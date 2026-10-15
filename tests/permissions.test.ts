/**
 * server/permissions.js — answer a Claude Code permission dialog from the
 * office: the pending record a PermissionRequest creates through POST /event,
 * the hook's long-poll (GET /permission/:id, token), the page's decision
 * (POST /permission/:id, UI token), release by the session's later activity,
 * the 15 s / 10 min expiry policy, the broadcasts and the snapshot, the
 * answerPermissions setting and its marker file.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, officeProtocols, postAuthed, postEvent, removeOffice, type Office, type OfficeServer } from './helpers'
import {
  DENY_MESSAGE, PERMISSION_WAIT_MAX_MS, PERMISSION_WAIT_MS, createPermissionStore, hookOutputFor, sanitiseSuggestions,
} from '../server/permissions.js'

const ALPHA = {
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
  project: 'alpha',
  cwd: '/home/me/alpha',
  transcriptPath: '/root/.claude/projects/-home-me-alpha/aaaaaaaa-1111-4111-8111-111111111111.jsonl',
}
const BETA = { ...ALPHA, sessionId: 'bbbbbbbb-2222-4222-8222-222222222222', project: 'beta', cwd: '/home/me/beta' }

const SUGGESTIONS = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]

/** What the hook POSTs for a PermissionRequest the office may answer (marker present). */
function permissionRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session_needs_you', kind: 'permission', ...ALPHA, promptId: 'p-1',
    toolName: 'Write', summary: 'probe.txt', detail: '/home/me/alpha/probe.txt',
    answerable: true, permissionMode: 'default', suggestions: SUGGESTIONS,
    ...overrides,
  }
}

const ALLOW_OUTPUT = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
const ALLOW_REMEMBER_OUTPUT = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: SUGGESTIONS } } }
const DENY_OUTPUT = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: DENY_MESSAGE, interrupt: false } } }

/** The hook's long-poll. */
const poll = (server: OfficeServer, id: string, wait = 5, token = server.AUTH_TOKEN) =>
  request(server.app).get(`/permission/${id}?wait=${wait}`).set('Authorization', `Bearer ${token}`)

/** The page's click. */
const decide = (server: OfficeServer, id: string, decision: string, token = server.UI_TOKEN) =>
  request(server.app).post(`/permission/${id}`).set('Authorization', `Bearer ${token}`).send({ decision })

const pendingIds = async (server: OfficeServer) =>
  ((await request(server.app).get('/permissions')).body.permissions as Array<{ id: string }>).map(p => p.id)

describe('the pure parts', () => {
  it('hookOutputFor builds the exact PermissionRequest hook output per decision, never with updatedInput', () => {
    expect(hookOutputFor('allow')).toEqual(ALLOW_OUTPUT)
    expect(hookOutputFor('allow-remember', SUGGESTIONS)).toEqual(ALLOW_REMEMBER_OUTPUT)
    expect(hookOutputFor('deny')).toEqual(DENY_OUTPUT)
    expect(hookOutputFor('maybe')).toBeNull()
    expect(JSON.stringify(hookOutputFor('allow-remember', SUGGESTIONS))).not.toContain('updatedInput')
  })

  it('sanitiseSuggestions keeps the PermissionUpdate shape (rules[] included) but bounds count, depth and sizes', () => {
    const addRules = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }
    expect(sanitiseSuggestions([addRules, ...SUGGESTIONS])).toEqual([addRules, ...SUGGESTIONS])
    expect(sanitiseSuggestions(new Array(10).fill(SUGGESTIONS[0]))).toHaveLength(4)
    expect(sanitiseSuggestions([{ mode: 'x'.repeat(500) }])[0].mode).toHaveLength(200)
    expect(sanitiseSuggestions([{ rules: new Array(20).fill({ toolName: 'Bash' }) }])[0].rules).toHaveLength(8)
    expect(sanitiseSuggestions([{ a: { b: { c: { d: 'too deep' } } } }])).toEqual([{ a: { b: { c: null } } }])
    expect(sanitiseSuggestions([{ n: Infinity, ok: true, nil: null }])).toEqual([{ n: null, ok: true, nil: null }])
    expect(sanitiseSuggestions(['setMode', 42, null, SUGGESTIONS[0]])).toEqual(SUGGESTIONS)
    expect(sanitiseSuggestions('nope')).toEqual([])
    expect(sanitiseSuggestions(undefined)).toEqual([])
  })

  it('the store: a pending record expires after PERMISSION_WAIT_MS, or after PERMISSION_WAIT_MAX_MS once the session is interactive', () => {
    vi.useFakeTimers()
    try {
      const events: any[] = []
      const store = createPermissionStore({ broadcast: e => events.push(e) })
      const { permission, wait } = store.create({ sessionId: 's1', toolName: 'Write', summary: 'a.txt' })
      expect(permission).toMatchObject({ status: 'pending', interactive: false, deadline: permission.createdAt + PERMISSION_WAIT_MS })
      expect(wait).toEqual({ pollMs: 20_000, deadline: permission.deadline })
      expect(events).toEqual([{ type: 'permission_request', permission, timestamp: expect.any(Number) }])

      // One millisecond short: still pending; then the timeout
      vi.advanceTimersByTime(PERMISSION_WAIT_MS - 1)
      expect(store.get(permission.id)?.status).toBe('pending')
      vi.advanceTimersByTime(1)
      expect(store.get(permission.id)).toMatchObject({ status: 'expired', decidedBy: 'timeout' })
      expect(events.at(-1)).toEqual({ type: 'permission_resolved', permissionId: permission.id, sessionId: 's1', status: 'expired', decidedBy: 'timeout', timestamp: expect.any(Number) })
      expect(store.pending()).toEqual([])

      // A Notification arrives for the session: the pending record of it may wait the full ten minutes
      const second = store.create({ sessionId: 's1', toolName: 'Bash', summary: 'npm test' }).permission
      vi.advanceTimersByTime(6_000)
      const extended = store.markInteractive('s1')
      expect(extended).toEqual([expect.objectContaining({ id: second.id, interactive: true, deadline: second.createdAt + PERMISSION_WAIT_MAX_MS })])
      expect(events.at(-1)).toEqual({ type: 'permission_extended', permissionId: second.id, sessionId: 's1', deadline: second.createdAt + PERMISSION_WAIT_MAX_MS, timestamp: expect.any(Number) })
      vi.advanceTimersByTime(PERMISSION_WAIT_MS)
      expect(store.get(second.id)?.status).toBe('pending')
      vi.advanceTimersByTime(PERMISSION_WAIT_MAX_MS - PERMISSION_WAIT_MS - 6_000)
      expect(store.get(second.id)?.status).toBe('expired')

      // The session stays interactive: the next request starts with the long deadline, and a second markInteractive extends nothing
      const third = store.create({ sessionId: 's1', toolName: 'Edit', summary: 'b.ts' }).permission
      expect(third).toMatchObject({ interactive: true, deadline: third.createdAt + PERMISSION_WAIT_MAX_MS })
      expect(store.markInteractive('s1')).toEqual([])
      // Another session is not
      expect(store.create({ sessionId: 's2', toolName: 'Edit', summary: 'c.ts' }).permission.interactive).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the store: decide validates, resolves once, and resolveSession honours its filter', () => {
    const store = createPermissionStore()
    const noSuggestions = store.create({ sessionId: 's1', toolName: 'Bash', summary: 'ls', suggestions: [] }).permission
    expect(store.decide('nope', 'allow')).toEqual({ error: 'Unknown permission', code: 404 })
    expect(store.decide(noSuggestions.id, 'maybe')).toMatchObject({ code: 400 })
    expect(store.decide(noSuggestions.id, 'allow-remember')).toMatchObject({ code: 400, error: expect.stringContaining('Nothing to remember') })
    expect(store.decide(noSuggestions.id, 'deny').permission).toMatchObject({ status: 'denied', decidedBy: 'office', decision: 'deny', hookOutput: DENY_OUTPUT })
    expect(store.decide(noSuggestions.id, 'allow')).toMatchObject({ code: 409, status: 'denied' })

    const a = store.create({ sessionId: 's1', toolName: 'Write', summary: 'a' }).permission
    const b = store.create({ sessionId: 's1', toolName: 'Edit', summary: 'b' }).permission
    const other = store.create({ sessionId: 's2', toolName: 'Write', summary: 'c' }).permission
    expect(store.resolveSession('s1', 'test', p => p.toolName === 'Edit')).toBe(1)
    expect(store.get(b.id)).toMatchObject({ status: 'resolved_elsewhere', decidedBy: 'terminal' })
    expect(store.get(a.id)?.status).toBe('pending')
    expect(store.resolveSession('s1', 'test')).toBe(1)
    expect(store.get(a.id)?.status).toBe('resolved_elsewhere')
    expect(store.get(other.id)?.status).toBe('pending')
    expect(store.resolveSession('s3', 'test')).toBe(0)
  })
})

describe('POST /event creates a pending permission', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('an answerable session_needs_you answers with permissionId + wait; GET /permissions lists it (the command line only with a token); the hand is still raised after the debounce', async () => {
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup', title: 'login fix' })
    const res = await postEvent(office.server, permissionRequest())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, permissionId: expect.stringMatching(/^[0-9a-f]{16}$/), wait: { pollMs: 20_000, deadline: expect.any(Number) } })
    const id = res.body.permissionId as string

    // Open: what the hand shows on GET /sessions, not the command line or the suggestions
    const open = await request(office.server.app).get('/permissions')
    expect(open.status).toBe(200)
    expect(open.body.permissions).toEqual([{
      id, sessionId: ALPHA.sessionId, project: 'alpha', cwd: '/home/me/alpha', sessionTitle: 'login fix',
      toolName: 'Write', summary: 'probe.txt', permissionMode: 'default',
      promptId: 'p-1', createdAt: expect.any(Number), deadline: res.body.wait.deadline, status: 'pending', interactive: false,
    }])
    const list = await request(office.server.app).get('/permissions').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    expect(list.status).toBe(200)
    expect(list.body.permissions).toEqual([{
      id, sessionId: ALPHA.sessionId, project: 'alpha', cwd: '/home/me/alpha', sessionTitle: 'login fix',
      toolName: 'Write', summary: 'probe.txt', detail: '/home/me/alpha/probe.txt', suggestions: SUGGESTIONS, permissionMode: 'default',
      promptId: 'p-1', createdAt: expect.any(Number), deadline: res.body.wait.deadline, status: 'pending', interactive: false,
    }])
    expect(res.body.wait.deadline - list.body.permissions[0].createdAt).toBe(PERMISSION_WAIT_MS)

    // The usual needs-you path is untouched: the hand goes up after the 300 ms debounce
    await new Promise(r => setTimeout(r, 350))
    expect(office.server.sessions.get(ALPHA.sessionId)?.main).toMatchObject({ state: 'needs-you', needsYou: { kind: 'permission', toolName: 'Write' } })
    office.server.permissions.resolveSession(ALPHA.sessionId, '')
  })

  it('without answerable, with the setting off, or without a session id the response is the plain {ok} and nothing is created', async () => {
    const plain = await postEvent(office.server, permissionRequest({ answerable: undefined }))
    expect(plain.body).toEqual({ ok: true })
    const noSession = await postEvent(office.server, permissionRequest({ sessionId: undefined }))
    expect(noSession.body).toEqual({ ok: true })
    await postAuthed(office.server, '/settings', { answerPermissions: false })
    try {
      const off = await postEvent(office.server, permissionRequest())
      expect(off.body).toEqual({ ok: true })
    } finally {
      await postAuthed(office.server, '/settings', { answerPermissions: true })
    }
    expect(await pendingIds(office.server)).toEqual([])
  })

  it('clamps: detail to 400, suggestions to 4 bounded objects, and the broadcast carries the same record', async () => {
    const res = await postEvent(office.server, permissionRequest({
      toolName: 'Bash', summary: 'x', detail: 'y'.repeat(1000), suggestions: new Array(9).fill({ type: 'setMode', mode: 'm'.repeat(300), destination: 'session' }),
    }))
    const rec = office.server.permissions.get(res.body.permissionId)
    expect(rec.detail).toHaveLength(400)
    expect(rec.suggestions).toHaveLength(4)
    expect(rec.suggestions[0].mode).toHaveLength(200)
    office.server.permissions.resolveSession(ALPHA.sessionId, '')
  })
})

describe('the hook long-poll and the office decision', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))
  afterEach(() => { office.server.permissions.resolveSession(ALPHA.sessionId, ''); office.server.permissions.resolveSession(BETA.sessionId, '') })

  it('GET /permission/:id waits, POST allow with the UI token releases it with the exact allow hookOutput, and the hand comes down', async () => {
    const { permissionId: id } = (await postEvent(office.server, permissionRequest())).body
    await new Promise(r => setTimeout(r, 350))
    expect(office.server.sessions.get(ALPHA.sessionId)?.main.state).toBe('needs-you')

    const started = Date.now()
    const waiting = poll(office.server, id, 10)
    await new Promise(r => setTimeout(r, 100))
    const click = await decide(office.server, id, 'allow')
    expect(click.status).toBe(200)
    expect(click.body).toEqual({ ok: true, permissionId: id, status: 'allowed' })

    const res = await waiting
    expect(Date.now() - started).toBeLessThan(5_000)   // released by the click, not by the wait
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'allowed', deadline: expect.any(Number), hookOutput: ALLOW_OUTPUT })
    expect(office.server.sessions.get(ALPHA.sessionId)?.main).toMatchObject({ state: 'working' })
    expect(office.server.sessions.get(ALPHA.sessionId)?.main.needsYou).toBeUndefined()
    // A later poll of a decided record still answers (the hook may have raced the click)
    expect((await poll(office.server, id, 0)).body).toMatchObject({ status: 'allowed', hookOutput: ALLOW_OUTPUT })
  })

  it('allow-remember echoes the suggestions as updatedPermissions; deny carries the office message; a decision before the debounce withdraws the parked hand', async () => {
    const a = (await postEvent(office.server, permissionRequest())).body.permissionId
    expect((await decide(office.server, a, 'allow-remember')).body).toMatchObject({ status: 'allowed' })
    expect((await poll(office.server, a, 0)).body.hookOutput).toEqual(ALLOW_REMEMBER_OUTPUT)
    // Decided within the 300 ms debounce: the parked wait never becomes a raised hand
    await new Promise(r => setTimeout(r, 350))
    expect(office.server.sessions.get(ALPHA.sessionId)?.main.state).not.toBe('needs-you')

    const b = (await postEvent(office.server, permissionRequest({ promptId: 'p-2' }))).body.permissionId
    expect((await decide(office.server, b, 'deny')).body).toMatchObject({ status: 'denied' })
    expect((await poll(office.server, b, 0)).body).toEqual({ status: 'denied', deadline: expect.any(Number), hookOutput: DENY_OUTPUT })
  })

  it('a long-poll with wait=0 answers at once with pending; wait is capped at 30 s', async () => {
    const id = (await postEvent(office.server, permissionRequest())).body.permissionId
    const res = await poll(office.server, id, 0)
    expect(res.body).toEqual({ status: 'pending', deadline: expect.any(Number) })
    expect(res.body).not.toHaveProperty('hookOutput')
    // The cap is not observable without waiting 30 s; the parameter itself is accepted
    const started = Date.now()
    const capped = poll(office.server, id, 9999)
    await decide(office.server, id, 'allow')
    expect((await capped).body.status).toBe('allowed')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('401 without a token and with a wrong one (poll and decision alike), 404 for an unknown id, 409 for a second decision, 400 for a bad one and for allow-remember without suggestions', async () => {
    const id = (await postEvent(office.server, permissionRequest({ suggestions: [] }))).body.permissionId
    expect((await request(office.server.app).get(`/permission/${id}`)).status).toBe(401)
    expect((await poll(office.server, id, 0, 'wrong')).status).toBe(401)
    expect((await request(office.server.app).post(`/permission/${id}`).send({ decision: 'allow' })).status).toBe(401)
    expect((await decide(office.server, id, 'allow', 'wrong-ui-token')).status).toBe(401)
    expect((await decide(office.server, id, 'allow', office.server.UI_TOKEN + 'x')).status).toBe(401)
    // The hook's long-poll takes the file token only, not the UI token
    expect((await poll(office.server, id, 0, office.server.UI_TOKEN)).status).toBe(401)
    expect((await poll(office.server, 'ffffffffffffffff', 0)).status).toBe(404)
    expect((await decide(office.server, 'ffffffffffffffff', 'allow')).status).toBe(404)
    expect((await decide(office.server, id, 'maybe')).status).toBe(400)
    expect((await decide(office.server, id, 'allow-remember')).status).toBe(400)
    expect((await decide(office.server, id, 'deny')).status).toBe(200)
    const twice = await decide(office.server, id, 'allow')
    expect(twice.status).toBe(409)
    expect(twice.body).toEqual({ error: 'Permission already denied', status: 'denied' })
    // The file token works for the decision too (a script with the token may answer)
    const other = (await postEvent(office.server, permissionRequest())).body.permissionId
    expect((await decide(office.server, other, 'allow', office.server.AUTH_TOKEN)).status).toBe(200)
  })

  it('is resolved_elsewhere by the session\'s later activity: PostToolUse of the tool, PostToolBatch, Stop, a prompt, a new PermissionRequest, a tool call past the race window, the session ending', async () => {
    const after = async (event: Record<string, unknown>) => {
      const id = (await postEvent(office.server, permissionRequest())).body.permissionId
      const waiting = poll(office.server, id, 10)
      await new Promise(r => setTimeout(r, 50))
      await postEvent(office.server, event)
      const res = await waiting
      expect(res.body).toEqual({ status: 'resolved_elsewhere', deadline: expect.any(Number) })
      return office.server.permissions.get(id)
    }
    expect(await after({ type: 'session_tool_done', ...ALPHA, promptId: 'p-1', toolName: 'Write' })).toMatchObject({ decidedBy: 'terminal' })
    expect(await after({ type: 'session_tool_done', ...ALPHA, promptId: 'p-1', batch: true, count: 1 })).toMatchObject({ decidedBy: 'terminal' })
    expect(await after({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'done', backgroundTasks: [], crons: 0 })).toMatchObject({ decidedBy: 'terminal' })
    expect(await after({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'no, do it differently' })).toMatchObject({ decidedBy: 'terminal' })
    expect(await after({ type: 'session_error', ...ALPHA, promptId: 'p-2', error: 'rate_limit', detail: '' })).toMatchObject({ decidedBy: 'terminal' })
    expect(await after({ type: 'session_ended', ...ALPHA, reason: 'other' })).toMatchObject({ decidedBy: 'terminal' })
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'resume' })

    // A new PermissionRequest of the same session releases the old one and creates its own
    const old = (await postEvent(office.server, permissionRequest())).body.permissionId
    const fresh = (await postEvent(office.server, permissionRequest({ promptId: 'p-3', toolName: 'Bash', summary: 'ls', detail: 'ls' }))).body.permissionId
    expect(office.server.permissions.get(old)).toMatchObject({ status: 'resolved_elsewhere' })
    expect(office.server.permissions.get(fresh)).toMatchObject({ status: 'pending' })
    // Another session's activity touches nothing
    await postEvent(office.server, { type: 'session_tool_done', ...BETA, batch: true, count: 1 })
    expect(office.server.permissions.get(fresh)?.status).toBe('pending')
  })

  it('a PostToolUse of another tool, or a PreToolUse, inside the race window leaves it pending; past the window they release it', async () => {
    const id = (await postEvent(office.server, permissionRequest())).body.permissionId
    // The Read that ran beside the Write in the same batch, and the Write's own late PreToolUse
    await postEvent(office.server, { type: 'session_tool_done', ...ALPHA, promptId: 'p-1', toolName: 'Read' })
    await postEvent(office.server, { type: 'agent_working', ...ALPHA, status: 'writing probe.txt' })
    expect(office.server.permissions.get(id)?.status).toBe('pending')
    // Age the record past PERMISSION_RACE_MS (1 s) and a tool call means the dialog was answered
    office.server.permissions.get(id)  // public copy; adjust the live record through a new old one instead:
    const aged = (await postEvent(office.server, permissionRequest({ promptId: 'p-9' }))).body.permissionId
    await new Promise(r => setTimeout(r, 1_050))
    await postEvent(office.server, { type: 'agent_working', ...ALPHA, status: 'reading x' })
    expect(office.server.permissions.get(aged)).toMatchObject({ status: 'resolved_elsewhere', decidedBy: 'terminal' })
  })

  it('a Notification for the session (interactive) extends the deadline to the ten-minute maximum; the hook sees the new deadline on its next poll', async () => {
    const res = await postEvent(office.server, permissionRequest())
    const id = res.body.permissionId
    const before = res.body.wait.deadline
    await postEvent(office.server, { type: 'session_needs_you', ...ALPHA, promptId: 'p-1', kind: 'permission', notificationType: 'permission_prompt', message: 'Claude needs your permission' })
    const rec = office.server.permissions.get(id)
    expect(rec).toMatchObject({ status: 'pending', interactive: true, deadline: rec.createdAt + PERMISSION_WAIT_MAX_MS })
    expect(rec.deadline).toBeGreaterThan(before)
    expect((await poll(office.server, id, 0)).body).toEqual({ status: 'pending', deadline: rec.deadline })
    // The Notification is the same dialog, not a new request: nothing was released
    expect(await pendingIds(office.server)).toEqual([id])
  })
})

describe('expiry over HTTP (short wait via env)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice({ env: { AGENT_OFFICE_PERMISSION_WAIT_MS: '400' } }) })
  afterAll(() => removeOffice(office))

  it('a pending permission nobody answers expires at the deadline and the long-poll returns expired without hookOutput', async () => {
    const res = await postEvent(office.server, permissionRequest())
    expect(res.body.wait.deadline - Date.now()).toBeLessThanOrEqual(400)
    const started = Date.now()
    const waiting = await poll(office.server, res.body.permissionId, 5)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(waiting.body).toEqual({ status: 'expired', deadline: res.body.wait.deadline })
    expect(office.server.permissions.get(res.body.permissionId)).toMatchObject({ status: 'expired', decidedBy: 'timeout' })
    expect((await decide(office.server, res.body.permissionId, 'allow')).status).toBe(409)
  })
})

describe('the WebSocket: snapshot and broadcasts', () => {
  let office: Office
  let port: number
  const sockets: WebSocket[] = []

  function connect(): Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean) => Promise<any> }> {
    return new Promise((resolve, reject) => {
      // The office page: the dev-server origin and the office token (tests/ws-auth.test.ts has the read-only side)
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, officeProtocols(office.server), { headers: { Origin: 'http://localhost:3333' } })
      const queue: any[] = []
      const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = []
      ws.on('message', raw => {
        const m = JSON.parse(raw.toString())
        const i = waiters.findIndex(w => w.pred(m))
        if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
        else queue.push(m)
      })
      const next = (pred: (m: any) => boolean) => {
        const i = queue.findIndex(pred)
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
        return new Promise<any>(res => waiters.push({ pred, resolve: res }))
      }
      ws.once('open', () => { sockets.push(ws); resolve({ ws, next }) })
      ws.once('error', reject)
    })
  }

  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
  })
  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('the snapshot carries uiToken and pendingPermissions; permission_request / permission_extended / permission_resolved are broadcast', async () => {
    const first = (await postEvent(office.server, permissionRequest())).body.permissionId
    const client = await connect()
    const snapshot = await client.next(m => m.type === 'snapshot')
    expect(snapshot.uiToken).toBe(office.server.UI_TOKEN)
    expect(snapshot.uiToken).toMatch(/^[0-9a-f]{48}$/)
    expect(snapshot.uiToken).not.toBe(office.server.AUTH_TOKEN)
    expect(snapshot.pendingPermissions).toEqual([expect.objectContaining({ id: first, toolName: 'Write', status: 'pending' })])

    const second = (await postEvent(office.server, permissionRequest({ ...BETA, promptId: 'p-b' }))).body.permissionId
    const requested = await client.next(m => m.type === 'permission_request')
    expect(requested.permission).toMatchObject({ id: second, sessionId: BETA.sessionId, project: 'beta', toolName: 'Write', summary: 'probe.txt', suggestions: SUGGESTIONS, status: 'pending' })

    await postEvent(office.server, { type: 'session_needs_you', ...BETA, promptId: 'p-b', kind: 'permission', notificationType: 'permission_prompt', message: 'Claude needs your permission' })
    const extended = await client.next(m => m.type === 'permission_extended')
    expect(extended).toEqual({ type: 'permission_extended', permissionId: second, sessionId: BETA.sessionId, deadline: expect.any(Number), timestamp: expect.any(Number) })

    // Answered from the office: permission_resolved, then the session_main that lowers the hand
    await new Promise(r => setTimeout(r, 350))
    await decide(office.server, second, 'allow')
    const resolved = await client.next(m => m.type === 'permission_resolved' && m.permissionId === second)
    expect(resolved).toEqual({ type: 'permission_resolved', permissionId: second, sessionId: BETA.sessionId, status: 'allowed', decidedBy: 'office', timestamp: expect.any(Number) })
    const mainEvent = await client.next(m => m.type === 'session_main' && m.sessionId === BETA.sessionId)
    expect(mainEvent).toMatchObject({ reason: 'permission answered from the office', main: { state: 'working' } })

    // Answered in the terminal: decidedBy terminal
    await postEvent(office.server, { type: 'session_tool_done', ...ALPHA, promptId: 'p-1', toolName: 'Write' })
    const elsewhere = await client.next(m => m.type === 'permission_resolved' && m.permissionId === first)
    expect(elsewhere).toMatchObject({ status: 'resolved_elsewhere', decidedBy: 'terminal' })

    // A fresh connection no longer lists them
    const again = await connect()
    expect((await again.next(m => m.type === 'snapshot')).pendingPermissions).toEqual([])
  })

  it('the UI token is not on GET /sessions, /permissions, /settings or /health', async () => {
    for (const path of ['/sessions', '/permissions', '/settings', '/health', '/roster']) {
      const res = await request(office.server.app).get(path)
      expect(JSON.stringify(res.body), path).not.toContain(office.server.UI_TOKEN)
    }
  })
})

describe('the answerPermissions setting and its marker file', () => {
  let office: Office
  afterEach(() => removeOffice(office))

  it('defaults to on, the marker is written 0600 at load, removed when switched off, written again when switched on; POST /settings takes the UI token', async () => {
    office = await loadOffice()
    const marker = join(office.dir, 'answer-permissions')
    expect(office.server.ANSWER_MARKER_FILE).toBe(marker)
    expect(existsSync(marker)).toBe(true)
    expect(statSync(marker).mode & 0o777).toBe(0o600)
    expect((await request(office.server.app).get('/settings')).body).toMatchObject({ answerPermissions: true, logPrompts: 'summary' })

    const ui = (token: string, body: unknown) => request(office.server.app).post('/settings').set('Authorization', `Bearer ${token}`).send(body as object)
    expect((await request(office.server.app).post('/settings').send({ answerPermissions: false })).status).toBe(401)
    expect((await ui('not-it', { answerPermissions: false })).status).toBe(401)
    expect((await ui(office.server.UI_TOKEN, { answerPermissions: 'no' })).status).toBe(400)
    expect(existsSync(marker)).toBe(true)

    const off = await ui(office.server.UI_TOKEN, { answerPermissions: false })
    expect(off.status).toBe(200)
    expect(off.body).toEqual({ ok: true, logPrompts: 'summary', answerPermissions: false })
    expect(existsSync(marker)).toBe(false)
    expect(JSON.parse(readFileSync(join(office.dir, 'settings.json'), 'utf8'))).toEqual({ logPrompts: 'summary', answerPermissions: false })

    // Off survives a restart: no marker is written at load
    const again = await loadOffice({ dir: office.dir })
    expect(again.server.settings.answerPermissions).toBe(false)
    expect(existsSync(marker)).toBe(false)
    // The UI token still changes logPrompts too (the page may change both)
    const on = await request(again.server.app).post('/settings').set('Authorization', `Bearer ${again.server.UI_TOKEN}`).send({ answerPermissions: true, logPrompts: 'off' })
    expect(on.body).toEqual({ ok: true, logPrompts: 'off', answerPermissions: true })
    expect(existsSync(marker)).toBe(true)
  })

  it('junk in settings.json leaves the default on', async () => {
    const dir = (await loadOffice()).dir
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ answerPermissions: 'yes' }))
    office = await loadOffice({ dir })
    expect(office.server.settings.answerPermissions).toBe(true)
    expect(existsSync(join(dir, 'answer-permissions'))).toBe(true)
  })
})
