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
  walkDurationMs,
  errandWaitMs,
  ERRAND_MIN_WAIT_MS,
  lobbyPosition,
  MAIN_ROOM,
  DOOR_TARGET,
  BOSS_ID,
  CLAUDE_ID,
  MIN_VISIBLE_TIME,
  A2A_VISIT_MS,
  CLAUDE_HOME_SPOT,
  HANDOVER_DWELL_MS,
  HANDOVER_MAX_MS,
  SESSION_CLAUDE_GRACE_MS,
  HOOK_WARN_MS,
  initialHealth,
  reduceConnection,
  hookVerdict,
  type OfficeState,
  type OfficeEnv,
  type OfficeEffect,
  type OfficeAction,
} from '../src/officeReducer'
import { mainId } from '../src/mainState'
import { createAgent, findWaypointPath, stepToward, WALK_SPEED } from '../src/agentManager'
import { getInteraction } from '../src/interactions'
import { readFileSync } from 'node:fs'
import { BOSS_NAME } from '../src/config'
import { AGENT_CONFIGS, type Agent, type ServerHealth } from '../src/types'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const T0 = 1_000_000

/** A deterministic environment: fixed clock, no waypoints, no randomness */
function env(over: Partial<OfficeEnv> = {}): OfficeEnv {
  return { now: T0, live: true, computePath: () => [], random: () => 0.5, ...over }
}

const spot = (id: string) => MAIN_ROOM.agentSpots.find(s => s.id === id)!

/** An agent already sitting at its desk (hired at the fixed clock, so two fixtures are equal) */
function seated(id: string, role: string, spotId: string): Agent {
  const a = createAgent({ id, name: id, role, spot: spot(spotId), hiredAt: T0 })
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
    // Everything time- or chance-dependent comes through OfficeEnv (now, random,
    // computePath); the themed chatter pools are the one Math.random left, pinned
    // here. The two runs start from two separately built but identical offices, so
    // nothing is shared between them, and the clock is the env's, never Date.now().
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const build = () => fullOffice(1)
      const office = build()
      const frozen = JSON.stringify(office)
      const events: OfficeAction[] = [
        spawn('a2', 'test-engineer', 'write tests'),
        { type: 'agent_working', agentId: 'w1', status: 'reading' },
        { type: 'chat_message', id: 5, sender: 'w1', role: 'debugger', text: 'hello', timestamp: 1 },
        { type: 'chat_message', id: 6, sender: 'w1', role: 'debugger', text: 'ping', timestamp: 2, recipient: 'a2', recipientId: 'a2', senderId: 'w1' },
        { type: 'session_started', sessionId: 's1', project: 'office', cwd: '/home/me/office' },
        { type: 'session_prompt', sessionId: 's1', text: 'fix the flaky test' },
        { type: 'agent_working', sessionId: 's1', status: 'reading a.ts' },
        { type: 'session_needs_you', sessionId: 's1', kind: 'permission', toolName: 'Bash', summary: 'npm test' },
        { type: 'session_turn_end', sessionId: 's1', text: 'done', backgroundTasks: [] },
      ]
      let a = office
      let b = build()
      expect(b).toEqual(a)
      for (const ev of events) {
        const r1 = reduceOffice(a, ev, env())
        const r2 = reduceOffice(b, ev, env())
        expect(r2.state).toEqual(r1.state)
        expect(r2.effects).toEqual(r1.effects)
        a = r1.state; b = r2.state
      }
      expect(JSON.stringify(office)).toBe(frozen)
      // The spawn clock is the env's: no Date.now() anywhere in the reducer's path
      expect(agent(a, 'a2')!.hiredAt).toBe(T0)
      expect(agent(a, mainId('s1'))!.hiredAt).toBe(T0)
    } finally {
      spy.mockRestore()
    }
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
    // The echo is recognised by the configured boss name, which is 'Boss' without
    // an office.config.json and whatever the file says with one (CI copies the example)
    const { state, effects } = reduceOffice(fullOffice(1), { type: 'chat_message', id: 42, sender: BOSS_NAME, text: 'ship it', timestamp: 12 }, env())
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

// ---------------------------------------------------------------------------
// Pipeline health — the status strip's state (G1)
// ---------------------------------------------------------------------------

describe('pipeline health: connection + health actions (G1)', () => {
  /** What server/health.js reports */
  const report = (over: Partial<ServerHealth> = {}): ServerHealth => ({
    status: 'ok', agents: 0, clients: 1, sessions: 0, lastHookAt: null, hooksSeen: 0,
    uiAvailable: true, version: '1.0.0', uptimeMs: 0, ...over,
  })
  const conn = (socket: 'open' | 'closed'): OfficeAction => ({ type: 'connection', socket })
  const healthEvent = (h: ServerHealth): OfficeAction => ({ type: 'health', health: h })
  const at = (now: number) => env({ now })

  it('starts connecting, with no server report', () => {
    expect(emptyOffice().health).toEqual(initialHealth(T0))
    expect(emptyOffice().health).toEqual({ connection: 'connecting', connectionSince: T0, onlineSince: null, server: null, reportedAt: null })
  })

  it('open → online; a later close → reconnecting; open again → online, remembering the first open', () => {
    const s1 = reduceOffice(emptyOffice(), conn('open'), at(T0 + 100)).state
    expect(s1.health).toMatchObject({ connection: 'online', connectionSince: T0 + 100, onlineSince: T0 + 100 })

    const s2 = reduceOffice(s1, conn('closed'), at(T0 + 5_000)).state
    expect(s2.health).toMatchObject({ connection: 'reconnecting', connectionSince: T0 + 5_000, onlineSince: T0 + 100 })

    // Retries that fail close again: the phase (and when it began) stand, the state is not churned
    const s3 = reduceOffice(s2, conn('closed'), at(T0 + 9_000))
    expect(s3.state).toBe(s2)
    expect(s3.effects).toEqual([])

    const s4 = reduceOffice(s3.state, conn('open'), at(T0 + 12_000)).state
    expect(s4.health).toMatchObject({ connection: 'online', connectionSince: T0 + 12_000, onlineSince: T0 + 100 })
  })

  it('a close before any open is offline — the server was never reached — and repeats do not churn', () => {
    const r1 = reduceOffice(emptyOffice(), conn('closed'), at(T0 + 50))
    expect(r1.state.health).toMatchObject({ connection: 'offline', connectionSince: T0 + 50, onlineSince: null })
    const r2 = reduceOffice(r1.state, conn('closed'), at(T0 + 2_000))
    expect(r2.state).toBe(r1.state)
    // ...and the first open from there is a plain online
    const r3 = reduceOffice(r2.state, conn('open'), at(T0 + 3_000))
    expect(r3.state.health).toMatchObject({ connection: 'online', onlineSince: T0 + 3_000 })
    expect(reduceConnection(r3.state.health, 'open', T0 + 4_000)).toBe(r3.state.health)
    expect(reduceConnection(r3.state.health, undefined, T0 + 4_000)).toBe(r3.state.health)
  })

  it('a health event stores the server report (with when it came) and touches nothing else', () => {
    const office = fullOffice(2)
    const h = report({ hooksSeen: 3, lastHookAt: T0 - 1_000, sessions: 1, agents: 2 })
    const { state, effects } = reduceOffice(office, healthEvent(h), at(T0 + 500))
    expect(state.health.server).toEqual(h)
    expect(state.health.reportedAt).toBe(T0 + 500)
    expect(state.health.connection).toBe(office.health.connection)
    // The roster is the same array: nobody moved, nothing re-renders for it
    expect(state.agents).toBe(office.agents)
    expect(state.meta).toBe(office.meta)
    expect(effects).toEqual([])
    // A health event with no payload is ignored
    expect(reduceOffice(state, { type: 'health' }, at(T0 + 600)).state).toBe(state)
  })

  it('connection and health never post chat lines or play sounds, in live or sim mode', () => {
    for (const live of [true, false]) {
      const { effects } = dispatchAll(emptyOffice(), [conn('open'), healthEvent(report()), conn('closed'), conn('open')], env({ live }))
      expect(effects).toEqual([])
    }
  })

  it('hookVerdict: unknown until a report, waiting while young, missing after HOOK_WARN_MS with both page and server up', () => {
    const connecting = emptyOffice().health
    expect(hookVerdict(connecting, T0)).toEqual({ kind: 'unknown' })

    // Online at T0, server up 10 min already, no hooks ever
    const online = dispatchAll(emptyOffice(), [conn('open'), healthEvent(report({ uptimeMs: 10 * 60_000 }))], at(T0)).state.health
    expect(hookVerdict(online, T0 + 1_000)).toEqual({ kind: 'waiting', forMs: 1_000 })
    expect(hookVerdict(online, T0 + HOOK_WARN_MS - 1)).toEqual({ kind: 'waiting', forMs: HOOK_WARN_MS - 1 })
    expect(hookVerdict(online, T0 + HOOK_WARN_MS)).toEqual({ kind: 'missing', forMs: HOOK_WARN_MS })
    // The threshold is a parameter (VITE_HOOK_WARN_MS lowers it for screenshots)
    expect(hookVerdict(online, T0 + 2_000, 1_500)).toEqual({ kind: 'missing', forMs: 2_000 })
  })

  it('hookVerdict: a server that just (re)started does not trigger the warning, however long the page has been open', () => {
    // Online for an hour, then the server comes back with 5 s of uptime and no hooks
    const h = dispatchAll(emptyOffice(), [conn('open')], at(T0)).state.health
    const fresh = reduceOffice({ ...emptyOffice(), health: h }, healthEvent(report({ uptimeMs: 5_000 })), at(T0 + 3_600_000)).state.health
    expect(hookVerdict(fresh, T0 + 3_600_000)).toEqual({ kind: 'waiting', forMs: 5_000 })
    // Its uptime keeps counting between reports, so the warning does come once it has been up long enough
    expect(hookVerdict(fresh, T0 + 3_600_000 + HOOK_WARN_MS)).toEqual({ kind: 'missing', forMs: HOOK_WARN_MS + 5_000 })
  })

  it('hookVerdict: once a hook has been seen it reports the age of the last one and the count', () => {
    const h = dispatchAll(emptyOffice(), [conn('open'), healthEvent(report({ hooksSeen: 42, lastHookAt: T0 - 12_000, uptimeMs: 99_000 }))], at(T0)).state.health
    expect(hookVerdict(h, T0)).toEqual({ kind: 'seen', agoMs: 12_000, count: 42 })
    // A clock a hair ahead of the server's never shows a negative age
    const ahead = { ...h, server: report({ hooksSeen: 1, lastHookAt: T0 + 50 }) }
    expect(hookVerdict(ahead, T0)).toEqual({ kind: 'seen', agoMs: 0, count: 1 })
  })

  it('hookVerdict: while offline or reconnecting the hooks question is moot — never "missing"', () => {
    const lost = dispatchAll(emptyOffice(), [conn('open'), healthEvent(report({ uptimeMs: 10 * 60_000 })), conn('closed')], at(T0)).state.health
    expect(lost.connection).toBe('reconnecting')
    expect(hookVerdict(lost, T0 + 2 * HOOK_WARN_MS)).toEqual({ kind: 'waiting', forMs: 0 })
    const never = dispatchAll(emptyOffice(), [conn('closed')], at(T0)).state.health
    expect(hookVerdict(never, T0 + 2 * HOOK_WARN_MS)).toEqual({ kind: 'unknown' })
  })

  it('the office keeps working through connection changes: a spawn after a reconnect seats the agent as usual', () => {
    const { state } = dispatchAll(emptyOffice(), [conn('open'), conn('closed'), conn('open'), spawn('w1')], at(T0))
    expect(agent(state, 'w1')?.state).toBe('new-hire')
    expect(state.health.connection).toBe('online')
  })
})

// ---------------------------------------------------------------------------
// F01 / F02 — a Claude per session that acts out the turn, and needs-you
// ---------------------------------------------------------------------------

/** A live office: the boss alone, until the server names a session */
function liveOffice(now = T0): OfficeState {
  return initialOfficeState([seated(BOSS_ID, 'boss', 'spot-1')], now)
}

const S1 = { sessionId: 's1', project: 'office', cwd: '/home/me/office' }
const S2 = { sessionId: 's2', project: 'api', cwd: '/home/me/api' }

/** A worker spawned for a session */
const spawnFor = (id: string, s: { sessionId: string; project: string }, role = 'debugger'): OfficeAction =>
  ({ type: 'agent_spawned', agent: { id, name: id, role, task: `task ${id}` }, sessionId: s.sessionId, project: s.project })

/** A live office with session s1's Claude seated (and n of its workers) */
function sessionOffice(n = 0): OfficeState {
  const ids = Array.from({ length: n }, (_, i) => `w${i + 1}`)
  const { state } = dispatchAll(liveOffice(), [{ type: 'session_started', ...S1 }, ...ids.map(id => spawnFor(id, S1))])
  return settle(state).state
}

const claudeOf = (s: OfficeState, sid: string) => agent(s, mainId(sid))
const msgs = (effects: OfficeEffect[]) => effects.filter(e => e.kind === 'msg') as Array<Extract<OfficeEffect, { kind: 'msg' }>>
const titles = (effects: OfficeEffect[]) => effects.filter(e => e.kind === 'title').map(e => (e as { prefix: string }).prefix)

describe('one Claude per session', () => {
  it('session_started seats a Claude for that session by the boss, with its own clock-in line', () => {
    const { state, effects } = reduceOffice(liveOffice(), { type: 'session_started', ...S1, model: 'claude-sonnet-4-5-20250929' }, env())
    const c = claudeOf(state, 's1')!
    expect(c.role).toBe('assistant')
    expect(c.name).toBe('Claude')
    expect(c.sessionId).toBe('s1')
    expect(c.project).toBe('office')
    expect(c.model).toBe('claude-sonnet-4-5-20250929')
    expect(c.assignedSpotId).toBe(CLAUDE_HOME_SPOT)
    expect(c.state).toBe('new-hire')
    expect(c.mainState).toBeUndefined()
    expect(sfx(effects)).toEqual(['doorOpen'])
    expect(msgs(effects)).toEqual([expect.objectContaining({ sender: 'Claude', role: 'assistant', text: '🤖 clocked in · office', agentId: mainId('s1') })])

    // It walks in and sits down idle (nothing heard from its main thread yet), not typing
    const { state: settled } = settle(state)
    expect(claudeOf(settled, 's1')!.state).toBe('idle')
    expect(claudeOf(settled, 's1')!.position).toEqual(claudeOf(settled, 's1')!.deskPosition)
    expect(settled.meta[mainId('s1')].idleSince).toBeNull()      // unknown is not asleep

    // The same session again is a no-op; a second session gets its own Claude at another desk
    const again = reduceOffice(settled, { type: 'session_started', ...S1 }, env())
    expect(again.state.agents).toHaveLength(settled.agents.length)
    expect(again.effects).toEqual([])
    const { state: two, effects: e2 } = reduceOffice(settled, { type: 'session_started', ...S2 }, env())
    const c2 = claudeOf(two, 's2')!
    expect(c2.assignedSpotId).not.toBe(CLAUDE_HOME_SPOT)
    expect(c2.assignedSpotId).toMatch(/^spot-/)
    // With two terminals open the chat line names the project
    expect(msgs(e2)[0].sender).toBe('Claude · api')
  })

  it('the first event of any kind from a session creates its Claude; nothing is created for an ended session', () => {
    const { state } = reduceOffice(liveOffice(), { type: 'agent_working', ...S1, status: 'reading a.ts' }, env())
    expect(claudeOf(state, 's1')).toBeDefined()
    const { state: ended } = reduceOffice(state, { type: 'session_ended', sessionId: 's1', reason: 'other' }, env())
    const { state: late } = reduceOffice(ended, { type: 'agent_working', sessionId: 's2', status: 'x' }, env({ now: T0 + 1 }))
    expect(claudeOf(late, 's2')).toBeDefined()               // another session is fine
    const { state: straggler, effects: none } = reduceOffice(late, { type: 'session_prompt', sessionId: 's1', text: 'late' }, env())
    expect(straggler).toBe(late)
    expect(none).toEqual([])
  })

  it('the snapshot seats a Claude per listed session, in the state the server records, and walks out the Claude of a session it no longer lists', () => {
    const office = sessionOffice()
    const { state, effects } = reduceOffice(office, {
      type: 'snapshot',
      activeAgents: [],
      sessions: [
        { id: 's2', project: 'api', state: 'active', main: { state: 'needs-you', since: T0 - 5000, needsYou: { kind: 'permission', toolName: 'Write', summary: 'src/a.ts', since: T0 - 5000 } } },
        { id: 's3', project: 'docs', state: 'active', main: { state: 'idle', since: T0 - 60_000 } },
      ],
    }, env())
    expect(claudeOf(state, 's1')!.state).toBe('completed')   // s1 is gone: its Claude is walking out
    const c2 = agent(state, mainId('s2'))!
    expect(c2.mainState).toBe('needs-you')
    expect(c2.needsYou).toEqual({ kind: 'permission', toolName: 'Write', summary: 'src/a.ts', since: T0 - 5000 })
    expect(c2.statusText).toBe('✋ needs you: Write · src/a.ts')
    expect(titles(effects)).toEqual(['✋ '])
    const c3 = agent(state, mainId('s3'))!
    expect(c3.mainState).toBe('idle')
    expect(state.meta[mainId('s3')].idleSince).toBe(T0 - 60_000) // long idle: asleep as soon as it sits down
    const { state: settled } = settle(state)
    expect(agent(settled, mainId('s1'))).toBeUndefined()
    expect(agent(settled, mainId('s2'))!.state).toBe('idle')    // blocked on you: not typing
    expect(agent(settled, mainId('s3'))!.state).toBe('idle')
  })

  it('a snapshot without a session list leaves the Claudes alone (older server)', () => {
    const office = sessionOffice()
    const { state } = reduceOffice(office, { type: 'snapshot', activeAgents: [] }, env())
    expect(claudeOf(state, 's1')!.state).toBe('idle')
  })

  it('session_ended keeps the Claude seated for the grace, then it clocks out; a resume within the grace keeps it', () => {
    const office = sessionOffice()
    const { state: s1, effects } = reduceOffice(office, { type: 'session_ended', sessionId: 's1', reason: 'prompt_input_exit' }, env())
    expect(claudeOf(s1, 's1')!.statusText).toBe('👋 session ended (prompt_input_exit)')
    expect(claudeOf(s1, 's1')!.mainState).toBeUndefined()
    expect(effects).toEqual([{ kind: 'schedule', action: { type: 'session_claude_leave', sessionId: 's1', endedAt: T0 }, delayMs: SESSION_CLAUDE_GRACE_MS }])

    const late = env({ now: T0 + SESSION_CLAUDE_GRACE_MS })
    const { state: gone, effects: bye } = reduceOffice(s1, { type: 'session_claude_leave', sessionId: 's1', endedAt: T0 }, late)
    expect(agent(gone, mainId('s1'))!.state).toBe('completed')
    expect(agent(gone, mainId('s1'))!.targetPosition).toEqual(DOOR_TARGET)
    expect(texts(bye)).toEqual(['👋 clocked out'])
    expect(sfx(bye)).toEqual([])                              // quiet: no celebration, no boss reply
    expect(agent(settle(gone, late).state, mainId('s1'))).toBeUndefined()

    // Resume before the grace is over: the leave is a no-op
    const { state: back } = reduceOffice(s1, { type: 'session_started', ...S1, source: 'resume' }, env())
    expect(back.endedSessions).toEqual({})
    const r = reduceOffice(back, { type: 'session_claude_leave', sessionId: 's1', endedAt: T0 }, late)
    expect(r.state).toBe(back)
    expect(claudeOf(r.state, 's1')!.state).toBe('idle')
  })

  it("end, resume and end again inside the grace: the first end's timer is stale and cannot cut the second grace short", () => {
    const at = (ms: number) => env({ now: T0 + ms })
    const leaveOf = (effects: OfficeEffect[]) => (effects.find(e => e.kind === 'schedule') as Extract<OfficeEffect, { kind: 'schedule' }>).action
    const { state: end1, effects: fx1 } = reduceOffice(sessionOffice(), { type: 'session_ended', sessionId: 's1' }, at(0))
    const { state: resumed } = reduceOffice(end1, { type: 'session_started', ...S1, source: 'resume' }, at(3000))
    const { state: end2, effects: fx2 } = reduceOffice(resumed, { type: 'session_ended', sessionId: 's1' }, at(6000))
    const leave1 = leaveOf(fx1)
    const leave2 = leaveOf(fx2)
    expect(leave1).toEqual({ type: 'session_claude_leave', sessionId: 's1', endedAt: T0 })
    expect(leave2).toEqual({ type: 'session_claude_leave', sessionId: 's1', endedAt: T0 + 6000 })

    // The first end's timer fires 4 s into the second grace: nothing happens
    const stale = reduceOffice(end2, leave1, at(SESSION_CLAUDE_GRACE_MS))
    expect(stale.state).toBe(end2)
    expect(stale.effects).toEqual([])
    expect(claudeOf(stale.state, 's1')!.state).toBe('idle')

    // So a resume 5 s into the second grace keeps the same Claude seated: no door, no clock-in
    const { state: back, effects: welcome } = reduceOffice(stale.state, { type: 'session_started', ...S1, source: 'resume' }, at(11_000))
    expect(sfx(welcome)).toEqual([])
    expect(msgs(welcome)).toEqual([])
    expect(claudeOf(back, 's1')!.state).toBe('idle')
    expect(reduceOffice(back, leave2, at(16_000)).state).toBe(back)

    // Without that resume, the second end's own timer clocks it out
    const { state: out, effects: bye } = reduceOffice(end2, leave2, at(16_000))
    expect(agent(out, mainId('s1'))!.state).toBe('completed')
    expect(texts(bye)).toEqual(['👋 clocked out'])
  })

  it('a snapshot that lists the session as ended stops its Claude at once, as session_ended does: hand down, no ✋ in the title, not typing', () => {
    const ended = (reason?: string): OfficeAction => ({ type: 'snapshot', activeAgents: [], sessions: [{ id: 's1', project: 'office', state: 'ended', reason, hooked: true, main: { state: 'idle' } }] })
    const { state: raised } = reduceOffice(sessionOffice(), { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'rm -rf dist' }, env())
    const { state, effects } = reduceOffice(raised, ended('prompt_input_exit'), env())
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBeUndefined()
    expect(c.needsYou).toBeUndefined()
    expect(c.state).toBe('idle')                               // still at its desk for the grace
    expect(c.statusText).toBe('👋 session ended (prompt_input_exit)')
    expect(titles(effects)).toEqual([''])
    expect(effects.filter(e => e.kind === 'schedule')).toEqual([
      { kind: 'schedule', action: { type: 'session_claude_leave', sessionId: 's1', endedAt: T0 }, delayMs: SESSION_CLAUDE_GRACE_MS },
    ])
    // The same snapshot again during the grace: nothing more
    expect(reduceOffice(state, ended('prompt_input_exit'), env({ now: T0 + 2000 })).effects).toEqual([])

    // A Claude that was typing stops
    const { state: working } = reduceOffice(sessionOffice(), { type: 'session_prompt', ...S1, text: 'go' }, env())
    const { state: stopped } = reduceOffice(working, ended(), env())
    expect(claudeOf(stopped, 's1')!.state).toBe('idle')
    expect(claudeOf(stopped, 's1')!.mainState).toBeUndefined()
    expect(claudeOf(stopped, 's1')!.statusText).toBe('👋 session ended')
  })

  it("on a reload the snapshot seats each session's Claude by the boss before its workers take their desks", () => {
    const worker = (id: string, role: string) => ({ id, name: id, role, task: 'fix', state: 'working', status: 'x', sessionId: 's1', project: 'office' })
    const sessions = [{ id: 's1', project: 'office', state: 'active' as const, main: { state: 'working' as const, since: T0 } }]
    const { state } = reduceOffice(liveOffice(), { type: 'snapshot', activeAgents: [worker('agent-a', 'debugger'), worker('agent-b', 'code-reviewer')], sessions }, env())
    expect(claudeOf(state, 's1')!.assignedSpotId).toBe(CLAUDE_HOME_SPOT)
    expect(agent(state, 'agent-a')!.assignedSpotId).toBe('spot-3')
    expect(agent(state, 'agent-b')!.assignedSpotId).toBe('spot-4')
    // The workers still walk in with their task line, after the Claude's clock-in
    expect(texts(reduceOffice(liveOffice(), { type: 'snapshot', activeAgents: [worker('agent-a', 'debugger')], sessions }, env()).effects))
      .toEqual(['🤖 clocked in · office', '📋 fix'])

    // A browsing role still takes the filing cabinet
    const { state: browsing } = reduceOffice(liveOffice(), { type: 'snapshot', activeAgents: [worker('agent-e', 'Explore')], sessions }, env())
    expect(agent(browsing, 'agent-e')!.assignedSpotId).toBe('spot-filing')
    expect(claudeOf(browsing, 's1')!.assignedSpotId).toBe(CLAUDE_HOME_SPOT)
  })

  it('a Claude between turns joins a fire drill; one mid-turn or with a hand up stays at its desk (C32 for Claude)', () => {
    const { state } = dispatchAll(sessionOffice(), [
      { type: 'session_started', ...S2 },
      { type: 'session_prompt', ...S2, text: 'go' },
    ])
    const settled = settle(state).state
    expect(claudeOf(settled, 's1')!.mainState).toBeUndefined()
    expect(claudeOf(settled, 's2')!.mainState).toBe('working')
    const { movedIds } = moveAgentsForEvent(settled.agents, { x: 67.5, y: 48.9 }, 'Fire Drill', env({ live: true }))
    expect(movedIds).toContain(mainId('s1'))
    expect(movedIds).not.toContain(mainId('s2'))
    expect(pickSingleEventAgent(settled.agents, env({ live: true }))!.id).toBe(mainId('s1'))
  })
})

describe('sessions without hooks (the registry roster)', () => {
  const R1 = { sessionId: 'r1', project: 'office', cwd: '/home/me/office' }

  it('session_started { hooked: false } seats no Claude; the same session arriving hooked later gets one', () => {
    const office = liveOffice()
    const r = reduceOffice(office, { type: 'session_started', ...R1, hooked: false, source: 'registry', main: { state: 'working', since: T0 } }, env())
    expect(r.state).toBe(office)
    expect(r.effects).toEqual([])
    expect(claudeOf(r.state, 'r1')).toBeUndefined()

    // The first hook event flipped it on the server: session_started comes again with hooked: true
    const flipped = reduceOffice(r.state, { type: 'session_started', ...R1, hooked: true, source: 'implicit' }, env())
    const c = claudeOf(flipped.state, 'r1')!
    expect(c.name).toBe(AGENT_CONFIGS['assistant'].title)
    expect(c.sessionId).toBe('r1')
    expect(c.assignedSpotId).toBe(CLAUDE_HOME_SPOT)
    expect(msgs(flipped.effects)).toEqual([expect.objectContaining({ role: 'assistant', text: '🤖 clocked in · office', agentId: mainId('r1') })])
  })

  it('the snapshot seats a Claude only for hooked sessions, and walks out the Claude of one it now lists as unhooked', () => {
    const office = sessionOffice()
    const { state, effects } = reduceOffice(office, {
      type: 'snapshot',
      activeAgents: [],
      sessions: [
        { id: 's1', project: 'office', state: 'active', hooked: false, main: { state: 'working' } },
        { id: 'r2', project: 'api', state: 'active', hooked: false, main: { state: 'needs-you', needsYou: { kind: 'registry', summary: 'waiting in the terminal' } } },
        { id: 's2', project: 'docs', state: 'active', hooked: true, main: { state: 'idle', since: T0 } },
        { id: 'r3', project: 'old', state: 'ended', hooked: false },
      ],
    }, env())
    expect(claudeOf(state, 's1')!.state).toBe('completed')     // the server only knows s1 from the registry now
    expect(claudeOf(state, 'r2')).toBeUndefined()
    expect(claudeOf(state, 's2')).toBeDefined()
    expect(claudeOf(state, 'r3')).toBeUndefined()
    expect(state.endedSessions).toEqual({})                    // an ended unhooked session schedules no leave
    expect(titles(effects)).toEqual([])                        // a registry needs-you raises no ✋ in the title
  })

  it('session_registry changes nothing on the floor; session_ended of an unhooked session finds no Claude to send home', () => {
    const office = sessionOffice()
    const r = reduceOffice(office, { type: 'session_registry', sessionId: 's1', hooked: true, registry: { pid: 4242, status: 'idle' }, main: { state: 'working' } }, env())
    expect(r.state).toBe(office)
    expect(r.effects).toEqual([])
    const e = reduceOffice(office, { type: 'session_ended', sessionId: 'r9', hooked: false, reason: 'exited' }, env())
    expect(claudeOf(e.state, 'r9')).toBeUndefined()
    expect(claudeOf(e.state, 's1')!.state).toBe('idle')
    expect(e.effects).toEqual([{ kind: 'schedule', action: { type: 'session_claude_leave', sessionId: 'r9', endedAt: T0 }, delayMs: SESSION_CLAUDE_GRACE_MS }])
    const { state: later } = reduceOffice(e.state, { type: 'session_claude_leave', sessionId: 'r9', endedAt: T0 }, env({ now: T0 + SESSION_CLAUDE_GRACE_MS }))
    expect(later.agents).toHaveLength(e.state.agents.length)
  })
})

describe("main-thread activity lands on the session's Claude", () => {
  it('an agent_working with a sessionId and no agentId is that Claude working, never a worker', () => {
    const office = sessionOffice(2)
    const w1Before = agent(office, 'w1')!
    const { state, effects } = reduceOffice(office, { type: 'agent_working', ...S1, status: 'editing src/a.ts' }, env())
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('working')
    expect(c.state).toBe('working')
    expect(c.statusText).toBe('editing src/a.ts')
    expect(agent(state, 'w1')).toBe(w1Before)
    expect(agent(state, 'w2')!.statusText).not.toBe('editing src/a.ts')
    expect(msgs(effects)).toEqual([expect.objectContaining({ sender: 'Claude', role: 'assistant', text: '⚡ editing src/a.ts', agentId: mainId('s1') })])

    const failed = reduceOffice(state, { type: 'agent_working', ...S1, status: 'running: npm test', failed: true }, env())
    expect(claudeOf(failed.state, 's1')!.lastFailed).toBe(true)
    expect(texts(failed.effects)).toEqual(['❌ running: npm test'])
  })

  it('without a sessionId (old hook) a worker shows it, or the only Claude when no worker is at work', () => {
    const withWorkers = sessionOffice(1)
    const r1 = reduceOffice(withWorkers, { type: 'agent_working', status: 'grep' }, env())
    expect(agent(r1.state, 'w1')!.statusText).toBe('grep')
    expect(claudeOf(r1.state, 's1')!.statusText).not.toBe('grep')

    const alone = sessionOffice()
    const r2 = reduceOffice(alone, { type: 'agent_working', status: 'grep' }, env())
    expect(claudeOf(r2.state, 's1')!.statusText).toBe('grep')
    expect(claudeOf(r2.state, 's1')!.mainState).toBe('working')
  })

  it('a status for a Claude still walking in is posted now and shown on arrival (C13)', () => {
    const { state } = reduceOffice(liveOffice(), { type: 'session_started', ...S1 }, env())
    const { state: s1, effects } = reduceOffice(state, { type: 'agent_working', ...S1, status: 'reading README' }, env())
    expect(claudeOf(s1, 's1')!.state).toBe('new-hire')
    expect(texts(effects)).toEqual(['⚡ reading README'])
    const { state: s2 } = settle(s1)
    expect(claudeOf(s2, 's1')!.state).toBe('working')
    expect(claudeOf(s2, 's1')!.statusText).toBe('reading README')
  })
})

describe("a Claude's status line survives its walks", () => {
  it('a Claude that sits down after a walk-in shows the turn as it stands, not a tool call from earlier in it', () => {
    // A prompt, a tool call and the turn end, all before the new Claude reaches its desk
    const { state } = dispatchAll(liveOffice(), [
      { type: 'session_prompt', ...S1, text: 'fix the build' },
      { type: 'agent_working', ...S1, status: 'Reading src/a.ts' },
      { type: 'session_turn_end', ...S1, text: 'done', backgroundTasks: [] },
    ])
    expect(claudeOf(state, 's1')!.state).toBe('new-hire')
    const seated = claudeOf(settle(state).state, 's1')!
    expect(seated.state).toBe('idle')
    expect(seated.statusText).toBe('turn over — idle')
    expect(seated.lastFailed).toBe(false)

    // A failed tool call, then a hand up
    const { state: s2 } = dispatchAll(liveOffice(), [
      { type: 'session_prompt', ...S1, text: 'fix the build' },
      { type: 'agent_working', ...S1, status: 'failed: Bash — Exit code 1', failed: true },
      { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'rm -rf build' },
    ])
    const raised = claudeOf(settle(s2).state, 's1')!
    expect(raised.mainState).toBe('needs-you')
    expect(raised.statusText).toBe('✋ needs you: Bash · rm -rf build')
  })

  it('a Claude back from a fire drill keeps its own line, and one a prompt reached at the drill shows that prompt', () => {
    const drill = { x: 67.5, y: 48.9 }
    const idle = settle(reduceOffice(sessionOffice(), { type: 'session_turn_end', ...S1, text: 'done', backgroundTasks: [] }, env()).state).state
    const { agents, movedIds } = moveAgentsForEvent(idle.agents, drill, 'Fire Drill', env())
    expect(movedIds).toContain(mainId('s1'))
    const atDrill = settle({ ...idle, agents }).state
    expect(claudeOf(atDrill, 's1')!.statusText).toBe('turn over — idle')
    expect(agent(atDrill, BOSS_ID)!.statusText).toBe('Fire Drill')   // the boss still plays along

    const back = settle({ ...atDrill, agents: returnAgentsFromEvent(atDrill.agents, movedIds, env()) }).state
    expect(claudeOf(back, 's1')!.state).toBe('idle')
    expect(claudeOf(back, 's1')!.statusText).toBe('turn over — idle')

    const { state: prompted } = reduceOffice(atDrill, { type: 'session_prompt', ...S1, text: 'add tests for the parser' }, env())
    const backToWork = settle({ ...prompted, agents: returnAgentsFromEvent(prompted.agents, movedIds, env()) }).state
    expect(claudeOf(backToWork, 's1')!.state).toBe('working')
    expect(claudeOf(backToWork, 's1')!.statusText).toBe('✍ add tests for the parser')
  })

  it('a Claude seated from the lobby keeps its needs-you line', () => {
    const desks = MAIN_ROOM.agentSpots.filter(s => s.type === 'desk').length
    const ids = Array.from({ length: desks - 1 }, (_, i) => `w${i + 1}`)  // the boss has the other desk
    const full = settle(dispatchAll(liveOffice(), ids.map(id => spawn(id))).state).state
    const { state: waiting } = reduceOffice(full, { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'npm test' }, env())
    expect(waiting.lobby).toEqual([mainId('s1')])
    const late = env({ now: T0 + MIN_VISIBLE_TIME + 1 })
    const { state: freed } = reduceOffice(settle(waiting).state, { type: 'agent_completed', agentId: 'w3', result: 'done' }, late)
    const seated = settle(freed, late).state
    const c = claudeOf(seated, 's1')!
    expect(c.assignedSpotId).toBeDefined()
    expect(c.state).toBe('idle')
    expect(c.mainState).toBe('needs-you')
    expect(c.statusText).toBe('✋ needs you: Bash · npm test')
  })
})

describe('session_prompt: the boss hands the prompt over, Claude types', () => {
  it("walks the boss to Claude's desk with the prompt as his line, posts the prompt as his chat row, and starts Claude working", () => {
    const office = sessionOffice()
    const claude = claudeOf(office, 's1')!
    const { state, effects } = reduceOffice(office, { type: 'session_prompt', ...S1, text: 'Fix the flaky purity test in tests/officeReducer.test.ts please', promptId: 'p1' }, env())

    const boss = agent(state, BOSS_ID)!
    expect(boss.state).toBe('walking-to-manager')
    expect(boss.targetPosition).toEqual({ x: claude.deskPosition.x + 4, y: claude.deskPosition.y + 2 })
    expect(boss.statusText).toBe('Fix the flaky purity test in tests/officeReducer.test.ts pl…')   // 60 chars for a bubble
    expect(state.handoverSeq).toBe(1)

    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('working')
    expect(c.state).toBe('working')
    expect(c.statusText).toBe('✍ Fix the flaky purity test in tests/officeReducer.test.ts pl…')

    expect(msgs(effects)).toEqual([expect.objectContaining({ sender: BOSS_NAME, role: 'boss', text: 'Fix the flaky purity test in tests/officeReducer.test.ts please', tag: 'prompt', agentId: BOSS_ID })])
    expect(sfx(effects)).toEqual(['typing'])
    expect(effects).toContainEqual({ kind: 'schedule', action: { type: 'handover_over', seq: 1 }, delayMs: HANDOVER_MAX_MS })

    // He arrives, says his line (talking-to-manager drives the speech bubble) and the dwell is scheduled
    const { state: arrived, effects: walk } = settle(state)
    expect(agent(arrived, BOSS_ID)!.state).toBe('talking-to-manager')
    expect(walk).toContainEqual({ kind: 'schedule', action: { type: 'handover_over', seq: 1 }, delayMs: HANDOVER_DWELL_MS })

    // A stale timer is ignored; the right one sends him back to his desk
    expect(reduceOffice(arrived, { type: 'handover_over', seq: 0 }, env()).state).toBe(arrived)
    const { state: back } = reduceOffice(arrived, { type: 'handover_over', seq: 1 }, env())
    expect(agent(back, BOSS_ID)!.state).toBe('walking-to-desk')
    expect(agent(back, BOSS_ID)!.targetPosition).toEqual(agent(back, BOSS_ID)!.deskPosition)
    const { state: home } = settle(back)
    expect(agent(home, BOSS_ID)!.state).toBe('working')
    expect(claudeOf(home, 's1')!.state).toBe('working')        // Claude kept typing throughout
  })

  it('a second prompt while the boss is still over there just gives him the new line, with a new sequence', () => {
    const office = sessionOffice()
    const { state: s1 } = reduceOffice(office, { type: 'session_prompt', ...S1, text: 'first' }, env())
    const { state: there } = settle(s1)
    const { state: s2, effects } = reduceOffice(there, { type: 'session_prompt', ...S1, text: 'second' }, env())
    expect(agent(s2, BOSS_ID)!.state).toBe('talking-to-manager')
    expect(agent(s2, BOSS_ID)!.statusText).toBe('second')
    expect(s2.handoverSeq).toBe(2)
    expect(effects).toContainEqual({ kind: 'schedule', action: { type: 'handover_over', seq: 2 }, delayMs: HANDOVER_DWELL_MS })
    expect(reduceOffice(s2, { type: 'handover_over', seq: 1 }, env()).state).toBe(s2)
  })

  it('a prompt while the boss walks back from the last hand-over turns him round with the new line', () => {
    const { state: s1 } = reduceOffice(sessionOffice(), { type: 'session_prompt', ...S1, text: 'first' }, env())
    const { state: there } = settle(s1)
    const visitSpot = { ...agent(there, BOSS_ID)!.position }
    const { state: leaving } = reduceOffice(there, { type: 'handover_over', seq: 1 }, env())
    // Twenty frames on he is well on his way home, but not there
    let walking = leaving
    for (let i = 0; i < 20; i++) walking = stepOffice(walking, 1, env()).state
    const boss = agent(walking, BOSS_ID)!
    expect(boss.state).toBe('walking-to-desk')
    expect(Math.hypot(boss.position.x - visitSpot.x, boss.position.y - visitSpot.y)).toBeGreaterThan(1)

    const { state: s2, effects } = reduceOffice(walking, { type: 'session_prompt', ...S1, text: 'yes, continue' }, env())
    expect(s2.handoverSeq).toBe(2)
    expect(effects).toContainEqual({ kind: 'schedule', action: { type: 'handover_over', seq: 2 }, delayMs: HANDOVER_MAX_MS })
    expect(agent(s2, BOSS_ID)!.state).toBe('walking-to-manager')
    expect(agent(s2, BOSS_ID)!.statusText).toBe('yes, continue')
    expect(agent(s2, BOSS_ID)!.targetPosition).toEqual(visitSpot)
    const { state: back, effects: walk } = settle(s2)
    expect(agent(back, BOSS_ID)!.state).toBe('talking-to-manager')
    expect(walk).toContainEqual({ kind: 'schedule', action: { type: 'handover_over', seq: 2 }, delayMs: HANDOVER_DWELL_MS })

    // A frame after he set off he is still beside Claude: he just says the new line
    const { state: s3 } = reduceOffice(stepOffice(leaving, 1, env()).state, { type: 'session_prompt', ...S1, text: 'and the docs' }, env())
    expect(agent(s3, BOSS_ID)!.state).toBe('talking-to-manager')
    expect(agent(s3, BOSS_ID)!.statusText).toBe('and the docs')

    // Once he has sat down the walk home is over: the mark is cleared
    const { state: home } = settle(leaving)
    expect(agent(home, BOSS_ID)!.state).toBe('working')
    expect(home.meta[BOSS_ID].homeFromHandover).toBe(false)
  })

  it('a prompt while the boss walks back from a fire drill or an errand does not turn him round', () => {
    const office = sessionOffice()
    const { agents, movedIds } = moveAgentsForEvent(office.agents, { x: 67.5, y: 48.9 }, 'Fire Drill', env())
    const atDrill = settle({ ...office, agents }).state
    const returning = { ...atDrill, agents: returnAgentsFromEvent(atDrill.agents, movedIds, env()) }
    expect(agent(returning, BOSS_ID)!.state).toBe('walking-to-desk')
    const { state } = reduceOffice(returning, { type: 'session_prompt', ...S1, text: 'go' }, env())
    expect(state.handoverSeq).toBe(0)
    expect(agent(state, BOSS_ID)!.state).toBe('walking-to-desk')
    expect(agent(state, BOSS_ID)!.statusText).toBe('back to work')
    expect(claudeOf(state, 's1')!.mainState).toBe('working')

    // Walking home from a hand-over, but the person sent him off somewhere else (the coffee machine)
    const { state: there } = settle(reduceOffice(office, { type: 'session_prompt', ...S1, text: 'first' }, env()).state)
    const { state: leaving } = reduceOffice(there, { type: 'handover_over', seq: 1 }, env())
    const errand = { ...leaving, agents: leaving.agents.map(a => (a.id === BOSS_ID ? { ...a, targetPosition: { x: 73.5, y: 56.7 }, statusText: 'coffee time' } : a)) }
    const { state: s2 } = reduceOffice(errand, { type: 'session_prompt', ...S1, text: 'second' }, env())
    expect(s2.handoverSeq).toBe(1)
    expect(agent(s2, BOSS_ID)!.statusText).toBe('coffee time')
  })

  it('a wake-up from a background worker is a note on Claude, not a walk', () => {
    const office = sessionOffice(1)
    // The hook names the subagent id; the server adds the office id when it knows the worker
    const { state, effects } = reduceOffice(office, { type: 'session_prompt', ...S1, isWakeup: true, wakeupAgentId: 'a4b69979afca21afd', wakeupOfficeId: 'w1', text: 'tests pass' }, env())
    expect(agent(state, BOSS_ID)!.state).toBe('working')
    expect(state.handoverSeq).toBe(0)
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('working')
    expect(c.statusText).toBe('📬 w1 reported back')
    expect(msgs(effects)).toEqual([expect.objectContaining({ sender: 'Claude', text: '📬 w1 reported back' })])
    expect(sfx(effects)).toEqual([])
  })

  it('with logPrompts off the text is absent: no prompt row, a generic bubble, Claude still works', () => {
    const office = sessionOffice()
    const { state, effects } = reduceOffice(office, { type: 'session_prompt', ...S1, text: '' }, env())
    expect(msgs(effects)).toEqual([])
    expect(agent(state, BOSS_ID)!.statusText).toBe('📝 new prompt')
    expect(claudeOf(state, 's1')!.statusText).toBe('✍ working on a prompt')
    expect(claudeOf(state, 's1')!.mainState).toBe('working')
  })

  it('the boss only goes when he is at his desk; Claude works either way', () => {
    const office = sessionOffice()
    const onBreak = { ...office, agents: office.agents.map(a => (a.id === BOSS_ID ? { ...a, state: 'coffee-break' as const } : a)) }
    const { state } = reduceOffice(onBreak, { type: 'session_prompt', ...S1, text: 'go' }, env())
    expect(agent(state, BOSS_ID)!.state).toBe('coffee-break')
    expect(state.handoverSeq).toBe(0)
    expect(claudeOf(state, 's1')!.mainState).toBe('working')
  })
})

describe('session_turn_end: the reply, then idle or waiting', () => {
  it("posts the reply as Claude's chat row and goes idle with the sleep timer started", () => {
    const { state: working } = reduceOffice(sessionOffice(), { type: 'session_prompt', ...S1, text: 'go' }, env())
    const { state, effects } = reduceOffice(working, { type: 'session_turn_end', ...S1, text: 'All 289 tests pass.', backgroundTasks: [], crons: [], stopHookActive: false }, env({ now: T0 + 5000 }))
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('idle')
    expect(c.state).toBe('idle')
    expect(c.statusText).toBe('turn over — idle')
    expect(c.waitingOn).toBeUndefined()
    expect(state.meta[mainId('s1')].idleSince).toBe(T0 + 5000)     // sleeping.png after 30 s (getEffect)
    expect(msgs(effects)).toEqual([expect.objectContaining({ sender: 'Claude', text: 'All 289 tests pass.', tag: 'reply', agentId: mainId('s1') })])

    // The next prompt wakes it: the timer is cleared
    const { state: again } = reduceOffice(state, { type: 'session_prompt', ...S1, text: 'more' }, env({ now: T0 + 9000 }))
    expect(again.meta[mainId('s1')].idleSince).toBeNull()
    expect(claudeOf(again, 's1')!.state).toBe('working')
  })

  it('with background workers still out it waits on them (glass of water), counting the unfinished ones', () => {
    const { state, effects } = reduceOffice(sessionOffice(), {
      type: 'session_turn_end', ...S1, text: 'Kicked off two reviewers.',
      backgroundTasks: [
        { id: 't1', type: 'subagent', status: 'running', description: 'review PR' },
        { id: 't2', type: 'shell', status: 'running', description: 'npm test' },
        { id: 't3', type: 'subagent', status: 'completed', description: 'done already' },
      ],
    }, env())
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('waiting')
    expect(c.state).toBe('idle')
    expect(c.waitingOn).toBe(2)
    expect(c.statusText).toBe('⏳ waiting on 2 background workers')
    expect(state.meta[mainId('s1')].idleSince).toBeNull()        // waiting is not asleep
    expect(texts(effects)).toEqual(['Kicked off two reviewers.'])

    // The server's own count wins when it sends one
    const { state: one } = reduceOffice(sessionOffice(), { type: 'session_turn_end', ...S1, backgroundTasks: [], main: { state: 'waiting', waitingOn: 1 } }, env())
    expect(claudeOf(one, 's1')!.statusText).toBe('⏳ waiting on 1 background worker')
  })

  it('without text (logPrompts off) there is no reply row, only the state change', () => {
    const { state, effects } = reduceOffice(sessionOffice(), { type: 'session_turn_end', ...S1, text: '', backgroundTasks: [] }, env())
    expect(msgs(effects)).toEqual([])
    expect(claudeOf(state, 's1')!.mainState).toBe('idle')
  })
})

describe('session_compact: memory wipe', () => {
  it('pre sweeps the desk and remembers the state; post goes back to it', () => {
    const { state: working } = reduceOffice(sessionOffice(), { type: 'session_prompt', ...S1, text: 'go' }, env())
    const { state: pre, effects } = reduceOffice(working, { type: 'session_compact', ...S1, phase: 'pre', trigger: 'auto' }, env())
    const c = claudeOf(pre, 's1')!
    expect(c.mainState).toBe('compacting')
    expect(c.state).toBe('working')
    expect(c.statusText).toBe('🧹 memory wipe')
    expect(pre.meta[mainId('s1')].beforeCompact).toBe('working')
    expect(texts(effects)).toEqual(['🧹 memory wipe (auto)'])

    const { state: post, effects: quiet } = reduceOffice(pre, { type: 'session_compact', ...S1, phase: 'post', trigger: 'auto' }, env())
    expect(claudeOf(post, 's1')!.mainState).toBe('working')
    expect(claudeOf(post, 's1')!.statusText).toBe('✍ back to work')
    expect(post.meta[mainId('s1')].beforeCompact).toBeUndefined()
    expect(texts(quiet)).toEqual([])

    // A manual /compact at idle comes back idle
    const { state: idle } = reduceOffice(sessionOffice(), { type: 'session_turn_end', ...S1, backgroundTasks: [] }, env())
    const { state: pre2 } = reduceOffice(idle, { type: 'session_compact', ...S1, phase: 'pre', trigger: 'manual' }, env())
    const { state: post2 } = reduceOffice(pre2, { type: 'session_compact', ...S1, phase: 'post', trigger: 'manual' }, env())
    expect(claudeOf(post2, 's1')!.mainState).toBe('idle')
    expect(claudeOf(post2, 's1')!.state).toBe('idle')

    // A wipe while waiting on workers comes back waiting on them, count and line intact
    const tasks = [{ id: 't1', type: 'subagent', status: 'running' }, { id: 't2', type: 'shell', status: 'running' }]
    const { state: waiting } = reduceOffice(sessionOffice(), { type: 'session_turn_end', ...S1, backgroundTasks: tasks }, env())
    const { state: pre3 } = reduceOffice(waiting, { type: 'session_compact', ...S1, phase: 'pre', trigger: 'auto' }, env())
    expect(claudeOf(pre3, 's1')!.statusText).toBe('🧹 memory wipe')
    const { state: post3 } = reduceOffice(pre3, { type: 'session_compact', ...S1, phase: 'post', trigger: 'auto' }, env())
    expect(claudeOf(post3, 's1')!.mainState).toBe('waiting')
    expect(claudeOf(post3, 's1')!.waitingOn).toBe(2)
    expect(claudeOf(post3, 's1')!.statusText).toBe('⏳ waiting on 2 background workers')

    // With the server's record on the post event, that record wins
    const { state: post4 } = reduceOffice(pre3, { type: 'session_compact', ...S1, phase: 'post', trigger: 'auto', main: { state: 'idle', since: T0 + 5 } }, env())
    expect(claudeOf(post4, 's1')!.mainState).toBe('idle')
  })
})

describe('session_error', () => {
  it('shows the red API-error state with a chat line and the error sound, until the next prompt', () => {
    const { state, effects } = reduceOffice(sessionOffice(), { type: 'session_error', ...S1, error: 'rate_limit', detail: 'Rate limit reached, retry in 30s' }, env())
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('error')
    expect(c.state).toBe('idle')
    expect(c.statusText).toBe('⚠ API error: rate_limit')
    expect(texts(effects)).toEqual(['⚠ API error: rate_limit — Rate limit reached, retry in 30s'])
    expect(sfx(effects)).toEqual(['error'])
    const { state: next } = reduceOffice(state, { type: 'session_prompt', ...S1, text: 'retry' }, env())
    expect(claudeOf(next, 's1')!.mainState).toBe('working')
  })
})

describe('session_needs_you (F02)', () => {
  const permission: OfficeAction = { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'rm -rf dist', message: 'Claude needs your permission' }

  it('a permission request raises the hand, turns the pill amber, chimes once and prefixes the title', () => {
    const { state: working } = reduceOffice(sessionOffice(), { type: 'session_prompt', ...S1, text: 'clean up' }, env())
    const { state, effects } = reduceOffice(working, permission, env({ now: T0 + 100 }))
    const c = claudeOf(state, 's1')!
    expect(c.mainState).toBe('needs-you')
    expect(c.state).toBe('idle')                               // not typing while blocked on you
    expect(c.needsYou).toEqual({ kind: 'permission', toolName: 'Bash', summary: 'rm -rf dist', message: 'Claude needs your permission', since: T0 + 100 })
    expect(c.statusText).toBe('✋ needs you: Bash · rm -rf dist')
    expect(texts(effects)).toEqual(['✋ needs you: Bash · rm -rf dist'])
    expect(sfx(effects)).toEqual(['needsYou'])
    expect(titles(effects)).toEqual(['✋ '])

    // The same request again (the trailing Notification): nothing new
    const again = reduceOffice(state, permission, env({ now: T0 + 6000 }))
    expect(again.effects.filter(e => e.kind !== 'title')).toEqual([])
    expect(titles(again.effects)).toEqual([])
    expect(claudeOf(again.state, 's1')!.needsYou!.since).toBe(T0 + 100)
  })

  it('clears on the next tool call, prompt, turn end or a server record that has moved on — and the title prefix goes', () => {
    const { state: raised } = reduceOffice(sessionOffice(), permission, env())
    const clears: OfficeAction[] = [
      { type: 'agent_working', ...S1, status: 'running: rm -rf dist' },
      { type: 'session_prompt', ...S1, text: 'ok go' },
      { type: 'session_turn_end', ...S1, text: 'done', backgroundTasks: [] },
      { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', main: { state: 'working' } },
      { type: 'session_ended', sessionId: 's1' },
    ]
    for (const clear of clears) {
      const { state, effects } = reduceOffice(raised, clear, env())
      expect(claudeOf(state, 's1')!.mainState, clear.type).not.toBe('needs-you')
      expect(claudeOf(state, 's1')!.needsYou, clear.type).toBeUndefined()
      expect(titles(effects), clear.type).toEqual([''])
    }
    // Two sessions with hands up: the prefix stays until the last one is cleared
    const { state: both } = dispatchAll(raised, [{ type: 'session_started', ...S2 }, { ...permission, ...S2 }])
    const { state: one, effects: e1 } = reduceOffice(both, { type: 'agent_working', ...S1, status: 'x' }, env())
    expect(titles(e1)).toEqual([])
    const { effects: e2 } = reduceOffice(one, { type: 'agent_working', ...S2, status: 'x' }, env())
    expect(titles(e2)).toEqual([''])
  })

  it('session_main (the server lowered the hand: the granted tool ran, or nobody answered for 10 min) clears it with a line', () => {
    const { state: raised } = reduceOffice(sessionOffice(), permission, env())
    const granted = reduceOffice(raised, { type: 'session_main', sessionId: 's1', project: 'office', reason: 'permission answered', main: { state: 'working', since: T0 + 2000, waitingOn: 0 } }, env())
    expect(claudeOf(granted.state, 's1')!.mainState).toBe('working')
    expect(claudeOf(granted.state, 's1')!.needsYou).toBeUndefined()
    expect(texts(granted.effects)).toEqual(['✅ permission answered'])
    expect(titles(granted.effects)).toEqual([''])

    const timedOut = reduceOffice(raised, { type: 'session_main', sessionId: 's1', reason: 'needs-you timed out', main: { state: 'idle', since: T0 + 600_000, waitingOn: 0 } }, env({ now: T0 + 600_000 }))
    expect(claudeOf(timedOut.state, 's1')!.mainState).toBe('idle')
    expect(timedOut.state.meta[mainId('s1')].idleSince).toBe(T0 + 600_000)
    expect(texts(timedOut.effects)).toEqual(['💤 needs-you timed out'])

    // A session_main for a session we have not seen seats its Claude in that state
    const fresh = reduceOffice(liveOffice(), { type: 'session_main', ...S2, reason: 'x', main: { state: 'error', error: { error: 'overloaded', detail: '529' } } }, env())
    expect(claudeOf(fresh.state, 's2')!.mainState).toBe('error')
    expect(claudeOf(fresh.state, 's2')!.statusText).toBe('⚠ API error: overloaded')
  })

  it('session_tool_done lowers a permission hand for that tool or for the whole batch, and nothing else', () => {
    const { state: raised } = reduceOffice(sessionOffice(), permission, env())
    expect(reduceOffice(raised, { type: 'session_tool_done', sessionId: 's1', toolName: 'Read' }, env()).state).toBe(raised)
    expect(reduceOffice(raised, { type: 'session_tool_done', sessionId: 's2', toolName: 'Bash' }, env()).state).toBe(raised)
    const ran = reduceOffice(raised, { type: 'session_tool_done', sessionId: 's1', toolName: 'Bash' }, env())
    expect(claudeOf(ran.state, 's1')!.mainState).toBe('working')
    expect(claudeOf(ran.state, 's1')!.statusText).toBe('⚡ Bash ran')
    expect(texts(ran.effects)).toEqual(['✅ permission answered — Bash ran'])
    expect(titles(ran.effects)).toEqual([''])
    const batch = reduceOffice(raised, { type: 'session_tool_done', sessionId: 's1', batch: true, count: 2 }, env())
    expect(claudeOf(batch.state, 's1')!.statusText).toBe('⚡ tool batch of 2 done')
    // An idle prompt is not answered by a tool
    const { state: idle } = reduceOffice(sessionOffice(), { type: 'session_needs_you', ...S1, kind: 'idle' }, env())
    expect(reduceOffice(idle, { type: 'session_tool_done', sessionId: 's1', batch: true, count: 1 }, env()).state).toBe(idle)
  })

  it('idle and quota are soft: a note, no chime, no title prefix; agent-input is a hand like a permission', () => {
    const idle = reduceOffice(sessionOffice(), { type: 'session_needs_you', ...S1, kind: 'idle', message: 'Claude is waiting for your input' }, env())
    expect(claudeOf(idle.state, 's1')!.statusText).toBe('💤 idle prompt')
    expect(claudeOf(idle.state, 's1')!.mainState).toBe('needs-you')
    expect(sfx(idle.effects)).toEqual([])
    expect(titles(idle.effects)).toEqual([])

    const quota = reduceOffice(sessionOffice(), { type: 'session_needs_you', ...S1, kind: 'quota', message: 'usage limit' }, env())
    expect(claudeOf(quota.state, 's1')!.statusText).toBe('⏳ waiting for tokens')
    expect(texts(quota.effects)).toEqual(['⏳ waiting for tokens'])
    expect(sfx(quota.effects)).toEqual([])
    expect(titles(quota.effects)).toEqual([])

    const input = reduceOffice(sessionOffice(), { type: 'session_needs_you', ...S1, kind: 'agent-input', summary: 'which branch?' }, env())
    expect(claudeOf(input.state, 's1')!.statusText).toBe('✋ needs input: which branch?')
    expect(sfx(input.effects)).toEqual(['needsYou'])
    expect(titles(input.effects)).toEqual(['✋ '])
  })

  it("a new wait of the same shape is announced again: the server's since says it is not the one already up", () => {
    // What the server broadcasts: the wait, and the record it now holds, both with when it began
    const wait = (since: number): OfficeAction => {
      const needsYou = { kind: 'permission' as const, toolName: 'Bash', summary: 'npm test', since }
      return { type: 'session_needs_you', ...S1, kind: 'permission', toolName: 'Bash', summary: 'npm test', needsYou, main: { state: 'needs-you', since, needsYou } }
    }
    const { state: first, effects: e1 } = reduceOffice(sessionOffice(), wait(T0), env())
    expect(texts(e1)).toEqual(['✋ needs you: Bash · npm test'])
    expect(sfx(e1)).toEqual(['needsYou'])

    // The same broadcast delivered again: nothing new
    expect(reduceOffice(first, wait(T0), env({ now: T0 + 500 })).effects).toEqual([])

    // A worker asks for the same command again 11 s later (the first was approved in the
    // terminal, which lowers no hand for a subagent): the server parked a new wait
    const { state: second, effects: e2 } = reduceOffice(first, wait(T0 + 11_000), env({ now: T0 + 11_000 }))
    expect(texts(e2)).toEqual(['✋ needs you: Bash · npm test'])
    expect(sfx(e2)).toEqual(['needsYou'])
    expect(titles(e2)).toEqual([])                             // the prefix is already up
    expect(claudeOf(second, 's1')!.needsYou!.since).toBe(T0 + 11_000)

    // Two agent-input waits in a row, likewise
    const input = (since: number): OfficeAction => {
      const needsYou = { kind: 'agent-input' as const, message: 'Agent needs your input', since }
      return { type: 'session_needs_you', ...S1, kind: 'agent-input', message: 'Agent needs your input', needsYou, main: { state: 'needs-you', since, needsYou } }
    }
    const { state: i1 } = reduceOffice(sessionOffice(), input(T0), env())
    const i2 = reduceOffice(i1, input(T0 + 11_000), env({ now: T0 + 11_000 }))
    expect(texts(i2.effects)).toEqual(['✋ needs input: Agent needs your input'])
    expect(sfx(i2.effects)).toEqual(['needsYou'])
  })
})

describe('session_cwd / session_model', () => {
  it('cd moves the project tag of the Claude and its workers; /model sets the badge', () => {
    const office = sessionOffice(1)
    const { state } = reduceOffice(office, { type: 'session_cwd', sessionId: 's1', cwd: '/home/me/office/packages/web/' }, env())
    expect(claudeOf(state, 's1')!.project).toBe('web')
    expect(agent(state, 'w1')!.project).toBe('web')
    expect(agent(state, BOSS_ID)!.project).toBeUndefined()

    const { state: m } = reduceOffice(state, { type: 'session_model', sessionId: 's1', model: 'claude-opus-4-1' }, env())
    expect(claudeOf(m, 's1')!.model).toBe('claude-opus-4-1')
  })
})

describe("completion line with the Agent tool's numbers", () => {
  const late = env({ now: T0 + MIN_VISIBLE_TIME + 1 })

  it('live: "✅ done · 42k tok · 3m12s" next to the boss reply; nothing extra without the numbers', () => {
    const { effects } = reduceOffice(fullOffice(1), { type: 'agent_completed', agentId: 'w1', result: 'all green', tokens: 42_000, durationMs: 192_000, toolUses: 17 }, late)
    expect(texts(effects)[0]).toBe('✅ done · 42k tok · 3m12s')
    expect(texts(effects)).toHaveLength(2)                    // plus the boss reply
    const { effects: plain } = reduceOffice(fullOffice(1), { type: 'agent_completed', agentId: 'w1', result: 'all green' }, late)
    expect(texts(plain)).toHaveLength(1)
    const { effects: tokensOnly } = reduceOffice(fullOffice(1), { type: 'agent_completed', agentId: 'w1', tokens: 950 }, late)
    expect(texts(tokensOnly)[0]).toBe('✅ done · 950 tok')
  })

  it('sim: the numbers join the "done:" line', () => {
    const { effects } = reduceOffice(fullOffice(1), { type: 'agent_completed', agentId: 'w1', result: 'all green', tokens: 4_200, durationMs: 45_000 }, env({ now: T0 + MIN_VISIBLE_TIME + 1, live: false }))
    expect(texts(effects)[0]).toBe('done: all green · 4.2k tok · 45s')
  })
})

describe("the boss's errands to the furniture", () => {
  const desk = spot('spot-1')
  const route = (to: { x: number; y: number }) => findWaypointPath(desk.x, desk.y, to.x, to.y, MAIN_ROOM.waypoints ?? [])

  it('walkDurationMs is what stepping the walk frame by frame at 60 fps takes', () => {
    const board = getInteraction('kanban-board', null)!.walkTo
    const path = route(board)
    let at = { x: desk.x, y: desk.y }
    let frames = 0
    for (const target of [...path, board]) {
      for (;;) {
        const r = stepToward(at, target, WALK_SPEED)
        at = r.position
        frames++
        if (r.arrived) break
      }
    }
    // One frame per waypoint is lost to the step that lands on it
    expect(Math.abs(walkDurationMs(desk, path, board) - (frames * 1000) / 60)).toBeLessThan(((path.length + 1) * 1000) / 60 + 1)
    expect(walkDurationMs(desk, [], desk)).toBe(0)
  })

  it('the wait for him to arrive covers the walk: from his desk to the whiteboard takes more than the old fixed 15 s', () => {
    const board = getInteraction('kanban-board', null)!.walkTo
    const walk = walkDurationMs(desk, route(board), board)
    expect(walk).toBeGreaterThan(ERRAND_MIN_WAIT_MS)
    expect(errandWaitMs(walk)).toBeGreaterThan(walk)
    // A short errand still gets at least the old 15 s
    expect(errandWaitMs(1000)).toBe(ERRAND_MIN_WAIT_MS)
    // App.tsx watches for that long, not for a fixed time
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('clearInterval(checkArrival), errandWaitMs(walkMs))')
    expect(app).not.toMatch(/clearInterval\(checkArrival\), \d+\)/)
  })
})
