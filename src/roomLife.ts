/**
 * roomLife.ts - what the room's props are doing, from what the office is doing.
 *
 * The rules behind RoomLife.tsx (the wall: deploy TV, city windows, water
 * cooler, bell, fire extinguisher) and the coffee machine and printer in
 * FurnitureRenderer, kept pure so they can be tested:
 *   - the deploy TV shows a deploy shipping, then shipped or rolled back,
 *     else a status dashboard
 *   - the printer prints a page when a build, test run or deploy finishes
 *   - the water cooler bubbles while someone is at it or waiting
 *   - the filing cabinet opens while an agent reads or searches files
 */

import type { Agent, SignalKind } from './types'

export type TvMode = 'dashboard' | 'deploying' | 'shipped' | 'failed'

/** The last signal the office heard, and when (Date.now()). */
export interface LastSignal { kind: SignalKind; at: number }

// Why 10 min: the same limit SCENE_MS puts on a deploy scene that never reports back
const DEPLOY_MAX_MS = 10 * 60_000
// Why 60 s: long enough to be seen from across the room, short enough to be news
const RESULT_MS = 60_000

/**
 * What the wall TV shows.
 * @param agents everyone in the room (a deploy scene on any of them counts)
 * @param last the last signal heard, if any
 * @param now Date.now()
 */
export function tvMode(agents: readonly Agent[], last: LastSignal | null, now: number): TvMode {
  const age = last ? now - last.at : Infinity
  if (last?.kind === 'deploy_fail' && age < RESULT_MS) return 'failed'
  if (last?.kind === 'deploy_success' && age < RESULT_MS) return 'shipped'
  if (agents.some(a => a.scene?.kind === 'shipping' && a.scene.until > now)) return 'deploying'
  if (last?.kind === 'deploy_start' && age < DEPLOY_MAX_MS) return 'deploying'
  if (agents.some(a => a.scene?.kind === 'shipped' && a.scene.until > now)) return 'shipped'
  return 'dashboard'
}

// The signals that end a run: the printer prints the result
const PRINTS: Partial<Record<SignalKind, boolean>> = {
  build_ok: true, test_ok: true, deploy_success: true,
  build_failed: false, test_failed: false, deploy_fail: false,
}

/**
 * A page for the printer, or null: a build, test run or deploy that finished.
 * @returns `ok` (a green page or a red one) and `at`, which keys one print per signal
 */
export function printJob(last: LastSignal | null): { ok: boolean; at: number } | null {
  if (!last) return null
  const ok = PRINTS[last.kind]
  return ok === undefined ? null : { ok, at: last.at }
}

// Why 2 (% of the room): close enough to be standing at the cooler
const AT_SPOT = 2

/**
 * Whether the water cooler bubbles: someone is standing at it, or a session's
 * Claude is waiting on its background workers (the glass of water it holds).
 * @param waterSpots the room's water spots (MAIN_ROOM agentSpots of type 'water')
 */
export function waterBusy(agents: readonly Agent[], waterSpots: ReadonlyArray<{ x: number; y: number }>): boolean {
  return agents.some(a => a.mainState === 'waiting' ||
    waterSpots.some(s => Math.abs(a.position.x - s.x) < AT_SPOT && Math.abs(a.position.y - s.y) < AT_SPOT))
}

// Why these words: the tracker hook's status lines for Read, Grep, Glob and LS
// (hooks/agent-tracker.py: "reading App.tsx", "searching for 'x'", ...)
const READING = /^(reading|searching|finding|listing|globbing)\b/i

/** Whether the filing cabinet stands open: an agent at work is reading or searching files. */
export function filingOpen(agents: readonly Agent[]): boolean {
  return agents.some(a => a.state === 'working' && !!a.statusText && READING.test(a.statusText))
}
