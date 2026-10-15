/**
 * server/health.js — GET /health (hooks seen, last hook, sessions, version,
 * uptime), the stamp from POST /event, the `health` entry in the WS snapshot
 * and the throttled `health` broadcast.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, postEvent, removeOffice, type Office } from './helpers'
import { HEALTH_THROTTLE_MS, createHealth, readVersion } from '../server/health.js'

const PKG_VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).version

type Message = Record<string, any>

/** Connect and buffer every message; `next` resolves with the first one matching `pred`. */
function connect(url: string): Promise<{ ws: WebSocket; next: (pred?: (m: Message) => boolean) => Promise<Message> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const queue: Message[] = []
    const waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = []
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      const i = waiters.findIndex(w => w.pred(m))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
      else queue.push(m)
    })
    const next = (pred: (m: Message) => boolean = () => true) => {
      const i = queue.findIndex(pred)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise<Message>(res => waiters.push({ pred, resolve: res }))
    }
    ws.once('open', () => resolve({ ws, next }))
    ws.once('error', reject)
  })
}

// ---------------------------------------------------------------------------
// createHealth — the record and its throttle, with an injected clock and timer
// ---------------------------------------------------------------------------

describe('createHealth', () => {
  function harness(over: Record<string, unknown> = {}) {
    let t = 1_000_000
    const broadcasts: Message[] = []
    const timers: Array<{ fn: () => void; ms: number; due: number; cleared: boolean; fired: boolean }> = []
    const health = createHealth({
      now: () => t,
      broadcast: (e: Message) => broadcasts.push(e),
      setTimer: ((fn: () => void, ms: number) => { const h = { fn, ms, due: t + ms, cleared: false, fired: false }; timers.push(h); return h }) as unknown as typeof setTimeout,
      clearTimer: ((h: { cleared: boolean }) => { h.cleared = true }) as unknown as typeof clearTimeout,
      counts: () => ({ agents: 2, clients: 1, sessions: 1 }),
      uiAvailable: true,
      version: '9.9.9',
      ...over,
    })
    /** Advance the clock; fire (once) every live timer whose delay has elapsed */
    const advance = (ms: number) => {
      t += ms
      for (const h of timers) {
        if (h.cleared || h.fired || h.due > t) continue
        h.fired = true
        h.fn()
      }
    }
    return { health, broadcasts, timers, advance, now: () => t }
  }

  it('starts with no hooks seen and reports counts, version, uptime and the UI flag', () => {
    const { health, advance } = harness()
    expect(health.snapshot()).toEqual({
      status: 'ok', agents: 2, clients: 1, sessions: 1,
      lastHookAt: null, hooksSeen: 0, uiAvailable: true, version: '9.9.9', uptimeMs: 0,
    })
    advance(1500)
    expect(health.snapshot().uptimeMs).toBe(1500)
    expect(health.event()).toEqual({ type: 'health', health: health.snapshot(), timestamp: 1_001_500 })
  })

  it('counts every hook and keeps the time of the last one', () => {
    const { health, advance, now } = harness()
    health.markHook()
    advance(10)
    health.markHook()
    expect(health.hooksSeen).toBe(2)
    expect(health.lastHookAt).toBe(now())
    expect(health.snapshot()).toMatchObject({ hooksSeen: 2, lastHookAt: now() })
  })

  it('broadcasts the first hook at once and coalesces a burst into one trailing broadcast', () => {
    const { health, broadcasts, timers, advance } = harness()

    health.markHook()
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({ type: 'health', health: { hooksSeen: 1 } })
    expect(health.pending).toBe(false)

    // Three more inside the window: nothing goes out yet, one timer waits for the window's end
    advance(100); health.markHook()
    advance(100); health.markHook()
    advance(100); health.markHook()
    expect(broadcasts).toHaveLength(1)
    expect(health.pending).toBe(true)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(HEALTH_THROTTLE_MS - 100)

    advance(HEALTH_THROTTLE_MS)
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[1].health.hooksSeen).toBe(4)
    expect(health.pending).toBe(false)

    // After a quiet spell the next hook is immediate again
    advance(HEALTH_THROTTLE_MS * 2)
    health.markHook()
    expect(broadcasts).toHaveLength(3)
    expect(broadcasts[2].health.hooksSeen).toBe(5)
  })

  it('stop() drops a pending trailing broadcast', () => {
    const { health, broadcasts, timers, advance } = harness()
    health.markHook()
    advance(10); health.markHook()
    expect(health.pending).toBe(true)
    health.stop()
    expect(health.pending).toBe(false)
    expect(timers[0].cleared).toBe(true)
    advance(HEALTH_THROTTLE_MS)
    expect(broadcasts).toHaveLength(1)
  })

  it('tolerates a counts() that says nothing and a package.json that cannot be read', () => {
    const health = createHealth({ counts: () => ({}), version: readVersion(new URL('file:///nonexistent/package.json')) })
    expect(health.snapshot()).toMatchObject({ agents: 0, clients: 0, sessions: 0, version: '0.0.0', uiAvailable: false })
  })

  it('readVersion reads the real package.json', () => {
    expect(readVersion()).toBe(PKG_VERSION)
  })
})

// ---------------------------------------------------------------------------
// Through the server: GET /health, POST /event, the snapshot and the broadcast
// ---------------------------------------------------------------------------

describe('GET /health and the health broadcast', () => {
  let office: Office
  let uiDir: string
  let port: number
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    // A built UI so uiAvailable is deterministic whatever this checkout's dist/ holds
    uiDir = mkdtempSync(join(tmpdir(), 'agent-office-ui-'))
    mkdirSync(uiDir, { recursive: true })
    writeFileSync(join(uiDir, 'index.html'), '<!DOCTYPE html><html><body></body></html>')
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
    port = await listen(office.server.httpServer)
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    office.server.app.locals.health.stop()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
    try { rmSync(uiDir, { recursive: true, force: true }) } catch {}
  })

  it('reports the full record before any hook has fired', async () => {
    const res = await request(office.server.app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'ok',
      agents: 0,
      clients: 0,
      sessions: 0,
      lastHookAt: null,
      hooksSeen: 0,
      uiAvailable: true,
      version: PKG_VERSION,
      uptimeMs: expect.any(Number),
    })
  })

  it('rides on the WebSocket snapshot and goes out as a `health` event the moment a hook fires', async () => {
    const client = await connect(`ws://127.0.0.1:${port}/ws`)
    sockets.push(client.ws)

    const snapshot = await client.next(m => m.type === 'snapshot')
    expect(snapshot.health).toMatchObject({ status: 'ok', hooksSeen: 0, lastHookAt: null, sessions: 0, clients: 1, version: PKG_VERSION })

    // Nothing has fired since boot, so the first hook's broadcast is immediate (leading edge)
    const before = Date.now()
    await postEvent(office.server, { type: 'session_started', sessionId: 's-health', project: 'office', cwd: '/tmp/office' })
    const event = await client.next(m => m.type === 'health')
    expect(event).toMatchObject({ type: 'health', health: { status: 'ok', hooksSeen: 1, sessions: 1, agents: 0 } })
    expect(event.health.lastHookAt).toBeGreaterThanOrEqual(before)
    expect(event.timestamp).toBeTypeOf('number')
    expect(Date.now() - before).toBeLessThan(HEALTH_THROTTLE_MS)
  })

  it('is stamped by every accepted POST /event, not by a rejected one', async () => {
    const bad = await postEvent(office.server, { type: 'not_a_thing' })
    expect(bad.status).toBe(400)
    expect((await request(office.server.app).get('/health')).body.hooksSeen).toBe(1)

    const unauthorised = await postEvent(office.server, { type: 'agent_spawned', agent: { id: 'h-0' } }, 'wrong-token')
    expect(unauthorised.status).toBe(401)
    expect((await request(office.server.app).get('/health')).body.hooksSeen).toBe(1)

    const before = Date.now()
    const ok = await postEvent(office.server, { type: 'agent_spawned', sessionId: 's-health', agent: { id: 'h-1', name: 'Debugger', role: 'debugger', task: 'look' } })
    expect(ok.status).toBe(200)
    const body = (await request(office.server.app).get('/health')).body
    expect(body).toMatchObject({ hooksSeen: 2, sessions: 1, agents: 1 })
    expect(body.lastHookAt).toBeGreaterThanOrEqual(before)
    expect(body.lastHookAt).toBeLessThanOrEqual(Date.now())
    // Inside the window of the previous broadcast: this one waits for the trailing edge
    expect(office.server.app.locals.health.pending).toBe(true)
  })

  it('stays open without a token and ahead of the static UI', async () => {
    const res = await request(office.server.app).get('/health').set('Origin', 'http://localhost:3333')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/json/)
    expect(res.body.uiAvailable).toBe(true)
  })
})
