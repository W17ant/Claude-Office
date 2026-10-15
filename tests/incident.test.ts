/**
 * Incident mode ("Prod Is Down") — the pure state machine in src/incident.ts.
 *
 * Inputs carry their own timestamps, so these tests drive entry/exit with
 * explicit clocks and never touch React, timers or localStorage.
 */

import { describe, expect, it } from 'vitest'
import {
  INCIDENT_CONFIG,
  createIncidentState,
  reduceIncident,
  recentFailures,
  failureToolFromStatus,
  formatClock,
  formatDuration,
  formatPostmortem,
  incidentTransitionLines,
  INCIDENT_LINES,
  signalIncidentInput,
  type IncidentInput,
  type IncidentState,
  type IncidentTransition,
} from '../src/incident'
import type { SignalKind } from '../src/types'
import { INCIDENT_EVENTS, RANDOM_EVENTS } from '../src/events'

const T0 = 1_760_000_000_000
const SEC = 1_000
const MIN = 60 * SEC

const fail = (at: number, tool = 'Bash', agent?: { id: string; name: string }): IncidentInput =>
  ({ type: 'failure', at, tool, agentId: agent?.id, agentName: agent?.name })
const event = (at: number, id: string): IncidentInput => ({ type: 'random-event', at, id })
const cmd = (at: number, c: 'incident' | 'all-clear', reason?: 'manual' | 'remote' | 'restored'): IncidentInput =>
  ({ type: 'command', at, cmd: c, reason })
const tick = (at: number): IncidentInput => ({ type: 'tick', at })
const pin = (at: number): IncidentInput => ({ type: 'pin', at })
/** A `signal` event as App.tsx feeds it in (main thread of session s1 unless said otherwise) */
const signal = (at: number, kind: SignalKind, extra: Partial<Omit<Extract<IncidentInput, { type: 'signal' }>, 'type' | 'at' | 'kind'>> = {}): IncidentInput =>
  ({ type: 'signal', at, kind, target: 'api', sessionId: 's1', ...extra })

/** Feed inputs in order; collect every transition that entered or exited. */
function run(inputs: IncidentInput[], start: IncidentState = createIncidentState()) {
  let state = start
  const transitions: IncidentTransition[] = []
  for (const input of inputs) {
    const t = reduceIncident(state, input)
    if (t.entered || t.exited) transitions.push(t)
    state = t.state
  }
  return { state, transitions }
}

const threeFailures = (at: number) => [fail(at - 2 * MIN), fail(at - MIN, 'Edit'), fail(at, 'Bash')]

describe('incident mode — entry', () => {
  it('starts after 3 failed tool calls inside 5 minutes', () => {
    const { state, transitions } = run(threeFailures(T0))
    expect(state.variant).toBe('incident')
    expect(state.reason).toBe('failures')
    expect(state.mini).toBe(false)
    expect(state.startedAt).toBe(T0)
    expect(state.expiresAt).toBe(T0 + INCIDENT_CONFIG.autoExitMs)
    expect(transitions).toHaveLength(1)
    expect(transitions[0].entered).toBe('failures')
  })

  it('stays off with 2 failures, or 3 spread over more than 5 minutes', () => {
    expect(run([fail(T0), fail(T0 + MIN)]).state.variant).toBe('none')
    // The first failure falls out of the window before the third arrives
    const spread = run([fail(T0), fail(T0 + 2 * MIN), fail(T0 + 5 * MIN + SEC)])
    expect(spread.state.variant).toBe('none')
    expect(spread.state.failures).toHaveLength(2)
  })

  it('prunes failures older than the window while idle', () => {
    const { state } = run([fail(T0), fail(T0 + 6 * MIN)])
    expect(state.failures.map(f => f.at)).toEqual([T0 + 6 * MIN])
    expect(recentFailures([{ at: T0, tool: 'Bash' }], T0 + INCIDENT_CONFIG.failureWindowMs + 1)).toEqual([])
  })

  it.each(INCIDENT_CONFIG.triggerEvents)('%s random event starts a 90 s mini-incident', id => {
    const { state, transitions } = run([event(T0, id)])
    expect(state.variant).toBe('incident')
    expect(state.mini).toBe(true)
    expect(state.reason).toBe('event')
    expect(state.expiresAt).toBe(T0 + INCIDENT_CONFIG.miniIncidentMs)
    expect(transitions[0].entered).toBe('event')
  })

  it('other random events do nothing', () => {
    const before = createIncidentState()
    const t = reduceIncident(before, event(T0, 'pizza'))
    expect(t.state).toBe(before)
    expect(t.entered).toBeUndefined()
  })

  it('/incident starts a full incident; a second /incident is a no-op', () => {
    const first = reduceIncident(createIncidentState(), cmd(T0, 'incident'))
    expect(first.entered).toBe('manual')
    expect(first.state.mini).toBe(false)
    expect(first.state.expiresAt).toBe(T0 + INCIDENT_CONFIG.autoExitMs)

    const again = reduceIncident(first.state, cmd(T0 + SEC, 'incident', 'remote'))
    expect(again.state).toBe(first.state)
    expect(again.entered).toBeUndefined()
  })

  it('the relayed /incident keeps the reason it was given', () => {
    expect(reduceIncident(createIncidentState(), cmd(T0, 'incident', 'remote')).entered).toBe('remote')
    expect(reduceIncident(createIncidentState(), cmd(T0, 'incident', 'restored')).entered).toBe('restored')
  })

  it('?variant=incident pins it: no expiry, ticks never end it', () => {
    const pinned = reduceIncident(createIncidentState(), pin(T0))
    expect(pinned.entered).toBe('url')
    expect(pinned.state.pinned).toBe(true)
    expect(pinned.state.expiresAt).toBeNull()

    const later = reduceIncident(pinned.state, tick(T0 + 24 * 60 * MIN))
    expect(later.state).toBe(pinned.state)
    expect(later.exited).toBeUndefined()
  })

  it('pinning an incident that is already running keeps it and removes the expiry', () => {
    const running = run(threeFailures(T0)).state
    const pinned = reduceIncident(running, pin(T0 + MIN))
    expect(pinned.entered).toBeUndefined()
    expect(pinned.state.startedAt).toBe(T0)
    expect(pinned.state.pinned).toBe(true)
    expect(pinned.state.expiresAt).toBeNull()
  })
})

describe('incident mode — exit', () => {
  it('/all-clear ends it with a summary', () => {
    const running = run(threeFailures(T0)).state
    const t = reduceIncident(running, cmd(T0 + 4 * MIN + 12 * SEC, 'all-clear'))
    expect(t.state.variant).toBe('none')
    expect(t.state.failures).toEqual([])
    expect(t.exited).toMatchObject({
      id: `INC-${T0}`,
      startedAt: T0,
      endedAt: T0 + 4 * MIN + 12 * SEC,
      durationMs: 4 * MIN + 12 * SEC,
      reason: 'failures',
      endedBy: 'all-clear',
      failureCount: 3,
      tools: { Bash: 2, Edit: 1 },
      lastTool: 'Bash',
    })
  })

  it('/all-clear is a no-op when nothing is burning', () => {
    const idle = createIncidentState()
    expect(reduceIncident(idle, cmd(T0, 'all-clear')).state).toBe(idle)
  })

  it('/all-clear also ends a pinned incident (only the AUTO exit is disabled)', () => {
    const pinned = reduceIncident(createIncidentState(), pin(T0)).state
    const t = reduceIncident(pinned, cmd(T0 + MIN, 'all-clear'))
    expect(t.state.variant).toBe('none')
    expect(t.exited?.endedBy).toBe('all-clear')
  })

  it('auto-exits 10 minutes after the LAST failure, not after the start', () => {
    const running = run(threeFailures(T0)).state
    // Another failure 5 min in pushes the quiet-period clock out
    const extended = reduceIncident(running, fail(T0 + 5 * MIN, 'Grep')).state
    expect(extended.expiresAt).toBe(T0 + 15 * MIN)
    expect(extended.failures).toHaveLength(4)

    const early = reduceIncident(extended, tick(T0 + 15 * MIN - SEC))
    expect(early.state).toBe(extended)

    const done = reduceIncident(extended, tick(T0 + 15 * MIN))
    expect(done.state.variant).toBe('none')
    expect(done.exited).toMatchObject({ endedBy: 'timeout', failureCount: 4, lastTool: 'Grep', durationMs: 15 * MIN })
  })

  it('a mini-incident ends on deploy-success; a full incident ignores it', () => {
    const mini = run([event(T0, 'deploy-fail')]).state
    const resolved = reduceIncident(mini, event(T0 + 30 * SEC, 'deploy-success'))
    expect(resolved.state.variant).toBe('none')
    expect(resolved.exited).toMatchObject({ endedBy: 'resolved', reason: 'event', failureCount: 0, lastTool: null })

    const full = run(threeFailures(T0)).state
    const ignored = reduceIncident(full, event(T0 + 30 * SEC, 'deploy-success'))
    expect(ignored.state).toBe(full)
  })

  it('a mini-incident auto-exits after 90 s and a repeat trigger restarts its clock', () => {
    const mini = run([event(T0, 'who-broke-build')]).state
    expect(reduceIncident(mini, tick(T0 + 89 * SEC)).state).toBe(mini)

    const restarted = reduceIncident(mini, event(T0 + 60 * SEC, 'deploy-fail')).state
    expect(restarted.expiresAt).toBe(T0 + 150 * SEC)
    expect(restarted.startedAt).toBe(T0)

    const over = reduceIncident(restarted, tick(T0 + 150 * SEC))
    expect(over.exited?.endedBy).toBe('timeout')
  })

  it('a full incident shrugs at deploy-fail (same state object)', () => {
    const full = run(threeFailures(T0)).state
    expect(reduceIncident(full, event(T0 + SEC, 'deploy-fail')).state).toBe(full)
  })

  it('a mini-incident that crosses the failure threshold becomes a full one', () => {
    const mini = run([event(T0, 'deploy-fail')]).state
    const oneFailure = reduceIncident(mini, fail(T0 + 10 * SEC)).state
    expect(oneFailure.mini).toBe(true)
    expect(oneFailure.expiresAt).toBe(T0 + 90 * SEC) // still on the 90 s clock

    const { state } = run([fail(T0 + 20 * SEC), fail(T0 + 30 * SEC)], oneFailure)
    expect(state.mini).toBe(false)
    expect(state.reason).toBe('failures')
    expect(state.expiresAt).toBe(T0 + 30 * SEC + INCIDENT_CONFIG.autoExitMs)
    expect(state.startedAt).toBe(T0) // the incident started when the deploy failed
  })

  it('after an exit the window is empty: three fresh failures are needed again', () => {
    const ended = reduceIncident(run(threeFailures(T0)).state, cmd(T0 + MIN, 'all-clear')).state
    expect(run([fail(T0 + 2 * MIN), fail(T0 + 3 * MIN)], ended).state.variant).toBe('none')
    expect(run([fail(T0 + 2 * MIN), fail(T0 + 3 * MIN), fail(T0 + 4 * MIN)], ended).state.variant).toBe('incident')
  })

  it('the summary names the agents whose tool calls failed, first seen first', () => {
    const dbg = { id: 'a1', name: 'Debugger' }
    const tst = { id: 'a2', name: 'Tester' }
    const { state } = run([fail(T0, 'Bash', dbg), fail(T0 + SEC, 'Edit', tst), fail(T0 + 2 * SEC, 'Bash', dbg)])
    const t = reduceIncident(state, cmd(T0 + MIN, 'all-clear'))
    expect(t.exited?.participants).toEqual(['Debugger', 'Tester'])
  })

  it('caps the failure log kept during one incident', () => {
    let state = run(threeFailures(T0)).state
    for (let i = 1; i <= INCIDENT_CONFIG.maxFailures + 50; i++) {
      state = reduceIncident(state, fail(T0 + i * SEC)).state
    }
    expect(state.failures).toHaveLength(INCIDENT_CONFIG.maxFailures)
  })
})

describe('incident mode — formatting', () => {
  it('reads the failing tool out of the hook status line', () => {
    expect(failureToolFromStatus('failed: Bash — Exit code 1 cat: /x: No such file')).toBe('Bash')
    expect(failureToolFromStatus('failed: Edit — String to replace not found')).toBe('Edit')
    expect(failureToolFromStatus('failed: WebFetch')).toBe('WebFetch')
    expect(failureToolFromStatus('reading App.tsx')).toBe('tool')
    expect(failureToolFromStatus(undefined)).toBe('tool')
  })

  it('formats the live clock and durations', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(4 * MIN + 12 * SEC)).toBe('00:04:12')
    expect(formatClock(90 * MIN + 5 * SEC)).toBe('01:30:05')
    expect(formatDuration(45 * SEC)).toBe('45s')
    expect(formatDuration(4 * MIN + 12 * SEC)).toBe('4m 12s')
    expect(formatDuration(10 * MIN)).toBe('10m')
    expect(formatDuration(61 * MIN)).toBe('1h 1m')
  })

  it('writes a one-line postmortem card', () => {
    // Third failure lands at T0, so the incident id and clock start there
    const t = reduceIncident(
      run([fail(T0 - 2 * SEC, 'Bash', { id: 'a1', name: 'Debugger' }), fail(T0 - SEC, 'Edit'), fail(T0, 'Bash')]).state,
      cmd(T0 + 4 * MIN + 12 * SEC, 'all-clear'),
    )
    expect(formatPostmortem(t.exited!)).toBe(
      `📋 Postmortem INC-${T0} · all clear after 4m 12s · 3 tool failures (Bash ×2, Edit ×1) · responders: Debugger · root cause: Bash`,
    )
  })

  it('falls back to the agents in the room and a joke root cause when nothing failed', () => {
    const t = reduceIncident(run([event(T0, 'deploy-fail')]).state, event(T0 + 90 * SEC, 'deploy-success'))
    const card = formatPostmortem(t.exited!, ['Debugger', 'Tester'])
    expect(card).toContain('no tool failures')
    expect(card).toContain('responders: Debugger, Tester')
    expect(card).toMatch(/root cause: .+/)
    expect(formatPostmortem(t.exited!)).toContain('responders: just the boss and Claude')
  })

  it('posts an entry line per reason, stays quiet for relayed entries, and always posts the postmortem', () => {
    expect(incidentTransitionLines(run(threeFailures(T0)).transitions[0])[0]).toContain('3 tool failures in 5 min')
    expect(incidentTransitionLines(run([event(T0, 'deploy-fail')]).transitions[0])[0]).toContain('Mini-incident')
    expect(incidentTransitionLines(reduceIncident(createIncidentState(), cmd(T0, 'incident')))[0]).toContain('INCIDENT MODE ON')
    expect(incidentTransitionLines(reduceIncident(createIncidentState(), pin(T0)))[0]).toContain('?variant=incident')
    expect(incidentTransitionLines(reduceIncident(createIncidentState(), cmd(T0, 'incident', 'remote')))).toEqual([])

    const exit = reduceIncident(run(threeFailures(T0)).state, cmd(T0 + MIN, 'all-clear'))
    const lines = incidentTransitionLines(exit, [
      { name: 'Boss', role: 'boss' }, { name: 'Claude', role: 'assistant' }, { name: 'Tester', role: 'test-engineer' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('📋 Postmortem')
  })

  it('ships a non-empty line pool for every kind', () => {
    for (const pool of Object.values(INCIDENT_LINES)) expect(pool.length).toBeGreaterThan(0)
  })
})

describe('INCIDENT_EVENTS', () => {
  it('reuses RANDOM_EVENTS ids and types so the movement targets in App.tsx resolve', () => {
    const byId = new Map(RANDOM_EVENTS.map(e => [e.id, e]))
    expect(INCIDENT_EVENTS.length).toBe(RANDOM_EVENTS.length)
    for (const e of INCIDENT_EVENTS) {
      const base = byId.get(e.id)
      expect(base, `unknown incident event id ${e.id}`).toBeDefined()
      expect(e.type).toBe(base!.type)
      expect(e.targetPosition).toEqual(base!.targetPosition)
    }
  })

  it('covers the trigger and resolve events the state machine listens for', () => {
    const ids = new Set(INCIDENT_EVENTS.map(e => e.id))
    for (const id of [...INCIDENT_CONFIG.triggerEvents, ...INCIDENT_CONFIG.resolveEvents]) expect(ids.has(id)).toBe(true)
  })
})

describe('incident mode — signals (what the Bash commands meant)', () => {
  it('a failed deploy opens the incident at once; the summary names the project and the error', () => {
    const { state, transitions } = run([signal(T0, 'deploy_fail', { error: 'Error: Deployment failed: 503 from the edge' })])
    expect(state.variant).toBe('incident')
    expect(state.reason).toBe('deploy-fail')
    expect(state.mini).toBe(false)
    expect(state.expiresAt).toBe(T0 + INCIDENT_CONFIG.autoExitMs)
    expect(transitions[0].entered).toBe('deploy-fail')
    expect(incidentTransitionLines(transitions[0])[0]).toBe('🔴 The api deploy failed — INCIDENT MODE ON. Prod is down. Everyone to the war room.')

    const over = reduceIncident(state, cmd(T0 + 2 * MIN, 'all-clear'))
    expect(over.exited).toMatchObject({ reason: 'deploy-fail', failureCount: 1, tools: { deploy: 1 }, cause: 'deploy of api failed: Error: Deployment failed: 503 from the edge' })
    expect(formatPostmortem(over.exited!)).toContain('root cause: deploy of api failed: Error: Deployment failed: 503 from the edge')
  })

  it('a deploy that went out resolves it; a pinned screenshot stays on', () => {
    const burning = run([signal(T0, 'deploy_fail')]).state
    const t = reduceIncident(burning, signal(T0 + 3 * MIN, 'deploy_success'))
    expect(t.state.variant).toBe('none')
    expect(t.exited).toMatchObject({ endedBy: 'resolved', reason: 'deploy-fail', durationMs: 3 * MIN })
    // ... whatever opened it (three plain failures here)
    expect(reduceIncident(run(threeFailures(T0)).state, signal(T0 + MIN, 'deploy_success')).exited?.endedBy).toBe('resolved')
    const pinned = reduceIncident(createIncidentState(), pin(T0)).state
    expect(reduceIncident(pinned, signal(T0 + MIN, 'deploy_success')).state.variant).toBe('incident')
    // Nothing burning: a deploy going out changes nothing
    const idle = createIncidentState()
    expect(reduceIncident(idle, signal(T0, 'deploy_success')).state).toBe(idle)
  })

  it('three failed builds open it under their own name', () => {
    const { state, transitions } = run([
      signal(T0 - 2 * MIN, 'build_failed', { detail: '2 errors' }),
      signal(T0 - MIN, 'build_failed', { detail: '1 error' }),
      signal(T0, 'build_failed', { detail: '4 errors' }),
    ])
    expect(state.variant).toBe('incident')
    expect(state.reason).toBe('failures')
    expect(state.failures.map(f => f.tool)).toEqual(['build', 'build', 'build'])
    expect(incidentTransitionLines(transitions[0])[0]).toBe('🔴 3 tool failures in 5 min — INCIDENT MODE ON. Prod is down. Everyone to the war room. Latest: build failed in api: 4 errors.')
  })

  it('a failed test run names its reason for the summary ("tests failed in api: 3 failing")', () => {
    const { state } = run([fail(T0 - MIN), fail(T0 - SEC), signal(T0, 'test_failed', { detail: '3 failing' })])
    expect(state.variant).toBe('incident')
    const t = reduceIncident(state, cmd(T0 + MIN, 'all-clear'))
    expect(t.exited?.cause).toBe('tests failed in api: 3 failing')
    expect(t.exited?.tools).toEqual({ Bash: 2, test: 1 })
  })

  it('a signal names the plain tool failure the same call logged a moment before instead of counting it twice', () => {
    // App.tsx hears the failed Bash call (agent_working failed) and then its test_failed signal
    const plainThenSignal = (at: number) => [fail(at, 'Bash'), signal(at + 50, 'test_failed', { detail: '1 failing' })]
    const twoRuns = run([...plainThenSignal(T0 - MIN), ...plainThenSignal(T0)].map(i => ({ ...i, sessionId: 's1' }) as IncidentInput))
    expect(twoRuns.state.variant).toBe('none')
    expect(twoRuns.state.failures.map(f => f.tool)).toEqual(['test', 'test'])
    expect(run([...plainThenSignal(T0 - 2 * MIN), ...plainThenSignal(T0 - MIN), ...plainThenSignal(T0)].map(i => ({ ...i, sessionId: 's1' }) as IncidentInput)).state.variant).toBe('incident')
    // Another session's failure is not the same call
    const other = run([{ ...fail(T0, 'Bash'), sessionId: 's2' } as IncidentInput, signal(T0 + 50, 'test_failed')])
    expect(other.state.failures.map(f => f.tool)).toEqual(['Bash', 'test'])
  })

  it('test_ok after a red run clears the window while idle, and resolves the incident when it was the last red run', () => {
    const idle = run([signal(T0, 'test_failed'), fail(T0 + SEC)]).state
    expect(idle.failures).toHaveLength(2)
    const green = reduceIncident(idle, signal(T0 + MIN, 'test_ok'))
    expect(green.state.failures).toEqual([])
    expect(green.state.red).toEqual([])
    // Green without a red run before it: nothing to clear
    const quiet = run([fail(T0)]).state
    expect(reduceIncident(quiet, signal(T0 + SEC, 'test_ok')).state).toBe(quiet)

    const burning = run([signal(T0 - 2 * MIN, 'test_failed'), signal(T0 - MIN, 'build_failed'), signal(T0, 'test_failed')]).state
    expect(burning.variant).toBe('incident')
    // Tests green, build still red: still burning
    const half = reduceIncident(burning, signal(T0 + MIN, 'test_ok'))
    expect(half.state.variant).toBe('incident')
    const all = reduceIncident(half.state, signal(T0 + 2 * MIN, 'build_ok'))
    expect(all.state.variant).toBe('none')
    expect(all.exited).toMatchObject({ endedBy: 'resolved', failureCount: 3 })
    // A green test run does not fix a failed deploy
    expect(reduceIncident(run([signal(T0, 'deploy_fail')]).state, signal(T0 + MIN, 'test_ok')).state.variant).toBe('incident')
  })

  it('pushes, starts and interrupted runs change nothing; a failed deploy turns a mini-incident into a real one', () => {
    const idle = createIncidentState()
    for (const kind of ['push', 'push_done', 'push_failed', 'deploy_start', 'build_start', 'test_start'] as SignalKind[]) {
      expect(reduceIncident(idle, signal(T0, kind, { toDefault: true } as never)).state, kind).toBe(idle)
    }
    expect(reduceIncident(idle, signal(T0, 'deploy_fail', { interrupted: true })).state).toBe(idle)

    const mini = run([event(T0, 'deploy-fail')]).state
    const real = reduceIncident(mini, signal(T0 + 10 * SEC, 'deploy_fail')).state
    expect(real.mini).toBe(false)
    expect(real.reason).toBe('deploy-fail')
    expect(real.expiresAt).toBe(T0 + 10 * SEC + INCIDENT_CONFIG.autoExitMs)
    expect(real.startedAt).toBe(T0)
  })

  it('reads a `signal` broadcast: target falls back to the project, unknown kinds are ignored', () => {
    expect(signalIncidentInput({ type: 'signal', kind: 'test_failed', project: 'web', detail: '2 failing', sessionId: 's9', agentId: 'agent-1', agentName: 'Tester' }, T0))
      .toEqual({ type: 'signal', at: T0, kind: 'test_failed', target: 'web', detail: '2 failing', error: undefined, interrupted: undefined, sessionId: 's9', agentId: 'agent-1', agentName: 'Tester' })
    expect(signalIncidentInput({ type: 'signal', kind: 'deploy_rolled_back' as SignalKind }, T0)).toBeNull()
  })
})
