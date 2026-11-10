/**
 * roomSwitcher.ts - the floor plan's model: which rooms it lists, who is in each, and which one calls for you.
 *
 * Pure (no React, no DOM, no clock): src/components/RoomSwitcher.tsx draws
 * what this returns and tests/roomSwitcher.test.ts checks it.
 *
 * The plan follows the building (src/rooms.ts): the corridor is a strip along
 * the bottom and the rooms stand side by side above it, left to right in the
 * order of their doors along the corridor's wall. A closed room (no art, see
 * src/roomAccess.ts) is left out, and with only the office open there is no
 * plan at all, so an office without the extra rooms shows nothing new.
 */

import type { Agent } from './types'
import { ROOMS, HUB_ROOM, OFFICE_ROOM, type RoomId } from './rooms'
import { roomOf } from './roomTransfer'
import { isHardNeedsYou, mainId } from './mainState'

/**
 * What a room's mark says. `needs-you`: a session in there waits on a person
 * (a permission dialog, a question). `trouble`: something went wrong in there
 * (a turn failed, a tool call failed, a red build, the office's incident).
 * needs-you wins when both hold, because only that one is waiting on you.
 */
export type RoomMark = 'needs-you' | 'trouble'

/** One agent's dot on the plan */
export interface PlanDot {
  id: string
  color: string
}

/** One room of the plan */
export interface PlanRoom {
  id: RoomId
  name: string
  /** The name on the plan's box, where there is room for one word */
  short: string
  /** The dots to draw: at most MAX_DOTS, in the office's agent order */
  dots: PlanDot[]
  /** Agents in the room beyond the dots drawn */
  more: number
  /** Everybody in the room (dots + more) */
  count: number
  mark: RoomMark | null
  /** The room the stage shows */
  current: boolean
  /** Where it sits on the plan: 'hub' is the corridor strip, 'room' one of the boxes above it */
  place: 'hub' | 'room'
}

/**
 * Dots drawn per room before the rest becomes "+n".
 * Why 8: two rows of four 4 px dots is what a plan box holds in the desktop's
 * compact mode (the room column can be as narrow as 302 px), and it covers
 * the meeting room's eight seats and the server room's six racks exactly.
 */
export const MAX_DOTS = 8

/** What the plan needs to know beyond the agents themselves */
export interface SwitcherFacts {
  /** The rooms in use (src/roomAccess.ts openRoomSet) */
  open: ReadonlySet<RoomId>
  /** The room the stage shows */
  view: RoomId
  /** Sessions with a permission card waiting in the chat column (src/permissions.ts) */
  pendingSessionIds?: readonly string[]
  /** The office is in incident mode (src/incident.ts): its room is in trouble whoever is in it */
  officeIncident?: boolean
}

/**
 * The side rooms in plan order: left to right as their doors stand along the
 * corridor, so the plan and the corridor's picture agree.
 * @returns the ids of every room that has a door onto the corridor
 */
export function planOrder(): RoomId[] {
  return [...ROOMS[HUB_ROOM].connections]
    .sort((a, b) => a.position.x - b.position.x)
    .map(c => c.toRoom)
}

/** Whether this agent, where it stands, needs a person */
function needsYou(agent: Agent, pending: ReadonlySet<string>): boolean {
  if (agent.state === 'completed') return false
  if (agent.mainState === 'needs-you' && isHardNeedsYou(agent.needsYou)) return true
  // Why only the session's Claude: a card belongs to a session, and the mark
  // should lead to one place, the room its Claude is in
  return !!agent.sessionId && agent.id === mainId(agent.sessionId) && pending.has(agent.sessionId)
}

/** Whether something went wrong for this agent */
function inTrouble(agent: Agent): boolean {
  if (agent.state === 'completed') return false
  return agent.mainState === 'error' || !!agent.lastFailed || agent.scene?.kind === 'red'
}

/**
 * The floor plan for the office as it stands.
 * @param agents everybody in the building
 * @param facts the open rooms, the room in view and what waits on the user
 * @returns the rooms to draw, the boxes first (plan order) and the corridor
 *   last; empty when only the office is open (draw no plan at all)
 */
export function switcherModel(agents: readonly Agent[], facts: SwitcherFacts): PlanRoom[] {
  const { open, view } = facts
  if (!open.has(HUB_ROOM)) return []
  const pending = new Set(facts.pendingSessionIds ?? [])
  // Why: a card for a session with no Claude in the building (it has not been
  // seated yet) still waits on you; the office is where it will turn up
  const seated = new Set(agents.filter(a => a.sessionId && a.id === mainId(a.sessionId)).map(a => a.sessionId!))
  const strayCard = [...pending].some(id => !seated.has(id))

  const ids = [...planOrder().filter(id => open.has(id)), HUB_ROOM]
  return ids.map(id => {
    const here = agents.filter(a => roomOf(a) === id)
    const dots = here.slice(0, MAX_DOTS).map(a => ({ id: a.id, color: a.color }))
    let mark: RoomMark | null = null
    if (here.some(inTrouble) || (id === OFFICE_ROOM && facts.officeIncident)) mark = 'trouble'
    if (here.some(a => needsYou(a, pending)) || (id === OFFICE_ROOM && strayCard)) mark = 'needs-you'
    return {
      id,
      name: ROOMS[id].name,
      short: id === OFFICE_ROOM ? 'Office' : ROOMS[id].name.replace(/ Room$/, ''),
      dots,
      more: here.length - dots.length,
      count: here.length,
      mark,
      current: id === view,
      place: id === HUB_ROOM ? 'hub' as const : 'room' as const,
    }
  })
}

/**
 * The room the stage should show: the one asked for while it is open, else
 * the office (a room can only close on a reload, but the fallback keeps a
 * stale choice from showing an empty stage).
 * @param wanted the room the user picked
 * @param open the rooms in use
 * @returns `wanted`, or the office when that room is closed
 */
export function viewableRoom(wanted: RoomId, open: ReadonlySet<RoomId>): RoomId {
  return open.has(wanted) ? wanted : OFFICE_ROOM
}

/**
 * The label a screen reader hears for a room's button.
 * @param room one room of the plan
 * @returns e.g. "Meeting Room, 3 people, needs you, in view"
 */
export function planRoomLabel(room: PlanRoom): string {
  const people = room.count === 0 ? 'empty' : room.count === 1 ? '1 person' : `${room.count} people`
  const mark = room.mark === 'needs-you' ? ', needs you' : room.mark === 'trouble' ? ', something went wrong' : ''
  return `${room.name}, ${people}${mark}${room.current ? ', in view' : ''}`
}
