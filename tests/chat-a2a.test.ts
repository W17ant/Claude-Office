/**
 * Chat replies, directed agent-to-agent messages, inbox/unread, and the A2A
 * JSON-RPC surface.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { loadOffice, removeOffice, spawnAgent, type Office, type OfficeServer } from './helpers'

function spawnPair(server: OfficeServer) {
  spawnAgent(server, { id: 'agent-rev', name: 'Reviewer', role: 'code-reviewer', task: 'review auth.ts' })
  spawnAgent(server, { id: 'agent-dbg', name: 'Debugger', role: 'debugger', task: 'fix token refresh' })
}

function readInbox(dir: string, slug: string) {
  return JSON.parse(readFileSync(join(dir, 'inbox', `${slug}.json`), 'utf8'))
}

async function unreadOf(server: OfficeServer, id: string) {
  const res = await request(server.app).get('/agents')
  return res.body.agents.find((a: any) => a.id === id)?.unread
}

describe('POST /chat/reply', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnPair(office.server)
  })
  afterAll(() => removeOffice(office))

  it('delivers a directed message, stores it with its type and writes the inbox file under the runtime dir', async () => {
    const res = await request(office.server.app).post('/chat/reply').send({
      sender: 'Reviewer', role: 'code-reviewer', recipient: 'Debugger', type: 'review_request',
      text: 'can you check the token refresh in auth.ts?',
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: expect.any(Number), recipient: 'Debugger', delivered: true })

    const chat = await request(office.server.app).get('/chat').query({ recipient: 'Debugger' })
    expect(chat.body.messages).toEqual([expect.objectContaining({
      id: res.body.id,
      sender: 'Reviewer',
      role: 'code-reviewer',
      text: 'can you check the token refresh in auth.ts?',
      recipient: 'Debugger',
      msg_type: 'review_request',
      read_at: null,
    })])

    const inbox = readInbox(office.dir, 'debugger')
    expect(inbox).toMatchObject({ id: res.body.id, sender: 'Reviewer', recipient: 'Debugger' })
  })

  it('treats a leading @Name as the recipient when that agent is in the office', async () => {
    const res = await request(office.server.app).post('/chat/reply').send({
      sender: 'Reviewer', role: 'code-reviewer', text: '@Debugger: the retry loop looks wrong',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ recipient: 'Debugger', delivered: true })

    const chat = await request(office.server.app).get('/chat').query({ recipient: 'Debugger' })
    const stored = chat.body.messages.find((m: any) => m.id === res.body.id)
    expect(stored).toMatchObject({ text: 'the retry loop looks wrong', recipient: 'Debugger', msg_type: 'message' })

    // A mention of someone who is not in the office stays a plain reply
    const nobody = await request(office.server.app).post('/chat/reply').send({ sender: 'Reviewer', text: '@Nobody hi there' })
    expect(nobody.status).toBe(200)
    expect(nobody.body).toMatchObject({ recipient: null, delivered: false })
    const all = await request(office.server.app).get('/chat')
    expect(all.body.messages.find((m: any) => m.id === nobody.body.id)).toMatchObject({ text: '@Nobody hi there', recipient: null })
  })

  it('rejects a self-message with 400', async () => {
    const byName = await request(office.server.app).post('/chat/reply').send({
      sender: 'Debugger', recipient: 'Debugger', text: 'note to self',
    })
    expect(byName.status).toBe(400)
    expect(byName.body).toEqual({ error: 'An agent cannot message itself' })

    // Resolving to the same agent through its role counts too
    const byRole = await request(office.server.app).post('/chat/reply').send({
      sender: 'Debugger', recipient: 'debugger', text: 'still me',
    })
    expect(byRole.status).toBe(400)
  })

  it('rejects a reply without text', async () => {
    const res = await request(office.server.app).post('/chat/reply').send({ sender: 'Reviewer' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Missing text' })
  })

  it('GET /chat?recipient= returns only that agent\'s messages, case-insensitively', async () => {
    await request(office.server.app).post('/chat/reply').send({ sender: 'Debugger', recipient: 'Reviewer', text: 'for the reviewer' })
    await request(office.server.app).post('/chat/reply').send({ sender: 'Claude', text: 'for everyone' })

    const forReviewer = await request(office.server.app).get('/chat').query({ recipient: 'reviewer' })
    expect(forReviewer.body.messages.map((m: any) => m.text)).toEqual(['for the reviewer'])

    const forDebugger = await request(office.server.app).get('/chat').query({ recipient: 'Debugger' })
    expect(forDebugger.body.messages.every((m: any) => m.recipient === 'Debugger')).toBe(true)
    expect(forDebugger.body.messages.map((m: any) => m.text)).not.toContain('for everyone')

    const everything = await request(office.server.app).get('/chat')
    expect(everything.body.messages.map((m: any) => m.text)).toContain('for everyone')
  })
})

describe('unread badges and the inbox', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnPair(office.server)
  })
  afterAll(() => removeOffice(office))

  it('increments unread per directed message and POST /chat/inbox/read clears it', async () => {
    expect(await unreadOf(office.server, 'agent-dbg')).toBe(0)

    await request(office.server.app).post('/chat/reply').send({ sender: 'Reviewer', recipient: 'Debugger', text: 'one' })
    expect(await unreadOf(office.server, 'agent-dbg')).toBe(1)
    await request(office.server.app).post('/chat/reply').send({ sender: 'Reviewer', recipient: 'Debugger', text: 'two' })
    expect(await unreadOf(office.server, 'agent-dbg')).toBe(2)
    // A2A cards carry the same counter
    const cards = await request(office.server.app).get('/a2a/agents')
    expect(cards.body.agents.find((c: any) => c.metadata.officeId === 'agent-dbg').metadata.unread).toBe(2)

    // unread survives a restart via agents.json
    const saved = JSON.parse(readFileSync(join(office.dir, 'agents.json'), 'utf8'))
    expect(saved.agents.find((a: any) => a.id === 'agent-dbg').unread).toBe(2)

    const read = await request(office.server.app).post('/chat/inbox/read').send({ recipient: 'Debugger' })
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ ok: true })
    expect(await unreadOf(office.server, 'agent-dbg')).toBe(0)

    const chat = await request(office.server.app).get('/chat').query({ recipient: 'Debugger' })
    expect(chat.body.messages).toHaveLength(2)
    for (const m of chat.body.messages) expect(m.read_at).toBeTypeOf('number')
  })

  it('accepts the office id as the recipient and rejects a missing one', async () => {
    await request(office.server.app).post('/chat/reply').send({ sender: 'Debugger', recipient: 'Reviewer', text: 'ping' })
    expect(await unreadOf(office.server, 'agent-rev')).toBe(1)
    const read = await request(office.server.app).post('/chat/inbox/read').send({ recipient: 'agent-rev' })
    expect(read.status).toBe(200)
    expect(await unreadOf(office.server, 'agent-rev')).toBe(0)

    const missing = await request(office.server.app).post('/chat/inbox/read').send({})
    expect(missing.status).toBe(400)
    expect(missing.body).toEqual({ error: 'Missing recipient' })
  })
})

describe('A2A loop budget', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice({ env: { AGENT_OFFICE_A2A_LIMIT: '3' } })
    spawnPair(office.server)
  })
  afterAll(() => removeOffice(office))

  it('returns 429 once a pair has exchanged AGENT_OFFICE_A2A_LIMIT messages in a minute, in either direction', async () => {
    const send = (sender: string, recipient: string, text: string) =>
      request(office.server.app).post('/chat/reply').send({ sender, recipient, text })

    expect((await send('Reviewer', 'Debugger', '1')).status).toBe(200)
    expect((await send('Debugger', 'Reviewer', '2')).status).toBe(200)
    expect((await send('Reviewer', 'Debugger', '3')).status).toBe(200)

    const blocked = await send('Debugger', 'Reviewer', '4')
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toMatch(/^Loop budget hit: Debugger and Reviewer have exchanged 3 messages/)

    // The budget is per pair — another conversation is unaffected
    expect((await send('Reviewer', 'Tester', 'hello?')).status).toBe(200)

    // Nothing was stored for the blocked message
    const chat = await request(office.server.app).get('/chat').query({ recipient: 'Reviewer' })
    expect(chat.body.messages.map((m: any) => m.text)).toEqual(['2'])
  })
})

describe('GET /agents', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnPair(office.server)
  })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('lists live agents with their public fields, hiding MCP workers and completed agents', async () => {
    office.server.processEvent({ type: 'mcp_call', server: 'github', tool: 'get_me' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    spawnAgent(office.server, { id: 'agent-done', name: 'Tester', role: 'test-engineer', task: 'done already' })
    office.server.processEvent({ type: 'agent_completed', agentId: 'agent-done', result: 'ok' })
    vi.useRealTimers()

    const res = await request(office.server.app).get('/agents')
    expect(res.status).toBe(200)
    expect(res.body.agents).toEqual([
      {
        id: 'agent-rev', name: 'Reviewer', role: 'code-reviewer', task: 'review auth.ts', state: 'new-hire',
        background: false, spawnedAt: expect.any(Number), lastActivityAt: expect.any(Number), unread: 0,
      },
      {
        id: 'agent-dbg', name: 'Debugger', role: 'debugger', task: 'fix token refresh', state: 'new-hire',
        background: false, spawnedAt: expect.any(Number), lastActivityAt: expect.any(Number), unread: 0,
      },
    ])
  })
})

describe('A2A protocol surface', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnPair(office.server)
  })
  afterAll(() => removeOffice(office))

  const rpc = (body: object) => request(office.server.app).post('/a2a').send(body)
  const message = (text: string, metadata: object, extra: object = {}) => ({
    jsonrpc: '2.0', id: 7, method: 'message/send',
    params: { message: { kind: 'message', messageId: 'm1', role: 'agent', parts: [{ kind: 'text', text }], metadata, ...extra } },
  })

  it('serves the office agent card', async () => {
    const res = await request(office.server.app).get('/.well-known/agent-card.json')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      protocolVersion: '0.3.0',
      name: 'Agent Office',
      url: `http://localhost:${office.server.PORT}/a2a`,
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      skills: [expect.objectContaining({ id: 'office-message', tags: ['message', 'question', 'review_request', 'task_handoff'] })],
    })
  })

  it('serves one card per live agent', async () => {
    const res = await request(office.server.app).get('/a2a/agents')
    expect(res.status).toBe(200)
    expect(res.body.agents).toEqual([
      expect.objectContaining({ name: 'Reviewer', description: 'review auth.ts', skills: [expect.objectContaining({ id: 'code-reviewer' })], metadata: { officeId: 'agent-rev', state: 'new-hire', unread: 0 } }),
      expect.objectContaining({ name: 'Debugger', metadata: { officeId: 'agent-dbg', state: 'new-hire', unread: 0 } }),
    ])
  })

  it('message/send delivers to the office agent and echoes the stored message', async () => {
    const res = await rpc(message('can you check token refresh?', { from: 'Reviewer', to: 'Debugger', type: 'review_request' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: {
        kind: 'message',
        messageId: expect.any(String),
        role: 'agent',
        parts: [{ kind: 'text', text: 'can you check token refresh?' }],
        metadata: { from: 'Reviewer', to: 'Debugger', type: 'review_request', timestamp: expect.any(Number) },
      },
    })

    const id = Number(res.body.result.messageId)
    const chat = await request(office.server.app).get('/chat').query({ recipient: 'Debugger' })
    expect(chat.body.messages).toEqual([expect.objectContaining({ id, sender: 'Reviewer', msg_type: 'review_request' })])
    expect(readInbox(office.dir, 'debugger').id).toBe(id)
    expect(await unreadOf(office.server, 'agent-dbg')).toBe(1)

    // Replies thread through metadata.replyTo / referenceTaskIds
    const reply = await rpc(message('on it', { from: 'Debugger', to: 'Reviewer', replyTo: id }))
    expect(reply.body.result.referenceTaskIds).toEqual([String(id)])
  })

  it('answers -32601 for an unknown method', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: {} })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: tasks/get' } })
  })

  it('answers -32600 for a request that is not JSON-RPC 2.0', async () => {
    const res = await rpc({ method: 'message/send' })
    expect(res.body).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })
  })

  it('answers -32602 when the message has no text part or no recipient', async () => {
    const noText = await rpc({
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: { message: { kind: 'message', parts: [{ kind: 'file', file: {} }], metadata: { from: 'Reviewer', to: 'Debugger' } } },
    })
    expect(noText.body.error).toEqual({ code: -32602, message: 'Invalid params: message.parts needs at least one text part' })

    const noRecipient = await rpc(message('hello', { from: 'Reviewer' }))
    expect(noRecipient.body.error).toEqual({ code: -32602, message: 'Invalid params: set message.metadata.to to the recipient agent' })
  })

  it('answers -32000 for a self-message', async () => {
    const res = await rpc(message('talking to myself', { from: 'Debugger', to: 'Debugger' }))
    expect(res.body).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'An agent cannot message itself' } })
  })
})

describe('POST /chat (office UI)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('stores the message and writes last-chat under the runtime dir', async () => {
    const res = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: 'hello office' })
    expect(res.status).toBe(200)
    expect(existsSync(join(office.dir, 'last-chat'))).toBe(true)
    expect(JSON.parse(readFileSync(join(office.dir, 'last-chat'), 'utf8'))).toMatchObject({ sender: 'Boss', text: 'hello office' })

    const chat = await request(office.server.app).get('/chat')
    expect(chat.body.messages).toEqual([expect.objectContaining({ sender: 'Boss', text: 'hello office', is_system: 0 })])
  })

  it('answers slash commands with a system message', async () => {
    const res = await request(office.server.app).post('/chat').send({ sender: 'Boss', text: '/status' })
    expect(res.status).toBe(200)
    const chat = await request(office.server.app).get('/chat')
    expect(chat.body.messages.at(-1)).toMatchObject({ sender: 'system', is_system: 1, text: expect.stringContaining('0 agents active') })
  })
})
