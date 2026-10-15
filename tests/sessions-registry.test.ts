/**
 * server/sessions.js — the registry roster: the sessions Claude Code's own
 * session registry (~/.claude/sessions/<pid>.json) knows about, shown before
 * (or without) the hooks. readRegistry on fixture files shaped like the real
 * ones, the status mapping, and the roster mounted in the office: unhooked
 * sessions on GET /sessions and the WebSocket, the join to hooked sessions by
 * session id, the flip to hooked on the first hook event, the own-bot
 * exclusion, and the watcher.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, postEvent, removeOffice, type Office } from './helpers'
import {
  BOT_SESSION_NAME, DEFAULT_POLL_MS, REGISTRY_STATES, REGISTRY_WAIT_SUMMARY,
  isBotSession, mainFromRegistry, mountRegistry, parseRegistryEntry, pidAlive,
  readRegistry, registryInfo, registryToSession,
} from '../server/sessions.js'

// ---------------------------------------------------------------------------
// Fixtures: the field set of a live 2.1.300 entry (nothing in it is secret
// beyond paths), with the pid and session id of the test's choosing
// ---------------------------------------------------------------------------

const SID = 'c25c5511-f321-521a-825b-f189ac4d57e8'

function entry(over: Record<string, unknown> = {}) {
  const pid = (over.pid as number) ?? process.pid
  return {
    pid,
    sessionId: SID,
    cwd: '/home/me/claude-office',
    startedAt: 1792021300048,
    procStart: '365',
    version: '2.1.300',
    peerProtocol: 1,
    peerFeatures: ['notify_idle', 'reply_across_default_dirs', 'artifact_yield'],
    kind: 'interactive',
    entrypoint: 'cli',
    pidDomain: 'linux:4c398f739c8447eb99d3fe100ad1b0fa:pid:[4026531836]',
    messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
    name: 'claude-office-75',
    nameSource: 'derived',
    nameSince: 1792021300048,
    updatedAt: 1792024878689,
    status: 'busy',
    statusUpdatedAt: 1792024878689,
    ...over,
  }
}

/** Write <pid>.json (and the <pid>.<hash>.key file that sits next to it) the way Claude Code does. */
function writeEntry(dir: string, over: Record<string, unknown> = {}) {
  const e = entry(over)
  writeFileSync(join(dir, `${e.pid}.json`), JSON.stringify(e))
  writeFileSync(join(dir, `${e.pid}.b36013db1aa298f7.key`), 'not a registry entry')
  return e
}

/** A pid that is certainly dead: a `sleep 0` that has already exited and been reaped. */
function deadPid(): number {
  const r = spawnSync('sleep', ['0'])
  if (!r.pid) throw new Error('could not spawn sleep')
  return r.pid
}

/** A process the test can kill to make a registry entry go stale. */
function liveChild(): ChildProcess {
  return spawn('sleep', ['300'], { stdio: 'ignore' })
}

function killAndReap(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = probe()
    if (v) return v
    await sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---------------------------------------------------------------------------
// readRegistry and friends
// ---------------------------------------------------------------------------

describe('readRegistry', () => {
  let dir: string
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'claude-sessions-')) })
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  it('pidAlive: this process yes, a reaped one no', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(deadPid())).toBe(false)
  })

  it('keeps the live, well-formed entries and skips the .key file, non-JSON, non-objects, entries without a pid or session id, and dead pids', () => {
    const live = writeEntry(dir, { pid: process.pid })
    const dead = writeEntry(dir, { pid: deadPid(), sessionId: 'dead-dead-dead', name: 'crashed-00' })
    writeFileSync(join(dir, '12345.json'), '{ not json')
    writeFileSync(join(dir, '12346.json'), '[1, 2, 3]')
    writeFileSync(join(dir, '12347.json'), JSON.stringify({ pid: 12347, cwd: '/x' }))           // no sessionId
    writeFileSync(join(dir, '12348.json'), JSON.stringify({ sessionId: 'no-pid' }))             // no pid
    writeFileSync(join(dir, '12349.json'), JSON.stringify({ pid: '12349', sessionId: 'str' }))  // pid must be an integer
    writeFileSync(join(dir, 'notes.txt'), 'ignored')

    const entries = readRegistry(dir)
    expect(entries).toEqual([{
      pid: process.pid,
      sessionId: SID,
      cwd: live.cwd,
      name: 'claude-office-75',
      nameSource: 'derived',
      kind: 'interactive',
      status: 'busy',
      version: '2.1.300',
      entrypoint: 'cli',
      startedAt: live.startedAt,
      updatedAt: live.updatedAt,
      statusUpdatedAt: live.statusUpdatedAt,
    }])
    // The stale file of a crashed session is still on disk; only the pid check tells
    expect(existsSync(join(dir, `${dead.pid}.json`))).toBe(true)
  })

  it('reads a file only when its mtime or size changed (the cache), and forgets removed files', async () => {
    const cache = new Map()
    const first = readRegistry(dir, { cache })
    expect(first).toHaveLength(1)
    expect(cache.get(`${process.pid}.json`)?.entry.status).toBe('busy')

    // Same file, nothing changed: the cached parse is reused
    const again = readRegistry(dir, { cache })
    expect(again[0]).toBe(first[0])

    await sleep(20)
    writeEntry(dir, { pid: process.pid, status: 'waiting', statusUpdatedAt: 1792024880000 })
    const changed = readRegistry(dir, { cache })
    expect(changed[0].status).toBe('waiting')
    expect(changed[0]).not.toBe(first[0])

    unlinkSync(join(dir, `${process.pid}.json`))
    expect(readRegistry(dir, { cache })).toEqual([])
    expect(cache.has(`${process.pid}.json`)).toBe(false)
  })

  it('a dead pid is skipped even when the file has not changed since it was alive', () => {
    const cache = new Map()
    let alive = true
    writeEntry(dir, { pid: process.pid })
    const probe = (pid: number) => pid === process.pid && alive
    expect(readRegistry(dir, { cache, alive: probe })).toHaveLength(1)
    alive = false
    expect(readRegistry(dir, { cache, alive: probe })).toEqual([])
  })

  it('two live files naming the same session keep the newer start; the list is oldest first', () => {
    writeEntry(dir, { pid: process.pid, sessionId: 'dup', startedAt: 100, name: 'older' })
    writeEntry(dir, { pid: process.ppid, sessionId: 'dup', startedAt: 200, name: 'newer' })
    const entries = readRegistry(dir)
    expect(entries.filter(e => e.sessionId === 'dup')).toEqual([expect.objectContaining({ name: 'newer', pid: process.ppid })])
    unlinkSync(join(dir, `${process.ppid}.json`))
  })

  it('a missing directory (Claude Code has never run here) is an empty registry', () => {
    expect(readRegistry(join(dir, 'does-not-exist'))).toEqual([])
  })

  it('parseRegistryEntry clamps strings and drops non-numbers', () => {
    const e = parseRegistryEntry(JSON.stringify(entry({ name: 'n'.repeat(500), cwd: `/${'c'.repeat(500)}`, startedAt: 'yesterday', status: 42 })))!
    expect(e.name).toHaveLength(200)
    expect(e.cwd).toHaveLength(400)
    expect(e.startedAt).toBeUndefined()
    expect(e.status).toBeUndefined()
    expect(parseRegistryEntry('null')).toBeNull()
    expect(parseRegistryEntry('"string"')).toBeNull()
    expect(parseRegistryEntry(JSON.stringify({ pid: 0, sessionId: 'x' }))).toBeNull()
    expect(parseRegistryEntry(JSON.stringify({ pid: 5, sessionId: '' }))).toBeNull()
  })
})

describe('registry entry -> session record', () => {
  it('maps the registry status to main.state: busy and shell are working, idle is idle, waiting is needs-you, anything else idle', () => {
    expect(REGISTRY_STATES).toEqual({ busy: 'working', shell: 'working', idle: 'idle', waiting: 'needs-you' })
    expect(mainFromRegistry(entry({ status: 'busy' }), 5)).toEqual({ state: 'working', since: 1792024878689, waitingOn: 0 })
    expect(mainFromRegistry(entry({ status: 'shell' }), 5).state).toBe('working')
    expect(mainFromRegistry(entry({ status: 'idle' }), 5).state).toBe('idle')
    expect(mainFromRegistry(entry({ status: 'waiting', statusUpdatedAt: 777 }), 5)).toEqual({
      state: 'needs-you', since: 777, waitingOn: 0,
      needsYou: { kind: 'registry', summary: REGISTRY_WAIT_SUMMARY, since: 777 },
    })
    expect(mainFromRegistry(entry({ status: 'something-new' }), 5).state).toBe('idle')
    // No timestamps at all: since is now
    expect(mainFromRegistry(entry({ status: 'busy', statusUpdatedAt: undefined, updatedAt: undefined }), 5).since).toBe(5)
  })

  it('registryToSession: an unhooked, active session named after its cwd, with presence fields only on `registry`', () => {
    const s = registryToSession(entry({ cwd: '/home/me/alpha/' }), 42)
    expect(s).toEqual({
      id: SID,
      hooked: false,
      project: 'alpha',
      cwd: '/home/me/alpha/',
      source: 'registry',
      state: 'active',
      startedAt: 1792021300048,
      lastActivityAt: 1792024878689,
      agentIds: new Set(),
      registry: {
        pid: process.pid, name: 'claude-office-75', nameSource: 'derived', status: 'busy', kind: 'interactive',
        version: '2.1.300', startedAt: 1792021300048, statusUpdatedAt: 1792024878689,
      },
      main: { state: 'working', since: 1792024878689, waitingOn: 0 },
    })
    expect(registryInfo(entry())).not.toHaveProperty('cwd')
    expect(registryInfo(entry())).not.toHaveProperty('messagingSocketPath')
    // No cwd in the entry: no project, no cwd field at all
    const bare = registryToSession({ pid: 1, sessionId: 'x' }, 42)
    expect(bare.project).toBeUndefined()
    expect(bare).not.toHaveProperty('cwd')
    expect(bare.startedAt).toBe(42)
  })

  it("isBotSession: the chat watcher's own claude -p calls are named agent-office-bot", () => {
    expect(BOT_SESSION_NAME).toBe('agent-office-bot')
    expect(isBotSession(entry({ name: BOT_SESSION_NAME, nameSource: 'user' }))).toBe(true)
    expect(isBotSession(entry())).toBe(false)
    expect(isBotSession(undefined)).toBe(false)
  })

  it('mountRegistry refuses to mount without its collaborators', () => {
    const app = express()
    expect(() => mountRegistry(app, {})).toThrow(TypeError)
    expect(() => mountRegistry(app, { sessions: new Map(), broadcast() {}, toEvent() {}, endSession() {}, forgetSession() {} })).toThrow(/registryDir/)
  })
})

// ---------------------------------------------------------------------------
// The roster mounted in the office
// ---------------------------------------------------------------------------

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const C = 'cccccccc-3333-4333-8333-333333333333'
const D = 'dddddddd-4444-4444-8444-444444444444'
const E = 'eeeeeeee-5555-4555-8555-555555555555'
const F = 'ffffffff-6666-4666-8666-666666666666'
const G = '99999999-7777-4777-8777-777777777777'
const H = '88888888-8888-4888-8888-888888888888'

describe('the registry roster in the office', () => {
  let office: Office
  let regDir: string
  let ws: WebSocket
  const messages: any[] = []
  const children: ChildProcess[] = []
  let mark = 0

  const reg = () => office.server.registry
  const session = (id: string) => office.server.sessions.get(id)
  const listed = async (id: string, token?: string) => {
    const req = request(office.server.app).get('/sessions')
    if (token) req.set('Authorization', `Bearer ${token}`)
    const res = await req
    return res.body.sessions.find((s: any) => s.id === id)
  }
  /** WS messages since the last call */
  const fresh = async () => {
    await sleep(60)
    const out = messages.slice(mark)
    mark = messages.length
    return out
  }

  beforeAll(async () => {
    regDir = mkdtempSync(join(tmpdir(), 'claude-sessions-office-'))
    office = await loadOffice({ env: { AGENT_OFFICE_REGISTRY_DIR: regDir } })
    const port = await listen(office.server.httpServer)
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())))
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    await waitFor('the snapshot', () => messages.length > 0)
    mark = messages.length
  })

  afterAll(async () => {
    reg().stop()
    ws.terminate()
    for (const child of children) await killAndReap(child)
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
    try { rmSync(regDir, { recursive: true, force: true }) } catch {}
  })

  it('is mounted against the directory the env named, idle until start()', async () => {
    expect(office.server.REGISTRY_DIR).toBe(regDir)
    expect(reg().running).toBe(false)
    expect(reg().stats()).toEqual({ dir: regDir, watching: false, count: 0, lastScanAt: null })
    const roster = await request(office.server.app).get('/registry')
    expect(roster.body).toEqual({ dir: regDir, watching: false, count: 0, lastScanAt: null, entries: [] })
    expect(office.server.sessions.size).toBe(0)
    // Health counts sessions from the same map: none yet, and no hook has ever reached the server
    expect((await request(office.server.app).get('/health')).body).toMatchObject({ sessions: 0, hooksSeen: 0 })
  })

  it('a live entry nobody has hooks for becomes an unhooked session: GET /sessions, GET /registry and a session_started { hooked: false }', async () => {
    writeEntry(regDir, { pid: process.pid, sessionId: A, cwd: '/home/me/alpha', name: 'alpha-7f', status: 'busy' })
    reg().scan()

    const rec = session(A)
    expect(rec).toMatchObject({ id: A, hooked: false, project: 'alpha', cwd: '/home/me/alpha', source: 'registry', state: 'active' })
    expect(rec.main).toEqual({ state: 'working', since: 1792024878689, waitingOn: 0 })

    const open = await listed(A)
    expect(open).toMatchObject({
      id: A, hooked: false, project: 'alpha', state: 'active', source: 'registry', agentIds: [], agentCount: 0, workingCount: 0,
      registry: { pid: process.pid, name: 'alpha-7f', nameSource: 'derived', status: 'busy', kind: 'interactive', version: '2.1.300' },
      main: { state: 'working' },
    })

    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({
      type: 'session_started', sessionId: A, hooked: false, project: 'alpha', source: 'registry',
      registry: expect.objectContaining({ name: 'alpha-7f', status: 'busy' }),
      main: expect.objectContaining({ state: 'working' }),
    })])
    expect(events[0]).not.toHaveProperty('id')

    const roster = await request(office.server.app).get('/registry')
    expect(roster.body).toMatchObject({ dir: regDir, watching: false })
    expect(roster.body.entries).toEqual([{ sessionId: A, pid: process.pid, name: 'alpha-7f', status: 'busy', kind: 'interactive', hooked: false }])
    expect(roster.body.lastScanAt).toBeTypeOf('number')
    expect(roster.body.count).toBe(1)
    // An unhooked session is a session as far as health is concerned ("1 session, 0 hooks seen" is the whole story)
    expect((await request(office.server.app).get('/health')).body).toMatchObject({ sessions: 1, hooksSeen: 0 })
  })

  it('a status change is a session_registry broadcast and moves main.state; "waiting" is needs-you', async () => {
    writeEntry(regDir, { pid: process.pid, sessionId: A, cwd: '/home/me/alpha', name: 'alpha-7f', status: 'waiting', statusUpdatedAt: 1792024890000, updatedAt: 1792024890000 })
    reg().scan()
    expect(session(A).main).toEqual({
      state: 'needs-you', since: 1792024890000, waitingOn: 0,
      needsYou: { kind: 'registry', summary: REGISTRY_WAIT_SUMMARY, since: 1792024890000 },
    })
    expect(session(A).registry.status).toBe('waiting')
    expect(session(A).lastActivityAt).toBe(1792024890000)
    let events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_registry', sessionId: A, hooked: false, registry: expect.objectContaining({ status: 'waiting' }), main: expect.objectContaining({ state: 'needs-you' }) })])

    // Nothing changed: nothing said
    reg().scan()
    expect(await fresh()).toEqual([])

    writeEntry(regDir, { pid: process.pid, sessionId: A, cwd: '/home/me/alpha', name: 'alpha-7f', status: 'idle', statusUpdatedAt: 1792024900000, updatedAt: 1792024900000 })
    reg().scan()
    expect(session(A).main).toEqual({ state: 'idle', since: 1792024900000, waitingOn: 0 })
    events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_registry', sessionId: A, main: expect.objectContaining({ state: 'idle' }) })])
  })

  it('a session with a live registry entry is never swept as stale, however quiet', async () => {
    office.server.sweepStale(Date.now() + 365 * 24 * 60 * 60_000)
    expect(session(A).state).toBe('active')
    expect(await fresh()).toEqual([])
  })

  it('an unhooked session is not persisted (the registry rebuilds it)', () => {
    office.server.processEvent({ type: 'session_started', sessionId: 'persisted', project: 'p', cwd: '/home/me/p', source: 'startup' })
    const saved = JSON.parse(readFileSync(join(office.dir, 'agents.json'), 'utf8'))
    expect(saved.sessions.map((s: any) => s.id)).toEqual(['persisted'])
    office.server.processEvent({ type: 'session_ended', sessionId: 'persisted', reason: 'other' })
  })

  it('the file going ends it: session_ended { hooked: false, reason: exited }, listed as ended, then forgotten like any session', async () => {
    await fresh()
    unlinkSync(join(regDir, `${process.pid}.json`))
    reg().scan()
    expect(session(A)).toMatchObject({ state: 'ended', reason: 'exited', hooked: false })
    expect(session(A).main.state).toBe('idle')
    expect(await listed(A)).toMatchObject({ state: 'ended', reason: 'exited', hooked: false })
    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_ended', sessionId: A, hooked: false, reason: 'exited', state: 'ended' })])
    // A second scan has nothing more to say about it
    reg().scan()
    expect(await fresh()).toEqual([])
  })

  it('an ended unhooked session that is back under a new pid (a quick --resume) starts over', async () => {
    const child = liveChild()
    children.push(child)
    writeEntry(regDir, { pid: child.pid, sessionId: A, cwd: '/home/me/alpha', name: 'alpha-7f', status: 'busy' })
    reg().scan()
    expect(session(A)).toMatchObject({ state: 'active', hooked: false, registry: { pid: child.pid, status: 'busy' } })
    expect(session(A).main.state).toBe('working')
    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_started', sessionId: A, hooked: false })])
  })

  it('the process dying ends an unhooked session even while its file remains (a crash)', async () => {
    const child = children[children.length - 1]
    await killAndReap(child)
    expect(existsSync(join(regDir, `${child.pid}.json`))).toBe(true)
    reg().scan()
    expect(session(A)).toMatchObject({ state: 'ended', reason: 'exited' })
    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_ended', sessionId: A, hooked: false })])
    unlinkSync(join(regDir, `${child.pid}.json`))
    reg().scan()
  })

  it('join: a hooked session gets `registry` attached and keeps its hook-driven main state when the registry says idle', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: B, project: 'beta', cwd: '/home/me/beta', source: 'startup', model: 'claude-haiku-5-5' })
    await postEvent(office.server, { type: 'session_prompt', sessionId: B, project: 'beta', cwd: '/home/me/beta', text: 'go' })
    expect(session(B)).toMatchObject({ hooked: true, main: { state: 'working' } })
    await fresh()

    writeEntry(regDir, { pid: process.ppid, sessionId: B, cwd: '/home/me/beta', name: 'beta-2c', status: 'idle' })
    reg().scan()
    const rec = session(B)
    expect(rec.hooked).toBe(true)
    expect(rec.source).toBe('startup')
    expect(rec.registry).toEqual({ pid: process.ppid, name: 'beta-2c', nameSource: 'derived', status: 'idle', kind: 'interactive', version: '2.1.300', startedAt: 1792021300048, statusUpdatedAt: 1792024878689 })
    expect(rec.main.state).toBe('working')                       // the hooks are the truth
    expect(rec.main.lastPrompt).toBe('go')

    const open = await listed(B)
    expect(open).toMatchObject({ hooked: true, model: 'claude-haiku-5-5', registry: { name: 'beta-2c', status: 'idle' }, main: { state: 'working' } })
    expect(open.main).not.toHaveProperty('lastPrompt')           // still token-gated
    expect((await listed(B, office.server.AUTH_TOKEN)).main.lastPrompt).toBe('go')

    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_registry', sessionId: B, hooked: true, registry: expect.objectContaining({ status: 'idle' }), main: expect.objectContaining({ state: 'working', lastPrompt: 'go' }) })])
    expect((await request(office.server.app).get('/registry')).body.entries).toEqual([expect.objectContaining({ sessionId: B, hooked: true })])

    // A registry status change on a hooked session updates `registry` only
    writeEntry(regDir, { pid: process.ppid, sessionId: B, cwd: '/home/me/beta', name: 'beta-2c', status: 'waiting', statusUpdatedAt: 1792024890000 })
    reg().scan()
    expect(session(B).registry.status).toBe('waiting')
    expect(session(B).main.state).toBe('working')
    expect(session(B).main.needsYou).toBeUndefined()
    expect(await fresh()).toEqual([expect.objectContaining({ type: 'session_registry', sessionId: B, hooked: true })])
  })

  it('a hooked session that loses its registry entry just loses `registry` and stays active', async () => {
    unlinkSync(join(regDir, `${process.ppid}.json`))
    reg().scan()
    expect(session(B)).toMatchObject({ state: 'active', hooked: true, main: { state: 'working' } })
    expect(session(B)).not.toHaveProperty('registry')
    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_registry', sessionId: B, hooked: true, state: 'active' })])
    expect(events[0]).not.toHaveProperty('registry')
    // Without a live entry the stale sweep applies again
    office.server.sweepStale(Date.now() + 365 * 24 * 60 * 60_000)
    expect(session(B).state).toBe('ended')
    await fresh()
  })

  it('the flip: an unhooked session\'s first hook event makes it hooked (same id), announced as session_started { hooked: true } before that event', async () => {
    const child = liveChild()
    children.push(child)
    writeEntry(regDir, { pid: child.pid, sessionId: C, cwd: '/home/me/gamma', name: 'gamma-01', status: 'busy' })
    reg().scan()
    expect(session(C).hooked).toBe(false)
    await fresh()

    await postEvent(office.server, { type: 'agent_working', sessionId: C, project: 'gamma', cwd: '/home/me/gamma', status: 'reading index.js' })
    const rec = session(C)
    expect(rec).toMatchObject({ id: C, hooked: true, source: 'implicit', project: 'gamma', state: 'active' })
    expect(rec.main.state).toBe('working')
    expect(rec.registry).toMatchObject({ pid: child.pid, name: 'gamma-01', status: 'busy' })   // presence stays attached
    expect(rec.lastStatus).toBe('reading index.js')
    const events = await fresh()
    expect(events.map(e => e.type)).toEqual(['session_started', 'agent_working'])
    expect(events[0]).toMatchObject({ sessionId: C, hooked: true, source: 'implicit', registry: expect.objectContaining({ name: 'gamma-01' }) })

    // From now on the registry touches `registry` only, never main
    writeEntry(regDir, { pid: child.pid, sessionId: C, cwd: '/home/me/gamma', name: 'gamma-01', status: 'idle', statusUpdatedAt: 1792024890000 })
    reg().scan()
    expect(session(C).main.state).toBe('working')
    expect(session(C).registry.status).toBe('idle')
    expect(await fresh()).toEqual([expect.objectContaining({ type: 'session_registry', sessionId: C, hooked: true })])

    // It is persisted now, as a hooked session
    const saved = JSON.parse(readFileSync(join(office.dir, 'agents.json'), 'utf8'))
    expect(saved.sessions.map((s: any) => s.id)).toContain(C)
  })

  it('the flip through SessionStart: an unhooked session whose session_started arrives takes that source and a fresh main', async () => {
    const child = liveChild()
    children.push(child)
    writeEntry(regDir, { pid: child.pid, sessionId: D, cwd: '/home/me/delta', name: 'delta-aa', status: 'waiting', statusUpdatedAt: 1792024890000 })
    reg().scan()
    expect(session(D).main.state).toBe('needs-you')
    await fresh()

    const res = await postEvent(office.server, { type: 'session_started', sessionId: D, project: 'delta', cwd: '/home/me/delta', source: 'startup', title: 'delta work' })
    expect(res.status).toBe(200)
    expect(session(D)).toMatchObject({ hooked: true, source: 'startup', title: 'delta work', main: { state: 'idle', waitingOn: 0 } })
    expect(session(D).main.needsYou).toBeUndefined()
    const events = await fresh()
    expect(events).toEqual([expect.objectContaining({ type: 'session_started', sessionId: D, hooked: true, source: 'startup', title: 'delta work' })])
  })

  it('own bot: an entry named agent-office-bot is neither a session nor listed on GET /registry', async () => {
    writeEntry(regDir, { pid: process.pid, sessionId: E, cwd: '/home/me/Claude-Office', name: BOT_SESSION_NAME, nameSource: 'user', status: 'busy' })
    reg().scan()
    expect(session(E)).toBeUndefined()
    expect((await request(office.server.app).get('/registry')).body.entries.map((e: any) => e.sessionId)).not.toContain(E)
    expect(await fresh()).toEqual([])
    unlinkSync(join(regDir, `${process.pid}.json`))
    reg().scan()
    expect(await fresh()).toEqual([])
  })

  it('a consumer can count hooked / unhooked / needs-you sessions from GET /sessions alone', async () => {
    writeEntry(regDir, { pid: process.pid, sessionId: F, cwd: '/home/me/zeta', name: 'zeta-ff', status: 'waiting' })
    reg().scan()
    await fresh()
    const { body } = await request(office.server.app).get('/sessions')
    const active = body.sessions.filter((s: any) => s.state === 'active')
    expect(active.every((s: any) => typeof s.hooked === 'boolean' && typeof s.main?.state === 'string')).toBe(true)
    expect(active.filter((s: any) => s.hooked === false).map((s: any) => s.id)).toEqual([F])
    expect(active.filter((s: any) => s.main.state === 'needs-you').map((s: any) => s.id)).toEqual([F])
    expect(active.filter((s: any) => s.hooked).map((s: any) => s.id).sort()).toEqual([C, D].sort())
    unlinkSync(join(regDir, `${process.pid}.json`))
    reg().scan()
    await fresh()
  })

  it('start() picks up a file written afterwards on its own (watch + poll) and stop() ends that', async () => {
    reg().start({ pollMs: 40 })
    expect(reg().running).toBe(true)
    expect((await request(office.server.app).get('/registry')).body.watching).toBe(true)
    const child = liveChild()
    children.push(child)
    writeEntry(regDir, { pid: child.pid, sessionId: G, cwd: '/home/me/eta', name: 'eta-11', status: 'busy' })
    await waitFor('the session to appear', () => session(G))
    expect(session(G)).toMatchObject({ hooked: false, registry: { name: 'eta-11' } })
    await waitFor('its session_started', () => messages.slice(mark).find(m => m.type === 'session_started' && m.sessionId === G))
    await fresh()

    reg().stop()
    expect(reg().running).toBe(false)
    const other = liveChild()
    children.push(other)
    writeEntry(regDir, { pid: other.pid, sessionId: H, cwd: '/home/me/theta', name: 'theta-22', status: 'busy' })
    await sleep(150)
    expect(session(H)).toBeUndefined()
    reg().start()                                      // idempotent and scans at once
    expect(session(H)).toBeDefined()
    reg().start()
    reg().stop()
    expect(DEFAULT_POLL_MS).toBe(2000)
  })
})
