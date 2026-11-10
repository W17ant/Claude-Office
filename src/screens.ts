/**
 * screens.ts - what each desk's monitors show, from who is standing at it.
 *
 * The standing desks are furniture sprites with two monitors each. Instead of
 * new art, the screens are drawn over the sprite in code (DeskScreens.tsx):
 * a desk nobody works at has its screens off, a desk whose worker is busy
 * scrolls code, a worker whose last tool call failed (or whose test run went
 * red, or whose session hit an API error) gets a red flashing screen with a bug
 * walking from one monitor to the other, and the security auditor's screens
 * show a yellow warning triangle. A rear-facing desk (screens turned away from
 * us) shows the same mood as a glow around the monitor backs.
 */

import type { Agent } from './types'

export type ScreenMode = 'off' | 'idle' | 'code' | 'bug' | 'security'

/** Which desk (MAIN_ROOM furniture id) each desk spot works at. */
// Why a table: the spot stands beside its desk, not on it, and in two cases
// the nearest desk by straight distance is a neighbour's
export const SPOT_DESK: Readonly<Record<string, string>> = {
  'spot-1': 'desk-2c', 'spot-2': 'desk-2b', 'spot-3': 'desk-2a',
  'spot-4': 'desk-1c', 'spot-5': 'desk-1b', 'spot-6': 'desk-1a',
  'spot-7': 'desk-3c', 'spot-8': 'desk-3b', 'spot-9': 'desk-3a', 'spot-10': 'desk-3d',
}

// Why 1 (% of the room): the same "at the desk" test App.tsx uses for the desk z-order
const AT_DESK = 1

/** Whether `agent` is standing at its desk (not walking to it, not on a break). */
export function atDesk(agent: Agent): boolean {
  return (agent.state === 'working' || agent.state === 'idle') &&
    Math.abs(agent.position.x - agent.deskPosition.x) < AT_DESK &&
    Math.abs(agent.position.y - agent.deskPosition.y) < AT_DESK
}

/**
 * The screens of a desk worked at by `agent`.
 * @param agent the worker at the desk, or undefined for an empty desk
 * @param typing whether the office shows it typing right now
 */
export function screenMode(agent: Agent | undefined, typing = false): ScreenMode {
  if (!agent || !atDesk(agent)) return 'off'
  // Why bug first: a failure is the one thing worth looking up for
  if (agent.lastFailed || agent.scene?.kind === 'red' || agent.mainState === 'error') return 'bug'
  const busy = typing || agent.state === 'working'
  if (!busy) return 'idle'
  return /secur/i.test(agent.role) ? 'security' : 'code'
}

/**
 * Screen mode per desk id for everyone in the room; desks nobody is at are 'off'.
 * @param agents the room's agents
 * @param typing ids the office shows typing
 */
export function deskScreens(agents: readonly Agent[], typing: ReadonlySet<string> = new Set()): Record<string, ScreenMode> {
  const out: Record<string, ScreenMode> = {}
  for (const desk of Object.values(SPOT_DESK)) out[desk] = 'off'
  for (const a of agents) {
    const desk = a.assignedSpotId ? SPOT_DESK[a.assignedSpotId] : undefined
    if (!desk) continue
    const mode = screenMode(a, typing.has(a.id))
    // Why keep a lit mode: someone walking past a desk must not switch off its worker's screens
    if (mode !== 'off' || out[desk] === undefined) out[desk] = mode
  }
  return out
}

// ---------------------------------------------------------------------------
// Where the screens are, in each desk sprite's own pixels
// ---------------------------------------------------------------------------

/** A monitor face: left edge at x0 from y0 down `h`, right edge at x1 from y1 down `h`. */
export interface ScreenQuad { x0: number; y0: number; x1: number; y1: number; h: number }

export interface DeskGeometry {
  /** The sprite's size in its own pixels (the overlay's viewBox) */
  w: number
  h: number
  /** Screens facing us, left to right (a front desk); empty on a rear desk */
  screens: ScreenQuad[]
  /** Centre and radii of the glow behind the monitor backs (a rear desk) */
  glow?: { cx: number; cy: number; rx: number; ry: number }
}

// Measured from the PNGs: the light-blue screen areas of the front desks
// (their vertical left and right edges), and the dark monitor backs of the
// rear ones. The right-hand desks are the left-hand ones mirrored.
export const DESK_GEOMETRY: Readonly<Record<string, DeskGeometry>> = {
  'desk-standing-left-front': {
    w: 580, h: 728,
    screens: [{ x0: 69, y0: 142, x1: 221, y1: 70, h: 111 }, { x0: 258, y0: 55, x1: 439, y1: 23, h: 108 }],
  },
  'desk-standing-right-front': {
    w: 580, h: 728,
    screens: [{ x0: 140, y0: 23, x1: 321, y1: 55, h: 108 }, { x0: 358, y0: 70, x1: 510, y1: 142, h: 111 }],
  },
  'desk-standing-left-rear': { w: 577, h: 703, screens: [], glow: { cx: 337, cy: 165, rx: 210, ry: 140 } },
  'desk-standing-right-rear': { w: 576, h: 704, screens: [], glow: { cx: 240, cy: 165, rx: 210, ry: 140 } },
}

const MODES: readonly ScreenMode[] = ['off', 'idle', 'code', 'bug', 'security']

/**
 * `?screens=bug` (or code, security, off, idle) shows that on every desk, to
 * see a screen without waiting for the state behind it (like `?season=`).
 * @returns the forced mode, or null when the URL does not ask for one
 */
export function previewScreenMode(search: string = typeof location !== 'undefined' ? location.search : ''): ScreenMode | null {
  const v = new URLSearchParams(search).get('screens')
  return v && (MODES as readonly string[]).includes(v) ? (v as ScreenMode) : null
}
