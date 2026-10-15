/**
 * Agent Office - WebSocket + HTTP Event Server
 *
 * Runs on port 3334, or AGENT_OFFICE_PORT (server/config.js).
 * - React frontend connects via ws://localhost:<port>/ws
 * - Claude Code hook script POSTs to http://localhost:<port>/event
 * - GET /config tells the page the port and the boss from office.config.json
 * - GET /roster returns discovered MCP servers
 * - GET /agents lists agents in the office; POST /chat/reply with a recipient
 *   sends a directed agent-to-agent message
 * - GET /sessions lists the Claude Code sessions (terminals) the agents belong to,
 *   hooked ones and the ones only Claude Code's session registry knows about
 * - GET /registry shows that registry as the roster reads it (server/sessions.js)
 * - GET /signals lists the last deploy / build / test / push signals the
 *   hook classified out of the sessions' Bash commands
 * - GET /tasks shows each session's task list, the board on the office's
 *   kanban whiteboard (server/tasks.js)
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, chmodSync, unlinkSync, openSync, fstatSync, closeSync, constants as fsConstants } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { randomBytes, timingSafeEqual, createHmac } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction, markInboxRead } from './chat-db.js'
import db from './chat-db.js'
import { mountStatus } from './status.js'
import { mountRegistry } from './sessions.js'
import { mountTasks } from './tasks.js'
import { mountPermissions, sanitiseSuggestions, redactPermission } from './permissions.js'
import { mountHealth, readVersion } from './health.js'
import { readPort, readUiPort, readHost, loadOfficeConfig, bossFromConfig } from './config.js'
import { agentTranscriptPath, readTranscript, isTranscriptPath, clampLine } from './transcript.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const NOTIFY_SCRIPT = join(__dirname, '..', 'scripts', 'notify.sh')

function sendNotification(title, msg) {
  try {
    const child = execFile('bash', [NOTIFY_SCRIPT, title, msg], { timeout: 3000 })
    child.unref()
  } catch {}
}

// The port and the Vite dev port come from AGENT_OFFICE_PORT /
// AGENT_OFFICE_UI_PORT (server/config.js); the bind host is read in start().
const PORT = readPort()
const UI_DEV_PORT = readUiPort()

// ---------------------------------------------------------------------------
// Runtime dir + auth token
//
// Everything the server writes (auth token, agents.json, chat.db, inbox/...)
// lives in ~/.agent-office, or AGENT_OFFICE_HOME when set (tests point it at
// a temp dir). The token is read or generated here but only written to disk
// by start(), once the port is bound, so importing this module has no side
// effects outside RUNTIME_DIR and a second instance that loses the port race
// never clobbers the running instance's token.
//
// Threat model. The server only listens on loopback (127.0.0.1;
// AGENT_OFFICE_HOST may spell it 127.0.0.1 or localhost, anything else is
// refused by readHost, with the reason, and 127.0.0.1 is bound). Browsers on other
// origins are kept out by the origin allowlist below (every other origin
// gets 403 / a 1008 close) and by the JSON content type, which makes
// cross-site POSTs preflight. What is left is any other process on this
// machine — another local user's included — which can reach the port freely
// and send any Origin it likes (Origin only binds browsers). So the one
// secret that separates this user from the rest is the bearer token in
// ~/.agent-office/auth-token, the 0600 file only this user can read: the
// hook, the office scripts and A2A clients send it as
// `Authorization: Bearer <token>`, and the office page gets it through the
// link the server prints at start (see "The office link" below) and
// presents it when it opens the WebSocket. Everything that acts *as an
// agent*, answers for the person or destroys state needs it, and so does
// conversation text; reads of what the office shows, a person's plain chat
// line (POST /chat), the typing indicator and the chat-monitor pause toggle
// stay open.
//
//   token required   POST /event, /chat/reply, /a2a, /chat/inbox/read,
//                    /chat/seen, /chat/react, /chat/video-mode,
//                    GET /permission/:id (the hook's long-poll),
//                    and POST /chat for a destructive slash command (/clear)
//   UI token or token  POST /permission/:id (answer a permission dialog) and
//                    POST /settings — the two things the office page itself
//                    may change; see UI_TOKEN below
//   open             every GET, POST /chat (plain lines + read-only /status,
//                    /agents, /help and the incident toggles), /chat/typing,
//                    POST /chat/cron-state (the UI's pause button); the
//                    WebSocket without the token (read-only, see below)
//
// GET /roster and GET /agents do show each agent's task text and the names of
// the configured MCP servers; that is the office's purpose, and anything on
// this machine can already read ~/.claude/settings.json. GET /tasks shows each
// session's task subjects the same way. Prompts, replies, transcript tails, a
// permission dialog's command line and a task's description are conversation:
// they go only to a caller with the token (GET /chat, GET /sessions,
// GET /agents/:id, GET /permissions, GET /tasks, the WebSocket).
//
// The token is stable across restarts: a start reuses the one in the file
// when the file is still safe to trust (readTokenFile), so a page that
// remembered it keeps working after the office restarts. `npm run
// rotate-token` deletes the file, and the next start writes a new one.
// ---------------------------------------------------------------------------

const RUNTIME_DIR = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }) } catch {}
// mkdirSync's mode is ignored when the dir already exists, so a dir the
// installer or an older build left group/world-readable keeps those bits.
// Tighten it to 0700 unconditionally (the prompts in chat.db and the A2A
// inbox under here must not be readable by other local users).
try { chmodSync(RUNTIME_DIR, 0o700) } catch {}
const TOKEN_FILE = join(RUNTIME_DIR, 'auth-token')

// What the server writes: 32 random bytes as 64 lowercase hex digits
const TOKEN_PATTERN = /^[0-9a-f]{64}$/

/**
 * The token a previous start left in `file`, if it is still safe to keep
 * using: a regular file (a symlink is not followed), owned by this user,
 * with no group or other permission bits, holding a well-formed token.
 * Anything else — missing, malformed, readable by others, someone else's —
 * is null, and the server mints a new token instead. The file is opened
 * once and checked through that descriptor, so it cannot be swapped between
 * the check and the read. Windows has no uid or mode bits to check.
 */
function readTokenFile(file = TOKEN_FILE) {
  let fd
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const st = fstatSync(fd)
    if (!st.isFile()) return null
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null
    const token = readFileSync(fd, 'utf8').trim()
    return TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

const REUSED_TOKEN = readTokenFile()
const AUTH_TOKEN = REUSED_TOKEN ?? randomBytes(32).toString('hex')

/**
 * Write a file only this user can read. The mode applies when the file is
 * created, so a file an older version left world-readable is fixed as well.
 */
function writePrivate(path, data) {
  writeFileSync(path, data, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

/**
 * Repair the runtime dir and the chat database so another local user cannot
 * read them. mkdirSync's mode and SQLite's own file-create mode apply only
 * when they create the entry, so a dir left 0755 by the installer /
 * start-office.sh, or chat.db* left 0644 by an older build or the process
 * umask, keeps those bits. Fix them on every start. No-op on Windows.
 */
function repairPrivateModes() {
  if (process.platform === 'win32') return
  try { chmodSync(RUNTIME_DIR, 0o700) } catch {}
  for (const name of ['chat.db', 'chat.db-wal', 'chat.db-shm']) {
    const file = join(RUNTIME_DIR, name)
    try { if (existsSync(file)) chmodSync(file, 0o600) } catch {}
  }
}

/**
 * Put AUTH_TOKEN in the token file (after listen). A reused token is already
 * there. A new one replaces whatever the file was — unlinked first and then
 * created exclusively, so a symlink or a file owned by someone else is
 * replaced rather than written through.
 */
function writeTokenFile() {
  if (readTokenFile() === AUTH_TOKEN) return
  try {
    try { unlinkSync(TOKEN_FILE) } catch (err) { if (err.code !== 'ENOENT') throw err }
    writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600, flag: 'wx' })
    try { chmodSync(TOKEN_FILE, 0o600) } catch {}
  } catch (err) {
    console.warn('[auth] Could not write token file:', err.message)
  }
}

/** Constant-time comparison of a supplied token with ours. */
function tokenMatches(supplied) {
  if (typeof supplied !== 'string' || supplied.length === 0) return false
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(AUTH_TOKEN, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function bearerToken(req) {
  const header = req.headers['authorization'] ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

// ---------------------------------------------------------------------------
// Request signing — how the hook proves it holds the token without ever
// putting it on a command line
//
// The hook (and status line) run as short-lived processes whose argv every
// local user can read in `ps` / /proc/<pid>/cmdline. A bearer token on that
// argv leaks to anyone on the machine, and since the token is stable across
// restarts (#41) the leak stays useful — a port squatter that answered the
// first POST while the office was down would own the token for good. So the
// hook no longer sends the token at all: it signs each request with
// HMAC-SHA256(token, method\npath\ntimestamp\nbody) and sends the timestamp
// and the signature as headers. A reader of the argv sees only a signature
// bound to one method, path, body and minute — useless beyond replaying that
// exact request inside the window, which is the victim's own event. The
// token stays in the 0600 file (and, for the hook, in its own process memory
// / environment, which only its owner can read), never on a command line.
//
// The server accepts a request to a token-guarded route when it carries
// either a valid bearer token (the Python chat scripts and A2A clients send
// it from their own memory, not argv) or a valid signature whose timestamp is
// within SIGNATURE_WINDOW_MS. Both checks are constant-time.
// ---------------------------------------------------------------------------

/** ±1 minute: wide enough for clock skew, narrow enough that a leaked signature expires fast. */
const SIGNATURE_WINDOW_MS = 60_000

/** HMAC-SHA256(token, canonical request) as the hook computes it. The key is the token string's bytes. */
function requestSignature(method, path, timestamp, rawBody) {
  const h = createHmac('sha256', AUTH_TOKEN)
  h.update(`${method}\n${path}\n${timestamp}\n`)
  h.update(rawBody && rawBody.length ? rawBody : Buffer.alloc(0))
  return h.digest()
}

/**
 * True when the request carries a signature this server's token would
 * produce over the raw body, for a timestamp within the window. `req.rawBody`
 * is captured by express.json's verify hook (the exact bytes the hook signed);
 * it is empty for the hook's GET long-poll, which signs an empty body.
 */
function signatureValid(req) {
  const ts = req.headers['x-office-timestamp']
  const sig = req.headers['x-office-signature']
  if (typeof ts !== 'string' || typeof sig !== 'string' || !/^[0-9a-f]+$/.test(sig)) return false
  const tnum = Number(ts)
  if (!Number.isFinite(tnum) || Math.abs(Date.now() - tnum) > SIGNATURE_WINDOW_MS) return false
  const given = Buffer.from(sig, 'hex')
  const expected = requestSignature(req.method, req.originalUrl, ts, req.rawBody)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** A caller proved it holds the token: a valid bearer token, or a valid request signature. */
function tokenAuthed(req) {
  return tokenMatches(bearerToken(req)) || signatureValid(req)
}

function unauthorized(res, body) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="agent-office"')
  return res.status(401).json(body)
}

/** Express middleware: the route needs the office's token (bearer or a valid signature). */
function requireToken(req, res, next) {
  if (tokenAuthed(req)) return next()
  unauthorized(res, { error: 'Unauthorized' })
}

/** Same, answering in the JSON-RPC envelope for the A2A endpoint. */
function requireTokenRpc(req, res, next) {
  if (tokenAuthed(req)) return next()
  unauthorized(res, { jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32001, message: 'Unauthorized: send the office auth token as Authorization: Bearer <token>' } })
}

// ---------------------------------------------------------------------------
// Allowed origins
//
// The office UI is served from this server (PORT, 3334 by default: `npm run
// build`, the packaged desktop app) or from the Vite dev server (UI_DEV_PORT,
// 3333 by default), and browsers reach either as localhost, 127.0.0.1 or ::1
// — the Origin header spells it whichever way the page was opened, so match
// the loopback host rather than a fixed string. Anything else (other ports,
// `null`, `file://`) is refused. 3333 stays allowed next to a configured
// AGENT_OFFICE_UI_PORT: `npm run dev` ignores that variable and still opens
// Vite on 3333 (vite.config.ts).
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const ALLOWED_ORIGIN_PORTS = new Set([String(UI_DEV_PORT), '3333', String(PORT)])

function isAllowedOrigin(origin) {
  if (!origin) return true  // no Origin header: curl, the hook script, same-origin GETs
  try {
    const { protocol, hostname, port } = new URL(origin)
    return protocol === 'http:' && LOOPBACK_HOSTS.has(hostname) && ALLOWED_ORIGIN_PORTS.has(port)
  } catch {
    return false  // not a URL (`null`)
  }
}

// ---------------------------------------------------------------------------
// Host-header guard — defeats DNS rebinding
//
// The origin allowlist keeps cross-origin browser requests out, but a
// same-origin GET from a page the browser rebound to 127.0.0.1 carries no
// Origin header (the Fetch spec adds Origin only to CORS-tainted or
// non-GET/HEAD requests). Such a request would otherwise read every open GET
// — the pending command lines on GET /permissions, cwds and titles on
// GET /sessions, agent tasks on GET /agents. What it cannot forge is the Host
// header the browser sends: a rebinding page's Host is still its own domain.
// So every request must name a loopback host (any port: Vite proxies as
// localhost:3333, Electron loads 127.0.0.1:<port>); anything else is 421.
// ---------------------------------------------------------------------------

/** The host name of a Host header, port stripped, brackets kept for IPv6 ([::1]:3334 -> [::1]). */
function hostName(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return ''
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1)
  }
  const colon = hostHeader.indexOf(':')
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon)
}

/** A request is served only when its Host names a loopback host; guards against DNS rebinding. */
function isAllowedHost(hostHeader) {
  return LOOPBACK_HOSTS.has(hostName(hostHeader))
}

// ---------------------------------------------------------------------------
// The UI token — how the office page gets to answer a permission dialog
//
// Answering "Do you want to run this command?" for a Claude Code session
// must not be open to any local process the way POST /chat is. The server
// mints a second secret per process, UI_TOKEN, and hands it out in exactly
// one place: the WebSocket snapshot of a *trusted* connection — one that
// presented the file token at the handshake (see "The WebSocket" below).
// The Origin check alone cannot do this: it keeps web pages on other origins
// out, but a local process sends whatever Origin it likes. So nobody without
// the file token can obtain the UI token. It lives in memory only, changes
// on every restart, is compared in constant time, and opens only the
// routes the page needs: POST /permission/:id, POST /settings and the
// transcript on GET /agents/:id. The hook's long-poll that *learns* a
// decision stays behind the file token, the loopback bind is unchanged,
// nothing is ever auto-allowed, and when the server is down the hook prints
// nothing and the terminal dialog is in charge.
// ---------------------------------------------------------------------------

const UI_TOKEN = randomBytes(24).toString('hex')

function uiTokenMatches(supplied) {
  if (typeof supplied !== 'string' || supplied.length === 0) return false
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(UI_TOKEN, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Express middleware: the office page (UI token from the snapshot) or a token holder. */
function requireUi(req, res, next) {
  const supplied = bearerToken(req)
  if (uiTokenMatches(supplied) || tokenMatches(supplied)) return next()
  unauthorized(res, { error: 'Unauthorized' })
}

// ---------------------------------------------------------------------------
// Built UI
//
// `vite build` writes the React app, plus everything in public/, to dist/.
// When that directory exists the server serves it from its root, so
// http://127.0.0.1:<PORT>/ is the whole office on one port: the packaged
// Electron app loads this URL, and `npm run build && npm run server` works in
// a plain browser. `npm run dev` keeps using Vite on 3333 instead. Tests point
// AGENT_OFFICE_UI_DIR at a temp dir.
// ---------------------------------------------------------------------------

const UI_DIR = process.env.AGENT_OFFICE_UI_DIR || join(__dirname, '..', 'dist')
const UI_AVAILABLE = existsSync(join(UI_DIR, 'index.html'))

// ---------------------------------------------------------------------------
// office.config.json
//
// The boss character's name, sprite, colour and emoji. The file sits next to
// package.json: the checkout root in dev, and resources/app/ in a packaged
// desktop build (asar is off). Read on every GET /config rather than once,
// so a rename shows up on the next page load with no restart; tests point
// AGENT_OFFICE_CONFIG_DIR at a temp dir. The bundle keeps its own build-time
// copy (src/config.ts) as the fallback for ?sim and for a server that is down.
// ---------------------------------------------------------------------------

const CONFIG_DIR = process.env.AGENT_OFFICE_CONFIG_DIR || join(__dirname, '..')
const VERSION = readVersion()

// ---------------------------------------------------------------------------
// MCP server discovery
// ---------------------------------------------------------------------------

/**
 * Read ~/.claude/settings.json and any .claude.json in cwd to discover
 * configured MCP servers. Returns an array of server-name strings.
 */
function discoverMcpServers() {
  const servers = new Set()

  const candidates = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude.json'),
    join(process.cwd(), '.claude.json'),
  ]

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, 'utf8')
      const data = JSON.parse(raw)
      const mcpServers = data.mcpServers ?? data.mcp_servers ?? {}
      for (const name of Object.keys(mcpServers)) {
        servers.add(name)
      }
    } catch {
      // Malformed JSON or unreadable file — skip silently
    }
  }

  return Array.from(servers)
}

// ---------------------------------------------------------------------------
// Agent state tracking
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} agentId -> agent object */
const activeAgents = new Map()

/**
 * Claude Code subagent id (the `agent_id` in hook payloads) -> office agent id.
 * Tool calls made inside a subagent and the SubagentHandback of a background
 * agent only know the subagent id, so this is how they find their agent.
 * @type {Map<string, string>}
 */
const subagentAliases = new Map()

/**
 * SubagentStart events that arrived before the agent_spawned they belong to.
 * The hook POSTs from backgrounded curls, so the order is a race: such a start
 * is parked here (subagentId -> { agentType, parentId, sessionId, at }) and
 * consumed by the next spawn of that agentType (from the same session, when
 * both say which), or dropped after PENDING_START_MS.
 * @type {Map<string, {agentType: string, parentId?: string, sessionId?: string, at: number}>}
 */
const pendingStarts = new Map()
const PENDING_START_MS = 15_000

// How long after its spawn an agent can still be bound by guess (see
// guessAgentForSubagent). A SubagentStart follows its PreToolUse(Agent) by
// ~50 ms; the gap only grows while something holds the call between the two,
// such as another plugin's PreToolUse hook or a permission prompt (the Agent
// tool asks only under an `ask` rule), and a minute covers that. A subagent's
// first tool call comes a whole model turn after its start, so the fallback
// that binds on it waits longer. Anything older is a launch whose start never
// came (cancelled, or lost), and binding it would hand it someone else's work.
const START_BIND_MS = 60_000
const FIRST_TOOL_BIND_MS = 5 * 60_000

// Agents with no activity for this long are assumed gone (missed hand-back,
// Claude Code killed mid-task) and are walked out of the office.
const STALE_AGENT_MS = (Number(process.env.AGENT_OFFICE_STALE_MINUTES) || 120) * 60_000

// ---------------------------------------------------------------------------
// Activity — what each character has done, for the inspector card
//
// GET /agents/:id answers "what is it doing and what has it done": the last
// ACTIVITY_MAX things an agent did (its tool calls from agent_working, the
// failed ones marked, its completion line, the directed messages it sent)
// and a count per tool. The session's own Claude is kept the same way under
// the id the office gives it, `main-<sessionId>`: its tool calls reach the
// server as agent_working without an agentId and as mcp_call, and every
// change of its main state is one 'status' line.
//
// The buffers live in their own Map, off the agent records, so agents.json
// (which saveAgents writes whole on every event) stays a few hundred bytes
// per agent. A restart starts them afresh: a worker's record is gone ten
// seconds after it finishes anyway, and the transcript tail covers the rest.
// ---------------------------------------------------------------------------

const ACTIVITY_MAX = 50
const ACTIVITY_TEXT_MAX = 160
const MAIN_ID_PREFIX = 'main-'

/** @type {Map<string, {history: object[], toolCounts: Record<string, number>}>} office id or main-<sessionId> -> activity */
const activity = new Map()

/** The office id of a session's own Claude (what the frontend's mainId() gives it). */
function mainActivityId(sessionId) {
  return `${MAIN_ID_PREFIX}${sessionId}`
}

function activityOf(id) {
  let entry = activity.get(id)
  if (!entry) {
    entry = { history: [], toolCounts: {} }
    activity.set(id, entry)
  }
  return entry
}

/**
 * Append one entry { at, kind: 'tool' | 'failed' | 'status' | 'completed' | 'message', tool?, text }
 * to an agent's history (the oldest falls off past ACTIVITY_MAX) and count
 * the tool. The text is one line clamped to ACTIVITY_TEXT_MAX.
 */
function recordActivity(id, { kind, tool, text }, now = Date.now()) {
  if (!id) return
  const entry = activityOf(id)
  const row = { at: now, kind, text: clampLine(text, ACTIVITY_TEXT_MAX) }
  if (tool) {
    row.tool = tool
    // A failed call was already counted by its PreToolUse; the failure only marks it
    if (kind === 'tool') entry.toolCounts[tool] = (entry.toolCounts[tool] ?? 0) + 1
  }
  entry.history.push(row)
  if (entry.history.length > ACTIVITY_MAX) entry.history.splice(0, entry.history.length - ACTIVITY_MAX)
}

// The tracker's own status phrasings, for a hook that sends no `tool`
// (an older agent-tracker.sh): "reading x" is a Read, "running: ..." a Bash,
// "using WebFetch" a WebFetch, "failed: Bash — ..." a Bash that errored.
const STATUS_TOOLS = [
  ['reading ', 'Read'], ['writing ', 'Write'], ['editing ', 'Edit'], ['running: ', 'Bash'],
  ['searching for ', 'Grep'], ['finding files: ', 'Glob'], ['using /', 'Skill'],
]

function toolFromStatus(status) {
  if (typeof status !== 'string') return undefined
  for (const [prefix, tool] of STATUS_TOOLS) if (status.startsWith(prefix)) return tool
  const m = /^(?:using|failed:) (\S+)/.exec(status)
  return m ? m[1] : undefined
}

// ---------------------------------------------------------------------------
// Session tracking — one Claude Code session (terminal) per session_id
//
// Every hook payload carries session_id / cwd / transcript_path, which the
// tracker forwards as sessionId / project / cwd / transcriptPath on every
// event. Agents are filed under the session that spawned them, so two
// terminals never share workers, and main-thread tool calls (agent_working
// without an agentId) are attributed to their session instead of to a random
// worker. A session the office has not seen is created implicitly by its
// first event (hooks installed mid-session, server restarted).
//
// Sessions without hooks. Claude Code's own session registry
// (~/.claude/sessions/<pid>.json, server/sessions.js) lists every running
// CLI process, so a session shows up here before (or without) the hooks
// being installed: `hooked: false`, `registry: { pid, name, status, ... }`
// and a `main` mapped from the registry status. Such a record is not
// persisted (the registry rebuilds it) and never swept as stale while its
// process is alive; the first hook event from it flips it to hooked
// (hookSession), same id, and from then on the hooks are the truth. A
// hooked session with a live registry entry carries `registry` too, as
// presence only.
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} sessionId -> session record */
const sessions = new Map()

// Claude Code's config dir (CLAUDE_CONFIG_DIR moves it) holds the registry;
// tests point AGENT_OFFICE_REGISTRY_DIR at a temp dir
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const REGISTRY_DIR = process.env.AGENT_OFFICE_REGISTRY_DIR || join(CLAUDE_DIR, 'sessions')
// ...and each session's task list (server/tasks.js); tests point
// AGENT_OFFICE_TASKS_DIR at a temp dir
const TASKS_DIR = process.env.AGENT_OFFICE_TASKS_DIR || join(CLAUDE_DIR, 'tasks')

/** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId -> timer that forgets an ended session */
const sessionTimers = new Map()

// An ended session stays listed (state 'ended') this long so UIs can show it leaving
const SESSION_FORGET_MS = 60_000

// ---------------------------------------------------------------------------
// The session's own Claude — `main` on every session record
//
// Besides its workers, each session has the Claude the boss talks to. The
// tracker reports its turn from the main-thread hooks (UserPromptSubmit,
// PreToolUse, Stop, PermissionRequest, Notification, StopFailure,
// Pre/PostCompact) and the server keeps one record per session:
//
//   main: {
//     state:       'working' | 'waiting' | 'idle' | 'needs-you' | 'error' | 'compacting',
//     since:       when it entered that state,
//     lastPrompt,  lastPromptAt,     the boss's last prompt (clamped to 2000 chars)
//     lastReply,   lastReplyAt,      Claude's last reply (Stop.last_assistant_message)
//     waitingOn:   background tasks still running when the turn ended,
//     needsYou?:   { kind, toolName?, summary?, message?, notificationType?, since, promptId? },
//     error?:      { error, detail, since },
//     promptId?:   the current prompt (Claude Code's prompt_id)
//   }
//
// Transitions: session_prompt -> working (clears needs-you); a main-thread
// agent_working -> working; session_needs_you -> needs-you; session_turn_end
// -> waiting when a background task is still running, else idle;
// session_error -> error; session_compact pre -> compacting, post -> the
// state before; session_ended and a resume reset it. Each change logs one
// `[main]` line. The record travels on GET /sessions, the WS snapshot and
// every session_* broadcast, and persists with the session.
// ---------------------------------------------------------------------------

const MAIN_STATES = new Set(['working', 'waiting', 'idle', 'needs-you', 'error', 'compacting'])
const NEEDS_YOU_KINDS = new Set(['permission', 'idle', 'quota', 'agent-input'])
// Needs-you timing:
// - a wait is applied and announced only after NEEDS_YOU_DEBOUNCE_MS: in a
//   headless (-p) session a PermissionRequest is auto-denied and its
//   PostToolBatch follows ~60 ms later, which would make the hand flap
// - PermissionRequest fires at once and Notification{permission_prompt} ~6 s
//   later for the same dialog: a repeat within NEEDS_YOU_DEDUPE_MS is the same wait
// - PreToolUse fires ~70 ms before the PermissionRequest of the same call and
//   the hook's POSTs are backgrounded, so the two can arrive in either order:
//   a working event does not lower a hand raised less than PERMISSION_RACE_MS ago
// - a hand nobody answers comes down by itself after NEEDS_YOU_TIMEOUT_MS
//   (re-armed for what is left of it when a hand is restored from agents.json)
//
// Which call a permission wait belongs to. A PermissionRequest carries no
// tool_use_id, so the hook sends a `callKey` instead — a hash of the call's
// tool name and tool input, which its PostToolUse carries too — and the
// subagent's agent_id when a worker asked. A wait is answered only by its own
// thread (the worker that asked, or the main thread) and, for a single call,
// only by that call: tool name and callKey alike. Another call of the same
// tool finishing beside it (`git status` next to the `git push` that asked,
// a parallel read) says nothing about the dialog. A batch ending answers
// every wait of its thread; a worker's next tool call past the race window,
// or its completion, answers the ones it raised; main-thread activity never
// answers a worker's. A turn boundary (Stop, a prompt, an API error, the
// session ending) still answers everything.
const NEEDS_YOU_DEBOUNCE_MS = 300
const NEEDS_YOU_DEDUPE_MS = 10_000
const PERMISSION_RACE_MS = 1_000
const NEEDS_YOU_TIMEOUT_MS = 10 * 60_000
// Stop.background_tasks statuses that mean the task is still in flight
const TASK_IN_FLIGHT = /^(running|pending)$/i

/** @type {Map<string, {wait: object, agentId?: string, timer: ReturnType<typeof setTimeout>}>} sessionId -> needs-you waiting out the debounce */
const pendingNeedsYou = new Map()
/** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId -> timer that lowers a hand nobody answered */
const needsYouTimers = new Map()
/**
 * A wait (parked, or main.needsYou) -> the call behind it: { agentId?, callKey?,
 * before? } — the raw subagent id that asked, the hook's callKey, and the main
 * state the hand went up from. Kept off the wait itself, which is broadcast and
 * persisted; a hand restored from agents.json has none and is matched by tool
 * name alone, as before.
 * @type {WeakMap<object, {agentId?: string, callKey?: string, before?: string}>}
 */
const waitCalls = new WeakMap()

const callOf = wait => (wait && waitCalls.get(wait)) || {}

/**
 * Whether two raw thread ids name the same thread: both absent is the main
 * thread; a subagent id and an office id match through the alias map.
 */
function sameThread(a, b) {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a === b) return true
  const id = lookupAgentId(a)
  return !!id && id === lookupAgentId(b)
}

/** The same call by callKey, when both sides have one (an older hook sends none). */
function sameCallKey(a, b) {
  return !a || !b || a === b
}

function cancelPendingNeedsYou(sessionId) {
  const pending = pendingNeedsYou.get(sessionId)
  if (!pending) return null
  clearTimeout(pending.timer)
  pendingNeedsYou.delete(sessionId)
  return pending
}

function clearNeedsYouTimer(sessionId) {
  const timer = needsYouTimers.get(sessionId)
  if (!timer) return
  clearTimeout(timer)
  needsYouTimers.delete(sessionId)
}

function newMain(now = Date.now()) {
  return { state: 'idle', since: now, waitingOn: 0 }
}

/** A session's main record, created on first use (sessions restored from an older agents.json). */
function mainOf(session, now = Date.now()) {
  if (!session.main) session.main = newMain(now)
  return session.main
}

/** A persisted main record, or a fresh one when the file predates it or holds junk. */
function restoredMain(main) {
  if (!main || typeof main !== 'object' || !MAIN_STATES.has(main.state)) return newMain()
  return { ...main, waitingOn: Number.isInteger(main.waitingOn) ? main.waitingOn : 0 }
}

function sessionName(session) {
  return session.project ?? session.id
}

/**
 * Move a session's Claude to `state`. Stamps `since` and logs one line only
 * on a change; returns whether the state changed.
 */
function setMainState(session, state, reason, now = Date.now()) {
  const main = mainOf(session, now)
  if (main.state === state) return false
  if (main.state === 'needs-you') clearNeedsYouTimer(session.id)
  console.log(`[main] ${sessionName(session)}: ${main.state} -> ${state}${reason ? ` (${reason})` : ''}`)
  main.state = state
  main.since = now
  // One line per transition in Claude's own history (the inspector card)
  recordActivity(mainActivityId(session.id), { kind: 'status', text: `${state}${reason ? ` — ${reason}` : ''}` }, now)
  return true
}

/** The label a needs-you wait gets in the log. */
function needsYouLabel(wait) {
  if (wait.kind === 'permission') return `permission: ${[wait.toolName, wait.summary].filter(Boolean).join(' ') || wait.message || 'tool call'}`
  return `${wait.kind}${wait.notificationType ? ` / ${wait.notificationType}` : ''}${wait.message ? `: ${wait.message}` : ''}`
}

/** A server-side change to main (a hand lowered by a tool result or a timeout) as a broadcast. */
function mainEvent(session, reason, now = Date.now()) {
  return { type: 'session_main', sessionId: session.id, project: session.project, reason, main: { ...session.main }, timestamp: now }
}

/** Lower a hand nobody answered within NEEDS_YOU_TIMEOUT_MS (`delayMs`: what is left of it, for a restored hand). */
function armNeedsYouTimeout(session, delayMs = NEEDS_YOU_TIMEOUT_MS) {
  clearNeedsYouTimer(session.id)
  const since = session.main.needsYou?.since
  const timer = setTimeout(() => {
    needsYouTimers.delete(session.id)
    const current = sessions.get(session.id)
    if (!current || current.main?.state !== 'needs-you' || current.main.needsYou?.since !== since) return
    delete current.main.needsYou
    setMainState(current, 'idle', `needs-you unanswered for ${NEEDS_YOU_TIMEOUT_MS / 60_000} min`)
    saveAgents()
    broadcast(mainEvent(current, 'needs-you timed out'))
  }, Math.max(0, delayMs))
  timer.unref?.()
  needsYouTimers.set(session.id, timer)
}

/**
 * The debounce ran out: the wait parked by session_needs_you is still
 * unanswered, so it becomes the session's state and is announced.
 */
function applyNeedsYou(sessionId) {
  const pending = cancelPendingNeedsYou(sessionId)
  const session = sessions.get(sessionId)
  if (!pending || !session || session.state === 'ended') return
  const now = Date.now()
  const main = mainOf(session, now)
  const wait = pending.wait
  // The state to go back to when the worker that asked moves on (a hand raised over a hand keeps the first one's)
  const before = main.state === 'needs-you' ? callOf(main.needsYou).before : main.state
  main.needsYou = { ...wait }
  waitCalls.set(main.needsYou, { ...callOf(wait), before })
  if (wait.promptId) main.promptId = wait.promptId
  delete main.error
  delete main.beforeCompact
  const label = needsYouLabel(wait)
  if (!setMainState(session, 'needs-you', label, now)) console.log(`[main] ${sessionName(session)}: needs-you again (${label})`)
  armNeedsYouTimeout(session)
  saveAgents()
  // A request raised inside a subagent names it; resolved to the office agent when known
  const agentId = pending.agentId ? (lookupAgentId(pending.agentId) ?? pending.agentId) : undefined
  broadcast({
    type: 'session_needs_you',
    sessionId: session.id,
    project: session.project,
    kind: wait.kind,
    ...(wait.promptId ? { promptId: wait.promptId } : {}),
    ...(wait.toolName ? { toolName: wait.toolName } : {}),
    ...(wait.summary ? { summary: wait.summary } : {}),
    ...(wait.message ? { message: wait.message } : {}),
    ...(wait.notificationType ? { notificationType: wait.notificationType } : {}),
    ...(agentId ? { agentId } : {}),
    needsYou: { ...main.needsYou },
    main: { ...main },
    timestamp: now,
  })
}

/**
 * A tool call on the main thread: Claude is working — unless a permission hand
 * just went up (see PERMISSION_RACE_MS), or a worker raised it (that worker's
 * own activity lowers it, see threadMovedOn).
 */
function mainWorking(session, status, now = Date.now()) {
  const main = mainOf(session, now)
  if (main.state === 'needs-you' && main.needsYou?.kind === 'permission') {
    if (now - main.needsYou.since < PERMISSION_RACE_MS || callOf(main.needsYou).agentId) return false
  }
  delete main.needsYou
  delete main.error
  delete main.beforeCompact
  return setMainState(session, 'working', status ? `tool call: ${status}` : 'tool call', now)
}

/**
 * Lower the permission hand `answers(wait, call)` accepts, and withdraw a
 * parked one it accepts, logging `what` as the reason. The hand goes to `to`,
 * or, without one, back to the state it went up from (a worker's dialog
 * answered while Claude itself waits on that worker is waiting again).
 * Returns the session_main broadcast when the raised hand came down, else null.
 */
function lowerPermissionHand(session, answers, what, to) {
  const pending = pendingNeedsYou.get(session.id)
  if (pending && pending.wait.kind === 'permission' && answers(pending.wait, callOf(pending.wait))) {
    cancelPendingNeedsYou(session.id)
    console.log(`[main] ${sessionName(session)}: needs-you withdrawn before it was shown (${needsYouLabel(pending.wait)}; ${what} ${Date.now() - pending.wait.since} ms later)`)
  }
  const main = mainOf(session)
  if (main.state !== 'needs-you' || main.needsYou?.kind !== 'permission') return null
  const call = callOf(main.needsYou)
  if (!answers(main.needsYou, call)) return null
  const back = to ?? (['working', 'waiting', 'idle'].includes(call.before) ? call.before : 'working')
  delete main.needsYou
  setMainState(session, back, what)
  saveAgents()
  return mainEvent(session, 'permission answered')
}

/**
 * One tool call of a thread finished (PostToolUse; an MCP call's mcp_done) or
 * a whole batch of its calls did (PostToolBatch): the permission waits it
 * answers come down — the pending office card, a parked wait, the hand (see
 * "Which call a permission wait belongs to" above). `done` is { toolName?,
 * callKey?, agentId?, batch?, count? }. Returns the session_main broadcast
 * when the hand came down, else null.
 */
function toolDone(session, done) {
  const answers = (toolName, agentId, callKey) => sameThread(agentId, done.agentId)
    && (done.batch === true || (!!done.toolName && toolName === done.toolName && sameCallKey(callKey, done.callKey)))
  const what = done.batch === true ? `tool batch of ${done.count ?? '?'} done` : `${done.toolName ?? 'tool'} ran`
  releasePermissions(session.id, what, p => answers(p.toolName, p.agentId, p.callKey))
  // The main thread goes back to work; a worker's hand returns to where it was raised from
  return lowerPermissionHand(session, (w, call) => answers(w.toolName, call.agentId, call.callKey), what, done.agentId ? undefined : 'working')
}

/**
 * A worker made a tool call (PreToolUse, PostToolUseFailure) or finished: a
 * permission it asked for was answered in the terminal. A tool call counts
 * past PERMISSION_RACE_MS only, like the main thread's (it may be the late
 * PreToolUse of the very call that asked); a completion (`finished`) always.
 * `agentId` is the raw id the event carried. Returns the session_main
 * broadcast when the hand came down, else null.
 */
function threadMovedOn(session, agentId, what, { finished = false, now = Date.now() } = {}) {
  const settled = since => finished || now - since >= PERMISSION_RACE_MS
  releasePermissions(session.id, what, p => !!p.agentId && sameThread(p.agentId, agentId) && settled(p.createdAt))
  const main = mainOf(session, now)
  if (main.state !== 'needs-you' || main.needsYou?.kind !== 'permission') return null
  const call = callOf(main.needsYou)
  if (!call.agentId || !sameThread(call.agentId, agentId) || !settled(main.needsYou.since)) return null
  return lowerPermissionHand(session, w => w === main.needsYou, what)
}

/** One line of text for a log line. */
function logText(text, max = 60) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, max)
}

/** Display name of a session: the tracker's project, else the last path segment of cwd. */
function projectName(project, cwd) {
  if (project) return project
  if (!cwd) return undefined
  return basename(cwd.replace(/\/+$/, '')) || cwd
}

/** Session record -> persistable object (the agentIds Set becomes an array). */
function sessionToRecord(session) {
  return { ...session, agentIds: Array.from(session.agentIds) }
}

/**
 * Session record -> API/WS shape: the record plus live agent counts. Without
 * `withText` the prompt and reply text is left out of `main` (GET /sessions
 * and the WebSocket without the office token; with it, they carry it).
 */
function sessionToJSON(session, { withText = true } = {}) {
  const live = Array.from(activeAgents.values())
    .filter(a => a.sessionId === session.id && !a.server && a.state !== 'completed')
  const record = sessionToRecord(session)
  if (!withText && record.main) {
    const { lastPrompt, lastReply, ...rest } = record.main
    record.main = rest
  }
  return {
    ...record,
    // Sessions restored from an older agents.json predate the flag: hooks made them
    hooked: session.hooked !== false,
    agentCount: live.length,
    workingCount: live.filter(a => a.state === 'working').length,
  }
}

/** Broadcast shape of a session lifecycle event. */
function sessionEvent(session, type = 'session_started') {
  const { id, ...json } = sessionToJSON(session)
  return { type, sessionId: id, ...json, timestamp: Date.now() }
}

function createSession({ id, project, cwd, source, model, title, transcriptPath, now = Date.now() }) {
  const session = {
    id,
    hooked: true,
    project: projectName(project, cwd),
    cwd,
    source: source || 'implicit',
    state: 'active',
    startedAt: now,
    lastActivityAt: now,
    agentIds: new Set(),
    main: newMain(now),
  }
  if (model) session.model = model
  if (title) session.title = title
  // The session's own transcript; a worker's file is derived from it (server/transcript.js)
  if (transcriptPath) session.transcriptPath = transcriptPath
  sessions.set(id, session)
  console.log(`[session] ${session.source}: ${session.project ?? id} (${id})`)
  return session
}

/**
 * A session the registry put here (hooked: false) has sent its first hook
 * event — hooks installed mid-session, or the office only now hearing them:
 * from here on the hooks are the truth. The registry-derived main state is
 * dropped for a fresh one (the event about to be applied sets it), the
 * registry entry stays attached as presence. Returns whether it flipped; the
 * caller announces it (session_started with hooked: true).
 */
function hookSession(session, source, now = Date.now()) {
  if (session.hooked !== false) return false
  session.hooked = true
  session.source = source
  session.main = newMain(now)
  session.lastActivityAt = now
  console.log(`[session] hooked now (${source}): ${sessionName(session)} (${session.id})`)
  return true
}

/**
 * The session an event belongs to, created on the fly (source 'implicit')
 * when the office has not seen it. Bumps the session's activity clock. A
 * straggling event does not revive an ended session — only session_started
 * (a resume) does that.
 */
function touchSession(body, now = Date.now()) {
  const id = body.sessionId
  if (!id) return null
  let session = sessions.get(id)
  if (!session) {
    session = createSession({ id, project: body.project, cwd: body.cwd, source: 'implicit', transcriptPath: body.transcriptPath, now })
    saveAgents()
    broadcast(sessionEvent(session))
    return session
  }
  if (hookSession(session, 'implicit', now)) {
    saveAgents()
    broadcast(sessionEvent(session))
  }
  if (session.state === 'active') session.lastActivityAt = now
  if (!session.project) session.project = projectName(body.project, body.cwd)
  if (!session.cwd && body.cwd) session.cwd = body.cwd
  if (body.transcriptPath && session.transcriptPath !== body.transcriptPath) session.transcriptPath = body.transcriptPath
  return session
}

/** File an agent under a session (and show the session's project on its nameplate). */
function attachAgentToSession(agent, session) {
  if (!agent || !session) return
  if (agent.sessionId && agent.sessionId !== session.id) {
    sessions.get(agent.sessionId)?.agentIds.delete(agent.id)
  }
  agent.sessionId = session.id
  agent.project = session.project
  session.agentIds.add(agent.id)
}

function clearSessionTimer(id) {
  const timer = sessionTimers.get(id)
  if (!timer) return
  clearTimeout(timer)
  sessionTimers.delete(id)
}

function forgetSession(id) {
  clearSessionTimer(id)
  cancelPendingNeedsYou(id)
  clearNeedsYouTimer(id)
  sessionSignals.delete(id)
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  activity.delete(mainActivityId(id))
  saveAgents()
  console.log(`[session] forgot ${session.project ?? id} (${id})`)
}

/**
 * Mark a session ended (SessionEnd hook, or no events for STALE_AGENT_MS):
 * its still-active agents clock out through the usual agent_completed path
 * (10 s grace), and the session itself is forgotten after SESSION_FORGET_MS.
 */
function endSession(session, reason, now = Date.now()) {
  session.state = 'ended'
  session.endedAt = now
  session.reason = reason
  session.lastActivityAt = now
  cancelPendingNeedsYou(session.id)
  clearNeedsYouTimer(session.id)
  releasePermissions(session.id, 'session ended')
  if (session.main?.state !== 'idle') console.log(`[main] ${sessionName(session)}: ${session.main?.state ?? 'idle'} -> idle (session ended)`)
  session.main = newMain(now)
  for (const agentId of Array.from(session.agentIds)) {
    const agent = activeAgents.get(agentId)
    if (!agent || agent.server || agent.state === 'completed') continue
    broadcast(processEvent({ type: 'agent_completed', agentId, result: 'session ended' }))
  }
  saveAgents()
  clearSessionTimer(session.id)
  const timer = setTimeout(() => forgetSession(session.id), SESSION_FORGET_MS)
  timer.unref?.()
  sessionTimers.set(session.id, timer)
  console.log(`[session] ended (${reason}): ${session.project ?? session.id} (${session.id})`)
}

/**
 * Generate a stable agent ID from the event payload.
 * Uses the provided id, or derives one from name+role.
 */
function resolveAgentId(agent) {
  if (agent.id) return agent.id
  const slug = `${agent.name ?? 'agent'}-${agent.role ?? 'worker'}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
  // A derived id must not collide with an agent still in the office, or the
  // second spawn would be taken for a replay of the first and its task dropped
  let id = slug
  for (let n = 2; activeAgents.has(id); n++) id = `${slug}-${n}`
  return id
}

/** Map an office id or a subagent id to the office agent id, if known. */
function lookupAgentId(id) {
  if (!id) return null
  if (activeAgents.has(id)) return id
  const aliased = subagentAliases.get(id)
  return aliased && activeAgents.has(aliased) ? aliased : null
}

function linkSubagent(officeId, subagentId) {
  const agent = activeAgents.get(officeId)
  if (!agent || !subagentId) return
  // A guessed binding may have attached this subagent to another agent first
  for (const other of activeAgents.values()) {
    if (other !== agent && other.subagentId === subagentId) delete other.subagentId
  }
  // Relinking: the subagent this agent was guessed onto before is somebody
  // else's — drop its alias, or its tool calls and its SubagentStop would
  // keep landing here and walk this agent out while its own subagent runs
  if (agent.subagentId && agent.subagentId !== subagentId && subagentAliases.get(agent.subagentId) === officeId) {
    subagentAliases.delete(agent.subagentId)
  }
  agent.subagentId = subagentId
  subagentAliases.set(subagentId, officeId)
}

/** Both unknown, or the same: an event and an agent may belong together. */
function sameSession(a, b) {
  return !a || !b || a === b
}

/**
 * The office agent a subagent id we have not seen most likely belongs to,
 * when all the event says is its agent type: the earliest-spawned unbound,
 * not-completed, non-MCP agent of that type, spawned within `withinMs` before
 * the event, and from the same session when the event names one (so a start
 * in one terminal never binds to a spawn in another). Earliest first keeps
 * parallel launches of one type in launch order. Agents restored from
 * agents.json never qualify: their start did not arrive before the restart,
 * so it either never will or it was lost while the server was down, and the
 * subagent's own tool calls then get an agent of their own.
 */
function guessAgentForSubagent(agentType, sessionId, withinMs) {
  const now = Date.now()
  return Array.from(activeAgents.values())
    .filter(a => !a.server && !a.subagentId && !a.restored && a.state !== 'completed' && a.agentType === agentType)
    .filter(a => sameSession(a.sessionId, sessionId) && now - a.spawnedAt <= withinMs)
    .sort((a, b) => a.spawnedAt - b.spawnedAt)[0] ?? null
}

/** Record who spawned an agent: the parent's subagent id and, when known, its office id. */
function setLineage(agent, parentSubagentId) {
  if (!parentSubagentId) return
  agent.parentSubagentId = parentSubagentId
  const parentId = lookupAgentId(parentSubagentId)
  if (parentId && parentId !== agent.id) agent.parentId = parentId
}

function prunePendingStarts(now = Date.now()) {
  for (const [subagentId, pending] of pendingStarts) {
    if (now - pending.at > PENDING_START_MS) {
      pendingStarts.delete(subagentId)
      console.log(`[~] Dropped parked SubagentStart ${subagentId} (${pending.agentType}): no spawn within ${PENDING_START_MS / 1000}s`)
    }
  }
}

/** Link a freshly spawned agent to the oldest parked SubagentStart of its type, if any. */
function adoptPendingStart(agent) {
  let oldest = null
  for (const [subagentId, pending] of pendingStarts) {
    if (pending.agentType !== agent.agentType || !sameSession(pending.sessionId, agent.sessionId)) continue
    if (!oldest || pending.at < oldest.at) oldest = { subagentId, ...pending }
  }
  if (!oldest) return false
  pendingStarts.delete(oldest.subagentId)
  linkSubagent(agent.id, oldest.subagentId)
  setLineage(agent, oldest.parentId)
  console.log(`[~] Agent ${agent.id} linked to parked subagent ${oldest.subagentId} (${agent.agentType}) by SubagentStart`)
  return true
}

/**
 * The agents a client should draw: not the transient MCP records, not an
 * agent in its completed grace window (still in the map so late events find
 * it, but already announced as gone — a client that first sees it now would
 * seat a ghost that never leaves).
 */
function liveAgents() {
  return Array.from(activeAgents.values()).filter(a => !a.server && a.state !== 'completed')
}

function forgetAgent(id) {
  const agent = activeAgents.get(id)
  if (agent?.subagentId && subagentAliases.get(agent.subagentId) === id) {
    subagentAliases.delete(agent.subagentId)
  }
  if (agent?.sessionId) sessions.get(agent.sessionId)?.agentIds.delete(id)
  activeAgents.delete(id)
  activity.delete(id)
  saveAgents()
}

// Roles whose sprites differ from each other. General-purpose agents are
// spread across these so a busy office isn't full of identical clones.
const GENERAL_SPRITE_POOL = [
  'general-purpose',
  'code-reviewer',
  'test-engineer',
  'debugger',
  'fullstack-developer',
  'frontend-developer',
  'security-auditor',
]

function leastUsedGeneralRole() {
  const counts = new Map(GENERAL_SPRITE_POOL.map(r => [r, 0]))
  for (const a of activeAgents.values()) {
    if (counts.has(a.role) && a.state !== 'completed') counts.set(a.role, counts.get(a.role) + 1)
  }
  let best = GENERAL_SPRITE_POOL[0]
  for (const role of GENERAL_SPRITE_POOL) {
    if (counts.get(role) < counts.get(best)) best = role
  }
  return best
}

// ---------------------------------------------------------------------------
// Agent + session persistence — survive a server restart while agents are
// still working. agents.json holds { agents, sessions }.
// ---------------------------------------------------------------------------

const AGENTS_FILE = join(RUNTIME_DIR, 'agents.json')

function saveAgents() {
  try {
    // MCP entries are transient (one per call), only persist real agents;
    // ended sessions are on their way out and are not kept either, nor are
    // registry-only sessions (the registry rebuilds them on the next start)
    const agents = liveAgents()
    const saved = Array.from(sessions.values()).filter(s => s.state === 'active' && s.hooked !== false).map(sessionToRecord)
    writePrivate(AGENTS_FILE, JSON.stringify({ agents, sessions: saved }))
  } catch (err) {
    console.warn('[agents] Could not save agent state:', err.message)
  }
}

function loadAgents() {
  if (!existsSync(AGENTS_FILE)) return
  try {
    const { agents = [], sessions: saved = [] } = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
    const cutoff = Date.now() - STALE_AGENT_MS
    for (const agent of agents) {
      if (!agent?.id || agent.state === 'completed') continue
      if ((agent.lastActivityAt ?? agent.spawnedAt ?? 0) < cutoff) continue
      // Never a guess-binding candidate again (guessAgentForSubagent)
      agent.restored = true
      activeAgents.set(agent.id, agent)
      if (agent.subagentId) subagentAliases.set(agent.subagentId, agent.id)
    }
    if (activeAgents.size > 0) console.log(`[agents] Restored ${activeAgents.size} agent(s) from ${AGENTS_FILE}`)

    // Sessions come back with the same stale cutoff; their agent lists are
    // rebuilt from the agents that survived
    for (const session of Array.isArray(saved) ? saved : []) {
      if (!session?.id || session.state === 'ended' || session.hooked === false) continue
      if ((session.lastActivityAt ?? session.startedAt ?? 0) < cutoff) continue
      const agentIds = (Array.isArray(session.agentIds) ? session.agentIds : []).filter(id => activeAgents.has(id))
      sessions.set(session.id, { ...session, state: 'active', agentIds: new Set(agentIds), main: restoredMain(session.main) })
    }
    for (const agent of activeAgents.values()) {
      if (agent.sessionId) sessions.get(agent.sessionId)?.agentIds.add(agent.id)
    }
    if (sessions.size > 0) console.log(`[sessions] Restored ${sessions.size} session(s) from ${AGENTS_FILE}`)

    // A hand that was up when the server stopped gets what is left of its ten
    // minutes, counted from when it went up: the dialog may well have been
    // answered while nothing was listening, and nothing else would lower it
    const now = Date.now()
    for (const session of sessions.values()) {
      const main = session.main
      if (main?.state !== 'needs-you') continue
      const since = main.needsYou?.since ?? main.since ?? now
      const left = NEEDS_YOU_TIMEOUT_MS - (now - since)
      if (left > 0) {
        armNeedsYouTimeout(session, left)
        continue
      }
      delete main.needsYou
      setMainState(session, 'idle', `needs-you unanswered for ${NEEDS_YOU_TIMEOUT_MS / 60_000} min, across a restart`, now)
    }
  } catch (err) {
    console.warn('[agents] Could not restore agent state:', err.message)
  }
}

loadAgents()

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  'agent_spawned',
  'agent_working',
  'agent_completed',
  'agent_linked',
  'agent_started',
  'mcp_call',
  'mcp_done',
  'session_started',
  'session_ended',
  // The session's own Claude (see `main` above)
  'session_prompt',
  'session_turn_end',
  'session_needs_you',
  'session_tool_done',
  'session_error',
  'session_compact',
  'session_cwd',
  'session_model',
  // A Bash call's signals when the call sends no other event (see Signals below)
  'signal',
  // TaskCreated / TaskCompleted: the task board looks at the session's list now (server/tasks.js)
  'task_created',
  'task_completed',
])

const MAX_STRING_LEN = 200
// A prompt or a reply: the same room POST /chat gives a chat line
const MAX_TEXT_LEN = 2000

function clampString(val, max = MAX_STRING_LEN) {
  if (typeof val !== 'string') return undefined
  return val.slice(0, max)
}

/** A count from a hook payload: a non-negative integer, else undefined. */
function clampCount(val, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(val) && val >= 0 ? Math.min(val, max) : undefined
}

// ---------------------------------------------------------------------------
// Settings — $AGENT_OFFICE_HOME/settings.json
//
// logPrompts says how much of the boss's prompts and Claude's replies (the
// session_prompt / session_turn_end text) the office keeps and shows:
//   off      state transitions only; no text is stored or broadcast
//   summary  the first 200 characters (default)
//   full     the whole 2000-character clamp
// The file is written by POST /settings (UI token or token) and read at
// startup; GET /settings is open.
//
// answerPermissions (default true) says whether a Claude Code permission
// dialog may be answered from the office (server/permissions.js). The hook
// must know this before it decides to wait, without a round trip, so the
// server mirrors it as a marker file: $AGENT_OFFICE_HOME/answer-permissions
// exists while the setting is on and is removed when it is off. Without the
// marker the hook's PermissionRequest branch behaves as it always did.
// ---------------------------------------------------------------------------

const SETTINGS_FILE = join(RUNTIME_DIR, 'settings.json')
const ANSWER_MARKER_FILE = join(RUNTIME_DIR, 'answer-permissions')
const LOG_PROMPTS_LEVELS = new Map([['off', 0], ['summary', 200], ['full', MAX_TEXT_LEN]])
const settings = { logPrompts: 'summary', answerPermissions: true }

function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) return
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    if (saved && typeof saved === 'object') {
      if (LOG_PROMPTS_LEVELS.has(saved.logPrompts)) settings.logPrompts = saved.logPrompts
      if (typeof saved.answerPermissions === 'boolean') settings.answerPermissions = saved.answerPermissions
    }
  } catch (err) {
    console.warn('[settings] Could not read settings:', err.message)
  }
}

function saveSettings() {
  try {
    writePrivate(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
  } catch (err) {
    console.warn('[settings] Could not save settings:', err.message)
  }
}

/** The marker file the hook checks follows the answerPermissions setting (0600 like the token). */
function syncAnswerMarker() {
  try {
    if (settings.answerPermissions) writePrivate(ANSWER_MARKER_FILE, 'The office may answer permission dialogs (settings.answerPermissions).\n')
    else if (existsSync(ANSWER_MARKER_FILE)) unlinkSync(ANSWER_MARKER_FILE)
  } catch (err) {
    console.warn('[settings] Could not update the answer-permissions marker:', err.message)
  }
}

/**
 * Remove the answer-permissions marker. Called when the office stops (close /
 * SIGINT / SIGTERM / exit): the hook waits for an office answer only while the
 * marker is there, so a stopped office must not leave it behind, or every
 * later PermissionRequest would park on whatever now holds the port (a
 * squatter) instead of falling back to the terminal dialog at once.
 */
function removeAnswerMarker() {
  try { if (existsSync(ANSWER_MARKER_FILE)) unlinkSync(ANSWER_MARKER_FILE) } catch {}
}

/** Prompt / reply text at the configured logPrompts level: '' when off, else its first N characters. */
function transcriptText(text) {
  const max = LOG_PROMPTS_LEVELS.get(settings.logPrompts) ?? 0
  return max ? String(text ?? '').slice(0, max) : ''
}

/**
 * Bring the text the sessions already hold (main.lastPrompt / lastReply, in
 * memory and in agents.json) down to the current logPrompts level — or to
 * nothing (`clear`, the /clear command). Lowering the level is a promise about
 * what the office keeps from now on and about what it holds now: without this
 * an earlier prompt would ride on every later session_* broadcast. Returns
 * the sessions it changed; the caller saves and announces them.
 */
function retrimTranscripts({ clear = false } = {}) {
  const changed = []
  for (const session of sessions.values()) {
    const main = session.main
    if (!main) continue
    let touched = false
    for (const key of ['lastPrompt', 'lastReply']) {
      if (typeof main[key] !== 'string') continue
      const kept = clear ? '' : transcriptText(main[key])
      if (kept === main[key]) continue
      main[key] = kept
      touched = true
    }
    if (touched) changed.push(session)
  }
  return changed
}

/** retrimTranscripts, saved and broadcast (each changed session's main, as session_main). */
function retrimAndAnnounce(reason, opts) {
  const changed = retrimTranscripts(opts)
  if (!changed.length) return 0
  saveAgents()
  for (const session of changed) broadcast(mainEvent(session, reason))
  console.log(`[settings] ${reason}: text trimmed on ${changed.length} session(s)`)
  return changed.length
}

loadSettings()
syncAnswerMarker()
// agents.json was written under whatever level was set then; settings.json may say less now
if (retrimTranscripts().length) saveAgents()

/** Stop.background_tasks as forwarded by the tracker: at most 10, four clamped strings each. */
function sanitiseTasks(list) {
  if (!Array.isArray(list)) return undefined
  return list.slice(0, 10).filter(t => t && typeof t === 'object').map(t => ({
    id:          clampString(t.id, 64) ?? '',
    type:        clampString(t.type, 40) ?? '',
    status:      clampString(t.status, 40) ?? '',
    description: clampString(t.description, 120) ?? '',
  }))
}

// ---------------------------------------------------------------------------
// Signals — what a session's Bash commands mean
//
// The tracker classifies Bash commands that deploy, build, test or push
// (hooks/agent-tracker.sh, "Signals") and sends their start, success or
// failure as `signals: [...]` on the event the call sends anyway (or alone,
// as a `signal` event). The server checks them, keeps the last
// SIGNAL_RING_SIZE in memory — for the whole office and per session — and
// broadcasts one `signal` event per signal right after the event that
// carried it, so the office has already applied that call's tool status
// when the signal lands. GET /signals and the WS snapshot read the ring.
// Nothing is persisted: signals are about the last few minutes.
//
//   { kind, target?, detail?, error?, exitCode?, branch?, toDefault?,
//     interrupted?, sessionId?, project?, agentId?, agentName?, at, seq }
//
// agentId is the office id of the worker that ran the command (a subagent
// id the office knows is resolved), absent on the main thread. The command
// itself (clamped to 160) stays in the ring and is shown only to a caller
// with the office token, the way GET /sessions treats prompt text.
// ---------------------------------------------------------------------------

const SIGNAL_KINDS = new Set([
  'deploy_start', 'deploy_success', 'deploy_fail',
  'build_start', 'build_ok', 'build_failed',
  'test_start', 'test_ok', 'test_failed',
  'push', 'push_done', 'push_failed',
])
const MAX_SIGNALS_PER_EVENT = 8
const SIGNAL_RING_SIZE = 100
const SNAPSHOT_SIGNALS = 20

/** @type {object[]} the last SIGNAL_RING_SIZE signals, oldest first */
const signalRing = []
/** @type {Map<string, object[]>} sessionId -> that session's last SIGNAL_RING_SIZE signals */
const sessionSignals = new Map()
let signalSeq = 0

/** A tracker's signal list, checked and clamped: unknown kinds and non-objects are dropped. */
function sanitiseSignals(list) {
  if (!Array.isArray(list)) return []
  return list.filter(s => s && typeof s === 'object' && SIGNAL_KINDS.has(s.kind)).map(s => {
    const out = { kind: s.kind }
    const strings = { target: 80, command: 160, error: 200, detail: 120, branch: 120 }
    for (const [key, max] of Object.entries(strings)) {
      const value = clampString(s[key], max)
      if (value) out[key] = value
    }
    if (Number.isInteger(s.exitCode) && s.exitCode >= 0 && s.exitCode <= 255) out.exitCode = s.exitCode
    if (typeof s.toDefault === 'boolean') out.toDefault = s.toDefault
    if (s.interrupted === true) out.interrupted = true
    return out
  })
}

function pushRing(ring, record) {
  ring.push(record)
  if (ring.length > SIGNAL_RING_SIZE) ring.splice(0, ring.length - SIGNAL_RING_SIZE)
}

/** A ring record as the office page sees it: everything but the command. */
function publicSignal(record) {
  const { command, ...rest } = record
  return rest
}

/**
 * A ring record for a caller without the office token (GET /signals, a
 * read-only WebSocket): also without `error` (a line of the command's
 * output) and `detail` (what the tracker read from it). The kind, target
 * (a project or path name, as GET /sessions shows project and cwd), branch
 * and exit code stay: they are what the office draws.
 */
function readOnlySignal(record) {
  const { command, error, detail, ...rest } = record
  return rest
}

/**
 * Record and broadcast the signals an event carried. Called after the event
 * itself was processed and broadcast, so a subagent the event just bound is
 * known by its office id here.
 */
function relaySignals(body, signals) {
  if (!signals.length) return
  const session = body.sessionId ? sessions.get(body.sessionId) : undefined
  const project = session?.project ?? body.project
  const agentId = lookupAgentId(body.agentId) ?? undefined
  const agentName = agentId ? activeAgents.get(agentId)?.name : undefined
  for (const signal of signals) {
    const at = Date.now()
    const record = {
      ...signal,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(project ? { project } : {}),
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
      at,
      seq: ++signalSeq,
    }
    pushRing(signalRing, record)
    if (body.sessionId) {
      if (!sessionSignals.has(body.sessionId)) sessionSignals.set(body.sessionId, [])
      pushRing(sessionSignals.get(body.sessionId), record)
    }
    const what = [record.target, record.branch && `→ ${record.branch}`, record.detail, record.error && `— ${logText(record.error, 80)}`].filter(Boolean).join(' ')
    console.log(`[signal] ${project ?? body.sessionId ?? 'unknown session'}: ${record.kind}${what ? ` ${what}` : ''}${record.interrupted ? ' (interrupted)' : ''}${agentName ? ` [${agentName}]` : ''}`)
    // The inspector card of whoever ran the command shows it in its history
    recordActivity(agentId ?? (body.sessionId ? mainActivityId(body.sessionId) : null), { kind: 'status', text: `${record.kind}${what ? ` ${what}` : ''}` }, at)
    broadcast({ type: 'signal', ...publicSignal(record), timestamp: at })
  }
}

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Missing body'
  if (!body.type || typeof body.type !== 'string') return 'Missing event type'
  if (!KNOWN_EVENT_TYPES.has(body.type)) return `Unknown event type: ${body.type}`
  if (body.signals !== undefined) {
    if (!Array.isArray(body.signals)) return 'signals must be an array'
    if (body.signals.length > MAX_SIGNALS_PER_EVENT) return `At most ${MAX_SIGNALS_PER_EVENT} signals per event`
  }
  if (body.type === 'signal' && sanitiseSignals(body.signals).length === 0) return 'A signal event needs at least one known signal'
  return null
}

// ---------------------------------------------------------------------------
// Express + HTTP server
// ---------------------------------------------------------------------------

const app = express()

// JSON bodies: 10 KiB is plenty for a chat line or a tool event, but a
// session_prompt / session_turn_end carries up to MAX_TEXT_LEN characters of
// text (JSON-escaped, several bytes each) plus the background-task list, so
// /event alone takes more. Its sanitiser clamps every field it keeps.
const JSON_LIMIT = '10kb'
const EVENT_JSON_LIMIT = '64kb'
// Capture the exact request bytes so a signed request (the hook) can be
// verified over the body it actually sent (requestSignature / signatureValid).
const captureRaw = (req, _res, buf) => { req.rawBody = buf }
const jsonBody = express.json({ limit: JSON_LIMIT, verify: captureRaw })
const eventJsonBody = express.json({ limit: EVENT_JSON_LIMIT, verify: captureRaw })

// Host-header guard: the first thing every request passes, before the body
// parsers and CORS. A non-loopback (or missing) Host is a DNS-rebinding page
// or a cross-host request and is refused outright.
app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) {
    return res.status(421).json({ error: 'Forbidden host' })
  }
  next()
})

app.use((req, res, next) => (req.path === '/event' ? eventJsonBody : jsonBody)(req, res, next))

// CORS for local dev — only allow known localhost origins
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ error: 'Forbidden origin' })
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  next()
})

app.options('*', (_req, res) => res.sendStatus(204))

// Payroll / electricity / memory: POST /status + GET /status (server/status.js),
// fed by the Claude Code status line and keyed by the same session ids as `sessions`
const status = mountStatus(app, { requireToken, broadcast, staleMs: STALE_AGENT_MS, sessions })

/**
 * A permission was answered from the office: the session's hand comes down
 * the way a PostToolUse would lower it (the call is about to run, or Claude
 * is about to hear the denial and carry on), and the UI is told.
 */
function onOfficeDecision(permission) {
  const session = sessions.get(permission.sessionId)
  if (!session) return
  const isPermission = w => w && w.kind === 'permission'
  const pending = pendingNeedsYou.get(session.id)
  if (pending && isPermission(pending.wait)) cancelPendingNeedsYou(session.id)
  const main = mainOf(session)
  if (main.state !== 'needs-you' || !isPermission(main.needsYou)) return
  delete main.needsYou
  setMainState(session, 'working', `${permission.toolName} ${permission.status} from the office`)
  saveAgents()
  broadcast(mainEvent(session, 'permission answered from the office'))
}

// Answer a permission dialog from the office: GET /permissions, the hook's
// long-poll GET /permission/:id (token) and the page's POST /permission/:id
// (UI token). Pending records are created in POST /event below and released
// by the session's later activity in processEvent. GET /permissions shows a
// dialog's command line and suggestions only to a token holder.
const permissions = mountPermissions(app, {
  requireToken,
  requireUi,
  broadcast,
  onDecided: onOfficeDecision,
  canSeeDetail: req => { const supplied = bearerToken(req); return tokenMatches(supplied) || uiTokenMatches(supplied) },
  // The hook trusts a decision only when the office proves it holds the token:
  // HMAC(token, nonce + permissionId + decision) over the nonce the hook made.
  // A squatter has never seen the token, so it cannot forge this.
  proof: (nonce, id, decision) => createHmac('sha256', AUTH_TOKEN).update(`${nonce}${id}${decision}`).digest('hex'),
})

/**
 * The session showed activity after a PermissionRequest: whatever permission
 * was pending for it was answered in the terminal (see server/permissions.js).
 * `filter` narrows it, e.g. to records older than the PreToolUse race window.
 */
function releasePermissions(sessionId, reason, filter) {
  if (!sessionId) return
  permissions.resolveSession(sessionId, reason, filter)
}

// Pipeline health: GET /health + the throttled `health` broadcast (server/health.js);
// POST /event stamps it, the WS snapshot carries it, the status strip and `npm run doctor` read it.
// `sessions` counts every active session, registry-only ones included: "2 sessions, 0 hooks seen"
// is exactly the picture the doctor needs when the hooks are not installed.
const health = mountHealth(app, { broadcast, uiAvailable: UI_AVAILABLE, counts: () => ({ agents: activeAgents.size, clients: wss?.clients.size ?? 0, sessions: Array.from(sessions.values()).filter(s => s.state === 'active').length }) })

// The registry roster (server/sessions.js): Claude Code's own session registry
// adds the sessions nothing has hooks for, and ends them when their process
// goes. Nothing is read until start() — importing the module stays side-effect
// free and the tests point AGENT_OFFICE_REGISTRY_DIR at a temp dir.
const registry = mountRegistry(app, {
  sessions,
  broadcast,
  registryDir: REGISTRY_DIR,
  toEvent: sessionEvent,
  endSession,
  forgetSession,
  onStatusChange: registryStatusChanged,
})

/**
 * A hooked session's registry entry left "waiting": the permission dialog
 * that was on screen is gone — answered Yes (busy), rejected with Esc (idle;
 * no hook fires for that at all), or the process exited. Whatever office card
 * was pending for it is released as answered in the terminal, so a late click
 * is a 409 and the hook's poll ends silently, and a permission hand comes
 * down with it — only cards and hands from before the dialog closed (the
 * entry's statusUpdatedAt), so the next dialog's request, already in, stays.
 * The one time the registry touches a hooked session's main state.
 */
function registryStatusChanged(session, before, after, entry, t) {
  if (before !== 'waiting' || after === 'waiting' || session.hooked === false || session.state !== 'active') return
  const closedAt = entry?.statusUpdatedAt ?? t
  const what = `the dialog closed in the terminal (registry: waiting -> ${after ?? 'gone'})`
  releasePermissions(session.id, what, p => p.createdAt <= closedAt)
  const lowered = lowerPermissionHand(session, w => w.since <= closedAt, what, after === 'busy' || after === 'shell' ? 'working' : 'idle')
  if (lowered) broadcast({ ...lowered, reason: 'answered in the terminal' })
}

// The task board (server/tasks.js): each known session's task list, read from
// ~/.claude/tasks/<session id>/ and broadcast as `task_board` when it changes.
// GET /tasks is open; the task descriptions on it need the office token.
// Started with the server, like the registry roster.
const tasks = mountTasks(app, {
  sessions,
  broadcast,
  tasksDir: TASKS_DIR,
  hasToken: req => tokenMatches(bearerToken(req)),
})

/**
 * GET /config — what the page needs to know about this server before it
 * renders: the port and host it is bound to, the boss from
 * office.config.json (the file's fields over the defaults; `configFile` is
 * the path that was read, or null when there is none and `boss` is all
 * defaults, so the page keeps its bundled values then) and the version.
 * Open, like GET /health: nothing here that http://127.0.0.1:<port>/ does
 * not already show.
 */
app.get('/config', (_req, res) => {
  const { config, file } = loadOfficeConfig(CONFIG_DIR)
  const address = httpServer.address()
  const bound = address && typeof address === 'object' ? address : null
  res.json({
    port: bound?.port || PORT,
    host: bound?.address || '127.0.0.1',
    boss: bossFromConfig(config),
    configFile: file,
    version: VERSION,
  })
})

// MCP server roster + the agents in the office (same view as the WS snapshot)
app.get('/roster', (_req, res) => {
  const mcpServers = discoverMcpServers()
  res.json({
    mcpServers,
    activeAgents: liveAgents(),
  })
})

/**
 * POST /event — receives hook events from agent-tracker.sh
 *
 * Requires Authorization: Bearer <token> (the token in ~/.agent-office/auth-token).
 * Answers { ok: true, agentId? } — agentId is the office id of a spawned agent,
 * which matters when the spawn carried no id and one was derived.
 *
 * Accepted body shapes:
 *   { type: "agent_spawned",   agent: { name, role, task, id? } }
 *   { type: "agent_working",   agentId?, status, agentType?, role?, name?, failed? }
 *   { type: "agent_completed", agentId, result }
 *   { type: "agent_linked",    agentId, subagentId }
 *   { type: "agent_started",   subagentId, agentType, parentId? }   (SubagentStart)
 *
 * agentId on working/completed may be either the office id or a Claude Code
 * subagent id (from the hook payload's agent_id). agent.parentSubagentId on a
 * spawn is the subagent that made the Agent call (a nested spawn).
 *   { type: "mcp_call",        server, tool, agentId? }
 *   { type: "mcp_done",        server, tool?, callKey?, agentId? }
 *   { type: "session_started", sessionId, project, cwd, source, model?, title? }   (SessionStart)
 *   { type: "session_ended",   sessionId, reason }                                 (SessionEnd)
 *
 * The session's own Claude (its `main` record; all carry sessionId, promptId?):
 *   { type: "session_prompt",    text, isWakeup, wakeupAgentId?, wakeupStatus? }  (UserPromptSubmit)
 *   { type: "session_turn_end",  text, backgroundTasks[], crons, stopHookActive } (Stop)
 *   { type: "session_needs_you", kind, toolName?, summary?, message?, notificationType?, agentId?, callKey? }
 *                                                           (PermissionRequest, Notification)
 *   { type: "session_error",     error, detail }                                   (StopFailure)
 *   { type: "session_compact",   phase: "pre" | "post", trigger }                  (Pre/PostCompact)
 *   { type: "session_tool_done", toolName?, callKey? | batch: true, count; agentId? }
 *                                                           (PostToolUse / PostToolBatch; agentId inside a worker)
 *   { type: "session_cwd",       cwd, project, oldCwd? }                           (CwdChanged)
 *   { type: "session_model",     model, fromModel?, switchSource? }                (PostModelSwitch)
 *   { type: "task_created" | "task_completed", taskId, subject }        (TaskCreated, TaskCompleted)
 * A foreground agent's agent_completed may add tokens, durationMs, toolUses, model.
 *
 * What a Bash call meant (see Signals): agent_working (PreToolUse,
 * PostToolUseFailure) and session_tool_done (PostToolUse) may carry
 *   signals: [{ kind, target?, command?, error?, exitCode?, detail?, branch?, toDefault?, interrupted? }]
 * (at most 8; kinds outside SIGNAL_KINDS are dropped), and a call that sends
 * nothing else sends them alone:
 *   { type: "signal", signals: [...], agentId? }
 *
 * Every event may carry sessionId, project, cwd and transcriptPath — the
 * Claude Code session the hook fired in. Agents are filed under it.
 */
app.post('/event', requireToken, (req, res) => {
  const body = req.body

  // Validate event type
  const validationError = validateEvent(body)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  // Clamp string fields to prevent oversized payloads reaching the frontend
  const sanitised = {
    ...body,
    agent: body.agent ? {
      ...body.agent,
      name:   clampString(body.agent.name),
      role:   clampString(body.agent.role),
      task:   clampString(body.agent.task),
      id:     clampString(body.agent.id),
      agentType:  clampString(body.agent.agentType),
      background: !!body.agent.background,
      parentSubagentId: clampString(body.agent.parentSubagentId),
    } : undefined,
    agentId: clampString(body.agentId),
    subagentId: clampString(body.subagentId),
    parentId: clampString(body.parentId),
    failed: body.failed === true || undefined,
    agentType:  clampString(body.agentType),
    role:       clampString(body.role),
    name:       clampString(body.name),
    status:  clampString(body.status),
    result:  clampString(body.result),
    server:  clampString(body.server),
    tool:    clampString(body.tool),
    // Session identity (on every event) + session lifecycle fields
    sessionId:      clampString(body.sessionId),
    project:        clampString(body.project),
    cwd:            clampString(body.cwd, 400),
    transcriptPath: clampString(body.transcriptPath, 400),
    source:  clampString(body.source),
    model:   clampString(body.model),
    title:   clampString(body.title),
    reason:  clampString(body.reason),
    // The session's own Claude: prompt / reply text gets the chat-line clamp,
    // labels the usual 200, enums are checked, the task list is rebuilt
    promptId:         clampString(body.promptId, 80),
    text:             clampString(body.text, MAX_TEXT_LEN),
    isWakeup:         body.isWakeup === true || undefined,
    wakeupAgentId:    clampString(body.wakeupAgentId, 80),
    wakeupStatus:     clampString(body.wakeupStatus, 40),
    kind:             NEEDS_YOU_KINDS.has(body.kind) ? body.kind : undefined,
    toolName:         clampString(body.toolName, 80),
    // Which call a PermissionRequest / PostToolUse is (a hash of its input, see needs-you timing)
    callKey:          clampString(body.callKey, 64),
    summary:          clampString(body.summary),
    message:          clampString(body.message),
    notificationType: clampString(body.notificationType, 40),
    // A PermissionRequest the office may answer (server/permissions.js): the
    // detail is the command or the path (400), the suggestions go back to
    // Claude Code verbatim, so their shape is kept and their sizes bounded
    answerable:       body.answerable === true || undefined,
    // The per-request nonce the hook signs the server's proof over (hex, kept
    // out of the broadcast event and the public permission record)
    nonce:            clampString(body.nonce, 64),
    permissionMode:   clampString(body.permissionMode, 40),
    suggestions:      body.type === 'session_needs_you' ? sanitiseSuggestions(body.suggestions) : undefined,
    error:            clampString(body.error, 40),
    detail:           clampString(body.detail, body.type === 'session_needs_you' ? 400 : MAX_STRING_LEN),
    phase:            body.phase === 'pre' || body.phase === 'post' ? body.phase : undefined,
    trigger:          clampString(body.trigger, 20),
    backgroundTasks:  sanitiseTasks(body.backgroundTasks),
    crons:            clampCount(body.crons, 1000),
    stopHookActive:   body.stopHookActive === true || undefined,
    batch:            body.batch === true || undefined,
    count:            clampCount(body.count, 1000),
    oldCwd:           clampString(body.oldCwd, 400),
    fromModel:        clampString(body.fromModel, 80),
    switchSource:     clampString(body.switchSource, 20),
    // What a foreground agent cost (agent_completed)
    tokens:           clampCount(body.tokens),
    durationMs:       clampCount(body.durationMs),
    toolUses:         clampCount(body.toolUses),
    // The worker's own transcript file (SubagentStop.agent_transcript_path), for the inspector's tail
    agentTranscriptPath: clampString(body.agentTranscriptPath, 400),
    // TaskCreated / TaskCompleted: which task, and its subject (open, like an agent's task)
    taskId:           clampString(body.taskId, 40),
    subject:          clampString(body.subject, 120),
    // What the Bash call meant (see Signals): relayed below, not by processEvent
    signals:          undefined,
  }
  const signals = sanitiseSignals(body.signals)

  const event = processEvent(sanitised)
  if (event) {
    broadcast(event)
  }
  // After the event that carried them, so the office has its tool status first
  relaySignals(sanitised, signals)
  // The task board: a session's first event starts the watch on its task list,
  // its end stops it, TaskCreated / TaskCompleted make it look now
  tasks.noteEvent(sanitised)
  health.markHook()  // a hook reached us: what the strip's "last seen" counts (after the event, so its counts include it)
  status.noteHook(sanitised)  // MEMORY from the transcript for a session with no status line (throttled, read after we answer)

  // A PermissionRequest the hook will wait on: the response names the pending
  // record and how to poll it (server/permissions.js). Only while the setting
  // is on and the session is known; otherwise the hook gets the usual {ok} and
  // exits without printing, leaving the terminal dialog in charge.
  if (sanitised.type === 'session_needs_you' && sanitised.kind === 'permission' && sanitised.answerable && settings.answerPermissions && sanitised.sessionId) {
    const session = sessions.get(sanitised.sessionId)
    const { permission, wait } = permissions.create({
      sessionId: sanitised.sessionId,
      project: session?.project,
      cwd: session?.cwd ?? sanitised.cwd,
      sessionTitle: session?.title,
      toolName: sanitised.toolName,
      summary: sanitised.summary,
      detail: sanitised.detail,
      suggestions: sanitised.suggestions,
      permissionMode: sanitised.permissionMode,
      promptId: sanitised.promptId,
      agentId: sanitised.agentId,
      nonce: sanitised.nonce,
      callKey: sanitised.callKey,
    })
    return res.json({ ok: true, permissionId: permission.id, wait })
  }

  res.json({ ok: true, ...(event?.type === 'agent_spawned' ? { agentId: event.agent.id } : {}) })
})

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

function handleSlashCommand(cmd) {
  switch (cmd) {
    case '/status': {
      const agentCount = activeAgents.size
      const working = Array.from(activeAgents.values()).filter(a => a.state === 'working').length
      const clients = wss?.clients?.size ?? 0
      return `📊 ${agentCount} agents active, ${working} working, ${clients} clients connected`
    }
    case '/agents': {
      const agents = Array.from(activeAgents.values())
      if (agents.length === 0) return '🏢 Office is quiet — no agents active'
      return agents.map(a => `${a.name} (${a.role}) — ${a.state}`).join(', ')
    }
    case '/clear': {
      db.prepare('DELETE FROM messages').run()
      // The last prompt and reply on each session are the same conversation
      retrimAndAnnounce('chat cleared', { clear: true })
      return '🧹 Chat cleared'
    }
    // Incident mode ("Prod Is Down"): relayed to every connected office as a
    // variant_change so all tabs switch together. Nothing is persisted server-side.
    // Sent after the reply lines below so the office's own postmortem card lands
    // under the all-clear line rather than above it.
    case '/incident': {
      setImmediate(() => broadcast({ type: 'variant_change', variant: 'incident', reason: 'manual', timestamp: Date.now() }))
      return '🔴 INCIDENT DECLARED — prod is down. Everyone to the war room. (/all-clear when it is over)'
    }
    case '/all-clear': {
      setImmediate(() => broadcast({ type: 'variant_change', variant: 'none', reason: 'manual', timestamp: Date.now() }))
      return '✅ ALL CLEAR — incident over. Postmortem at 10, blameless, bring pizza.'
    }
    case '/help':
      return '📋 Commands: /status — office stats, /agents — list agents, /incident — declare an incident, /all-clear — end it, /clear — wipe chat history (needs the auth token), /help — this message'
    default:
      return null
  }
}

// Slash commands that destroy state need the office token. POST /chat itself
// is open because the office UI (a person typing) has no token — but so does
// any other local process, and it must not be able to truncate the chat.
const PRIVILEGED_COMMANDS = new Set(['/clear'])

// ---------------------------------------------------------------------------
// Chat — user messages from the office UI
// ---------------------------------------------------------------------------

/**
 * POST /chat — receives a message typed in the office Slack panel
 * No auth required for a plain line or a read-only slash command (comes from
 * the UI, not hooks); a privileged command (/clear) needs the bearer token.
 */
app.post('/chat', (req, res) => {
  const { sender, text } = req.body ?? {}
  if (!sender || !text) {
    return res.status(400).json({ error: 'Missing sender or text' })
  }

  // Slash command detection — handle before saving as normal message
  if (typeof text === 'string' && text.startsWith('/')) {
    const parts = text.split(' ')
    const cmd = parts[0]
    if (PRIVILEGED_COMMANDS.has(cmd) && !tokenMatches(bearerToken(req))) {
      // Tell the person in the chat panel why nothing happened (the UI ignores
      // the HTTP status), and the caller through the status
      const sysMsg = addMessage({ sender: 'system', text: `🔒 ${cmd} needs the office auth token — run python3 scripts/chat-post.py ${cmd} from the office checkout, which sends it (see README › Chat)`, isSystem: true })
      broadcast({ type: 'chat_message', ...sysMsg, isSystem: true })
      console.warn(`[chat] Refused ${cmd} from ${clampString(sender)}: no auth token`)
      return unauthorized(res, { error: `${cmd} needs the office auth token` })
    }
    const cmdResult = handleSlashCommand(cmd)
    if (cmdResult) {
      const userMsg = addMessage({ sender: clampString(sender), text: clampString(text, 2000) })
      broadcast({ type: 'chat_message', ...userMsg })
      const sysMsg = addMessage({ sender: 'system', text: cmdResult, isSystem: true })
      broadcast({ type: 'chat_message', ...sysMsg, isSystem: true })
      return res.json({ ok: true })
    }
  }

  const msg = addMessage({
    sender: clampString(sender),
    text: clampString(text, 2000),
  })

  // Broadcast to all WS clients
  broadcast({ type: 'chat_message', ...msg })

  // Smart notification — ping when "claude" or "@claude" is mentioned
  if (/claude/i.test(text)) {
    sendNotification('Office Chat', clampString(sender) + ': ' + text.slice(0, 50))
  }

  // Write to webhook file so Claude can detect new messages
  try {
    writePrivate(join(RUNTIME_DIR, 'last-chat'), JSON.stringify(msg))
  } catch {}

  console.log(`[chat] ${msg.sender}: ${msg.text}`)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Video mode — when enabled, GET /chat filters out scripted video messages
// so external Claude sessions only see real agent messages.
// Toggle via POST /chat/video-mode  { enabled: true/false }  (needs the token:
// it hides messages from every polling session)
// ---------------------------------------------------------------------------
let videoPaused = false
let videoPausedSince = 0

app.post('/chat/video-mode', requireToken, (req, res) => {
  videoPaused = !!req.body?.enabled
  videoPausedSince = videoPaused ? Date.now() : 0
  console.log(`[video-mode] chat polling ${videoPaused ? 'PAUSED' : 'RESUMED'}`)
  res.json({ ok: true, videoPaused })
})

/**
 * GET /chat — read recent chat messages (for Claude to read via terminal)
 * ?since=<timestamp> returns only messages after that time
 * ?recipient=<name> returns only messages directed at that agent
 * When video mode is active, only returns messages from before video started
 * (i.e. hides the scripted video messages but keeps old real ones)
 */
app.get('/chat', (req, res) => {
  const since = parseInt(req.query.since) || 0
  const recipient = typeof req.query.recipient === 'string' ? req.query.recipient : null
  // The Boss / Claude transcript rows only for a caller with the office token
  // (the chat watcher and any other local process never see them)
  let messages = getMessages({ since, limit: 50, recipient, transcript: tokenMatches(bearerToken(req)) })
  if (videoPaused && videoPausedSince) {
    // Hide any messages created after video mode was enabled (scripted messages)
    messages = messages.filter(m => m.timestamp < videoPausedSince)
  }
  res.json({ messages })
})

// ---------------------------------------------------------------------------
// Agent-to-agent (A2A) messaging
// ---------------------------------------------------------------------------

const A2A_TYPES = new Set(['message', 'question', 'review_request', 'task_handoff'])

// Loop budget: two agents can't trade more than this many directed messages
// (in either direction) per window, so a pair of bots can't chat forever.
const A2A_PAIR_LIMIT = Number(process.env.AGENT_OFFICE_A2A_LIMIT) || 10
const A2A_WINDOW_MS = 60_000
/** @type {Map<string, number[]>} "a|b" (sorted, lowercase) -> send timestamps */
const a2aPairLog = new Map()

function a2aBudgetLeft(a, b) {
  const key = [a.toLowerCase(), b.toLowerCase()].sort().join('|')
  const now = Date.now()
  const recent = (a2aPairLog.get(key) ?? []).filter(t => now - t < A2A_WINDOW_MS)
  a2aPairLog.set(key, recent)
  if (recent.length >= A2A_PAIR_LIMIT) return false
  recent.push(now)
  return true
}

/** Find an active agent by office id, subagent id, name or role (case-insensitive). */
function findAgent(ref) {
  if (!ref) return null
  const byId = lookupAgentId(ref)
  if (byId) return activeAgents.get(byId)
  const want = ref.toLowerCase()
  const live = Array.from(activeAgents.values()).filter(a => !a.server && a.state !== 'completed')
  return live.find(a => a.name?.toLowerCase() === want)
    ?? live.find(a => a.role?.toLowerCase() === want)
    ?? null
}

function inboxSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

/** The names a directed message to this agent may have been addressed by. */
function agentAddresses(agent) {
  return [agent.id, agent.subagentId, agent.name, agent.role].filter(Boolean)
}

/**
 * Send a directed (agent-to-agent) or plain reply message. Shared by
 * POST /chat/reply and the A2A JSON-RPC endpoint.
 * @returns {{ error?: string, status?: number, msg?: object, to?: string|null, recipientAgent?: object|null }}
 */
function sendAgentMessage({ sender, role, text, recipient, type, replyTo, senderId }) {
  if (!text || typeof text !== 'string') return { error: 'Missing text', status: 400 }

  let to = clampString(recipient)?.trim() || null
  let body = text
  if (!to) {
    // "@Debugger can you look at this" — only counts if Debugger is in the office
    const mention = /^@([\w-]+)[:,]?\s+/.exec(text)
    if (mention && findAgent(mention[1])) {
      to = mention[1]
      body = text.slice(mention[0].length)
    }
  }

  const from = clampString(sender || 'Claude')
  const senderAgent = findAgent(senderId) ?? findAgent(from)
  let msgType = null
  let recipientAgent = null
  if (to) {
    msgType = A2A_TYPES.has(type) ? type : 'message'
    recipientAgent = findAgent(to)
    const sameAgent = recipientAgent && senderAgent && recipientAgent.id === senderAgent.id
    if (sameAgent || to.toLowerCase() === from.toLowerCase()) {
      return { error: 'An agent cannot message itself', status: 400 }
    }
    if (!a2aBudgetLeft(from, to)) {
      return { error: `Loop budget hit: ${from} and ${to} have exchanged ${A2A_PAIR_LIMIT} messages in the last minute`, status: 429 }
    }
  }

  const msg = addMessage({
    sender: from,
    role: clampString(role || 'default'),
    text: clampString(body, 2000),
    threadId: Number.isInteger(replyTo) ? replyTo : null,
    recipient: to,
    msgType,
  })

  // The sender's own history (inspector card) remembers what it said
  if (senderAgent) recordActivity(senderAgent.id, { kind: 'message', text: to ? `to ${to}: ${msg.text}` : msg.text })

  // Broadcast as a chat message — the frontend will attribute it to an agent
  broadcast({
    type: 'chat_message',
    ...msg,
    senderId: senderAgent?.id ?? null,
    recipientId: recipientAgent?.id ?? null,
  })

  if (to) {
    try {
      const inboxDir = join(RUNTIME_DIR, 'inbox')
      mkdirSync(inboxDir, { recursive: true, mode: 0o700 })
      writePrivate(join(inboxDir, `${inboxSlug(to)}.json`), JSON.stringify(msg))
    } catch {}
    if (recipientAgent) {
      recipientAgent.unread = (recipientAgent.unread ?? 0) + 1
      saveAgents()
      broadcast({ type: 'inbox_update', agentId: recipientAgent.id, unread: recipientAgent.unread })
    }
    console.log(`[a2a] ${msg.sender} -> ${to} (${msgType}): ${msg.text}`)
  } else {
    console.log(`[reply] ${msg.sender}: ${msg.text}`)
  }
  return { msg, to, recipientAgent }
}

/**
 * GET /agents — directory of who is in the office right now, so agents can
 * discover each other before sending a directed message.
 */
app.get('/agents', (_req, res) => {
  const agents = Array.from(activeAgents.values())
    .filter(a => !a.server && a.state !== 'completed')
    .map(({ id, name, role, task, state, status, lastError, background, spawnedAt, lastActivityAt, unread, parentId, parentSubagentId, sessionId, project }) => ({
      id, name, role, task, state, status, lastError, background, spawnedAt, lastActivityAt, unread: unread ?? 0,
      // Lineage: the subagent that spawned this one and, once that parent is linked, its office id
      parentId: parentId ?? lookupAgentId(parentSubagentId) ?? undefined,
      parentSubagentId,
      // The Claude Code session (terminal) this agent works for
      sessionId,
      project,
    }))
  res.json({ agents })
})

// ---------------------------------------------------------------------------
// GET /agents/:id — the inspector card
// ---------------------------------------------------------------------------

/**
 * A character's transcript, read from its end once: `section` is what of the
 * tail the card may show at the current logPrompts level (or why nothing),
 * `usage` the last message's { tokens, model } — numbers, not conversation,
 * so they are read whatever logPrompts says.
 */
function transcriptFor(path, { withText }) {
  const maxChars = LOG_PROMPTS_LEVELS.get(settings.logPrompts) ?? 0
  const readable = !!path && isTranscriptPath(path) && existsSync(path)
  // Without a token the entries are dropped, so they need not be built at length
  const read = readable ? readTranscript(path, { maxChars: (withText && maxChars) || 1 }) : null
  let section
  if (!maxChars) section = { transcriptAvailable: false, transcriptReason: 'prompts off' }
  // What an agent said is conversation: only for the office page (UI token)
  // or a token holder, like the prompt / reply text on GET /sessions
  else if (!withText) section = { transcriptAvailable: false, transcriptReason: 'needs the office token' }
  else if (!path) section = { transcriptAvailable: false, transcriptReason: 'no transcript path yet' }
  else if (!readable) section = { transcriptAvailable: false, transcriptReason: 'transcript file not found' }
  else section = { transcriptAvailable: true, transcript: read.entries }
  return { section, usage: read?.usage ?? null }
}

function activityFor(id) {
  const entry = activity.get(id)
  return { history: entry ? entry.history.slice() : [], toolCounts: { ...(entry?.toolCounts ?? {}) } }
}

/** A worker's inspection: its GET /agents fields, its activity, its stats and its transcript tail. */
function inspectAgent(agent, { withText }) {
  const parentId = agent.parentId ?? lookupAgentId(agent.parentSubagentId) ?? null
  const session = agent.sessionId ? sessions.get(agent.sessionId) : null
  // The file SubagentStop named, else the one its session transcript and Claude agent id imply
  const path = agent.transcriptPath ?? agentTranscriptPath(session?.transcriptPath, agent.sessionId, agent.subagentId)
  const { section, usage } = transcriptFor(path, { withText })
  const activityNow = activityFor(agent.id)
  // What Claude Code reported (a foreground agent's PostToolUse(Agent)) wins;
  // a background agent's SubagentStop carries none of it, so the office
  // fills the gaps itself and lists the fields it filled in `derived`:
  // tokens and model from its transcript's last message (the same sum Claude
  // Code reports), once finished the duration from spawn to completion and
  // the tool uses the hook saw
  const derived = []
  const fill = (key, reported, value) => {
    if (reported !== undefined && reported !== null) return { [key]: reported }
    if (value === undefined || value === null) return {}
    derived.push(key)
    return { [key]: value }
  }
  const toolsSeen = Object.values(activityNow.toolCounts).reduce((sum, n) => sum + n, 0)
  const finished = typeof agent.completedAt === 'number'
  const stats = {
    spawnedAt: agent.spawnedAt,
    lastActivityAt: agent.lastActivityAt,
    ...(finished ? { completedAt: agent.completedAt } : {}),
    ...fill('tokens', agent.tokens, usage?.tokens),
    ...fill('durationMs', agent.durationMs, finished && typeof agent.spawnedAt === 'number' ? agent.completedAt - agent.spawnedAt : undefined),
    ...fill('toolUses', agent.toolUses, finished ? toolsSeen : undefined),
    ...fill('model', agent.model || undefined, usage?.model),
    parent: parentId ? { id: parentId, name: activeAgents.get(parentId)?.name ?? parentId } : null,
    unread: agent.unread ?? 0,
  }
  if (derived.length) stats.derived = derived
  return {
    id: agent.id,
    kind: 'worker',
    name: agent.name,
    role: agent.role,
    task: agent.task,
    agentType: agent.agentType,
    background: !!agent.background,
    // Back from agents.json after a server restart: its history starts at the restart
    restored: !!agent.restored,
    state: agent.state,
    status: agent.status,
    lastError: agent.lastError,
    spawnedAt: agent.spawnedAt,
    lastActivityAt: agent.lastActivityAt,
    unread: agent.unread ?? 0,
    parentId: parentId ?? undefined,
    parentSubagentId: agent.parentSubagentId,
    subagentId: agent.subagentId,
    sessionId: agent.sessionId,
    project: agent.project,
    ...activityNow,
    stats,
    ...section,
  }
}

/**
 * A session's own Claude: its main record (the prompt / reply text only with
 * the token, as GET /sessions), the model and crons, the session, its
 * activity and the tail of the session transcript.
 */
function inspectMain(session, { withText }) {
  const json = sessionToJSON(session, { withText })
  const main = json.main ?? newMain()
  // The session transcript's last message: its usage is how full the context
  // window is (the meters' MEMORY), its model a fallback for the session's
  const { section, usage } = transcriptFor(session.transcriptPath, { withText })
  const model = session.model ?? usage?.model
  return {
    id: mainActivityId(session.id),
    kind: 'main',
    name: 'Claude',
    role: 'assistant',
    state: main.state,
    status: session.lastStatus,
    lastStatusAt: session.lastStatusAt,
    sessionId: session.id,
    project: session.project,
    cwd: session.cwd,
    title: session.title,
    model,
    crons: main.crons ?? 0,
    // false: the session is known from Claude Code's registry only, no hook has reported yet
    hooked: session.hooked !== false,
    main,
    session: {
      id: session.id,
      project: session.project,
      cwd: session.cwd,
      title: session.title,
      source: session.source,
      state: session.state,
      hooked: session.hooked !== false,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      ...(session.endedAt ? { endedAt: session.endedAt, reason: session.reason } : {}),
      agentCount: json.agentCount,
      workingCount: json.workingCount,
    },
    ...activityFor(mainActivityId(session.id)),
    stats: {
      spawnedAt: session.startedAt,
      since: main.since,
      lastActivityAt: session.lastActivityAt,
      ...(model ? { model } : {}),
      ...(usage ? { contextTokens: usage.tokens } : {}),
      ...(!session.model && usage?.model ? { derived: ['model'] } : {}),
      parent: null,
      unread: 0,
    },
    ...section,
  }
}

/**
 * GET /agents/:id — one character for the inspector card: the agent's record
 * plus `history` (its last ACTIVITY_MAX tool calls, failures, completion and
 * messages), `toolCounts`, `stats` (spawnedAt, completedAt, tokens, duration,
 * tool uses and model when it has finished, its parent, unread) and the tail
 * of its own transcript. :id is an office id, a Claude subagent id, or
 * `main-<sessionId>` for a session's own Claude (its main record, model and
 * crons). Open on loopback like GET /agents, but conversation text — the
 * transcript tail and the main record's prompt / reply — goes only to the
 * office page (UI token) or a token holder, as on GET /sessions and
 * GET /chat; without one the card says `transcriptReason: 'needs the office
 * token'`. With one the tail follows logPrompts (off: none; summary: 200
 * characters per entry; full: 2000). The history, counts and stats stay open:
 * tool names, status lines and the completion line are what GET /agents,
 * GET /sessions and the agent broadcasts already show. An agent in its
 * completed grace window still answers; anything else is a 404.
 */
app.get('/agents/:id', (req, res) => {
  // The route stays open; a missing or wrong token only means no conversation text
  const supplied = bearerToken(req)
  const withText = tokenMatches(supplied) || uiTokenMatches(supplied)
  const ref = req.params.id
  if (ref.startsWith(MAIN_ID_PREFIX)) {
    const session = sessions.get(ref.slice(MAIN_ID_PREFIX.length))
    if (!session) return res.status(404).json({ error: 'Unknown agent' })
    return res.json(inspectMain(session, { withText }))
  }
  const id = lookupAgentId(ref)
  const agent = id ? activeAgents.get(id) : null
  if (!agent || agent.server) return res.status(404).json({ error: 'Unknown agent' })
  res.json(inspectAgent(agent, { withText }))
})

/**
 * GET /sessions — the Claude Code sessions (one per terminal) the office knows
 * about: project, cwd, how it started, its agent counts, the last main-thread
 * status and `main` — what the session's own Claude is doing (state, last
 * prompt and reply, what it waits on). Ended sessions stay listed for
 * SESSION_FORGET_MS.
 */
app.get('/sessions', (req, res) => {
  // The prompt / reply text in `main` only for a caller with the office token
  const withText = tokenMatches(bearerToken(req))
  res.json({ sessions: Array.from(sessions.values()).map(s => sessionToJSON(s, { withText })) })
})

/**
 * GET /signals?since=<ms>&sessionId=<id> — the last signals (see Signals),
 * oldest first: those after `since` (a timestamp, exclusive), from one
 * session's ring when sessionId names one. Open like GET /sessions; the
 * command each came from, and the output it printed (`error`, `detail`),
 * only for a caller with the office token (readOnlySignal).
 */
app.get('/signals', (req, res) => {
  const since = Number(req.query.since)
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
  const ring = sessionId ? (sessionSignals.get(sessionId) ?? []) : signalRing
  const withCommand = tokenMatches(bearerToken(req))
  const signals = ring.filter(s => !Number.isFinite(since) || s.at > since).map(s => (withCommand ? { ...s } : readOnlySignal(s)))
  res.json({ signals, now: Date.now() })
})

/**
 * GET /settings — the office settings (see Settings above). Open.
 * POST /settings — change them: { logPrompts: "off" | "summary" | "full",
 * answerPermissions: boolean }. Needs the UI token (the office page) or the
 * bearer token: it decides what of the conversation is kept and whether a
 * permission dialog may be answered from here.
 */
app.get('/settings', (_req, res) => {
  res.json({ ...settings, logPromptsLevels: Array.from(LOG_PROMPTS_LEVELS.keys()) })
})

app.post('/settings', requireUi, (req, res) => {
  const { logPrompts, answerPermissions } = req.body ?? {}
  if (logPrompts !== undefined) {
    if (typeof logPrompts !== 'string' || !LOG_PROMPTS_LEVELS.has(logPrompts)) {
      return res.status(400).json({ error: `logPrompts must be one of ${Array.from(LOG_PROMPTS_LEVELS.keys()).join(', ')}` })
    }
  }
  if (answerPermissions !== undefined && typeof answerPermissions !== 'boolean') {
    return res.status(400).json({ error: 'answerPermissions must be true or false' })
  }
  if (logPrompts !== undefined) settings.logPrompts = logPrompts
  if (answerPermissions !== undefined) settings.answerPermissions = answerPermissions
  saveSettings()
  syncAnswerMarker()
  console.log(`[settings] logPrompts = ${settings.logPrompts}, answerPermissions = ${settings.answerPermissions}`)
  // A lower level applies to the text already held too (rows in chat.db stay until /clear)
  if (logPrompts !== undefined) retrimAndAnnounce(`logPrompts ${settings.logPrompts}`)
  res.json({ ok: true, ...settings })
})

/**
 * POST /chat/reply — Claude replies as an agent in the office Slack
 * Body: { sender: "AgentName", role: "code-reviewer", text: "message",
 *         recipient?: "Debugger", type?: "question", replyTo?: <messageId> }
 *
 * With a recipient (or a leading "@Name" in the text) the message is directed:
 * it is stored with the recipient, readable via GET /chat?recipient=<name>, and
 * the latest one is written to ~/.agent-office/inbox/<recipient>.json so the
 * recipient's session can pick it up like last-chat.
 * Needs the bearer token: this speaks as an agent and writes to another agent's inbox.
 */
app.post('/chat/reply', requireToken, (req, res) => {
  const result = sendAgentMessage(req.body ?? {})
  if (result.error) return res.status(result.status).json({ error: result.error })
  res.json({ ok: true, id: result.msg.id, recipient: result.to, delivered: !!result.recipientAgent })
})

/**
 * POST /chat/inbox/read — the recipient has read its directed messages.
 * Body: { recipient: "Debugger" }  (office id, subagent id, name or role)
 * Clears the unread badge on the agent's desk. Needs the bearer token.
 */
app.post('/chat/inbox/read', requireToken, (req, res) => {
  const recipient = clampString(req.body?.recipient)?.trim()
  if (!recipient) return res.status(400).json({ error: 'Missing recipient' })
  const agent = findAgent(recipient)
  markInboxRead(agent ? [recipient, ...agentAddresses(agent)] : [recipient])
  if (agent && agent.unread) {
    agent.unread = 0
    saveAgents()
    broadcast({ type: 'inbox_update', agentId: agent.id, unread: 0 })
  }
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// A2A protocol surface — a subset of the Agent2Agent (A2A) spec so agents that
// speak A2A can reach office agents without learning the office's own API.
//
//   GET  /.well-known/agent-card.json   card for the office as a whole
//   GET  /a2a/agents                    one agent card per agent in the office
//   POST /a2a                           JSON-RPC 2.0, method "message/send"
//
// Office agents are addressed through message.metadata.to (id, name or role);
// the sender is message.metadata.from. Replies thread via referenceTaskIds or
// metadata.replyTo (an office message id). Tasks/streaming aren't supported —
// every message is delivered as-is and answered with the stored message.
// POST /a2a needs the office bearer token; the cards advertise it.
// ---------------------------------------------------------------------------

const A2A_PROTOCOL_VERSION = '0.3.0'
const A2A_URL = `http://localhost:${PORT}/a2a`
const A2A_SECURITY = {
  securitySchemes: {
    bearer: { type: 'http', scheme: 'bearer', description: 'The office auth token — the contents of ~/.agent-office/auth-token' },
  },
  security: [{ bearer: [] }],
}

function officeAgentCard(agent) {
  const cfgTitle = agent.name ?? 'Agent'
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: cfgTitle,
    description: agent.task || `${agent.role} agent in Agent Office`,
    url: A2A_URL,
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    ...A2A_SECURITY,
    skills: [{ id: agent.role, name: agent.role, description: agent.task || agent.role, tags: [agent.role] }],
    // Office-specific: how to address this agent in message.metadata.to
    metadata: { officeId: agent.id, state: agent.state, unread: agent.unread ?? 0 },
  }
}

/** Office chat row -> A2A Message object */
function toA2AMessage(msg) {
  return {
    kind: 'message',
    messageId: String(msg.id),
    role: 'agent',
    parts: [{ kind: 'text', text: msg.text }],
    ...(msg.thread_id ? { referenceTaskIds: [String(msg.thread_id)] } : {}),
    metadata: { from: msg.sender, to: msg.recipient, type: msg.msg_type, timestamp: msg.timestamp },
  }
}

app.get('/.well-known/agent-card.json', (_req, res) => {
  res.json({
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: 'Agent Office',
    description: 'Shared office for Claude Code agents. Send a message to any agent in the office; set metadata.to to its name, role or id (see GET /a2a/agents).',
    url: A2A_URL,
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    ...A2A_SECURITY,
    skills: [{
      id: 'office-message',
      name: 'Message an office agent',
      description: 'Deliver a message, question, review request or task handoff to an agent in the office.',
      tags: ['message', 'question', 'review_request', 'task_handoff'],
    }],
  })
})

app.get('/a2a/agents', (_req, res) => {
  const cards = Array.from(activeAgents.values())
    .filter(a => !a.server && a.state !== 'completed')
    .map(officeAgentCard)
  res.json({ agents: cards })
})

app.post('/a2a', requireTokenRpc, (req, res) => {
  const rpc = req.body ?? {}
  const id = rpc.id ?? null
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } })

  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return fail(-32600, 'Invalid Request')
  if (rpc.method !== 'message/send') return fail(-32601, `Method not found: ${rpc.method}`)

  const m = rpc.params?.message
  const text = Array.isArray(m?.parts)
    ? m.parts.filter(p => p?.kind === 'text' && typeof p.text === 'string').map(p => p.text).join('\n')
    : ''
  const meta = m?.metadata ?? {}
  if (!text) return fail(-32602, 'Invalid params: message.parts needs at least one text part')
  if (!meta.to) return fail(-32602, 'Invalid params: set message.metadata.to to the recipient agent')

  const replyTo = Number.parseInt(meta.replyTo ?? m.referenceTaskIds?.[0], 10)
  const result = sendAgentMessage({
    sender: meta.from,
    role: meta.role,
    senderId: meta.fromId,
    recipient: String(meta.to),
    type: meta.type,
    replyTo: Number.isInteger(replyTo) ? replyTo : undefined,
    text,
  })
  if (result.error) return fail(-32000, result.error)
  res.json({ jsonrpc: '2.0', id, result: toA2AMessage(result.msg) })
})

/**
 * A message id from a request body: a positive integer (or a string of
 * digits), else null. Anything else used to reach the prepared statement and
 * throw from inside better-sqlite3.
 */
function parseMessageId(value) {
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) value = Number(value)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * POST /chat/seen — mark a message as seen (the Claude watcher read it)
 * Body: { messageId: number }. Needs the bearer token.
 */
app.post('/chat/seen', requireToken, (req, res) => {
  const messageId = parseMessageId(req.body?.messageId)
  if (!messageId) {
    return res.status(400).json({ error: 'messageId must be a positive integer' })
  }
  markSeen(messageId)
  broadcast({ type: 'chat_seen', messageId })
  res.json({ ok: true })
})

/**
 * POST /chat/react — add or toggle an emoji reaction on a message
 * Body: { messageId: number, emoji: string }. Needs the bearer token.
 * A message holds at most MAX_REACTIONS distinct emoji (see chat-db.js).
 */
app.post('/chat/react', requireToken, (req, res) => {
  const messageId = parseMessageId(req.body?.messageId)
  const emoji = clampString(req.body?.emoji, 10)
  if (!messageId || !emoji) {
    return res.status(400).json({ error: 'messageId must be a positive integer and emoji a non-empty string' })
  }
  const reactions = addReaction(messageId, emoji)
  broadcast({ type: 'chat_reaction', messageId, reactions })
  res.json({ ok: true, reactions })
})

/**
 * POST /chat/typing — broadcast a typing indicator
 * Body: { sender: string }
 */
app.post('/chat/typing', (req, res) => {
  const { sender } = req.body ?? {}
  if (!sender) {
    return res.status(400).json({ error: 'Missing sender' })
  }
  broadcast({ type: 'chat_typing', sender: clampString(sender) })
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Cron/chat-monitor state — toggle from the frontend UI
// ---------------------------------------------------------------------------

const cronStatePath = join(RUNTIME_DIR, 'chat-poll-state')

app.get('/chat/cron-state', (_req, res) => {
  try {
    const data = readFileSync(cronStatePath, 'utf8')
    res.json(JSON.parse(data))
  } catch {
    res.json({ paused: false, consecutive_idle_count: 0, last_seen_timestamp: 0 })
  }
})

// Open on purpose: the office UI's pause button posts here with no token, and
// all it can do is flip the chat monitor's `paused` flag.
app.post('/chat/cron-state', (req, res) => {
  try {
    let state = {}
    try { state = JSON.parse(readFileSync(cronStatePath, 'utf8')) } catch {}
    state.paused = !!req.body?.paused
    writePrivate(cronStatePath, JSON.stringify(state))
    console.log(`[cron] Chat monitor ${state.paused ? 'PAUSED' : 'RESUMED'}`)
    res.json({ ok: true, paused: state.paused })
  } catch (err) {
    console.error('[cron] Could not write chat monitor state:', err.message)
    res.status(500).json({ error: 'Could not update chat monitor state' })
  }
})

// ---------------------------------------------------------------------------
// Event processing — normalise incoming hook payloads
// ---------------------------------------------------------------------------

function processEvent(body) {
  switch (body.type) {
    case 'agent_spawned': {
      const agent = body.agent ?? {}
      const id = resolveAgentId(agent)
      prunePendingStarts()
      const session = touchSession(body)
      if (activeAgents.has(id)) {
        // Replayed spawn (e.g. hook retry) — keep the existing record
        const existing = activeAgents.get(id)
        if (existing.state === 'completed') {
          // ...unless it already clocked out: re-announcing it would seat a ghost
          console.log(`[~] Ignoring replayed spawn of completed agent ${id}`)
          return null
        }
        if (session && !existing.sessionId) attachAgentToSession(existing, session)
        if (!existing.subagentId && adoptPendingStart(existing)) saveAgents()
        return { type: 'agent_spawned', agent: existing, timestamp: Date.now() }
      }
      let role = agent.role ?? 'general-purpose'
      if (role === 'general-purpose') role = leastUsedGeneralRole()
      const now = Date.now()
      const record = {
        id,
        name:   agent.name  ?? 'Agent',
        role,
        task:   agent.task  ?? agent.description ?? '',
        agentType: agent.agentType ?? agent.role ?? 'general-purpose',
        background: !!agent.background,
        state:  'new-hire',
        spawnedAt: now,
        lastActivityAt: now,
      }
      setLineage(record, agent.parentSubagentId)
      attachAgentToSession(record, session)
      activeAgents.set(id, record)
      // The Agent call is a tool use of whoever made it: the parent worker for
      // a nested spawn, else the session's own Claude. Not for the stand-in
      // the server makes for a subagent it never saw spawned (`recovered`).
      const spawner = agent.parentSubagentId ? record.parentId : session ? mainActivityId(session.id) : null
      if (spawner && !body.recovered) recordActivity(spawner, { kind: 'tool', tool: 'Agent', text: `spawned ${record.name}: ${record.task}` }, now)
      console.log(`[+] Agent spawned: ${record.name} (${record.role}) — ${id}${record.parentId ? ` (parent ${record.parentId})` : ''}${session ? ` [${session.project ?? session.id}]` : ''}`)
      // A SubagentStart that overtook this spawn on the way here is waiting for it
      adoptPendingStart(record)
      saveAgents()

      // Proactive message — announce task in chat
      const taskShort = (record.task ?? '').slice(0, 50)
      if (taskShort) {
        const chatMsg = addMessage({ sender: record.name, role: record.role, text: `starting: ${taskShort}` })
        broadcast({ type: 'chat_message', ...chatMsg })
      }

      return { type: 'agent_spawned', agent: record, timestamp: Date.now() }
    }

    case 'agent_linked': {
      touchSession(body)
      const id = lookupAgentId(body.agentId)
      if (id && body.subagentId) {
        linkSubagent(id, body.subagentId)
        pendingStarts.delete(body.subagentId)
        activeAgents.get(id).lastActivityAt = Date.now()
        saveAgents()
        console.log(`[~] Agent ${id} linked to subagent ${body.subagentId} by PostToolUse(Agent)`)
      }
      return null
    }

    case 'agent_started': {
      // SubagentStart: the subagent exists now. Tie it to the earliest recent
      // unbound agent of the same type — the PreToolUse(Agent) that spawned it
      // fired ~50 ms earlier, so that agent is normally in the office already.
      // When the start overtook its spawn, park it until that spawn arrives.
      const subagentId = body.subagentId
      if (!subagentId) return null
      touchSession(body)
      prunePendingStarts()
      const agentType = body.agentType || 'general-purpose'
      const known = lookupAgentId(subagentId)
      if (known) {
        // agent_linked (the PostToolUse of a background launch) got here first
        const agent = activeAgents.get(known)
        setLineage(agent, body.parentId)
        agent.lastActivityAt = Date.now()
        saveAgents()
        console.log(`[~] SubagentStart ${subagentId} (${agentType}) confirms agent ${known}`)
        return null
      }
      const agent = guessAgentForSubagent(agentType, body.sessionId, START_BIND_MS)
      if (agent) {
        linkSubagent(agent.id, subagentId)
        setLineage(agent, body.parentId)
        agent.lastActivityAt = Date.now()
        saveAgents()
        console.log(`[~] Agent ${agent.id} linked to subagent ${subagentId} (${agentType}) by SubagentStart`)
      } else {
        pendingStarts.set(subagentId, { agentType, parentId: body.parentId, sessionId: body.sessionId, at: Date.now() })
        console.log(`[~] SubagentStart ${subagentId} (${agentType}) arrived before its spawn — parked`)
      }
      return null
    }

    case 'agent_working': {
      const session = touchSession(body)
      let id = lookupAgentId(body.agentId)

      // A subagent id we haven't seen: no SubagentStart reached us (hook not
      // registered, server was down), so fall back to binding it to the
      // earliest recent unbound agent of the same type on its first tool call.
      if (!id && body.agentId && body.agentType) {
        const unbound = guessAgentForSubagent(body.agentType, body.sessionId, FIRST_TOOL_BIND_MS)
        if (unbound) {
          linkSubagent(unbound.id, body.agentId)
          id = unbound.id
          console.log(`[~] Agent ${id} bound to subagent ${body.agentId} by its first tool call (no SubagentStart seen)`)
        } else {
          pendingStarts.delete(body.agentId)
          const spawned = processEvent({
            type: 'agent_spawned',
            recovered: true,
            sessionId: body.sessionId,
            project: body.project,
            cwd: body.cwd,
            agent: {
              id:   `agent-${body.agentId}`,
              name: body.name ?? 'Agent',
              role: body.role ?? 'general-purpose',
              task: 'Picking up where they left off',
              agentType: body.agentType,
            },
          })
          broadcast(spawned)
          id = spawned.agent.id
          linkSubagent(id, body.agentId)
        }
      }

      if (id) {
        const agent = activeAgents.get(id)
        if (agent.state === 'completed') {
          // A straggling tool event for an agent already announced as done
          // and walking out (its forgetAgent timer is pending): a resurrected
          // record would be dropped by that timer without a word, and the
          // office would be told it is working while it stands at the door.
          console.log(`[~] Ignoring ${body.type} for completed agent ${id}`)
          return null
        }
        agent.state = 'working'
        agent.status = body.status ?? ''
        agent.lastActivityAt = Date.now()
        if (body.failed) {
          // A tool call errored (PostToolUseFailure); the agent carries on working
          agent.lastError = agent.status
          console.log(`[!] Agent ${id} ${agent.status}`)
        }
        recordActivity(id, { kind: body.failed ? 'failed' : 'tool', tool: body.tool ?? toolFromStatus(body.status), text: body.status }, agent.lastActivityAt)
        // An agent spawned before the hook knew its session learns it here
        if (session && !agent.sessionId) attachAgentToSession(agent, session)
        // The worker moved on: a dialog it raised has been answered in the
        // terminal (past the race window, as on the main thread below)
        const home = session ?? (agent.sessionId ? sessions.get(agent.sessionId) : null)
        const lowered = home ? threadMovedOn(home, body.agentId, `${agent.name ?? id}: ${logText(body.status)}`, { now: agent.lastActivityAt }) : null
        saveAgents()
        if (lowered) broadcast(lowered)
        return {
          type: 'agent_working',
          agentId: id,
          status: body.status,
          ...(body.failed ? { failed: true } : {}),
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
          timestamp: Date.now(),
        }
      }
      // Unknown or missing id is main-thread activity. It is remembered on the
      // session (the last thing Claude itself did), moves the session's Claude
      // to 'working', and the broadcast names the session, so the frontend can
      // show it there instead of on a random worker.
      if (session) {
        const now = Date.now()
        session.lastStatus = body.status ?? ''
        session.lastStatusAt = now
        mainWorking(session, body.status, now)
        recordActivity(mainActivityId(session.id), { kind: body.failed ? 'failed' : 'tool', tool: body.tool ?? toolFromStatus(body.status), text: body.status }, now)
        // PreToolUse / PostToolUseFailure on the main thread: a dialog the
        // main thread raised has been answered — unless this is the PreToolUse
        // of the very call that raised it, which can arrive after it
        // (PERMISSION_RACE_MS). A worker's dialog is not the main thread's to settle.
        releasePermissions(session.id, `tool call: ${logText(body.status)}`, p => !p.agentId && now - p.createdAt >= PERMISSION_RACE_MS)
        saveAgents()
      }
      return {
        type: 'agent_working',
        agentId: undefined,
        status: body.status,
        ...(body.failed ? { failed: true } : {}),
        ...(session ? { sessionId: session.id, project: session.project } : {}),
        timestamp: Date.now(),
      }
    }

    case 'agent_completed': {
      const touched = touchSession(body)
      const id = lookupAgentId(body.agentId)
      if (id && activeAgents.get(id).state === 'completed') {
        // Already announced and walking out — a foreground agent's SubagentStop
        // and its PostToolUse(Agent) both report it; the second says nothing
        console.log(`[-] Agent already completed: ${id}`)
        return null
      }
      // What a foreground agent cost, when its result said (PostToolUse(Agent) totals)
      const stats = {
        ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
        ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
        ...(body.toolUses !== undefined ? { toolUses: body.toolUses } : {}),
        ...(body.model ? { model: body.model } : {}),
      }
      if (id) {
        const agent = activeAgents.get(id)
        agent.state = 'completed'
        agent.completedAt = Date.now()
        Object.assign(agent, stats)
        // SubagentStop names the worker's own transcript; kept only when it looks like one
        if (isTranscriptPath(body.agentTranscriptPath)) agent.transcriptPath = body.agentTranscriptPath
        recordActivity(id, { kind: 'completed', text: body.result ?? 'done' }, agent.completedAt)
        saveAgents()
        // Remove after a short grace period so frontends can animate exit
        setTimeout(() => forgetAgent(id), 10_000)

        // Proactive message — announce completion in chat
        const resultShort = (body.result ?? 'done').slice(0, 50)
        const chatMsg = addMessage({ sender: agent.name, role: agent.role, text: `done: ${resultShort}` })
        broadcast({ type: 'chat_message', ...chatMsg })

        // Smart notification — alert on failure
        if (/error|fail/i.test(body.result ?? '')) {
          sendNotification('Agent Failed', agent.name + ' failed')
        }
      }
      console.log(`[-] Agent completed: ${id ?? body.agentId}${stats.tokens !== undefined ? ` (${stats.tokens} tokens${stats.durationMs !== undefined ? `, ${stats.durationMs} ms` : ''})` : ''}`)
      const sessionId = id ? activeAgents.get(id).sessionId : undefined
      // The worker is done: whatever it was waiting on in the terminal is over
      const home = (sessionId ? sessions.get(sessionId) : null) ?? touched
      if (home && body.agentId) {
        const lowered = threadMovedOn(home, body.agentId, `${id ? activeAgents.get(id).name ?? id : body.agentId} finished`, { finished: true })
        if (lowered) broadcast(lowered)
      }
      return {
        type: 'agent_completed',
        agentId: id ?? body.agentId,
        result: body.result,
        ...stats,
        ...(sessionId ? { sessionId } : {}),
        timestamp: Date.now(),
      }
    }

    case 'mcp_call': {
      const session = touchSession(body)
      // Two calls to the same MCP in one millisecond (two terminals, say)
      // must not share a record
      let id = `mcp-${body.server}-${Date.now()}`
      for (let n = Date.now() + 1; activeAgents.has(id); n++) id = `mcp-${body.server}-${n}`
      const record = {
        id,
        name:   body.server ?? 'mcp',
        role:   body.server ?? 'default',
        server: body.server,
        tool:   body.tool,
        state:  'working',
        spawnedAt: Date.now(),
        ...(session ? { sessionId: session.id, project: session.project } : {}),
      }
      // Track MCP agents transiently
      activeAgents.set(record.id, record)
      console.log(`[mcp] ${body.server} / ${body.tool}`)
      // An MCP call is the session's Claude at work (the hook sends them without an agent id)
      if (session) {
        recordActivity(mainActivityId(session.id), {
          kind: 'tool',
          tool: body.tool ? `mcp__${body.server}__${body.tool}` : `mcp__${body.server}`,
          text: `${body.server ?? 'mcp'}${body.tool ? ` / ${body.tool}` : ''}`,
        })
      }
      return {
        type: 'mcp_call', server: body.server, tool: body.tool, agentId: record.id,
        ...(session ? { sessionId: session.id } : {}),
        timestamp: Date.now(),
      }
    }

    case 'mcp_done': {
      const session = touchSession(body)
      // Clean up the mcp agent entries for this server — only this session's
      // when the event says which, so two terminals on the same MCP don't
      // clear each other's workers
      for (const [id, agent] of activeAgents.entries()) {
        if (agent.server !== body.server || agent.state !== 'working') continue
        if (session && agent.sessionId && agent.sessionId !== session.id) continue
        activeAgents.delete(id)
      }
      // The MCP call's own PostToolUse: the permission it asked for (as
      // mcp__<server>__<tool>) was granted, exactly as for any other tool
      if (session && body.tool) {
        const lowered = toolDone(session, { toolName: `mcp__${body.server}__${body.tool}`, callKey: body.callKey, agentId: body.agentId })
        if (lowered) broadcast(lowered)
      }
      return { type: 'mcp_done', server: body.server, ...(session ? { sessionId: session.id } : {}), timestamp: Date.now() }
    }

    case 'session_started': {
      // SessionStart hook: startup | resume | compact | clear | fork. The same
      // session_id comes back on a resume, so an ended session is revived.
      const id = body.sessionId
      if (!id) return null
      const now = Date.now()
      const source = body.source || 'startup'
      let session = sessions.get(id)
      if (!session) {
        session = createSession({ id, project: body.project, cwd: body.cwd, source, model: body.model, title: body.title, transcriptPath: body.transcriptPath, now })
      } else {
        if (session.state === 'ended') {
          clearSessionTimer(id)
          session.state = 'active'
          delete session.endedAt
          delete session.reason
          session.main = newMain(now)
          console.log(`[session] back (${source}): ${session.project ?? id} (${id})`)
        }
        // A registry-only session's first SessionStart: hooked from now on
        hookSession(session, source === 'compact' ? 'implicit' : source, now)
        session.lastActivityAt = now
        // Compaction fires SessionStart too, but it is not how the session started
        if (source !== 'compact') session.source = source
        const project = projectName(body.project, body.cwd)
        if (project) session.project = project
        if (body.cwd) session.cwd = body.cwd
        if (body.model) session.model = body.model
        if (body.title) session.title = body.title
        if (body.transcriptPath) session.transcriptPath = body.transcriptPath
      }
      saveAgents()
      return sessionEvent(session)
    }

    case 'session_ended': {
      // SessionEnd hook (reason: other | prompt_input_exit | ...), or the
      // stale sweep below. Agents still at their desks clock out.
      const id = body.sessionId
      if (!id) return null
      const reason = body.reason || 'other'
      const session = sessions.get(id)
      if (!session) return { type: 'session_ended', sessionId: id, reason, timestamp: Date.now() }
      if (session.state !== 'ended') endSession(session, reason)
      return sessionEvent(session, 'session_ended')
    }

    // ── The session's own Claude (see `main` near the session tracking) ────

    case 'session_prompt': {
      // UserPromptSubmit: the boss spoke (or a background worker woke Claude
      // up — isWakeup, with the worker's subagent id in wakeupAgentId)
      const session = touchSession(body)
      if (!session) return null
      const now = Date.now()
      const main = mainOf(session, now)
      const text = transcriptText(body.text)
      const wakeup = body.isWakeup === true
      main.lastPrompt = text
      main.lastPromptAt = now
      if (body.promptId) main.promptId = body.promptId
      cancelPendingNeedsYou(session.id)
      releasePermissions(session.id, wakeup ? 'woken by a background task' : 'new prompt')
      delete main.needsYou
      delete main.error
      delete main.beforeCompact
      setMainState(session, 'working', wakeup ? `woken by ${body.wakeupAgentId ?? 'a background task'}` : 'prompt', now)
      console.log(`[main] ${sessionName(session)}: ${wakeup ? 'wake-up' : 'prompt'}: ${logText(text)}`)
      // The boss's words become a chat row (role 'boss', msg_type 'prompt')
      // for the transcript; the chat watcher only answers role 'default'
      // rows, so it never replies to them. A wake-up is not the boss speaking.
      const row = text && !wakeup ? addMessage({ sender: 'Boss', role: 'boss', text, msgType: 'prompt' }) : null
      const wakeupOfficeId = wakeup ? lookupAgentId(body.wakeupAgentId) : null
      saveAgents()
      return {
        type: 'session_prompt',
        sessionId: session.id,
        project: session.project,
        ...(body.promptId ? { promptId: body.promptId } : {}),
        text,
        isWakeup: wakeup,
        ...(body.wakeupAgentId ? { wakeupAgentId: body.wakeupAgentId } : {}),
        ...(wakeupOfficeId ? { wakeupOfficeId } : {}),
        ...(body.wakeupStatus ? { wakeupStatus: body.wakeupStatus } : {}),
        ...(row ? { messageId: row.id } : {}),
        main: { ...main },
        timestamp: now,
      }
    }

    case 'session_turn_end': {
      // Stop: Claude replied. Still-running background tasks mean it is
      // waiting to be woken, otherwise it is idle until the next prompt.
      const session = touchSession(body)
      if (!session) return null
      const now = Date.now()
      const main = mainOf(session, now)
      const text = transcriptText(body.text)
      const tasks = Array.isArray(body.backgroundTasks) ? body.backgroundTasks : []
      const inFlight = tasks.filter(t => TASK_IN_FLIGHT.test(t.status ?? ''))
      main.lastReply = text
      main.lastReplyAt = now
      main.waitingOn = inFlight.length
      main.crons = body.crons ?? 0
      if (body.promptId) main.promptId = body.promptId
      cancelPendingNeedsYou(session.id)
      releasePermissions(session.id, 'turn ended')
      delete main.needsYou
      delete main.error
      delete main.beforeCompact
      if (inFlight.length) setMainState(session, 'waiting', `turn ended, ${inFlight.length} background task(s) still running`, now)
      else setMainState(session, 'idle', 'turn ended', now)
      console.log(`[main] ${sessionName(session)}: reply: ${logText(text)}`)
      // Claude's words become a chat row too (role 'assistant', msg_type 'reply')
      const row = text ? addMessage({ sender: 'Claude', role: 'assistant', text, msgType: 'reply' }) : null
      saveAgents()
      return {
        type: 'session_turn_end',
        sessionId: session.id,
        project: session.project,
        ...(body.promptId ? { promptId: body.promptId } : {}),
        text,
        // A subagent task is also given its office agent id when the office knows it
        backgroundTasks: tasks.map(t => {
          const officeId = lookupAgentId(t.id)
          return officeId ? { ...t, officeId } : { ...t }
        }),
        crons: main.crons,
        stopHookActive: body.stopHookActive === true,
        ...(row ? { messageId: row.id } : {}),
        main: { ...main },
        timestamp: now,
      }
    }

    case 'session_needs_you': {
      // PermissionRequest / Notification: the session is waiting on a person.
      // The wait is parked for NEEDS_YOU_DEBOUNCE_MS (see applyNeedsYou) so a
      // headless auto-deny, answered by its PostToolBatch within ~60 ms,
      // never shows; nothing is broadcast here.
      if (!NEEDS_YOU_KINDS.has(body.kind)) return null
      const session = touchSession(body)
      if (!session) return null
      const now = Date.now()
      const main = mainOf(session, now)
      // Answering from the office (server/permissions.js): a Notification
      // proves the session is interactive, so a pending permission of it may
      // wait the full ten minutes; a new PermissionRequest (the hook's, not a
      // Notification's) means the previous dialog was answered. Both happen
      // before the dedupe below, which only concerns the hand.
      if (body.notificationType) permissions.markInteractive(session.id)
      else if (body.kind === 'permission') releasePermissions(session.id, 'a new permission request')
      // A Notification names no tool: it is the dialog already waited on. A
      // PermissionRequest is the same wait only from the same thread for the
      // same call (another call of that tool is another dialog)
      const sameWait = w => w && w.kind === body.kind
        && (w.promptId ?? null) === (body.promptId ?? null)
        && (!body.toolName || (w.toolName === body.toolName && sameThread(callOf(w).agentId, body.agentId) && sameCallKey(callOf(w).callKey, body.callKey)))
      // One wait, several hooks (PermissionRequest, then Notification
      // {permission_prompt} ~6 s later): a repeat for the same prompt within
      // NEEDS_YOU_DEDUPE_MS changes nothing
      const current = main.state === 'needs-you' ? main.needsYou : null
      if (sameWait(current) && now - current.since < NEEDS_YOU_DEDUPE_MS) {
        console.log(`[main] ${sessionName(session)}: needs-you (${body.kind}) repeated within ${NEEDS_YOU_DEDUPE_MS / 1000}s — ignored`)
        return null
      }
      const pending = pendingNeedsYou.get(session.id)
      if (pending && sameWait(pending.wait)) return null
      cancelPendingNeedsYou(session.id)
      const wait = {
        kind: body.kind,
        since: now,
        ...(body.promptId ? { promptId: body.promptId } : {}),
        ...(body.toolName ? { toolName: body.toolName } : {}),
        ...(body.summary ? { summary: body.summary } : {}),
        ...(body.message ? { message: body.message } : {}),
        ...(body.notificationType ? { notificationType: body.notificationType } : {}),
      }
      // Which call asked (see "Which call a permission wait belongs to")
      if (body.agentId || body.callKey) waitCalls.set(wait, { ...(body.agentId ? { agentId: body.agentId } : {}), ...(body.callKey ? { callKey: body.callKey } : {}) })
      console.log(`[main] ${sessionName(session)}: needs-you requested (${needsYouLabel(wait)})`)
      const timer = setTimeout(() => applyNeedsYou(session.id), NEEDS_YOU_DEBOUNCE_MS)
      timer.unref?.()
      pendingNeedsYou.set(session.id, { wait, agentId: body.agentId, timer })
      return null
    }

    case 'session_tool_done': {
      // A tool call ran (PostToolUse) or a whole batch of them was answered
      // (PostToolBatch), on the main thread or inside the worker agentId
      // names: the permission it answers — that call's own, or every one of
      // the thread's for a batch — was granted or settled in the terminal
      // (toolDone). Another call of the same tool says nothing about it.
      const session = touchSession(body)
      if (!session) return null
      // A worker's call is activity of that worker too
      const workerId = lookupAgentId(body.agentId)
      if (workerId && activeAgents.get(workerId).state !== 'completed') activeAgents.get(workerId).lastActivityAt = Date.now()
      return toolDone(session, { toolName: body.toolName, callKey: body.callKey, agentId: body.agentId, batch: body.batch, count: body.count })
    }

    case 'session_cwd': {
      // CwdChanged: the session moved; its project tag (and its workers') follows
      const session = touchSession(body)
      if (!session || !body.cwd) return null
      const oldCwd = body.oldCwd ?? session.cwd
      session.cwd = body.cwd
      session.project = projectName(body.project, body.cwd)
      for (const agentId of session.agentIds) {
        const agent = activeAgents.get(agentId)
        if (agent) agent.project = session.project
      }
      saveAgents()
      console.log(`[session] cwd: ${oldCwd ?? '?'} -> ${body.cwd} (${session.project ?? session.id})`)
      return { ...sessionEvent(session, 'session_cwd'), ...(oldCwd ? { oldCwd } : {}) }
    }

    case 'session_model': {
      // PostModelSwitch: the session runs another model from here on
      const session = touchSession(body)
      if (!session || !body.model) return null
      const fromModel = body.fromModel ?? session.model
      session.model = body.model
      saveAgents()
      console.log(`[session] model: ${fromModel ?? '?'} -> ${body.model}${body.switchSource ? ` (${body.switchSource})` : ''} (${session.project ?? session.id})`)
      return {
        ...sessionEvent(session, 'session_model'),
        ...(fromModel ? { fromModel } : {}),
        ...(body.switchSource ? { switchSource: body.switchSource } : {}),
      }
    }

    case 'session_error': {
      // StopFailure: the turn ended on an API error (rate_limit, overloaded, ...)
      const session = touchSession(body)
      if (!session) return null
      const now = Date.now()
      const main = mainOf(session, now)
      main.error = { error: body.error || 'unknown', detail: body.detail ?? '', since: now }
      if (body.promptId) main.promptId = body.promptId
      cancelPendingNeedsYou(session.id)
      releasePermissions(session.id, 'turn failed')
      delete main.needsYou
      delete main.beforeCompact
      setMainState(session, 'error', `${main.error.error}${main.error.detail ? `: ${logText(main.error.detail, 80)}` : ''}`, now)
      saveAgents()
      return {
        type: 'session_error',
        sessionId: session.id,
        project: session.project,
        ...(body.promptId ? { promptId: body.promptId } : {}),
        error: main.error.error,
        detail: main.error.detail,
        main: { ...main },
        timestamp: now,
      }
    }

    case 'session_compact': {
      // PreCompact / PostCompact: Claude is rewriting its memory. A `pre`
      // may have no `post` (compaction refused), so any later event moves on.
      if (body.phase !== 'pre' && body.phase !== 'post') return null
      const session = touchSession(body)
      if (!session) return null
      const now = Date.now()
      const main = mainOf(session, now)
      const trigger = body.trigger || 'manual'
      if (body.phase === 'pre') {
        if (main.state !== 'compacting') main.beforeCompact = main.state
        setMainState(session, 'compacting', `${trigger} compaction`, now)
      } else if (main.state === 'compacting') {
        // Back to what Claude was doing; idle when the pre was never seen
        const back = MAIN_STATES.has(main.beforeCompact) && main.beforeCompact !== 'compacting' ? main.beforeCompact : 'idle'
        delete main.beforeCompact
        setMainState(session, back, 'compaction done', now)
      }
      saveAgents()
      return {
        type: 'session_compact',
        sessionId: session.id,
        project: session.project,
        ...(body.promptId ? { promptId: body.promptId } : {}),
        phase: body.phase,
        trigger,
        main: { ...main },
        timestamp: now,
      }
    }

    case 'signal': {
      // A Bash call's signals with no event of their own (a worker's
      // PostToolUse): the session is alive; POST /event relays the signals
      const session = touchSession(body)
      const id = lookupAgentId(body.agentId)
      if (id) activeAgents.get(id).lastActivityAt = Date.now()
      if (session || id) saveAgents()
      return null
    }

    case 'task_created':
    case 'task_completed': {
      // TaskCreated / TaskCompleted: the session is alive and its Claude's
      // history gets a line. Nothing is broadcast from here — the board comes
      // from the task files (POST /event has server/tasks.js rescan them)
      const session = touchSession(body)
      if (!session) return null
      const label = `task ${body.type === 'task_created' ? 'created' : 'completed'}: ${body.subject || `#${body.taskId ?? '?'}`}`
      recordActivity(mainActivityId(session.id), { kind: 'status', text: label })
      console.log(`[tasks] ${sessionName(session)}: ${logText(label, 100)}`)
      saveAgents()
      return null
    }

    default:
      console.warn(`[?] Unknown event type: ${body.type}`)
      return null
  }
}

// An MCP record lives for one call. When its mcp_done never arrives (the tool
// was denied in PreToolUse, the session was interrupted, the hook's curl was
// dropped) it is forgotten after this long instead of lingering until restart.
const MCP_STALE_MS = (Number(process.env.AGENT_OFFICE_MCP_STALE_MINUTES) || 5) * 60_000

/**
 * Walk out agents that went silent (lost hand-back, killed session, ...), end
 * sessions nothing has been heard from for as long (missed SessionEnd), and
 * drop MCP calls that never reported done. Runs every minute; `now` is a
 * parameter so tests can sweep a future.
 */
function sweepStale(now = Date.now()) {
  const cutoff = now - STALE_AGENT_MS
  for (const session of Array.from(sessions.values())) {
    // A session with a live registry entry has a running process, however
    // quiet it is; the registry ends it when the process goes
    if (session.registry) continue
    if (session.state === 'active' && session.lastActivityAt < cutoff) {
      broadcast(processEvent({ type: 'session_ended', sessionId: session.id, reason: 'stale' }))
    }
  }
  for (const agent of Array.from(activeAgents.values())) {
    if (agent.state === 'completed') continue
    if (agent.server) {
      if ((agent.spawnedAt ?? 0) < now - MCP_STALE_MS) {
        activeAgents.delete(agent.id)
        console.log(`[mcp] ${agent.server} / ${agent.tool} never reported done — dropped after ${MCP_STALE_MS / 60_000} min`)
        broadcast({
          type: 'mcp_done', server: agent.server, agentId: agent.id, reason: 'stale',
          ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
          timestamp: now,
        })
      }
      continue
    }
    if ((agent.lastActivityAt ?? agent.spawnedAt) < cutoff) {
      broadcast(processEvent({ type: 'agent_completed', agentId: agent.id, result: 'went quiet, clocking out' }))
    }
  }
}

setInterval(() => sweepStale(), 5 * 60_000).unref()

// ---------------------------------------------------------------------------
// Static UI — registered after every API route so /health, /chat, ... win
// ---------------------------------------------------------------------------

if (UI_AVAILABLE) {
  app.use(express.static(UI_DIR))
} else {
  app.get('/', (_req, res) => {
    res.status(404).json({
      error: 'Office UI not built. Run `npm run build` to serve it from here, or `npm run dev` for the Vite dev server on port 3333.',
    })
  })
}

// ---------------------------------------------------------------------------
// Errors — registered last, after every route and the static UI (a route
// added below this line is not covered). Only errors come here: a request
// nothing matched still falls through to Express's plain 404.
// ---------------------------------------------------------------------------

const BODY_ERROR_MESSAGES = {
  'entity.parse.failed': 'Malformed JSON body',
  'entity.too.large': 'Request body too large',
}

/**
 * Every error becomes a small JSON body. Without this Express answers an
 * uncaught exception with its stack trace — absolute install paths and all —
 * whenever NODE_ENV is unset. body-parser's errors carry a status and a type;
 * anything else is a 500, logged here and nowhere else.
 */
function jsonErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500
  const error = BODY_ERROR_MESSAGES[err?.type] ?? (status < 500 ? 'Bad request' : 'Internal error')
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err)
  res.status(status).json({ error })
}

app.use(jsonErrorHandler)

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The WebSocket — trusted with the file token, read-only without it
//
// The Origin check keeps web pages on other origins out, but it cannot tell
// the office page from another local process: anything on this machine can
// open ws://127.0.0.1:<port>/ws and send any Origin. So each connection is
// authenticated at the handshake with the file token. Browsers cannot set
// headers on a WebSocket, so the page sends it as a subprotocol value:
//
//   Sec-WebSocket-Protocol: agent-office, agent-office.token.<token>
//
// (a header, never part of a URL, so it stays out of history and access
// logs). The server answers with plain `agent-office`, so the token is not
// echoed back. src/officeToken.ts builds the same list.
//
// A connection that presents the token is trusted: the full snapshot, the
// UI token, every broadcast as is. Any other connection — no token, a wrong
// one — is not refused: the office stays viewable read-only (a bare
// bookmark, a second browser), with no UI token and no conversation text.
// redactForReadOnly says what that view leaves out. Each connection is told
// which it is, first thing: { type: 'auth', trusted }.
// ---------------------------------------------------------------------------

const WS_PROTOCOL = 'agent-office'
const WS_TOKEN_PROTOCOL_PREFIX = 'agent-office.token.'

/** The token a WebSocket handshake offered as a subprotocol, or ''. */
function wsTokenFrom(req) {
  const header = req.headers['sec-websocket-protocol']
  if (typeof header !== 'string') return ''
  for (const part of header.split(',')) {
    const value = part.trim()
    if (value.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return value.slice(WS_TOKEN_PROTOCOL_PREFIX.length)
  }
  return ''
}

/** The subprotocol the server agrees to: `agent-office` when offered, never the token. */
function handleProtocols(protocols) {
  return protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false
}

// The chat rows that are the conversation itself (see chat-db.js)
const TRANSCRIPT_MSG_TYPES = new Set(['prompt', 'reply'])

/** A copy of `obj` without `keys`. */
function omit(obj, keys) {
  const out = { ...obj }
  for (const key of keys) delete out[key]
  return out
}

/** An event's `main` without the last prompt and reply text (what GET /sessions shows without the token). */
function withoutMainText(event) {
  const main = event.main
  if (!main || typeof main !== 'object' || !('lastPrompt' in main || 'lastReply' in main)) return event
  return { ...event, main: omit(event.main, ['lastPrompt', 'lastReply']) }
}

/**
 * What a read-only connection gets of a broadcast: the payload itself when
 * it carries no conversation text, a copy without the text, or null when
 * the whole event is conversation. The rule: what GET /agents and
 * GET /sessions show without the token stays; conversation text and command
 * lines go.
 *
 *   session_prompt, session_turn_end   `text` (the prompt, the reply) and the
 *                                      `messageId` of its chat row
 *   every event with `main`            main.lastPrompt / main.lastReply
 *                                      (session_started, _ended, _registry,
 *                                      _cwd, _model, _needs_you, _error,
 *                                      _compact, _main)
 *   chat_message with msg_type prompt / reply   withheld (none is broadcast
 *                                      today; the page builds those rows
 *                                      from the two events above)
 *   permission_request                 permission.detail (the command, path
 *                                      or tool input) and .suggestions
 *   signal                             error and detail (command output;
 *                                      the command never travels), see
 *                                      readOnlySignal
 *
 * Kept: agent records and their status lines, the completion line of
 * agent_completed (it is the office's open `done:` chat line too), a
 * needs-you's tool name, one-line summary and notification message, an API
 * error line, permission_extended / _resolved, meters, health, chat lines,
 * task_board (subjects, activeForms and states, as open as an agent's task on
 * GET /agents; a task's description never travels, see server/tasks.js).
 */
function redactForReadOnly(payload) {
  switch (payload.type) {
    case 'session_prompt':
    case 'session_turn_end':
      return withoutMainText(omit(payload, ['text', 'messageId']))
    case 'chat_message':
      return TRANSCRIPT_MSG_TYPES.has(payload.msg_type) ? null : payload
    case 'permission_request':
      return payload.permission ? { ...payload, permission: redactPermission(payload.permission) } : payload
    case 'signal':
      return readOnlySignal(payload)
    default:
      return withoutMainText(payload)
  }
}

/** Connections that presented the file token (membership dies with the socket). */
const trustedClients = new WeakSet()

const httpServer = createServer(app)

const wss = new WebSocketServer({ server: httpServer, path: '/ws', handleProtocols })

wss.on('connection', (ws, req) => {
  // Host validation — loopback hosts only (see isAllowedHost): defence in
  // depth against a DNS-rebinding page that opens the WebSocket
  if (!isAllowedHost(req.headers.host)) {
    console.warn(`[ws] Rejected connection from disallowed host: ${req.headers.host}`)
    ws.close(1008, 'Forbidden host')
    return
  }
  // Origin validation — loopback origins only (see isAllowedOrigin)
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[ws] Rejected connection from disallowed origin: ${origin}`)
    ws.close(1008, 'Forbidden origin')
    return
  }

  const trusted = tokenMatches(wsTokenFrom(req))
  if (trusted) trustedClients.add(ws)
  const ip = req.socket.remoteAddress ?? 'unknown'
  console.log(`[ws] Client connected from ${ip}, ${trusted ? 'trusted' : 'read-only (no office token)'} (total: ${wss.clients.size})`)

  // First: what this connection may see, so the page can say so
  ws.send(JSON.stringify({ type: 'auth', trusted }))

  // Then the current state: the agents to draw (not MCP transients, not
  // agents in their completed grace window — a client seats every entry, and
  // nothing would ever walk those out). A read-only connection gets the same
  // office without the conversation (redactForReadOnly) and no UI token.
  const pending = permissions.pending()
  const snapshot = {
    type: 'snapshot',
    activeAgents: liveAgents(),
    sessions: Array.from(sessions.values()).map(s => sessionToJSON(s, { withText: trusted })),
    statuses: status.summary(),
    health: health.snapshot(),
    mcpServers: discoverMcpServers(),
    // Permission dialogs waiting on the office, and the token that answers
    // them — handed out here, to a trusted connection, and nowhere else (see UI_TOKEN)
    pendingPermissions: trusted ? pending : pending.map(redactPermission),
    ...(trusted ? { uiToken: UI_TOKEN } : {}),
    // The last few signals (see Signals), oldest first, as their broadcasts carried them
    signals: signalRing.slice(-SNAPSHOT_SIGNALS).map(trusted ? publicSignal : readOnlySignal),
    // Each session's task board, the most recently changed first: subjects and
    // states only, never a description, so read-only connections get it as is
    taskBoards: tasks.boards(),
    timestamp: Date.now(),
  }
  ws.send(JSON.stringify(snapshot))

  ws.on('close', () => {
    console.log(`[ws] Client disconnected (remaining: ${wss.clients.size})`)
  })

  ws.on('error', (err) => {
    console.error(`[ws] Client error:`, err.message)
  })
})

/**
 * Broadcast a JSON message to all connected WebSocket clients: trusted ones
 * get the payload as is, read-only ones what redactForReadOnly leaves of it.
 * Each variant is serialised once, the read-only one only when a read-only
 * client is connected. A null payload (processEvent had nothing to say) is
 * skipped rather than sent as "null".
 */
function broadcast(payload) {
  if (!payload) return
  const full = JSON.stringify(payload)
  let readOnly  // undefined: not built yet; null: withheld from read-only clients
  let sent = 0
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue
    let msg = full
    if (!trustedClients.has(client)) {
      if (readOnly === undefined) {
        const redacted = redactForReadOnly(payload)
        readOnly = redacted === payload ? full : redacted ? JSON.stringify(redacted) : null
      }
      msg = readOnly
    }
    if (!msg) continue
    client.send(msg)
    sent++
  }
  if (sent > 0) {
    console.log(`[broadcast] ${payload.type} -> ${sent} client(s)`)
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Bind the port, then write the auth token and print the banner.
 *
 * The token is written only once the port is ours: a second instance started
 * while the first is running (`npm run server` twice, Electron plus the CLI)
 * used to overwrite the file with its own token and then die on EADDRINUSE,
 * so every hook event to the surviving server was a 401 until it was
 * restarted. Now the loser exits without touching the file.
 * The host comes from AGENT_OFFICE_HOST here, at start, so a refused value
 * is logged next to the banner: whatever it says, 127.0.0.1 is bound
 * (readHost in server/config.js has the reasons).
 * @param {{ port?: number, host?: string }} [opts] — tests bind an ephemeral port
 */
export function start({ port = PORT, host = readHost() } = {}) {
  // A listen failure (EADDRINUSE: another instance already holds the port)
  // surfaces on the http server, but ws re-emits it on the WebSocketServer —
  // and an unhandled 'error' there throws. Handle it in one place, once,
  // whichever object delivers it, so the banner prints and we exit cleanly
  // without having written the token (writeTokenFile runs only on success).
  let fatal = false
  const onFatal = (err) => {
    if (fatal) return
    fatal = true
    if (err?.code === 'EADDRINUSE') {
      console.error(`[error] Port ${port} is already in use. Is the server already running? (its token in ${TOKEN_FILE} is left as it was)`)
    } else {
      console.error('[error]', err)
    }
    process.exit(1)
  }
  httpServer.on('error', onFatal)
  wss.on('error', onFatal)

  // The answer-permissions marker must not outlive the office (see
  // removeAnswerMarker): drop it when the process goes, however it goes.
  // Registered once, before listen, so a failed bind still cleans up.
  if (!start.cleanupRegistered) {
    start.cleanupRegistered = true
    process.once('exit', removeAnswerMarker)
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, () => { removeAnswerMarker(); process.exit(0) })
    }
  }

  httpServer.listen(port, host, () => {
    writeTokenFile()
    // Tighten the runtime dir and the chat database to 0600/0700 even when an
    // installer, a start script or an older build created them world-readable
    // first (mkdirSync's mode and SQLite's own create mode do not fix an
    // existing file). The prompts and replies in chat.db must stay private.
    repairPrivateModes()
    // The marker tracks the live office: (re)write it now, per the setting,
    // and the shutdown handlers above remove it when we stop.
    syncAnswerMarker()
    // The registry roster runs with the server (and stops with it, so a
    // test's closed server leaves no poll behind)
    registry.start()
    httpServer.once('close', () => { registry.stop(); removeAnswerMarker() })
    // So does the task board's watch on the sessions' task lists
    tasks.start()
    httpServer.once('close', () => tasks.stop())
    const bound = httpServer.address()?.port ?? port
    const mcpServers = discoverMcpServers()
    console.log(`
╔═══════════════════════════════════════════╗
║         Agent Office Server v1.0          ║
╠═══════════════════════════════════════════╣
║  HTTP  http://localhost:${bound}              ║
║  WS    ws://localhost:${bound}/ws             ║
║  POST  http://localhost:${bound}/event        ║
║  GET   http://localhost:${bound}/roster       ║
║  GET   http://localhost:${bound}/agents       ║
║  GET   http://localhost:${bound}/sessions     ║
║  POST  http://localhost:${bound}/a2a          ║
╚═══════════════════════════════════════════╝`)

    console.log(`  Auth token ${REUSED_TOKEN ? 'reused from' : 'written to'}: ${TOKEN_FILE}`)
    console.log(`  Session registry read from: ${REGISTRY_DIR}`)
    console.log(`  Task lists read from: ${TASKS_DIR}`)
    if (UI_AVAILABLE) {
      console.log(`  Office UI served from: ${UI_DIR}`)
    } else {
      console.log(`  Office UI not built (npm run build) — use the Vite dev server on port ${UI_DEV_PORT}`)
    }

    if (mcpServers.length > 0) {
      console.log(`  MCP servers discovered: ${mcpServers.join(', ')}`)
    } else {
      console.log('  No MCP servers found in ~/.claude/settings.json')
    }
    console.log()
    // The office link. Only whoever started the server sees this output;
    // the page reads the token from the fragment, which a browser never
    // sends to a server, keeps it and strips it from the address bar.
    const address = httpServer.address()
    const linkHost = address && typeof address === 'object' && address.family === 'IPv6' ? `[${address.address}]` : '127.0.0.1'
    const base = UI_AVAILABLE ? `http://${linkHost}:${bound}` : `http://localhost:${UI_DEV_PORT}`
    console.log(`  Agent Office: ${officeLink(base)}${UI_AVAILABLE ? '' : '  (the Vite dev server)'}`)
    console.log('  Open that link once per browser (or run `npm run open`); a bare address shows the office read-only.')
    console.log()
  })
}

/** The page URL with the office token in its fragment, the one way the page learns it. */
function officeLink(base) {
  return `${base.replace(/\/+$/, '')}/#token=${AUTH_TOKEN}`
}

// Only bind the port when run directly (`node server/index.js`, `npm run
// server`, the Electron child process). Importing the module — e.g. from the
// tests — builds the app without listening or writing the token file.
function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(__filename)
  } catch {
    return false
  }
}

if (isMainModule()) start()

export {
  app,
  httpServer,
  wss,
  AUTH_TOKEN,
  REUSED_TOKEN,
  UI_TOKEN,
  RUNTIME_DIR,
  TOKEN_FILE,
  TOKEN_PATTERN,
  readTokenFile,
  WS_PROTOCOL,
  WS_TOKEN_PROTOCOL_PREFIX,
  redactForReadOnly,
  officeLink,
  ANSWER_MARKER_FILE,
  PORT,
  UI_DEV_PORT,
  CONFIG_DIR,
  isAllowedOrigin,
  UI_DIR,
  UI_AVAILABLE,
  activeAgents,
  pendingStarts,
  START_BIND_MS,
  FIRST_TOOL_BIND_MS,
  sessions,
  registry,
  REGISTRY_DIR,
  tasks,
  TASKS_DIR,
  pendingNeedsYou,
  permissions,
  settings,
  activity,
  processEvent,
  sendAgentMessage,
  sweepStale,
  broadcast,
}
