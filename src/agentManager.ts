/**
 * agentManager.ts
 *
 * Agent lifecycle helpers for the Agent Office visualiser.
 *
 * Lifecycle:
 *   1. agent_spawned  → new-hire state → walk from door to assigned desk
 *   2. agent_working  → working state at desk (show typing effect)
 *   3. Randomly:        coffee-break → walk to coffee spot, wait, walk back
 *   4. Randomly:        water-break  → walk to water spot, wait, walk back
 *   5. agent_completed → walk to door → agent removed
 *
 * Movement:
 *   Positions are percentages (0-100) matching room container dimensions.
 *   Agents glide toward their target via linear interpolation each frame.
 *   The walkable polygon is respected via clamping to the nearest on-polygon
 *   point — a lightweight approach that keeps agents visually within bounds
 *   without full path-planning.
 *
 * Direction (sprite variant):
 *   - dx >= 0, dy < 0  → front-left  (moving up-right in isometric)
 *   - dx < 0,  dy < 0  → front-right (moving up-left)
 *   - dx >= 0, dy >= 0 → rear-left   (moving down-right)
 *   - dx < 0,  dy >= 0 → rear-left   (fallback — no rear-right walking sprite)
 */

import { Agent, AgentState, Position } from './types'
import { AgentSpot, Waypoint } from './rooms'

// ---------------------------------------------------------------------------
// Spot assignment
// ---------------------------------------------------------------------------

/**
 * Find the first desk spot not currently occupied by any agent.
 * Returns null if all desks are taken.
 */
export function assignSpot(
  agents: Agent[],
  spots: AgentSpot[],
): AgentSpot | null {
  const deskSpots = spots.filter(s => s.type === 'desk')
  const takenIds = new Set(agents.map(a => a.assignedSpotId).filter(Boolean))

  for (const spot of deskSpots) {
    if (!takenIds.has(spot.id)) return spot
  }
  return null
}

// ---------------------------------------------------------------------------
// Movement / direction
// ---------------------------------------------------------------------------

/**
 * Move an agent one step toward its targetPosition.
 *
 * @param position      Current position
 * @param targetPosition Where we want to go
 * @param speed         Maximum distance to move this frame (in %-units)
 * @returns             New position and whether we have arrived
 */
export function stepToward(
  position: Position,
  targetPosition: Position,
  speed: number,
): { position: Position; arrived: boolean } {
  const dx = targetPosition.x - position.x
  const dy = targetPosition.y - position.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist <= speed) {
    return { position: { ...targetPosition }, arrived: true }
  }

  return {
    position: {
      x: position.x + (dx / dist) * speed,
      y: position.y + (dy / dist) * speed,
    },
    arrived: false,
  }
}

// ---------------------------------------------------------------------------
// Waypoint pathfinding
// ---------------------------------------------------------------------------

/**
 * Find the nearest waypoint to a given (x, y) position.
 */
function nearestWaypoint(x: number, y: number, waypoints: Waypoint[]): Waypoint {
  let best = waypoints[0]
  let bestDist = Infinity
  for (const wp of waypoints) {
    const dx = wp.x - x
    const dy = wp.y - y
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      bestDist = d
      best = wp
    }
  }
  return best
}

/**
 * BFS through the waypoint graph to find the shortest path of waypoint ids
 * from startId to endId.  Returns null if no path exists.
 */
function bfsWaypoints(startId: string, endId: string, waypoints: Waypoint[]): string[] | null {
  if (startId === endId) return [startId]

  const byId = new Map<string, Waypoint>(waypoints.map(w => [w.id, w]))
  const visited = new Set<string>([startId])
  const queue: { id: string; path: string[] }[] = [{ id: startId, path: [startId] }]

  while (queue.length > 0) {
    const { id, path } = queue.shift()!
    const node = byId.get(id)
    if (!node) continue

    for (const neighborId of node.connections) {
      if (neighborId === endId) return [...path, endId]
      if (!visited.has(neighborId)) {
        visited.add(neighborId)
        queue.push({ id: neighborId, path: [...path, neighborId] })
      }
    }
  }

  return null
}

/**
 * Compute a waypoint path from (fromX, fromY) to (toX, toY) using the given
 * waypoint graph.  Returns an ordered array of {x, y} positions to walk
 * through (not including the caller's current position, not including the
 * final destination — the caller should keep walking to targetPosition once
 * the queue is empty).
 *
 * The returned array always contains at least the nearest start waypoint.
 */
/**
 * Add slight random deviation to a waypoint position so agents don't all
 * walk the exact same line. Keeps them within ±1.5% of the waypoint.
 */
function jitter(v: number, amount = 1.5): number {
  return v + (Math.random() - 0.5) * amount * 2
}

/**
 * Occasionally pick a longer route via a random intermediate waypoint.
 * ~20% chance when the shortest path is short (≤4 waypoints).
 */
function maybeTakeLongWay(
  startId: string,
  endId: string,
  waypoints: Waypoint[],
): string[] | null {
  const shortest = bfsWaypoints(startId, endId, waypoints)
  if (!shortest || shortest.length > 4) return shortest // already long enough

  // 20% chance to detour
  if (Math.random() > 0.2) return shortest

  // Pick a random waypoint that's NOT on the shortest path as a detour
  const onPath = new Set(shortest)
  const detours = waypoints.filter(w => !onPath.has(w.id))
  if (detours.length === 0) return shortest

  const via = detours[Math.floor(Math.random() * detours.length)]
  const leg1 = bfsWaypoints(startId, via.id, waypoints)
  const leg2 = bfsWaypoints(via.id, endId, waypoints)

  if (leg1 && leg2) {
    // Combine legs, removing duplicate via-point
    return [...leg1, ...leg2.slice(1)]
  }

  return shortest
}

export function findWaypointPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  waypoints: Waypoint[],
): { x: number; y: number }[] {
  if (waypoints.length === 0) return []

  const startWp = nearestWaypoint(fromX, fromY, waypoints)
  const endWp   = nearestWaypoint(toX, toY, waypoints)

  const ids = maybeTakeLongWay(startWp.id, endWp.id, waypoints)
  if (!ids) return [{ x: startWp.x, y: startWp.y }]

  const byId = new Map<string, Waypoint>(waypoints.map(w => [w.id, w]))
  return ids.map(id => {
    const wp = byId.get(id)!
    return { x: jitter(wp.x), y: jitter(wp.y) }
  })
}

// ---------------------------------------------------------------------------
// Effect sprite mapping
// ---------------------------------------------------------------------------

const ENERGY_DRINKS = [
  '/sprites/effects/redbull-energy.png',
  '/sprites/effects/monster-energy.png',
]

// Pick a consistent energy drink per agent (based on a simple hash)
function pickEnergyDrink(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0
  return ENERGY_DRINKS[Math.abs(hash) % ENERGY_DRINKS.length]
}

/**
 * Map an agent state to the effect sprite path (or null for no effect).
 * Pass statusText/task to detect ultra-think mode.
 */
export function getEffect(
  state: AgentState,
  idleDurationMs: number = 0,
  statusText?: string,
  agentId?: string,
  task?: string,
): string | null {
  // Boss gets Red Bull instead of coffee
  if (agentId?.startsWith('boss-') && state === 'coffee-break') {
    return '/sprites/effects/redbull-energy.png'
  }

  switch (state) {
    case 'working': {
      // Ultra-think = energy drink mode — check both statusText and task
      const text = `${statusText ?? ''} ${task ?? ''}`.toLowerCase()
      if (text.includes('ultra') || text.includes('deep analysis') || text.includes('ultra-think')) {
        return pickEnergyDrink(agentId ?? 'default')
      }
      // No permanent typing bubble — only shows via status updates briefly
      return null
    }
    case 'coffee-break': {
      // Boss gets Red Bull (handled above), water breaks get water glass
      const breakText = (statusText ?? '').toLowerCase()
      if (breakText.includes('hydrat') || breakText.includes('h2o') || breakText.includes('water') || breakText.includes('refill')) {
        return '/sprites/effects/glass-water.png'
      }
      return '/sprites/effects/need-coffee.png'
    }
    case 'walking-to-desk': {
      // Event-specific effects while walking to event spots
      const walkText = (statusText ?? '').toLowerCase()
      if (walkText.includes('pizza')) return '/sprites/effects/pizza.png'
      if (walkText.includes('birthday')) return '/sprites/effects/cake.png'
      if (walkText.includes('fire')) return '/sprites/effects/fire.png'
      if (walkText.includes('deploy') || walkText.includes('friday') || walkText.includes('success')) return '/sprites/effects/party.png'
      if (walkText.includes('standup')) return null
      return null
    }
    case 'new-hire':
      return '/sprites/effects/star.png'
    case 'completed':
      return '/sprites/effects/thumb-up.png'
    case 'idle':
      return idleDurationMs > 30_000 ? '/sprites/effects/sleeping.png' : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Slack message helpers
// ---------------------------------------------------------------------------

const SPAWN_MESSAGES = [
  'reporting for duty!',
  'clocked in',
  'ready to ship',
  'coffee first, then code',
  'let\'s do this',
  'opening vim...',
  'pulling latest main',
]

const WORK_MESSAGES = [
  'on it',
  'typing furiously',
  'in the zone',
  'making progress',
  'checking the docs',
  'git blame time',
  'stack overflow to the rescue',
]

const DONE_MESSAGES = [
  'task complete!',
  'shipped it',
  'PR opened',
  'done and dusted',
  'LGTM',
  'merged to main',
  'deployed',
]

const COFFEE_MESSAGES = [
  'brb, coffee',
  'need caffeine',
  'grabbing a cup',
  'coffee run',
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

const WATER_MESSAGES = [
  'stay hydrated',
  'h2o break',
  'water run',
  'refilling bottle',
  'hydration check',
  'quick water break',
]

export function spawnMessage(): string  { return pick(SPAWN_MESSAGES) }
export function workMessage(): string   { return pick(WORK_MESSAGES) }
export function doneMessage(): string   { return pick(DONE_MESSAGES) }
export function coffeeMessage(): string { return pick(COFFEE_MESSAGES) }
export function waterMessage(): string  { return pick(WATER_MESSAGES) }

// ---------------------------------------------------------------------------
// Break scheduling
// ---------------------------------------------------------------------------

/** Minimum time at desk before a coffee/water break can trigger (ms) */
export const BREAK_MIN_DESK_TIME = 20_000
/** Probability per second of initiating a break while at desk */
export const BREAK_CHANCE_PER_SEC = 0.008
/** How long agent waits at the break spot before returning (ms) */
export const BREAK_DURATION = 8_000
/** Walking speed in %-units per frame at 60fps */
export const WALK_SPEED = 0.08

// ---------------------------------------------------------------------------
// Agent creation helper
// ---------------------------------------------------------------------------

import { AGENT_CONFIGS } from './types'
import { ROOMS } from './rooms'

export function createAgent(partial: {
  id: string
  name: string
  role: string
  task?: string
  spot: AgentSpot
}): Agent {
  const cfg = AGENT_CONFIGS[partial.role] ?? AGENT_CONFIGS['default']
  const entry = ROOMS['main-office'].entryPoint

  return {
    id: partial.id,
    name: partial.name,
    type: 'subagent',
    role: partial.role,
    state: 'new-hire',
    position: { x: entry.x, y: entry.y },
    targetPosition: { x: partial.spot.x, y: partial.spot.y },
    deskPosition: { x: partial.spot.x, y: partial.spot.y },
    room: 'main-office',
    assignedRoom: 'main-office',
    assignedSpotId: partial.spot.id,
    spriteFacing: partial.spot.spriteFacing,
    task: partial.task,
    statusText: spawnMessage(),
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: Date.now(),
  }
}
