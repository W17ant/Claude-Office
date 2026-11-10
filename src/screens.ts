/**
 * screens.ts - what each desk's monitors show, from who is standing at it.
 *
 * The standing desks are furniture sprites with two monitors each. Instead of
 * new art, the screens are drawn over the sprite in code (DeskScreens.tsx):
 * a desk nobody works at has its screens off; a busy worker has its role's
 * pair up (the frontend developer code and the page it builds, the tester
 * code and tests going green, devops a terminal and a pipeline, the security
 * auditor a yellow warning sign...); a worker whose last tool call failed (or
 * whose test run went red, or whose session hit an API error) gets red
 * flashing screens with a bug walking from one monitor to the other. A
 * rear-facing desk (screens turned away from us) glows in the same colour
 * around the monitor backs.
 */

import type { Agent } from './types'

/** What one busy monitor shows; each role has its own pair (ROLE_SCREENS). */
export type ScreenKind =
  | 'code' | 'terminal' | 'web' | 'tests' | 'diff' | 'pipeline' | 'chart'
  | 'data' | 'chat' | 'search' | 'debug' | 'mail' | 'security'

/** One monitor: off, the desk art's own lit screen (idle), the bug, or a busy kind. */
export type ScreenMode = 'off' | 'idle' | 'bug' | ScreenKind

/** A desk's two monitors, left then right as we see them. */
export type DeskScreen = readonly [ScreenMode, ScreenMode]

/** Which desk (MAIN_ROOM furniture id) each desk spot works at. */
// Why a table: the spot stands beside its desk, not on it, and in two cases
// the nearest desk by straight distance is a neighbour's
export const SPOT_DESK: Readonly<Record<string, string>> = {
  'spot-1': 'desk-2c', 'spot-2': 'desk-2b', 'spot-3': 'desk-2a',
  'spot-4': 'desk-1c', 'spot-5': 'desk-1b', 'spot-6': 'desk-1a',
  'spot-7': 'desk-3c', 'spot-8': 'desk-3b', 'spot-9': 'desk-3a', 'spot-10': 'desk-3d',
}

// What each kind of worker has up on its two monitors while busy. Roles are
// config.ts ROLE_TO_CHAR's keys (subagent types and MCP servers); anything else
// falls through ROLE_PATTERNS, then to code and a terminal.
const ROLE_SCREENS: Readonly<Record<string, readonly [ScreenKind, ScreenKind]>> = {
  'boss': ['chat', 'mail'],
  'assistant': ['code', 'terminal'],
  'debugger': ['debug', 'terminal'],
  'code-reviewer': ['diff', 'code'],
  'architect-reviewer': ['diff', 'chart'],
  'frontend-developer': ['code', 'web'],
  'fullstack-developer': ['code', 'web'],
  'test-engineer': ['code', 'tests'],
  'security-auditor': ['terminal', 'security'],
  'devops-engineer': ['terminal', 'pipeline'],
  'performance-engineer': ['chart', 'code'],
  'database-architect': ['data', 'terminal'],
  'typescript-pro': ['code', 'code'],
  'ai-engineer': ['chat', 'code'],
  'prompt-engineer': ['chat', 'chat'],
  'general-purpose': ['code', 'terminal'],
  'Explore': ['search', 'code'],
  'github': ['terminal', 'pipeline'],
  'supabase': ['data', 'terminal'],
  'playwright': ['web', 'tests'],
  'chrome': ['web', 'web'],
  'memory': ['data', 'chat'],
  'seo': ['web', 'chart'],
  'gmail': ['mail', 'mail'],
  'ios-simulator': ['code', 'web'],
}

// Why patterns too: custom subagent types and other MCP servers have their own names
const ROLE_PATTERNS: ReadonlyArray<[RegExp, readonly [ScreenKind, ScreenKind]]> = [
  [/secur|audit|pentest/i, ['terminal', 'security']],
  [/test|qa\b|e2e/i, ['code', 'tests']],
  [/review/i, ['diff', 'code']],
  [/front|ui\b|ux\b|css|design|web/i, ['code', 'web']],
  [/devops|deploy|ops\b|ci\b|infra|cloud|vercel|docker|k8s/i, ['terminal', 'pipeline']],
  [/perf|bench|profil/i, ['chart', 'code']],
  [/data|sql|db\b|postgres|mongo|redis/i, ['data', 'terminal']],
  [/\bai\b|prompt|llm|ml\b/i, ['chat', 'code']],
  [/explor|research|search/i, ['search', 'code']],
  [/debug/i, ['debug', 'terminal']],
  [/mail|slack|chat/i, ['mail', 'chat']],
]

/** The two monitors a busy worker in `role` has up. */
export function roleScreens(role: string): readonly [ScreenKind, ScreenKind] {
  return ROLE_SCREENS[role] ?? ROLE_PATTERNS.find(([re]) => re.test(role))?.[1] ?? ['code', 'terminal']
}

// Why 1 (% of the room): the same "at the desk" test App.tsx uses for the desk z-order
const AT_DESK = 1

/** Whether `agent` is standing at its desk (not walking to it, not on a break). */
export function atDesk(agent: Agent): boolean {
  return (agent.state === 'working' || agent.state === 'idle') &&
    Math.abs(agent.position.x - agent.deskPosition.x) < AT_DESK &&
    Math.abs(agent.position.y - agent.deskPosition.y) < AT_DESK
}

const OFF: DeskScreen = ['off', 'off']

/**
 * The two monitors of a desk worked at by `agent`.
 * @param agent the worker at the desk, or undefined for an empty desk
 * @param typing whether the office shows it typing right now
 */
export function screenMode(agent: Agent | undefined, typing = false): DeskScreen {
  if (!agent || !atDesk(agent)) return OFF
  // Why bug first: a failure is the one thing worth looking up for
  if (agent.lastFailed || agent.scene?.kind === 'red' || agent.mainState === 'error') return ['bug', 'bug']
  const busy = typing || agent.state === 'working'
  return busy ? roleScreens(agent.role) : ['idle', 'idle']
}

/**
 * The monitors of every desk, by desk id; desks nobody is at are off.
 * @param agents the room's agents
 * @param typing ids the office shows typing
 */
export function deskScreens(agents: readonly Agent[], typing: ReadonlySet<string> = new Set()): Record<string, DeskScreen> {
  const out: Record<string, DeskScreen> = {}
  for (const desk of Object.values(SPOT_DESK)) out[desk] = OFF
  for (const a of agents) {
    const desk = a.assignedSpotId ? SPOT_DESK[a.assignedSpotId] : undefined
    if (!desk) continue
    const screens = screenMode(a, typing.has(a.id))
    // Why keep lit screens: someone walking past a desk must not switch off its worker's
    if (screens[0] !== 'off') out[desk] = screens
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

const KINDS: readonly ScreenKind[] = ['code', 'terminal', 'web', 'tests', 'diff', 'pipeline', 'chart', 'data', 'chat', 'search', 'debug', 'mail', 'security']
const MODES: readonly string[] = ['off', 'idle', 'bug', ...KINDS]

/**
 * `?screens=<mode>` (bug, web, tests, off...) shows that on every desk, and
 * `?screens=all` the bug on the first desk facing us and every other kind in
 * turn on the rest, to see the screens without waiting for the work behind
 * them (like `?season=`).
 * @param desks the desk ids to fill, with whether their screens face us
 * @returns the forced screens by desk, or null when the URL does not ask for any
 */
export function previewScreens(desks: ReadonlyArray<{ id: string; front: boolean }>, search: string = typeof location !== 'undefined' ? location.search : ''): Record<string, DeskScreen> | null {
  const v = new URLSearchParams(search).get('screens')
  if (!v) return null
  if (v === 'all') {
    // Why front desks first: only their screens are seen; a rear desk just glows
    const order = [...desks.filter(d => d.front), ...desks.filter(d => !d.front)]
    let k = 0
    const next = () => KINDS[k++ % KINDS.length]
    return Object.fromEntries(order.map((d, i) => [d.id, i === 0 ? ['bug', 'bug'] : [next(), next()]]))
  }
  if (!MODES.includes(v)) return null
  return Object.fromEntries(desks.map(d => [d.id, [v, v] as unknown as DeskScreen]))
}
