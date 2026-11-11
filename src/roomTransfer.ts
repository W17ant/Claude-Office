/**
 * roomTransfer.ts - walking an agent from one room to another, and deciding who goes where.
 *
 * Pure helpers for src/officeReducer.ts: no React, no DOM, no timers, and
 * randomness / path-finding only through the reducer's `OfficeEnv`.
 *
 * ── The walk ───────────────────────────────────────────────────────────────
 * Every room change goes through the corridor (src/rooms.ts is a star), in
 * up to three legs, kept as `AgentMeta.transfer`:
 *
 *   to-door    an ordinary walk, in the room the agent is in, to its door
 *              (waypoints as usual). At the door the agent is handed to the
 *              corridor: it now stands at the corridor's door for that room.
 *   corridor   straight along the hallway to the destination's door, at
 *              CORRIDOR_PACE. At that door it is handed to the destination
 *              room and stands just inside its door.
 *   to-spot    an ordinary walk from the door to its seat.
 *
 * The two hand-offs are the only jumps, and each is between two pictures of
 * the same doorway. A walk that starts in the corridor (a newcomer at the
 * front door) begins at the second leg; one that ends there (a leaver) stops
 * after it. A newcomer's transfer ends at the destination's door: from there
 * it is the ordinary walk-in the office has always had.
 *
 * ── The cap ────────────────────────────────────────────────────────────────
 * TRANSFER_MAX_MS bounds a whole change of room. It is spent on the corridor:
 * `corridorBy` is the moment the agent has to be through the destination's
 * door for its last leg to still fit, and when the clock passes it the rest
 * of the corridor is skipped (the door-to-door hand-off, which is allowed to
 * jump). The walks inside the two rooms are never shortened: an agent
 * snapping across a room it is visibly in would be a teleport.
 *
 * ── Who goes where ─────────────────────────────────────────────────────────
 * `planRoomMoves` asks src/roomRules.ts about every settled agent and starts
 * the walks. A visitor keeps its own desk: the seat it takes elsewhere is
 * `Agent.visitSpotId`, so the way back can never find the desk gone.
 *
 * ── The boss ───────────────────────────────────────────────────────────────
 * The boss is pinned to the office by the rules, but follows the person
 * around the building: a room picked on the stage sends him there by the same
 * walk (`drop-in`, src/officeReducer.ts sendBoss), to `standInside` that
 * room, and `planRoomMoves` leaves him alone while he is out (`sentTo`).
 */

import type { Agent, Position } from './types'
import type { AgentMeta, OfficeEnv, PendingStatus } from './officeReducer'
import { ROOMS, HUB_ROOM, OFFICE_ROOM, doorTo, findSpot, getFreeSpot, type RoomId, type AgentSpot } from './rooms'
import { stepToward, WALK_SPEED } from './agentManager'
import { agentStateFor, isHardNeedsYou, isMainAgent } from './mainState'
import { wantedRoom, dwellMs, MEETING_ROOM, type RoomFacts } from './roomRules'

/** Why an agent is changing room; decides what it does when it gets there */
export type TransferWhy =
  /** A newcomer coming in by the front door */
  | 'arrive'
  /** Finished: out by the front door */
  | 'leave'
  /** To a seat in another room while a rule (src/roomRules.ts) says so */
  | 'visit'
  /** Back to its own desk */
  | 'return'
  /** A coffee / water break in the lunch room */
  | 'break'
  /** The boss, sent to a room the person put on the stage: he stands just inside its door */
  | 'drop-in'

export interface Transfer {
  /** The room it is going to */
  to: RoomId
  /** Where in that room it will end up */
  target: Position
  leg: 'to-door' | 'corridor' | 'to-spot'
  /** By when it must be through the destination's door (the cap; see the file header) */
  corridorBy: number
  why: TransferWhy
}

/**
 * How much faster than WALK_SPEED the corridor is walked.
 * Why 2: the corridor is the dull part of a room change, and the plan asks
 * for it to be quick; twice the pace still reads as a brisk walk (the walk
 * cycle's frame rate does not follow speed), where 3x and up reads as sliding.
 */
export const CORRIDOR_PACE = 2

/**
 * The budget for a whole change of room, from getting up to sitting down.
 * Why 20 s: an agent is guaranteed 30 s on screen (MIN_VISIBLE_TIME), so a
 * room change has to be clearly shorter than that or a quick agent would
 * spend its whole life in doorways. A typical change is ~8 s to the office
 * door, 2-7 s of corridor at CORRIDOR_PACE and ~5 s to the seat, so 20 s
 * leaves the corridor walk whole in the normal case and only cuts it when
 * the first leg was a long detour.
 */
export const TRANSFER_MAX_MS = 20_000

/** The corridor's front door: where newcomers appear and leavers are last seen */
export const FRONT_DOOR: Position = { x: ROOMS[HUB_ROOM].entryPoint.x, y: ROOMS[HUB_ROOM].entryPoint.y }

/** The frame rate WALK_SPEED is tuned for (App.tsx steps with dt = elapsed / 16.67 ms) */
const FRAMES_PER_SECOND = 60

/**
 * How far into a room the boss stands when he drops in: this share of the
 * way from its door to the middle of its floor.
 * Why 0.25: far enough that he is clearly in the room and off the doormat,
 * near enough that he stays clear of the furniture in the middle (the meeting
 * table, the lunch tables, the racks' aisle); tests/roomTransfer.test.ts
 * checks the spot is on each room's floor.
 */
export const BOSS_STEP_IN = 0.25

/**
 * Rooms where the step in from the door lands on furniture, with a spot
 * placed by hand instead. Why the meeting room: its table runs from the
 * middle of the floor up to the door, so a quarter of the way in is the
 * table's end; to the right of the door, in front of the TV, the floor is clear.
 */
const STAND_SPOTS: Partial<Record<RoomId, Position>> = {
  'meeting-room': { x: 73.5, y: 57.5 },
}

/**
 * Where the boss stands when he drops in on a room: a step in from the door
 * he came in by (for the corridor, the office's door: he comes from there or
 * passes it on his way), or the spot placed by hand in STAND_SPOTS.
 * @param room the room he was sent to (not the office: there he sits at his desk)
 * @returns the spot, on the room's floor
 */
export function standInside(room: RoomId): Position {
  const placed = STAND_SPOTS[room]
  if (placed) return { ...placed }
  const door = doorTo(room, room === HUB_ROOM ? OFFICE_ROOM : HUB_ROOM) ?? ROOMS[room].entryPoint
  const floor = ROOMS[room].walkableArea
  if (!floor || floor.length === 0) return { ...door }
  // Why the corners' average: every room is the same isometric box, so it is the floor's middle
  const mid = {
    x: floor.reduce((sum, p) => sum + p.x, 0) / floor.length,
    y: floor.reduce((sum, p) => sum + p.y, 0) / floor.length,
  }
  const round = (n: number) => Math.round(n * 10) / 10
  return { x: round(door.x + (mid.x - door.x) * BOSS_STEP_IN), y: round(door.y + (mid.y - door.y) * BOSS_STEP_IN) }
}

/**
 * The room an agent is in. Agents made before rooms existed (old fixtures,
 * a stored snapshot) carry no room and are in the office.
 * @param agent the agent
 * @returns its current room
 */
export function roomOf(agent: Pick<Agent, 'room'>): RoomId {
  return agent.room ?? OFFICE_ROOM
}

/**
 * Whether an agent is at home in the office: in the room, and not holding a
 * seat somewhere else. Everything the office does to a seated agent (fire
 * drills, the coffee machine, a colleague dropping by) asks this first.
 * @param agent the agent
 * @returns true when office-only behaviour may touch it
 */
export function inOffice(agent: Pick<Agent, 'room' | 'visitSpotId' | 'type'>): boolean {
  return roomOf(agent) === OFFICE_ROOM && !agent.visitSpotId && agent.type !== 'mcp'
}

/** How long a straight walk takes at WALK_SPEED, in ms at 60 fps */
function walkMs(from: Position, to: Position): number {
  return Math.ceil((Math.hypot(to.x - from.x, to.y - from.y) / (WALK_SPEED * FRAMES_PER_SECOND)) * 1000)
}

/** Where in the corridor a transfer to `to` is heading */
function corridorGoal(to: RoomId, target: Position): Position {
  return to === HUB_ROOM ? target : (doorTo(HUB_ROOM, to) ?? target)
}

/**
 * Start a room change. The agent is pointed at the first thing to walk to
 * (its room's door, or along the corridor when it is already there); the
 * caller sets its state and stores the transfer in its meta.
 * @param agent the agent, wherever it is
 * @param to the room to end up in
 * @param target where in that room
 * @param why what it does on arrival
 * @param env the reducer's environment (clock, path-finding)
 * @returns the agent on its way and the transfer to store
 */
export function beginTransfer(agent: Agent, to: RoomId, target: Position, why: TransferWhy, env: OfficeEnv): { agent: Agent; transfer: Transfer } {
  const from = roomOf(agent)
  const lastLegFrom = to === HUB_ROOM ? null : doorTo(to, HUB_ROOM)
  const corridorBy = env.now + TRANSFER_MAX_MS - (lastLegFrom ? walkMs(lastLegFrom, target) : 0)
  const transfer: Transfer = { to, target: { ...target }, leg: 'to-door', corridorBy, why }

  if (from === HUB_ROOM) {
    return {
      agent: { ...agent, targetPosition: { ...corridorGoal(to, target) }, pathQueue: [] },
      transfer: { ...transfer, leg: 'corridor' },
    }
  }
  if (from === to) {
    // Already in the room (a caller's slip): just the last leg
    return {
      agent: { ...agent, targetPosition: { ...target }, pathQueue: env.computePath(agent.position, target, from) },
      transfer: { ...transfer, leg: 'to-spot' },
    }
  }
  const door = doorTo(from, HUB_ROOM) ?? ROOMS[from].entryPoint
  return {
    agent: { ...agent, targetPosition: { ...door }, pathQueue: env.computePath(agent.position, door, from) },
    transfer,
  }
}

/** Hand the agent from the corridor into the destination room, just inside its door */
function enterDestination(agent: Agent, t: Transfer, env: OfficeEnv): { agent: Agent; transfer: Transfer | null } {
  const door = doorTo(t.to, HUB_ROOM) ?? ROOMS[t.to].entryPoint
  const next: Agent = {
    ...agent,
    room: t.to,
    position: { ...door },
    targetPosition: { ...t.target },
    pathQueue: env.computePath(door, t.target, t.to),
  }
  // Why a newcomer's transfer ends here: from the door on it is the walk-in
  // the reducer already has (new-hire to a desk, or waiting in the lobby)
  if (t.why === 'arrive') return { agent: next, transfer: null }
  return { agent: next, transfer: { ...t, leg: 'to-spot' } }
}

/**
 * Advance a room change by one frame.
 * @param agent the agent in transit
 * @param t its transfer
 * @param dt frames elapsed (60 fps frames, usually ~1)
 * @param env the reducer's environment
 * @returns the agent after the frame (the same object when it did not move)
 *          and the transfer to keep, or null when the change is over
 */
export function stepTransfer(agent: Agent, t: Transfer, dt: number, env: OfficeEnv): { agent: Agent; transfer: Transfer | null } {
  const pace = WALK_SPEED * dt * (t.leg === 'corridor' ? CORRIDOR_PACE : 1)
  const queue = agent.pathQueue ?? []
  const goal = queue.length > 0 ? queue[0] : agent.targetPosition
  const { position, arrived } = stepToward(agent.position, goal, pace)
  // The cap: out of budget in the corridor, so the rest of it is skipped
  const outOfTime = t.leg === 'corridor' && t.to !== HUB_ROOM && env.now >= t.corridorBy

  if (!outOfTime) {
    if (!arrived) {
      const moved = position.x !== agent.position.x || position.y !== agent.position.y
      return { agent: moved ? { ...agent, position } : agent, transfer: t }
    }
    if (queue.length > 0) return { agent: { ...agent, position, pathQueue: queue.slice(1) }, transfer: t }
  }

  switch (t.leg) {
    case 'to-door': {
      const from = roomOf(agent)
      const inHub = doorTo(HUB_ROOM, from) ?? ROOMS[HUB_ROOM].entryPoint
      const next: Agent = { ...agent, room: HUB_ROOM, position: { ...inHub }, targetPosition: { ...corridorGoal(t.to, t.target) }, pathQueue: [] }
      const corridor: Transfer = { ...t, leg: 'corridor' }
      // The first leg used the whole budget: door to door, no corridor at all
      if (t.to !== HUB_ROOM && env.now >= t.corridorBy) return enterDestination(next, corridor, env)
      return { agent: next, transfer: corridor }
    }
    case 'corridor':
      if (t.to === HUB_ROOM) return { agent: { ...agent, position: { ...t.target }, pathQueue: [] }, transfer: null }
      return enterDestination(agent, t, env)
    case 'to-spot':
      return { agent: { ...agent, position: { ...t.target }, pathQueue: [] }, transfer: null }
  }
}

/**
 * What an agent does when its room change is over.
 * - arrive / leave: nothing here (the reducer's walk-in and its pruning at
 *   the front door take over)
 * - visit: sits down in the seat it was given, in whatever it was doing
 * - return: sits down at its own desk again
 * - break: stands at the counter for the length of a break
 * - drop-in: the boss stands where he was sent, idle
 * @param agent the agent, at its target
 * @param why the transfer's reason
 * @param pending a status that arrived while it was walking (applied on sitting down)
 * @param now the reducer's clock
 * @returns the settled agent, the meta fields to set, and whether `pending` was used
 */
export function settleTransfer(agent: Agent, why: TransferWhy, pending: PendingStatus | undefined, now: number): { agent: Agent; meta: Partial<AgentMeta>; usedPending: boolean } {
  if (why === 'arrive' || why === 'leave') return { agent, meta: {}, usedPending: false }
  if (why === 'drop-in') {
    // Standing just inside, facing into the room the way its door's arrivals do;
    // idle (no typing, no props), and not at his desk, so no coffee break is due
    const door = ROOMS[roomOf(agent)].connections.find(c => c.toRoom === HUB_ROOM)
    return {
      agent: { ...agent, state: 'idle', spriteFacing: door?.entryFacing ?? 'front-left' },
      meta: { arrivedAtDeskAt: null, idleSince: null, onBreak: false, breakStartedAt: null },
      usedPending: false,
    }
  }
  const seat = findSpot(why === 'return' ? agent.assignedSpotId : agent.visitSpotId)?.spot
  const facing = seat?.spriteFacing ?? agent.spriteFacing
  if (why === 'break') {
    return { agent: { ...agent, state: 'coffee-break', spriteFacing: facing }, meta: { onBreak: true, breakStartedAt: now }, usedPending: false }
  }
  // A session's Claude sits down in whatever its main thread is doing (applyMain
  // kept that current during the walk); a worker takes the status that arrived meanwhile
  const seated: Agent = isMainAgent(agent)
    ? { ...agent, state: agentStateFor(agent.mainState), spriteFacing: facing }
    : { ...agent, state: 'working', spriteFacing: facing, statusText: pending?.status ?? agent.statusText, lastFailed: pending ? pending.failed : agent.lastFailed }
  return {
    agent: seated,
    // Why arrivedAtDeskAt only for 'return': it is what makes an agent due a
    // coffee break, and a visitor is not at its desk
    meta: { arrivedAtDeskAt: why === 'return' ? now : null, onBreak: false, breakStartedAt: null },
    usedPending: !isMainAgent(agent) && !!pending,
  }
}

/** The kind of seat a visitor takes in each room */
function visitSeat(room: RoomId, taken: Set<string>): AgentSpot | null {
  return getFreeSpot(room, taken, room === MEETING_ROOM ? 'meeting-seat' : 'lounge')
}

/**
 * Spots somebody holds: every desk of an agent still in the building, and
 * every seat a visitor has taken elsewhere.
 * @param agents everyone
 * @returns the held spot ids
 */
export function heldSpotIds(agents: Agent[]): Set<string> {
  const ids = new Set<string>()
  for (const a of agents) {
    if (a.state === 'completed') continue
    if (a.assignedSpotId) ids.add(a.assignedSpotId)
    if (a.visitSpotId) ids.add(a.visitSpotId)
  }
  return ids
}

/**
 * The session an agent belongs to, or null. Why no group for agents without
 * one (?sim's staff, hooks too old to send it): the meeting room is for "a
 * session's agents", and lumping every stray together would walk the whole
 * ?sim office into it and leave the room in view empty.
 */
function sessionKey(a: Agent): string | null {
  return a.sessionId ?? null
}

/**
 * Ask the room rules about every settled agent and start the walks that are
 * due. Only an agent sitting somewhere (working or idle, not on a break, not
 * already walking between rooms) is considered, so nobody is turned round
 * mid-walk. A wish has to hold for its dwell (src/roomRules.ts) first, and a
 * full room is simply not entered: the agent stays where it is and is asked
 * again on the next frame.
 * @param agents everyone, after this frame's walking
 * @param meta their meta records
 * @param env the reducer's environment (`openRooms` decides what exists)
 * @param isPinned true for staff who never leave their desk's room (the boss, the ?sim Claude)
 * @returns the agents and meta to keep, and whether anything changed
 */
export function planRoomMoves(
  agents: Agent[], meta: Record<string, AgentMeta>, env: OfficeEnv, isPinned: (a: Agent) => boolean,
): { agents: Agent[]; meta: Record<string, AgentMeta>; changed: boolean } {
  const open = env.openRooms
  if (!open || open.size <= 2) return { agents, meta, changed: false } // the office and at most the corridor: nowhere to go

  // Per session: how many workers it runs, and whether its Claude waits on a person
  const teamSize = new Map<string, number>()
  const needsYou = new Set<string>()
  for (const a of agents) {
    const key = sessionKey(a)
    if (a.state === 'completed' || key === null) continue
    if (isMainAgent(a)) {
      if (a.mainState === 'needs-you' && isHardNeedsYou(a.needsYou)) needsYou.add(key)
    } else if (a.type === 'subagent' && !isPinned(a) && a.state !== 'waiting') {
      teamSize.set(key, (teamSize.get(key) ?? 0) + 1)
    }
  }

  let changed = false
  let nextMeta = meta
  let taken: Set<string> | null = null
  const next = agents.map(agent => {
    const m = nextMeta[agent.id]
    // Why sentTo: the person sent the boss out (he follows the stage); the rules would only walk him home
    if (!m || m.transfer || m.onBreak || m.sentTo || !agent.assignedSpotId) return agent
    if (agent.state !== 'working' && agent.state !== 'idle') return agent

    const current = roomOf(agent)
    const home = agent.assignedRoom ?? OFFICE_ROOM
    const key = sessionKey(agent)
    const facts: RoomFacts = {
      home,
      current,
      pinned: isPinned(agent) || agent.type === 'mcp',
      teamSize: key === null ? 0 : teamSize.get(key) ?? 0,
      sessionNeedsYou: key !== null && needsYou.has(key),
      idleForMs: agent.state === 'idle' && m.idleSince !== null ? env.now - m.idleSince : null,
    }
    const wish = wantedRoom(facts, open)

    if (wish.room === current) {
      if (m.wish) { nextMeta = { ...nextMeta, [agent.id]: { ...m, wish: undefined } }; changed = true }
      return agent
    }
    let since = m.wish?.room === wish.room ? m.wish.since : null
    if (since === null) {
      since = env.now
      nextMeta = { ...nextMeta, [agent.id]: { ...m, wish: { room: wish.room, since } } }
      changed = true
    }
    if (env.now - since < dwellMs(wish.reason)) return agent

    let moving: { agent: Agent; transfer: Transfer }
    if (wish.room === home) {
      moving = beginTransfer({ ...agent, visitSpotId: undefined }, home, agent.deskPosition, 'return', env)
    } else {
      taken ??= heldSpotIds(agents)
      const seat = visitSeat(wish.room, taken)
      if (!seat) return agent // full: stay put, ask again next frame
      taken.add(seat.id)
      moving = beginTransfer({ ...agent, visitSpotId: seat.id }, wish.room, { x: seat.x, y: seat.y }, 'visit', env)
    }
    nextMeta = { ...nextMeta, [agent.id]: { ...nextMeta[agent.id], wish: undefined, transfer: moving.transfer, arrivedAtDeskAt: null } }
    changed = true
    return { ...moving.agent, state: 'changing-room' as const }
  })

  return changed ? { agents: next, meta: nextMeta, changed } : { agents, meta, changed: false }
}
