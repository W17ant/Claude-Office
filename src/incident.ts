/**
 * incident.ts — "Prod Is Down" incident mode.
 *
 * A situational VARIANT of the office, orthogonal to the theme axis in
 * theme.ts: the office switches it on by itself when real failures happen.
 *
 * Two layers live here:
 *   1. A pure state machine (`reduceIncident`) — feed it inputs with
 *      timestamps and it returns the next state plus any transition. No
 *      React, no timers, no storage, so it is unit-testable in plain Node.
 *   2. A tiny store around it (`dispatchIncident`, `useVariant`,
 *      `useIncident`, `subscribeIncidentTransitions`) that mirrors the
 *      theme.ts pattern: module state + listeners + localStorage.
 *
 * Entry: 3 failed tool calls inside 5 min (a failed build or test run
 * counts, under its own name), a real deploy failing (a `deploy_fail`
 * signal: at once), a `deploy-fail` / `who-broke-build` random event (90 s
 * mini-incident), `/incident` in the chat (relayed by the server as a
 * `variant_change` event), or `?variant=incident` (pins it; auto-exit off,
 * for screenshots).
 * Exit: `/all-clear`, 10 min without a new failure, a deploy that went out
 * (`deploy_success` signal), the last red build or test run going green
 * again, or `deploy-success` during a mini-incident. Exit records
 * `agent-office-last-incident`, which the "days since last incident" sign
 * reads in every mode.
 *
 * Signals (src/signals.ts) arrive right after the failed tool call that
 * carried them, which this machine has already counted as a plain failure:
 * the signal names that failure instead of counting the call twice.
 */

import { useSyncExternalStore } from 'react'
import type { SignalEvent, SignalKind } from './types'
import { signalFamily, signalOutcome, signalFailureLabel, isSignalKind } from './signals'

export type VariantName = 'none' | 'incident'

export type IncidentReason =
  | 'failures'   // crossed the failure threshold
  | 'deploy-fail' // a real deploy failed (deploy_fail signal)
  | 'event'      // deploy-fail / who-broke-build random event (mini-incident)
  | 'manual'     // /incident typed in this tab
  | 'remote'     // /incident relayed by the server (another tab, or this one)
  | 'url'        // ?variant=incident
  | 'restored'   // localStorage said we were in an incident when the tab loaded

export type IncidentEndedBy = 'all-clear' | 'timeout' | 'resolved'

export interface IncidentFailure {
  at: number
  /** The tool that failed, or 'deploy' / 'build' / 'test' for a signal */
  tool: string
  agentId?: string
  agentName?: string
  /** The Claude Code session it happened in (pairs a signal with its tool failure) */
  sessionId?: string
  /** A signal's target (the app, package or directory) */
  target?: string
  /** A signal's failure as a sentence: "tests failed in api: 3 failing" */
  label?: string
}

export interface IncidentState {
  variant: VariantName
  startedAt: number | null
  reason: IncidentReason | null
  /** 90 s mini-incident started by a random event (ends on deploy-success). */
  mini: boolean
  /** ?variant=incident — never auto-exits. */
  pinned: boolean
  /** When the incident auto-exits (null while pinned or when idle). */
  expiresAt: number | null
  /** Idle: failures inside the 5 min window. Incident: every failure since it started. */
  failures: IncidentFailure[]
  /**
   * Deploys, builds and test runs whose last run failed, as `family:target`
   * ("test:api"): a green run of one of them clears the window, and the
   * last one going green resolves an open incident.
   */
  red: string[]
}

export interface IncidentSummary {
  id: string
  startedAt: number
  endedAt: number
  durationMs: number
  reason: IncidentReason
  endedBy: IncidentEndedBy
  failureCount: number
  /** tool → number of failures */
  tools: Record<string, number>
  /** Names of agents whose tool calls failed, first seen first. */
  participants: string[]
  lastTool: string | null
  /** The last failure that had a name ("deploy of api failed: Error: 503"), null when none did */
  cause: string | null
}

/** A `signal` event as incident mode reads it (signalIncidentInput) */
export interface IncidentSignal {
  type: 'signal'
  at: number
  kind: SignalKind
  target?: string
  detail?: string
  error?: string
  interrupted?: boolean
  sessionId?: string
  agentId?: string
  agentName?: string
}

export type IncidentInput =
  | { type: 'failure'; at: number; tool: string; agentId?: string; agentName?: string; sessionId?: string }
  | IncidentSignal
  | { type: 'random-event'; at: number; id: string }
  | { type: 'command'; at: number; cmd: 'incident' | 'all-clear'; reason?: 'manual' | 'remote' | 'restored' }
  | { type: 'pin'; at: number }
  | { type: 'tick'; at: number }

export interface IncidentTransition {
  state: IncidentState
  /** Set when this input switched the variant on. */
  entered?: IncidentReason
  /** Set when this input switched the variant off. */
  exited?: IncidentSummary
}

export const INCIDENT_CONFIG = {
  failureThreshold: 3,
  failureWindowMs: 5 * 60_000,
  autoExitMs: 10 * 60_000,
  miniIncidentMs: 90_000,
  /** Random-event ids that start a mini-incident. */
  triggerEvents: ['deploy-fail', 'who-broke-build'],
  /** Random-event ids that end a mini-incident. */
  resolveEvents: ['deploy-success'],
  /** Cap on the failure log kept during one incident. */
  maxFailures: 200,
  /** How far back a signal looks for the plain tool failure of the same call. */
  signalPairMs: 10_000,
  /** Cap on the red runs remembered. */
  maxRed: 20,
} as const

export const VARIANT_STORAGE_KEY = 'agent-office-variant'
export const LAST_INCIDENT_STORAGE_KEY = 'agent-office-last-incident'
const FIRST_SEEN_STORAGE_KEY = 'agent-office-first-seen'

// ---------------------------------------------------------------------------
// Pure state machine
// ---------------------------------------------------------------------------

export function createIncidentState(): IncidentState {
  return { variant: 'none', startedAt: null, reason: null, mini: false, pinned: false, expiresAt: null, failures: [], red: [] }
}

/** Failures that still count toward the threshold at time `at`. */
export function recentFailures(failures: IncidentFailure[], at: number): IncidentFailure[] {
  const cutoff = at - INCIDENT_CONFIG.failureWindowMs
  return failures.filter(f => f.at > cutoff)
}

function begin(state: IncidentState, reason: IncidentReason, at: number, mini: boolean): IncidentTransition {
  const expiresAt = at + (mini ? INCIDENT_CONFIG.miniIncidentMs : INCIDENT_CONFIG.autoExitMs)
  return {
    state: {
      variant: 'incident',
      startedAt: at,
      reason,
      mini,
      pinned: false,
      expiresAt,
      // Failures from the last 5 min are context for this incident
      failures: recentFailures(state.failures, at),
      red: state.red,
    },
    entered: reason,
  }
}

function finish(state: IncidentState, at: number, endedBy: IncidentEndedBy): IncidentTransition {
  const startedAt = state.startedAt ?? at
  const tools: Record<string, number> = {}
  const participants: string[] = []
  for (const f of state.failures) {
    tools[f.tool] = (tools[f.tool] ?? 0) + 1
    if (f.agentName && !participants.includes(f.agentName)) participants.push(f.agentName)
  }
  const last = state.failures[state.failures.length - 1]
  const named = [...state.failures].reverse().find(f => f.label)
  return {
    state: createIncidentState(),
    exited: {
      id: `INC-${startedAt}`,
      startedAt,
      endedAt: at,
      durationMs: Math.max(0, at - startedAt),
      reason: state.reason ?? 'manual',
      endedBy,
      failureCount: state.failures.length,
      tools,
      participants,
      lastTool: last?.tool ?? null,
      cause: named?.label ?? null,
    },
  }
}

/**
 * One more failure: idle, it may cross the threshold; during an incident it
 * joins the log and restarts the quiet-period clock (a mini-incident that
 * crosses the threshold becomes a full one).
 */
function addFailure(state: IncidentState, failures: IncidentFailure[], at: number): IncidentTransition {
  if (state.variant === 'incident') {
    const log = failures.slice(-INCIDENT_CONFIG.maxFailures)
    const crossed = state.mini && recentFailures(log, at).length >= INCIDENT_CONFIG.failureThreshold
    const mini = state.mini && !crossed
    // Every failure in a full incident restarts the 10 min quiet-period clock
    const expiresAt = state.pinned ? null : mini ? state.expiresAt : at + INCIDENT_CONFIG.autoExitMs
    return { state: { ...state, failures: log, mini, expiresAt, reason: crossed ? 'failures' : state.reason } }
  }
  const recent = recentFailures(failures, at)
  if (recent.length >= INCIDENT_CONFIG.failureThreshold) {
    return begin({ ...state, failures: recent }, 'failures', at, false)
  }
  return { state: { ...state, failures: recent } }
}

/**
 * A signal's failure takes the place of the plain tool failure the same
 * call logged a moment earlier (same session and worker, a Bash failure
 * with no name yet), so one failed `npm test` counts once, under its name.
 */
function withSignalFailure(failures: IncidentFailure[], failure: IncidentFailure): IncidentFailure[] {
  for (let i = failures.length - 1; i >= 0; i--) {
    const f = failures[i]
    if (failure.at - f.at > INCIDENT_CONFIG.signalPairMs) break
    if (!f.label && f.tool === 'Bash' && f.sessionId === failure.sessionId && f.agentId === failure.agentId) {
      return [...failures.slice(0, i), ...failures.slice(i + 1), failure]
    }
  }
  return [...failures, failure]
}

/** A deploy, build or test run that ended: what it does to the incident. */
function reduceSignal(state: IncidentState, input: IncidentSignal): IncidentTransition {
  const at = input.at
  const active = state.variant === 'incident'
  const family = signalFamily(input.kind)
  const outcome = signalOutcome(input.kind)
  // A push is not prod, a start has no result yet, and a run stopped with Esc failed nobody
  if (family === 'push' || outcome === 'start' || input.interrupted) return { state }
  const key = `${family}:${input.target ?? ''}`

  if (outcome === 'fail') {
    const failure: IncidentFailure = {
      at, tool: family, agentId: input.agentId, agentName: input.agentName, sessionId: input.sessionId,
      target: input.target, label: signalFailureLabel(input),
    }
    const failures = withSignalFailure(state.failures, failure)
    const red = state.red.includes(key) ? state.red : [...state.red, key].slice(-INCIDENT_CONFIG.maxRed)
    if (family !== 'deploy') return addFailure({ ...state, red }, failures, at)
    // A failed deploy is prod down: the incident opens at once
    if (!active) return begin({ ...state, failures, red }, 'deploy-fail', at, false)
    // Already on fire: it joins the log, and a mini-incident becomes a real one
    return {
      state: {
        ...state,
        failures: failures.slice(-INCIDENT_CONFIG.maxFailures),
        red,
        mini: false,
        reason: state.mini ? 'deploy-fail' : state.reason,
        expiresAt: state.pinned ? null : at + INCIDENT_CONFIG.autoExitMs,
      },
    }
  }

  // A green run
  const wasRed = state.red.includes(key)
  const red = state.red.filter(k => k !== key)
  if (family === 'deploy') {
    // A deploy that went out is the fix: whatever is burning is resolved
    // (a pinned screenshot stays on; only /all-clear ends that)
    if (active) return state.pinned ? { state: { ...state, red: [] } } : finish(state, at, 'resolved')
    return wasRed ? { state: { ...state, red, failures: [] } } : { state }
  }
  if (!wasRed) return { state }
  if (!active) {
    // Red, then green again before it came to an incident: the window starts over
    return { state: { ...state, red, failures: [] } }
  }
  // The last red build or test run is green again: prod is back
  if (red.length === 0 && !state.pinned) return finish(state, at, 'resolved')
  return { state: { ...state, red } }
}

/** A `signal` event as incident mode reads it; null for a kind this page does not know. */
export function signalIncidentInput(s: SignalEvent, at: number, agentName?: string): IncidentSignal | null {
  if (!isSignalKind(s.kind)) return null
  return {
    type: 'signal', at, kind: s.kind,
    target: s.target || s.project || undefined,
    detail: s.detail, error: s.error, interrupted: s.interrupted === true || undefined,
    sessionId: s.sessionId, agentId: s.agentId, agentName: agentName ?? s.agentName,
  }
}

/**
 * Apply one input. Returns the SAME state object when nothing changed, so
 * callers can skip persisting/emitting.
 */
export function reduceIncident(state: IncidentState, input: IncidentInput): IncidentTransition {
  const at = input.at
  const active = state.variant === 'incident'

  switch (input.type) {
    case 'failure': {
      const failure: IncidentFailure = { at, tool: input.tool, agentId: input.agentId, agentName: input.agentName, sessionId: input.sessionId }
      return addFailure(state, [...state.failures, failure], at)
    }

    case 'signal':
      return reduceSignal(state, input)

    case 'random-event': {
      if ((INCIDENT_CONFIG.triggerEvents as readonly string[]).includes(input.id)) {
        if (!active) return begin(state, 'event', at, true)
        // Already on fire: a mini-incident restarts its 90 s clock, a full one shrugs
        if (state.mini && !state.pinned) return { state: { ...state, expiresAt: at + INCIDENT_CONFIG.miniIncidentMs } }
        return { state }
      }
      if ((INCIDENT_CONFIG.resolveEvents as readonly string[]).includes(input.id) && active && state.mini) {
        return finish(state, at, 'resolved')
      }
      return { state }
    }

    case 'command': {
      if (input.cmd === 'incident') {
        return active ? { state } : begin(state, input.reason ?? 'manual', at, false)
      }
      // /all-clear works even when pinned — only the AUTO exit is disabled
      return active ? finish(state, at, 'all-clear') : { state }
    }

    case 'pin': {
      const t = active ? { state } : begin(state, 'url', at, false)
      return { ...t, state: { ...t.state, pinned: true, expiresAt: null } }
    }

    case 'tick': {
      if (!active || state.pinned || state.expiresAt === null) return { state }
      return at >= state.expiresAt ? finish(state, at, 'timeout') : { state }
    }
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure)
// ---------------------------------------------------------------------------

/** "failed: Bash — Exit code 1 ..." → "Bash" (the hook's status format). */
export function failureToolFromStatus(status: string | undefined): string {
  const m = /^failed:\s*([^—]+?)\s*(?:—|$)/.exec(status ?? '')
  const tool = m?.[1]?.trim()
  return tool && tool.length > 0 ? tool : 'tool'
}

/** 0 → "00:00:00" (hh:mm:ss) */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':')
}

/** 252000 → "4m 12s"; 59000 → "59s"; 3660000 → "1h 1m" */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const ROOT_CAUSES_WITHOUT_FAILURES =['a Friday deploy', 'DNS. it is always DNS.', 'a config change nobody remembers', 'a null. always a null.']

/** One-line "postmortem card" for the chat. `bystanders` = agents in the room when nobody's tool failed. */
export function formatPostmortem(summary: IncidentSummary, bystanders: string[] = []): string {
  const parts = [`📋 Postmortem ${summary.id}`, `all clear after ${formatDuration(summary.durationMs)}`]

  if (summary.failureCount === 0) {
    parts.push('no tool failures')
  } else {
    const byTool = Object.entries(summary.tools)
      .sort((a, b) => b[1] - a[1])
      .map(([tool, n]) => `${tool} ×${n}`)
      .join(', ')
    parts.push(`${summary.failureCount} tool failure${summary.failureCount === 1 ? '' : 's'} (${byTool})`)
  }

  const who = summary.participants.length > 0 ? summary.participants : bystanders
  parts.push(who.length > 0 ? `responders: ${who.slice(0, 6).join(', ')}` : 'responders: just the boss and Claude')

  // A named failure (a deploy, build or test signal) beats the bare tool name
  const cause = (summary.cause ? clip(summary.cause, 140) : null)
    ?? summary.lastTool
    ?? ROOT_CAUSES_WITHOUT_FAILURES[summary.startedAt % ROOT_CAUSES_WITHOUT_FAILURES.length]
  parts.push(`root cause: ${cause}`)

  return parts.join(' · ')
}

/**
 * System lines to post in the chat for a transition. The server already
 * posts its own line for /incident and /all-clear, so 'remote' entries are
 * silent here; the postmortem is always posted because it carries the stats.
 */
export function incidentTransitionLines(t: IncidentTransition, agentsInRoom: { name: string; role: string }[] = []): string[] {
  const lines: string[] = []
  if (t.entered) {
    switch (t.entered) {
      case 'failures': {
        const n = recentFailures(t.state.failures, t.state.startedAt ?? Date.now()).length
        const last = t.state.failures[t.state.failures.length - 1]
        lines.push(`🔴 ${n} tool failures in 5 min — INCIDENT MODE ON. Prod is down. Everyone to the war room.${last?.label ? ` Latest: ${clip(last.label, 120)}.` : ''}`)
        break
      }
      case 'deploy-fail': {
        const deploy = [...t.state.failures].reverse().find(f => f.tool === 'deploy')
        lines.push(`🔴 ${deploy?.target ? `The ${deploy.target} deploy` : 'A deploy'} failed — INCIDENT MODE ON. Prod is down. Everyone to the war room.`)
        break
      }
      case 'event':
        lines.push('🚨 Mini-incident declared (90 s) — rollback in progress. Nobody deploys until the graph is flat.')
        break
      case 'manual':
        lines.push('🔴 INCIDENT MODE ON — declared by the boss. Everyone to the war room.')
        break
      case 'url':
        lines.push('🔴 INCIDENT MODE pinned by ?variant=incident — type /all-clear to end it.')
        break
      case 'restored':
        lines.push('🔴 Still in INCIDENT MODE from last time — type /all-clear when prod is back.')
        break
      case 'remote':
        break
    }
  }
  if (t.exited) {
    const bystanders = agentsInRoom
      .filter(a => a.role !== 'boss' && a.role !== 'assistant')
      .map(a => a.name)
    lines.push(formatPostmortem(t.exited, bystanders))
  }
  return lines
}

// ---------------------------------------------------------------------------
// Incident chatter — used by theme.ts (spawn/work/done/coffee/water) and the
// boss reply in App.tsx while the variant is active.
// ---------------------------------------------------------------------------

export const INCIDENT_LINES = {
  spawn: ['paged. on it.', 'joining the bridge, who is IC?', 'clocked in at 02:14, send coffee', 'laptop open before the eyes were'],
  work: ['bisecting between 4f2a1c and main', 'it is not DNS. checking DNS.', 'tailing prod logs, 400 req/s of sadness', 'reading the runbook for the first time', 'adding a feature flag we should have had'],
  done: ['rollback complete, error rate 0.1%', 'root cause: a null. always a null.', 'hotfix merged, tests added after', 'status page back to green'],
  coffee: ['third coffee, do not judge', 'the machine is the only thing working', 'coffee is not a sleep substitute, trying anyway'],
  water: ['water. then more coffee.', 'hydrating like a responsible adult at 2am', 'the water cooler is also degraded'],
  bossReply: ['all clear. nobody deploys on Friday again.', 'postmortem at 10, blameless, bring pizza', 'good catch. write it down for the timeline.', 'I know. I KNOW.'],
} as const

export type IncidentLineKind = keyof typeof INCIDENT_LINES

export function pickIncidentLine(kind: IncidentLineKind): string {
  const pool = INCIDENT_LINES[kind]
  return pool[Math.floor(Math.random() * pool.length)]
}

// ---------------------------------------------------------------------------
// Store — module state + listeners, mirrors theme.ts
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>()
const transitionListeners = new Set<(t: IncidentTransition) => void>()
let tickTimer: ReturnType<typeof setInterval> | null = null
/** In-memory copy of the last incident end, for when localStorage is unavailable. */
let lastEndedAtMem: number | null = null

let state: IncidentState = loadInitial()

function loadInitial(): IncidentState {
  const base = createIncidentState()
  try {
    if (localStorage.getItem(VARIANT_STORAGE_KEY) === 'incident') {
      return reduceIncident(base, { type: 'command', cmd: 'incident', at: Date.now(), reason: 'restored' }).state
    }
  } catch {}
  return base
}

function persist() {
  // A URL-pinned incident is for screenshots — it must not leak into the next plain visit
  if (state.pinned) return
  try { localStorage.setItem(VARIANT_STORAGE_KEY, state.variant) } catch {}
}

function emit() { listeners.forEach(l => l()) }

function syncTicker() {
  const wantTicker = state.variant === 'incident' && !state.pinned && typeof window !== 'undefined'
  if (wantTicker && tickTimer === null) {
    tickTimer = setInterval(() => dispatchIncident({ type: 'tick', at: Date.now() }), 1000)
  } else if (!wantTicker && tickTimer !== null) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

/** Apply an input to the live store; persists, notifies, and runs the auto-exit ticker. */
export function dispatchIncident(input: IncidentInput): IncidentTransition {
  const t = reduceIncident(state, input)
  if (t.state === state) return t
  state = t.state
  if (t.exited) {
    lastEndedAtMem = t.exited.endedAt
    try { localStorage.setItem(LAST_INCIDENT_STORAGE_KEY, String(t.exited.endedAt)) } catch {}
  }
  persist()
  syncTicker()
  emit()
  if (t.entered || t.exited) {
    // A listener that throws (AudioContext, React) must never break the state machine
    transitionListeners.forEach(l => {
      try { l(t) } catch (err) { console.error('[incident] transition listener failed', err) }
    })
  }
  return t
}

export function getIncident(): IncidentState { return state }
export function getVariant(): VariantName { return state.variant }
export function isIncident(): boolean { return state.variant === 'incident' }

/** `?variant=incident` — pin the variant on for screenshots (auto-exit off). */
export function pinIncidentFromUrl() {
  dispatchIncident({ type: 'pin', at: Date.now() })
}

export function subscribeIncident(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Called once per entry/exit, with the transition that caused it. */
export function subscribeIncidentTransitions(fn: (t: IncidentTransition) => void): () => void {
  transitionListeners.add(fn)
  return () => transitionListeners.delete(fn)
}

export function useVariant(): VariantName {
  return useSyncExternalStore(subscribeIncident, () => state.variant, () => 'none')
}

export function useIncident(): IncidentState {
  return useSyncExternalStore(subscribeIncident, () => state, () => state)
}

/**
 * Whole days since the last incident ended. Before any incident is on record
 * the office has been incident-free since it was first opened in this browser.
 */
export function daysSinceLastIncident(now: number = Date.now()): number {
  let since: number | null = lastEndedAtMem
  try {
    const saved = localStorage.getItem(LAST_INCIDENT_STORAGE_KEY)
    if (saved && Number.isFinite(Number(saved))) since = Number(saved)
    if (since === null) {
      const first = localStorage.getItem(FIRST_SEEN_STORAGE_KEY)
      if (first && Number.isFinite(Number(first))) since = Number(first)
      else { localStorage.setItem(FIRST_SEEN_STORAGE_KEY, String(now)); since = now }
    }
  } catch {}
  if (since === null) return 0
  return Math.max(0, Math.floor((now - since) / 86_400_000))
}

/** Test hook: reset the live store (not used by the app). */
export function _resetIncidentStoreForTests() {
  state = createIncidentState()
  lastEndedAtMem = null
  if (tickTimer !== null) { clearInterval(tickTimer); tickTimer = null }
  emit()
}
