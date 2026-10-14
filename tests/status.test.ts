/**
 * server/status.js — POST /status (the status-line feed), GET /status,
 * burn-rate math, the WS broadcast + snapshot, and expiry.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, removeOffice, type Office, type OfficeServer } from './helpers'
import { BURN_WINDOW_MS, HISTORY_POINTS, computeBurn, createStatusStore, validateStatus } from '../server/status.js'

const SID = '8cf68f64-5433-40f7-a130-557fc7f67e42'

/** What hooks/status-line.sh posts for a captured haiku-5-5 session */
function status(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session_status',
    sessionId: SID,
    project: 'Claude-Office',
    model: 'Haiku 5.5',
    modelId: 'claude-haiku-5-5',
    cost: 0.014055975,
    durationMs: 23245,
    apiDurationMs: 19074,
    linesAdded: 156,
    linesRemoved: 23,
    context: { used: 4.4, size: 1000000, input: 44051, output: 358 },
    rateLimits: { fiveHour: 23.5, fiveHourResetsAt: 1738425600, sevenDay: 41.2, sevenDayResetsAt: 1738857600 },
    effort: 'medium',
    exceeds200k: false,
    version: '2.1.300',
    ...overrides,
  }
}

function postStatus(server: OfficeServer, body: unknown, token: string = server.AUTH_TOKEN) {
  return request(server.app).post('/status').set('Authorization', `Bearer ${token}`).send(body as object)
}

const store = (office: Office) => office.server.app.locals.status

describe('POST /status', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('returns 401 without a bearer token or with a wrong one, and stores nothing', async () => {
    const none = await request(office.server.app).post('/status').send(status())
    expect(none.status).toBe(401)
    expect(none.body).toEqual({ error: 'Unauthorized' })
    const wrong = await postStatus(office.server, status(), 'not-the-token')
    expect(wrong.status).toBe(401)
    expect(store(office).has(SID)).toBe(false)
  })

  it('returns 400 for an unknown type, a missing sessionId, or an agent_status without agents', async () => {
    expect((await postStatus(office.server, { type: 'agent_spawned', sessionId: SID })).body).toEqual({ error: 'Unknown status type: agent_spawned' })
    expect((await postStatus(office.server, { type: 'session_status' })).body).toEqual({ error: 'Missing sessionId' })
    expect((await postStatus(office.server, { type: 'agent_status', sessionId: SID })).body).toEqual({ error: 'Missing agents' })
    expect((await postStatus(office.server, { sessionId: SID })).status).toBe(400)
    expect(store(office).size).toBe(0)
  })

  it('stores the latest status per session and GET /status lists it with burn and totals', async () => {
    const res = await postStatus(office.server, status())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const summary = await request(office.server.app).get('/status')
    expect(summary.status).toBe(200)
    expect(summary.body.sessions).toHaveLength(1)
    expect(summary.body.sessions[0]).toMatchObject({
      sessionId: SID,
      project: 'Claude-Office',
      model: 'Haiku 5.5',
      modelId: 'claude-haiku-5-5',
      cost: 0.014055975,
      durationMs: 23245,
      linesAdded: 156,
      linesRemoved: 23,
      context: { used: 4.4, size: 1000000, input: 44051, output: 358 },
      rateLimits: { fiveHour: 23.5, fiveHourResetsAt: 1738425600, sevenDay: 41.2, sevenDayResetsAt: 1738857600 },
      effort: 'medium',
      exceeds200k: false,
      version: '2.1.300',
      burn: { dollarsPerMin: 0, tokensPerMin: 0 },
      agents: [],
    })
    expect(summary.body.sessions[0].updatedAt).toBeTypeOf('number')
    expect(summary.body.sessions[0]).not.toHaveProperty('history')
    expect(summary.body.totals).toEqual({ costToday: 0.014056, tokensPerMin: 0, dollarsPerMin: 0 })

    // A later status replaces, never duplicates
    await postStatus(office.server, status({ cost: 0.02, context: { used: 6, size: 1000000, input: 60000, output: 400 } }))
    const again = await request(office.server.app).get('/status')
    expect(again.body.sessions).toHaveLength(1)
    expect(again.body.sessions[0].cost).toBe(0.02)
    expect(again.body.sessions[0].context.used).toBe(6)
  })

  it('clamps strings and numbers before anything reaches the frontend', async () => {
    const long = 'x'.repeat(500)
    await postStatus(office.server, status({
      sessionId: 'sess-clamp', project: long, model: long, cost: -3, durationMs: Infinity, linesAdded: 'many',
      context: { used: 140, size: -5, input: -1, output: 'lots' },
      rateLimits: { fiveHour: 120, sevenDay: 'none', spendLimit: 130 },
      effort: long, version: long,
    }))
    const rec = store(office).get('sess-clamp')
    expect(rec.project).toHaveLength(200)
    expect(rec.model).toHaveLength(200)
    expect(rec.cost).toBe(0)
    expect(rec.durationMs).toBe(0)
    expect(rec.linesAdded).toBe(0)
    expect(rec.context).toEqual({ used: 100, size: 0, input: 0, output: 0 })
    // Rate-limit windows run 0-100 but spend_limit may exceed 100 once over the limit
    expect(rec.rateLimits).toEqual({ fiveHour: 120, spendLimit: 130 })
    expect(rec.effort).toHaveLength(20)
    expect(rec.version).toHaveLength(20)
  })

  it('borrows the project name from the office session map when the status line has none', async () => {
    office.server.processEvent({
      type: 'agent_spawned', sessionId: 'sess-office', project: 'office-proj', cwd: '/x/office-proj',
      agent: { id: 'agent-office-1', name: 'Agent', role: 'general-purpose', task: 'x' },
    })
    await postStatus(office.server, status({ sessionId: 'sess-office', project: undefined }))
    expect(store(office).get('sess-office').project).toBe('office-proj')
  })

  it('agent_status stores the subagent rows on the session (a stub when the session is new)', async () => {
    const agents = [
      { id: 'ac5ff55b850b4fecf', tokens: 28170, status: 'running', contextSize: 1000000, agentType: 'general-purpose', model: 'claude-haiku-5-5', description: 'Count etc' },
      { id: 'b17c2d9e4f0a1b2c3', tokens: 5120, status: 'completed', agentType: 'Explore' },
    ]
    const res = await postStatus(office.server, { type: 'agent_status', sessionId: SID, agents })
    expect(res.status).toBe(200)
    expect(store(office).get(SID).agents).toEqual(agents)

    await postStatus(office.server, { type: 'agent_status', sessionId: 'sess-only-subagents', agents: [{ id: 'z', tokens: 10, bogus: 1 }, { tokens: 5 }, 'nope'] })
    const stub = store(office).get('sess-only-subagents')
    expect(stub).toMatchObject({ sessionId: 'sess-only-subagents', cost: 0, context: { used: null, size: null, input: 0, output: 0 }, agents: [{ id: 'z', tokens: 10 }] })

    const summary = await request(office.server.app).get('/status')
    expect(summary.body.sessions.find((s: any) => s.sessionId === SID).agents).toEqual(agents)
  })
})

describe('burn rate', () => {
  const now = 1_800_000_000_000

  it('needs two points inside the 5-minute window', () => {
    expect(computeBurn([], now)).toEqual({ dollarsPerMin: 0, tokensPerMin: 0 })
    expect(computeBurn([{ t: now, cost: 1, tokens: 50_000 }], now)).toEqual({ dollarsPerMin: 0, tokensPerMin: 0 })
    expect(computeBurn([{ t: now - BURN_WINDOW_MS - 1, cost: 0, tokens: 0 }, { t: now, cost: 1, tokens: 50_000 }], now)).toEqual({ dollarsPerMin: 0, tokensPerMin: 0 })
  })

  it('takes the cost delta and the tokens of every later call over the span of the window', () => {
    const history = [
      { t: now - 240_000, cost: 0.10, tokens: 50_000 },
      { t: now - 180_000, cost: 0.15, tokens: 40_000 },
      { t: now - 120_000, cost: 0.20, tokens: 40_000 },
      { t: now - 60_000,  cost: 0.25, tokens: 40_000 },
      { t: now,           cost: 0.30, tokens: 40_000 },
    ]
    // 4 minutes of data: $0.20 and 160k tokens
    expect(computeBurn(history, now)).toEqual({ dollarsPerMin: 0.05, tokensPerMin: 40_000 })
  })

  it('ignores points older than five minutes', () => {
    const history = [
      { t: now - 600_000, cost: 0, tokens: 999_999 },
      { t: now - 240_000, cost: 0.10, tokens: 50_000 },
      { t: now,           cost: 0.30, tokens: 160_000 },
    ]
    expect(computeBurn(history, now)).toEqual({ dollarsPerMin: 0.05, tokensPerMin: 40_000 })
  })

  it('extrapolates less than a minute of data to a minute', () => {
    const history = [{ t: now - 10_000, cost: 0.10, tokens: 1 }, { t: now, cost: 0.12, tokens: 30_000 }]
    expect(computeBurn(history, now)).toEqual({ dollarsPerMin: 0.02, tokensPerMin: 30_000 })
  })

  it('the store builds that history from status points and sums the totals', () => {
    let clock = now
    const s = createStatusStore({ now: () => clock })
    s.ingest(status({ cost: 0.10, context: { used: 4, size: 1000000, input: 40_000, output: 300 } }))
    // The status line re-runs for a permission-mode or vim toggle with the same numbers: no new point
    s.ingest(status({ cost: 0.10, context: { used: 4, size: 1000000, input: 40_000, output: 300 } }))
    clock += 60_000
    s.ingest(status({ cost: 0.16, context: { used: 5, size: 1000000, input: 52_000, output: 500 } }))
    clock += 60_000
    s.ingest(status({ cost: 0.22, context: { used: 6, size: 1000000, input: 64_000, output: 400 } }))
    expect(s.get(SID).history).toHaveLength(3)

    // 2 minutes: $0.12 and 52.5k + 64.4k tokens
    const { sessions, totals } = s.summary()
    expect(sessions[0].burn).toEqual({ dollarsPerMin: 0.06, tokensPerMin: 58_450 })

    s.ingest(status({ sessionId: 'other', project: 'other', cost: 0.5, context: { used: 10, size: 200000, input: 20_000, output: 100 } }))
    clock += 30_000
    s.ingest(status({ sessionId: 'other', project: 'other', cost: 0.6, context: { used: 11, size: 200000, input: 22_000, output: 100 } }))
    const after = s.summary()
    expect(after.sessions.map((x: any) => x.sessionId)).toEqual(['other', SID])
    expect(after.sessions[0].burn).toEqual({ dollarsPerMin: 0.1, tokensPerMin: 22_100 })
    expect(after.totals.costToday).toBe(0.82)
    expect(after.totals.tokensPerMin).toBe(22_100 + after.sessions[1].burn.tokensPerMin)
    expect(after.totals.dollarsPerMin).toBeCloseTo(0.1 + after.sessions[1].burn.dollarsPerMin, 6)
    expect(totals.costToday).toBe(0.22)
  })

  it('keeps a ring of HISTORY_POINTS points', () => {
    let clock = now
    const s = createStatusStore({ now: () => clock })
    for (let i = 0; i < HISTORY_POINTS + 10; i++) {
      clock += 1000
      s.ingest(status({ cost: i * 0.01, context: { used: 1, size: 1000000, input: 1000 + i, output: 10 } }))
    }
    expect(s.get(SID).history).toHaveLength(HISTORY_POINTS)
  })

  it('validateStatus names the problem', () => {
    expect(validateStatus(null)).toBe('Missing body')
    expect(validateStatus({})).toBe('Missing event type')
    expect(validateStatus({ type: 'x' })).toBe('Unknown status type: x')
    expect(validateStatus({ type: 'session_status' })).toBe('Missing sessionId')
    expect(validateStatus({ type: 'agent_status', sessionId: 's' })).toBe('Missing agents')
    expect(validateStatus(status())).toBeNull()
  })
})

describe('expiry', () => {
  it('drops sessions quiet for staleMs, keeps their cost in costToday, returns removal events', () => {
    let clock = 1_800_000_000_000
    const s = createStatusStore({ staleMs: 1000, now: () => clock })
    s.ingest(status({ cost: 0.5 }))
    s.ingest(status({ sessionId: 'fresh', cost: 0.25 }))
    clock += 500
    expect(s.expireStale()).toEqual([])
    clock += 600
    s.ingest(status({ sessionId: 'fresh', cost: 0.3 }))  // keeps 'fresh' alive
    const events = s.expireStale()
    // 'fresh' went from $0.25 to $0.30 in just over a second: extrapolated to $0.05/min, no new tokens
    expect(events).toEqual([{ type: 'session_status', sessionId: SID, removed: true, totals: { costToday: 0.8, tokensPerMin: 0, dollarsPerMin: 0.05 }, timestamp: clock }])
    expect(s.has(SID)).toBe(false)
    expect(s.summary().sessions.map((x: any) => x.sessionId)).toEqual(['fresh'])
    expect(s.summary().totals.costToday).toBe(0.8)
  })

  it('the mounted store uses AGENT_OFFICE_STALE_MINUTES', async () => {
    const office = await loadOffice({ env: { AGENT_OFFICE_STALE_MINUTES: '1' } })
    try {
      await postStatus(office.server, status())
      expect(store(office).expireStale(Date.now() + 59_000)).toEqual([])
      const events = store(office).expireStale(Date.now() + 61_000)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'session_status', sessionId: SID, removed: true })
      expect((await request(office.server.app).get('/status')).body.sessions).toEqual([])
    } finally {
      removeOffice(office)
    }
  })
})

describe('WebSocket', () => {
  let office: Office
  let url: string
  const sockets: WebSocket[] = []

  function connect(): Promise<{ next: (pred?: (m: any) => boolean) => Promise<any> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      sockets.push(ws)
      const queue: any[] = []
      const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = []
      ws.on('message', raw => {
        const m = JSON.parse(raw.toString())
        const i = waiters.findIndex(w => w.pred(m))
        if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
        else queue.push(m)
      })
      const next = (pred: (m: any) => boolean = () => true) => {
        const i = queue.findIndex(pred)
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
        return new Promise<any>(res => waiters.push({ pred, resolve: res }))
      }
      ws.once('open', () => resolve({ next }))
      ws.once('error', reject)
    })
  }

  beforeAll(async () => {
    office = await loadOffice()
    await postStatus(office.server, status())
    const port = await listen(office.server.httpServer)
    url = `ws://127.0.0.1:${port}/ws`
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('the snapshot carries the status summary (sessions + totals)', async () => {
    const client = await connect()
    const snapshot = await client.next(m => m.type === 'snapshot')
    expect(snapshot.statuses.sessions).toEqual([expect.objectContaining({ sessionId: SID, project: 'Claude-Office', cost: 0.014055975 })])
    expect(snapshot.statuses.totals).toEqual({ costToday: 0.014056, tokensPerMin: 0, dollarsPerMin: 0 })
  })

  it('broadcasts session_status (session + totals) and agent_status to every client', async () => {
    const a = await connect()
    const b = await connect()
    await a.next(m => m.type === 'snapshot')
    await b.next(m => m.type === 'snapshot')

    await postStatus(office.server, status({ cost: 0.03, context: { used: 88, size: 200000, input: 176_000, output: 900 } }))
    for (const client of [a, b]) {
      const ev = await client.next(m => m.type === 'session_status')
      expect(ev.sessionId).toBe(SID)
      expect(ev.session).toMatchObject({ project: 'Claude-Office', cost: 0.03, context: { used: 88, size: 200000 }, model: 'Haiku 5.5' })
      expect(ev.session.burn.tokensPerMin).toBeGreaterThan(0)
      expect(ev.totals.costToday).toBe(0.03)
      expect(ev.timestamp).toBeTypeOf('number')
    }

    await postStatus(office.server, { type: 'agent_status', sessionId: SID, agents: [{ id: 'ac5', tokens: 100 }] })
    const ev = await a.next(m => m.type === 'agent_status')
    expect(ev).toMatchObject({ sessionId: SID, agents: [{ id: 'ac5', tokens: 100 }] })
  })
})
