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
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, chmodSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction, markInboxRead } from './chat-db.js'
import db from './chat-db.js'
import { mountStatus } from './status.js'
import { mountRegistry } from './sessions.js'
import { mountPermissions, sanitiseSuggestions } from './permissions.js'
import { mountHealth, readVersion } from './health.js'
import { readPort, readUiPort, readHost, loadOfficeConfig, bossFromConfig } from './config.js'

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
// a temp dir). The token is generated here but only written to disk by
// start(), once the port is bound, so importing this module has no side
// effects outside RUNTIME_DIR and a second instance that loses the port race
// never clobbers the running instance's token.
//
// Threat model. The server only listens on loopback (AGENT_OFFICE_HOST may
// spell it 127.0.0.1, localhost or ::1; anything else is refused by
// readHost, with the reason, and loopback is bound). Browsers are kept out
// by the origin allowlist below (every other origin gets 403 / a 1008 close)
// and by the JSON content type, which makes cross-site POSTs preflight. What
// is left is any other process on this machine, which can reach the port
// freely. So: everything that acts *as an agent* or destroys state needs the
// bearer token in ~/.agent-office/auth-token — the file only this user can
// read, which the hook, the office scripts and A2A clients send as
// `Authorization: Bearer <token>`. Reads (GET routes), a person's plain chat
// line (POST /chat), the typing indicator and the chat-monitor pause toggle
// stay open: the office UI has no token, and the worst a local process can
// do with them is read what the office already shows and post a chat line.
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
//                    POST /chat/cron-state (the UI's pause button)
//
// GET /roster and GET /agents do show each agent's task text and the names of
// the configured MCP servers; that is the office's purpose, and anything on
// this machine can already read ~/.claude/settings.json.
// ---------------------------------------------------------------------------

const AUTH_TOKEN = randomBytes(32).toString('hex')
const RUNTIME_DIR = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }) } catch {}
const TOKEN_FILE = join(RUNTIME_DIR, 'auth-token')

/**
 * Write a file only this user can read. The mode applies when the file is
 * created, so a file an older version left world-readable is fixed as well.
 */
function writePrivate(path, data) {
  writeFileSync(path, data, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
}

function writeTokenFile() {
  try {
    writePrivate(TOKEN_FILE, AUTH_TOKEN)
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

function unauthorized(res, body) {
  res.setHeader('WWW-Authenticate', 'Bearer realm="agent-office"')
  return res.status(401).json(body)
}

/** Express middleware: the route needs the office's bearer token. */
function requireToken(req, res, next) {
  if (tokenMatches(bearerToken(req))) return next()
  unauthorized(res, { error: 'Unauthorized' })
}

/** Same, answering in the JSON-RPC envelope for the A2A endpoint. */
function requireTokenRpc(req, res, next) {
  if (tokenMatches(bearerToken(req))) return next()
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
// The UI token — how the office page gets to answer a permission dialog
//
// The page has no way to read the 0600 token file, yet answering "Do you want
// to run this command?" for a Claude Code session must not be open to any
// local process the way POST /chat is. So the server mints a second secret
// per process, UI_TOKEN, and hands it out in exactly one place: the WebSocket
// snapshot. That socket is origin-gated (isAllowedOrigin above: a browser
// always sends Origin, and only the loopback UI ports pass), so a web page on
// another origin — a malicious site, a DNS-rebinding page whose Origin is its
// own hostname — can never open it and never learns the token, while a local
// process that could connect without an Origin header could just as well
// read the token file. The token lives in memory only, changes on every
// restart, is compared in constant time, and opens only the two routes the
// page needs: POST /permission/:id and POST /settings. The hook's long-poll
// that *learns* a decision stays behind the file token, the loopback bind is
// unchanged, nothing is ever auto-allowed, and when the server is down the
// hook prints nothing and the terminal dialog is in charge.
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

// Agents with no activity for this long are assumed gone (missed hand-back,
// Claude Code killed mid-task) and are walked out of the office.
const STALE_AGENT_MS = (Number(process.env.AGENT_OFFICE_STALE_MINUTES) || 120) * 60_000

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

/** Lower a hand nobody answered within NEEDS_YOU_TIMEOUT_MS. */
function armNeedsYouTimeout(session) {
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
  }, NEEDS_YOU_TIMEOUT_MS)
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
  main.needsYou = { ...wait }
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

/** A tool call on the main thread: Claude is working (unless a hand just went up, see PERMISSION_RACE_MS). */
function mainWorking(session, status, now = Date.now()) {
  const main = mainOf(session, now)
  if (main.state === 'needs-you' && main.needsYou?.kind === 'permission' && now - main.needsYou.since < PERMISSION_RACE_MS) return false
  delete main.needsYou
  delete main.error
  delete main.beforeCompact
  return setMainState(session, 'working', status ? `tool call: ${status}` : 'tool call', now)
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
 * `withText` the prompt and reply text is left out of `main` (the open
 * GET /sessions; the origin-gated WS snapshot and broadcasts carry it).
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

function createSession({ id, project, cwd, source, model, title, now = Date.now() }) {
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
    session = createSession({ id, project: body.project, cwd: body.cwd, source: 'implicit', now })
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
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
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
 * Oldest unlinked, not-completed, non-MCP agent of this Claude Code agent
 * type — from the same session when the event names one, so a SubagentStart
 * in one terminal never binds to an older spawn in another.
 */
function oldestUnlinkedAgent(agentType, sessionId) {
  return Array.from(activeAgents.values())
    .filter(a => !a.server && !a.subagentId && a.state !== 'completed' && a.agentType === agentType)
    .filter(a => sameSession(a.sessionId, sessionId))
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

/** Prompt / reply text at the configured logPrompts level: '' when off, else its first N characters. */
function transcriptText(text) {
  const max = LOG_PROMPTS_LEVELS.get(settings.logPrompts) ?? 0
  return max ? String(text ?? '').slice(0, max) : ''
}

loadSettings()
syncAnswerMarker()

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

function validateEvent(body) {
  if (!body || typeof body !== 'object') return 'Missing body'
  if (!body.type || typeof body.type !== 'string') return 'Missing event type'
  if (!KNOWN_EVENT_TYPES.has(body.type)) return `Unknown event type: ${body.type}`
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
const jsonBody = express.json({ limit: JSON_LIMIT })
const eventJsonBody = express.json({ limit: EVENT_JSON_LIMIT })
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
// by the session's later activity in processEvent.
const permissions = mountPermissions(app, { requireToken, requireUi, broadcast, onDecided: onOfficeDecision })

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
 *   { type: "mcp_done",        server, agentId? }
 *   { type: "session_started", sessionId, project, cwd, source, model?, title? }   (SessionStart)
 *   { type: "session_ended",   sessionId, reason }                                 (SessionEnd)
 *
 * The session's own Claude (its `main` record; all carry sessionId, promptId?):
 *   { type: "session_prompt",    text, isWakeup, wakeupAgentId?, wakeupStatus? }  (UserPromptSubmit)
 *   { type: "session_turn_end",  text, backgroundTasks[], crons, stopHookActive } (Stop)
 *   { type: "session_needs_you", kind, toolName?, summary?, message?, notificationType?, agentId? }
 *                                                           (PermissionRequest, Notification)
 *   { type: "session_error",     error, detail }                                   (StopFailure)
 *   { type: "session_compact",   phase: "pre" | "post", trigger }                  (Pre/PostCompact)
 *   { type: "session_tool_done", toolName? | batch: true, count }  (main-thread PostToolUse / PostToolBatch)
 *   { type: "session_cwd",       cwd, project, oldCwd? }                           (CwdChanged)
 *   { type: "session_model",     model, fromModel?, switchSource? }                (PostModelSwitch)
 * A foreground agent's agent_completed may add tokens, durationMs, toolUses, model.
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
    summary:          clampString(body.summary),
    message:          clampString(body.message),
    notificationType: clampString(body.notificationType, 40),
    // A PermissionRequest the office may answer (server/permissions.js): the
    // detail is the command or the path (400), the suggestions go back to
    // Claude Code verbatim, so their shape is kept and their sizes bounded
    answerable:       body.answerable === true || undefined,
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
  }

  const event = processEvent(sanitised)
  if (event) {
    broadcast(event)
  }
  health.markHook()  // a hook reached us: what the strip's "last seen" counts (after the event, so its counts include it)

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
      const sysMsg = addMessage({ sender: 'system', text: `🔒 ${cmd} needs the office auth token — send it as Authorization: Bearer <token> (see README › Security)`, isSystem: true })
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
      // SubagentStart: the subagent exists now. Tie it to the oldest unlinked
      // agent of the same type — the PreToolUse(Agent) that spawned it fired
      // ~50 ms earlier, so that agent is normally in the office already. When
      // the start overtook its spawn, park it until that spawn arrives.
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
      const agent = oldestUnlinkedAgent(agentType, body.sessionId)
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
      // oldest unlinked agent of the same type on its first tool call.
      if (!id && body.agentId && body.agentType) {
        const unbound = oldestUnlinkedAgent(body.agentType, body.sessionId)
        if (unbound) {
          linkSubagent(unbound.id, body.agentId)
          id = unbound.id
          console.log(`[~] Agent ${id} bound to subagent ${body.agentId} by its first tool call (no SubagentStart seen)`)
        } else {
          pendingStarts.delete(body.agentId)
          const spawned = processEvent({
            type: 'agent_spawned',
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
        // An agent spawned before the hook knew its session learns it here
        if (session && !agent.sessionId) attachAgentToSession(agent, session)
        saveAgents()
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
        // PreToolUse / PostToolUseFailure on the main thread: a dialog that
        // was up has been answered — unless this is the PreToolUse of the very
        // call that raised it, which can arrive after it (PERMISSION_RACE_MS)
        releasePermissions(session.id, `tool call: ${logText(body.status)}`, p => now - p.createdAt >= PERMISSION_RACE_MS)
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
      touchSession(body)
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
        Object.assign(agent, stats)
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
        session = createSession({ id, project: body.project, cwd: body.cwd, source, model: body.model, title: body.title, now })
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
      const sameWait = w => w && w.kind === body.kind
        && (w.promptId ?? null) === (body.promptId ?? null)
        && (!body.toolName || w.toolName === body.toolName)
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
      console.log(`[main] ${sessionName(session)}: needs-you requested (${needsYouLabel(wait)})`)
      const timer = setTimeout(() => applyNeedsYou(session.id), NEEDS_YOU_DEBOUNCE_MS)
      timer.unref?.()
      pendingNeedsYou.set(session.id, { wait, agentId: body.agentId, timer })
      return null
    }

    case 'session_tool_done': {
      // A main-thread tool call ran (PostToolUse) or a whole batch of them
      // was answered (PostToolBatch): a permission hand raised for that tool
      // — or any hand, for a batch — comes down, since the call went ahead
      const session = touchSession(body)
      if (!session) return null
      const answers = w => w && w.kind === 'permission' && (body.batch === true || (body.toolName && w.toolName === body.toolName))
      const what = body.batch === true ? `tool batch of ${body.count ?? '?'} done` : `${body.toolName ?? 'tool'} ran`
      // A pending permission of the session was answered in the terminal: the
      // batch end settles everything; a single PostToolUse settles the tool it
      // names, or any record older than the parallel-batch race window (a Read
      // that ran beside the Write still waiting on its dialog)
      releasePermissions(session.id, what, p => body.batch === true || p.toolName === body.toolName || Date.now() - p.createdAt >= PERMISSION_RACE_MS)
      const pending = pendingNeedsYou.get(session.id)
      if (pending && answers(pending.wait)) {
        cancelPendingNeedsYou(session.id)
        console.log(`[main] ${sessionName(session)}: needs-you withdrawn before it was shown (${needsYouLabel(pending.wait)}; ${what} ${Date.now() - pending.wait.since} ms later)`)
      }
      const main = mainOf(session)
      if (main.state !== 'needs-you' || !answers(main.needsYou)) return null
      delete main.needsYou
      setMainState(session, 'working', what)
      saveAgents()
      return mainEvent(session, 'permission answered')
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

const httpServer = createServer(app)

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  // Origin validation — loopback origins only (see isAllowedOrigin)
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[ws] Rejected connection from disallowed origin: ${origin}`)
    ws.close(1008, 'Forbidden origin')
    return
  }

  const ip = req.socket.remoteAddress ?? 'unknown'
  console.log(`[ws] Client connected from ${ip} (total: ${wss.clients.size})`)

  // Send current state snapshot immediately on connect: the agents to draw
  // (not MCP transients, not agents in their completed grace window — a
  // client seats every entry, and nothing would ever walk those out)
  const snapshot = {
    type: 'snapshot',
    activeAgents: liveAgents(),
    sessions: Array.from(sessions.values()).map(sessionToJSON),
    statuses: status.summary(),
    health: health.snapshot(),
    mcpServers: discoverMcpServers(),
    // Permission dialogs waiting on the office, and the token that answers
    // them — handed out here and nowhere else (see UI_TOKEN)
    pendingPermissions: permissions.pending(),
    uiToken: UI_TOKEN,
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
 * Broadcast a JSON message to all connected WebSocket clients. A null payload
 * (processEvent had nothing to say) is skipped rather than sent as "null".
 */
function broadcast(payload) {
  if (!payload) return
  const msg = JSON.stringify(payload)
  let sent = 0
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg)
      sent++
    }
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
 * is logged next to the banner: loopback forms bind as given, anything else
 * binds 127.0.0.1 (readHost in server/config.js has the reason).
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

  httpServer.listen(port, host, () => {
    writeTokenFile()
    // The registry roster runs with the server (and stops with it, so a
    // test's closed server leaves no poll behind)
    registry.start()
    httpServer.once('close', () => registry.stop())
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

    console.log(`  Auth token written to: ${TOKEN_FILE}`)
    console.log(`  Session registry read from: ${REGISTRY_DIR}`)
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
  })
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
  UI_TOKEN,
  RUNTIME_DIR,
  TOKEN_FILE,
  ANSWER_MARKER_FILE,
  PORT,
  UI_DEV_PORT,
  CONFIG_DIR,
  isAllowedOrigin,
  UI_DIR,
  UI_AVAILABLE,
  activeAgents,
  pendingStarts,
  sessions,
  registry,
  REGISTRY_DIR,
  pendingNeedsYou,
  permissions,
  settings,
  processEvent,
  sendAgentMessage,
  sweepStale,
  broadcast,
}
