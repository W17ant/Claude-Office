/**
 * recap.test.ts - the end-of-day recap (server/recap.js): each event type
 * counts in the right column once, the day rolls over at local midnight,
 * GET /recap serves numbers only, and /recap posts the office manager's line.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import request from 'supertest'
import { createRecap, recapLine, isRecapDate, localDate, INCIDENT_QUIET_MS } from '../server/recap.js'
import { loadOffice, postAuthed, postEvent, removeOffice, type Office } from './helpers'

/** A recap on a fresh in-memory db with a clock the test moves. */
function freshRecap(start = new Date(2026, 10, 9, 12, 0, 0).getTime()) {
  const clock = { t: start }
  const recap = createRecap(new Database(':memory:'), { now: () => clock.t })
  return { recap, clock }
}

const ZERO = {
  sessions: 0, agentsSpawned: 0, agentsCompleted: 0, tasksCompleted: 0, deploys: 0,
  buildsFailed: 0, testsFailed: 0, pushes: 0, incidents: 0, costUsd: 0,
}

describe('createRecap: each kind of event counts once, in its own column', () => {
  let recap: ReturnType<typeof freshRecap>['recap']
  beforeEach(() => { recap = freshRecap().recap })

  it('a day with nothing noted reads as zeros', () => {
    expect(recap.today()).toEqual({ date: '2026-11-09', ...ZERO })
  })

  it.each([
    ['session', 'sessions'],
    ['spawned', 'agentsSpawned'],
    ['completed', 'agentsCompleted'],
    ['task', 'tasksCompleted'],
  ] as const)('note({ %s }) bumps %s once, however often it repeats', (fact, column) => {
    recap.note({ [fact]: 'id-1' })
    recap.note({ [fact]: 'id-1' })
    expect(recap.today()).toEqual({ date: '2026-11-09', ...ZERO, [column]: 1 })
    recap.note({ [fact]: 'id-2' })
    expect(recap.today()[column]).toBe(2)
  })

  it('the same id under different facts counts in each column (the kinds are separate)', () => {
    recap.note({ spawned: 'agent-a', completed: 'agent-a' })
    expect(recap.today()).toMatchObject({ agentsSpawned: 1, agentsCompleted: 1 })
  })

  it.each([
    ['deploy_success', 'deploys'],
    ['build_failed', 'buildsFailed'],
    ['test_failed', 'testsFailed'],
    ['push_done', 'pushes'],
  ] as const)('a %s signal bumps %s by one each time', (kind, column) => {
    recap.signal({ kind })
    expect(recap.today()[column]).toBe(1)
    recap.signal({ kind })
    expect(recap.today()[column]).toBe(2)
  })

  it('starts, green builds and tests, a push still running, and runs stopped with Esc count nothing', () => {
    for (const kind of ['deploy_start', 'build_start', 'build_ok', 'test_start', 'test_ok', 'push', 'push_failed']) recap.signal({ kind })
    recap.signal({ kind: 'build_failed', interrupted: true })
    recap.signal({ kind: 'test_failed', interrupted: true })
    recap.signal({ kind: 'deploy_fail', interrupted: true })
    recap.signal({ kind: 'nonsense' })
    expect(recap.today()).toEqual({ date: '2026-11-09', ...ZERO })
  })
})

describe('createRecap: incidents mirror incident mode', () => {
  it('/incident opens one; a second /incident while it is open does not count', () => {
    const { recap } = freshRecap()
    recap.incident('declare')
    recap.incident('declare')
    expect(recap.today().incidents).toBe(1)
  })

  it('a failed deploy opens one at once; more failures while it is open join it', () => {
    const { recap, clock } = freshRecap()
    recap.signal({ kind: 'deploy_fail' })
    clock.t += 60_000
    recap.signal({ kind: 'deploy_fail' })
    recap.signal({ kind: 'build_failed' })
    recap.incident('declare')
    expect(recap.today().incidents).toBe(1)
  })

  it('/all-clear or a deploy that went out closes it, so the next failure is a new incident', () => {
    const { recap } = freshRecap()
    recap.incident('declare')
    recap.incident('resolved')
    recap.signal({ kind: 'deploy_fail' })
    recap.signal({ kind: 'deploy_success' })
    recap.signal({ kind: 'deploy_fail' })
    expect(recap.today()).toMatchObject({ incidents: 3, deploys: 1 })
  })

  it('closes itself after the quiet period; a failed build or test keeps it open meanwhile', () => {
    const { recap, clock } = freshRecap()
    recap.signal({ kind: 'deploy_fail' })
    clock.t += INCIDENT_QUIET_MS - 1000
    recap.signal({ kind: 'test_failed' })       // extends the quiet period
    clock.t += INCIDENT_QUIET_MS - 1000
    recap.signal({ kind: 'deploy_fail' })       // still the same incident
    expect(recap.today().incidents).toBe(1)
    clock.t += INCIDENT_QUIET_MS + 1
    recap.signal({ kind: 'deploy_fail' })       // quiet for too long: a new one
    expect(recap.today().incidents).toBe(2)
  })

  it('a failed build or test with no incident open does not open one (the page decides that)', () => {
    const { recap } = freshRecap()
    for (let i = 0; i < 5; i++) recap.signal({ kind: 'build_failed' })
    expect(recap.today()).toMatchObject({ incidents: 0, buildsFailed: 5 })
  })
})

describe('createRecap: payroll', () => {
  it('sums the highest cost seen per session; a lower reading changes nothing', () => {
    const { recap } = freshRecap()
    recap.cost('s1', 0.5)
    recap.cost('s1', 1.25)
    recap.cost('s1', 1.0)
    recap.cost('s2', 0.75)
    expect(recap.today().costUsd).toBe(2)
  })

  it('ignores junk readings', () => {
    const { recap } = freshRecap()
    recap.cost('', 3)
    recap.cost('s1', -1)
    recap.cost('s1', Number.NaN)
    recap.cost('s1', Infinity)
    expect(recap.today().costUsd).toBe(0)
  })

  it('a session running past midnight books only what it spent after midnight on the new day', () => {
    const { recap, clock } = freshRecap(new Date(2026, 10, 9, 23, 0).getTime())
    recap.cost('s1', 2)
    clock.t = new Date(2026, 10, 10, 1, 0).getTime()
    recap.cost('s1', 2.5)
    expect(recap.get('2026-11-09').costUsd).toBe(2)
    expect(recap.get('2026-11-10').costUsd).toBe(0.5)
  })
})

describe('createRecap: the day rolls over at local midnight', () => {
  it('counts before midnight stay on that day; after it a new row starts, and a session counts again', () => {
    const { recap, clock } = freshRecap(new Date(2026, 10, 9, 23, 59, 59).getTime())
    recap.note({ session: 's1', spawned: 'a1' })
    recap.signal({ kind: 'push_done' })
    clock.t = new Date(2026, 10, 10, 0, 0, 1).getTime()
    recap.note({ session: 's1', spawned: 'a1' })
    expect(recap.get('2026-11-09')).toMatchObject({ sessions: 1, agentsSpawned: 1, pushes: 1 })
    expect(recap.today()).toEqual({ date: '2026-11-10', ...ZERO, sessions: 1, agentsSpawned: 1 })
  })

  it('localDate is the local calendar date, zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5, 0, 0, 0).getTime())).toBe('2026-01-05')
    expect(localDate(new Date(2026, 0, 4, 23, 59, 59, 999).getTime())).toBe('2026-01-04')
  })

  it('isRecapDate takes real YYYY-MM-DD dates only', () => {
    expect(isRecapDate('2026-11-09')).toBe(true)
    expect(isRecapDate('2028-02-29')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-9', '20261109', '', null, 3, '2026-11-09T00:00']) {
      expect(isRecapDate(bad)).toBe(false)
    }
  })
})

describe('recapLine', () => {
  it('says so on a quiet day', () => {
    expect(recapLine({ date: '2026-11-09', ...ZERO })).toMatch(/quiet day/)
  })

  it('lists the day in one line, with payroll and a sign-off', () => {
    const line = recapLine({ date: '2026-11-09', ...ZERO, sessions: 2, agentsSpawned: 5, agentsCompleted: 4, tasksCompleted: 1, deploys: 1, pushes: 3, testsFailed: 1, costUsd: 4.2711 })
    expect(line).toBe('📋 Recap for today: 2 sessions · 5 agents hired, 4 clocked out · 1 task closed · 1 deploy shipped, 3 pushes · 1 failed test run · no incidents. Payroll: $4.27. Good shipping, everyone.')
  })

  it('owns up to incidents', () => {
    expect(recapLine({ date: '2026-11-09', ...ZERO, sessions: 1, incidents: 2 })).toMatch(/2 incidents \(we don't talk about them\).*Postmortem/)
  })
})

// ---------------------------------------------------------------------------
// Through the server: the hook paths, GET /recap and the /recap command
// ---------------------------------------------------------------------------

describe('server: events, signals and status reports feed the recap', () => {
  let office: Office
  const S = 'recap-session-1'
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  const recapNow = async () => (await request(office.server.app).get('/recap')).body

  it('a session, an agent that comes and goes, a task, signals and a status report each land once', async () => {
    const { server } = office
    await postEvent(server, { type: 'session_started', sessionId: S, project: 'demo', cwd: '/tmp/demo' })
    // Further events of the same session do not count it again
    await postEvent(server, { type: 'session_prompt', sessionId: S, text: 'hello' })
    const spawned = await postEvent(server, { type: 'agent_spawned', sessionId: S, agent: { id: 'recap-a1', name: 'Rex', role: 'debugger', task: 'look' } })
    expect(spawned.status).toBe(200)
    // A replayed spawn (hook retry) is the same agent
    await postEvent(server, { type: 'agent_spawned', sessionId: S, agent: { id: 'recap-a1', name: 'Rex', role: 'debugger', task: 'look' } })
    await postEvent(server, { type: 'agent_completed', sessionId: S, agentId: 'recap-a1', result: 'done' })
    // SubagentStop and PostToolUse(Agent) both report a finish: counted once
    await postEvent(server, { type: 'agent_completed', sessionId: S, agentId: 'recap-a1', result: 'done' })
    // An unknown agent's finish is not one of ours
    await postEvent(server, { type: 'agent_completed', sessionId: S, agentId: 'nobody', result: 'done' })
    await postEvent(server, { type: 'task_completed', sessionId: S, taskId: '1', subject: 'Fix it' })
    await postEvent(server, { type: 'task_completed', sessionId: S, taskId: '1', subject: 'Fix it' })
    await postEvent(server, { type: 'signal', sessionId: S, signals: [{ kind: 'deploy_success', target: 'prod' }, { kind: 'push_done', branch: 'main' }] })
    await postEvent(server, { type: 'agent_working', sessionId: S, status: 'running: npm test', signals: [{ kind: 'test_failed', error: 'boom' }, { kind: 'build_failed' }] })
    await postAuthed(server, '/status', { type: 'session_status', sessionId: S, cost: 1.5, context: { used: 1, size: 200000, input: 10, output: 1 } })
    await postAuthed(server, '/status', { type: 'session_status', sessionId: S, cost: 1.25, context: { used: 1, size: 200000, input: 11, output: 1 } })

    expect(await recapNow()).toEqual({
      date: localDate(Date.now()), today: true,
      sessions: 1, agentsSpawned: 1, agentsCompleted: 1, tasksCompleted: 1,
      deploys: 1, buildsFailed: 1, testsFailed: 1, pushes: 1, incidents: 0, costUsd: 1.5,
    })
  })

  it('a session that ends sends its agents home, and they count as clocked out', async () => {
    const { server } = office
    const before = await recapNow()
    await postEvent(server, { type: 'session_started', sessionId: 'recap-session-2', project: 'other' })
    await postEvent(server, { type: 'agent_spawned', sessionId: 'recap-session-2', agent: { id: 'recap-b1', name: 'Bea', role: 'debugger', task: 'x' } })
    await postEvent(server, { type: 'session_ended', sessionId: 'recap-session-2', reason: 'other' })
    const after = await recapNow()
    expect(after.sessions - before.sessions).toBe(1)
    expect(after.agentsSpawned - before.agentsSpawned).toBe(1)
    expect(after.agentsCompleted - before.agentsCompleted).toBe(1)
  })

  it('/incident and /all-clear in the chat open and close the incident tally', async () => {
    const chat = (text: string) => request(office.server.app).post('/chat').send({ sender: 'Boss', text })
    const before = (await recapNow()).incidents
    await chat('/incident')
    await chat('/incident')
    await chat('/all-clear')
    await chat('/incident')
    await chat('/all-clear')
    expect((await recapNow()).incidents - before).toBe(2)
  })
})

describe('GET /recap', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('is open (no token) and answers today by default, numbers only', async () => {
    const res = await request(office.server.app).get('/recap')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ date: localDate(Date.now()), today: true, ...ZERO })
    for (const [key, value] of Object.entries(res.body)) {
      if (key === 'date') expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      else if (key === 'today') expect(typeof value).toBe('boolean')
      else expect(typeof value).toBe('number')
    }
  })

  it('takes ?date=YYYY-MM-DD and answers zeros for a day with nothing noted', async () => {
    const res = await request(office.server.app).get('/recap').query({ date: '2020-02-29' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ date: '2020-02-29', today: false, ...ZERO })
  })

  it('refuses anything that is not a real date', async () => {
    for (const date of ['yesterday', '2026-02-30', '2026-11-9']) {
      const res = await request(office.server.app).get('/recap').query({ date })
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'date must be YYYY-MM-DD' })
    }
    const twice = await request(office.server.app).get('/recap?date=2026-11-09&date=2026-11-10')
    expect(twice.status).toBe(400)
  })

  it('keeps to the Host guard like every other route', async () => {
    const res = await request(office.server.app).get('/recap').set('Host', 'evil.example')
    expect(res.status).toBe(421)
  })
})

describe('/recap in the chat', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('needs no token, and posts the office manager\'s line as a system message', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 'recap-chat-1', project: 'demo' })
    await postEvent(office.server, { type: 'signal', sessionId: 'recap-chat-1', signals: [{ kind: 'push_done' }] })
    const res = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/recap' })
    expect(res.status).toBe(200)
    const { messages } = (await request(office.server.app).get('/chat')).body
    const last = messages[messages.length - 1]
    expect(last).toMatchObject({ sender: 'system', is_system: 1 })
    expect(last.text).toMatch(/^📋 Recap for today: 1 session · 0 agents hired, 0 clocked out · 0 tasks closed · 1 push · no incidents\./)
    expect(messages[messages.length - 2]).toMatchObject({ sender: 'Boss', text: '/recap' })
  })

  it('/help lists it', async () => {
    await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/help' })
    const { messages } = (await request(office.server.app).get('/chat')).body
    expect(messages[messages.length - 1].text).toContain('/recap')
  })
})
