/**
 * Signals — what a session's Bash commands meant (a deploy, a build, a test
 * run, a push), from the server's side (validation, the rings, GET /signals,
 * the broadcast after the carrying event, the WS snapshot) and the office's
 * (src/officeReducer.ts: the scene on whoever ran the command and the chat
 * line). The hook's classifier is in tests/hook-script.test.ts, incident
 * mode's reaction in tests/incident.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listen, loadOffice, officeProtocols, postEvent, removeOffice, spawnAgent, type Office } from './helpers'
import { reduceOffice, initialOfficeState, MAIN_ROOM, BOSS_ID, type OfficeEnv, type OfficeState, type OfficeEffect, type OfficeAction } from '../src/officeReducer'
import { mainId } from '../src/mainState'
import { createAgent } from '../src/agentManager'
import { SCENE_MS, signalFailureLabel } from '../src/signals'
import type { SignalEvent } from '../src/types'

type Message = Record<string, any>

/**
 * A WebSocket client that buffers every message (the snapshot included);
 * with the office page's subprotocols (helpers officeProtocols) it is trusted
 */
function connect(url: string, protocols: string[] = []): Promise<{ ws: WebSocket; messages: Message[]; next: (pred: (m: Message) => boolean) => Promise<Message> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols)
    const messages: Message[] = []
    const waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = []
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      messages.push(m)
      for (const w of waiters.splice(0)) {
        if (w.pred(m)) w.resolve(m)
        else waiters.push(w)
      }
    })
    const next = (pred: (m: Message) => boolean) => {
      const hit = messages.find(pred)
      return hit ? Promise.resolve(hit) : new Promise<Message>(res => waiters.push({ pred, resolve: res }))
    }
    ws.once('open', () => resolve({ ws, messages, next }))
    ws.once('error', reject)
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('POST /event: signals are checked and clamped', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('refuses a signals field that is not a list, or more than 8 of them', async () => {
    const notList = await postEvent(office.server, { type: 'agent_working', status: 'running: npm test', signals: 'test_start' })
    expect(notList.status).toBe(400)
    expect(notList.body).toEqual({ error: 'signals must be an array' })
    const nine = Array.from({ length: 9 }, () => ({ kind: 'test_start' }))
    const tooMany = await postEvent(office.server, { type: 'agent_working', status: 'running: npm test', signals: nine })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body).toEqual({ error: 'At most 8 signals per event' })
  })

  it('a `signal` event needs one known signal; unknown kinds are dropped from any event', async () => {
    for (const signals of [[], [{ kind: 'deploy_rolled_back' }], ['test_ok'], [null]]) {
      const res = await postEvent(office.server, { type: 'signal', sessionId: 's-val', signals })
      expect(res.status, JSON.stringify(signals)).toBe(400)
      expect(res.body).toEqual({ error: 'A signal event needs at least one known signal' })
    }
    const mixed = await postEvent(office.server, {
      type: 'agent_working', sessionId: 's-val', project: 'api', status: 'running: npm test',
      signals: [{ kind: 'deploy_rolled_back' }, { kind: 'test_start', target: 'api' }, 'nonsense'],
    })
    expect(mixed.status).toBe(200)
    const listed = await request(office.server.app).get('/signals?sessionId=s-val')
    expect(listed.body.signals.map((s: Message) => s.kind)).toEqual(['test_start'])
  })

  it('clamps every string, keeps exit codes 0..255 and booleans as booleans', async () => {
    const res = await postEvent(office.server, {
      type: 'signal', sessionId: 's-clamp', project: 'api',
      signals: [{
        kind: 'test_failed', target: 't'.repeat(300), command: 'c'.repeat(500), error: 'e'.repeat(500),
        detail: 'd'.repeat(500), branch: 'b'.repeat(500), exitCode: 999, toDefault: 'yes', interrupted: 'no',
      }, { kind: 'test_failed', exitCode: 137, toDefault: false, interrupted: true }],
    })
    expect(res.status).toBe(200)
    const listed = await request(office.server.app).get('/signals?sessionId=s-clamp').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    const [first, second] = listed.body.signals
    expect([first.target.length, first.command.length, first.error.length, first.detail.length, first.branch.length]).toEqual([80, 160, 200, 120, 120])
    expect(first).not.toHaveProperty('exitCode')
    expect(first).not.toHaveProperty('toDefault')
    expect(first).not.toHaveProperty('interrupted')
    expect(second).toMatchObject({ exitCode: 137, toDefault: false, interrupted: true })
  })
})

describe('the signal rings and GET /signals', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('keeps the last 100 signals, oldest first, numbered', async () => {
    for (let i = 0; i < 13; i++) {
      const signals = Array.from({ length: 8 }, (_, j) => ({ kind: 'build_start', target: `pkg${i * 8 + j}` }))
      expect((await postEvent(office.server, { type: 'agent_working', sessionId: 's-ring', project: 'mono', status: 'running: make', signals })).status).toBe(200)
    }
    const res = await request(office.server.app).get('/signals')
    expect(res.status).toBe(200)
    expect(res.body.signals).toHaveLength(100)
    expect(res.body.signals[0].target).toBe('pkg4')
    expect(res.body.signals[99].target).toBe('pkg103')
    const seqs = res.body.signals.map((s: Message) => s.seq)
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b))
    expect(res.body.signals[0]).toMatchObject({ kind: 'build_start', sessionId: 's-ring', project: 'mono' })
    expect(res.body.now).toBeTypeOf('number')
  })

  it('?since= returns what came after a moment; ?sessionId= one session\'s own ring', async () => {
    await postEvent(office.server, { type: 'signal', sessionId: 's-a', project: 'api', signals: [{ kind: 'test_failed', target: 'api', detail: '3 failing' }] })
    await sleep(5)
    const mark = Date.now()
    await sleep(5)
    await postEvent(office.server, { type: 'signal', sessionId: 's-b', project: 'web', signals: [{ kind: 'deploy_start', target: 'web' }] })
    const after = await request(office.server.app).get(`/signals?since=${mark}`)
    expect(after.body.signals.map((s: Message) => s.kind)).toEqual(['deploy_start'])
    const sa = await request(office.server.app).get('/signals?sessionId=s-a').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    expect(sa.body.signals).toEqual([expect.objectContaining({ kind: 'test_failed', target: 'api', detail: '3 failing', sessionId: 's-a', project: 'api' })])
    expect((await request(office.server.app).get('/signals?sessionId=nobody')).body.signals).toEqual([])
  })

  it('is open like GET /sessions; the command each came from, and its output (error, detail), only with the office token', async () => {
    await postEvent(office.server, { type: 'signal', sessionId: 's-cmd', signals: [{ kind: 'deploy_fail', target: 'api', branch: 'main', command: 'VERCEL_TOKEN=abc vercel deploy --prod', error: 'Error: token abc rejected', detail: '1 failing', exitCode: 1 }] })
    const open = await request(office.server.app).get('/signals?sessionId=s-cmd')
    expect(open.status).toBe(200)
    expect(open.body.signals[0]).toMatchObject({ kind: 'deploy_fail', target: 'api', branch: 'main', exitCode: 1 })
    for (const field of ['command', 'error', 'detail']) expect(open.body.signals[0]).not.toHaveProperty(field)
    const withToken = await request(office.server.app).get('/signals?sessionId=s-cmd').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    expect(withToken.body.signals[0]).toMatchObject({ command: 'VERCEL_TOKEN=abc vercel deploy --prod', error: 'Error: token abc rejected', detail: '1 failing' })
  })

  it('persists nothing: agents.json and the session records never carry signals', async () => {
    await postEvent(office.server, { type: 'agent_working', sessionId: 's-persist', project: 'api', status: 'running: vercel deploy', signals: [{ kind: 'deploy_start', target: 'api' }] })
    const saved = readFileSync(join(office.dir, 'agents.json'), 'utf8')
    expect(saved).toContain('s-persist')
    expect(saved).not.toContain('deploy_start')
    const sessions = await request(office.server.app).get('/sessions')
    expect(JSON.stringify(sessions.body)).not.toContain('deploy_start')
  })
})

describe('signal broadcasts and the WS snapshot', () => {
  let office: Office
  let url: string
  const clients: WebSocket[] = []

  beforeAll(async () => {
    office = await loadOffice()
    const port = await listen(office.server.httpServer)
    url = `ws://127.0.0.1:${port}/ws`
  })

  afterAll(async () => {
    for (const ws of clients) ws.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('one `signal` per signal, right after the event that carried it, without the command; one log line each', async () => {
    const client = await connect(url, officeProtocols(office.server))
    clients.push(client.ws)
    await client.next(m => m.type === 'snapshot')
    const log = vi.spyOn(console, 'log')
    try {
      const res = await postEvent(office.server, {
        type: 'agent_working', sessionId: 's-order', project: 'api', status: 'failed: Bash — Exit code 1', failed: true,
        signals: [
          { kind: 'build_ok', target: 'api', command: 'npm run build && vercel deploy --prod' },
          { kind: 'deploy_fail', target: 'api', command: 'npm run build && vercel deploy --prod', error: 'Error: Deployment failed: 503', exitCode: 1 },
        ],
      })
      expect(res.status).toBe(200)
      await client.next(m => m.type === 'signal' && m.kind === 'deploy_fail')
      const order = client.messages.filter(m => m.sessionId === 's-order').map(m => (m.type === 'signal' ? `signal:${m.kind}` : m.type))
      expect(order).toEqual(['session_started', 'agent_working', 'signal:build_ok', 'signal:deploy_fail'])
      const fail = client.messages.find(m => m.type === 'signal' && m.kind === 'deploy_fail')!
      expect(fail).toMatchObject({ type: 'signal', kind: 'deploy_fail', target: 'api', error: 'Error: Deployment failed: 503', exitCode: 1, sessionId: 's-order', project: 'api' })
      expect(fail.at).toBeTypeOf('number')
      expect(fail).not.toHaveProperty('command')
      expect(fail).not.toHaveProperty('agentId')
      const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[signal]'))
      expect(lines).toEqual([
        '[signal] api: build_ok api',
        '[signal] api: deploy_fail api — Error: Deployment failed: 503',
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('a worker\'s standalone `signal` names the office agent (its subagent id resolved) and lands in its inspector history', async () => {
    spawnAgent(office.server, { id: 'agent-toolu_W', name: 'Tester', role: 'test-engineer', task: 'run the suite', agentType: 'general-purpose' })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-toolu_W', subagentId: 'a1b2c3d4e5f6a7b8c' })
    const client = await connect(url, officeProtocols(office.server))
    clients.push(client.ws)
    await client.next(m => m.type === 'snapshot')
    const res = await postEvent(office.server, {
      type: 'signal', sessionId: 's-worker', project: 'api', agentId: 'a1b2c3d4e5f6a7b8c', agentType: 'general-purpose',
      signals: [{ kind: 'test_failed', target: 'api', detail: '3 failing', error: 'FAIL tests/a.test.ts', exitCode: 1 }],
    })
    expect(res.status).toBe(200)
    const sig = await client.next(m => m.type === 'signal' && m.sessionId === 's-worker')
    expect(sig).toMatchObject({ kind: 'test_failed', agentId: 'agent-toolu_W', agentName: 'Tester', detail: '3 failing' })
    const card = await request(office.server.app).get('/agents/agent-toolu_W')
    expect(card.body.history.map((h: Message) => h.text)).toContain('test_failed api 3 failing — FAIL tests/a.test.ts')
  })

  it('signals on a session_tool_done (which broadcasts nothing itself) still go out', async () => {
    const client = await connect(url, officeProtocols(office.server))
    clients.push(client.ws)
    await client.next(m => m.type === 'snapshot')
    await postEvent(office.server, { type: 'session_tool_done', sessionId: 's-done', project: 'api', toolName: 'Bash', signals: [{ kind: 'push_done', target: 'api', branch: 'main', toDefault: true }] })
    expect(await client.next(m => m.type === 'signal' && m.sessionId === 's-done')).toMatchObject({ kind: 'push_done', branch: 'main', toDefault: true })
  })

  it('the snapshot carries the last 20 signals, oldest first, without commands', async () => {
    for (let i = 0; i < 4; i++) {
      const signals = Array.from({ length: 8 }, (_, j) => ({ kind: 'test_start', target: `t${i * 8 + j}`, command: 'npm test' }))
      await postEvent(office.server, { type: 'agent_working', sessionId: 's-snap', status: 'running: npm test', signals })
    }
    const client = await connect(url, officeProtocols(office.server))
    clients.push(client.ws)
    const snapshot = await client.next(m => m.type === 'snapshot')
    expect(snapshot.signals).toHaveLength(20)
    expect(snapshot.signals[19]).toMatchObject({ kind: 'test_start', target: 't31' })
    expect(snapshot.signals[0].seq).toBeLessThan(snapshot.signals[19].seq)
    expect(snapshot.signals.some((s: Message) => 'command' in s)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The office: scenes and chat lines (src/officeReducer.ts)
// ---------------------------------------------------------------------------

const T0 = 2_000_000
const env = (now = T0): OfficeEnv => ({ now, live: true, computePath: () => [], random: () => 0.5 })

/** The boss at his desk and the Claude of session s1 (project api) */
function office(): OfficeState {
  const spot = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-1')!
  const boss = createAgent({ id: BOSS_ID, name: 'Boss', role: 'boss', spot, hiredAt: T0 })
  const state = initialOfficeState([{ ...boss, state: 'working', position: { ...boss.deskPosition }, pathQueue: [] }], T0)
  return reduceOffice(state, { type: 'session_started', sessionId: 's1', project: 'api' }, env()).state
}

const sig = (kind: SignalEvent['kind'], extra: Partial<SignalEvent> = {}): SignalEvent =>
  ({ type: 'signal', kind, target: 'api', sessionId: 's1', project: 'api', ...extra })

function apply(state: OfficeState, actions: OfficeAction[], now = T0): { state: OfficeState; effects: OfficeEffect[] } {
  const effects: OfficeEffect[] = []
  for (const action of actions) {
    const r = reduceOffice(state, action, env(now))
    state = r.state
    effects.push(...r.effects)
  }
  return { state, effects }
}

const claude = (s: OfficeState) => s.agents.find(a => a.id === mainId('s1'))!
const lines = (effects: OfficeEffect[]) => effects.filter((e): e is Extract<OfficeEffect, { kind: 'msg' }> => e.kind === 'msg').map(e => ({ text: e.text, isSystem: e.isSystem }))
const sounds = (effects: OfficeEffect[]) => effects.filter((e): e is Extract<OfficeEffect, { kind: 'sfx' }> => e.kind === 'sfx').map(e => e.sfx)

describe('office: what a signal shows', () => {
  it('deploy_start puts a shipping rocket on the session\'s Claude for up to 10 minutes; deploy_success lands it with a cheer', () => {
    const start = apply(office(), [sig('deploy_start')])
    expect(claude(start.state).scene).toEqual({ kind: 'shipping', until: T0 + SCENE_MS.shipping, label: '🚀 shipping api' })
    expect(start.effects).toContainEqual({ kind: 'schedule', action: { type: 'scene_over', agentId: mainId('s1'), until: T0 + SCENE_MS.shipping }, delayMs: SCENE_MS.shipping })
    expect(lines(start.effects)).toEqual([])

    const landed = apply(start.state, [sig('deploy_success')], T0 + 40_000)
    expect(claude(landed.state).scene).toMatchObject({ kind: 'shipped', until: T0 + 40_000 + SCENE_MS.shipped })
    expect(lines(landed.effects)).toEqual([{ text: '🚀 api deployed', isSystem: true }])
    expect(sounds(landed.effects)).toEqual(['celebration'])
  })

  it('deploy_fail turns the rocket into a red flash and posts the error (incident mode opens the incident)', () => {
    const r = apply(office(), [sig('deploy_start'), sig('deploy_fail', { error: 'Error: Deployment failed: 503', exitCode: 1 })])
    expect(claude(r.state).scene?.kind).toBe('red')
    expect(lines(r.effects)).toEqual([{ text: '💥 api deploy failed — Error: Deployment failed: 503', isSystem: true }])
    // Without an error line the exit code stands in
    expect(lines(apply(office(), [sig('deploy_fail', { exitCode: 2 })]).effects)).toEqual([{ text: '💥 api deploy failed — exit code 2', isSystem: true }])
  })

  it('an interrupted deploy just stops shipping', () => {
    const r = apply(office(), [sig('deploy_start'), sig('deploy_fail', { interrupted: true, error: 'Interrupted by user' })])
    expect(claude(r.state).scene).toBeUndefined()
    expect(lines(r.effects)).toEqual([{ text: '⏹ api deploy interrupted', isSystem: true }])
  })

  it('a failed test run flashes red with its count; the next green run says so once', () => {
    const red = apply(office(), [sig('test_start'), sig('test_failed', { detail: '3 failing', error: 'FAIL tests/a.test.ts' })])
    expect(claude(red.state).scene?.kind).toBe('red')
    expect(lines(red.effects)).toEqual([{ text: '❌ tests failed in api — 3 failing', isSystem: true }])
    expect(sounds(red.effects)).toEqual(['error'])
    const green = apply(red.state, [sig('test_ok')])
    expect(lines(green.effects)).toEqual([{ text: '✅ tests green again in api', isSystem: true }])
    expect(lines(apply(green.state, [sig('test_ok')]).effects)).toEqual([])
    // Green with nothing red before it: quiet
    expect(apply(office(), [sig('build_ok')]).effects).toEqual([])
    // A build failure is its own red run
    const build = apply(office(), [sig('build_failed', { detail: '2 errors' }), sig('build_ok')])
    expect(lines(build.effects)).toEqual([
      { text: '❌ build failed in api — 2 errors', isSystem: true },
      { text: '✅ build green again in api', isSystem: true },
    ])
  })

  it('a push to main gets a small celebration; any other push, nothing', () => {
    const main = apply(office(), [sig('push'), sig('push_done', { branch: 'main', toDefault: true })])
    expect(claude(main.state).scene?.kind).toBe('pushed')
    expect(lines(main.effects)).toEqual([{ text: '🎉 pushed to main · api', isSystem: true }])
    expect(sounds(main.effects)).toEqual(['notification'])
    const feature = apply(office(), [sig('push_done', { branch: 'feature/x', toDefault: false })])
    expect(claude(feature.state).scene).toBeUndefined()
    expect(feature.effects).toEqual([])
  })

  it('a worker that ran the command wears the scene itself', () => {
    const withWorker = apply(office(), [{ type: 'agent_spawned', sessionId: 's1', agent: { id: 'agent-w1', name: 'DevOps', role: 'devops-engineer', task: 'ship it', sessionId: 's1' } }]).state
    const r = apply(withWorker, [sig('deploy_start', { agentId: 'agent-w1', agentName: 'DevOps' })])
    expect(r.state.agents.find(a => a.id === 'agent-w1')?.scene?.kind).toBe('shipping')
    expect(claude(r.state).scene).toBeUndefined()
  })

  it('scene_over ends only the scene it was scheduled for', () => {
    const shipping = apply(office(), [sig('deploy_start')]).state
    const landed = apply(shipping, [sig('deploy_success')], T0 + 1_000).state
    // The shipping scene's own timer fires after the deploy landed: the newer scene stays
    expect(apply(landed, [{ type: 'scene_over', agentId: mainId('s1'), until: T0 + SCENE_MS.shipping }]).state).toBe(landed)
    const over = apply(landed, [{ type: 'scene_over', agentId: mainId('s1'), until: T0 + 1_000 + SCENE_MS.shipped }]).state
    expect(claude(over).scene).toBeUndefined()
  })

  it('an unknown kind or an ended session changes nothing', () => {
    const state = office()
    expect(apply(state, [sig('deploy_rolled_back' as SignalEvent['kind'])]).state).toBe(state)
    const ended = apply(state, [{ type: 'session_ended', sessionId: 's2' }]).state
    const r = apply(ended, [sig('deploy_start', { sessionId: 's2' })])
    expect(r.state.agents.some(a => a.id === mainId('s2'))).toBe(false)
  })

  it('names a failure the way the incident summary does', () => {
    expect(signalFailureLabel(sig('test_failed', { detail: '3 failing' }))).toBe('tests failed in api: 3 failing')
    expect(signalFailureLabel(sig('build_failed', { error: "error TS2322: Type 'string'" }))).toBe("build failed in api: error TS2322: Type 'string'")
    expect(signalFailureLabel(sig('deploy_fail', { target: undefined, error: 'Error: 503' }))).toBe('deploy of api failed: Error: 503')
    expect(signalFailureLabel(sig('deploy_success'))).toBeUndefined()
  })
})
