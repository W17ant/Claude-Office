/**
 * Agent Office - WebSocket + HTTP Event Server
 *
 * Runs on port 3334.
 * - React frontend connects via ws://localhost:3334/ws
 * - Claude Code hook script POSTs to http://localhost:3334/event
 * - GET /roster returns discovered MCP servers
 * - GET /agents lists agents in the office; POST /chat/reply with a recipient
 *   sends a directed agent-to-agent message
 * - GET /sessions lists the Claude Code sessions (terminals) the agents belong to
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'
import { randomBytes, timingSafeEqual } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction, markInboxRead } from './chat-db.js'
import db from './chat-db.js'
import { mountStatus } from './status.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const NOTIFY_SCRIPT = join(__dirname, '..', 'scripts', 'notify.sh')

function sendNotification(title, msg) {
  try {
    const child = execFile('bash', [NOTIFY_SCRIPT, title, msg], { timeout: 3000 })
    child.unref()
  } catch {}
}

const PORT = 3334

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
// Threat model. The server only listens on 127.0.0.1. Browsers are kept out
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
//                    and POST /chat for a destructive slash command (/clear)
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
// The office UI is served from this server (port 3334: `npm run build`, the
// packaged desktop app) or from the Vite dev server (port 3333), and browsers
// reach either as localhost, 127.0.0.1 or ::1 — the Origin header spells it
// whichever way the page was opened, so match the loopback host rather than
// a fixed string. Anything else (other ports, `null`, `file://`) is refused.
// ---------------------------------------------------------------------------

const UI_DEV_PORT = 3333
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const ALLOWED_ORIGIN_PORTS = new Set([String(UI_DEV_PORT), String(PORT)])

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
// Built UI
//
// `vite build` writes the React app, plus everything in public/, to dist/.
// When that directory exists the server serves it from its root, so
// http://127.0.0.1:3334/ is the whole office on one port: the packaged
// Electron app loads this URL, and `npm run build && npm run server` works in
// a plain browser. `npm run dev` keeps using Vite on 3333 instead. Tests point
// AGENT_OFFICE_UI_DIR at a temp dir.
// ---------------------------------------------------------------------------

const UI_DIR = process.env.AGENT_OFFICE_UI_DIR || join(__dirname, '..', 'dist')
const UI_AVAILABLE = existsSync(join(UI_DIR, 'index.html'))

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
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} sessionId -> session record */
const sessions = new Map()

/** @type {Map<string, ReturnType<typeof setTimeout>>} sessionId -> timer that forgets an ended session */
const sessionTimers = new Map()

// An ended session stays listed (state 'ended') this long so UIs can show it leaving
const SESSION_FORGET_MS = 60_000

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

/** Session record -> API/WS shape: the record plus live agent counts. */
function sessionToJSON(session) {
  const live = Array.from(activeAgents.values())
    .filter(a => a.sessionId === session.id && !a.server && a.state !== 'completed')
  return {
    ...sessionToRecord(session),
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
    project: projectName(project, cwd),
    cwd,
    source: source || 'implicit',
    state: 'active',
    startedAt: now,
    lastActivityAt: now,
    agentIds: new Set(),
  }
  if (model) session.model = model
  if (title) session.title = title
  sessions.set(id, session)
  console.log(`[session] ${session.source}: ${session.project ?? id} (${id})`)
  return session
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
    // ended sessions are on their way out and are not kept either
    const agents = liveAgents()
    const saved = Array.from(sessions.values()).filter(s => s.state === 'active').map(sessionToRecord)
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
      if (!session?.id || session.state === 'ended') continue
      if ((session.lastActivityAt ?? session.startedAt ?? 0) < cutoff) continue
      const agentIds = (Array.isArray(session.agentIds) ? session.agentIds : []).filter(id => activeAgents.has(id))
      sessions.set(session.id, { ...session, state: 'active', agentIds: new Set(agentIds) })
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
])

const MAX_STRING_LEN = 200

function clampString(val, max = MAX_STRING_LEN) {
  if (typeof val !== 'string') return undefined
  return val.slice(0, max)
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
app.use(express.json({ limit: '10kb' }))

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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: activeAgents.size, clients: wss?.clients.size ?? 0 })
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
  }

  const event = processEvent(sanitised)
  if (event) {
    broadcast(event)
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
  let messages = getMessages({ since, limit: 50, recipient })
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
 * about: project, cwd, how it started, its agent counts and the last
 * main-thread status. Ended sessions stay listed for SESSION_FORGET_MS.
 */
app.get('/sessions', (_req, res) => {
  res.json({ sessions: Array.from(sessions.values()).map(sessionToJSON) })
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
      // session (the last thing Claude itself did) and the broadcast names the
      // session, so the frontend can show it there instead of on a random worker.
      if (session) {
        session.lastStatus = body.status ?? ''
        session.lastStatusAt = Date.now()
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
      if (id) {
        const agent = activeAgents.get(id)
        agent.state = 'completed'
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
      console.log(`[-] Agent completed: ${id ?? body.agentId}`)
      const sessionId = id ? activeAgents.get(id).sessionId : undefined
      return {
        type: 'agent_completed',
        agentId: id ?? body.agentId,
        result: body.result,
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
          console.log(`[session] back (${source}): ${session.project ?? id} (${id})`)
        }
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
    mcpServers: discoverMcpServers(),
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
 * @param {{ port?: number, host?: string }} [opts] — tests bind an ephemeral port
 */
export function start({ port = PORT, host = '127.0.0.1' } = {}) {
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
    if (UI_AVAILABLE) {
      console.log(`  Office UI served from: ${UI_DIR}`)
    } else {
      console.log('  Office UI not built (npm run build) — use the Vite dev server on port 3333')
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
  RUNTIME_DIR,
  TOKEN_FILE,
  PORT,
  UI_DIR,
  UI_AVAILABLE,
  activeAgents,
  pendingStarts,
  sessions,
  processEvent,
  sendAgentMessage,
  sweepStale,
  broadcast,
}
