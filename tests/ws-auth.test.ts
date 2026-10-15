/**
 * The WebSocket's handshake auth and the office token's life on disk.
 *
 * Any local process can open ws://127.0.0.1:<port>/ws and send any Origin it
 * likes, so the Origin check cannot keep the conversation or the UI token
 * from another local user. A connection that presents the file token (as a
 * subprotocol, the way src/officeToken.ts does) is trusted; every other one
 * still gets the office, read-only: no UI token, no prompt / reply text, no
 * permission command line, no signal output. Then the token file: reused
 * across restarts when it is still safe to trust, replaced otherwise; and
 * the startup link that carries it.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import WebSocket from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { listen, loadOffice, officeProtocols, postEvent, removeOffice, type Office } from './helpers'
import { WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX, officeWsProtocols } from '../src/officeToken'

type Message = Record<string, any>

interface Client {
  ws: WebSocket
  messages: Message[]
  /** The next message matching `pred` (buffered ones count; each is handed out once). */
  next: (pred?: (m: Message) => boolean) => Promise<Message>
}

function connect(url: string, protocols: string[] = [], headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, { headers })
    const messages: Message[] = []
    const queue: Message[] = []
    const waiters: Array<{ pred: (m: Message) => boolean; resolve: (m: Message) => void }> = []
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      messages.push(m)
      const i = waiters.findIndex(w => w.pred(m))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
      else queue.push(m)
    })
    const next = (pred: (m: Message) => boolean = () => true) => {
      const i = queue.findIndex(pred)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise<Message>(res => waiters.push({ pred, resolve: res }))
    }
    ws.once('open', () => resolve({ ws, messages, next }))
    ws.once('error', reject)
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const ALPHA = { sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', project: 'alpha', cwd: '/home/me/alpha' }
const SUGGESTIONS = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push origin:*' }], behavior: 'allow', destination: 'localSettings' }]
const PERMISSION = {
  type: 'session_needs_you', kind: 'permission', ...ALPHA, promptId: 'p-1',
  toolName: 'Bash', summary: 'git push', detail: 'git push origin main --force-with-lease',
  answerable: true, permissionMode: 'default', suggestions: SUGGESTIONS,
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe('the WebSocket handshake: trusted with the file token, read-only without', () => {
  let office: Office
  let url: string
  let permissionId: string
  const sockets: WebSocket[] = []

  const open = async (protocols: string[] = [], headers: Record<string, string> = {}) => {
    const client = await connect(url, protocols, headers)
    sockets.push(client.ws)
    return client
  }

  beforeAll(async () => {
    office = await loadOffice()
    const { server } = office
    // A session with a prompt, a reply and a pending permission dialog, and a failed test run
    server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'deploy the hotfix to prod' })
    server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'Pushed the hotfix; prod is green.' })
    permissionId = (await postEvent(server, PERMISSION)).body.permissionId
    await postEvent(server, { type: 'signal', ...ALPHA, signals: [{ kind: 'test_failed', target: 'api', detail: '3 failing', error: 'FAIL secret-name.test.ts', command: 'npm test', exitCode: 1 }] })
    url = `ws://127.0.0.1:${await listen(server.httpServer)}/ws`
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  /** What every read-only snapshot must not carry. */
  function expectReadOnlySnapshot(snapshot: Message) {
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot).not.toHaveProperty('uiToken')
    // The office itself is all there: sessions, states, counts
    const alpha = snapshot.sessions.find((s: Message) => s.id === ALPHA.sessionId)
    expect(alpha).toMatchObject({ project: 'alpha', state: 'active', main: { since: expect.any(Number), lastPromptAt: expect.any(Number), lastReplyAt: expect.any(Number) } })
    expect(alpha.main).not.toHaveProperty('lastPrompt')
    expect(alpha.main).not.toHaveProperty('lastReply')
    // The dialog: which tool, for which project — not the command line or the rules
    expect(snapshot.pendingPermissions).toEqual([expect.objectContaining({ id: permissionId, toolName: 'Bash', project: 'alpha', status: 'pending' })])
    expect(snapshot.pendingPermissions[0]).not.toHaveProperty('detail')
    expect(snapshot.pendingPermissions[0]).not.toHaveProperty('suggestions')
    // The signal: what happened, not what the command printed
    expect(snapshot.signals).toEqual([expect.objectContaining({ kind: 'test_failed', target: 'api', exitCode: 1 })])
    for (const field of ['command', 'error', 'detail']) expect(snapshot.signals[0]).not.toHaveProperty(field)
    const text = JSON.stringify(snapshot)
    for (const secret of ['deploy the hotfix', 'Pushed the hotfix', '--force-with-lease', 'git push origin:*', 'FAIL secret-name', '3 failing', office.server.UI_TOKEN, office.server.AUTH_TOKEN]) {
      expect(text, secret).not.toContain(secret)
    }
  }

  it('no token: `auth` says read-only, and the snapshot has no UI token and no conversation', async () => {
    const client = await open()
    expect(await client.next()).toEqual({ type: 'auth', trusted: false })
    expectReadOnlySnapshot(await client.next())
    // No subprotocol was offered, so none was agreed
    expect(client.ws.protocol).toBe('')
  })

  it('a wrong token, or one offered under another name, counts as none', async () => {
    const wrong = await open([WS_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${'0'.repeat(64)}`])
    expect(await wrong.next()).toEqual({ type: 'auth', trusted: false })
    expectReadOnlySnapshot(await wrong.next())
    const prefix = await open([WS_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${office.server.AUTH_TOKEN.slice(0, 63)}`])
    expect(await prefix.next()).toEqual({ type: 'auth', trusted: false })
    // The UI token is not the file token
    const ui = await open([WS_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${office.server.UI_TOKEN}`])
    expect(await ui.next()).toEqual({ type: 'auth', trusted: false })
    const bare = await open([WS_PROTOCOL, office.server.AUTH_TOKEN])
    expect(await bare.next()).toEqual({ type: 'auth', trusted: false })
  })

  it('an allowed Origin forged by a local process does not make it trusted', async () => {
    for (const origin of ['http://localhost:3333', `http://127.0.0.1:${office.server.PORT}`]) {
      const client = await open([], { Origin: origin })
      expect(await client.next()).toEqual({ type: 'auth', trusted: false })
      expectReadOnlySnapshot(await client.next())
    }
  })

  it('the file token as a subprotocol: trusted, the full snapshot with the UI token and the text; the token is not echoed', async () => {
    const client = await open(officeProtocols(office.server), { Origin: 'http://localhost:3333' })
    expect(client.ws.protocol).toBe('agent-office')
    expect(await client.next()).toEqual({ type: 'auth', trusted: true })
    const snapshot = await client.next()
    expect(snapshot.uiToken).toBe(office.server.UI_TOKEN)
    expect(snapshot.sessions.find((s: Message) => s.id === ALPHA.sessionId).main).toMatchObject({ lastPrompt: 'deploy the hotfix to prod', lastReply: 'Pushed the hotfix; prod is green.' })
    expect(snapshot.pendingPermissions[0]).toMatchObject({ detail: 'git push origin main --force-with-lease', suggestions: SUGGESTIONS })
    expect(snapshot.signals[0]).toMatchObject({ error: 'FAIL secret-name.test.ts', detail: '3 failing' })
    expect(snapshot.signals[0]).not.toHaveProperty('command')  // the page never needed it
  })

  it('the page\'s own subprotocol list (src/officeToken.ts) is what the server trusts', async () => {
    expect(officeWsProtocols(office.server.AUTH_TOKEN)).toEqual(officeProtocols(office.server))
    const client = await open(officeWsProtocols(office.server.AUTH_TOKEN))
    expect(await client.next()).toEqual({ type: 'auth', trusted: true })
    const tokenless = await open(officeWsProtocols(null))
    expect(tokenless.ws.protocol).toBe('agent-office')
    expect(await tokenless.next()).toEqual({ type: 'auth', trusted: false })
  })

  it('one broadcast, two variants: the trusted client gets the text, the read-only one the same event without it', async () => {
    const trusted = await open(officeProtocols(office.server))
    const readOnly = await open()
    for (const c of [trusted, readOnly]) await c.next(m => m.type === 'snapshot')

    // The boss's prompt and Claude's reply
    office.server.broadcast(office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'rotate the database password' }))
    const fullPrompt = await trusted.next(m => m.type === 'session_prompt')
    const roPrompt = await readOnly.next(m => m.type === 'session_prompt')
    expect(fullPrompt).toMatchObject({ text: 'rotate the database password', messageId: expect.any(Number), main: { state: 'working', lastPrompt: 'rotate the database password' } })
    expect(roPrompt).toMatchObject({ type: 'session_prompt', sessionId: ALPHA.sessionId, project: 'alpha', promptId: 'p-2', isWakeup: false, main: { state: 'working' } })
    for (const field of ['text', 'messageId']) expect(roPrompt).not.toHaveProperty(field)
    expect(roPrompt.main).not.toHaveProperty('lastPrompt')
    expect(roPrompt.main).not.toHaveProperty('lastReply')

    office.server.broadcast(office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-2', text: 'Done: the new password is in the vault.' }))
    expect(await trusted.next(m => m.type === 'session_turn_end')).toMatchObject({ text: 'Done: the new password is in the vault.' })
    const roReply = await readOnly.next(m => m.type === 'session_turn_end')
    expect(roReply).toMatchObject({ type: 'session_turn_end', main: { state: 'idle' }, backgroundTasks: [] })
    expect(roReply).not.toHaveProperty('text')
    expect(JSON.stringify(roReply)).not.toContain('vault')

    // Every other event with `main` (here a session_started) loses the text too
    office.server.broadcast(office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'resume' }))
    expect((await trusted.next(m => m.type === 'session_started')).main.lastReply).toBe('Done: the new password is in the vault.')
    const roStarted = await readOnly.next(m => m.type === 'session_started')
    expect(roStarted.main).toMatchObject({ state: 'idle' })
    expect(JSON.stringify(roStarted)).not.toContain('vault')
  })

  it('a permission_request reaches a read-only client without the command line or the suggestions; its answer is a 401', async () => {
    const trusted = await open(officeProtocols(office.server))
    const readOnly = await open()
    expect(await readOnly.next(m => m.type === 'snapshot')).not.toHaveProperty('uiToken')
    await trusted.next(m => m.type === 'snapshot')

    const id = (await postEvent(office.server, { ...PERMISSION, sessionId: 'cccccccc-3333-4333-8333-333333333333', project: 'gamma', promptId: 'p-g', detail: 'curl -H "Authorization: Bearer sk-live-123" https://api.example.com' })).body.permissionId
    expect((await trusted.next(m => m.type === 'permission_request')).permission).toMatchObject({ id, detail: expect.stringContaining('sk-live-123'), suggestions: SUGGESTIONS })
    const request_ = await readOnly.next(m => m.type === 'permission_request')
    expect(request_.permission).toMatchObject({ id, toolName: 'Bash', project: 'gamma', status: 'pending', deadline: expect.any(Number) })
    expect(request_.permission).not.toHaveProperty('detail')
    expect(request_.permission).not.toHaveProperty('suggestions')
    expect(JSON.stringify(request_)).not.toContain('sk-live-123')

    // Nothing the read-only client was sent answers it
    const res = await request(office.server.app).post(`/permission/${id}`).send({ decision: 'allow' })
    expect(res.status).toBe(401)
    expect(office.server.permissions.get(id)).toMatchObject({ status: 'pending' })
    // The resolution itself is no secret: both hear it
    await request(office.server.app).post(`/permission/${id}`).set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ decision: 'deny' })
    for (const c of [trusted, readOnly]) {
      expect(await c.next(m => m.type === 'permission_resolved' && m.permissionId === id)).toMatchObject({ status: 'denied', decidedBy: 'office' })
    }
  })

  it('a signal reaches a read-only client without error and detail (the command never travels)', async () => {
    const trusted = await open(officeProtocols(office.server))
    const readOnly = await open()
    for (const c of [trusted, readOnly]) await c.next(m => m.type === 'snapshot')
    await postEvent(office.server, { type: 'signal', ...ALPHA, signals: [{ kind: 'deploy_fail', target: 'web', branch: 'main', error: 'Error: invalid token tk_9', detail: 'exit 1 after 3 retries', command: 'DEPLOY_KEY=tk_9 vercel deploy --prod', exitCode: 1 }] })
    const full = await trusted.next(m => m.type === 'signal' && m.kind === 'deploy_fail')
    expect(full).toMatchObject({ target: 'web', branch: 'main', error: 'Error: invalid token tk_9', detail: 'exit 1 after 3 retries', exitCode: 1 })
    expect(full).not.toHaveProperty('command')
    const ro = await readOnly.next(m => m.type === 'signal' && m.kind === 'deploy_fail')
    expect(ro).toMatchObject({ type: 'signal', kind: 'deploy_fail', target: 'web', branch: 'main', exitCode: 1, sessionId: ALPHA.sessionId, project: 'alpha', at: expect.any(Number) })
    for (const field of ['command', 'error', 'detail']) expect(ro).not.toHaveProperty(field)
  })

  it('a prompt / reply chat row is withheld from read-only clients; ordinary chat lines and agent events reach both', async () => {
    const trusted = await open(officeProtocols(office.server))
    const readOnly = await open()
    for (const c of [trusted, readOnly]) await c.next(m => m.type === 'snapshot')
    office.server.broadcast({ type: 'chat_message', id: 900, sender: 'Boss', role: 'boss', text: 'the boss typed this in a terminal', msg_type: 'prompt' })
    office.server.broadcast({ type: 'chat_message', id: 901, sender: 'Claude', role: 'assistant', text: 'and Claude said this', msg_type: 'reply' })
    office.server.broadcast({ type: 'chat_message', id: 902, sender: 'Pam', role: 'default', text: 'lunch?', msg_type: null })
    office.server.broadcast(office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: { id: 'agent-ro', name: 'Tester', role: 'test-engineer', task: 'run the suite' } }))
    expect((await trusted.next(m => m.id === 900)).text).toBe('the boss typed this in a terminal')
    expect((await trusted.next(m => m.id === 901)).text).toBe('and Claude said this')
    expect((await readOnly.next(m => m.id === 902)).text).toBe('lunch?')
    expect((await readOnly.next(m => m.type === 'agent_spawned')).agent).toMatchObject({ id: 'agent-ro', task: 'run the suite' })
    await sleep(50)
    expect(readOnly.messages.some(m => m.id === 900 || m.id === 901)).toBe(false)
  })

  it('redactForReadOnly hands back the payload itself when there is nothing to strip, so broadcast reuses the one serialisation', async () => {
    const { redactForReadOnly } = office.server
    const noText = { type: 'agent_working', agentId: 'a', status: 'reading x' }
    expect(redactForReadOnly(noText)).toBe(noText)
    const mainNoText = { type: 'session_main', main: { state: 'idle' } }
    expect(redactForReadOnly(mainNoText)).toBe(mainNoText)
    expect(redactForReadOnly({ type: 'chat_message', msg_type: 'reply', text: 'x' })).toBeNull()
  })
})

describe('GET /permissions: the command line only with a token', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('lists the pending dialogs without detail and suggestions, and in full with the file token or the UI token', async () => {
    await postEvent(office.server, PERMISSION)
    const open = (await request(office.server.app).get('/permissions')).body.permissions
    expect(open).toEqual([expect.objectContaining({ toolName: 'Bash', summary: 'git push', project: 'alpha' })])
    expect(open[0]).not.toHaveProperty('detail')
    expect(open[0]).not.toHaveProperty('suggestions')
    for (const token of [office.server.AUTH_TOKEN, office.server.UI_TOKEN]) {
      const full = (await request(office.server.app).get('/permissions').set('Authorization', `Bearer ${token}`)).body.permissions
      expect(full[0]).toMatchObject({ detail: 'git push origin main --force-with-lease', suggestions: SUGGESTIONS })
    }
    const wrong = (await request(office.server.app).get('/permissions').set('Authorization', `Bearer ${'f'.repeat(64)}`)).body.permissions
    expect(wrong[0]).not.toHaveProperty('detail')
  })
})

// ---------------------------------------------------------------------------
// The token file
// ---------------------------------------------------------------------------

const TOKEN = 'c0ffee'.repeat(10) + 'beef'

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'agent-office-token-'))
}

function mode(path: string) {
  return statSync(path).mode & 0o777
}

/** start() on an ephemeral port with the banner captured; resolves once listening. */
async function started(office: Office) {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  const listening = new Promise<void>(res => office.server.httpServer.once('listening', res))
  office.server.start({ port: 0, host: '127.0.0.1' })
  await listening
  return lines
}

async function stop(office: Office) {
  await new Promise<void>(res => office.server.wss.close(() => res()))
  await new Promise<void>(res => office.server.httpServer.close(() => res()))
}

describe('the token file: reused when it is safe to trust, replaced otherwise', () => {
  const offices: Office[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    while (offices.length) {
      const office = offices.pop()!
      if (office.server.httpServer.listening) await stop(office)
      removeOffice(office)
    }
  })

  async function load(setup: (tokenFile: string, dir: string) => void, env?: Record<string, string>) {
    const dir = freshDir()
    const tokenFile = join(dir, 'auth-token')
    setup(tokenFile, dir)
    const office = await loadOffice({ dir, env })
    offices.push(office)
    return { office, tokenFile }
  }

  it('reuses a valid 0600 token file of this user, and start() leaves it as it was', async () => {
    const { office, tokenFile } = await load(file => writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 }))
    expect(office.server.AUTH_TOKEN).toBe(TOKEN)
    expect(office.server.REUSED_TOKEN).toBe(TOKEN)
    const before = statSync(tokenFile)
    const lines = await started(office)
    expect(readFileSync(tokenFile, 'utf8')).toBe(`${TOKEN}\n`)
    expect(statSync(tokenFile).ino).toBe(before.ino)
    expect(lines.join('\n')).toContain(`Auth token reused from: ${tokenFile}`)
    // ... and the hook's token keeps working
    expect((await postEvent(office.server, { type: 'session_ended', sessionId: 's', reason: 'other' }, TOKEN)).status).toBe(200)
  })

  it('a restart against the same runtime dir comes back with the same token', async () => {
    const { office: first, tokenFile } = await load(() => {})
    await started(first)
    const token = readFileSync(tokenFile, 'utf8')
    expect(token).toBe(first.server.AUTH_TOKEN)
    await stop(first)
    const second = await loadOffice({ dir: first.dir })
    offices.push(second)
    expect(second.server.AUTH_TOKEN).toBe(token)
  })

  it('generates and writes (0600, after listen) a token when the file is missing', async () => {
    const { office, tokenFile } = await load(() => {})
    expect(office.server.REUSED_TOKEN).toBeNull()
    expect(office.server.AUTH_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(tokenFile)).toBe(false)
    const lines = await started(office)
    expect(readFileSync(tokenFile, 'utf8')).toBe(office.server.AUTH_TOKEN)
    expect(mode(tokenFile)).toBe(0o600)
    expect(lines.join('\n')).toContain(`Auth token written to: ${tokenFile}`)
  })

  for (const [what, content] of [
    ['malformed', 'not-a-token'],
    ['too short', TOKEN.slice(0, 63)],
    ['upper case', TOKEN.toUpperCase()],
    ['empty', ''],
  ] as const) {
    it(`replaces a ${what} token file with a new token`, async () => {
      const { office, tokenFile } = await load(file => writeFileSync(file, content, { mode: 0o600 }))
      expect(office.server.REUSED_TOKEN).toBeNull()
      expect(office.server.AUTH_TOKEN).not.toBe(content)
      await started(office)
      expect(readFileSync(tokenFile, 'utf8')).toBe(office.server.AUTH_TOKEN)
      expect(mode(tokenFile)).toBe(0o600)
    })
  }

  for (const fileMode of [0o640, 0o604, 0o644, 0o660]) {
    it(`replaces a token file other users could read (mode ${fileMode.toString(8)})`, async () => {
      const { office, tokenFile } = await load(file => { writeFileSync(file, TOKEN); chmodSync(file, fileMode) })
      expect(office.server.AUTH_TOKEN).not.toBe(TOKEN)
      await started(office)
      expect(readFileSync(tokenFile, 'utf8')).toBe(office.server.AUTH_TOKEN)
      expect(mode(tokenFile)).toBe(0o600)
    })
  }

  it('replaces a token file owned by someone else (simulated: another uid)', async () => {
    const realUid = process.getuid!()
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(realUid + 4242)
    const { office, tokenFile } = await load(file => writeFileSync(file, TOKEN, { mode: 0o600 }))
    getuid.mockRestore()
    expect(office.server.AUTH_TOKEN).not.toBe(TOKEN)
    await started(office)
    expect(readFileSync(tokenFile, 'utf8')).toBe(office.server.AUTH_TOKEN)
  })

  it.skipIf(process.getuid?.() !== 0)('replaces a token file really owned by another user (root can chown one)', async () => {
    const { chownSync } = await import('node:fs')
    const { office, tokenFile } = await load(file => { writeFileSync(file, TOKEN, { mode: 0o600 }); chownSync(file, 4242, 4242) })
    expect(office.server.AUTH_TOKEN).not.toBe(TOKEN)
    await started(office)
    expect(readFileSync(tokenFile, 'utf8')).toBe(office.server.AUTH_TOKEN)
    expect(statSync(tokenFile).uid).toBe(0)
  })

  it('does not follow a symlink: neither reads the token through it nor writes the new one through it', async () => {
    const elsewhere = freshDir()
    const target = join(elsewhere, 'planted')
    try {
      const { office, tokenFile } = await load(file => { writeFileSync(target, TOKEN, { mode: 0o600 }); symlinkSync(target, file) })
      expect(office.server.AUTH_TOKEN).not.toBe(TOKEN)
      await started(office)
      expect(lstatSync(tokenFile).isSymbolicLink()).toBe(false)
      expect(readFileSync(tokenFile, 'utf8')).toBe(office.server.AUTH_TOKEN)
      expect(readFileSync(target, 'utf8')).toBe(TOKEN)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('a directory where the file should be is not a token either', async () => {
    const { office } = await load(file => mkdirSync(file))
    expect(office.server.REUSED_TOKEN).toBeNull()
  })
})

describe('the office link at startup', () => {
  const offices: Office[] = []
  const dirs: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    while (offices.length) {
      const office = offices.pop()!
      if (office.server.httpServer.listening) await stop(office)
      removeOffice(office)
    }
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('prints http://127.0.0.1:<port>/#token=<token> when the server serves the UI', async () => {
    const uiDir = freshDir()
    dirs.push(uiDir)
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>office</title>')
    const office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
    offices.push(office)
    const lines = await started(office)
    const port = (office.server.httpServer.address() as AddressInfo).port
    expect(lines).toContain(`  Agent Office: http://127.0.0.1:${port}/#token=${office.server.AUTH_TOKEN}`)
    expect(office.server.officeLink(`http://127.0.0.1:${port}/`)).toBe(`http://127.0.0.1:${port}/#token=${office.server.AUTH_TOKEN}`)
  })

  it('points at the Vite dev server when the UI is not built', async () => {
    const office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: join(freshDir(), 'nothing-here') } })
    offices.push(office)
    const lines = await started(office)
    expect(lines.find(l => l.includes('Agent Office: '))).toBe(`  Agent Office: http://localhost:${office.server.UI_DEV_PORT}/#token=${office.server.AUTH_TOKEN}  (the Vite dev server)`)
  })

  it('the fragment never reaches the server: a request for the link\'s page carries no token', async () => {
    // What a browser sends for http://127.0.0.1:<port>/#token=... is GET / — the fragment stays in the browser
    const office = await loadOffice()
    offices.push(office)
    const seen: string[] = []
    office.server.httpServer.on('request', req => { seen.push(req.url ?? '') })
    const port = await listen(office.server.httpServer)
    await fetch(`http://127.0.0.1:${port}/health#token=${office.server.AUTH_TOKEN}`)
    expect(seen.join(' ')).not.toContain(office.server.AUTH_TOKEN)
  })
})
