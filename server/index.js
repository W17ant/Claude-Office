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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { addMessage, getMessages, markSeen, addReaction } from './chat-db.js'
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
// Auth token — generated on startup, written to /tmp/agent-office-token
// ---------------------------------------------------------------------------

const AUTH_TOKEN = randomBytes(32).toString('hex')
const RUNTIME_DIR = join(homedir(), '.agent-office')
try { mkdirSync(RUNTIME_DIR, { recursive: true }) } catch {}
const TOKEN_FILE = join(RUNTIME_DIR, 'auth-token')

try {
  writeFileSync(TOKEN_FILE, AUTH_TOKEN, { mode: 0o600 })
} catch (err) {
  console.warn('[auth] Could not write token file:', err.message)
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

const AGENTS_FILE = join(homedir(), '.agent-office', 'agents.json')

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
 *   { type: "agent_working",   agentId?, status, agentType?, role?, name? }
 *   { type: "agent_completed", agentId, result }
 *   { type: "agent_linked",    agentId, subagentId }
 *
 * agentId on working/completed may be either the office id or a Claude Code
 * subagent id (from the hook payload's agent_id).
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
    } : undefined,
    agentId: clampString(body.agentId),
    subagentId: clampString(body.subagentId),
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
    const webhookPath = join(homedir(), '.agent-office', 'last-chat')
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

/**
 * GET /agents — directory of who is in the office right now, so agents can
 * discover each other before sending a directed message.
 */
app.get('/agents', (_req, res) => {
  const agents = Array.from(activeAgents.values())
    .filter(a => !a.server && a.state !== 'completed')
    .map(({ id, name, role, task, state, status, background, spawnedAt, lastActivityAt }) =>
      ({ id, name, role, task, state, status, background, spawnedAt, lastActivityAt }))
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
  const { sender, role, text, recipient, type, replyTo, senderId } = req.body ?? {}
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Missing text' })
  }

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
      return res.status(400).json({ error: 'An agent cannot message itself' })
    }
    if (!a2aBudgetLeft(from, to)) {
      return res.status(429).json({ error: `Loop budget hit: ${from} and ${to} have exchanged ${A2A_PAIR_LIMIT} messages in the last minute` })
    }
  }

  const threadId = Number.isInteger(replyTo) ? replyTo : null
  const msg = addMessage({
    sender: from,
    role: clampString(role || 'default'),
    text: clampString(body, 2000),
    threadId,
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
    console.log(`[a2a] ${msg.sender} -> ${to} (${msgType}): ${msg.text}`)
  } else {
    console.log(`[reply] ${msg.sender}: ${msg.text}`)
  }
  res.json({ ok: true, id: msg.id, recipient: to, delivered: !!recipientAgent })
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

const cronStatePath = join(homedir(), '.agent-office', 'chat-poll-state')

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
      if (activeAgents.has(id)) {
        // Replayed spawn (e.g. hook retry) — keep the existing record
        return { type: 'agent_spawned', agent: activeAgents.get(id), timestamp: Date.now() }
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
      activeAgents.set(id, record)
      saveAgents()
      console.log(`[+] Agent spawned: ${record.name} (${record.role}) — ${id}`)

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
        activeAgents.get(id).lastActivityAt = Date.now()
        saveAgents()
        console.log(`[~] Agent ${id} linked to subagent ${body.subagentId}`)
      }
      return null
    }

    case 'agent_working': {
      let id = lookupAgentId(body.agentId)

      // A subagent id we haven't seen: it belongs to a foreground agent whose
      // id we only learn now, or to an agent spawned while the server was down.
      if (!id && body.agentId && body.agentType) {
        const unbound = Array.from(activeAgents.values())
          .filter(a => !a.server && !a.subagentId && a.state !== 'completed' && a.agentType === body.agentType)
          .sort((a, b) => a.spawnedAt - b.spawnedAt)[0]
        if (unbound) {
          linkSubagent(unbound.id, body.agentId)
          id = unbound.id
        } else {
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
        saveAgents()
      }
      // Unknown or missing id is main-thread activity — frontend picks a worker
      return { type: 'agent_working', agentId: id ?? undefined, status: body.status, timestamp: Date.now() }
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
