/**
 * /incident and /all-clear — the server relays incident mode to every
 * connected office as a `variant_change` broadcast and answers with a system
 * line, so all tabs switch together. Nothing is persisted server-side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { readdirSync } from 'node:fs'
import { listen, loadOffice, removeOffice, type Office } from './helpers'

type Message = Record<string, any>

interface Client {
  ws: WebSocket
  next: (pred?: (m: Message) => boolean) => Promise<Message>
}

function connect(url: string): Promise<Client> {
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

describe('POST /chat — /incident and /all-clear', () => {
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

  it('/incident broadcasts variant_change=incident to every client and answers with a system line', async () => {
    const a = await connect(url)
    const b = await connect(url)
    clients.push(a.ws, b.ws)
    await a.next(m => m.type === 'snapshot')
    await b.next(m => m.type === 'snapshot')

    const res = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/incident' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    for (const client of [a, b]) {
      const change = await client.next(m => m.type === 'variant_change')
      expect(change).toMatchObject({ variant: 'incident', reason: 'manual' })
      expect(change.timestamp).toBeTypeOf('number')

      // The boss's own line is echoed, then the system reply
      const echo = await client.next(m => m.type === 'chat_message' && m.sender === 'Boss')
      expect(echo.text).toBe('/incident')
      const sys = await client.next(m => m.type === 'chat_message' && m.sender === 'system')
      expect(sys).toMatchObject({ isSystem: true, text: expect.stringContaining('INCIDENT DECLARED') })
    }

    const chat = await request(office.server.app).get('/chat')
    expect(chat.body.messages.at(-1)).toMatchObject({ sender: 'system', is_system: 1, text: expect.stringContaining('INCIDENT DECLARED') })
  })

  it('/all-clear broadcasts variant_change=none and answers with the all-clear line', async () => {
    const a = await connect(url)
    clients.push(a.ws)
    await a.next(m => m.type === 'snapshot')

    const res = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/all-clear' })
    expect(res.status).toBe(200)

    const change = await a.next(m => m.type === 'variant_change')
    expect(change).toMatchObject({ variant: 'none', reason: 'manual' })
    const sys = await a.next(m => m.type === 'chat_message' && m.sender === 'system')
    expect(sys.text).toContain('ALL CLEAR')
  })

  it('/help lists both commands', async () => {
    await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/help' })
    const chat = await request(office.server.app).get('/chat')
    const help = chat.body.messages.at(-1).text as string
    expect(help).toContain('/incident')
    expect(help).toContain('/all-clear')
  })

  it('persists nothing about the incident server-side', async () => {
    // Only the usual runtime files: no incident state file appears after the commands above
    const files = readdirSync(office.dir)
    expect(files.some(f => /incident|variant/i.test(f))).toBe(false)
    const status = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/status' })
    expect(status.status).toBe(200)
    const chat = await request(office.server.app).get('/chat')
    expect(chat.body.messages.at(-1).text).toContain('0 agents active')
  })
})
