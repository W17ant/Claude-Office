/**
 * ws://.../ws — snapshot on connect, broadcast of events, origin checks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, postAuthed, postEvent, removeOffice, spawnAgent, type Office } from './helpers'

type Message = Record<string, any>

interface Client {
  ws: WebSocket
  /** Resolve with the next message matching `pred` (buffered messages count). */
  next: (pred?: (m: Message) => boolean) => Promise<Message>
  closed: Promise<{ code: number; reason: string }>
}

function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const queue: Message[] = []
    const waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = []
    // Attach before 'open' so the snapshot can never be missed
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      const i = waiters.findIndex(w => w.pred(m))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
      else queue.push(m)
    })
    const closed = new Promise<{ code: number; reason: string }>(res =>
      ws.on('close', (code, reason) => res({ code, reason: reason.toString() })),
    )
    const next = (pred: (m: Message) => boolean = () => true) => {
      const i = queue.findIndex(pred)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise<Message>(res => waiters.push({ pred, resolve: res }))
    }
    ws.once('open', () => resolve({ ws, next, closed }))
    ws.once('error', reject)
  })
}

describe('WebSocket /ws', () => {
  let office: Office
  let port: number
  let url: string
  const clients: WebSocket[] = []

  beforeAll(async () => {
    office = await loadOffice()
    spawnAgent(office.server, { id: 'agent-ws-1', name: 'Debugger', role: 'debugger', task: 'fix it' })
    port = await listen(office.server.httpServer)
    url = `ws://127.0.0.1:${port}/ws`
  })

  afterAll(async () => {
    for (const ws of clients) ws.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('sends a snapshot with activeAgents and mcpServers on connect', async () => {
    const client = await connect(url)
    clients.push(client.ws)

    const snapshot = await client.next()
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.activeAgents).toEqual([expect.objectContaining({ id: 'agent-ws-1', name: 'Debugger', state: 'new-hire' })])
    expect(Array.isArray(snapshot.mcpServers)).toBe(true)
    expect(snapshot.timestamp).toBeTypeOf('number')

    const health = await request(office.server.app).get('/health')
    expect(health.body).toEqual({ status: 'ok', agents: 1, clients: 1 })
  })

  it('broadcasts a POSTed event (and its chat announcement) to every connected client', async () => {
    const a = await connect(url)
    const b = await connect(url)
    clients.push(a.ws, b.ws)
    await a.next(m => m.type === 'snapshot')
    await b.next(m => m.type === 'snapshot')

    const res = await postEvent(office.server, {
      type: 'agent_spawned',
      agent: { id: 'agent-ws-2', name: 'Tester', role: 'test-engineer', task: 'Write tests for parser' },
    })
    expect(res.status).toBe(200)

    for (const client of [a, b]) {
      const spawned = await client.next(m => m.type === 'agent_spawned')
      expect(spawned.agent).toMatchObject({ id: 'agent-ws-2', name: 'Tester', role: 'test-engineer', state: 'new-hire' })
      expect(spawned.timestamp).toBeTypeOf('number')
      const announced = await client.next(m => m.type === 'chat_message')
      expect(announced).toMatchObject({ sender: 'Tester', text: 'starting: Write tests for parser' })
    }

    // Directed messages fan out as chat_message + inbox_update
    await postAuthed(office.server, '/chat/reply', { sender: 'Tester', recipient: 'Debugger', text: 'hi' })
    const inbox = await a.next(m => m.type === 'inbox_update')
    expect(inbox).toEqual({ type: 'inbox_update', agentId: 'agent-ws-1', unread: 1 })
  })

  it('closes connections from a disallowed origin with 1008', async () => {
    const client = await connect(url, { Origin: 'http://evil.example' })
    clients.push(client.ws)
    await expect(client.closed).resolves.toEqual({ code: 1008, reason: 'Forbidden origin' })
  })

  it('accepts the dev-server origin', async () => {
    const client = await connect(url, { Origin: 'http://localhost:3333' })
    clients.push(client.ws)
    const snapshot = await client.next()
    expect(snapshot.type).toBe('snapshot')
  })
})

describe('HTTP origin check', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('returns 403 for a disallowed origin and allows localhost:3333 or no origin', async () => {
    const evil = await request(office.server.app).get('/health').set('Origin', 'http://evil.example')
    expect(evil.status).toBe(403)
    expect(evil.body).toEqual({ error: 'Forbidden origin' })

    const dev = await request(office.server.app).get('/health').set('Origin', 'http://localhost:3333')
    expect(dev.status).toBe(200)
    expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:3333')

    const curl = await request(office.server.app).get('/health')
    expect(curl.status).toBe(200)
  })
})
