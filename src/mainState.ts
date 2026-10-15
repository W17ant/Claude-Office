/**
 * mainState.ts — pure helpers for a session's main-thread state (what the
 * session's own Claude is doing), shared by the reducer, the Character
 * badges and the session pill. No React, no DOM, no clock.
 *
 * The states are the server's `main.state` values: working (a turn is
 * running), waiting (the turn ended but background workers are still out),
 * idle (turn over, nothing pending — Claude dozes off after 30 s), needs-you
 * (a permission dialog, an idle prompt, a quota pause or a worker asking for
 * input), error (StopFailure) and compacting (PreCompact → PostCompact).
 */

import type { Agent, AgentState, MainState, NeedsYou, NeedsYouKind, SessionInfo } from './types'

/** Agents whose id starts with this are a session's Claude (`main-<sessionId>`) */
export const MAIN_ID_PREFIX = 'main-'

export function mainId(sessionId: string): string {
  return `${MAIN_ID_PREFIX}${sessionId}`
}

export function isMainAgent(a: Pick<Agent, 'id'>): boolean {
  return a.id.startsWith(MAIN_ID_PREFIX)
}

/**
 * Kinds that need a person at the keyboard right now — `registry` included:
 * Claude Code marks an unhooked session "waiting" exactly while a dialog or a
 * question is on its screen (an amber pill; no Claude is seated for it, so no
 * chime and no title-bar hand either way). The other two are soft: `idle` is
 * Claude Code nudging an absent user, `quota` is a usage pause nobody can
 * shorten — no chime and no title-bar hand for those.
 */
export const HARD_NEEDS_YOU: ReadonlySet<NeedsYouKind> = new Set<NeedsYouKind>(['permission', 'agent-input', 'registry'])

export function isHardNeedsYou(needsYou: NeedsYou | undefined): boolean {
  return !!needsYou && HARD_NEEDS_YOU.has(needsYou.kind)
}

/** The badge drawn over Claude's head for a needs-you kind */
export function needsYouBadge(kind: NeedsYouKind): string {
  switch (kind) {
    case 'permission':  return '✋'
    case 'agent-input': return '✋'
    case 'idle':        return '💤'
    case 'quota':       return '⏳'
    case 'registry':    return '✋'
  }
}

/** The short label on the session pill and under the sprite */
export function needsYouShort(kind: NeedsYouKind): string {
  switch (kind) {
    case 'permission':  return 'needs you'
    case 'agent-input': return 'needs input'
    case 'idle':        return 'idle prompt'
    case 'quota':       return 'waiting for tokens'
    case 'registry':    return 'waiting in the terminal'
  }
}

/** Claude's status line (and chat line) for a needs-you event: only what the event says */
export function needsYouLabel(needsYou: NeedsYou): string {
  const { kind, toolName, summary, message } = needsYou
  switch (kind) {
    case 'permission': {
      const what = [toolName, summary].filter(Boolean).join(' · ')
      return `✋ needs you${what ? `: ${what}` : ' — permission'}`
    }
    case 'agent-input':
      return `✋ needs input${summary ? `: ${summary}` : message ? `: ${message}` : ''}`
    case 'idle':
      return '💤 idle prompt'
    case 'quota':
      return '⏳ waiting for tokens'
    case 'registry':
      return `✋ ${summary ?? 'waiting in the terminal'}`
  }
}

/** The sprite state a seated Claude rests in for a main state */
export function agentStateFor(mainState: MainState | undefined): Extract<AgentState, 'working' | 'idle'> {
  return mainState === 'working' || mainState === 'compacting' ? 'working' : 'idle'
}

/** A Claude that may get up for a fire drill or a printer jam: nothing is running on its main thread */
export function isFreeMain(a: Pick<Agent, 'mainState'>): boolean {
  return a.mainState === undefined || a.mainState === 'idle' || a.mainState === 'waiting'
}

export type PillTone = 'busy' | 'waiting' | 'idle' | 'needs-you' | 'soft' | 'error' | 'compacting' | 'ended'

/** Colour family of the session pill / dot for a main state */
export function mainTone(mainState: MainState | undefined, needsYou?: NeedsYou): PillTone {
  switch (mainState) {
    case 'working':    return 'busy'
    case 'waiting':    return 'waiting'
    case 'needs-you':  return isHardNeedsYou(needsYou) ? 'needs-you' : 'soft'
    case 'error':      return 'error'
    case 'compacting': return 'compacting'
    default:           return 'idle'
  }
}

/** What the pill says next to the dot, if anything */
export function mainPillText(mainState: MainState | undefined, needsYou?: NeedsYou, waitingOn?: number): string | null {
  switch (mainState) {
    case 'needs-you':  return needsYou ? `${needsYouBadge(needsYou.kind)} ${needsYouShort(needsYou.kind)}` : '✋ needs you'
    case 'waiting':    return `⏳ ${waitingOn ?? 0}`
    case 'error':      return '⚠ error'
    case 'compacting': return '🧹 wipe'
    default:           return null
  }
}

/**
 * The status strip's session counts ("3 sessions · 1 not hooked · 2 need
 * you"), from the sessions the page holds. Ended sessions linger on the
 * title bar for a minute but are not counted. Not hooked: known only from
 * Claude Code's session registry (the dashed pills). Need you: a hard
 * needs-you, the amber pills; an idle prompt or a quota pause raises no hand
 * and is not counted. An unhooked session the registry marks "waiting" is
 * both. The lists feed the strip's tooltip; a zero count has no text.
 */
export interface StripCounts {
  sessions: number
  notHooked: SessionInfo[]
  needYou: SessionInfo[]
  sessionsText: string
  notHookedText: string | null
  needYouText: string | null
}

export function stripCounts(sessions: SessionInfo[]): StripCounts {
  const live = sessions.filter(s => s.state !== 'ended')
  const notHooked = live.filter(s => s.hooked === false)
  const needYou = live.filter(s => s.main?.state === 'needs-you' && isHardNeedsYou(s.main.needsYou))
  return {
    sessions: live.length,
    notHooked,
    needYou,
    sessionsText: `${live.length} session${live.length === 1 ? '' : 's'}`,
    notHookedText: notHooked.length > 0 ? `${notHooked.length} not hooked` : null,
    needYouText: needYou.length > 0 ? `${needYou.length} need${needYou.length === 1 ? 's' : ''} you` : null,
  }
}

/**
 * Model badge: "claude-sonnet-4-5-20250929" → "sonnet-4-5", "claude-opus-4-1" → "opus-4-1";
 * a display name ("Sonnet 4.5") is kept as is.
 */
export function shortModel(model: string | undefined | null): string | null {
  if (!model) return null
  let m = model.trim()
  if (!m) return null
  m = m.replace(/^claude-/i, '').replace(/-\d{8}$/, '')
  return m.length > 18 ? `${m.slice(0, 17)}…` : m
}

/** 42 000 → "42k", 4 200 → "4.2k", 950 → "950", 1 200 000 → "1.2M" */
export function formatTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
}

/** 192 000 ms → "3m12s", 45 000 → "45s", 3 900 000 → "1h05m" */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** "✅ done · 42k tok · 3m12s" — the stats part is empty when the event carried none */
export function completionStats(tokens: number | undefined, durationMs: number | undefined): string[] {
  const parts: string[] = []
  if (typeof tokens === 'number' && Number.isFinite(tokens)) parts.push(`${formatTokensShort(tokens)} tok`)
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) parts.push(formatElapsed(durationMs))
  return parts
}

/** First line of a prompt, cut for a speech bubble or status line */
export function summarise(text: string | undefined, max = 60): string | undefined {
  if (!text) return undefined
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return undefined
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Last path segment of a cwd ("/Users/me/src/office/" → "office") */
export function projectFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const seg = trimmed.split(/[\\/]/).pop()
  return seg || trimmed || undefined
}

/** A background task that is still out (anything the hook has not marked finished) */
const FINISHED_TASK = /^(completed|complete|done|finished|failed|error|killed|cancelled|canceled|stopped)$/i

export function countRunningTasks(tasks: Array<{ status?: string }> | undefined): number {
  if (!Array.isArray(tasks)) return 0
  return tasks.filter(t => !FINISHED_TASK.test(t?.status ?? '')).length
}
