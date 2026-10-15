/**
 * officeReducer.ts — the office's event → state machine, as pure functions.
 *
 * App.tsx used to compute the next agents array *and* its side-effects (chat
 * lines, sounds, furniture changes) inside a `setAgents(prev => ...)` updater.
 * React 18 defers and may double-invoke updaters, so those effects were lost
 * or duplicated, and the animation loop replaced the whole array from a stale
 * ref, dropping events that arrived during a frame (audit C12/C14/C31).
 *
 * Here every transition is `(state, action, env) → { state, effects }`:
 *   - `reduceOffice`  handles server / sim events (spawn, working, completed,
 *                     chat, snapshot reconciliation, the session turn events …)
 *   - `stepOffice`    advances one animation frame: walking, arrival, breaks,
 *                     pruning at the door, seating lobby waiters
 *   - effects are plain data; the caller flushes them once, outside React
 *
 * Nothing in this module touches React, the DOM, timers or Math.random
 * directly (randomness and path-finding come in through `OfficeEnv`), so the
 * whole lifecycle is unit-testable in plain Node.
 *
 * Sessions. Every Claude Code terminal gets its own Claude (`main-<sessionId>`,
 * src/mainState.ts), created on the first event from that session or by the
 * snapshot and seated by the boss when that desk is free. It acts out the
 * turn: session_prompt (the boss walks over and hands the prompt across, Claude
 * types), main-thread agent_working (its status line), session_turn_end (its
 * reply in the chat, then idle — asleep after 30 s — or waiting on background
 * workers), session_needs_you (hand up, chime, amber pill), session_error,
 * session_compact (memory wipe), session_cwd / session_model (pill tags), and
 * leaves after session_ended's grace. Under ?sim there are no sessions, so the
 * one decorative Claude (CLAUDE_ID) keeps its desk.
 *
 * Signals (src/signals.ts). What a session's Bash commands meant puts a scene
 * on the character that ran the command — its worker, else the session's
 * Claude: a rocket while a deploy ships (until it lands, fails or 10 min
 * pass), a party when it lands, a red flash on a failed build or test run, a
 * merge badge on a push to main — and a system line in the chat (never
 * answered by the chat bot). Incident mode hears the same signals in App.tsx.
 */

import { Agent, AgentScene, OfficeEvent, Position, SignalEvent, SnapshotAgent, ServerHealth, SessionInfo, SessionMain, MainState, NeedsYou, AGENT_CONFIGS } from './types'
import { ROOMS, AgentSpot } from './rooms'
import {
  mainId, isMainAgent, isFreeMain, isHardNeedsYou, needsYouLabel, agentStateFor,
  completionStats, summarise, projectFromCwd, countRunningTasks,
} from './mainState'
import {
  createAgent,
  stepToward,
  WALK_SPEED,
  BREAK_MIN_DESK_TIME,
  BREAK_CHANCE_PER_SEC,
  BREAK_DURATION,
  spawnMessage,
  workMessage,
  doneMessage,
  coffeeMessage,
  waterMessage,
} from './agentManager'
import { BOSS_ROLE, BOSS_NAME } from './config'
import { getTheme } from './theme'
import { getVariant, pickIncidentLine } from './incident'
import { isSignalKind, signalFamily, signalOutcome, signalWhere, SCENE_MS } from './signals'

// ---------------------------------------------------------------------------
// Room constants
// ---------------------------------------------------------------------------

export const MAIN_ROOM = ROOMS['main-office']
export const ENTRY = MAIN_ROOM.entryPoint
export const DOOR_TARGET: Position = { x: ENTRY.x, y: ENTRY.y }
const COFFEE_SPOT = MAIN_ROOM.agentSpots.find(s => s.type === 'coffee') ?? null
const WATER_SPOTS = MAIN_ROOM.agentSpots.filter(s => s.type === 'water')
const FILING_SPOT = MAIN_ROOM.agentSpots.find(s => s.type === 'filing') ?? null

/** Roles that browse the filing cabinet instead of taking a desk */
const FILING_ROLES = new Set(['Explore', 'general-purpose'])

export const BOSS_ID = `boss-${BOSS_NAME.toLowerCase()}`
/** The decorative Claude of ?sim / ?video (no sessions there); live offices get one per session */
export const CLAUDE_ID = 'assistant-claude'
export const CLAUDE_ROLE = 'assistant'
/** The desk next to the boss: the first session's Claude sits here, later ones take the next free desk */
export const CLAUDE_HOME_SPOT = 'spot-2'

/** How close (in %-units) an agent must be to a target to count as arrived */
export const ARRIVAL_THRESHOLD = 0.3
/** Minimum time (ms) an agent stays visible after spawning before it may leave */
export const MIN_VISIBLE_TIME = 30_000
/** How long the boss stands at Claude's desk after handing a prompt over */
export const HANDOVER_DWELL_MS = 3_000
/** Safety net: the boss returns to his desk this long after setting off, wherever he got to */
export const HANDOVER_MAX_MS = 15_000
/** A session's Claude keeps its desk this long after session_ended (a resume within it stays seated) */
export const SESSION_CLAUDE_GRACE_MS = 10_000

/** Directed agent-to-agent messages: icon per type, visit length at the recipient's desk */
const A2A_ICONS: Record<string, string> = {
  message:        '💬',
  question:       '❓',
  review_request: '👀',
  task_handoff:   '📦',
}
export const A2A_VISIT_MS = 6000

const SYSTEM_COLOR = '#8b8d91'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMeta {
  /** When the agent spawned */
  spawnedAt: number
  /** When the agent last sat down at its desk (null while away from it) */
  arrivedAtDeskAt: number | null
  /** When the agent entered the idle state */
  idleSince: number | null
  /** On a coffee / water break right now */
  onBreak: boolean
  /** When that break started */
  breakStartedAt: number | null
  /** Which lobby standing spot this agent took while waiting for a desk */
  lobbySlot?: number
  /** A session's Claude: the main state to go back to when the memory wipe is over */
  beforeCompact?: MainState
}

/** An agent_working that arrived before the agent reached its desk (C13) */
export interface PendingStatus {
  status: string
  failed: boolean
}

/** How the office is connected to its server (the status strip's first pill) */
export type ConnectionPhase = 'connecting' | 'online' | 'reconnecting' | 'offline'

/**
 * Pipeline health as the office knows it: the socket's phase (from the
 * `connection` actions src/hooks/useAgentSocket.ts dispatches on open/close)
 * and the server's last report (the `health` event, also the snapshot's
 * `health`). Shown by src/components/StatusStrip.tsx.
 */
export interface HealthState {
  connection: ConnectionPhase
  /** When the current phase began */
  connectionSince: number
  /** When the socket first opened this page load (null until it has) */
  onlineSince: number | null
  /** The server's last report (null until one arrives) */
  server: ServerHealth | null
  /** When that report arrived, by the office's clock */
  reportedAt: number | null
}

export interface OfficeState {
  agents: Agent[]
  /** Ids of agents waiting by the door for a desk, oldest first */
  lobby: string[]
  /** Latest status per agent that is still walking in; applied on arrival */
  pendingStatus: Record<string, PendingStatus>
  meta: Record<string, AgentMeta>
  /** `${timestamp}:${text}` of recent chat_message events, for deduplication */
  recentChatKeys: string[]
  /** Sessions whose session_ended arrived, with when: their Claude leaves after the grace unless a resume clears it */
  endedSessions: Record<string, number>
  /** Bumped per boss hand-over, so a stale handover_over cannot cut a newer visit short */
  handoverSeq: number
  /** Connection + the server's health report (the status strip) */
  health: HealthState
  /** Build and test runs whose last run failed (`session|family|target` -> when), for the "green again" line */
  redRuns: Record<string, number>
}

/** Everything impure the reducer needs, injected so tests are deterministic */
export interface OfficeEnv {
  now: number
  /** true when driven by the real server; false under ?sim / ?video */
  live: boolean
  computePath: (from: Position, to: Position) => Position[]
  random: () => number
}

/** Internal actions the wiring schedules on the reducer's behalf */
export type OfficeAction =
  | OfficeEvent
  | { type: 'a2a_visit_over'; agentId: string }
  /** The boss has said his piece at Claude's desk (seq guards against a stale timer) */
  | { type: 'handover_over'; seq: number }
  /** session_ended's grace is over: that session's Claude clocks out */
  | { type: 'session_claude_leave'; sessionId: string }
  /** What a Bash command meant (the server's `signal` broadcast) */
  | SignalEvent
  /** A signal's scene has run its course (`until` guards against a newer scene) */
  | { type: 'scene_over'; agentId: string; until: number }

export type SfxName = 'doorOpen' | 'typing' | 'celebration' | 'coffee' | 'alarm' | 'error' | 'powerDown' | 'notification' | 'needsYou'

export type OfficeEffect =
  /** `agentId` names the character that shows the typing bubble before the line; `tag` marks a prompt / reply row */
  | { kind: 'msg'; sender: string; role: string; color: string; text: string; isSystem?: boolean; id?: number; agentId?: string; tag?: 'prompt' | 'reply' }
  | { kind: 'sfx'; sfx: SfxName }
  /** Window / title-bar prefix: '✋ ' while any session needs a person, '' once none does */
  | { kind: 'title'; prefix: string }
  | { kind: 'furniture'; id: string; state: string }
  /** Dispatch `action` again after `delayMs` (deferred departures, A2A visits) */
  | { kind: 'schedule'; action: OfficeAction; delayMs: number }
  | { kind: 'typing'; sender: string | null }
  | { kind: 'reaction'; messageId: number; reactions: string[] }
  | { kind: 'seen'; messageId: number | null }
  /** The server echoed the boss's own message: give the local copy its row id */
  | { kind: 'adoptMsgId'; id: number; text: string }
  /** The last agent with this role left: free its Office-theme character */
  | { kind: 'releaseRole'; role: string }

export interface OfficeResult {
  state: OfficeState
  effects: OfficeEffect[]
}

export interface StepResult extends OfficeResult {
  /** false when nothing moved or changed (state is the same object) */
  changed: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfgFor(role: string) {
  return AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
}

function newMeta(now: number, seated = false): AgentMeta {
  return { spawnedAt: now, arrivedAtDeskAt: seated ? now : null, idleSince: null, onBreak: false, breakStartedAt: null }
}

function near(a: Position, b: Position, threshold = ARRIVAL_THRESHOLD): boolean {
  return Math.abs(a.x - b.x) < threshold && Math.abs(a.y - b.y) < threshold
}

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record
  const next = { ...record }
  delete next[id]
  return next
}

/** Spots held by agents who are still in the office (a leaver's desk is free) */
function occupiedSpotIds(agents: Agent[]): Set<string> {
  const ids = new Set<string>()
  for (const a of agents) if (a.assignedSpotId && a.state !== 'completed') ids.add(a.assignedSpotId)
  return ids
}

/** The filing cabinet for browsing roles when it is free, otherwise the first free desk */
export function pickSpot(agents: Agent[], role: string): AgentSpot | null {
  const taken = occupiedSpotIds(agents)
  if (FILING_ROLES.has(role) && FILING_SPOT !== null && !taken.has(FILING_SPOT.id)) return FILING_SPOT
  return MAIN_ROOM.agentSpots.find(s => s.type === 'desk' && !taken.has(s.id)) ?? null
}

/**
 * Where the n-th lobby waiter stands: along the wall either side of the door,
 * never on the doormat itself, so arrivals and leavers can still get past.
 */
export function lobbyPosition(slot: number): Position {
  const side = slot % 2 === 0 ? -1 : 1
  const rank = Math.floor(slot / 2)
  return { x: ENTRY.x + side * (3.5 + rank * 2.6), y: ENTRY.y + side * (2.3 + rank * 1.7) }
}

function freeLobbySlot(state: OfficeState): number {
  const used = new Set<number>()
  for (const id of state.lobby) {
    const slot = state.meta[id]?.lobbySlot
    if (slot !== undefined) used.add(slot)
  }
  let slot = 0
  while (used.has(slot)) slot++
  return slot
}

/** Match a chat sender/recipient to an agent in the office: id first, then name or role. */
export function findOfficeAgent(agents: Agent[], id: string | null | undefined, ref: string | null | undefined): Agent | undefined {
  if (id) {
    const byId = agents.find(a => a.id === id)
    if (byId) return byId
  }
  if (!ref) return undefined
  const want = ref.toLowerCase()
  return agents.find(a => a.name.toLowerCase() === want) ?? agents.find(a => a.role.toLowerCase() === want)
}

function walkTo(agent: Agent, target: Position, statusText: string, env: OfficeEnv): Agent {
  return {
    ...agent,
    state: 'walking-to-desk',
    targetPosition: { ...target },
    statusText,
    pathQueue: env.computePath(agent.position, target),
  }
}

function pickOne<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]
}

function bossReply(agentName: string, random: () => number): string {
  const replies = [
    `nice work ${agentName} 👊`,
    `solid 🔥`,
    `ship it!`,
    `great stuff, grab a Red Bull`,
    `legend 💯`,
    `good job, who's next?`,
    `that was quick, another one?`,
    `clean work 👌`,
    `cheers ${agentName}`,
    `merged. next task loading...`,
  ]
  // Why: during an incident the boss is the Incident Commander 40% of the time;
  // under the Office theme Michael Scott occasionally lands his signature line.
  if (getVariant() === 'incident' && random() < 0.4) return pickIncidentLine('bossReply')
  if (getTheme() === 'office' && random() < 0.25) return `That's what she said 😏`
  return pickOne(replies, random)
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/** The office with its permanent staff (the boss, and under ?sim the decorative Claude) already seated */
export function initialOfficeState(agents: Agent[], now: number): OfficeState {
  const meta: Record<string, AgentMeta> = {}
  for (const a of agents) meta[a.id] = newMeta(now, true)
  return { agents, lobby: [], pendingStatus: {}, meta, recentChatKeys: [], endedSessions: {}, handoverSeq: 0, health: initialHealth(now), redRuns: {} }
}

// ---------------------------------------------------------------------------
// Pipeline health (the status strip)
// ---------------------------------------------------------------------------

/** Before the socket has said anything: connecting, no report */
export function initialHealth(now: number): HealthState {
  return { connection: 'connecting', connectionSince: now, onlineSince: null, server: null, reportedAt: null }
}

/**
 * The socket's phase. `connecting` → `online` on the first open; a close
 * after that is `reconnecting` (the hook keeps retrying with back-off), a
 * close before any open is `offline` (no server has answered yet). A repeat
 * of the current phase — one failed retry after another — is not a change,
 * so `connectionSince` keeps the time the phase was entered.
 */
export function reduceConnection(h: HealthState, socket: 'open' | 'closed' | undefined, now: number): HealthState {
  if (socket === 'open') {
    if (h.connection === 'online') return h
    return { ...h, connection: 'online', connectionSince: now, onlineSince: h.onlineSince ?? now }
  }
  if (socket === 'closed') {
    const next: ConnectionPhase = h.onlineSince === null ? 'offline' : 'reconnecting'
    if (h.connection === next) return h
    return { ...h, connection: next, connectionSince: now }
  }
  return h
}

/** Online this long with no hook heard: the hooks are probably not installed */
export const HOOK_WARN_MS = 60_000

export type HookVerdict =
  /** No server report yet (not connected) */
  | { kind: 'unknown' }
  /** Hooks fire; the last one `agoMs` ago, `count` since the server started */
  | { kind: 'seen'; agoMs: number; count: number }
  /** None yet, but the office or the server has only been up `forMs` */
  | { kind: 'waiting'; forMs: number }
  /** None after `forMs` ≥ warnAfterMs with both up: time to run the installer */
  | { kind: 'missing'; forMs: number }

/**
 * What to say about hooks. `missing` needs both this page to have been
 * online and the server to have been up for `warnAfterMs` with nothing
 * heard: a server that was just restarted, or a page that just connected,
 * has not had the chance yet. `lastHookAt` is stamped by the server's clock,
 * which is this machine's — the two talk over loopback.
 */
export function hookVerdict(h: HealthState, now: number, warnAfterMs = HOOK_WARN_MS): HookVerdict {
  const s = h.server
  if (!s) return { kind: 'unknown' }
  if (s.lastHookAt !== null) return { kind: 'seen', agoMs: Math.max(0, now - s.lastHookAt), count: s.hooksSeen }
  const onlineFor = h.connection === 'online' && h.onlineSince !== null ? now - h.onlineSince : 0
  const serverUp = s.uptimeMs + Math.max(0, now - (h.reportedAt ?? now))
  const forMs = Math.max(0, Math.min(onlineFor, serverUp))
  return forMs >= warnAfterMs ? { kind: 'missing', forMs } : { kind: 'waiting', forMs }
}

// ---------------------------------------------------------------------------
// Spawning / completing
// ---------------------------------------------------------------------------

interface SpawnFields {
  id?: string
  name?: string
  role?: string
  task?: string
  status?: string
  unread?: number
  sessionId?: string
  project?: string
  /** Sit here when it is free (a session's Claude prefers the desk by the boss) */
  preferredSpotId?: string
  statusText?: string
  model?: string
}

/**
 * Add an agent. With a free desk (or the filing cabinet) it walks in from the
 * door as a new hire; otherwise it waits in the lobby by the door and is
 * seated by `stepOffice` as soon as a desk frees up (C29 — never dropped).
 *
 * `announce` posts the task line. The live server already posts
 * "starting: <task>" for every spawn it sees, so the office only announces
 * under ?sim (no server) and for snapshot-restored agents (the server's line
 * predates this connection).
 */
function spawnAgent(state: OfficeState, raw: SpawnFields, env: OfficeEnv, announce: boolean): OfficeResult {
  const id = raw.id ?? `agent-${env.now}`
  if (state.agents.some(a => a.id === id)) return { state, effects: [] }

  const name = raw.name ?? 'Agent'
  const role = raw.role ?? 'general-purpose'
  const task = raw.task
  const cfg = cfgFor(role)
  const effects: OfficeEffect[] = [{ kind: 'sfx', sfx: 'doorOpen' }]
  const common = {
    sessionId: raw.sessionId,
    project: raw.project,
    unread: raw.unread || undefined,
    ...(raw.model ? { model: raw.model } : {}),
  }

  let agent: Agent
  let meta = newMeta(env.now)
  let lobby = state.lobby

  const preferred = raw.preferredSpotId
    ? MAIN_ROOM.agentSpots.find(s => s.id === raw.preferredSpotId && !occupiedSpotIds(state.agents).has(s.id)) ?? null
    : null
  const spot = preferred ?? pickSpot(state.agents, role)
  if (spot) {
    // hiredAt from the env clock, so the same event reduced twice gives the same agent
    const base = createAgent({ id, name, role, task, spot, hiredAt: env.now })
    agent = { ...base, ...common, pathQueue: env.computePath(base.position, base.targetPosition) }
    if (raw.statusText) agent = { ...agent, statusText: raw.statusText }
    if (announce) {
      effects.push({ kind: 'msg', sender: name, role, color: cfg.color, text: task ? (env.live ? `📋 ${task}` : `starting: ${task}`) : spawnMessage() })
    }
  } else {
    const slot = freeLobbySlot(state)
    const pos = lobbyPosition(slot)
    const base = createAgent({ id, name, role, task, spot: { id: 'lobby', type: 'door', x: pos.x, y: pos.y, spriteFacing: 'front-left' }, hiredAt: env.now })
    agent = {
      ...base,
      ...common,
      assignedSpotId: undefined,
      state: 'waiting',
      statusText: 'waiting for a desk',
      pathQueue: env.computePath(base.position, pos),
    }
    meta = { ...meta, lobbySlot: slot }
    lobby = [...state.lobby, id]
    effects.push({ kind: 'msg', sender: name, role, color: cfg.color, text: 'waiting for a desk...' })
  }

  const pendingStatus = raw.status
    ? { ...state.pendingStatus, [id]: { status: raw.status, failed: false } }
    : state.pendingStatus

  return {
    state: { ...state, agents: [...state.agents, agent], lobby, meta: { ...state.meta, [id]: meta }, pendingStatus },
    effects,
  }
}

/**
 * Walk an agent out to the door. `quiet` skips the celebration and boss reply
 * (used when a snapshot tells us the agent left while we were disconnected).
 * `stats` are what the Agent tool reported (tokens, duration): they make the
 * completion line "✅ done · 42k tok · 3m12s".
 */
function completeAgent(
  state: OfficeState, id: string, result: string | undefined, env: OfficeEnv, quiet: boolean,
  stats: { tokens?: number; durationMs?: number } = {},
): OfficeResult {
  const agent = state.agents.find(a => a.id === id)
  if (!agent || agent.state === 'completed') return { state, effects: [] }

  const effects: OfficeEffect[] = []
  const resultMsg = result ?? doneMessage()
  if (!quiet) {
    const parts = completionStats(stats.tokens, stats.durationMs)
    const color = cfgFor(agent.role).color
    // The live server posts "done: <result>" itself; under ?sim nobody else will.
    // The numbers are ours either way: the server's row does not carry them.
    if (!env.live) effects.push({ kind: 'msg', sender: agent.name, role: agent.role, color, text: `done: ${resultMsg}${parts.length ? ` · ${parts.join(' · ')}` : ''}` })
    else if (parts.length) effects.push({ kind: 'msg', sender: agent.name, role: agent.role, color, text: `✅ done · ${parts.join(' · ')}` })
    effects.push({ kind: 'sfx', sfx: 'celebration' })
    const boss = cfgFor(BOSS_ROLE)
    effects.push({ kind: 'msg', sender: boss.title, role: BOSS_ROLE, color: boss.color, text: bossReply(agent.name, env.random) })
  }
  if (agent.assignedSpotId === 'spot-filing') effects.push({ kind: 'furniture', id: 'filing-1', state: 'closed' })

  const leaving: Agent = {
    ...agent,
    state: 'completed',
    targetPosition: { ...DOOR_TARGET },
    statusText: resultMsg,
    pathQueue: env.computePath(agent.position, DOOR_TARGET),
  }
  const prevMeta = state.meta[id] ?? newMeta(env.now)
  return {
    state: {
      ...state,
      agents: state.agents.map(a => (a.id === id ? leaving : a)),
      lobby: state.lobby.filter(x => x !== id),
      pendingStatus: without(state.pendingStatus, id),
      meta: { ...state.meta, [id]: { ...prevMeta, arrivedAtDeskAt: null, onBreak: false, breakStartedAt: null } },
    },
    effects,
  }
}

// ---------------------------------------------------------------------------
// Sessions: one Claude per terminal
// ---------------------------------------------------------------------------

/** The session's Claude, if it is in the office (a leaver no longer counts) */
function findMain(state: OfficeState, sessionId: string): Agent | undefined {
  const a = state.agents.find(x => x.id === mainId(sessionId))
  return a && a.state !== 'completed' ? a : undefined
}

/** How many Claudes share the office right now (two or more: chat lines carry the project) */
function mainCount(state: OfficeState): number {
  return state.agents.filter(a => isMainAgent(a) && a.state !== 'completed').length
}

/** A chat line from a session's Claude; "Claude · <project>" once several terminals are open */
function claudeMsg(state: OfficeState, claude: Agent, text: string, tag?: 'prompt' | 'reply'): OfficeEffect {
  const cfg = cfgFor(CLAUDE_ROLE)
  const sender = mainCount(state) > 1 && claude.project ? `${cfg.title} · ${claude.project}` : cfg.title
  return { kind: 'msg', sender, role: CLAUDE_ROLE, color: cfg.color, text, agentId: claude.id, ...(tag ? { tag } : {}) }
}

interface MainPatch {
  /** The new main state; `null` = unknown again (session ended) */
  mainState?: MainState | null
  statusText?: string
  needsYou?: NeedsYou
  waitingOn?: number
  lastFailed?: boolean
  /** When the server says this state began (a reload shows a long-idle Claude asleep at once) */
  since?: number
}

/**
 * Apply a main-thread transition to a session's Claude. A seated Claude
 * changes sprite state (working / idle); one walking in, out or to a break
 * keeps walking and takes the state on arrival. Entering idle starts the
 * sleep timer (meta.idleSince); leaving it stops it.
 */
function applyMain(state: OfficeState, id: string, patch: MainPatch, env: OfficeEnv): OfficeState {
  const agent = state.agents.find(a => a.id === id)
  if (!agent || agent.state === 'completed') return state
  const mainState = patch.mainState === undefined ? agent.mainState : (patch.mainState ?? undefined)
  const seated = agent.state === 'working' || agent.state === 'idle'
  // A memory wipe keeps the wait it interrupted, so PostCompact can restore it
  const keep = mainState === 'compacting'
  const next: Agent = {
    ...agent,
    mainState,
    needsYou: mainState === 'needs-you' || keep ? (patch.needsYou ?? agent.needsYou) : undefined,
    waitingOn: mainState === 'waiting' || keep ? (patch.waitingOn ?? agent.waitingOn) : undefined,
    statusText: patch.statusText ?? agent.statusText,
    lastFailed: patch.lastFailed ?? agent.lastFailed,
    state: seated ? agentStateFor(mainState) : agent.state,
  }
  const prevMeta = state.meta[id] ?? newMeta(env.now)
  const idleSince = mainState === 'idle' ? (prevMeta.idleSince ?? patch.since ?? env.now) : null
  return {
    ...state,
    agents: state.agents.map(a => (a.id === id ? next : a)),
    meta: { ...state.meta, [id]: { ...prevMeta, idleSince } },
  }
}

/** Claude's status line for a server-side main record (snapshot / reconnect) */
function mainStatusText(main: SessionMain): string | undefined {
  switch (main.state) {
    case 'working':    return main.lastPrompt ? `✍ ${summarise(main.lastPrompt)}` : '⚡ working'
    case 'waiting':    return waitingText(main.waitingOn ?? 0)
    case 'idle':       return 'turn over — idle'
    case 'needs-you':  return main.needsYou ? needsYouLabel(main.needsYou) : '✋ needs you'
    case 'error':      return `⚠ API error${main.error?.error ? `: ${main.error.error}` : ''}`
    case 'compacting': return '🧹 memory wipe'
    default:           return undefined
  }
}

function fromServerMain(main: SessionMain): MainPatch {
  return { mainState: main.state, needsYou: main.needsYou, waitingOn: main.waitingOn, since: main.since, statusText: mainStatusText(main) }
}

function waitingText(n: number): string {
  return n > 0 ? `⏳ waiting on ${n} background worker${n === 1 ? '' : 's'}` : '⏳ waiting on background workers'
}

/** Claude's status line when PostCompact puts it back where it was */
function restoredStatus(state: MainState, claude: Agent): string | undefined {
  switch (state) {
    case 'working':   return '✍ back to work'
    case 'idle':      return 'turn over — idle'
    case 'waiting':   return waitingText(claude.waitingOn ?? 0)
    case 'needs-you': return claude.needsYou ? needsYouLabel(claude.needsYou) : '✋ needs you'
    case 'error':     return '⚠ API error'
    default:          return undefined
  }
}

interface SessionFields {
  project?: string
  cwd?: string
  model?: string
  main?: SessionMain
}

/**
 * The session's Claude, created if this is the first we hear of the session.
 * It walks in like any new hire, to the desk by the boss when that is free,
 * and posts its own clock-in line (the server posts none for a main thread).
 * A session that has ended gets no new Claude; a resume (session_started)
 * clears that first. One caught on its way out by a resume comes back in
 * through the door.
 */
function ensureClaude(state: OfficeState, sessionId: string, info: SessionFields, env: OfficeEnv): OfficeResult & { created: boolean } {
  const id = mainId(sessionId)
  const existing = state.agents.find(a => a.id === id)
  if (existing && existing.state !== 'completed') return { state, effects: [], created: false }
  if (sessionId in state.endedSessions) return { state, effects: [], created: false }

  let cur = state
  if (existing) {
    cur = {
      ...cur,
      agents: cur.agents.filter(a => a.id !== id),
      lobby: cur.lobby.filter(x => x !== id),
      meta: without(cur.meta, id),
      pendingStatus: without(cur.pendingStatus, id),
    }
  }
  const project = info.project ?? projectFromCwd(info.cwd)
  const cfg = cfgFor(CLAUDE_ROLE)
  const r = spawnAgent(cur, {
    id, name: cfg.title, role: CLAUDE_ROLE,
    task: project ? `Claude Code · ${project}` : 'Claude Code',
    statusText: 'clocked in',
    sessionId, project, model: info.model,
    preferredSpotId: CLAUDE_HOME_SPOT,
  }, env, false)
  let next = r.state
  if (info.main) next = applyMain(next, id, fromServerMain(info.main), env)
  const claude = next.agents.find(a => a.id === id)!
  const effects: OfficeEffect[] = [...r.effects, claudeMsg(next, claude, `🤖 clocked in${project ? ` · ${project}` : ''}`)]
  return { state: next, effects, created: true }
}

/**
 * The boss gets up and hands the prompt over at Claude's desk: walking-to-
 * manager → (stepOffice, on arrival) talking-to-manager with `bubble` as the
 * speech bubble → handover_over → back to his desk. Only a seated boss (or
 * one already on such a visit) goes; a Claude without a desk gets no visit.
 */
function bossHandover(state: OfficeState, claude: Agent, bubble: string, env: OfficeEnv): OfficeResult {
  const boss = state.agents.find(a => a.id === BOSS_ID)
  const free = boss && (boss.state === 'working' || boss.state === 'idle' || boss.state === 'walking-to-manager' || boss.state === 'talking-to-manager')
  if (!boss || !free || !claude.assignedSpotId) return { state, effects: [] }
  const seq = state.handoverSeq + 1
  const spot = { x: claude.deskPosition.x + 4, y: claude.deskPosition.y + 2 }
  const effects: OfficeEffect[] = [{ kind: 'schedule', action: { type: 'handover_over', seq }, delayMs: HANDOVER_MAX_MS }]
  let next: Agent
  if (near(boss.position, spot, 1)) {
    // Already there (a second prompt in quick succession): just say the new line
    next = { ...boss, state: 'talking-to-manager', statusText: bubble, targetPosition: { ...spot }, pathQueue: [] }
    effects.push({ kind: 'schedule', action: { type: 'handover_over', seq }, delayMs: HANDOVER_DWELL_MS })
  } else {
    next = { ...walkTo(boss, spot, bubble, env), state: 'walking-to-manager' }
  }
  return {
    state: { ...state, handoverSeq: seq, agents: state.agents.map(a => (a.id === BOSS_ID ? next : a)) },
    effects,
  }
}

// ---------------------------------------------------------------------------
// Signals: scenes on the character that ran the command
// ---------------------------------------------------------------------------

/** How many red runs the office remembers for its "green again" line */
const MAX_RED_RUNS = 50

/** A system row in the chat: shown, never answered by the chat bot */
function systemMsg(text: string): OfficeEffect {
  return { kind: 'msg', sender: 'system', role: 'default', color: SYSTEM_COLOR, text, isSystem: true }
}

/** Put a scene on an agent; it ends by itself after `ms` unless a newer one replaces it */
function withScene(state: OfficeState, agentId: string, kind: AgentScene['kind'], ms: number, env: OfficeEnv, effects: OfficeEffect[], label?: string): OfficeState {
  const scene: AgentScene = { kind, until: env.now + ms, ...(label ? { label } : {}) }
  effects.push({ kind: 'schedule', action: { type: 'scene_over', agentId, until: scene.until }, delayMs: ms })
  return { ...state, agents: state.agents.map(a => (a.id === agentId ? { ...a, scene } : a)) }
}

/** End an agent's scene of this kind now (a deploy that stopped shipping) */
function withoutScene(state: OfficeState, agentId: string, kind: AgentScene['kind']): OfficeState {
  const agent = state.agents.find(a => a.id === agentId)
  if (agent?.scene?.kind !== kind) return state
  return { ...state, agents: state.agents.map(a => (a.id === agentId ? { ...a, scene: undefined } : a)) }
}

/**
 * One signal: the scene on the worker that ran the command (else the
 * session's Claude) and the chat line. Incident mode is fed the same signal
 * by App.tsx; this only draws and talks.
 */
function reduceSignal(state: OfficeState, action: SignalEvent, env: OfficeEnv): OfficeResult {
  if (!isSignalKind(action.kind)) return { state, effects: [] }
  const family = signalFamily(action.kind)
  const outcome = signalOutcome(action.kind)
  const effects: OfficeEffect[] = []
  let cur = state
  let actor = action.agentId ? cur.agents.find(a => a.id === action.agentId && a.state !== 'completed') : undefined
  if (!actor && action.sessionId) {
    const ensured = ensureClaude(cur, action.sessionId, { project: action.project }, env)
    cur = ensured.state
    effects.push(...ensured.effects)
    actor = findMain(cur, action.sessionId)
  }
  const where = signalWhere(action)
  const why = action.detail || action.error || (action.exitCode !== undefined ? `exit code ${action.exitCode}` : '')
  const scene = (kind: AgentScene['kind'], ms: number, label?: string) => {
    if (actor) cur = withScene(cur, actor.id, kind, ms, env, effects, label)
  }

  if (family === 'deploy') {
    if (outcome === 'start') {
      scene('shipping', SCENE_MS.shipping, `🚀 shipping${where ? ` ${where}` : ''}`)
    } else if (action.interrupted) {
      if (actor) cur = withoutScene(cur, actor.id, 'shipping')
      effects.push(systemMsg(`⏹ ${where ? `${where} deploy` : 'deploy'} interrupted`))
    } else if (outcome === 'ok') {
      scene('shipped', SCENE_MS.shipped)
      effects.push(systemMsg(`🚀 ${where ?? 'it'} deployed`), { kind: 'sfx', sfx: 'celebration' })
    } else {
      // The incident itself (and its alarm) opens in incident mode
      scene('red', SCENE_MS.red)
      effects.push(systemMsg(`💥 ${where ? `${where} deploy` : 'deploy'} failed${why ? ` — ${why}` : ''}`))
    }
    return { state: cur, effects }
  }

  if (family === 'push') {
    if (outcome === 'ok' && action.toDefault) {
      scene('pushed', SCENE_MS.pushed)
      effects.push(systemMsg(`🎉 pushed to ${action.branch ?? 'main'}${where ? ` · ${where}` : ''}`), { kind: 'sfx', sfx: 'notification' })
    }
    return { state: cur, effects }
  }

  // A build or a test run: red when it fails, a line when it is green again
  if (outcome === 'start' || action.interrupted) return { state: cur, effects }
  const what = family === 'test' ? 'tests' : 'build'
  const key = `${action.sessionId ?? ''}|${family}|${where ?? ''}`
  if (outcome === 'fail') {
    scene('red', SCENE_MS.red)
    const redRuns = Object.fromEntries(Object.entries({ ...cur.redRuns, [key]: env.now }).slice(-MAX_RED_RUNS))
    cur = { ...cur, redRuns }
    effects.push(systemMsg(`❌ ${what} failed${where ? ` in ${where}` : ''}${why ? ` — ${why}` : ''}`), { kind: 'sfx', sfx: 'error' })
    return { state: cur, effects }
  }
  if (!(key in cur.redRuns)) return { state: cur, effects }
  cur = { ...cur, redRuns: without(cur.redRuns, key) }
  effects.push(systemMsg(`✅ ${what} green again${where ? ` in ${where}` : ''}`))
  return { state: cur, effects }
}

/** Sessions whose Claude has a hand up for a person (drives the '✋ ' title prefix) */
function hardNeedsYouCount(state: OfficeState): number {
  return state.agents.filter(a => isMainAgent(a) && a.state !== 'completed' && a.mainState === 'needs-you' && isHardNeedsYou(a.needsYou)).length
}

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

/**
 * One event in, the next state and its effects out. Wraps the per-event
 * switch so the '✋ ' title prefix follows every raise *and* every clear path
 * (prompt, turn end, a tool call, session end, snapshot) from one place.
 */
export function reduceOffice(state: OfficeState, action: OfficeAction, env: OfficeEnv): OfficeResult {
  const r = reduceEvent(state, action, env)
  if (r.state === state) return r
  const before = hardNeedsYouCount(state) > 0
  const after = hardNeedsYouCount(r.state) > 0
  if (before === after) return r
  return { state: r.state, effects: [...r.effects, { kind: 'title', prefix: after ? '✋ ' : '' }] }
}

/** Turn events that say nothing once their session has ended (only a session_started revives it) */
const TURN_EVENTS = new Set<OfficeAction['type']>([
  'session_prompt', 'session_turn_end', 'session_needs_you', 'session_tool_done', 'session_main',
  'session_error', 'session_compact', 'session_cwd', 'session_model',
])

function reduceEvent(state: OfficeState, action: OfficeAction, env: OfficeEnv): OfficeResult {
  const none: OfficeResult = { state, effects: [] }

  // A straggler for a session whose end we already saw: its Claude is on its way out
  if (TURN_EVENTS.has(action.type) && 'sessionId' in action && action.sessionId && action.sessionId in state.endedSessions) return none

  /** Main-thread activity (a tool call with no agentId) lands on that session's Claude, never on a worker */
  const mainThreadWorking = (sessionId: string, statusMsg: string, failed: boolean, origin: SessionFields): OfficeResult => {
    if (sessionId in state.endedSessions) return none
    const ensured = ensureClaude(state, sessionId, origin, env)
    const id = mainId(sessionId)
    let cur = applyMain(ensured.state, id, { mainState: 'working', statusText: statusMsg, lastFailed: failed }, env)
    const claude = cur.agents.find(a => a.id === id)
    if (!claude) return none
    // A status that reaches a Claude still walking in applies on arrival (C13); its line is posted now
    if (claude.state !== 'working' && claude.state !== 'idle') {
      cur = { ...cur, pendingStatus: { ...cur.pendingStatus, [id]: { status: statusMsg, failed } } }
    }
    return { state: cur, effects: [...ensured.effects, claudeMsg(cur, claude, `${failed ? '❌' : '⚡'} ${statusMsg}`)] }
  }

  switch (action.type) {
    // ── New agent spawned ──────────────────────────────────────────────────
    case 'agent_spawned': {
      const raw = action.agent ?? {}
      return spawnAgent(state, { ...raw, sessionId: raw.sessionId ?? action.sessionId, project: raw.project ?? action.project }, env, !env.live)
    }

    // ── Agent started working / status update ──────────────────────────────
    case 'agent_working': {
      const id = action.agentId ?? action.agent?.id
      const statusMsg = action.status ?? workMessage()
      const icon = action.failed ? '❌' : '⚡'
      const failed = !!action.failed

      if (id) {
        const agent = state.agents.find(a => a.id === id)
        if (!agent) return none
        // A late status for an agent already walking out (hook curls are
        // backgrounded, ordering is not guaranteed): it stays on its way out.
        if (agent.state === 'completed') return none
        const effects: OfficeEffect[] = [
          { kind: 'msg', sender: agent.name, role: agent.role, color: cfgFor(agent.role).color, text: `${icon} ${statusMsg}` },
        ]
        if (agent.state === 'working' || agent.state === 'idle') {
          return {
            state: { ...state, agents: state.agents.map(a => (a.id === id ? { ...a, state: 'working' as const, statusText: statusMsg, lastFailed: failed } : a)) },
            effects,
          }
        }
        // Still walking in, on a break or waiting in the lobby: the walk stays
        // authoritative; the latest status is applied the moment they sit down (C13)
        return { state: { ...state, pendingStatus: { ...state.pendingStatus, [id]: { status: statusMsg, failed } } }, effects }
      }

      // No agentId — tool use from a main thread. With a sessionId it is that
      // session's own Claude at work. Without one (old hook, sim mode) any
      // worker will do; failing that, the only Claude in the office.
      const origin = { project: action.project, cwd: action.cwd }
      if (action.sessionId) return mainThreadWorking(action.sessionId, statusMsg, failed, origin)
      const workers = state.agents.filter(a => a.state === 'working' && a.id !== BOSS_ID && !isMainAgent(a))
      if (workers.length === 0) {
        const mains = state.agents.filter(a => isMainAgent(a) && a.state !== 'completed')
        if (mains.length === 1 && mains[0].sessionId) return mainThreadWorking(mains[0].sessionId, statusMsg, failed, origin)
        return none
      }
      const target = pickOne(workers, env.random)
      return {
        state: { ...state, agents: state.agents.map(a => (a.id === target.id ? { ...a, statusText: statusMsg, lastFailed: failed } : a)) },
        effects: [{ kind: 'msg', sender: target.name, role: target.role, color: cfgFor(target.role).color, text: `${icon} ${statusMsg}` }],
      }
    }

    // ── Agent completed task ───────────────────────────────────────────────
    case 'agent_completed': {
      const id = action.agentId ?? action.agent?.id
      if (!id) return none
      const agent = state.agents.find(a => a.id === id)
      if (!agent || agent.state === 'completed') return none
      // Keep a quick agent visible for a moment: re-dispatch once it has been
      // in the office long enough
      const meta = state.meta[id]
      if (meta) {
        const elapsed = env.now - meta.spawnedAt
        if (elapsed < MIN_VISIBLE_TIME) {
          return { state, effects: [{ kind: 'schedule', action, delayMs: MIN_VISIBLE_TIME - elapsed }] }
        }
      }
      return completeAgent(state, id, action.result, env, false, { tokens: action.tokens, durationMs: action.durationMs })
    }

    // ── Snapshot on (re)connect: reconcile the office with the server ──────
    case 'snapshot': {
      const entries = (action.activeAgents ?? []).filter(e => e && e.id && !e.server && e.state !== 'completed')
      const byId = new Map(entries.map(e => [e.id, e]))
      let cur = state
      const effects: OfficeEffect[] = []

      // 1. Agents that completed or timed out while we were disconnected (C35).
      //    The sessions' Claudes are reconciled against the session list below.
      for (const a of state.agents) {
        if (a.id === BOSS_ID || a.id === CLAUDE_ID || isMainAgent(a) || a.state === 'completed' || byId.has(a.id)) continue
        const r = completeAgent(cur, a.id, 'clocked out while we were away', env, true)
        cur = r.state
        effects.push(...r.effects)
      }

      // 2. Agents still here: refresh what the server knows, never re-walk them in
      let pendingStatus = cur.pendingStatus
      const agents = cur.agents.map(a => {
        const e = byId.get(a.id)
        if (!e) return a
        let next: Agent = {
          ...a,
          task: e.task ?? a.task,
          sessionId: e.sessionId ?? a.sessionId,
          project: e.project ?? a.project,
          unread: e.unread ?? a.unread,
        }
        if (e.status && e.state === 'working') {
          if (a.state === 'working') next = { ...next, statusText: e.status }
          else if (a.state !== 'completed') pendingStatus = { ...pendingStatus, [a.id]: { status: e.status, failed: false } }
        }
        return next
      })
      cur = { ...cur, agents, pendingStatus }

      // 3. Agents the server has that we do not: they walk in
      for (const e of entries) {
        if (cur.agents.some(a => a.id === e.id)) continue
        const r = spawnAgent(cur, e, env, true)
        cur = r.state
        effects.push(...r.effects)
      }

      // 4. Sessions (when the snapshot lists them): a Claude per active
      //    hooked session, refreshed from the server's main record; the Claude
      //    of a session the server no longer lists (or now lists as unhooked,
      //    i.e. only the registry knows it) leaves quietly, and one whose
      //    session ended leaves after the grace. Unhooked sessions are pills
      //    only: no Claude is seated for them.
      if (Array.isArray(action.sessions)) {
        const listed = action.sessions.filter((s): s is SessionInfo => !!s && !!s.id && s.hooked !== false)
        const bySid = new Map(listed.map(s => [s.id, s]))
        for (const a of cur.agents) {
          if (!isMainAgent(a) || a.state === 'completed') continue
          const sid = a.sessionId ?? a.id.slice(mainId('').length)
          if (bySid.has(sid)) continue
          cur = completeAgent(cur, a.id, 'clocked out while we were away', env, true).state
        }
        let ended = cur.endedSessions
        for (const s of listed) {
          if (s.state === 'ended') {
            if (!(s.id in ended)) {
              ended = { ...ended, [s.id]: env.now }
              effects.push({ kind: 'schedule', action: { type: 'session_claude_leave', sessionId: s.id }, delayMs: SESSION_CLAUDE_GRACE_MS })
            }
            continue
          }
          if (s.id in ended) ended = without(ended, s.id)
          cur = { ...cur, endedSessions: ended }
          const r = ensureClaude(cur, s.id, { project: s.project, cwd: s.cwd, model: s.model, main: s.main }, env)
          cur = r.state
          effects.push(...r.effects)
          if (!r.created) {
            const id = mainId(s.id)
            if (s.main) cur = applyMain(cur, id, fromServerMain(s.main), env)
            cur = { ...cur, agents: cur.agents.map(a => (a.id === id ? { ...a, project: s.project ?? a.project, model: s.model ?? a.model } : a)) }
          }
        }
        cur = { ...cur, endedSessions: ended }
      }
      return { state: cur, effects }
    }

    // ── MCP call started / finished ────────────────────────────────────────
    case 'mcp_call': {
      const id = action.agentId ?? action.agent?.id
      if (!id) return none
      const agent = state.agents.find(a => a.id === id)
      if (!agent) return none
      const server = action.server ?? ''
      const tool = action.tool ?? ''
      return {
        state: { ...state, agents: state.agents.map(a => (a.id === id ? { ...a, statusText: `${server}.${tool}` } : a)) },
        effects: [{ kind: 'msg', sender: agent.name, role: agent.role, color: cfgFor(agent.role).color, text: `🔌 ${server} → ${tool}` }],
      }
    }

    case 'mcp_done': {
      const id = action.agentId ?? action.agent?.id
      if (!id) return none
      return { state: { ...state, agents: state.agents.map(a => (a.id === id ? { ...a, statusText: action.result ?? 'done' } : a)) }, effects: [] }
    }

    // ── Chat plumbing: typing indicator, reactions, read receipt, inbox ────
    case 'chat_typing':
      return { state, effects: [{ kind: 'typing', sender: action.sender ?? '' }] }

    case 'chat_reaction': {
      const { messageId, reactions } = action
      if (!messageId || !reactions) return none
      return { state, effects: [{ kind: 'reaction', messageId, reactions }] }
    }

    case 'chat_seen':
      return { state, effects: [{ kind: 'seen', messageId: action.messageId ?? null }] }

    case 'inbox_update': {
      if (!action.agentId) return none
      return { state: { ...state, agents: state.agents.map(a => (a.id === action.agentId ? { ...a, unread: action.unread ?? 0 } : a)) }, effects: [] }
    }

    // ── Chat message from the server ───────────────────────────────────────
    case 'chat_message': {
      const sender = action.sender ?? 'Agent'
      const text = action.text ?? ''
      const ts = action.timestamp
      // A real message clears the typing indicator
      const effects: OfficeEffect[] = [{ kind: 'typing', sender: null }]

      // The boss's own messages were posted locally by onSendMessage; the
      // server's echo only tells us the row id (C34)
      const bossCfg = cfgFor(BOSS_ROLE)
      if (sender.toLowerCase() === bossCfg.title.toLowerCase()) {
        if (typeof action.id === 'number') effects.push({ kind: 'adoptMsgId', id: action.id, text })
        return { state, effects }
      }

      // Deduplicate by timestamp+text (the same row can reach us twice)
      const dedupKey = `${ts ?? 0}:${text}`
      if (state.recentChatKeys.includes(dedupKey)) return { state, effects }
      const base: OfficeState = { ...state, recentChatKeys: [...state.recentChatKeys, dedupKey].slice(-50) }

      // Server-side slash command replies (/status, /incident, ...) are system cards
      if (action.isSystem) {
        effects.push({ kind: 'msg', sender: 'system', role: 'default', color: SYSTEM_COLOR, text, isSystem: true, id: action.id })
        return { state: base, effects }
      }

      let msgSender: string, msgRole: string, msgColor: string
      const role = action.role
      if (sender.toLowerCase() === 'claude') {
        // From the AI watcher/bridge: always Claude
        const c = cfgFor(CLAUDE_ROLE)
        msgSender = c.title; msgRole = CLAUDE_ROLE; msgColor = c.color
      } else if (role && AGENT_CONFIGS[role]) {
        const c = AGENT_CONFIGS[role]
        msgSender = c.title; msgRole = role; msgColor = c.color
      } else {
        // Attribute to a working agent or fall back to Claude
        const workers = state.agents.filter(a => a.id !== BOSS_ID && a.role !== CLAUDE_ROLE && a.state === 'working')
        if (workers.length > 0) {
          const w = pickOne(workers, env.random)
          msgSender = w.name; msgRole = w.role; msgColor = cfgFor(w.role).color
        } else {
          const c = cfgFor(CLAUDE_ROLE)
          msgSender = c.title; msgRole = CLAUDE_ROLE; msgColor = c.color
        }
      }

      const recipient = action.recipient
      if (!recipient) {
        effects.push({ kind: 'msg', sender: msgSender, role: msgRole, color: msgColor, text, id: action.id })
        return { state: base, effects }
      }

      // Directed agent-to-agent message: show who it is for, and walk the
      // sender over to the recipient's desk for a quick chat
      const fromAgent = findOfficeAgent(state.agents, action.senderId, sender)
      const toAgent = findOfficeAgent(state.agents, action.recipientId, recipient)
      if (fromAgent) {
        msgSender = fromAgent.name; msgRole = fromAgent.role; msgColor = cfgFor(fromAgent.role).color
      }
      const icon = A2A_ICONS[action.msg_type ?? 'message'] ?? A2A_ICONS.message
      effects.push({ kind: 'msg', sender: msgSender, role: msgRole, color: msgColor, text: `${icon} → @${toAgent?.name ?? recipient}: ${text}`, id: action.id })

      // Only a seated sender gets up; one walking in, out or waiting stays on course
      if (!fromAgent || !toAgent || fromAgent.id === toAgent.id || fromAgent.id === BOSS_ID || fromAgent.state !== 'working') {
        return { state: base, effects }
      }
      const visitSpot = { x: toAgent.deskPosition.x + 4, y: toAgent.deskPosition.y + 2 }
      effects.push({ kind: 'schedule', action: { type: 'a2a_visit_over', agentId: fromAgent.id }, delayMs: A2A_VISIT_MS })
      return {
        state: { ...base, agents: base.agents.map(a => (a.id === fromAgent.id ? walkTo(a, visitSpot, `talking to ${toAgent.name}`, env) : a)) },
        effects,
      }
    }

    // ── The visitor's chat is over: back to their own desk ─────────────────
    case 'a2a_visit_over': {
      const agent = state.agents.find(a => a.id === action.agentId)
      if (!agent || agent.state !== 'walking-to-desk') return none
      return { state: { ...state, agents: state.agents.map(a => (a.id === agent.id ? walkTo(a, a.deskPosition, 'back to work', env) : a)) }, effects: [] }
    }

    // ── Session lifecycle: a Claude per terminal ───────────────────────────
    case 'session_started': {
      const sid = action.sessionId
      if (!sid) return none
      // Known only from Claude Code's session registry (no hook has reported):
      // a pill in the strip, no Claude in the office. Its first hook event
      // flips it to hooked and the server sends this again with hooked: true.
      if (action.hooked === false) return none
      const base = sid in state.endedSessions ? { ...state, endedSessions: without(state.endedSessions, sid) } : state
      const r = ensureClaude(base, sid, { project: action.project, cwd: action.cwd, model: action.model, main: action.main }, env)
      if (r.created) return r
      // Already here (a resume, or compaction's SessionStart): refresh what the server knows
      const id = mainId(sid)
      let cur = r.state
      if (action.main) cur = applyMain(cur, id, fromServerMain(action.main), env)
      const project = action.project ?? projectFromCwd(action.cwd)
      cur = { ...cur, agents: cur.agents.map(a => (a.id === id ? { ...a, project: project ?? a.project, model: action.model ?? a.model } : a)) }
      return { state: cur, effects: r.effects }
    }

    case 'session_ended': {
      const sid = action.sessionId
      if (!sid || sid in state.endedSessions) return none
      let cur: OfficeState = { ...state, endedSessions: { ...state.endedSessions, [sid]: env.now } }
      const effects: OfficeEffect[] = [{ kind: 'schedule', action: { type: 'session_claude_leave', sessionId: sid }, delayMs: SESSION_CLAUDE_GRACE_MS }]
      if (findMain(cur, sid)) cur = applyMain(cur, mainId(sid), { mainState: null, statusText: `👋 session ended${action.reason ? ` (${action.reason})` : ''}` }, env)
      return { state: cur, effects }
    }

    // The session's registry entry changed (server/sessions.js): presence and
    // status for the pill, which reads it from the session list — nothing for
    // the office floor. A hooked session's Claude follows the hooks, and an
    // unhooked session has none.
    case 'session_registry':
      return none

    case 'session_claude_leave': {
      const sid = action.sessionId
      if (!(sid in state.endedSessions)) return none            // resumed within the grace
      const cur: OfficeState = { ...state, endedSessions: without(state.endedSessions, sid) }
      const claude = findMain(cur, sid)
      if (!claude) return { state: cur, effects: [] }
      const r = completeAgent(cur, claude.id, 'clocked out', env, true)
      return { state: r.state, effects: [...r.effects, claudeMsg(cur, claude, '👋 clocked out')] }
    }

    // ── The boss hands a prompt over; Claude starts typing ─────────────────
    case 'session_prompt': {
      const sid = action.sessionId
      if (!sid) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd }, env)
      let cur = ensured.state
      const effects = [...ensured.effects]
      const id = mainId(sid)
      const claude = cur.agents.find(a => a.id === id)
      if (!claude) return none
      const serverState = action.main?.state

      if (action.isWakeup) {
        // A background worker's report woke Claude up: no walk, a small note
        // (the server resolves the subagent id to the office worker when it can)
        const workerId = action.wakeupOfficeId ?? action.wakeupAgentId
        const worker = workerId ? cur.agents.find(a => a.id === workerId) : undefined
        const label = `📬 ${worker?.name ?? 'a background worker'} reported back`
        cur = applyMain(cur, id, { mainState: serverState ?? 'working', statusText: label }, env)
        effects.push(claudeMsg(cur, claude, label))
        return { state: cur, effects }
      }

      const summary = summarise(action.text)
      if (action.text) {
        const boss = cfgFor(BOSS_ROLE)
        effects.push({ kind: 'msg', sender: boss.title, role: BOSS_ROLE, color: boss.color, text: action.text, agentId: BOSS_ID, tag: 'prompt' })
      }
      const handover = bossHandover(cur, claude, summary ?? '📝 new prompt', env)
      cur = handover.state
      effects.push(...handover.effects)
      cur = applyMain(cur, id, { mainState: serverState ?? 'working', statusText: summary ? `✍ ${summary}` : '✍ working on a prompt' }, env)
      effects.push({ kind: 'sfx', sfx: 'typing' })
      return { state: cur, effects }
    }

    case 'handover_over': {
      if (action.seq !== state.handoverSeq) return none
      const boss = state.agents.find(a => a.id === BOSS_ID)
      if (!boss || (boss.state !== 'walking-to-manager' && boss.state !== 'talking-to-manager')) return none
      return { state: { ...state, agents: state.agents.map(a => (a.id === BOSS_ID ? walkTo(a, a.deskPosition, 'back to work', env) : a)) }, effects: [] }
    }

    // ── The turn is over: reply in the chat, then idle or waiting on workers ─
    case 'session_turn_end': {
      const sid = action.sessionId
      if (!sid) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd }, env)
      let cur = ensured.state
      const effects = [...ensured.effects]
      const id = mainId(sid)
      const claude = cur.agents.find(a => a.id === id)
      if (!claude) return none
      if (action.text) effects.push(claudeMsg(cur, claude, action.text, 'reply'))
      const waitingOn = action.main?.waitingOn ?? countRunningTasks(action.backgroundTasks)
      const serverState = action.main?.state
      const next: MainState = serverState === 'waiting' || (serverState === undefined && waitingOn > 0) ? 'waiting' : serverState ?? 'idle'
      cur = next === 'waiting'
        ? applyMain(cur, id, { mainState: 'waiting', waitingOn, statusText: waitingText(waitingOn) }, env)
        : applyMain(cur, id, { mainState: next, statusText: next === 'idle' ? 'turn over — idle' : undefined, since: action.main?.since }, env)
      return { state: cur, effects }
    }

    // ── Claude is waiting on a person ──────────────────────────────────────
    case 'session_needs_you': {
      const sid = action.sessionId
      if (!sid) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd }, env)
      let cur = ensured.state
      const effects = [...ensured.effects]
      const id = mainId(sid)
      const claude = cur.agents.find(a => a.id === id)
      if (!claude) return none
      // The server's record already says it is over: follow it
      if (action.main && action.main.state !== 'needs-you') {
        return { state: applyMain(cur, id, fromServerMain(action.main), env), effects }
      }
      const fromServer = action.main?.needsYou ?? action.needsYou
      const fresh: NeedsYou = {
        kind: action.kind ?? fromServer?.kind ?? 'permission',
        toolName: action.toolName ?? fromServer?.toolName,
        summary: action.summary ?? fromServer?.summary,
        message: action.message ?? fromServer?.message,
        since: fromServer?.since ?? env.now,
      }
      // The same wait again (PermissionRequest, then its Notification): keep the first one, say nothing
      const same = claude.mainState === 'needs-you' && !!claude.needsYou && claude.needsYou.kind === fresh.kind
        && claude.needsYou.toolName === fresh.toolName && claude.needsYou.summary === fresh.summary
      const needsYou = same ? claude.needsYou! : fresh
      const label = needsYouLabel(needsYou)
      cur = applyMain(cur, id, { mainState: 'needs-you', needsYou, statusText: label }, env)
      if (!same) {
        effects.push(claudeMsg(cur, claude, label))
        if (isHardNeedsYou(needsYou)) effects.push({ kind: 'sfx', sfx: 'needsYou' })
      }
      return { state: cur, effects }
    }

    // ── A main-thread tool call went through: a hand raised for it comes down ─
    case 'session_tool_done': {
      const sid = action.sessionId
      if (!sid) return none
      const claude = findMain(state, sid)
      if (!claude) return none
      const id = claude.id
      if (action.main) return { state: applyMain(state, id, fromServerMain(action.main), env), effects: [] }
      const wait = claude.mainState === 'needs-you' ? claude.needsYou : undefined
      const answers = !!wait && wait.kind === 'permission' && (action.batch === true || (!!action.toolName && wait.toolName === action.toolName))
      if (!answers) return none
      const what = action.batch === true ? `tool batch of ${action.count ?? '?'} done` : `${action.toolName} ran`
      const cur = applyMain(state, id, { mainState: 'working', statusText: `⚡ ${what}` }, env)
      return { state: cur, effects: [claudeMsg(cur, claude, `✅ permission answered — ${what}`)] }
    }

    // ── The server changed the record itself (hand lowered by a tool result or the 10-min timeout) ─
    case 'session_main': {
      const sid = action.sessionId
      if (!sid || !action.main) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd, main: action.main }, env)
      if (ensured.created) return ensured
      const id = mainId(sid)
      const before = ensured.state.agents.find(a => a.id === id)
      if (!before) return none
      const cur = applyMain(ensured.state, id, fromServerMain(action.main), env)
      const effects = [...ensured.effects]
      // The hand came down without a prompt or a tool call of ours: say why
      if (before.mainState === 'needs-you' && action.main.state !== 'needs-you') {
        effects.push(claudeMsg(cur, before, `${action.main.state === 'working' ? '✅' : '💤'} ${action.reason ?? 'hand down'}`))
      }
      return { state: cur, effects }
    }

    // ── The API call failed (StopFailure) ──────────────────────────────────
    case 'session_error': {
      const sid = action.sessionId
      if (!sid) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd }, env)
      const id = mainId(sid)
      const claude = ensured.state.agents.find(a => a.id === id)
      if (!claude) return none
      const label = `⚠ API error${action.error ? `: ${action.error}` : ''}`
      const cur = applyMain(ensured.state, id, { mainState: action.main?.state ?? 'error', statusText: label }, env)
      return {
        state: cur,
        effects: [...ensured.effects, claudeMsg(cur, claude, `${label}${action.detail ? ` — ${action.detail}` : ''}`), { kind: 'sfx', sfx: 'error' }],
      }
    }

    // ── Memory wipe: PreCompact sweeps the desk, PostCompact restores the state ─
    case 'session_compact': {
      const sid = action.sessionId
      if (!sid) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd }, env)
      let cur = ensured.state
      const effects = [...ensured.effects]
      const id = mainId(sid)
      const claude = cur.agents.find(a => a.id === id)
      if (!claude) return none
      const meta = cur.meta[id] ?? newMeta(env.now)
      if (action.phase !== 'post') {
        const beforeCompact = claude.mainState === 'compacting' ? meta.beforeCompact : claude.mainState
        cur = applyMain(cur, id, { mainState: 'compacting', statusText: '🧹 memory wipe' }, env)
        cur = { ...cur, meta: { ...cur.meta, [id]: { ...cur.meta[id], beforeCompact } } }
        effects.push(claudeMsg(cur, claude, `🧹 memory wipe${action.trigger ? ` (${action.trigger})` : ''}`))
        return { state: cur, effects }
      }
      // Back to where it was: the server's record when it sends one, else what we remembered
      const back: MainState = action.main?.state ?? meta.beforeCompact ?? 'working'
      cur = action.main
        ? applyMain(cur, id, fromServerMain(action.main), env)
        : applyMain(cur, id, { mainState: back, statusText: restoredStatus(back, claude) }, env)
      cur = { ...cur, meta: { ...cur.meta, [id]: { ...cur.meta[id], beforeCompact: undefined } } }
      return { state: cur, effects }
    }

    // ── `cd` in the terminal: the project tag follows ──────────────────────
    case 'session_cwd': {
      const sid = action.sessionId
      if (!sid) return none
      const project = projectFromCwd(action.cwd) ?? action.project
      if (!project) return none
      const ensured = ensureClaude(state, sid, { project, cwd: action.cwd }, env)
      const cur = ensured.state
      return {
        state: { ...cur, agents: cur.agents.map(a => (a.sessionId === sid && a.state !== 'completed' ? { ...a, project } : a)) },
        effects: ensured.effects,
      }
    }

    // ── /model mid-session: the badge on the pill and Claude's tooltip ─────
    case 'session_model': {
      const sid = action.sessionId
      if (!sid || !action.model) return none
      const ensured = ensureClaude(state, sid, { project: action.project, cwd: action.cwd, model: action.model }, env)
      const id = mainId(sid)
      const cur = ensured.state
      return { state: { ...cur, agents: cur.agents.map(a => (a.id === id ? { ...a, model: action.model } : a)) }, effects: ensured.effects }
    }

    // ── What a Bash command meant: a scene on whoever ran it, a chat line ──
    case 'signal':
      return reduceSignal(state, action, env)

    case 'scene_over': {
      const agent = state.agents.find(a => a.id === action.agentId)
      if (!agent || agent.scene?.until !== action.until) return none
      return { state: { ...state, agents: state.agents.map(a => (a.id === agent.id ? { ...a, scene: undefined } : a)) }, effects: [] }
    }

    // ── Pipeline health: the socket's phase, the server's report ───────────
    case 'connection': {
      const health = reduceConnection(state.health, action.socket, env.now)
      return health === state.health ? none : { state: { ...state, health }, effects: [] }
    }

    case 'health': {
      if (!action.health) return none
      return { state: { ...state, health: { ...state.health, server: action.health, reportedAt: env.now } }, effects: [] }
    }

    default:
      return none
  }
}

// ---------------------------------------------------------------------------
// Animation step
// ---------------------------------------------------------------------------

/**
 * Advance every agent one frame (`dt` in 60 fps frames, usually ~1). Walks
 * along path queues, handles arrival (sitting down, applying a status that
 * arrived mid-walk, opening the filing cabinet), coffee/water breaks, prunes
 * leavers at the door and seats the oldest lobby waiter when a desk frees up.
 */
export function stepOffice(state: OfficeState, dt: number, env: OfficeEnv): StepResult {
  if (state.agents.length === 0) return { state, effects: [], changed: false }

  const now = env.now
  const speed = WALK_SPEED * dt
  const effects: OfficeEffect[] = []
  let changed = false
  let meta = state.meta
  let pendingStatus = state.pendingStatus
  const setMeta = (id: string, patch: Partial<AgentMeta>) => {
    meta = { ...meta, [id]: { ...(meta[id] ?? newMeta(now)), ...patch } }
    changed = true
  }

  const next = state.agents.map(agent => {
    const m = meta[agent.id] ?? newMeta(now)
    if (!meta[agent.id]) meta = { ...meta, [agent.id]: m }

    // Walk toward the first waypoint in the queue, or straight to the
    // final targetPosition once the queue is empty
    const queue = agent.pathQueue ?? []
    const immediateTarget = queue.length > 0 ? queue[0] : agent.targetPosition
    const { position, arrived } = stepToward(agent.position, immediateTarget, speed)
    const moved = position.x !== agent.position.x || position.y !== agent.position.y

    let updated: Agent = agent
    if (arrived) {
      if (queue.length > 0) {
        // More waypoints to go: pop and keep walking
        updated = { ...agent, position, pathQueue: queue.slice(1) }
        changed = true
      } else {
        const isAtDesk = near(agent.targetPosition, agent.deskPosition)
        const isAtDoor = near(agent.targetPosition, DOOR_TARGET)

        if (agent.state === 'new-hire' || agent.state === 'walking-to-desk') {
          if (isAtDesk || agent.state === 'new-hire') {
            setMeta(agent.id, { arrivedAtDeskAt: now, onBreak: false })
            if (agent.assignedSpotId === 'spot-filing') effects.push({ kind: 'furniture', id: 'filing-1', state: 'open' })
            // A status that arrived while they were walking in applies now (C13)
            const pending = pendingStatus[agent.id]
            if (pending) pendingStatus = without(pendingStatus, agent.id)
            // A session's Claude sits down in whatever its main thread is doing and keeps its status line
            const main = isMainAgent(agent)
            updated = {
              ...agent,
              position,
              state: main ? agentStateFor(agent.mainState) : 'working',
              statusText: pending?.status ?? (main ? agent.statusText : workMessage()),
              lastFailed: pending ? pending.failed : agent.lastFailed,
            }
            changed = true
          } else if (moved) {
            updated = { ...agent, position }
            changed = true
          }
        } else if (agent.state === 'walking-to-manager') {
          // The boss has reached Claude's desk: say the line (SpeechBubble), then handover_over sends him back
          updated = { ...agent, position, state: 'talking-to-manager' }
          effects.push({ kind: 'schedule', action: { type: 'handover_over', seq: state.handoverSeq }, delayMs: HANDOVER_DWELL_MS })
          changed = true
        } else if (agent.state === 'completed' && isAtDoor) {
          if (moved) { updated = { ...agent, position }; changed = true }
        } else if (agent.state === 'coffee-break') {
          if (!m.onBreak) {
            setMeta(agent.id, { onBreak: true, breakStartedAt: now })
            if (COFFEE_SPOT !== null && agent.id !== BOSS_ID && Math.abs(position.x - COFFEE_SPOT.x) < 3 && Math.abs(position.y - COFFEE_SPOT.y) < 3) {
              effects.push({ kind: 'furniture', id: 'coffee', state: 'on' })
            }
            if (FILING_SPOT !== null && Math.abs(position.x - FILING_SPOT.x) < 3 && Math.abs(position.y - FILING_SPOT.y) < 3) {
              effects.push({ kind: 'furniture', id: 'filing-1', state: 'open' })
            }
            updated = { ...agent, position }
          } else if (now - (m.breakStartedAt ?? now) >= BREAK_DURATION) {
            setMeta(agent.id, { onBreak: false, breakStartedAt: null, arrivedAtDeskAt: now })
            effects.push({ kind: 'furniture', id: 'coffee', state: 'off' }, { kind: 'furniture', id: 'filing-1', state: 'closed' })
            updated = walkTo({ ...agent, position }, agent.deskPosition, workMessage(), env)
            changed = true
          }
        } else if (moved) {
          // Standing at a lobby spot, an event spot, or a visit spot
          updated = { ...agent, position }
          changed = true
        }
      }
    } else if (moved) {
      updated = { ...agent, position }
      changed = true
    }

    // Random coffee / water break for anyone who has sat at their desk a while.
    // A session's Claude never wanders off mid-turn (it dozes at its desk between turns instead).
    const cur = meta[agent.id]
    if (updated.state === 'working' && !isMainAgent(updated) && cur.arrivedAtDeskAt !== null && !cur.onBreak && COFFEE_SPOT !== null) {
      if (now - cur.arrivedAtDeskAt >= BREAK_MIN_DESK_TIME && env.random() < BREAK_CHANCE_PER_SEC * (dt / 60)) {
        const useWater = env.random() < 0.35 && WATER_SPOTS.length > 0
        const breakSpot = useWater ? pickOne(WATER_SPOTS, env.random) : COFFEE_SPOT
        setMeta(agent.id, { onBreak: false, arrivedAtDeskAt: null })
        const isBoss = updated.id === BOSS_ID
        const breakMsg = useWater ? waterMessage() : (isBoss ? 'grabbing a Red Bull' : coffeeMessage())
        const breakIcon = isBoss ? '🥫' : (useWater ? '💧' : '☕')
        effects.push(
          { kind: 'msg', sender: updated.name, role: updated.role, color: cfgFor(updated.role).color, text: `${breakIcon} ${breakMsg}` },
          { kind: 'sfx', sfx: 'coffee' },
        )
        const breakTarget = { x: breakSpot.x, y: breakSpot.y }
        updated = {
          ...updated,
          state: 'coffee-break',
          targetPosition: breakTarget,
          statusText: breakMsg,
          pathQueue: env.computePath(updated.position, breakTarget),
        }
        changed = true
      }
    }

    return updated
  })

  // Prune leavers at the door (never the permanent staff)
  const kept: Agent[] = []
  const removed: Agent[] = []
  for (const a of next) {
    const gone = a.state === 'completed' && a.id !== BOSS_ID && a.id !== CLAUDE_ID && near(a.position, DOOR_TARGET, ARRIVAL_THRESHOLD * 2)
    if (gone) removed.push(a)
    else kept.push(a)
  }
  let lobby = state.lobby
  for (const a of removed) {
    changed = true
    meta = without(meta, a.id)
    pendingStatus = without(pendingStatus, a.id)
    lobby = lobby.filter(id => id !== a.id)
    if (a.role !== BOSS_ROLE && a.role !== CLAUDE_ROLE && !kept.some(o => o.role === a.role)) {
      effects.push({ kind: 'releaseRole', role: a.role })
    }
  }

  // Seat lobby waiters, oldest first, while desks are free (C29)
  while (lobby.length > 0) {
    const waiterId = lobby[0]
    const idx = kept.findIndex(a => a.id === waiterId)
    if (idx < 0 || kept[idx].state !== 'waiting') { lobby = lobby.slice(1); changed = true; continue }
    const spot = pickSpot(kept, kept[idx].role)
    if (!spot) break
    const desk = { x: spot.x, y: spot.y }
    kept[idx] = {
      ...kept[idx],
      state: 'walking-to-desk',
      assignedSpotId: spot.id,
      deskPosition: desk,
      targetPosition: desk,
      spriteFacing: spot.spriteFacing,
      statusText: 'found a desk',
      pathQueue: env.computePath(kept[idx].position, desk),
    }
    lobby = lobby.slice(1)
    changed = true
  }

  if (!changed) return { state, effects, changed: false }
  return { state: { ...state, agents: kept, lobby, pendingStatus, meta }, effects, changed: true }
}

// ---------------------------------------------------------------------------
// Random office events (fire drill, pizza, …)
// ---------------------------------------------------------------------------

/**
 * Who joins an all-move event. Only seated agents ever get up (one walking
 * out, on a break or waiting in the lobby keeps doing that), and in live mode
 * the real workers stay at their desks — a subagent mid-task does not go to a
 * fire drill (C32). The boss and the ?sim Claude are decorative and always
 * join; a session's Claude joins only between turns (idle, waiting, or not
 * heard from yet) — one mid-turn, with a hand up or wiping its memory stays.
 */
export function moveAgentsForEvent(agents: Agent[], target: Position, statusText: string, env: OfficeEnv): { agents: Agent[]; movedIds: string[] } {
  const movedIds: string[] = []
  const next = agents.map(a => {
    const seated = a.state === 'working' || a.state === 'idle'
    const decorative = a.id === BOSS_ID || a.id === CLAUDE_ID || (isMainAgent(a) && isFreeMain(a))
    if (!seated || (env.live && !decorative)) return a
    movedIds.push(a.id)
    return walkTo(a, target, statusText, env)
  })
  return { agents: next, movedIds }
}

/** After an event: those who went (and were not sent elsewhere since) walk back to their desks */
export function returnAgentsFromEvent(agents: Agent[], movedIds: string[], env: OfficeEnv): Agent[] {
  const moved = new Set(movedIds)
  return agents.map(a => (moved.has(a.id) && a.state === 'walking-to-desk' ? walkTo(a, a.deskPosition, 'back to work', env) : a))
}

/** The one agent a single-agent event (printer jam) sends somewhere: never the boss, never a live worker or a Claude mid-turn */
export function pickSingleEventAgent(agents: Agent[], env: OfficeEnv): Agent | null {
  const candidates = agents.filter(a =>
    a.id !== BOSS_ID && (a.state === 'working' || a.state === 'idle') && (!env.live || a.id === CLAUDE_ID || (isMainAgent(a) && isFreeMain(a))))
  return candidates.length > 0 ? pickOne(candidates, env.random) : null
}
