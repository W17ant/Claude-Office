/**
 * meters.ts — "Payroll, electricity and memory": the live cost, token-burn
 * and context-window meters fed by the Claude Code status line through the
 * server (server/status.js: POST /status → session_status / agent_status
 * broadcasts, plus `statuses` in the WS snapshot). A session with hooks but
 * no status line arrives the same way with `source: 'transcript'`: MEMORY
 * estimated from its transcript, nothing else (see the estimate helpers).
 *
 * A tiny external store in the theme.ts / incident.ts style — module state,
 * listeners, useSyncExternalStore — so App.tsx only forwards the two event
 * types and the Meters panel subscribes on its own. `reduceMeters` is pure
 * and unit-tested in plain Node.
 */

import { useSyncExternalStore } from 'react'
import type { OfficeEvent } from './types'

export interface ContextStatus {
  /** Percent of the context window in use (null early in a session) */
  used: number | null
  /** Context window size in tokens (200k, or 1M for extended-context models) */
  size: number | null
  /** Tokens in the window after the last API response (input + cache) */
  input: number
  /** Output tokens of the last API response */
  output: number
}

export interface RateLimitStatus {
  fiveHour?: number
  sevenDay?: number
  spendLimit?: number
  fiveHourResetsAt?: number
  sevenDayResetsAt?: number
  spendLimitResetsAt?: number
}

export interface BurnRate {
  dollarsPerMin: number
  tokensPerMin: number
}

/** One subagent row of the subagentStatusLine feed */
export interface AgentStatus {
  id: string
  tokens: number
  contextSize?: number
  status?: string
  agentType?: string
  name?: string
  model?: string
  description?: string
}

/**
 * Where a session's numbers come from: Claude Code's status line, or — for a
 * session that runs none (the plugin install, `claude -p`) — its transcript,
 * which gives MEMORY only (server/meterEstimate.js)
 */
export type MeterSource = 'statusline' | 'transcript'

/** How a transcript estimate was made (server/meterEstimate.js estimateMemory) */
export interface MemoryEstimate {
  /** input + cache + output tokens of the last reply; null right after a compaction */
  tokens: number | null
  /**
   * Where the window size came from: the model table, a [1m] tag on the model,
   * an unknown model (200k assumed) or more tokens than 200k (1M assumed)
   */
  basis: 'model' | '1m-tag' | 'unknown' | 'overflow'
  /** The window size is a guess (basis unknown / overflow) */
  approximate: boolean
  /** A compaction emptied the window and the next reply is not in yet */
  compacted?: boolean
}

/** Mirrors server/status.js's public session record */
export interface SessionStatus {
  sessionId: string
  /** Absent on a stub only the subagent status line has filled */
  source?: MeterSource
  /** Set when source is 'transcript' */
  estimate?: MemoryEstimate
  project?: string
  model?: string
  modelId?: string
  cost: number
  durationMs: number
  apiDurationMs?: number
  linesAdded: number
  linesRemoved: number
  context: ContextStatus
  rateLimits?: RateLimitStatus
  effort?: string | null
  exceeds200k?: boolean
  version?: string | null
  burn: BurnRate
  agents?: AgentStatus[]
  firstSeenAt?: number
  updatedAt?: number
}

export interface MeterTotals {
  costToday: number
  tokensPerMin: number
  dollarsPerMin: number
}

export interface MetersState {
  /** Most recently updated first */
  sessions: SessionStatus[]
  totals: MeterTotals | null
}

export type Tone = 'ok' | 'warn' | 'danger'

/** Context above this posts "Claude's desk is getting cluttered" once per session */
export const CLUTTER_THRESHOLD = 85

const EMPTY: MetersState = { sessions: [], totals: null }

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let state: MetersState = EMPTY
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function getMeters(): MetersState {
  return state
}

export function resetMeters() {
  state = EMPTY
  emit()
}

export function subscribeMeters(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useMeters(): MetersState {
  return useSyncExternalStore(subscribeMeters, getMeters, getMeters)
}

/** Forward a session_status / agent_status event from the socket. */
export function dispatchMeters(event: OfficeEvent) {
  const next = reduceMeters(state, event)
  if (next !== state) {
    state = next
    emit()
  }
}

// ---------------------------------------------------------------------------
// Reducer (pure)
// ---------------------------------------------------------------------------

function byRecency(a: SessionStatus, b: SessionStatus) {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

function totalsOf(sessions: SessionStatus[]): MeterTotals {
  return sessions.reduce(
    (acc, s) => ({
      costToday: acc.costToday + (s.cost ?? 0),
      tokensPerMin: acc.tokensPerMin + (s.burn?.tokensPerMin ?? 0),
      dollarsPerMin: acc.dollarsPerMin + (s.burn?.dollarsPerMin ?? 0),
    }),
    { costToday: 0, tokensPerMin: 0, dollarsPerMin: 0 },
  )
}

export function reduceMeters(prev: MetersState, event: OfficeEvent): MetersState {
  switch (event.type) {
    case 'session_status': {
      // Snapshot form: the server's whole store replaces ours (a reconnect
      // after a server restart must not keep rows the server forgot)
      if (event.statuses) {
        const sessions = event.statuses.filter(s => s?.sessionId).slice().sort(byRecency)
        return { sessions, totals: event.totals ?? totalsOf(sessions) }
      }
      if (!event.sessionId) return prev
      if (event.removed) {
        if (!prev.sessions.some(s => s.sessionId === event.sessionId)) return prev
        const sessions = prev.sessions.filter(s => s.sessionId !== event.sessionId)
        return { sessions, totals: event.totals ?? totalsOf(sessions) }
      }
      if (!event.session) return prev
      const existing = prev.sessions.find(s => s.sessionId === event.sessionId)
      const next: SessionStatus = {
        ...event.session,
        sessionId: event.sessionId,
        // Subagent rows arrive on their own event; keep them across session updates
        agents: event.session.agents?.length ? event.session.agents : existing?.agents,
      }
      const sessions = [...prev.sessions.filter(s => s.sessionId !== event.sessionId), next].sort(byRecency)
      return { sessions, totals: event.totals ?? totalsOf(sessions) }
    }
    case 'agent_status': {
      if (!event.sessionId || !event.agents) return prev
      const existing = prev.sessions.find(s => s.sessionId === event.sessionId)
      if (!existing) return prev
      const sessions = prev.sessions.map(s => (s.sessionId === event.sessionId ? { ...s, agents: event.agents } : s))
      return { ...prev, sessions }
    }
    default:
      return prev
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Amber above 70 %, red above 90 % */
export function contextTone(used: number | null | undefined): Tone {
  if (used == null) return 'ok'
  if (used > 90) return 'danger'
  if (used > 70) return 'warn'
  return 'ok'
}

/** Rate-limit windows use the same thresholds */
export const rateTone = contextTone

export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.1) return `$${usd.toFixed(3)}`
  if (usd < 1000) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/** Exact token count with thousands separators (tooltips) */
export function formatTokensExact(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return `${Math.round(ms / 1000)}s`
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h ${min % 60}m`
}

export function formatClockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 0-100 fill for the electricity gauge: log scale, 1M tokens/min is full */
export function electricityLevel(tokensPerMin: number): number {
  if (!Number.isFinite(tokensPerMin) || tokensPerMin <= 0) return 0
  return Math.max(0, Math.min(100, (Math.log10(1 + tokensPerMin) / 6) * 100))
}

/** Seconds per stripe cycle on the gauge: busier is faster (3 s idle → 0.4 s) */
export function electricityPeriod(tokensPerMin: number): number {
  if (!Number.isFinite(tokensPerMin) || tokensPerMin <= 0) return 3
  return Math.max(0.4, 3 - Math.log10(1 + tokensPerMin) / 2)
}

export function sessionLabel(s: SessionStatus): string {
  return s.project || s.sessionId.slice(0, 8)
}

export function modelLabel(s: SessionStatus): string {
  return s.model || s.modelId || '?'
}

// ---------------------------------------------------------------------------
// Transcript estimates (a session without the status line)
// ---------------------------------------------------------------------------

/**
 * What registers the status line — the only source of PAYROLL and
 * ELECTRICITY. The status line alone: these sessions are plugin installs or
 * claude -p runs whose hooks already report, and the full installer next to
 * the plugin would deliver every event twice.
 */
export const STATUS_LINE_INSTALL = 'npm run install-status-line'

/** MEMORY estimated from the transcript: no status line reports for this session */
export function isEstimated(s: SessionStatus): boolean {
  return s.source === 'transcript'
}

/** The small marker drawn beside an estimated MEMORY reading; '' for status-line numbers */
export function estimateMarker(s: SessionStatus): string {
  return isEstimated(s) ? 'est.' : ''
}

/** A MEMORY reading as shown: '44%', '≈44%' when the window size is a guess, '–' when unknown */
export function formatMemory(s: SessionStatus): string {
  const used = s.context.used
  if (used == null) return '–'
  return `${isEstimated(s) && s.estimate?.approximate ? '≈' : ''}${Math.round(used)}%`
}

function windowLine(s: SessionStatus): string {
  const size = s.context.size ? formatTokensExact(s.context.size) : '?'
  const model = s.modelId || s.model || 'an unnamed model'
  switch (s.estimate?.basis) {
    case '1m-tag':   return `window ${size} tokens: the session runs the [1m] variant of ${model}`
    case 'unknown':  return `window ${size} tokens assumed: ${model} is not in the office's model table, so the reading is approximate`
    case 'overflow': return `window ${size} tokens assumed: more than 200,000 are in use, so ${model} must run its 1M variant (approximate)`
    default:         return `window ${size} tokens for ${model} (Claude Code's model table)`
  }
}

/**
 * The tooltip of an estimated session's MEMORY: what it is, where it comes
 * from and why, the window, and what the status line would add.
 */
export function estimateTip(s: SessionStatus): string[] {
  const size = s.context.size
  const tokens = s.estimate?.tokens
  return [
    `MEMORY — ${sessionLabel(s)}: ${formatMemory(s)} of the context window` +
      (tokens != null && size ? ` (${formatTokensExact(tokens)} / ${formatTokensExact(size)} tokens)` : '') + ' · est.',
    s.estimate?.compacted
      ? 'compacted: the window was just emptied; the next reply in the transcript refills the meter'
      : 'estimated from the session transcript (the last reply\'s usage) because no status line is registered for this session',
    windowLine(s),
    `payroll and electricity need the status line: ${STATUS_LINE_INSTALL}`,
  ]
}

/**
 * The tooltip of PAYROLL or ELECTRICITY when a session only has an estimate:
 * the transcript has no cost or rate figures and the office does not make
 * them up, so the meter names the status line and how to get it.
 */
export function needsStatusLineTip(meter: 'PAYROLL' | 'ELECTRICITY', estimated: SessionStatus[]): string[] {
  const what = meter === 'PAYROLL' ? 'cost' : 'tokens per minute'
  return [
    `${meter} needs the status line — Claude Code reports ${what} only to its statusLine command`,
    `no status line is registered for ${estimated.length === 1 ? 'this session' : `these ${estimated.length} sessions`} (a plugin install or claude -p); MEMORY is estimated from the transcript`,
    `register it with: ${STATUS_LINE_INSTALL} (from the Claude-Office checkout)`,
    ...estimated.slice(0, 4).map(s => `${sessionLabel(s)}: needs the status line`),
  ]
}
