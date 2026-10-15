/**
 * src/officeReducer.ts — the office's event → state machine, driven in plain
 * Node with a deterministic environment (fixed clock, straight-line paths, a
 * non-random random). Each describe block is one of the audit's lifecycle
 * findings (C12/C13/C14/C29/C31/C32/C34/C35).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  reduceOffice,
  stepOffice,
  initialOfficeState,
  moveAgentsForEvent,
  returnAgentsFromEvent,
  pickSingleEventAgent,
  lobbyPosition,
  MAIN_ROOM,
  DOOR_TARGET,
  BOSS_ID,
  CLAUDE_ID,
  MIN_VISIBLE_TIME,
  A2A_VISIT_MS,
  type OfficeState,
  type OfficeEnv,
  type OfficeEffect,
  type OfficeAction,
} from '../src/officeReducer'
import { createAgent } from '../src/agentManager'
import type { Agent } from '../src/types'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const T0 = 1_000_000

/** A deterministic environment: fixed clock, no waypoints, no randomness */
function env(over: Partial<OfficeEnv> = {}): OfficeEnv {
  return { now: T0, live: true, computePath: () => [], random: () => 0.5, ...over }
}

const spot = (id: string) => MAIN_ROOM.agentSpots.find(s => s.id === id)!

/** An agent already sitting at its desk */
function seated(id: string, role: string, spotId: string): Agent {
  const a = createAgent({ id, name: id, role, spot: spot(spotId) })
  return { ...a, state: 'working', position: { ...a.deskPosition }, pathQueue: [] }
}

/** The office with only its permanent staff */
function emptyOffice(now = T0): OfficeState {
  return initialOfficeState([seated(BOSS_ID, 'boss', 'spot-1'), seated(CLAUDE_ID, 'assistant', 'spot-2')], now)
}

const spawn = (id: string, role = 'debugger', task = `task ${id}`): OfficeAction =>
  ({ type: 'agent_spawned', agent: { id, name: id, role, task } })

/** Dispatch a list of actions, returning the final state and every effect in order */
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
function settle(state: OfficeState, e = env(), maxFrames = 3000): { state: OfficeState; effects: OfficeEffect[]; frames: number } {
  const effects: OfficeEffect[] = []
  for (let i = 0; i < maxFrames; i++) {
    const r = stepOffice(state, 3, e)
    effects.push(...r.effects)
    if (!r.changed) return { state, effects, frames: i }
    state = r.state
  }
  throw new Error(`office did not settle in ${maxFrames} frames`)
}

const agent = (s: OfficeState, id: string) => s.agents.find(a => a.id === id)
const texts = (effects: OfficeEffect[]) => effects.filter(e => e.kind === 'msg').map(e => (e as { text: string }).text)
const sfx = (effects: OfficeEffect[]) => effects.filter(e => e.kind === 'sfx').map(e => (e as { sfx: string }).sfx)

/** Spawn n debuggers into a fresh office and let them all sit down */
function fullOffice(n: number): OfficeState {
  const ids = Array.from({ length: n }, (_, i) => `w${i + 1}`)
  const { state } = dispatchAll(emptyOffice(), ids.map(id => spawn(id)))
  return settle(state).state
}

// ---------------------------------------------------------------------------
// C13 — a status that arrives mid-walk waits for the desk
// ---------------------------------------------------------------------------

describe('agent_working before arrival (C13)', () => {
  it('keeps the walk authoritative, posts the status lines, and applies the last status on arrival', () => {
    const { state: s0 } = reduceOffice(emptyOffice(), spawn('a1'), env())
    expect(agent(s0, 'a1')!.state).toBe('new-hire')

    // The hook posts the first Read/Grep within a second of the spawn — three
    // of them land while the sprite is still at the door
    const { state: s1, effects } = dispatchAll(s0, [
      { type: 'agent_working', agentId: 'a1', status: 'reading a.ts' },
      { type: 'agent_working', agentId: 'a1', status: 'searching for x' },
      { type: 'agent_working', agentId: 'a1', status: 'running: npm test', failed: true },
    ])
    const a1 = agent(s1, 'a1')!
    expect(a1.state).toBe('new-hire')                       // still walking, not 'working' mid-walk
    expect(a1.position).toEqual({ x: MAIN_ROOM.entryPoint.x, y: MAIN_ROOM.entryPoint.y })
    expect(s1.pendingStatus.a1).toEqual({ status: 'running: npm test', failed: true })
    expect(texts(effects)).toEqual(['⚡ reading a.ts', '⚡ searching for x', '❌ running: npm test'])

    // A few frames in it is visibly walking, still not working
    const mid = stepOffice(s1, 3, env()).state
    expect(agent(mid, 'a1')!.state).toBe('new-hire')
    expect(agent(mid, 'a1')!.position).not.toEqual(a1.position)

    // On arrival the queued status is what the desk shows
    const { state: s2 } = settle(s1)
    const arrived = agent(s2, 'a1')!
    expect(arrived.state).toBe('working')
    expect(arrived.position).toEqual(arrived.deskPosition)
    expect(arrived.statusText).toBe('running: npm test')
    expect(arrived.lastFailed).toBe(true)
    expect(s2.pendingStatus.a1).toBeUndefined()
    expect(s2.meta.a1.arrivedAtDeskAt).toBe(T0)
  })

  it('applies a status immediately once the agent is seated, and ignores one for an agent walking out', () => {
    const seatedOffice = fullOffice(1)
    const { state: s1, effects } = reduceOffice(seatedOffice, { type: 'agent_working', agentId: 'w1', status: 'editing b.ts' }, env())
    expect(agent(s1, 'w1')!.statusText).toBe('editing b.ts')
    expect(agent(s1, 'w1')!.state).toBe('working')
    expect(texts(effects)).toEqual(['⚡ editing b.ts'])

    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1 })
    const { state: s2 } = reduceOffice(s1, { type: 'agent_completed', agentId: 'w1', result: 'done' }, late)
    expect(agent(s2, 'w1')!.state).toBe('completed')
    // The server flips a completed agent back to 'working' for its 10 s grace period; the office does not
    const { state: s3, effects: none } = reduceOffice(s2, { type: 'agent_working', agentId: 'w1', status: 'reading c.ts' }, late)
    expect(s3).toBe(s2)
    expect(none).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C29 — no desk: wait in the lobby, take the next free desk, never dropped
// ---------------------------------------------------------------------------

describe('lobby when every desk is taken (C29)', () => {
  it('seats eight workers, then parks the ninth by the door with a visible status', () => {
    const eight = fullOffice(8)
    expect(eight.agents.filter(a => a.state === 'working' && a.id.startsWith('w'))).toHaveLength(8)

    const { state, effects } = reduceOffice(eight, spawn('w9'), env())
    const w9 = agent(state, 'w9')!
    expect(w9.state).toBe('waiting')
    expect(w9.assignedSpotId).toBeUndefined()
    expect(w9.statusText).toBe('waiting for a desk')
    expect(w9.targetPosition).toEqual(lobbyPosition(0))
    expect(state.lobby).toEqual(['w9'])
    expect(texts(effects)).toEqual(['waiting for a desk...'])
    expect(sfx(effects)).toEqual(['doorOpen'])

    // It walks to its lobby spot and stays there, not at a desk
    const { state: settled } = settle(state)
    expect(agent(settled, 'w9')!.state).toBe('waiting')
    expect(agent(settled, 'w9')!.position).toEqual(lobbyPosition(0))

    // A second waiter takes the next lobby spot; later events for either are not lost
    const { state: two } = reduceOffice(settled, spawn('w10'), env())
    expect(agent(two, 'w10')!.targetPosition).toEqual(lobbyPosition(1))
    expect(two.lobby).toEqual(['w9', 'w10'])
    const { state: withStatus } = reduceOffice(two, { type: 'agent_working', agentId: 'w10', status: 'reading z.ts' }, env())
    expect(withStatus.pendingStatus.w10).toEqual({ status: 'reading z.ts', failed: false })
  })

  it('seats the oldest waiter when a desk frees up, and the status it received meanwhile applies on arrival', () => {
    const { state: s0 } = reduceOffice(fullOffice(8), spawn('w9'), env())
    const { state: s1 } = reduceOffice(s0, spawn('w10'), env())
    const { state: s2 } = reduceOffice(settle(s1).state, { type: 'agent_working', agentId: 'w9', status: 'grepping' }, env())

    // w3 finishes: its desk is free from the moment it gets up
    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1 })
    const freedSpot = agent(s2, 'w3')!.assignedSpotId
    const { state: s3 } = reduceOffice(s2, { type: 'agent_completed', agentId: 'w3', result: 'shipped' }, late)
    const { state: s4 } = { state: stepOffice(s3, 3, late).state }
    const w9 = agent(s4, 'w9')!
    expect(w9.state).toBe('walking-to-desk')
    expect(w9.assignedSpotId).toBe(freedSpot)
    expect(w9.deskPosition).toEqual({ x: spot(freedSpot!).x, y: spot(freedSpot!).y })
    expect(s4.lobby).toEqual(['w10'])                       // the newer waiter keeps waiting
    expect(agent(s4, 'w10')!.state).toBe('waiting')

    const { state: s5 } = settle(s4, late)
    expect(agent(s5, 'w9')!.state).toBe('working')
    expect(agent(s5, 'w9')!.statusText).toBe('grepping')
    expect(agent(s5, 'w3')).toBeUndefined()                 // w3 reached the door and left
    expect(s5.meta.w3).toBeUndefined()
  })

  it('a browsing role still takes the filing cabinet when the desks are full', () => {
    const { state } = reduceOffice(fullOffice(8), spawn('ex', 'Explore'), env())
    expect(agent(state, 'ex')!.state).toBe('new-hire')
    expect(agent(state, 'ex')!.assignedSpotId).toBe('spot-filing')
    expect(state.lobby).toEqual([])
  })
})

describe('completion of a lobby agent (C29)', () => {
  it('walks the waiter out, clears its lobby slot and queued status, and prunes it at the door', () => {
    const { state: s0 } = reduceOffice(fullOffice(8), spawn('w9'), env())
    const { state: s1 } = reduceOffice(settle(s0).state, { type: 'agent_working', agentId: 'w9', status: 'reading' }, env())
    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1 })
    const { state: s2, effects } = reduceOffice(s1, { type: 'agent_completed', agentId: 'w9', result: 'nothing to do' }, late)
    const w9 = agent(s2, 'w9')!
    expect(w9.state).toBe('completed')
    expect(w9.targetPosition).toEqual(DOOR_TARGET)
    expect(s2.lobby).toEqual([])
    expect(s2.pendingStatus.w9).toBeUndefined()
    expect(sfx(effects)).toEqual(['celebration'])
    expect(texts(effects)).toHaveLength(1)                  // the boss's reply; the server posts "done:"

    const { state: s3 } = settle(s2, late)
    expect(agent(s3, 'w9')).toBeUndefined()
    expect(s3.meta.w9).toBeUndefined()
    // The desks are still full, so the next arrival waits again at the first lobby spot
    const { state: s4 } = reduceOffice(s3, spawn('w11'), late)
    expect(agent(s4, 'w11')!.targetPosition).toEqual(lobbyPosition(0))
  })

  it('defers a completion until the agent has been visible for MIN_VISIBLE_TIME, as data', () => {
    const { state } = reduceOffice(emptyOffice(), spawn('a1'), env())
    const action: OfficeAction = { type: 'agent_completed', agentId: 'a1', result: 'quick' }
    const r = reduceOffice(state, action, env({ now: T0 + 10_000 }))
    expect(r.state).toBe(state)
    expect(r.effects).toEqual([{ kind: 'schedule', action, delayMs: MIN_VISIBLE_TIME - 10_000 }])
  })
})

// ---------------------------------------------------------------------------
// C35 — the reconnect snapshot reconciles instead of only adding
// ---------------------------------------------------------------------------

describe('snapshot reconciliation (C35)', () => {
  it('removes agents missing from the snapshot, refreshes present ones in place, walks new ones in', () => {
    const office = fullOffice(2)                            // w1, w2 seated
    const { state: withWaiter } = reduceOffice(office, spawn('w3', 'debugger'), env())
    const w1Before = agent(withWaiter, 'w1')!

    const { state, effects } = reduceOffice(withWaiter, {
      type: 'snapshot',
      activeAgents: [
        { id: 'w1', name: 'w1', role: 'debugger', task: 'renamed task', state: 'working', status: 'editing x.ts', unread: 2, sessionId: 's1', project: 'office' },
        { id: 'n1', name: 'n1', role: 'test-engineer', task: 'new work', state: 'working', status: 'running: vitest' },
        { id: 'mcp-github-1', name: 'github', role: 'github', state: 'working', server: 'github' },
        { id: 'gone', name: 'gone', role: 'debugger', state: 'completed' },
      ],
    }, env({ now: T0 + 60_000 }))

    // w2 and the waiter w3 completed while we were disconnected: they leave, quietly
    expect(agent(state, 'w2')!.state).toBe('completed')
    expect(agent(state, 'w3')!.state).toBe('completed')
    expect(state.lobby).toEqual([])
    expect(sfx(effects)).toEqual(['doorOpen'])              // only the newcomer's door; no celebrations
    expect(texts(effects)).toEqual(['📋 new work'])         // no boss replies for silent departures

    // w1 is still here: not re-walked, fields refreshed
    const w1 = agent(state, 'w1')!
    expect(w1.state).toBe('working')
    expect(w1.position).toEqual(w1Before.position)
    expect(w1.task).toBe('renamed task')
    expect(w1.statusText).toBe('editing x.ts')
    expect(w1.unread).toBe(2)
    expect(w1.sessionId).toBe('s1')
    expect(w1.project).toBe('office')

    // n1 walks in with its status queued for arrival; MCP and completed records are not workers
    const n1 = agent(state, 'n1')!
    expect(n1.state).toBe('new-hire')
    expect(state.pendingStatus.n1).toEqual({ status: 'running: vitest', failed: false })
    expect(agent(state, 'mcp-github-1')).toBeUndefined()
    expect(agent(state, 'gone')).toBeUndefined()

    // The permanent staff never leave
    expect(agent(state, BOSS_ID)!.state).toBe('working')
    expect(agent(state, CLAUDE_ID)!.state).toBe('working')

    const { state: settled } = settle(state, env({ now: T0 + 60_000 }))
    expect(settled.agents.map(a => a.id).sort()).toEqual([BOSS_ID, CLAUDE_ID, 'n1', 'w1'].sort())
    expect(agent(settled, 'n1')!.statusText).toBe('running: vitest')
  })

  it('an empty snapshot empties the office down to the boss and Claude', () => {
    const { state } = reduceOffice(fullOffice(3), { type: 'snapshot', activeAgents: [] }, env())
    expect(state.agents.filter(a => a.state === 'completed').map(a => a.id)).toEqual(['w1', 'w2', 'w3'])
    const { state: settled } = settle(state)
    expect(settled.agents.map(a => a.id)).toEqual([BOSS_ID, CLAUDE_ID])
  })

  it('a repeated snapshot with the same roster is a no-op for seated agents', () => {
    const office = fullOffice(2)
    const roster = [
      { id: 'w1', name: 'w1', role: 'debugger', state: 'working' },
      { id: 'w2', name: 'w2', role: 'debugger', state: 'working' },
    ]
    const { state: once, effects: e1 } = reduceOffice(office, { type: 'snapshot', activeAgents: roster }, env())
    const { state: twice, effects: e2 } = reduceOffice(once, { type: 'snapshot', activeAgents: roster }, env())
    expect(e1).toEqual([])
    expect(e2).toEqual([])
    expect(twice.agents.map(a => [a.id, a.state])).toEqual(office.agents.map(a => [a.id, a.state]))
  })
})

// ---------------------------------------------------------------------------
// C12 / C14 / C31 — effects are data, emitted once; the tick never clobbers
// ---------------------------------------------------------------------------

describe('effects are returned as data, exactly once per event (C12/C31)', () => {
  it('is pure: the same input twice (React StrictMode style) gives equal output and leaves the input untouched', () => {
    // The only randomness outside OfficeEnv is the themed chatter pools (spawn / work / done lines)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const office = fullOffice(1)
    const frozen = JSON.stringify(office)
    const events: OfficeAction[] = [
      spawn('a2', 'test-engineer', 'write tests'),
      { type: 'agent_working', agentId: 'w1', status: 'reading' },
      { type: 'chat_message', id: 5, sender: 'w1', role: 'debugger', text: 'hello', timestamp: 1 },
      { type: 'chat_message', id: 6, sender: 'w1', role: 'debugger', text: 'ping', timestamp: 2, recipient: 'a2', recipientId: 'a2', senderId: 'w1' },
    ]
    let a = office
    let b = office
    for (const ev of events) {
      const r1 = reduceOffice(a, ev, env())
      const r2 = reduceOffice(b, ev, env())
      expect(r2.state).toEqual(r1.state)
      expect(r2.effects).toEqual(r1.effects)
      a = r1.state; b = r2.state
    }
    expect(JSON.stringify(office)).toBe(frozen)
    vi.restoreAllMocks()
  })

  it('a store that flushes outside React delivers each effect once and dedups a re-broadcast chat row', () => {
    // Mirrors App.tsx: reduce → commit → flush, never inside a setState updater
    let state = fullOffice(2)
    const flushed: OfficeEffect[] = []
    const dispatch = (action: OfficeAction) => {
      const r = reduceOffice(state, action, env())
      state = r.state
      flushed.push(...r.effects)
    }
    dispatch({ type: 'agent_working', agentId: 'w1', status: 'reading a.ts' })
    dispatch({ type: 'agent_working', agentId: 'w2', status: 'reading b.ts' })
    dispatch({ type: 'chat_message', id: 9, sender: 'w1', role: 'debugger', text: 'same row', timestamp: 42 })
    dispatch({ type: 'chat_message', id: 9, sender: 'w1', role: 'debugger', text: 'same row', timestamp: 42 })
    expect(texts(flushed)).toEqual(['⚡ reading a.ts', '⚡ reading b.ts', 'same row'])
    expect(state.recentChatKeys).toEqual(['42:same row'])
  })

  it('a directed message walks a seated sender over and schedules the walk back as data', () => {
    const { state, effects } = reduceOffice(fullOffice(2), {
      type: 'chat_message', id: 7, sender: 'w1', senderId: 'w1', text: 'can you check this?', timestamp: 3,
      recipient: 'w2', recipientId: 'w2', msg_type: 'review_request',
    }, env())
    expect(agent(state, 'w1')!.state).toBe('walking-to-desk')
    expect(agent(state, 'w1')!.statusText).toBe('talking to w2')
    expect(texts(effects)).toEqual(['👀 → @w2: can you check this?'])
    expect(effects).toContainEqual({ kind: 'schedule', action: { type: 'a2a_visit_over', agentId: 'w1' }, delayMs: A2A_VISIT_MS })
    const { state: back } = reduceOffice(state, { type: 'a2a_visit_over', agentId: 'w1' }, env())
    expect(agent(back, 'w1')!.targetPosition).toEqual(agent(back, 'w1')!.deskPosition)
  })
})

describe('the animation tick composes with events (C14)', () => {
  it('an event between two frames is kept by the next frame', () => {
    const { state: s0 } = reduceOffice(emptyOffice(), spawn('a1'), env())
    const s1 = stepOffice(s0, 1, env()).state                // a1 is mid-walk
    const { state: s2 } = reduceOffice(s1, spawn('a2', 'test-engineer'), env())
    const { state: s3 } = reduceOffice(s2, { type: 'agent_working', agentId: 'a1', status: 'reading' }, env())
    const s4 = stepOffice(s3, 1, env()).state
    expect(s4.agents.map(a => a.id)).toEqual([BOSS_ID, CLAUDE_ID, 'a1', 'a2'])
    expect(s4.pendingStatus.a1).toEqual({ status: 'reading', failed: false })
  })

  it('returns the same state object when nothing moves, so the UI can skip the frame', () => {
    const office = fullOffice(2)
    const r = stepOffice(office, 1, env())
    expect(r.changed).toBe(false)
    expect(r.state).toBe(office)
    expect(r.effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C34 — the server's chat row ids are adopted
// ---------------------------------------------------------------------------

describe('server message ids (C34)', () => {
  it('carries the row id on chat lines and matches reactions and read receipts by it', () => {
    const { effects } = dispatchAll(fullOffice(1), [
      { type: 'chat_message', id: 777, sender: 'w1', role: 'debugger', text: 'SERVER-MSG-777', timestamp: 10 },
      { type: 'chat_message', id: 778, sender: 'system', text: '3 agents active', timestamp: 11, isSystem: true },
      { type: 'chat_reaction', messageId: 777, reactions: ['🔥'] },
      { type: 'chat_seen', messageId: 778 },
    ])
    const msgs = effects.filter(e => e.kind === 'msg') as Array<{ id?: number; text: string; isSystem?: boolean }>
    expect(msgs.map(m => [m.id, m.text, !!m.isSystem])).toEqual([[777, 'SERVER-MSG-777', false], [778, '3 agents active', true]])
    expect(effects).toContainEqual({ kind: 'reaction', messageId: 777, reactions: ['🔥'] })
    expect(effects).toContainEqual({ kind: 'seen', messageId: 778 })
  })

  it("the boss's own echo is not re-posted, only its row id is adopted", () => {
    const { state, effects } = reduceOffice(fullOffice(1), { type: 'chat_message', id: 42, sender: 'Boss', text: 'ship it', timestamp: 12 }, env())
    expect(texts(effects)).toEqual([])
    expect(effects).toContainEqual({ kind: 'adoptMsgId', id: 42, text: 'ship it' })
    expect(state.recentChatKeys).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// C32 — random office events leave live workers alone
// ---------------------------------------------------------------------------

describe('all-move office events (C32)', () => {
  const target = { x: 67.5, y: 48.9 }

  it('in live mode only the boss and Claude get up; a working subagent stays at its desk', () => {
    const office = fullOffice(2)
    const { agents, movedIds } = moveAgentsForEvent(office.agents, target, 'Fire Drill', env({ live: true }))
    expect(movedIds.sort()).toEqual([BOSS_ID, CLAUDE_ID].sort())
    const w1 = agents.find(a => a.id === 'w1')!
    expect(w1).toBe(office.agents.find(a => a.id === 'w1'))   // untouched, same object
    expect(w1.state).toBe('working')
    expect(agents.find(a => a.id === BOSS_ID)!.targetPosition).toEqual(target)
  })

  it('in sim mode seated agents join, but one walking out, on a break or waiting keeps doing that', () => {
    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1, live: false })
    const { state: s0 } = reduceOffice(fullOffice(8), spawn('w9'), late)             // w9 waits by the door
    const { state: s1 } = reduceOffice(s0, { type: 'agent_completed', agentId: 'w1', result: 'done' }, late) // w1 leaves
    const onBreak = s1.agents.map(a => (a.id === 'w2' ? { ...a, state: 'coffee-break' as const } : a))

    const { agents, movedIds } = moveAgentsForEvent(onBreak, target, 'Pizza Delivery', late)
    expect(movedIds).not.toContain('w1')
    expect(movedIds).not.toContain('w2')
    expect(movedIds).not.toContain('w9')
    expect(movedIds).toContain('w3')
    expect(movedIds).toContain(BOSS_ID)
    expect(agents.find(a => a.id === 'w1')!.state).toBe('completed')
    expect(agents.find(a => a.id === 'w1')!.targetPosition).toEqual(DOOR_TARGET)
    expect(agents.find(a => a.id === 'w9')!.state).toBe('waiting')

    // Only those who went come back, and only if nothing else moved them since
    const completedMeanwhile = agents.map(a => (a.id === 'w3' ? { ...a, state: 'completed' as const } : a))
    const back = returnAgentsFromEvent(completedMeanwhile, movedIds, late)
    expect(back.find(a => a.id === 'w3')!.state).toBe('completed')
    expect(back.find(a => a.id === 'w4')!.targetPosition).toEqual(back.find(a => a.id === 'w4')!.deskPosition)
    expect(back.find(a => a.id === 'w4')!.statusText).toBe('back to work')
    expect(back.find(a => a.id === 'w9')!.state).toBe('waiting')
  })

  it('a single-agent event never picks the boss, and in live mode only Claude', () => {
    const office = fullOffice(3)
    expect(pickSingleEventAgent(office.agents, env({ live: true }))!.id).toBe(CLAUDE_ID)
    for (let i = 0; i < 20; i++) {
      const chosen = pickSingleEventAgent(office.agents, env({ live: false, random: () => i / 20 }))!
      expect(chosen.id).not.toBe(BOSS_ID)
    }
  })
})

// ---------------------------------------------------------------------------
// Lifecycle chat lines come from one source per mode
// ---------------------------------------------------------------------------

describe('lifecycle chat lines are not duplicated', () => {
  it('live: the server posts "starting:" and "done:", the office only adds sounds and the boss reply', () => {
    const { effects: spawned } = reduceOffice(emptyOffice(), spawn('a1', 'debugger', 'fix the bug'), env({ live: true }))
    expect(texts(spawned)).toEqual([])
    expect(sfx(spawned)).toEqual(['doorOpen'])
    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1, live: true })
    const { effects: done } = reduceOffice(fullOffice(1), { type: 'agent_completed', agentId: 'w1', result: 'all green' }, late)
    expect(texts(done)).toHaveLength(1)
    expect(texts(done)[0]).not.toContain('all green')
    expect(sfx(done)).toEqual(['celebration'])
  })

  it('sim: there is no server, so the office posts them itself in the same format', () => {
    const { effects: spawned } = reduceOffice(emptyOffice(), spawn('a1', 'debugger', 'fix the bug'), env({ live: false }))
    expect(texts(spawned)).toEqual(['starting: fix the bug'])
    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1, live: false })
    const { effects: done } = reduceOffice(fullOffice(1), { type: 'agent_completed', agentId: 'w1', result: 'all green' }, late)
    expect(texts(done)[0]).toBe('done: all green')
    expect(texts(done)).toHaveLength(2)                     // plus the boss reply
  })
})
