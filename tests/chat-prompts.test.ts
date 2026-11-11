/**
 * chat-prompts.test.ts - `@<session> <prompt>` in the office chat queues a prompt the session's Stop hook claims.
 *
 * server/prompt-queue.js on its own (mentions, the queue, its markers), then
 * the routes: who may queue (the UI token or the office token on loopback;
 * not a token-less caller, not a proxied one), what the chat shows and keeps
 * from read-only and LAN clients, and the claim a Stop makes through POST
 * /event — delivered once, with a proof only the token holder can make.
 */

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createPromptQueue, mentionName, mentionSlug, parseMention, resolveMention, wellFormed,
  MAX_PROMPT_LEN, MAX_QUEUED_PER_SESSION, PROMPT_TTL_MS,
} from '../server/prompt-queue.js'
import { listen, loadOffice, postEvent, removeOffice, type Office } from './helpers'

// ---------------------------------------------------------------------------
// server/prompt-queue.js
// ---------------------------------------------------------------------------

describe('prompt-queue.js: mentions', () => {
  it('parseMention: a leading @name and a non-empty prompt; a trailing : or , is not part of the name', () => {
    expect(parseMention('@agent-office fix the failing test')).toEqual({ name: 'agent-office', body: 'fix the failing test' })
    expect(parseMention('  @Agent-Office:   two\nlines ')).toEqual({ name: 'agent-office', body: 'two\nlines' })
    expect(parseMention('@alpha, go')).toEqual({ name: 'alpha', body: 'go' })
    for (const no of ['@alpha', '@alpha   ', 'hi @alpha go', '@ alpha go', '/status', '', '@@alpha go']) expect(parseMention(no), no).toBeNull()
    expect(parseMention(42 as unknown as string)).toBeNull()
  })

  it('mentionName: the registry name, else the title, the project or the id start, as a slug', () => {
    expect(mentionName({ id: 'abcdef123456', registry: { name: 'Claude Office 75' }, title: 't', project: 'p' })).toBe('claude-office-75')
    expect(mentionName({ id: 'abcdef123456', title: 'Login Fix', project: 'p' })).toBe('login-fix')
    expect(mentionName({ id: 'abcdef123456', project: 'alpha' })).toBe('alpha')
    expect(mentionName({ id: 'abcdef123456' })).toBe('abcdef12')
    expect(mentionSlug('  Two  Words ')).toBe('two-words')
  })

  it('resolveMention: name or title first, then project, then a 6+ character id prefix; ended sessions never; ties are ambiguous', () => {
    const a = { id: 'aaaaaaaa-1', project: 'office', registry: { name: 'office-7f' }, state: 'active' }
    const b = { id: 'bbbbbbbb-2', project: 'office', registry: { name: 'office-a2' }, state: 'active' }
    const c = { id: 'cccccccc-3', project: 'alpha', title: 'office-7f-old', state: 'ended' }
    const all = [a, b, c]
    expect(resolveMention(all, 'office-7f')).toEqual({ session: a })
    expect(resolveMention(all, 'office')).toEqual({ ambiguous: [a, b] })
    expect(resolveMention(all, 'bbbbbb')).toEqual({ session: b })
    expect(resolveMention(all, 'bbbbb')).toBeNull()
    expect(resolveMention(all, 'alpha')).toBeNull()
    expect(resolveMention(all, 'claude')).toBeNull()
  })

  it('wellFormed: lone surrogates become U+FFFD, pairs stay', () => {
    expect(wellFormed('a\uD800b\uDC00c😀')).toBe('a�b�c😀')
  })
})

describe('prompt-queue.js: the queue and its markers', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-office-pq-')) })

  it('add / claim: first in, first out, each prompt handed out once; the marker exists exactly while something waits', () => {
    const q = createPromptQueue({ dir })
    expect(q.add('s-1', { text: 'one' })).toMatchObject({ ok: true, position: 1 })
    expect(q.add('s-1', { text: 'two' })).toMatchObject({ ok: true, position: 2 })
    expect(existsSync(join(dir, 's-1'))).toBe(true)
    expect(q.claim('s-1')).toMatchObject({ text: 'one', id: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(existsSync(join(dir, 's-1'))).toBe(true)
    expect(q.claim('s-1')).toMatchObject({ text: 'two' })
    expect(existsSync(join(dir, 's-1'))).toBe(false)
    expect(q.claim('s-1')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses an empty or oversize prompt, a full queue and a session id that is not a plain file name', () => {
    const q = createPromptQueue({ dir })
    expect(q.add('s-1', { text: '  ' })).toEqual({ ok: false, reason: 'empty' })
    expect(q.add('s-1', { text: 'x'.repeat(MAX_PROMPT_LEN + 1) })).toEqual({ ok: false, reason: 'too-long' })
    expect(q.add('s-1', { text: 'x'.repeat(MAX_PROMPT_LEN) })).toMatchObject({ ok: true })
    for (let i = 1; i < MAX_QUEUED_PER_SESSION; i++) expect(q.add('s-1', { text: `p${i}` }).ok).toBe(true)
    expect(q.add('s-1', { text: 'one too many' })).toEqual({ ok: false, reason: 'full' })
    for (const bad of ['../x', 'a/b', '.', '', 'x'.repeat(81)]) expect(q.add(bad, { text: 'hi' }), bad).toEqual({ ok: false, reason: 'bad-session' })
    expect(readdirSync(dir)).toEqual(['s-1'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('a prompt expires after the TTL (onExpire told, marker gone); drop forgets a session; clearMarkers clears leftovers', () => {
    let t = 1_000
    const expired: string[] = []
    const q = createPromptQueue({ dir, now: () => t, onExpire: (_sid: string, item: { text: string }) => expired.push(item.text) })
    q.add('s-1', { text: 'old' })
    t += PROMPT_TTL_MS - 1
    q.add('s-1', { text: 'new' })
    t += 1
    expect(q.claim('s-1')).toMatchObject({ text: 'new' })
    expect(expired).toEqual(['old'])
    expect(existsSync(join(dir, 's-1'))).toBe(false)

    q.add('s-2', { text: 'a' })
    q.add('s-2', { text: 'b' })
    expect(q.drop('s-2')).toBe(2)
    expect(existsSync(join(dir, 's-2'))).toBe(false)

    writeFileSync(join(dir, 'left-behind'), '')
    writeFileSync(join(dir, 'not.a.marker'), '')
    q.clearMarkers()
    expect(readdirSync(dir)).toEqual(['not.a.marker'])
    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

const SID = 'a1b2c3d4-0000-4000-8000-000000000001'
const SID2 = 'b1b2c3d4-0000-4000-8000-000000000002'
const ALPHA = { sessionId: SID, project: 'alpha', cwd: '/home/me/alpha' }
const NONCE = 'f'.repeat(32)

describe('POST /chat @<session>: queuing a prompt', () => {
  let office: Office
  const chat = (text: string, token?: string) => {
    const req = request(office.server.app).post('/chat')
    if (token) req.set('Authorization', `Bearer ${token}`)
    return req.send({ sender: 'Boss', text })
  }
  /** GET /chat as a token-less local process sees it. */
  const openChat = async () => JSON.stringify((await request(office.server.app).get('/chat')).body)

  beforeAll(async () => {
    office = await loadOffice()
    await postEvent(office.server, { type: 'session_started', ...ALPHA, source: 'startup' })
  })
  afterAll(() => removeOffice(office))

  it('sessions carry the name the @-autocomplete offers', async () => {
    const res = await request(office.server.app).get('/sessions')
    expect(res.body.sessions.find((s: { id: string }) => s.id === SID)).toMatchObject({ mention: 'alpha' })
  })

  it('without a token: refused (401), nothing queued, the prompt text kept out of the chat, a line says why', async () => {
    const res = await chat('@alpha delete the database')
    expect(res.status).toBe(401)
    expect(office.server.promptQueue.list(SID)).toEqual([])
    expect(existsSync(join(office.server.PROMPT_QUEUE_DIR, SID))).toBe(false)
    const text = await openChat()
    expect(text).not.toContain('delete the database')
    expect(text).toContain('Only the office page on this Mac can queue a prompt for alpha')
  })

  it('with the UI token through a proxy (a forwarding header) or a wrong token: refused', async () => {
    const proxied = await request(office.server.app).post('/chat').set('Authorization', `Bearer ${office.server.UI_TOKEN}`).set('X-Forwarded-For', '100.64.0.2').send({ sender: 'Boss', text: '@alpha via the proxy' })
    expect(proxied.status).toBe(401)
    expect((await chat('@alpha wrong token', 'nope')).status).toBe(401)
    expect(office.server.promptQueue.list(SID)).toEqual([])
  })

  it('with the UI token: queued, the marker is there, the line is a transcript row (hidden without the token), a system line says when it lands', async () => {
    const res = await chat('@alpha fix the failing test', office.server.UI_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, queued: { sessionId: SID, position: 1 } })
    expect(office.server.promptQueue.list(SID).map(p => p.text)).toEqual(['fix the failing test'])
    expect(existsSync(join(office.server.PROMPT_QUEUE_DIR, SID))).toBe(true)
    // A token-less reader (the chat watcher) never sees the prompt, only the system line
    const open = await openChat()
    expect(open).not.toContain('fix the failing test')
    expect(open).toContain('📨 Queued for alpha')
    // The token holder sees the boss's line, as a prompt row
    const full = (await request(office.server.app).get('/chat').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)).body.messages
    expect(full).toContainEqual(expect.objectContaining({ text: '@alpha fix the failing test', role: 'boss', msg_type: 'prompt' }))
  })

  it('the office token may queue too (a local script); the second waits behind the first', async () => {
    const res = await chat('@alpha then run the linter', office.server.AUTH_TOKEN)
    expect(res.body.queued.position).toBe(2)
    expect(await openChat()).toContain('#2 in line')
  })

  it('the queued row is withheld from read-only clients and the LAN', () => {
    const row = { type: 'chat_message', id: 9, sender: 'Boss', role: 'boss', text: '@alpha secret plan', msg_type: 'prompt', timestamp: 1 }
    expect(office.server.redactForReadOnly(row)).toBeNull()
    expect(office.server.redactForLan(row)).toBeNull()
  })

  it('a Stop that claims gets the oldest prompt once, with a proof over its nonce; the session is working again and the chat says so', async () => {
    const res = await postEvent(office.server, { type: 'session_turn_end', ...ALPHA, text: 'done', claim: true, nonce: NONCE })
    expect(res.status).toBe(200)
    const { prompt } = res.body
    expect(prompt).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{16}$/), text: 'fix the failing test' })
    const proof = createHmac('sha256', office.server.AUTH_TOKEN).update(`office-prompt\n${NONCE}\n${prompt.id}\n${prompt.text}`).digest('hex')
    expect(prompt.proof).toBe(proof)
    expect(office.server.sessions.get(SID)?.main?.state).toBe('working')
    expect(await openChat()).toContain('📬 alpha picked up the prompt from the chat (1 more waiting)')

    // The next Stop gets the second, then there is nothing left and the marker is gone
    const second = await postEvent(office.server, { type: 'session_turn_end', ...ALPHA, text: 'done', claim: true, nonce: NONCE, stopHookActive: true })
    expect(second.body.prompt.text).toBe('then run the linter')
    expect(existsSync(join(office.server.PROMPT_QUEUE_DIR, SID))).toBe(false)
    const third = await postEvent(office.server, { type: 'session_turn_end', ...ALPHA, text: 'done', claim: true, nonce: NONCE })
    expect(third.body).toEqual({ ok: true })
    expect(office.server.sessions.get(SID)?.main?.state).toBe('idle')
  })

  it('a Stop without claim, without a nonce, or unsigned never takes a prompt', async () => {
    await chat('@alpha wait for me', office.server.UI_TOKEN)
    expect((await postEvent(office.server, { type: 'session_turn_end', ...ALPHA, text: 'done' })).body).toEqual({ ok: true })
    expect((await postEvent(office.server, { type: 'session_turn_end', ...ALPHA, text: 'done', claim: true })).body).toEqual({ ok: true })
    expect((await postEvent(office.server, { type: 'session_turn_end', ...ALPHA, text: 'done', claim: true, nonce: NONCE }, 'wrong')).status).toBe(401)
    // claim only means something on a Stop
    expect((await postEvent(office.server, { type: 'session_prompt', ...ALPHA, text: 'hi', claim: true, nonce: NONCE })).body).toEqual({ ok: true })
    expect(office.server.promptQueue.list(SID)).toHaveLength(1)
  })

  it('the session ending drops its prompts and says so', async () => {
    await postEvent(office.server, { type: 'session_ended', ...ALPHA, reason: 'prompt_input_exit' })
    expect(office.server.promptQueue.list(SID)).toEqual([])
    expect(await openChat()).toContain('queued for alpha dropped: the session ended')
    // An ended session is no longer a mention: the line is an ordinary one
    const res = await chat('@alpha are you there', office.server.UI_TOKEN)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(await openChat()).toContain('@alpha are you there')
  })

  it('an @-mention that names no session is an ordinary chat line', async () => {
    const res = await chat('@claude what is the weather')
    expect(res.status).toBe(200)
    expect(await openChat()).toContain('@claude what is the weather')
  })

  it('ambiguous (409), not hooked (409), too long (413), full (429): nothing queued, a line says why', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: SID2, project: 'beta', cwd: '/home/me/beta', source: 'startup' })
    await postEvent(office.server, { type: 'session_started', sessionId: 'c1b2c3d4-0000-4000-8000-000000000003', project: 'beta', cwd: '/home/you/beta', source: 'startup' })
    expect((await chat('@beta go', office.server.UI_TOKEN)).status).toBe(409)
    expect(await openChat()).toContain('@beta matches 2 sessions')
    // The id prefix picks one of them
    expect((await chat('@b1b2c3d4 go', office.server.UI_TOKEN)).status).toBe(200)
    expect(office.server.promptQueue.drop(SID2)).toBe(1)

    office.server.sessions.set('d1b2c3d4-0000-4000-8000-000000000004', { id: 'd1b2c3d4-0000-4000-8000-000000000004', hooked: false, project: 'gamma', state: 'active', agentIds: new Set() } as any)
    expect((await chat('@gamma go', office.server.UI_TOKEN)).status).toBe(409)
    expect(await openChat()).toContain('gamma has no office hooks')

    expect((await chat(`@b1b2c3d4 ${'x'.repeat(MAX_PROMPT_LEN + 1)}`, office.server.UI_TOKEN)).status).toBe(413)
    for (let i = 0; i < MAX_QUEUED_PER_SESSION; i++) expect((await chat(`@b1b2c3d4 p${i}`, office.server.UI_TOKEN)).status).toBe(200)
    expect((await chat('@b1b2c3d4 one too many', office.server.UI_TOKEN)).status).toBe(429)
    expect(office.server.promptQueue.list(SID2)).toHaveLength(MAX_QUEUED_PER_SESSION)
  })

  it('/clear still needs the office token: the UI token is not enough', async () => {
    expect((await chat('/clear', office.server.UI_TOKEN)).status).toBe(401)
  })
})

describe('prompt-queue markers do not outlive the office', () => {
  it('clearMarkers (run when the server starts and stops) removes a marker an earlier run left', async () => {
    const office = await loadOffice()
    try {
      const dir = office.server.PROMPT_QUEUE_DIR
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, SID), '')
      office.server.promptQueue.clearMarkers()
      expect(existsSync(join(dir, SID))).toBe(false)
    } finally {
      removeOffice(office)
    }
  })
})

describe('end to end: the real hook claims from the real server', () => {
  let office: Office
  let port: number
  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
    // start() writes the token file; this test office only listens, so write it here
    writeFileSync(join(office.dir, 'auth-token'), office.server.AUTH_TOKEN + '\n')
  })
  afterAll(async () => {
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  /** hooks/agent-tracker.sh on a payload, against this office (spawned async: the server lives on this event loop). */
  function runHook(payload: unknown) {
    const env: Record<string, string | undefined> = { ...process.env, AGENT_OFFICE_HOME: office.dir, AGENT_OFFICE_PORT: String(port) }
    delete env.AGENT_OFFICE_EVENT_URL
    return new Promise<string>((resolve, reject) => {
      const child = spawn('bash', [join(__dirname, '..', 'hooks', 'agent-tracker.sh')], { env, stdio: ['pipe', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.setEncoding('utf8').on('data', c => { out += c })
      child.on('error', reject)
      child.on('close', () => resolve(out))
      child.stdin.end(JSON.stringify(payload))
    })
  }

  it('queued on the page, delivered once by the Stop hook as a block decision; both sides agree on the proof of non-ASCII text', async () => {
    await postEvent(office.server, { type: 'session_started', ...ALPHA, source: 'startup' })
    const text = 'fix the failing test — and say “done” 🎉'
    const queued = await request(office.server.app).post('/chat').set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ sender: 'Boss', text: `@alpha ${text}` })
    expect(queued.status).toBe(200)
    const stop = { session_id: SID, cwd: ALPHA.cwd, transcript_path: `/t/${SID}.jsonl`, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok', background_tasks: [], session_crons: [] }
    const first = JSON.parse(await runHook(stop))
    expect(first.decision).toBe('block')
    expect(first.reason.endsWith(`\n\n${text}`)).toBe(true)
    expect(office.server.sessions.get(SID)?.main?.state).toBe('working')
    // Delivered once: the marker is gone, and the next Stop ends the turn as usual
    expect(existsSync(join(office.server.PROMPT_QUEUE_DIR, SID))).toBe(false)
    expect(await runHook({ ...stop, stop_hook_active: true })).toBe('')
  })
})
