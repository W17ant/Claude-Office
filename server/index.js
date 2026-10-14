/**
 * Agent Office - WebSocket + HTTP Event Server
 *
 * Runs on port 3334.
 * - React frontend connects via ws://localhost:3334/ws
 * - Claude Code hook script POSTs to http://localhost:3334/event
 * - GET /roster returns discovered MCP servers
 * - GET /agents lists agents in the office; POST /chat/reply with a recipient
 *   sends a directed agent-to-agent message
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction, markInboxRead } from './chat-db.js'
import db from './chat-db.js'

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
// start(), so importing this module has no side effects outside RUNTIME_DIR.
// ---------------------------------------------------------------------------

const AUTH_TOKEN = randomBytes(32).toString('hex')
const RUNTIME_DIR = process.env.AGENT_OFFICE_HOME || join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const TOKEN_FILE = join(RUNTIME_DIR, 'auth-token')

function writeTokenFile() {
  try {
    writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 })
  } catch (err) {
    console.warn('[auth] Could not write token file:', err.message)
  }
}

// ---------------------------------------------------------------------------
// Allowed origins
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  'http://localhost:3333',
  'http://localhost:3334',
])

function isAllowedOrigin(origin) {
  if (!origin) return true  // null origin (Electron, file://, curl)
  return ALLOWED_ORIGINS.has(origin)
}

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
 * is parked here (subagentId -> { agentType, parentId, at }) and consumed by
 * the next spawn of that agentType, or dropped after PENDING_START_MS.
 * @type {Map<string, {agentType: string, parentId?: string, at: number}>}
 */
const pendingStarts = new Map()
const PENDING_START_MS = 15_000

// Agents with no activity for this long are assumed gone (missed hand-back,
// Claude Code killed mid-task) and are walked out of the office.
const STALE_AGENT_MS = (Number(process.env.AGENT_OFFICE_STALE_MINUTES) || 120) * 60_000

/**
 * Generate a stable agent ID from the event payload.
 * Uses the provided id, or derives one from name+role.
 */
function resolveAgentId(agent) {
  if (agent.id) return agent.id
  const slug = `${agent.name ?? 'agent'}-${agent.role ?? 'worker'}`
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
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
  agent.subagentId = subagentId
  subagentAliases.set(subagentId, officeId)
}

/** Oldest unlinked, not-completed, non-MCP agent of this Claude Code agent type. */
function oldestUnlinkedAgent(agentType) {
  return Array.from(activeAgents.values())
    .filter(a => !a.server && !a.subagentId && a.state !== 'completed' && a.agentType === agentType)
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
    if (pending.agentType === agent.agentType && (!oldest || pending.at < oldest.at)) oldest = { subagentId, ...pending }
  }
  if (!oldest) return false
  pendingStarts.delete(oldest.subagentId)
  linkSubagent(agent.id, oldest.subagentId)
  setLineage(agent, oldest.parentId)
  console.log(`[~] Agent ${agent.id} linked to parked subagent ${oldest.subagentId} (${agent.agentType}) by SubagentStart`)
  return true
}

function forgetAgent(id) {
  const agent = activeAgents.get(id)
  if (agent?.subagentId && subagentAliases.get(agent.subagentId) === id) {
    subagentAliases.delete(agent.subagentId)
  }
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
// Agent persistence — survive a server restart while agents are still working
// ---------------------------------------------------------------------------

const AGENTS_FILE = join(RUNTIME_DIR, 'agents.json')

function saveAgents() {
  try {
    // MCP entries are transient (one per call), only persist real agents
    const agents = Array.from(activeAgents.values()).filter(a => !a.server && a.state !== 'completed')
    writeFileSync(AGENTS_FILE, JSON.stringify({ agents }), { mode: 0o600 })
  } catch (err) {
    console.warn('[agents] Could not save agent state:', err.message)
  }
}

function loadAgents() {
  if (!existsSync(AGENTS_FILE)) return
  try {
    const { agents = [] } = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
    const cutoff = Date.now() - STALE_AGENT_MS
    for (const agent of agents) {
      if (!agent?.id || agent.state === 'completed') continue
      if ((agent.lastActivityAt ?? agent.spawnedAt ?? 0) < cutoff) continue
      activeAgents.set(agent.id, agent)
      if (agent.subagentId) subagentAliases.set(agent.subagentId, agent.id)
    }
    if (activeAgents.size > 0) console.log(`[agents] Restored ${activeAgents.size} agent(s) from ${AGENTS_FILE}`)
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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', agents: activeAgents.size, clients: wss?.clients.size ?? 0 })
})

// MCP server roster
app.get('/roster', (_req, res) => {
  const mcpServers = discoverMcpServers()
  res.json({
    mcpServers,
    activeAgents: Array.from(activeAgents.values()),
  })
})

/**
 * POST /event — receives hook events from agent-tracker.sh
 *
 * Requires Authorization: Bearer <token> header (token is in /tmp/agent-office-token).
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
 */
app.post('/event', (req, res) => {
  // Auth check
  const authHeader = req.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

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
  }

  const event = processEvent(sanitised)
  if (event) {
    broadcast(event)
  }

  res.json({ ok: true })
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
    case '/help':
      return '📋 Commands: /status — office stats, /agents — list agents, /clear — wipe chat history, /help — this message'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Chat — user messages from the office UI
// ---------------------------------------------------------------------------

/**
 * POST /chat — receives a message typed in the office Slack panel
 * No auth required (comes from the UI, not hooks)
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
    const webhookPath = join(RUNTIME_DIR, 'last-chat')
    writeFileSync(webhookPath, JSON.stringify(msg), 'utf8')
  } catch {}

  console.log(`[chat] ${msg.sender}: ${msg.text}`)
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Video mode — when enabled, GET /chat filters out scripted video messages
// so external Claude sessions only see real agent messages.
// Toggle via POST /chat/video-mode  { enabled: true/false }
// ---------------------------------------------------------------------------
let videoPaused = false
let videoPausedSince = 0

app.post('/chat/video-mode', (req, res) => {
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
      mkdirSync(inboxDir, { recursive: true })
      writeFileSync(join(inboxDir, `${inboxSlug(to)}.json`), JSON.stringify(msg), 'utf8')
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
    .map(({ id, name, role, task, state, status, lastError, background, spawnedAt, lastActivityAt, unread, parentId, parentSubagentId }) => ({
      id, name, role, task, state, status, lastError, background, spawnedAt, lastActivityAt, unread: unread ?? 0,
      // Lineage: the subagent that spawned this one and, once that parent is linked, its office id
      parentId: parentId ?? lookupAgentId(parentSubagentId) ?? undefined,
      parentSubagentId,
    }))
  res.json({ agents })
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
 */
app.post('/chat/reply', (req, res) => {
  const result = sendAgentMessage(req.body ?? {})
  if (result.error) return res.status(result.status).json({ error: result.error })
  res.json({ ok: true, id: result.msg.id, recipient: result.to, delivered: !!result.recipientAgent })
})

/**
 * POST /chat/inbox/read — the recipient has read its directed messages.
 * Body: { recipient: "Debugger" }  (office id, subagent id, name or role)
 * Clears the unread badge on the agent's desk.
 */
app.post('/chat/inbox/read', (req, res) => {
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
// ---------------------------------------------------------------------------

const A2A_PROTOCOL_VERSION = '0.3.0'
const A2A_URL = `http://localhost:${PORT}/a2a`

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

app.post('/a2a', (req, res) => {
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
 * POST /chat/seen — mark a message as seen
 * Body: { messageId: number }
 */
app.post('/chat/seen', (req, res) => {
  const { messageId } = req.body ?? {}
  if (!messageId) {
    return res.status(400).json({ error: 'Missing messageId' })
  }
  markSeen(messageId)
  broadcast({ type: 'chat_seen', messageId })
  res.json({ ok: true })
})

/**
 * POST /chat/react — add or toggle an emoji reaction on a message
 * Body: { messageId: number, emoji: string }
 */
app.post('/chat/react', (req, res) => {
  const { messageId, emoji } = req.body ?? {}
  if (!messageId || !emoji) {
    return res.status(400).json({ error: 'Missing messageId or emoji' })
  }
  const reactions = addReaction(messageId, clampString(emoji, 10))
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

app.post('/chat/cron-state', (req, res) => {
  try {
    let state = {}
    try { state = JSON.parse(readFileSync(cronStatePath, 'utf8')) } catch {}
    state.paused = !!req.body?.paused
    writeFileSync(cronStatePath, JSON.stringify(state), 'utf8')
    console.log(`[cron] Chat monitor ${state.paused ? 'PAUSED' : 'RESUMED'}`)
    res.json({ ok: true, paused: state.paused })
  } catch (err) {
    res.status(500).json({ error: err.message })
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
      if (activeAgents.has(id)) {
        // Replayed spawn (e.g. hook retry) — keep the existing record
        const existing = activeAgents.get(id)
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
      activeAgents.set(id, record)
      console.log(`[+] Agent spawned: ${record.name} (${record.role}) — ${id}${record.parentId ? ` (parent ${record.parentId})` : ''}`)
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
      const agent = oldestUnlinkedAgent(agentType)
      if (agent) {
        linkSubagent(agent.id, subagentId)
        setLineage(agent, body.parentId)
        agent.lastActivityAt = Date.now()
        saveAgents()
        console.log(`[~] Agent ${agent.id} linked to subagent ${subagentId} (${agentType}) by SubagentStart`)
      } else {
        pendingStarts.set(subagentId, { agentType, parentId: body.parentId, at: Date.now() })
        console.log(`[~] SubagentStart ${subagentId} (${agentType}) arrived before its spawn — parked`)
      }
      return null
    }

    case 'agent_working': {
      let id = lookupAgentId(body.agentId)

      // A subagent id we haven't seen: no SubagentStart reached us (hook not
      // registered, server was down), so fall back to binding it to the
      // oldest unlinked agent of the same type on its first tool call.
      if (!id && body.agentId && body.agentType) {
        const unbound = oldestUnlinkedAgent(body.agentType)
        if (unbound) {
          linkSubagent(unbound.id, body.agentId)
          id = unbound.id
          console.log(`[~] Agent ${id} bound to subagent ${body.agentId} by its first tool call (no SubagentStart seen)`)
        } else {
          pendingStarts.delete(body.agentId)
          const spawned = processEvent({
            type: 'agent_spawned',
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
        agent.state = 'working'
        agent.status = body.status ?? ''
        agent.lastActivityAt = Date.now()
        if (body.failed) {
          // A tool call errored (PostToolUseFailure); the agent carries on working
          agent.lastError = agent.status
          console.log(`[!] Agent ${id} ${agent.status}`)
        }
        saveAgents()
      }
      // Unknown or missing id is main-thread activity — frontend picks a worker
      return {
        type: 'agent_working',
        agentId: id ?? undefined,
        status: body.status,
        ...(body.failed ? { failed: true } : {}),
        timestamp: Date.now(),
      }
    }

    case 'agent_completed': {
      const id = lookupAgentId(body.agentId)
      if (id && activeAgents.get(id).state !== 'completed') {
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
      return { type: 'agent_completed', agentId: id ?? body.agentId, result: body.result, timestamp: Date.now() }
    }

    case 'mcp_call': {
      const record = {
        id:     `mcp-${body.server}-${Date.now()}`,
        name:   body.server ?? 'mcp',
        role:   body.server ?? 'default',
        server: body.server,
        tool:   body.tool,
        state:  'working',
        spawnedAt: Date.now(),
      }
      // Track MCP agents transiently
      activeAgents.set(record.id, record)
      console.log(`[mcp] ${body.server} / ${body.tool}`)
      return { type: 'mcp_call', server: body.server, tool: body.tool, agentId: record.id, timestamp: Date.now() }
    }

    case 'mcp_done': {
      // Clean up any mcp agent entries for this server
      for (const [id, agent] of activeAgents.entries()) {
        if (agent.server === body.server && agent.state === 'working') {
          activeAgents.delete(id)
        }
      }
      return { type: 'mcp_done', server: body.server, timestamp: Date.now() }
    }

    default:
      console.warn(`[?] Unknown event type: ${body.type}`)
      return null
  }
}

// Walk out agents that went silent (lost hand-back, killed session, ...)
setInterval(() => {
  const cutoff = Date.now() - STALE_AGENT_MS
  for (const agent of Array.from(activeAgents.values())) {
    if (agent.server || agent.state === 'completed') continue
    if ((agent.lastActivityAt ?? agent.spawnedAt) < cutoff) {
      broadcast(processEvent({ type: 'agent_completed', agentId: agent.id, result: 'went quiet, clocking out' }))
    }
  }
}, 5 * 60_000).unref()

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const httpServer = createServer(app)

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', (ws, req) => {
  // Origin validation — allow localhost origins and null (Electron/file://)
  const origin = req.headers.origin
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[ws] Rejected connection from disallowed origin: ${origin}`)
    ws.close(1008, 'Forbidden origin')
    return
  }

  const ip = req.socket.remoteAddress ?? 'unknown'
  console.log(`[ws] Client connected from ${ip} (total: ${wss.clients.size})`)

  // Send current state snapshot immediately on connect
  const snapshot = {
    type: 'snapshot',
    activeAgents: Array.from(activeAgents.values()),
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
 * Broadcast a JSON message to all connected WebSocket clients.
 */
function broadcast(payload) {
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

/** Write the auth token, bind the port and print the banner. */
export function start() {
  writeTokenFile()

  httpServer.listen(PORT, '127.0.0.1', () => {
    const mcpServers = discoverMcpServers()
    console.log(`
╔═══════════════════════════════════════════╗
║         Agent Office Server v1.0          ║
╠═══════════════════════════════════════════╣
║  HTTP  http://localhost:${PORT}              ║
║  WS    ws://localhost:${PORT}/ws             ║
║  POST  http://localhost:${PORT}/event        ║
║  GET   http://localhost:${PORT}/roster       ║
║  GET   http://localhost:${PORT}/agents       ║
║  POST  http://localhost:${PORT}/a2a          ║
╚═══════════════════════════════════════════╝`)

    console.log(`  Auth token written to: ${TOKEN_FILE}`)

    if (mcpServers.length > 0) {
      console.log(`  MCP servers discovered: ${mcpServers.join(', ')}`)
    } else {
      console.log('  No MCP servers found in ~/.claude/settings.json')
    }
    console.log()
  })

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[error] Port ${PORT} is already in use. Is the server already running?`)
    } else {
      console.error('[error]', err)
    }
    process.exit(1)
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
  activeAgents,
  pendingStarts,
  processEvent,
  sendAgentMessage,
  broadcast,
}
