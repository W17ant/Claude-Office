/**
 * src/roomTransfer.ts and the room branches of src/officeReducer.ts — who
 * walks to which room, through the corridor, driven in plain Node with the
 * same deterministic environment as tests/officeReducer.test.ts (fixed clock,
 * straight-line paths, a non-random random) plus `openRooms`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  reduceOffice, stepOffice, initialOfficeState, mcpWorkerId,
  MAIN_ROOM, DOOR_TARGET, BOSS_ID, CLAUDE_ID, MIN_VISIBLE_TIME, MCP_LINGER_MS, SHOUT_MS,
  moveAgentsForEvent, bossErrandGate,
  type OfficeState, type OfficeEnv, type OfficeEffect, type OfficeAction, type AgentMeta,
} from '../src/officeReducer'
import {
  beginTransfer, stepTransfer, planRoomMoves, heldSpotIds, roomOf, inOffice,
  CORRIDOR_PACE, TRANSFER_MAX_MS, FRONT_DOOR, standInside,
} from '../src/roomTransfer'
import { DWELL_MS, LUNCH_IDLE_MS, MEETING_MIN_WORKERS } from '../src/roomRules'
import { ROOMS, ROOM_IDS, HUB_ROOM, OFFICE_ROOM, doorTo, findSpot, type RoomId } from '../src/rooms'
import { openRoomSet } from '../src/roomAccess'
import { mainId } from '../src/mainState'
import { createAgent, WALK_SPEED, BREAK_MIN_DESK_TIME, BREAK_DURATION } from '../src/agentManager'
import { ROOMS_DEMO_SCRIPT, DEMO_LOOP_MS } from '../src/roomsDemo'
import type { Agent } from '../src/types'

// ---------------------------------------------------------------------------
// Harness (the one in tests/officeReducer.test.ts, with rooms)
// ---------------------------------------------------------------------------

const T0 = 1_000_000
const ALL: ReadonlySet<RoomId> = new Set(ROOM_IDS)
/** Frames per stepOffice call in `settle` and `walk` */
const DT = 3

/** A deterministic environment with every room open */
function env(over: Partial<OfficeEnv> = {}): OfficeEnv {
  return { now: T0, live: true, computePath: () => [], random: () => 0.5, openRooms: ALL, ...over }
}
/** The same environment as tests/officeReducer.test.ts: no rooms at all */
const closed = (over: Partial<OfficeEnv> = {}): OfficeEnv => env({ openRooms: undefined, ...over })
const at = (now: number, over: Partial<OfficeEnv> = {}) => env({ now, ...over })

// Why: the lines people say (agentManager's spawnMessage, workMessage, ...)
// are picked with Math.random, outside the reducer's own `env.random`. Pinned
// here so two runs of one script can be compared state for state.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5) })
afterEach(() => { vi.restoreAllMocks() })

const spot = (id: string) => MAIN_ROOM.agentSpots.find(s => s.id === id)!

/** An agent already sitting at its office desk */
function seated(id: string, role: string, spotId: string, over: Partial<Agent> = {}): Agent {
  const a = createAgent({ id, name: id, role, spot: spot(spotId), hiredAt: T0 })
  return { ...a, state: 'working', position: { ...a.deskPosition }, pathQueue: [], ...over }
}

/** The ?sim office: the boss and the decorative Claude */
const emptyOffice = (now = T0): OfficeState =>
  initialOfficeState([seated(BOSS_ID, 'boss', 'spot-1'), seated(CLAUDE_ID, 'assistant', 'spot-2')], now)
/** A live office: the boss alone, until the server names a session */
const liveOffice = (now = T0): OfficeState => initialOfficeState([seated(BOSS_ID, 'boss', 'spot-1')], now)

const S1 = { sessionId: 's1', project: 'office', cwd: '/home/me/office' }
const S2 = { sessionId: 's2', project: 'api', cwd: '/home/me/api' }

const spawn = (id: string, role = 'debugger'): OfficeAction =>
  ({ type: 'agent_spawned', agent: { id, name: id, role, task: `task ${id}` } })
const spawnFor = (id: string, s: { sessionId: string; project: string }, role = 'debugger'): OfficeAction =>
  ({ type: 'agent_spawned', agent: { id, name: id, role, task: `task ${id}` }, sessionId: s.sessionId, project: s.project })

function dispatchAll(state: OfficeState, actions: OfficeAction[], e = env()): { state: OfficeState; effects: OfficeEffect[] } {
  const effects: OfficeEffect[] = []
  for (const action of actions) {
    const r = reduceOffice(state, action, e)
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}

/** Run animation frames until nothing changes any more (everyone has arrived) */
function settle(state: OfficeState, e = env(), maxFrames = 6000): { state: OfficeState; effects: OfficeEffect[] } {
  const effects: OfficeEffect[] = []
  for (let i = 0; i < maxFrames; i++) {
    const r = stepOffice(state, DT, e)
    effects.push(...r.effects)
    if (!r.changed) return { state, effects }
    state = r.state
  }
  throw new Error(`office did not settle in ${maxFrames} frames`)
}

/** Run frames until `done` says so, returning every state on the way (the last one satisfies it) */
function walk(state: OfficeState, done: (s: OfficeState) => boolean, e = env(), maxFrames = 6000): OfficeState[] {
  const seen: OfficeState[] = []
  for (let i = 0; i < maxFrames; i++) {
    state = stepOffice(state, DT, e).state
    seen.push(state)
    if (done(state)) return seen
  }
  throw new Error(`never got there in ${maxFrames} frames`)
}

/** Run exactly n frames, returning every state on the way */
function frames(state: OfficeState, n: number, e = env()): OfficeState[] {
  const seen: OfficeState[] = []
  for (let i = 0; i < n; i++) {
    state = stepOffice(state, DT, e).state
    seen.push(state)
  }
  return seen
}

const agent = (s: OfficeState, id: string) => s.agents.find(a => a.id === id)
const claudeOf = (s: OfficeState, sid: string) => agent(s, mainId(sid))
const leg = (s: OfficeState, id: string) => s.meta[id]?.transfer?.leg
const sfx = (effects: OfficeEffect[]) => effects.filter(e => e.kind === 'sfx').map(e => (e as { sfx: string }).sfx)
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const door = (room: RoomId) => doorTo(room, HUB_ROOM)!
const hubDoor = (room: RoomId) => doorTo(HUB_ROOM, room)!

/** Session s1 with its Claude and n workers, everyone seated in the office */
function sessionOffice(n: number, e = env()): OfficeState {
  const ids = Array.from({ length: n }, (_, i) => `w${i + 1}`)
  const { state } = dispatchAll(liveOffice(), [{ type: 'session_started', ...S1 }, ...ids.map(id => spawnFor(id, S1))], e)
  return settle(state, e).state
}

/** Session s1's Claude and three workers, sitting in the meeting room (team rule, after its dwell) */
function inMeeting(): { state: OfficeState; now: number } {
  const now = T0 + DWELL_MS.team
  return { state: settle(sessionOffice(MEETING_MIN_WORKERS), at(now)).state, now }
}

// ---------------------------------------------------------------------------
// Closed until drawn
// ---------------------------------------------------------------------------

describe('with no room open nothing changes', () => {
  const script: OfficeAction[] = [
    { type: 'session_started', ...S1 },
    spawnFor('w1', S1), spawnFor('w2', S1), spawnFor('w3', S1),
    { type: 'mcp_call', server: 'github', tool: 'search_code', sessionId: 's1' },
    { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'rm -rf dist' },
  ]

  it('an office-only set of open rooms is the same as no set at all, state for state', () => {
    const officeOnly = env({ openRooms: openRoomSet([OFFICE_ROOM]) })
    const a = dispatchAll(liveOffice(), script, closed())
    const b = dispatchAll(liveOffice(), script, officeOnly)
    expect(b.state).toEqual(a.state)
    expect(b.effects).toEqual(a.effects)

    // ...and still the same after everyone has walked in and time has passed
    const later = T0 + LUNCH_IDLE_MS + DWELL_MS['needs-you']
    const sa = settle(settle(a.state, closed()).state, closed({ now: later })).state
    const sb = settle(settle(b.state, officeOnly).state, { ...officeOnly, now: later }).state
    expect(sb).toEqual(sa)
  })

  it('a newcomer starts at the office entry, an MCP call has no character, and nobody ever leaves the office', () => {
    const one = reduceOffice(liveOffice(), spawnFor('w1', S1), closed()).state
    expect(agent(one, 'w1')).toMatchObject({ state: 'new-hire', room: 'main-office', position: MAIN_ROOM.entryPoint })
    expect(one.meta.w1.transfer).toBeUndefined()

    const before = sessionOffice(0, closed())
    const call = reduceOffice(before, { type: 'mcp_call', server: 'github', tool: 'search_code', sessionId: 's1' }, closed())
    expect(call.state).toBe(before)
    expect(call.effects).toEqual([])

    // Every rule's condition at once (a team, a pending permission, a long idle): nobody moves
    const { state } = dispatchAll(liveOffice(), script, closed())
    for (const s of frames(state, 400, closed({ now: T0 + LUNCH_IDLE_MS * 2 }))) for (const a of s.agents) {
      expect(roomOf(a)).toBe(OFFICE_ROOM)
      expect(a.state).not.toBe('changing-room')
      expect(a.visitSpotId).toBeUndefined()
    }
  })

  it('a leaver walks to the office door and is gone there, as before', () => {
    const office = settle(reduceOffice(emptyOffice(), spawn('w1'), closed()).state, closed()).state
    const leaving = reduceOffice(office, { type: 'agent_completed', agentId: 'w1' }, closed({ now: T0 + MIN_VISIBLE_TIME })).state
    expect(agent(leaving, 'w1')).toMatchObject({ state: 'completed', room: 'main-office', targetPosition: DOOR_TARGET })
    expect(leaving.meta.w1.transfer).toBeUndefined()
    expect(agent(settle(leaving, closed()).state, 'w1')).toBeUndefined()
  })

  it('with the corridor open but no room behind it, people come and go by the front door and nobody visits anywhere', () => {
    const hallOnly = env({ openRooms: openRoomSet([OFFICE_ROOM, HUB_ROOM]) })
    const { state } = dispatchAll(liveOffice(), script, hallOnly)
    expect(agent(state, 'w1')).toMatchObject({ room: 'corridor', position: FRONT_DOOR })
    expect(agent(state, mcpWorkerId('github'))).toBeUndefined()
    const later = settle(settle(state, hallOnly).state, { ...hallOnly, now: T0 + LUNCH_IDLE_MS * 2 }).state
    for (const a of later.agents) expect(roomOf(a)).toBe(OFFICE_ROOM)
  })
})

// ---------------------------------------------------------------------------
// The walk itself
// ---------------------------------------------------------------------------

describe('a room change goes door, corridor, door', () => {
  it('office to server room, leg by leg (the transfer on its own)', () => {
    const e = env()
    const rack = findSpot('srv-2')!.spot
    const start = seated('w1', 'debugger', 'spot-5')
    const begun = beginTransfer({ ...start, visitSpotId: rack.id }, 'server-room', { x: rack.x, y: rack.y }, 'visit', e)

    // 1. Pointed at the office's own door, in the office
    expect(begun.transfer).toMatchObject({ to: 'server-room', leg: 'to-door', why: 'visit', target: { x: rack.x, y: rack.y } })
    expect(begun.agent.targetPosition).toEqual(door('main-office'))
    expect(roomOf(begun.agent)).toBe('main-office')

    let a = begun.agent
    let t: typeof begun.transfer | null = begun.transfer
    const legs: string[] = []
    const rooms: RoomId[] = []
    const jumps: Array<{ from: RoomId; to: RoomId; at: { x: number; y: number } }> = []
    for (let i = 0; i < 5000 && t; i++) {
      const before = a
      const pace = WALK_SPEED * DT * (t.leg === 'corridor' ? CORRIDOR_PACE : 1)
      const r = stepTransfer(a, t, DT, e)
      if (roomOf(r.agent) !== roomOf(before)) {
        jumps.push({ from: roomOf(before), to: roomOf(r.agent), at: { ...r.agent.position } })
      } else {
        // Inside one room it only ever walks: never further than one frame's pace
        expect(dist(before.position, r.agent.position)).toBeLessThanOrEqual(pace + 1e-9)
      }
      a = r.agent
      t = r.transfer
      if (t && legs[legs.length - 1] !== t.leg) legs.push(t.leg)
      if (rooms[rooms.length - 1] !== roomOf(a)) rooms.push(roomOf(a))
    }

    // 2. The three legs in order, through the corridor and nowhere else
    expect(t).toBeNull()
    expect(legs).toEqual(['to-door', 'corridor', 'to-spot'])
    expect(rooms).toEqual(['main-office', 'corridor', 'server-room'])
    // 3. The only two jumps are the hand-offs between two pictures of the same doorway
    expect(jumps).toEqual([
      { from: 'main-office', to: 'corridor', at: hubDoor('main-office') },
      { from: 'corridor', to: 'server-room', at: door('server-room') },
    ])
    // 4. It ends on its rack
    expect(a.position).toEqual({ x: rack.x, y: rack.y })
    expect(a.room).toBe('server-room')
  })

  it('the corridor is walked at twice the pace', () => {
    const e = env()
    const inHall: Agent = { ...seated('w1', 'debugger', 'spot-5'), room: HUB_ROOM, position: { ...hubDoor('main-office') } }
    const begun = beginTransfer(inHall, 'lunch-room', { x: 30, y: 68 }, 'visit', e)
    expect(begun.transfer.leg).toBe('corridor')            // already in the corridor: no first leg
    expect(begun.agent.targetPosition).toEqual(hubDoor('lunch-room'))
    const r = stepTransfer(begun.agent, begun.transfer, 1, e)
    expect(dist(inHall.position, r.agent.position)).toBeCloseTo(WALK_SPEED * CORRIDOR_PACE, 10)
  })

  it('the cap: out of budget, the rest of the corridor is skipped (door to door), the walks inside rooms never', () => {
    const rack = findSpot('srv-1')!.spot
    const start = seated('w1', 'debugger', 'spot-5')
    const begun = beginTransfer(start, 'server-room', { x: rack.x, y: rack.y }, 'visit', at(T0))
    // The budget leaves room for the last leg
    expect(begun.transfer.corridorBy).toBeLessThan(T0 + TRANSFER_MAX_MS)
    expect(begun.transfer.corridorBy).toBeGreaterThan(T0)
    const late = at(begun.transfer.corridorBy)

    // In the first leg the clock running out changes nothing: it keeps walking across the office
    const first = stepTransfer(begun.agent, begun.transfer, DT, late)
    expect(roomOf(first.agent)).toBe('main-office')
    expect(dist(start.position, first.agent.position)).toBeCloseTo(WALK_SPEED * DT, 10)

    // Reaching the office door out of budget: handed straight to the server room's door
    const atDoor: Agent = { ...begun.agent, position: { ...door('main-office') } }
    const through = stepTransfer(atDoor, begun.transfer, DT, late)
    expect(through.agent).toMatchObject({ room: 'server-room', position: door('server-room') })
    expect(through.transfer?.leg).toBe('to-spot')

    // Mid-corridor out of budget: the same
    const inHall: Agent = { ...begun.agent, room: HUB_ROOM, position: { x: 30, y: 50 }, targetPosition: { ...hubDoor('server-room') } }
    const skipped = stepTransfer(inHall, { ...begun.transfer, leg: 'corridor' }, DT, late)
    expect(skipped.agent).toMatchObject({ room: 'server-room', position: door('server-room') })

    // The last leg is never shortened
    const last = stepTransfer(skipped.agent, skipped.transfer!, DT, at(T0 + TRANSFER_MAX_MS * 10))
    expect(dist(skipped.agent.position, last.agent.position)).toBeCloseTo(WALK_SPEED * DT, 10)
  })

  it('every corridor crossing fits the budget with room to spare for both rooms', () => {
    // ms to walk the corridor between two of its doors at CORRIDOR_PACE (60 frames a second)
    const crossing = (a: { x: number; y: number }, b: { x: number; y: number }) => (dist(a, b) / (WALK_SPEED * CORRIDOR_PACE * 60)) * 1000
    const doors = ROOM_IDS.filter(r => r !== HUB_ROOM).map(hubDoor)
    const longest = Math.max(...[FRONT_DOOR, ...doors].flatMap(a => doors.map(b => crossing(a, b))))
    expect(longest).toBeLessThan(TRANSFER_MAX_MS / 2)
    expect(TRANSFER_MAX_MS).toBeLessThan(MIN_VISIBLE_TIME)
  })
})

// ---------------------------------------------------------------------------
// In and out by the front door
// ---------------------------------------------------------------------------

describe('with the corridor open the front door is the way in and out', () => {
  it('a new hire appears at the front door, walks the corridor to the office door and from there to its desk', () => {
    const { state, effects } = reduceOffice(emptyOffice(), spawn('w1'), env())
    const hired = agent(state, 'w1')!
    expect(hired).toMatchObject({ state: 'new-hire', room: 'corridor', assignedRoom: 'main-office', position: FRONT_DOOR })
    expect(hired.targetPosition).toEqual(hubDoor('main-office'))
    expect(state.meta.w1.transfer).toMatchObject({ to: 'main-office', leg: 'corridor', why: 'arrive', target: hired.deskPosition })
    expect(sfx(effects)).toEqual([])  // arrivals are seen, not heard

    // Down the corridor, then handed into the office at its door, still a new hire
    const steps = walk(state, s => roomOf(agent(s, 'w1')!) === OFFICE_ROOM)
    for (const s of steps.slice(0, -1)) expect(agent(s, 'w1')).toMatchObject({ room: 'corridor', state: 'new-hire' })
    const inside = steps[steps.length - 1]
    expect(agent(inside, 'w1')).toMatchObject({ state: 'new-hire', position: door('main-office'), targetPosition: hired.deskPosition })
    expect(inside.meta.w1.transfer).toBeUndefined()

    // From the door on it is the walk-in the office has always had
    const { state: sat } = settle(inside)
    expect(agent(sat, 'w1')).toMatchObject({ state: 'working', room: 'main-office', position: hired.deskPosition })
    expect(sat.meta.w1.arrivedAtDeskAt).toBe(T0)
  })

  it("a session's Claude comes in the same way", () => {
    const { state } = reduceOffice(liveOffice(), { type: 'session_started', ...S1 }, env())
    expect(claudeOf(state, 's1')).toMatchObject({ room: 'corridor', position: FRONT_DOOR })
    const sat = settle(state).state
    expect(claudeOf(sat, 's1')).toMatchObject({ room: 'main-office', state: 'idle', position: claudeOf(sat, 's1')!.deskPosition })
  })

  it('someone waiting for a desk waits in the office lobby, and is seated once a desk is free', () => {
    // Nine desks for hires: of the office's eleven one is the boss's and one is kept for a session's Claude
    const ids = Array.from({ length: 10 }, (_, i) => `w${i + 1}`)
    const hired = dispatchAll(liveOffice(), ids.map(id => spawn(id))).state
    // It too comes in by the front door, and is only queued for a desk once it is in the office
    expect(agent(hired, 'w10')).toMatchObject({ state: 'waiting', room: 'corridor', position: FRONT_DOOR })
    const full = settle(hired).state
    expect(agent(full, 'w10')).toMatchObject({ state: 'waiting', room: 'main-office' })
    expect(agent(full, 'w10')!.assignedSpotId).toBeUndefined()
    expect(full.meta.w10.transfer).toBeUndefined()

    const freed = reduceOffice(full, { type: 'agent_completed', agentId: 'w1' }, at(T0 + MIN_VISIBLE_TIME)).state
    const after = settle(freed, at(T0 + MIN_VISIBLE_TIME)).state
    expect(agent(after, 'w1')).toBeUndefined()
    expect(agent(after, 'w10')).toMatchObject({ state: 'working', room: 'main-office', assignedSpotId: agent(full, 'w1')!.assignedSpotId })
  })

  it('a leaver crosses the office to its door, then the corridor to the front door, and is gone there and not before', () => {
    const office = settle(reduceOffice(emptyOffice(), spawn('w1'), env()).state).state
    const now = T0 + MIN_VISIBLE_TIME
    const leaving = reduceOffice(office, { type: 'agent_completed', agentId: 'w1' }, at(now)).state
    expect(agent(leaving, 'w1')).toMatchObject({ state: 'completed', room: 'main-office', targetPosition: door('main-office') })
    expect(leaving.meta.w1.transfer).toMatchObject({ to: 'corridor', leg: 'to-door', why: 'leave', target: FRONT_DOOR })

    // Why this matters: the office door used to be where a leaver vanished
    const steps = walk(leaving, s => !agent(s, 'w1'), at(now))
    const rooms = steps.map(s => agent(s, 'w1')).filter(Boolean).map(a => roomOf(a!))
    expect([...new Set(rooms)]).toEqual(['main-office', 'corridor'])
    const lastSeen = [...steps].reverse().find(s => agent(s, 'w1'))!
    expect(dist(agent(lastSeen, 'w1')!.position, FRONT_DOOR)).toBeLessThan(2)   // a step or two short of it
    // Its desk was free from the moment it got up
    expect(heldSpotIds(leaving.agents).has(agent(office, 'w1')!.assignedSpotId!)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Server room: MCP servers' workers
// ---------------------------------------------------------------------------

describe('the server room: one worker per MCP server while its calls run', () => {
  const call = (server: string, sessionId = 's1', tool = 'search_code'): OfficeAction => ({ type: 'mcp_call', server, tool, sessionId })
  const done = (server: string, sessionId = 's1'): OfficeAction => ({ type: 'mcp_done', server, sessionId })
  const GH = mcpWorkerId('github')

  it('the first call brings the worker in by the front door to a rack; its status shows when it gets there', () => {
    const { state, effects } = reduceOffice(sessionOffice(0), call('github'), env())
    const w = agent(state, GH)!
    expect(w).toMatchObject({ type: 'mcp', role: 'github', room: 'corridor', assignedRoom: 'server-room', assignedSpotId: 'srv-1', position: FRONT_DOOR })
    expect(w.targetPosition).toEqual(hubDoor('server-room'))
    expect(state.meta[GH]).toMatchObject({ mcpBusy: ['s1'], mcpIdleSince: null })
    expect(state.meta[GH].transfer).toMatchObject({ to: 'server-room', leg: 'corridor', why: 'arrive' })
    expect(effects).toEqual([])

    const steps = walk(state, s => agent(s, GH)!.state === 'working')
    expect([...new Set(steps.map(s => roomOf(agent(s, GH)!)))]).toEqual(['corridor', 'server-room'])
    const sat = steps[steps.length - 1]
    const rack = findSpot('srv-1')!.spot
    expect(agent(sat, GH)).toMatchObject({ room: 'server-room', position: { x: rack.x, y: rack.y }, statusText: 'github.search_code' })
    // It is nobody's office colleague
    expect(inOffice(agent(sat, GH)!)).toBe(false)
  })

  it('later calls, from any session, go to the same worker; it stands by only when the last one is done', () => {
    let state = settle(reduceOffice(sessionOffice(0), call('github'), env()).state).state
    state = reduceOffice(state, call('github', 's2', 'list_issues'), env()).state
    expect(state.agents.filter(a => a.type === 'mcp')).toHaveLength(1)
    expect(agent(state, GH)!.statusText).toBe('github.list_issues')
    expect(state.meta[GH].mcpBusy).toEqual(['s1', 's2'])

    const first = reduceOffice(state, done('github', 's1'), at(T0 + 1000))
    expect(first.effects).toEqual([])
    expect(agent(first.state, GH)!.statusText).toBe('github.list_issues')

    const last = reduceOffice(first.state, done('github', 's2'), at(T0 + 2000))
    expect(agent(last.state, GH)).toMatchObject({ state: 'working', statusText: 'standing by' })
    expect(last.state.meta[GH]).toMatchObject({ mcpBusy: [], mcpIdleSince: T0 + 2000 })
    expect(last.effects).toEqual([
      { kind: 'schedule', action: { type: 'mcp_worker_leave', agentId: GH, idleSince: T0 + 2000 }, delayMs: MCP_LINGER_MS },
    ])
  })

  it('a call inside the linger keeps it: the old timer is stale; left alone it walks out by the front door', () => {
    let state = settle(reduceOffice(sessionOffice(0), call('github'), env()).state).state
    state = reduceOffice(state, done('github'), at(T0 + 2000)).state
    const leave1: OfficeAction = { type: 'mcp_worker_leave', agentId: GH, idleSince: T0 + 2000 }

    // Busy again before the timer fires
    const busy = reduceOffice(state, call('github'), at(T0 + 5000)).state
    expect(busy.meta[GH].mcpIdleSince).toBeNull()
    expect(reduceOffice(busy, leave1, at(T0 + 2000 + MCP_LINGER_MS)).state).toBe(busy)

    // Idle again: the first spell's timer is still stale, the second one's is not
    const idle = reduceOffice(busy, done('github'), at(T0 + 9000)).state
    expect(reduceOffice(idle, leave1, at(T0 + 2000 + MCP_LINGER_MS)).state).toBe(idle)
    const now = T0 + 9000 + MCP_LINGER_MS
    const leaving = reduceOffice(idle, { type: 'mcp_worker_leave', agentId: GH, idleSince: T0 + 9000 }, at(now)).state
    expect(agent(leaving, GH)).toMatchObject({ state: 'completed', room: 'server-room', targetPosition: door('server-room') })
    expect(leaving.meta[GH].transfer).toMatchObject({ to: 'corridor', why: 'leave' })

    const steps = walk(leaving, s => !agent(s, GH), at(now))
    expect([...new Set(steps.map(s => agent(s, GH)).filter(Boolean).map(a => roomOf(a!)))]).toEqual(['server-room', 'corridor'])
    // Its rack is free for the next server
    const next = reduceOffice(steps[steps.length - 1], call('postgres'), at(now)).state
    expect(agent(next, mcpWorkerId('postgres'))!.assignedSpotId).toBe('srv-1')
  })

  it('a full room: six racks, so a seventh server gets no character and nothing else changes', () => {
    const servers = ['github', 'postgres', 'sentry', 'slack', 'linear', 'figma']
    const { state } = dispatchAll(sessionOffice(0), servers.map(s => call(s)))
    expect(state.agents.filter(a => a.type === 'mcp').map(a => a.assignedSpotId)).toEqual(['srv-1', 'srv-2', 'srv-3', 'srv-4', 'srv-5', 'srv-6'])

    const seventh = reduceOffice(state, call('notion'), env())
    expect(seventh.state).toBe(state)
    expect(seventh.effects).toEqual([])
    // ...and its mcp_done is as harmless
    expect(reduceOffice(state, done('notion'), env()).state).toBe(state)

    const sat = settle(state).state
    for (const s of servers) expect(agent(sat, mcpWorkerId(s))).toMatchObject({ room: 'server-room', state: 'working' })
  })

  it('a worker stays in the server room: no meeting, no lunch, no coffee break, no office desk taken', () => {
    const state = settle(reduceOffice(sessionOffice(3), call('github'), env()).state).state
    const worker = agent(state, GH)!
    expect(MAIN_ROOM.agentSpots.some(s => s.id === worker.assignedSpotId)).toBe(false)
    // A long time later, with a random that always says "take a break"
    const later = settle(state, at(T0 + LUNCH_IDLE_MS * 3, { random: () => 0 })).state
    expect(agent(later, GH)).toMatchObject({ room: 'server-room', state: 'working' })
    expect(agent(later, GH)!.visitSpotId).toBeUndefined()
  })

  it('the server room closed: the call has no character, as before rooms', () => {
    const noServers = env({ openRooms: openRoomSet([OFFICE_ROOM, HUB_ROOM, 'meeting-room', 'lunch-room']) })
    const before = sessionOffice(0, noServers)
    expect(reduceOffice(before, call('github'), noServers).state).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Meeting room
// ---------------------------------------------------------------------------

describe("the meeting room: a session's team, or a session waiting on you", () => {
  const team = ['w1', 'w2', 'w3']
  const everyone = [mainId('s1'), ...team]

  it('three workers of one session: the wish has to hold for its dwell, then they and their Claude walk over', () => {
    const office = sessionOffice(3)
    for (const id of everyone) {
      expect(agent(office, id)).toMatchObject({ room: 'main-office' })
      expect(office.meta[id].wish).toEqual({ room: 'meeting-room', since: T0 })
    }
    // A moment short of the dwell: still at their desks
    const early = settle(office, at(T0 + DWELL_MS.team - 1)).state
    for (const id of everyone) expect(agent(early, id)!.state).not.toBe('changing-room')

    // The dwell is up: all four get up in the same frame, each with a seat of its own
    const up = stepOffice(office, DT, at(T0 + DWELL_MS.team)).state
    for (const id of everyone) {
      expect(agent(up, id)).toMatchObject({ state: 'changing-room', room: 'main-office', targetPosition: door('main-office') })
      expect(up.meta[id].transfer).toMatchObject({ to: 'meeting-room', leg: 'to-door', why: 'visit' })
      expect(up.meta[id].wish).toBeUndefined()
    }
    expect(everyone.map(id => agent(up, id)!.visitSpotId).sort()).toEqual(['meet-1', 'meet-2', 'meet-3', 'meet-4'])
  })

  it('one of them, step by step through the stepper: office door, corridor, meeting-room door, seat', () => {
    const now = T0 + DWELL_MS.team
    const steps = walk(sessionOffice(3), s => agent(s, 'w1')!.state === 'working' && roomOf(agent(s, 'w1')!) === 'meeting-room', at(now))
    const legs: string[] = []
    const rooms: RoomId[] = []
    for (const s of steps) {
      const l = leg(s, 'w1')
      if (l && legs[legs.length - 1] !== l) legs.push(l)
      const r = roomOf(agent(s, 'w1')!)
      if (rooms[rooms.length - 1] !== r) rooms.push(r)
      // The inspector has a word for it the whole way
      if (l) expect(agent(s, 'w1')!.state).toBe('changing-room')
    }
    expect(legs).toEqual(['to-door', 'corridor', 'to-spot'])
    expect(rooms).toEqual(['main-office', 'corridor', 'meeting-room'])

    // The hand-offs happen at the doors
    const firstInHall = steps.find(s => roomOf(agent(s, 'w1')!) === HUB_ROOM)!
    expect(agent(firstInHall, 'w1')!.position).toEqual(hubDoor('main-office'))
    const firstInRoom = steps.find(s => roomOf(agent(s, 'w1')!) === 'meeting-room')!
    expect(agent(firstInRoom, 'w1')!.position).toEqual(door('meeting-room'))

    const sat = steps[steps.length - 1]
    const seat = findSpot(agent(sat, 'w1')!.visitSpotId)!
    expect(seat.room).toBe('meeting-room')
    expect(agent(sat, 'w1')!.position).toEqual({ x: seat.spot.x, y: seat.spot.y })
    expect(sat.meta.w1.transfer).toBeUndefined()
    // Not at its desk: no coffee break is due from here
    expect(sat.meta.w1.arrivedAtDeskAt).toBeNull()
  })

  it('a visitor keeps its desk: nobody hired meanwhile is given it', () => {
    const { state, now } = inMeeting()
    const desks = everyone.map(id => agent(state, id)!.assignedSpotId!)
    for (const id of everyone) expect(agent(state, id)).toMatchObject({ room: 'meeting-room', assignedRoom: 'main-office' })
    expect(claudeOf(state, 's1')!.state).toBe('idle')

    const hired = reduceOffice(state, spawnFor('x1', S2), at(now)).state
    expect(desks).not.toContain(agent(hired, 'x1')!.assignedSpotId)
    // A status for a visitor shows where it sits
    const told = reduceOffice(state, { type: 'agent_working', agentId: 'w1', status: 'reading rooms.ts' }, at(now)).state
    expect(agent(told, 'w1')).toMatchObject({ room: 'meeting-room', statusText: 'reading rooms.ts' })
  })

  it('no ping-pong: down to two they stay, down to one they go back to their desks after a dwell', () => {
    const { state } = inMeeting()
    const t1 = T0 + MIN_VISIBLE_TIME
    // One finishes: two left, the meeting goes on
    const two = settle(reduceOffice(state, { type: 'agent_completed', agentId: 'w3' }, at(t1)).state, at(t1)).state
    expect(agent(two, 'w3')).toBeUndefined()
    const stillTwo = settle(two, at(t1 + DWELL_MS.home * 4)).state
    for (const id of [mainId('s1'), 'w1', 'w2']) expect(agent(stillTwo, id)).toMatchObject({ room: 'meeting-room' })

    // Another: one left. The wish to go home has to hold for its dwell first
    const t2 = t1 + 20_000
    const one = settle(reduceOffice(stillTwo, { type: 'agent_completed', agentId: 'w2' }, at(t2)).state, at(t2)).state
    expect(agent(one, 'w1')).toMatchObject({ room: 'meeting-room', state: 'working' })
    expect(one.meta.w1.wish).toEqual({ room: 'main-office', since: t2 })

    const back = stepOffice(one, DT, at(t2 + DWELL_MS.home)).state
    expect(agent(back, 'w1')).toMatchObject({ state: 'changing-room', targetPosition: door('meeting-room') })
    expect(agent(back, 'w1')!.visitSpotId).toBeUndefined()          // the seat is free at once
    expect(back.meta.w1.transfer).toMatchObject({ to: 'main-office', why: 'return', target: agent(back, 'w1')!.deskPosition })

    const home = settle(back, at(t2 + DWELL_MS.home)).state
    for (const id of [mainId('s1'), 'w1']) {
      expect(agent(home, id)).toMatchObject({ room: 'main-office', position: agent(home, id)!.deskPosition })
      expect(agent(home, id)!.visitSpotId).toBeUndefined()
    }
    expect(agent(home, 'w1')!.state).toBe('working')
    expect(home.meta.w1.arrivedAtDeskAt).toBe(t2 + DWELL_MS.home)  // back at its desk: breaks are due again
  })

  it('a session waiting on a permission: its Claude goes to the meeting room after the longer dwell, and back once answered', () => {
    const asked = reduceOffice(sessionOffice(0), { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'rm -rf dist' }, env()).state
    const waiting = settle(asked).state
    expect(claudeOf(waiting, 's1')).toMatchObject({ room: 'main-office', mainState: 'needs-you' })
    // Why the longer dwell: most permission prompts are answered within seconds
    expect(claudeOf(settle(waiting, at(T0 + DWELL_MS['needs-you'] - 1)).state, 's1')!.room).toBe('main-office')

    const now = T0 + DWELL_MS['needs-you']
    const met = settle(waiting, at(now)).state
    expect(claudeOf(met, 's1')).toMatchObject({ room: 'meeting-room', visitSpotId: 'meet-1', mainState: 'needs-you' })

    // Answered: the turn goes on, and it walks back
    const answered = reduceOffice(met, { type: 'session_tool_done', ...S1, toolName: 'Bash' }, at(now + 1000)).state
    expect(claudeOf(answered, 's1')!.mainState).not.toBe('needs-you')
    const home = settle(settle(answered, at(now + 1000)).state, at(now + 1000 + DWELL_MS.home)).state
    expect(claudeOf(home, 's1')).toMatchObject({ room: 'main-office', position: claudeOf(home, 's1')!.deskPosition })
  })

  it('agents without a session never make a team (the ?sim staff would otherwise all walk out)', () => {
    const { state } = dispatchAll(emptyOffice(), ['a', 'b', 'c', 'd'].map(id => spawn(id)))
    const sat = settle(state).state
    const later = settle(sat, at(T0 + DWELL_MS.team * 3)).state
    for (const a of later.agents) expect(roomOf(a)).toBe(OFFICE_ROOM)
    for (const id of ['a', 'b', 'c', 'd']) expect(later.meta[id].wish).toBeUndefined()
  })

  it('a full room: nobody sets off without a seat; the first seat to come free is taken', () => {
    const meta = (wishSince: number | null): AgentMeta => ({
      spawnedAt: T0, arrivedAtDeskAt: T0, idleSince: null, onBreak: false, breakStartedAt: null,
      ...(wishSince === null ? {} : { wish: { room: 'meeting-room' as RoomId, since: wishSince } }),
    })
    // Eight visitors from elsewhere hold every seat (desks spot-3, spot-4 between them do not matter here)
    const sitters = ROOMS['meeting-room'].agentSpots.map((s, i) =>
      seated(`v${i}`, 'debugger', 'spot-3', { room: 'meeting-room', visitSpotId: s.id, assignedSpotId: undefined, sessionId: 'other' }))
    const workers = ['w1', 'w2', 'w3'].map((id, i) => seated(id, 'debugger', `spot-${5 + i}`, { sessionId: 's1' }))
    const metas = Object.fromEntries(workers.map(w => [w.id, meta(T0)]))
    const e = at(T0 + DWELL_MS.team)

    const full = planRoomMoves([...sitters, ...workers], metas, e, () => false)
    expect(full.changed).toBe(false)
    for (const w of workers) expect(full.agents.find(a => a.id === w.id)).toBe(w)   // untouched: still working at its desk

    // One sitter leaves: exactly one worker goes, to that seat
    const freed = planRoomMoves([...sitters.slice(1), ...workers], metas, e, () => false)
    const moved = freed.agents.filter(a => a.state === 'changing-room')
    expect(moved.map(a => a.id)).toEqual(['w1'])
    expect(moved[0].visitSpotId).toBe('meet-1')
    expect(freed.meta.w1.transfer).toMatchObject({ to: 'meeting-room', why: 'visit' })
    expect(freed.meta.w2.transfer).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Finishing on the way
// ---------------------------------------------------------------------------

describe('an agent that completes in the middle of a room change', () => {
  it('in the corridor: it turns for the front door, its seat and its desk are free, the others carry on', () => {
    const now = T0 + MIN_VISIBLE_TIME
    const steps = walk(sessionOffice(3), s => leg(s, 'w1') === 'corridor', at(now))
    const mid = steps[steps.length - 1]
    const seat = agent(mid, 'w1')!.visitSpotId!
    const desk = agent(mid, 'w1')!.assignedSpotId!
    expect(heldSpotIds(mid.agents).has(seat)).toBe(true)

    const { state: leaving } = reduceOffice(mid, { type: 'agent_completed', agentId: 'w1' }, at(now))
    expect(agent(leaving, 'w1')).toMatchObject({ state: 'completed', room: 'corridor', targetPosition: FRONT_DOOR })
    expect(agent(leaving, 'w1')!.visitSpotId).toBeUndefined()
    expect(leaving.meta.w1.transfer).toMatchObject({ to: 'corridor', leg: 'corridor', why: 'leave' })
    expect(heldSpotIds(leaving.agents).has(seat)).toBe(false)
    expect(heldSpotIds(leaving.agents).has(desk)).toBe(false)

    // It never enters the meeting room, and is gone at the front door
    const rest = walk(leaving, s => !agent(s, 'w1'), at(now))
    for (const s of rest) if (agent(s, 'w1')) expect(roomOf(agent(s, 'w1')!)).toBe(HUB_ROOM)

    // Two workers are left, already on their way: the meeting they set off for still happens
    const end = settle(rest[rest.length - 1], at(now)).state
    for (const id of ['w2', 'w3']) expect(agent(end, id)).toMatchObject({ room: 'meeting-room', state: 'working' })
  })

  it('still crossing the office: it goes on to the office door and out through the corridor', () => {
    const now = T0 + MIN_VISIBLE_TIME
    const up = stepOffice(sessionOffice(3), DT, at(now)).state
    expect(leg(up, 'w2')).toBe('to-door')
    const leaving = reduceOffice(up, { type: 'agent_completed', agentId: 'w2' }, at(now)).state
    expect(agent(leaving, 'w2')).toMatchObject({ state: 'completed', room: 'main-office', targetPosition: door('main-office') })
    expect(leaving.meta.w2.transfer).toMatchObject({ to: 'corridor', leg: 'to-door', why: 'leave' })
    expect(agent(settle(leaving, at(now)).state, 'w2')).toBeUndefined()
  })

  it('sitting in another room: it leaves from there', () => {
    const { state } = inMeeting()
    const now = T0 + MIN_VISIBLE_TIME
    const leaving = reduceOffice(state, { type: 'agent_completed', agentId: 'w1' }, at(now)).state
    expect(agent(leaving, 'w1')).toMatchObject({ state: 'completed', room: 'meeting-room', targetPosition: door('meeting-room') })
    const steps = walk(leaving, s => !agent(s, 'w1'), at(now))
    expect([...new Set(steps.map(s => agent(s, 'w1')).filter(Boolean).map(a => roomOf(a!)))]).toEqual(['meeting-room', 'corridor'])
  })

  it('a session that ends takes its Claude out of whichever room it is in', () => {
    const { state, now } = inMeeting()
    const t1 = now + MIN_VISIBLE_TIME
    const ended = reduceOffice(state, { type: 'session_ended', ...S1 }, at(t1)).state
    // The grace for a resume: it stays where it sits
    expect(claudeOf(ended, 's1')).toMatchObject({ state: 'idle', room: 'meeting-room' })
    const left = reduceOffice(ended, { type: 'session_claude_leave', sessionId: 's1', endedAt: t1 }, at(t1)).state
    expect(claudeOf(left, 's1')).toMatchObject({ state: 'completed', room: 'meeting-room', targetPosition: door('meeting-room') })
    expect(left.meta[mainId('s1')].transfer).toMatchObject({ to: 'corridor', why: 'leave' })
    expect(claudeOf(settle(left, at(t1)).state, 's1')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Lunch room
// ---------------------------------------------------------------------------

describe('the lunch room: breaks, and a Claude with nothing to do', () => {
  /** A random that says "take a break" (and "water", < 0.35) */
  const thirsty = () => 0

  it("a worker's break is taken at the lunch room's cooler, and it walks back to its desk afterwards", () => {
    const office = settle(reduceOffice(liveOffice(), spawn('w1'), env()).state).state
    const t1 = T0 + BREAK_MIN_DESK_TIME
    const off = stepOffice(office, DT, at(t1, { random: thirsty }))
    const w = agent(off.state, 'w1')!
    expect(w).toMatchObject({ state: 'changing-room', room: 'main-office', visitSpotId: 'lunch-water', targetPosition: door('main-office') })
    expect(off.state.meta.w1.transfer).toMatchObject({ to: 'lunch-room', why: 'break' })
    expect(sfx(off.effects)).toEqual([])  // a break is seen, not heard

    // The boss keeps his break at the office machine
    expect(roomOf(agent(off.state, BOSS_ID)!)).toBe(OFFICE_ROOM)
    expect(off.state.meta[BOSS_ID].transfer).toBeUndefined()

    const there = walk(off.state, s => agent(s, 'w1')!.state === 'coffee-break', at(t1))
    const arrived = there[there.length - 1]
    const cooler = findSpot('lunch-water')!.spot
    expect(agent(arrived, 'w1')).toMatchObject({ room: 'lunch-room', position: { x: cooler.x, y: cooler.y } })
    expect(arrived.meta.w1).toMatchObject({ onBreak: true, breakStartedAt: t1 })

    // The break lasts as long as one at the office machine, then the way back
    const t2 = t1 + BREAK_DURATION
    const back = stepOffice(arrived, DT, at(t2)).state
    expect(agent(back, 'w1')).toMatchObject({ state: 'changing-room', room: 'lunch-room' })
    expect(agent(back, 'w1')!.visitSpotId).toBeUndefined()
    expect(back.meta.w1.transfer).toMatchObject({ to: 'main-office', why: 'return' })
    const home = settle(back, at(t2)).state
    expect(agent(home, 'w1')).toMatchObject({ state: 'working', room: 'main-office', position: agent(home, 'w1')!.deskPosition })
  })

  it('two setting off in the same frame get different places; with every place taken the office machine is used', () => {
    // The ?sim office: its decorative Claude takes breaks like anyone (it always has), the boss does not come
    const { state } = dispatchAll(emptyOffice(), [spawn('w1'), spawn('w2')])
    const office = settle(state).state
    const t1 = T0 + BREAK_MIN_DESK_TIME
    const off = stepOffice(office, DT, at(t1, { random: thirsty })).state
    expect([CLAUDE_ID, 'w1', 'w2'].map(id => agent(off, id)!.visitSpotId)).toEqual(['lunch-water', 'lunch-1', 'lunch-2'])
    expect(agent(off, BOSS_ID)!.visitSpotId).toBeUndefined()

    // Every lunch place held by someone else: today's break at the office cooler
    const holders = ROOMS['lunch-room'].agentSpots.map((s, i) =>
      seated(`v${i}`, 'debugger', 'spot-3', { room: 'lunch-room', visitSpotId: s.id, assignedSpotId: undefined }))
    const crowded: OfficeState = { ...office, agents: [...office.agents, ...holders] }
    const local = stepOffice(crowded, DT, at(t1, { random: thirsty })).state
    expect(agent(local, 'w1')).toMatchObject({ room: 'main-office' })
    expect(agent(local, 'w1')!.state).not.toBe('changing-room')
    expect(agent(local, 'w1')!.visitSpotId).toBeUndefined()
  })

  it('the lunch room closed: the office coffee and water spots are used, as today', () => {
    const noLunch = openRoomSet([OFFICE_ROOM, HUB_ROOM, 'meeting-room', 'server-room'])
    const office = settle(reduceOffice(emptyOffice(), spawn('w1'), env({ openRooms: noLunch })).state, env({ openRooms: noLunch })).state
    const t1 = T0 + BREAK_MIN_DESK_TIME
    const withRooms = stepOffice(office, DT, at(t1, { random: thirsty, openRooms: noLunch })).state
    const without = stepOffice(office, DT, at(t1, { random: thirsty, openRooms: undefined })).state
    // The line it says is picked at random (agentManager): everything else is the same
    const quiet = (a: Agent) => ({ ...a, statusText: '' })
    expect(quiet(agent(withRooms, 'w1')!)).toEqual(quiet(agent(without, 'w1')!))
    expect(agent(withRooms, 'w1')).toMatchObject({ state: 'coffee-break', room: 'main-office' })
    expect(withRooms.meta.w1).toEqual(without.meta.w1)
  })

  it("a session's Claude idle for two minutes goes to sit in the lunch room, and a prompt brings it back", () => {
    // Idle is counted from the end of a turn; a Claude that has not had one yet stays at its desk
    const fresh = sessionOffice(0)
    expect(claudeOf(settle(fresh, at(T0 + LUNCH_IDLE_MS * 2)).state, 's1')!.room).toBe('main-office')
    const office = reduceOffice(fresh, { type: 'session_turn_end', ...S1 }, env()).state
    expect(claudeOf(settle(office, at(T0 + LUNCH_IDLE_MS - 1)).state, 's1')!.room).toBe('main-office')

    const t1 = T0 + LUNCH_IDLE_MS
    const lunch = settle(office, at(t1)).state
    expect(claudeOf(lunch, 's1')).toMatchObject({ room: 'lunch-room', state: 'idle', visitSpotId: 'lunch-1' })

    // The prompt reaches it there: the boss shouts it from his desk and Claude hears it in the lunch room
    const boss = agent(lunch, BOSS_ID)!
    const prompted = reduceOffice(lunch, { type: 'session_prompt', ...S1, text: 'back to work', promptId: 'p1' }, at(t1 + 1000))
    expect(agent(prompted.state, BOSS_ID)).toEqual({ ...boss, callout: { kind: 'shout', text: 'back to work', seq: lunch.shoutSeq + 1 } })
    expect(claudeOf(prompted.state, 's1')).toMatchObject({ mainState: 'working', room: 'lunch-room', callout: { kind: 'heard', text: '!' } })

    const home = settle(settle(prompted.state, at(t1 + 1000)).state, at(t1 + 1000 + DWELL_MS.home)).state
    expect(claudeOf(home, 's1')).toMatchObject({ room: 'main-office', state: 'working', position: claudeOf(home, 's1')!.deskPosition })
  })
})

// ---------------------------------------------------------------------------
// What stays the office's own
// ---------------------------------------------------------------------------

describe('the office keeps its own business', () => {
  it('the shouted prompt is the same with rooms open: nobody walks, one timer for the bubble', () => {
    const prompt: OfficeAction = { type: 'session_prompt', ...S1, text: 'Fix the flaky test please', promptId: 'p1' }
    const office = sessionOffice(0, env())
    const withRooms = reduceOffice(office, prompt, env())
    const before = reduceOffice(sessionOffice(0, closed()), prompt, closed())

    expect(agent(withRooms.state, BOSS_ID)).toEqual(agent(before.state, BOSS_ID))
    expect(claudeOf(withRooms.state, 's1')).toEqual(claudeOf(before.state, 's1'))
    expect(withRooms.effects).toEqual(before.effects)
    expect(withRooms.state.shoutSeq).toBe(1)

    // He stays at his desk in the office: only the bubble is new
    expect(agent(withRooms.state, BOSS_ID)).toEqual({ ...agent(office, BOSS_ID)!, callout: { kind: 'shout', text: 'Fix the flaky test please', seq: 1 } })
    expect(withRooms.effects.filter(e => e.kind === 'schedule')).toEqual([{ kind: 'schedule', action: { type: 'shout_over', seq: 1 }, delayMs: SHOUT_MS }])
    expect(stepOffice(withRooms.state, DT, env()).changed).toBe(false)
  })

  it('a Claude in another room or walking between rooms hears the shout where it is, and the boss stays put', () => {
    const prompt: OfficeAction = { type: 'session_prompt', ...S1, text: 'one more thing', promptId: 'p2' }
    // Sitting in the meeting room
    const { state, now } = inMeeting()
    const there = reduceOffice(state, prompt, at(now))
    expect(agent(there.state, BOSS_ID)).toMatchObject({ ...agent(state, BOSS_ID), callout: { kind: 'shout' } })
    expect(claudeOf(there.state, 's1')).toMatchObject({ mainState: 'working', room: 'meeting-room', callout: { kind: 'heard' } })

    // On its way there
    const up = stepOffice(sessionOffice(3), DT, at(T0 + DWELL_MS.team)).state
    expect(claudeOf(up, 's1')!.state).toBe('changing-room')
    const walking = reduceOffice(up, prompt, at(T0 + DWELL_MS.team))
    expect(agent(walking.state, BOSS_ID)!.position).toEqual(agent(up, BOSS_ID)!.position)
    expect(claudeOf(walking.state, 's1')).toMatchObject({ state: 'changing-room', callout: { kind: 'heard' } })   // it finishes the walk it is on
  })

  it('the rules never move the boss or the ?sim Claude, however long they sit', () => {
    const office = settle(emptyOffice(), at(T0 + LUNCH_IDLE_MS * 5)).state
    for (const id of [BOSS_ID, CLAUDE_ID]) {
      expect(roomOf(agent(office, id)!)).toBe(OFFICE_ROOM)
      expect(office.meta[id]?.wish).toBeUndefined()
    }
  })

  it('a colleague dropping by (A2A) happens only between two people at their office desks', () => {
    const { state, now } = inMeeting()
    const hired = settle(reduceOffice(state, spawnFor('x1', S2), at(now)).state, at(now)).state
    const row = (id: number, from: string, to: string): OfficeAction =>
      ({ type: 'chat_message', id, sender: from, role: 'debugger', text: `got a minute? ${id}`, timestamp: id, senderId: from, recipient: to, recipientId: to })
    // x1 is at its desk, w1 is in the meeting room: the line shows, nobody gets up, either way round
    const out = reduceOffice(hired, row(1, 'x1', 'w1'), at(now))
    expect(agent(out.state, 'x1')).toEqual(agent(hired, 'x1'))
    expect(out.effects.some(e => e.kind === 'msg')).toBe(true)
    expect(out.effects.some(e => e.kind === 'schedule')).toBe(false)
    const back = reduceOffice(hired, row(2, 'w1', 'x1'), at(now))
    expect(agent(back.state, 'w1')).toEqual(agent(hired, 'w1'))
    expect(back.effects.some(e => e.kind === 'schedule')).toBe(false)
  })

  it('inOffice: in the room, at home there, and not a server worker', () => {
    const base = seated('w1', 'debugger', 'spot-5')
    expect(inOffice(base)).toBe(true)
    expect(inOffice({ ...base, room: undefined as unknown as RoomId })).toBe(true)   // made before rooms existed
    expect(inOffice({ ...base, room: 'meeting-room' })).toBe(false)
    expect(inOffice({ ...base, visitSpotId: 'meet-1' })).toBe(false)                 // has got up, not yet through the door
    expect(inOffice({ ...base, type: 'mcp' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The boss follows the stage (boss_go)
// ---------------------------------------------------------------------------

describe('the boss follows the room on the stage', () => {
  const go = (room: RoomId): OfficeAction => ({ type: 'boss_go', room })
  const boss = (s: OfficeState) => agent(s, BOSS_ID)!
  /** Ray casting: is the point on the floor polygon */
  const onFloor = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j]
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
    return inside
  }

  it('where he stands in each room is a step in from the door, on its floor', () => {
    for (const id of ROOM_IDS.filter(r => r !== OFFICE_ROOM)) {
      const spot = standInside(id)
      expect(onFloor(spot, ROOMS[id].walkableArea!), id).toBe(true)
      const from = doorTo(id, id === HUB_ROOM ? OFFICE_ROOM : HUB_ROOM)!
      expect(dist(spot, from), id).toBeGreaterThan(2)
      expect(dist(spot, from), id).toBeLessThan(15)
    }
  })

  it('picking the meeting room walks him out of the office, along the corridor and in at its door, where he stands', () => {
    const office = emptyOffice()
    const { state, effects } = reduceOffice(office, go('meeting-room'), env())
    expect(effects).toEqual([])
    expect(boss(state)).toMatchObject({ state: 'changing-room', room: OFFICE_ROOM, targetPosition: door(OFFICE_ROOM) })
    expect(state.meta[BOSS_ID]).toMatchObject({ sentTo: 'meeting-room', transfer: { to: 'meeting-room', why: 'drop-in', leg: 'to-door' } })

    const seen = walk(state, s => !s.meta[BOSS_ID].transfer)
    const rooms = seen.map(s => roomOf(boss(s)))
    expect(rooms).toContain(HUB_ROOM)                                   // through the corridor, no teleport
    expect(rooms.indexOf(HUB_ROOM)).toBeLessThan(rooms.indexOf('meeting-room'))
    const there = seen[seen.length - 1]
    expect(boss(there)).toMatchObject({ room: 'meeting-room', state: 'idle', position: standInside('meeting-room'), spriteFacing: 'front-left' })
    expect(there.meta[BOSS_ID]).toMatchObject({ sentTo: 'meeting-room', arrivedAtDeskAt: null })
    // He keeps his desk: nobody else may take it while he is out
    expect(boss(there).assignedSpotId).toBe('spot-1')
    expect(heldSpotIds(there.agents).has('spot-1')).toBe(true)
  })

  it('the room rules leave him where he was sent, however long he stands there, and he takes no coffee break', () => {
    const there = settle(reduceOffice(emptyOffice(), go('lunch-room'), env()).state).state
    expect(boss(there)).toMatchObject({ room: 'lunch-room', state: 'idle' })
    const later = settle(there, at(T0 + LUNCH_IDLE_MS * 3 + BREAK_MIN_DESK_TIME, { random: () => 0 })).state
    expect(boss(later)).toMatchObject({ room: 'lunch-room', state: 'idle', position: standInside('lunch-room') })
    expect(later.meta[BOSS_ID].wish).toBeUndefined()
    // A fire drill in the office is not his business while he is out
    expect(moveAgentsForEvent(later.agents, { x: 67.5, y: 48.9 }, 'Fire Drill', env()).movedIds).not.toContain(BOSS_ID)
  })

  it('back to the office: he walks back the same way and sits down at his desk', () => {
    const there = settle(reduceOffice(emptyOffice(), go('server-room'), env()).state).state
    const { state } = reduceOffice(there, go(OFFICE_ROOM), env())
    expect(state.meta[BOSS_ID]).toMatchObject({ transfer: { to: OFFICE_ROOM, why: 'return' } })
    expect(state.meta[BOSS_ID].sentTo).toBeUndefined()
    const seen = walk(state, s => !s.meta[BOSS_ID].transfer)
    expect(seen.map(s => roomOf(boss(s)))).toContain(HUB_ROOM)
    const home = seen[seen.length - 1]
    const desk = spot('spot-1')
    expect(boss(home)).toMatchObject({ room: OFFICE_ROOM, state: 'working', position: { x: desk.x, y: desk.y }, spriteFacing: desk.spriteFacing })
    expect(home.meta[BOSS_ID].arrivedAtDeskAt).toBe(T0)
  })

  it('the corridor: he steps out of the office door and stands in the hallway (never taken for a leaver)', () => {
    const there = settle(reduceOffice(emptyOffice(), go(HUB_ROOM), env()).state).state
    expect(boss(there)).toMatchObject({ room: HUB_ROOM, state: 'idle', position: standInside(HUB_ROOM) })
    // Then on to the lunch room: straight along the corridor and in
    const lunch = settle(reduceOffice(there, go('lunch-room'), env()).state).state
    expect(boss(lunch)).toMatchObject({ room: 'lunch-room', position: standInside('lunch-room') })
  })

  it('a new pick mid-walk turns him round from where he is', () => {
    const { state } = reduceOffice(emptyOffice(), go('meeting-room'), env())
    const partWay = frames(state, 10)[9]
    expect(roomOf(boss(partWay))).toBe(OFFICE_ROOM)                    // still crossing the office
    const { state: back } = reduceOffice(partWay, go(OFFICE_ROOM), env())
    const seen = walk(back, s => !s.meta[BOSS_ID].transfer)
    expect(seen.every(s => roomOf(boss(s)) === OFFICE_ROOM)).toBe(true) // never went through the door
    expect(boss(seen[seen.length - 1])).toMatchObject({ state: 'working', position: boss(state).deskPosition })
  })

  it('nothing happens when he is already there or on his way, or the room is not in use', () => {
    const office = emptyOffice()
    expect(reduceOffice(office, go(OFFICE_ROOM), env()).state).toBe(office)
    const { state: going } = reduceOffice(office, go('meeting-room'), env())
    expect(reduceOffice(going, go('meeting-room'), env()).state).toBe(going)
    // The office alone (no rooms in use), or a room that is closed
    expect(reduceOffice(office, go('meeting-room'), closed()).state).toBe(office)
    const noLunch = openRoomSet([OFFICE_ROOM, HUB_ROOM, 'meeting-room'])
    expect(reduceOffice(office, go('lunch-room'), env({ openRooms: noLunch })).state).toBe(office)
    // On an errand in the office (walking to the plant): picking the office again does not cut it short
    const errand = { ...office, agents: office.agents.map(a => (a.id === BOSS_ID ? { ...a, state: 'walking-to-desk' as const, targetPosition: { x: 70, y: 60 } } : a)) }
    expect(reduceOffice(errand, go(OFFICE_ROOM), env()).state).toBe(errand)
  })

  it('he shouts a prompt from wherever he is standing', () => {
    const live = settle(reduceOffice(liveOffice(), { type: 'session_started', ...S1 }, env()).state).state
    const there = settle(reduceOffice(live, go('meeting-room'), env()).state).state
    const { state } = reduceOffice(there, { type: 'session_prompt', ...S1, text: 'ship it' }, env())
    expect(boss(state)).toEqual({ ...boss(there), callout: { kind: 'shout', text: 'ship it', seq: 1 } })
    expect(claudeOf(state, 's1')).toMatchObject({ room: OFFICE_ROOM, callout: { kind: 'heard' } })
  })

  it('bossErrandGate: an errand goes at once at home, waits while he walks back, and fetches him from elsewhere', () => {
    const office = emptyOffice()
    expect(bossErrandGate(office)).toBe('go')
    const { state: going } = reduceOffice(office, go('meeting-room'), env())
    expect(bossErrandGate(going)).toBe('fetch')
    const there = settle(going).state
    expect(bossErrandGate(there)).toBe('fetch')
    const { state: coming } = reduceOffice(there, go(OFFICE_ROOM), env())
    expect(bossErrandGate(coming)).toBe('wait')
    expect(bossErrandGate(settle(coming).state)).toBe('go')
  })
})

// ---------------------------------------------------------------------------
// The ?sim&rooms=all demo
// ---------------------------------------------------------------------------

describe('the rooms demo script (src/roomsDemo.ts) played against the reducer', () => {
  /** One pass on a simulated clock: 3 frames are 50 ms; timers the reducer asks for fire when due */
  function playOnce(): { seen: OfficeState[]; end: OfficeState } {
    let state = emptyOffice()
    const due: Array<{ at: number; action: OfficeAction }> = ROOMS_DEMO_SCRIPT.map(s => ({ at: T0 + s.at, action: s.event }))
    const seen: OfficeState[] = []
    for (let now = T0; now <= T0 + DEMO_LOOP_MS; now += 50) {
      const e = at(now)
      for (const d of due.filter(x => x.at <= now)) {
        due.splice(due.indexOf(d), 1)
        const r = reduceOffice(state, d.action, e)
        state = r.state
        for (const fx of r.effects) if (fx.kind === 'schedule') due.push({ at: now + fx.delayMs, action: fx.action })
      }
      const r = stepOffice(state, DT, e)
      state = r.state
      for (const fx of r.effects) if (fx.kind === 'schedule') due.push({ at: now + fx.delayMs, action: fx.action })
      seen.push(state)
    }
    return { seen, end: state }
  }

  it('puts both MCP workers at racks and the three workers at the meeting table, and everybody it brought in is gone when it loops', () => {
    const { seen, end } = playOnce()
    const settledIn = (s: OfficeState, room: RoomId) => s.agents.filter(a => roomOf(a) === room && a.state === 'working')

    expect(seen.some(s => settledIn(s, 'server-room').length === 2)).toBe(true)
    expect(seen.some(s => settledIn(s, 'meeting-room').filter(a => a.id.startsWith('rooms-demo-')).length === 3)).toBe(true)
    // The third worker walks back to its desk once the other two have gone, and finishes there
    expect(seen.some(s => {
      const last = agent(s, 'rooms-demo-3')
      return !!last && !agent(s, 'rooms-demo-1') && !agent(s, 'rooms-demo-2') && roomOf(last) === OFFICE_ROOM && last.state === 'working'
    })).toBe(true)

    // Why this matters: the next pass reuses the same ids
    expect(end.agents.map(a => a.id).sort()).toEqual([BOSS_ID, CLAUDE_ID].sort())
  })
})

