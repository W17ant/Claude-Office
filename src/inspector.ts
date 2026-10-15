/**
 * inspector.ts — the agent inspector card's pure side: the shape of
 * GET /agents/:id, the labels the card prints, the fallback built from the
 * office's own record when the server has nothing (?sim, a 404), and the URL
 * it fetches (src/serverUrl.ts knows where the server is). No React, no DOM, no clock — the
 * tests run these in Node. The card itself is src/components/AgentCard.tsx.
 */

import type { Agent, NeedsYou, SessionInfo, SessionMain } from './types'
import { formatElapsed, formatTokensShort, isMainAgent, needsYouLabel, shortModel } from './mainState'
import { officeHttpBase } from './serverUrl'

/** GET /agents/:id on the office server (wherever src/serverUrl.ts says it is) */
export function inspectUrl(agentId: string, base: string = officeHttpBase()): string {
  return `${base}/agents/${encodeURIComponent(agentId)}`
}

/** How often an open card refreshes */
export const INSPECT_POLL_MS = 2000
/** How many history rows the card lists (the server keeps 50) */
export const HISTORY_SHOWN = 10

export type HistoryKind = 'tool' | 'failed' | 'status' | 'completed' | 'message'

export interface HistoryEntry {
  at: number
  kind: HistoryKind
  tool?: string
  text: string
}

export interface TranscriptEntry {
  at: number | null
  kind: 'said' | 'tool'
  text?: string
  tool?: string
  tools?: string[]
  input?: string
}

export interface InspectStats {
  spawnedAt?: number
  since?: number
  lastActivityAt?: number
  completedAt?: number
  tokens?: number
  durationMs?: number
  toolUses?: number
  model?: string
  /** A session's Claude: the last message's usage, i.e. how full its context window is */
  contextTokens?: number
  /** Fields the office worked out itself (transcript usage, its own clock, the calls the hook saw) rather than Claude Code reporting them */
  derived?: Array<'tokens' | 'durationMs' | 'toolUses' | 'model'>
  parent: { id: string; name: string } | null
  unread: number
}

/** The server's GET /agents/:id body (server/index.js inspectAgent / inspectMain) */
export interface Inspection {
  id: string
  kind: 'worker' | 'main'
  name: string
  role: string
  task?: string
  agentType?: string
  background?: boolean
  /** Back from agents.json after a server restart: the history only covers the time since */
  restored?: boolean
  state: string
  status?: string
  lastError?: string
  sessionId?: string
  project?: string
  cwd?: string
  title?: string
  model?: string
  crons?: number
  /** A session's Claude: false while only Claude Code's session registry knows the session */
  hooked?: boolean
  main?: SessionMain
  session?: { id: string; project?: string; title?: string; source?: string; state: string; startedAt?: number; endedAt?: number; reason?: string; agentCount?: number; workingCount?: number }
  unread?: number
  parentId?: string
  subagentId?: string
  history: HistoryEntry[]
  toolCounts: Record<string, number>
  stats: InspectStats
  transcriptAvailable: boolean
  transcriptReason?: string
  transcript?: TranscriptEntry[]
}

/** Where the card's data came from, for its footer */
export type InspectSource = 'server' | 'office' | 'loading'

/** "working", "waiting on 2 workers", "needs you: Bash · npm test", "API error: rate_limit", ... */
export function mainStateLabel(main: SessionMain | undefined, waitingOn?: number, needsYou?: NeedsYou): string {
  const state = main?.state
  switch (state) {
    case 'working':    return 'working'
    case 'waiting': {
      const n = main?.waitingOn ?? waitingOn ?? 0
      return `waiting on ${n} worker${n === 1 ? '' : 's'}`
    }
    case 'idle':       return 'idle'
    case 'needs-you':  return (main?.needsYou ?? needsYou) ? needsYouLabel((main?.needsYou ?? needsYou)!).replace(/^[^\w]*/, '') : 'needs you'
    case 'error':      return `API error${main?.error?.error ? `: ${main.error.error}` : ''}${main?.error?.detail ? ` — ${main.error.detail}` : ''}`
    case 'compacting': return 'compacting'
    default:           return 'not heard from yet'
  }
}

/** A worker's state in words */
export function workerStateLabel(state: string | undefined): string {
  switch (state) {
    case 'new-hire':            return 'arriving'
    case 'walking-to-desk':     return 'walking to the desk'
    case 'walking-to-manager':  return 'walking over'
    case 'talking-to-manager':  return 'talking'
    case 'coffee-break':        return 'on a break'
    case 'waiting':             return 'waiting for a desk'
    case 'changing-room':       return 'changing'
    case 'completed':           return 'finished'
    case 'working':             return 'working'
    case 'idle':                return 'idle'
    default:                    return state ?? 'unknown'
  }
}

/** Tool counts as rows, busiest first, then by name */
export function toolCountRows(counts: Record<string, number> | undefined): Array<{ tool: string; n: number }> {
  return Object.entries(counts ?? {})
    .map(([tool, n]) => ({ tool, n }))
    .sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool))
}

/** The last `n` history rows, newest first */
export function recentHistory(history: HistoryEntry[] | undefined, n = HISTORY_SHOWN): HistoryEntry[] {
  return (history ?? []).slice(-n).reverse()
}

/** A clock time for a history row: "19:05:35" */
export function clockTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--:--'
  const d = new Date(ms)
  const two = (v: number) => String(v).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * How long the character has been at it: a finished worker's reported
 * duration (else spawn to completion), a working one's time since spawn, and
 * for a session's Claude the time in its current main state.
 */
export function atItFor(insp: Inspection, now: number): string | null {
  if (insp.kind === 'main') {
    const since = insp.main?.since ?? insp.stats.since
    return typeof since === 'number' ? formatElapsed(now - since) : null
  }
  const { spawnedAt, completedAt, durationMs } = insp.stats
  if (typeof durationMs === 'number') return formatElapsed(durationMs)
  if (typeof spawnedAt !== 'number') return null
  return formatElapsed((typeof completedAt === 'number' ? completedAt : now) - spawnedAt)
}

/** "4.2k tok · 1m01s · 3 tools · haiku-5-5" for a finished worker; [] while nothing is known */
export function finishedStats(stats: InspectStats): string[] {
  const parts: string[] = []
  if (typeof stats.tokens === 'number') parts.push(`${formatTokensShort(stats.tokens)} tok`)
  if (typeof stats.durationMs === 'number') parts.push(formatElapsed(stats.durationMs))
  if (typeof stats.toolUses === 'number') parts.push(`${stats.toolUses} tool use${stats.toolUses === 1 ? '' : 's'}`)
  const model = shortModel(stats.model)
  if (model) parts.push(model)
  return parts
}

const DERIVED_LABELS: Record<string, string> = {
  tokens: 'tokens and model from its transcript',
  model: 'model from its transcript',
  durationMs: 'duration from spawn to finish',
  toolUses: 'tool uses the hook saw',
}

/** "worked out by the office: tokens and model from its transcript, duration from spawn to finish" — null when Claude Code reported everything */
export function derivedNote(stats: Pick<InspectStats, 'derived'>): string | null {
  const derived = stats.derived ?? []
  if (!derived.length) return null
  // tokens and model come from the same place: one phrase for both
  const keys = derived.includes('tokens') ? derived.filter(k => k !== 'model') : derived
  return `worked out by the office: ${keys.map(k => DERIVED_LABELS[k] ?? k).join(', ')}`
}

/** The marker in front of a history row */
export function historyMark(kind: HistoryKind): string {
  switch (kind) {
    case 'tool':      return '›'
    case 'failed':    return '✗'
    case 'completed': return '✓'
    case 'message':   return '✉'
    case 'status':    return '·'
  }
}

/** What the transcript section says when it lists nothing */
export function transcriptEmptyText(insp: Pick<Inspection, 'transcriptAvailable' | 'transcriptReason' | 'transcript'>): string | null {
  if (!insp.transcriptAvailable) {
    switch (insp.transcriptReason) {
      case 'prompts off':               return 'transcript hidden: prompts off'
      // The page has no UI token until the WebSocket snapshot arrives
      case 'needs the office token':    return 'transcript appears once the office is connected'
      case 'no transcript path yet':    return 'no transcript yet'
      case 'transcript file not found': return 'transcript file not found'
      default:                          return 'transcript unavailable'
    }
  }
  return insp.transcript && insp.transcript.length ? null : 'nothing said yet'
}

/** One transcript entry as a line: "Bash — ls /etc | wc -l" or the text */
export function transcriptLine(e: TranscriptEntry): string {
  if (e.kind === 'tool') {
    const names = e.tools && e.tools.length > 1 ? `${e.tool} +${e.tools.length - 1}` : (e.tool ?? 'tool')
    return `${names}${e.input ? ` — ${e.input}` : ''}${e.text ? `  “${e.text}”` : ''}`
  }
  return e.text ?? ''
}

/**
 * What the office alone knows about a character — ?sim, the boss, or a
 * worker the server no longer has: its reducer fields in the card's shape,
 * with no history and no transcript.
 */
export function fallbackInspection(agent: Agent, sessions: SessionInfo[] = []): Inspection {
  const main = isMainAgent(agent)
  const session = agent.sessionId ? sessions.find(s => s.id === agent.sessionId) : undefined
  return {
    id: agent.id,
    kind: main ? 'main' : 'worker',
    name: agent.name,
    role: agent.role,
    task: agent.task,
    state: main ? (agent.mainState ?? 'idle') : agent.state,
    status: agent.statusText,
    sessionId: agent.sessionId,
    project: agent.project ?? session?.project,
    cwd: session?.cwd,
    title: session?.title,
    model: agent.model ?? session?.model,
    crons: session?.main?.crons,
    main: main ? (session?.main ?? { state: agent.mainState ?? 'idle', waitingOn: agent.waitingOn, needsYou: agent.needsYou }) : undefined,
    unread: agent.unread,
    history: [],
    toolCounts: {},
    stats: { spawnedAt: agent.hiredAt, since: session?.main?.since, parent: null, unread: agent.unread ?? 0 },
    transcriptAvailable: false,
    transcriptReason: 'no transcript path yet',
  }
}

/**
 * The prompt / reply the card shows for a session's Claude: the server's
 * answer carries them once the card sends the UI token; until then the
 * WebSocket-fed session record (which has them at the logPrompts level)
 * fills in. Empty text is '' from the server when logPrompts is off.
 */
export function promptAndReply(insp: Inspection, session: SessionInfo | undefined): { prompt?: string; reply?: string; hidden: boolean } {
  const hidden = insp.transcriptReason === 'prompts off'
  return {
    prompt: insp.main?.lastPrompt || session?.main?.lastPrompt || undefined,
    reply: insp.main?.lastReply || session?.main?.lastReply || undefined,
    hidden,
  }
}

/**
 * Which side of the room the card opens on, from the character's x (percent
 * of the room's width): the card covers roughly the left 40 % of the room, so
 * a character standing there gets the card on the right instead.
 */
export const CARD_COVERS_PCT = 42

export function cardSide(x: number | undefined): 'left' | 'right' {
  return typeof x === 'number' && Number.isFinite(x) && x < CARD_COVERS_PCT ? 'right' : 'left'
}

/** A session id as the card prints it */
export function shortSession(id: string | undefined): string | null {
  return id ? id.slice(0, 8) : null
}
