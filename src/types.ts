import type { RoomId } from './rooms'
import type { SessionStatus, AgentStatus, MeterTotals } from './meters'

export type AgentState =
  | 'idle'
  | 'walking-to-manager'
  | 'talking-to-manager'
  | 'walking-to-desk'
  | 'working'
  | 'coffee-break'
  | 'completed'
  | 'new-hire'
  | 'changing-room'
  | 'waiting'               // in the lobby by the door until a desk frees up

export interface Position {
  x: number
  y: number
}

export interface Agent {
  id: string
  name: string
  type: 'subagent' | 'mcp'
  role: string
  state: AgentState
  position: Position
  targetPosition: Position
  deskPosition: Position
  room: RoomId              // which room the agent is currently in
  assignedRoom: RoomId      // where their desk is
  assignedSpotId?: string   // which spot they're assigned to
  task?: string
  statusText?: string
  spriteFacing?: 'front-left' | 'front-right' | 'rear-left' | 'rear-right'
  color: string
  emoji: string
  hiredAt: number
  pathQueue?: { x: number; y: number }[]  // waypoints to walk through
  unread?: number           // directed agent-to-agent messages not yet read
  sessionId?: string        // the Claude Code session (terminal) this agent works for
  project?: string          // that session's project (basename of its cwd)
  lastFailed?: boolean      // the last agent_working for this agent was a tool failure
  // The per-session Claude (id `main-<sessionId>`) only: what its main thread is doing
  mainState?: MainState     // undefined = not heard from yet
  needsYou?: NeedsYou       // set while mainState is 'needs-you'
  waitingOn?: number        // background workers a finished turn still waits for
  model?: string            // the session's model (session_model / session_started)
}

/** What a session's main thread (its Claude) is doing — the server's `main.state` */
export type MainState = 'working' | 'waiting' | 'idle' | 'needs-you' | 'error' | 'compacting'

export type NeedsYouKind = 'permission' | 'idle' | 'quota' | 'agent-input'

/** Why a session is waiting on a person (session_needs_you / main.needsYou) */
export interface NeedsYou {
  kind: NeedsYouKind
  toolName?: string
  summary?: string
  message?: string
  notificationType?: string
  promptId?: string
  since?: number
}

/**
 * The server's per-session main-thread record. Travels as `main` on the WS
 * snapshot's sessions, GET /sessions and every session_* broadcast. Text
 * fields are '' when the server's `logPrompts` setting is off.
 */
export interface SessionMain {
  state: MainState
  since?: number
  lastPrompt?: string
  lastPromptAt?: number
  lastReply?: string
  lastReplyAt?: number
  waitingOn?: number
  crons?: number
  needsYou?: NeedsYou
  error?: { error: string; detail?: string; since?: number }
  promptId?: string
}

/** One entry of session_turn_end.backgroundTasks (a Stop hook's background_tasks item) */
export interface BackgroundTask {
  id: string
  type: string
  status: string
  description?: string
  /** The office worker this task is, when the server knows it */
  officeId?: string
}

/**
 * A Claude Code session the office knows about — one per terminal. Mirrors
 * the server's GET /sessions entries and session_started/session_ended events.
 */
export interface SessionInfo {
  id: string
  project?: string
  cwd?: string
  title?: string
  model?: string
  source?: string           // startup | resume | compact | clear | fork | implicit
  state: 'active' | 'ended'
  reason?: string           // why it ended
  startedAt?: number
  lastActivityAt?: number
  /** Last main-thread tool status (agent_working with no agentId) and when */
  lastStatus?: string
  lastStatusAt?: number
  /** The server's main-thread record, once it sends one */
  main?: SessionMain
}

/**
 * One entry of the server's `snapshot` message (its activeAgents record).
 * MCP calls are tracked as transient records with a `server` field; they are
 * not office workers.
 */
export interface SnapshotAgent {
  id: string
  name?: string
  role?: string
  task?: string
  state?: string
  status?: string
  unread?: number
  sessionId?: string
  project?: string
  server?: string
}

/**
 * The server's pipeline health: GET /health, the snapshot's `health` and the
 * `health` broadcast (server/health.js). What the status strip shows.
 */
export interface ServerHealth {
  status: string
  agents: number
  clients: number
  sessions: number
  /** When a Claude Code hook last reached POST /event (ms epoch), null if never since boot */
  lastHookAt: number | null
  /** Hook events accepted since the server started */
  hooksSeen: number
  /** The built UI (dist/) is served from the server's root */
  uiAvailable: boolean
  version: string
  uptimeMs: number
}

export interface OfficeEvent {
  type: 'agent_spawned' | 'agent_working' | 'agent_completed' | 'mcp_call' | 'mcp_done' | 'new_hire' | 'chat_message' | 'chat_typing' | 'chat_reaction' | 'chat_seen' | 'inbox_update' | 'variant_change' | 'session_started' | 'session_ended' | 'session_status' | 'agent_status' | 'snapshot'
    // The turn events (UserPromptSubmit, Stop, PermissionRequest/Notification, StopFailure, Pre/PostCompact, CwdChanged, PostModelSwitch),
    // session_main (a server-side change: a hand lowered by a tool result or the timeout) and
    // session_tool_done (main-thread PostToolUse / PostToolBatch, the input that lowers a hand)
    | 'session_prompt' | 'session_turn_end' | 'session_needs_you' | 'session_error' | 'session_compact' | 'session_cwd' | 'session_model'
    | 'session_main' | 'session_tool_done'
    // Pipeline health (the status strip): the server's record, and the socket's own open/close
    | 'health' | 'connection'
  agent?: Partial<Agent>
  agentId?: string
  status?: string
  result?: string
  // agent_completed: what the Agent tool reported for a foreground subagent
  tokens?: number
  durationMs?: number
  toolUses?: number
  // snapshot: every agent the server knows about (sent on each (re)connect), and the sessions
  activeAgents?: SnapshotAgent[]
  sessions?: SessionInfo[]
  // Every session_* broadcast carries the session's main-thread record
  main?: SessionMain
  promptId?: string
  // session_prompt / session_turn_end (their `text` ≤ 2000 is the shared field below, '' when logPrompts is off)
  isWakeup?: boolean
  wakeupAgentId?: string      // the subagent id in the wake-up prompt
  wakeupOfficeId?: string     // that worker's office id, when the server knows it
  wakeupStatus?: string
  backgroundTasks?: BackgroundTask[]
  crons?: number | unknown[]
  stopHookActive?: boolean
  // session_needs_you
  kind?: NeedsYouKind
  toolName?: string
  summary?: string
  message?: string
  notificationType?: string
  needsYou?: NeedsYou
  // session_tool_done
  batch?: boolean
  count?: number
  // session_error
  error?: string
  detail?: string
  // session_compact
  phase?: 'pre' | 'post'
  trigger?: string
  // session_cwd / session_model
  oldCwd?: string
  fromModel?: string
  switchSource?: string
  // chat_message: the server's row id (chat_reaction / chat_seen refer to it)
  id?: number
  isSystem?: boolean
  role?: string
  // chat_reaction / chat_seen
  messageId?: number
  reactions?: string[]
  // mcp_call
  server?: string
  tool?: string
  // The Claude Code session the event came from (every hook event carries it)
  sessionId?: string
  project?: string
  // session_started / session_ended
  cwd?: string
  source?: string
  model?: string
  title?: string
  state?: 'active' | 'ended'
  startedAt?: number
  lastActivityAt?: number
  lastStatus?: string
  lastStatusAt?: number
  timestamp?: number
  // session_status / agent_status: the payroll / electricity / memory feed (src/meters.ts)
  session?: SessionStatus
  statuses?: SessionStatus[]
  totals?: MeterTotals
  removed?: boolean
  agents?: AgentStatus[]
  sender?: string
  text?: string
  // Directed agent-to-agent chat messages
  recipient?: string | null
  recipientId?: string | null
  senderId?: string | null
  msg_type?: string | null
  // inbox_update
  unread?: number
  // agent_working: the tool call errored (PostToolUseFailure)
  failed?: boolean
  // variant_change: the server relayed /incident or /all-clear to every client
  // (reason is also why a session_ended session ended)
  variant?: 'none' | 'incident'
  reason?: string
  // health: the server's pipeline record (server/health.js), also carried by the snapshot
  health?: ServerHealth
  // connection: the WebSocket opened or closed — dispatched by useAgentSocket, not sent by the server
  socket?: 'open' | 'closed'
}

import { BOSS_NAME, BOSS_COLOR, BOSS_EMOJI } from './config'

export const AGENT_CONFIGS: Record<string, { color: string; emoji: string; title: string }> = {
  // The boss — configured via office.config.json
  'boss':                  { color: BOSS_COLOR, emoji: BOSS_EMOJI, title: BOSS_NAME },
  // Subagents
  'debugger':              { color: '#e74c3c', emoji: '🔍', title: 'Debugger' },
  'code-reviewer':         { color: '#3498db', emoji: '📋', title: 'Reviewer' },
  'frontend-developer':    { color: '#2ecc71', emoji: '🎨', title: 'Frontend' },
  'fullstack-developer':   { color: '#9b59b6', emoji: '⚡', title: 'Fullstack' },
  'test-engineer':         { color: '#f39c12', emoji: '🧪', title: 'Tester' },
  'security-auditor':      { color: '#e67e22', emoji: '🛡️', title: 'Security' },
  'architect-reviewer':    { color: '#1abc9c', emoji: '🏗️', title: 'Architect' },
  'performance-engineer':  { color: '#e91e63', emoji: '🚀', title: 'PerfEng' },
  'devops-engineer':       { color: '#607d8b', emoji: '🔧', title: 'DevOps' },
  'database-architect':    { color: '#795548', emoji: '🗄️', title: 'DBA' },
  'typescript-pro':        { color: '#3178c6', emoji: '📘', title: 'TS Pro' },
  'ai-engineer':           { color: '#ff6f00', emoji: '🤖', title: 'AI Eng' },
  'prompt-engineer':       { color: '#ab47bc', emoji: '✍️', title: 'Prompts' },
  'general-purpose':       { color: '#78909c', emoji: '👤', title: 'General' },
  'Explore':               { color: '#4caf50', emoji: '🔭', title: 'Explorer' },
  // MCPs
  'github':                { color: '#f0f0f0', emoji: '🐙', title: 'GitHub' },
  'supabase':              { color: '#3ecf8e', emoji: '⚡', title: 'Supabase' },
  'playwright':            { color: '#45ba4b', emoji: '🎭', title: 'Playwright' },
  'chrome':                { color: '#4285f4', emoji: '🌐', title: 'Chrome' },
  'memory':                { color: '#ff9800', emoji: '🧠', title: 'Memory' },
  'seo':                   { color: '#4caf50', emoji: '📊', title: 'SEO' },
  'gmail':                 { color: '#ea4335', emoji: '📧', title: 'Gmail' },
  'ios-simulator':         { color: '#a2aaad', emoji: '📱', title: 'iOS' },
  'assistant':             { color: '#cc785c', emoji: '🤖', title: 'Claude' },
  'default':               { color: '#95a5a6', emoji: '👤', title: 'Worker' },
}
