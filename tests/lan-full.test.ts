/**
 * lan-full.test.ts - Phone full mode: the HTTPS LAN listener, its phone secret, route allowlist, lockout and files.
 *
 * Full mode (AGENT_OFFICE_LAN=full, `npm run lan -- --full`) puts the whole
 * office on the Wi-Fi, so these tests hold it to the rules that make that
 * defensible:
 *
 *   - watch-only mode is untouched: every API route is still a 404 there and
 *     the phone secret opens nothing on it
 *   - full mode answers nothing over plain HTTP (no route, no WebSocket)
 *   - only the phone secret opens it: the office token, the UI token and the
 *     viewer key are wrong secrets like any other
 *   - exact Host and https Origin, secret or not
 *   - an allowlist of routes; hook ingestion, agent routes and every
 *     token-only route are a 404 even with the secret
 *   - a permission is answered from the phone end to end
 *   - the WebSocket is refused before the upgrade without the secret, and
 *     carries the trusted stream (minus the UI token) with it
 *   - wrong secrets lock an address out; phones are capped
 *   - the secret and certificate files are reused only while safe to trust
 *
 * The listener binds 127.0.0.1 here and is named as the LAN host, as in
 * tests/lan.test.ts. Why not a real LAN address: binding one makes macOS ask
 * to allow incoming connections in the middle of a test run. The one thing
 * that loses — a phone's peer address is not loopback, so the loopback app
 * treats it as a remote request — is exercised with a forwarding header,
 * which takes the same branch (isRemoteRequest).
 */

import { createHmac, X509Certificate } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import request from 'supertest'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, officeProtocols, postEvent, removeOffice, type Office, type OfficeServer } from './helpers'
import {
  readLanConfig, lanFullHostOk, lanFullOriginOk, lanHostOk, lanOriginOk, phoneSecretFrom, offersWsCredential,
  phoneSecretMatches, phoneLink, lanFullRouteAllowed, createLockout, LAN_FULL_ROUTES, PHONE_SECRET_PATTERN,
  WS_PHONE_PROTOCOL_PREFIX, WS_VIEWER_PROTOCOL_PREFIX, DEFAULT_LAN_PORT,
} from '../server/lan.js'
import { LAN_CERT_FILE, LAN_KEY_FILE } from '../server/lan-cert.js'
import { rotatePhoneSecret } from '../scripts/lan.mjs'

type Message = Record<string, any>
const quiet = { warn: () => {} }
const KEY = 'ab'.repeat(32)
const SECRET = 'SECRET'
const posix = process.platform !== 'win32'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Poll until `check` is true or `ms` has passed; resolves with the last verdict. */
async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(20)
  }
  return check()
}

// ---------------------------------------------------------------------------
// server/lan.js — the full-mode pure helpers
// ---------------------------------------------------------------------------

describe('server/lan.js: full mode is asked for explicitly', () => {
  const interfaces = { en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }

  it('readLanConfig: only AGENT_OFFICE_LAN=full is full mode; 1 / true stay watch-only with the shape they had', () => {
    expect(readLanConfig({ AGENT_OFFICE_LAN: 'full' }, { interfaces, log: quiet })).toEqual({ enabled: true, host: '192.168.1.23', port: DEFAULT_LAN_PORT, full: true })
    expect(readLanConfig({ AGENT_OFFICE_LAN: ' FULL ' }, { interfaces, log: quiet })).toMatchObject({ enabled: true, full: true })
    expect(readLanConfig({ AGENT_OFFICE_LAN: 'full', AGENT_OFFICE_LAN_PORT: '8443', AGENT_OFFICE_LAN_HOST: '10.1.2.3' }, { interfaces, log: quiet }))
      .toEqual({ enabled: true, host: '10.1.2.3', port: 8443, full: true })
    for (const flag of ['1', 'true']) {
      const config = readLanConfig({ AGENT_OFFICE_LAN: flag }, { interfaces, log: quiet })
      expect(config).toEqual({ enabled: true, host: '192.168.1.23', port: DEFAULT_LAN_PORT })
      expect(config).not.toHaveProperty('full')
    }
    // A typo of `full` gives less than was asked for, never more
    for (const flag of ['ful', 'fulll', 'full-mode', 'https', 'yes', '2', '']) {
      expect(readLanConfig({ AGENT_OFFICE_LAN: flag }, { interfaces, log: quiet }), flag).toEqual({ enabled: false })
    }
  })

  it('readLanConfig: full mode is held to the same private-address rule', () => {
    for (const bad of ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'my-mac.local', '::', '100.64.0.1']) {
      expect(readLanConfig({ AGENT_OFFICE_LAN: 'full', AGENT_OFFICE_LAN_HOST: bad }, { interfaces, log: quiet }).enabled, bad).toBe(false)
    }
    expect(readLanConfig({ AGENT_OFFICE_LAN: 'full' }, { interfaces: {}, log: quiet }).enabled).toBe(false)
    expect(readLanConfig({ AGENT_OFFICE_LAN: 'full', AGENT_OFFICE_LAN_PORT: '0' }, { interfaces, log: quiet }).enabled).toBe(false)
  })

  it('lanFullHostOk / lanFullOriginOk: exactly the LAN IP and port, https only', () => {
    expect(lanFullHostOk('192.168.1.23:3335', '192.168.1.23', 3335)).toBe(true)
    expect(lanFullHostOk('192.168.1.23', '192.168.1.23', 443)).toBe(true)
    for (const bad of ['192.168.1.23', '192.168.1.23:3334', 'evil.example:3335', 'localhost:3335', '192.168.1.23:3335.evil.example', ' 192.168.1.23:3335', '', undefined]) {
      expect(lanFullHostOk(bad, '192.168.1.23', 3335), String(bad)).toBe(false)
    }
    expect(lanFullOriginOk(undefined, '192.168.1.23', 3335)).toBe(true)
    expect(lanFullOriginOk('https://192.168.1.23:3335', '192.168.1.23', 3335)).toBe(true)
    expect(lanFullOriginOk('https://192.168.1.23', '192.168.1.23', 443)).toBe(true)
    for (const bad of ['null', 'http://192.168.1.23:3335', 'https://192.168.1.23', 'https://192.168.1.23:3336', 'https://evil.example:3335', 'https://192.168.1.23:3335/', 'HTTPS://192.168.1.23:3335', 'http://127.0.0.1:3334']) {
      expect(lanFullOriginOk(bad, '192.168.1.23', 3335), bad).toBe(false)
    }
    // The two modes share nothing: each refuses the other's scheme
    expect(lanOriginOk('https://192.168.1.23:3335', '192.168.1.23', 3335)).toBe(false)
    expect(lanHostOk('192.168.1.23', '192.168.1.23', 443)).toBe(false)
  })

  it('phoneSecretFrom / offersWsCredential / phoneSecretMatches / phoneLink', () => {
    const req = (h?: string) => ({ headers: { 'sec-websocket-protocol': h } })
    expect(phoneSecretFrom(req(`agent-office, ${WS_PHONE_PROTOCOL_PREFIX}${KEY}`))).toBe(KEY)
    expect(phoneSecretFrom(req(`agent-office, agent-office.token.${KEY}`))).toBe('')
    expect(phoneSecretFrom(req(`agent-office, ${WS_VIEWER_PROTOCOL_PREFIX}${KEY}`))).toBe('')
    expect(phoneSecretFrom(req())).toBe('')
    expect(phoneSecretFrom({ headers: {} })).toBe('')

    expect(offersWsCredential(req('agent-office'))).toBe(false)
    expect(offersWsCredential(req())).toBe(false)
    for (const kind of ['phone', 'token', 'viewer']) expect(offersWsCredential(req(`agent-office, agent-office.${kind}.${KEY}`)), kind).toBe(true)

    expect(phoneSecretMatches(KEY, KEY)).toBe(true)
    for (const wrong of [KEY.slice(1), `${KEY}0`, KEY.toUpperCase(), '', undefined, null, 42, [KEY]]) expect(phoneSecretMatches(wrong, KEY), String(wrong)).toBe(false)
    expect(phoneSecretMatches(KEY, '')).toBe(false)
    expect(PHONE_SECRET_PATTERN.test(KEY)).toBe(true)

    // The secret rides in the fragment: never in what a browser sends or logs
    const link = new URL(phoneLink('192.168.1.23', 3335, KEY))
    expect(link.href).toBe(`https://192.168.1.23:3335/#phone=${KEY}`)
    expect(link.search).toBe('')
    expect(link.pathname).toBe('/')
    expect(link.hash).toBe(`#phone=${KEY}`)
  })
})

/** The requests the office page makes (every fetch under src/), as the phone would send them. */
const PAGE_REQUESTS: Array<[string, string]> = [
  ['GET', '/config'], ['GET', '/roster'], ['GET', '/recap'], ['GET', '/settings'], ['POST', '/settings'],
  ['GET', '/chat/cron-state'], ['POST', '/chat/cron-state'], ['POST', '/chat'],
  ['GET', '/agents/toolu_01ABC'], ['GET', '/agents/main%3Aaaaaaaaa-1111-4111-8111-111111111111'], ['POST', '/permission/0123456789abcdef'],
]

/** Everything else the loopback app answers, plus the shapes someone would try to slip past the table. */
const OFF_LIST: Array<[string, string]> = [
  // Hook ingestion and the hook's long-poll
  ['POST', '/event'], ['POST', '/status'], ['GET', '/permission/0123456789abcdef'],
  // Acting as an agent, agent-to-agent
  ['POST', '/chat/reply'], ['POST', '/chat/inbox/read'], ['POST', '/chat/seen'], ['POST', '/chat/react'], ['POST', '/chat/video-mode'],
  ['POST', '/chat/typing'], ['POST', '/a2a'], ['GET', '/a2a/agents'], ['GET', '/.well-known/agent-card.json'],
  // Reads the page never makes
  ['GET', '/chat'], ['GET', '/agents'], ['GET', '/sessions'], ['GET', '/signals'], ['GET', '/tasks'], ['GET', '/registry'],
  ['GET', '/permissions'], ['GET', '/health'], ['GET', '/status'], ['GET', '/ws'], ['GET', '/'],
  // The right path with the wrong method
  ['POST', '/config'], ['POST', '/roster'], ['POST', '/recap'], ['POST', '/agents/a1'], ['PUT', '/settings'], ['DELETE', '/agents/a1'],
  ['PATCH', '/settings'], ['OPTIONS', '/chat'], ['HEAD', '/config'], ['get', '/config'],
  // Near misses: case, trailing slash, extra or empty segments, encodings
  ['GET', '/CONFIG'], ['GET', '/config/'], ['GET', '/config/x'], ['GET', '//config'], ['GET', '/%63onfig'], ['GET', '/config%2f'],
  ['GET', '/agents/'], ['GET', '/agents/a/b'], ['POST', '/permission/'], ['POST', '/permission/a/b'], ['POST', '/chat/'],
  ['POST', '/chat/cron-state/x'], ['GET', `/agents/${'a'.repeat(201)}`], ['GET', '/settings.json'], ['GET', 'config'], ['GET', ''],
]

describe('server/lan.js: LAN_FULL_ROUTES is an allowlist', () => {
  it('allows what the page calls and nothing in the off-list', () => {
    for (const [method, path] of PAGE_REQUESTS) expect(lanFullRouteAllowed(method, path), `${method} ${path}`).toBe(true)
    for (const [method, path] of OFF_LIST) expect(lanFullRouteAllowed(method, path), `${method} ${path}`).toBe(false)
    expect(lanFullRouteAllowed(undefined as any, '/config')).toBe(false)
    expect(lanFullRouteAllowed('GET', undefined as any)).toBe(false)
    // Frozen: nothing adds a route at run time
    expect(Object.isFrozen(LAN_FULL_ROUTES)).toBe(true)
    expect(LAN_FULL_ROUTES).toHaveLength(10)
  })

  it('no route the server guards with the office token is on it', () => {
    // Every `app.<method>('<path>', requireToken...` in the server sources
    const guarded: Array<[string, string]> = []
    for (const file of ['index.js', 'permissions.js', 'status.js', 'tasks.js', 'sessions.js', 'health.js']) {
      const src = readFileSync(join(__dirname, '..', 'server', file), 'utf8')
      for (const m of src.matchAll(/app\.(get|post|put|delete|patch)\('([^']+)',\s*requireToken(?:Rpc)?\b/g)) {
        guarded.push([m[1].toUpperCase(), m[2].replace(/:[a-zA-Z]+/g, 'x1')])
      }
    }
    // The scan finds them (a renamed middleware would otherwise pass this test silently)
    expect(guarded.map(g => g.join(' '))).toEqual(expect.arrayContaining(['POST /event', 'POST /status', 'GET /permission/x1', 'POST /chat/reply', 'POST /a2a']))
    for (const [method, path] of guarded) expect(lanFullRouteAllowed(method, path), `${method} ${path}`).toBe(false)
  })

  it('every path the page fetches is on it (a new fetch must be listed, with its reason, before a phone can use it)', () => {
    const paths = new Set<string>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.tsx?$/.test(entry.name)) continue
        const src = readFileSync(full, 'utf8')
        // `${officeHttpBase()}/x`, `${base}/x` and the constants built from them
        for (const m of src.matchAll(/\$\{(?:officeHttpBase\(\)|base)\}(\/[a-z/-]*)/g)) paths.add(m[1])
        // postWithUiToken('/settings', ...) and its template twin
        for (const m of src.matchAll(/postWithUiToken\([`'](\/[a-z/-]*)/g)) paths.add(m[1])
      }
    }
    walk(join(__dirname, '..', 'src'))
    expect([...paths].sort()).toEqual(['/agents/', '/chat', '/chat/cron-state', '/config', '/permission/', '/recap', '/roster', '/settings'])
    for (const path of paths) {
      const probe = path.endsWith('/') ? `${path}some-id` : path
      expect(LAN_FULL_ROUTES.some(([, pattern]) => (pattern as RegExp).test(probe)), probe).toBe(true)
    }
  })
})

describe('server/lan.js: createLockout', () => {
  it('locks an address after maxFailures inside the window, for lockMs, then lets it back', () => {
    let t = 1_000_000
    const lock = createLockout({ maxFailures: 3, windowMs: 1000, lockMs: 5000, now: () => t })
    expect(lock.blockedFor('a')).toBe(0)
    expect(lock.fail('a')).toBe(false)
    expect(lock.fail('a')).toBe(false)
    expect(lock.blockedFor('a')).toBe(0)
    expect(lock.fail('a')).toBe(true)
    expect(lock.blockedFor('a')).toBe(5000)
    // Another address is not touched
    expect(lock.blockedFor('b')).toBe(0)
    // Attempts while locked neither extend the lock nor count
    t += 4000
    expect(lock.fail('a')).toBe(false)
    expect(lock.blockedFor('a')).toBe(1000)
    t += 1000
    expect(lock.blockedFor('a')).toBe(0)
    // The count started again from nothing
    expect(lock.fail('a')).toBe(false)
    expect(lock.fail('a')).toBe(false)
    expect(lock.blockedFor('a')).toBe(0)
  })

  it('failures older than the window do not count; a good secret forgets the address', () => {
    let t = 0
    const lock = createLockout({ maxFailures: 3, windowMs: 1000, lockMs: 5000, now: () => t })
    lock.fail('a'); t += 600
    lock.fail('a'); t += 600
    // The first is 1200 ms old: two inside the window, no lock
    expect(lock.fail('a')).toBe(false)
    expect(lock.blockedFor('a')).toBe(0)
    lock.ok('a')
    expect(lock.size()).toBe(0)
    expect(lock.fail('a')).toBe(false)
    expect(lock.fail('a')).toBe(false)
    expect(lock.fail('a')).toBe(true)
  })

  it('stays bounded: stale entries are swept, and when every entry is live the oldest goes', () => {
    let t = 0
    const lock = createLockout({ maxFailures: 3, windowMs: 1000, lockMs: 5000, maxEntries: 3, now: () => t })
    lock.fail('a'); lock.fail('b'); lock.fail('c')
    expect(lock.size()).toBe(3)
    t += 2000
    // a, b and c are stale now: a fourth address sweeps them out
    lock.fail('d')
    expect(lock.size()).toBe(1)
    lock.fail('e'); lock.fail('f')
    lock.fail('g')
    expect(lock.size()).toBe(3)
    // The defaults: 20 wrong secrets in a minute, a minute's lock
    const real = createLockout({ now: () => t })
    for (let i = 0; i < 19; i++) expect(real.fail('x')).toBe(false)
    expect(real.fail('x')).toBe(true)
    expect(real.blockedFor('x')).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// The listeners, end to end (bound on 127.0.0.1 here and named as the LAN host)
// ---------------------------------------------------------------------------

const INDEX_HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>'

interface Client { ws: WebSocket; messages: Message[] }
interface WsOutcome { client?: Client; status?: number; retryAfter?: string; code?: number; error?: string }

/**
 * Open a WebSocket and collect its messages. Resolves with the client on
 * open, with the HTTP status when the handshake is refused before the
 * upgrade (full mode), with the close code when it is accepted and closed
 * (watch-only), or with the error when no handshake happened at all.
 * @param ca the certificate to trust (a wss:// URL), as a strict client would
 */
function openWs(url: string, protocols: string[], { ca, headers = {} }: { ca?: string; headers?: Record<string, string> } = {}): Promise<WsOutcome> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, protocols, { ca, headers })
    const messages: Message[] = []
    let opened = false
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())))
    ws.on('open', () => {
      opened = true
      // A watch-only refusal is accepted and closed at once: give the close a moment to land
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN ? { client: { ws, messages } } : {}), 100)
    })
    ws.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode, retryAfter: res.headers['retry-after'] as string | undefined })
      // With a listener here ws leaves the request to us: drop it
      ws.terminate()
    })
    ws.on('close', (code, reason) => resolve({ code, error: reason.toString() }))
    ws.on('error', err => { if (!opened) resolve({ error: err.message }) })
  })
}

/** Write raw bytes to a TCP port and collect whatever comes back until the peer hangs up. */
function rawBytes(port: number, payload: string): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(payload))
    const done = () => resolve(Buffer.concat(chunks).toString('latin1'))
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('close', done)
    socket.on('error', done)
    socket.setTimeout(3000, () => socket.destroy())
  })
}

/** A built UI in a temp dir: index.html, one sprite, and a dotfile that must never be served. */
function makeUiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-lanfull-ui-'))
  mkdirSync(join(dir, 'sprites'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), INDEX_HTML)
  writeFileSync(join(dir, 'sprites', 'a.png'), 'png')
  writeFileSync(join(dir, '.env'), `${SECRET}=1`)
  return dir
}

const phoneProtocols = (secret: string) => ['agent-office', `${WS_PHONE_PROTOCOL_PREFIX}${secret}`]
const viewerProtocols = (key: string) => ['agent-office', `${WS_VIEWER_PROTOCOL_PREFIX}${key}`]

interface FullLan { host: string; port: number; full: true; secret: string; link: string; fingerprint: string; certReused: boolean; certReason: string | null }
const startFull = (server: OfficeServer): Promise<FullLan> => server.startLan({ host: '127.0.0.1', port: 0, full: true }) as Promise<FullLan>

const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const ALPHA = { sessionId: SID, project: 'alpha', cwd: '/home/me/alpha', transcriptPath: `/root/.claude/projects/-home-me-alpha/${SID}.jsonl` }
/** The fixed nonce the permission request carries, so the server's proof is reproducible here. */
const NONCE = 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4'

describe('watch-only mode after full mode has run in the same office: nothing changed', () => {
  let office: Office
  let uiDir: string
  let secret: string
  let lan: { host: string; port: number; key: string; link: string }
  let base: string

  beforeAll(async () => {
    uiDir = makeUiDir()
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
    // Full mode first, so a phone secret (and a certificate) exist on disk
    const full = await startFull(office.server)
    secret = full.secret
    office.server.stopLan()
    lan = await office.server.startLan({ host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${lan.port}`
  })

  afterAll(() => {
    office.server.stopLan()
    removeOffice(office)
    rmSync(uiDir, { recursive: true, force: true })
  })

  it('is plain HTTP with the viewer link, and its key is not the phone secret', async () => {
    expect(lan).not.toHaveProperty('full')
    expect(lan).not.toHaveProperty('secret')
    expect(lan.link).toBe(`http://127.0.0.1:${lan.port}/#viewer=${lan.key}`)
    expect(lan.key).not.toBe(secret)
    expect((await request(base).get('/')).text).toBe(INDEX_HTML)
  })

  it('still answers every API route 404, also with the phone secret', async () => {
    const bearer = `Bearer ${secret}`
    for (const [method, path] of [...PAGE_REQUESTS, ...OFF_LIST]) {
      // The static files are the one thing this listener serves
      if (path === '/' || path === '' || !path.startsWith('/') || method === 'get') continue
      const call = (request(base) as any)[method.toLowerCase()](path).set('Authorization', bearer)
      const res = await (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? call : call.set('Content-Type', 'application/json').send('{"sender":"x","text":"hi","type":"agent_spawned"}'))
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(office.server.activeAgents.size).toBe(0)
    expect(JSON.stringify((await request(office.server.app).get('/chat')).body)).not.toContain('"hi"')
  })

  it('refuses the phone secret on its WebSocket (1008), as a subprotocol of either kind', async () => {
    const wsUrl = `ws://127.0.0.1:${lan.port}/ws`
    expect((await openWs(wsUrl, phoneProtocols(secret))).code).toBe(1008)
    expect((await openWs(wsUrl, viewerProtocols(secret))).code).toBe(1008)
    expect((await openWs(wsUrl, officeProtocols(office.server, secret))).code).toBe(1008)
  })

  it('does not speak TLS: an https client gets nowhere', async () => {
    await expect(request(`https://127.0.0.1:${lan.port}`).get('/').disableTLSCerts()).rejects.toThrow()
  })
})

describe('the full-mode listener', () => {
  let office: Office
  let uiDir: string
  let viewerKey: string
  let lan: FullLan
  let base: string
  let wsUrl: string
  let loopbackUrl: string
  let ca: string
  const sockets: WebSocket[] = []
  const origin = () => `https://127.0.0.1:${lan.port}`
  const bearer = (value: string) => `Bearer ${value}`
  /** An HTTPS request as a strict client makes it: only this office's certificate is trusted. */
  const phone = (method: 'get' | 'post' | 'head' | 'put' | 'delete' | 'patch' | 'options', path: string, credential: string | null = lan.secret) => {
    const req = request(base)[method](path).ca(ca)
    return credential === null ? req : req.set('Authorization', bearer(credential))
  }
  const chatText = async () => JSON.stringify((await request(office.server.app).get('/chat')).body)

  beforeAll(async () => {
    uiDir = makeUiDir()
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
    loopbackUrl = `ws://127.0.0.1:${await listen(office.server.httpServer)}/ws`
    // Watch-only first, so a viewer key exists to be refused
    viewerKey = (await office.server.startLan({ host: '127.0.0.1', port: 0 })).key
    office.server.stopLan()
    lan = await startFull(office.server)
    base = `https://127.0.0.1:${lan.port}`
    wsUrl = `wss://127.0.0.1:${lan.port}/ws`
    ca = readFileSync(join(office.dir, LAN_CERT_FILE), 'utf8')
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    office.server.stopLan()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
    rmSync(uiDir, { recursive: true, force: true })
  })

  it('the phone secret: 64 hex digits in a 0600 file, a third secret, carried in the link\'s fragment', () => {
    expect(lan.full).toBe(true)
    expect(lan.secret).toMatch(/^[0-9a-f]{64}$/)
    for (const other of [office.server.AUTH_TOKEN, office.server.UI_TOKEN, viewerKey]) expect(lan.secret).not.toBe(other)
    expect(office.server.PHONE_SECRET_FILE).toBe(join(office.dir, 'lan-phone-secret'))
    expect(readFileSync(office.server.PHONE_SECRET_FILE, 'utf8')).toBe(lan.secret)
    if (posix) expect(statSync(office.server.PHONE_SECRET_FILE).mode & 0o777).toBe(0o600)
    expect(lan.link).toBe(`https://127.0.0.1:${lan.port}/#phone=${lan.secret}`)
    expect(new URL(lan.link).search).toBe('')
    // The viewer key file is left alone
    expect(readFileSync(office.server.VIEWER_KEY_FILE, 'utf8')).toBe(viewerKey)
  })

  it('the certificate: made here for this address, key 0600, and the printed fingerprint is its SHA-256', () => {
    const x = new X509Certificate(ca)
    expect(x.subjectAltName).toBe('IP Address:127.0.0.1')
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(lan.fingerprint).toBe(x.fingerprint256)
    expect(lan.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(lan.certReused).toBe(false)
    expect(lan.certReason).toBe('none stored')
    if (posix) {
      expect(statSync(join(office.dir, LAN_KEY_FILE)).mode & 0o777).toBe(0o600)
      expect(statSync(join(office.dir, LAN_CERT_FILE)).mode & 0o777).toBe(0o600)
    }
  })

  it('a real TLS handshake: a client that trusts only this certificate is authorised; one that does not is refused', async () => {
    const strict = await new Promise<{ authorized: boolean; protocol: string | null; peer: string }>((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port: lan.port, ca }, () => {
        resolve({ authorized: socket.authorized, protocol: socket.getProtocol(), peer: socket.getPeerX509Certificate()!.fingerprint256 })
        socket.end()
      })
      socket.on('error', reject)
    })
    expect(strict.authorized).toBe(true)
    expect(['TLSv1.2', 'TLSv1.3']).toContain(strict.protocol)
    // What the phone shows on its warning is what the banner printed
    expect(strict.peer).toBe(lan.fingerprint)

    // No trust in it (a client with the usual CA list): the handshake is refused client-side
    const untrusting = await new Promise<string>(resolve => {
      const socket = tls.connect({ host: '127.0.0.1', port: lan.port }, () => { resolve('connected'); socket.end() })
      socket.on('error', err => resolve((err as NodeJS.ErrnoException).code ?? err.message))
    })
    expect(untrusting).toBe('DEPTH_ZERO_SELF_SIGNED_CERT')
  })

  it('nothing answers over plain HTTP: no route, no WebSocket, even with the phone secret', async () => {
    await expect(request(`http://127.0.0.1:${lan.port}`).get('/config').set('Authorization', bearer(lan.secret))).rejects.toThrow()
    await expect(request(`http://127.0.0.1:${lan.port}`).get('/')).rejects.toThrow()

    const body = JSON.stringify({ sender: 'x', text: 'a plain http line' })
    const reply = await rawBytes(lan.port, [
      'POST /chat HTTP/1.1', `Host: 127.0.0.1:${lan.port}`, `Authorization: Bearer ${lan.secret}`,
      'Content-Type: application/json', `Content-Length: ${body.length}`, '', body,
    ].join('\r\n'))
    // At most a TLS alert comes back: never an HTTP response
    expect(reply).not.toMatch(/HTTP\/1\.[01]/)
    expect(reply).not.toContain('{')

    const plainWs = await openWs(`ws://127.0.0.1:${lan.port}/ws`, phoneProtocols(lan.secret))
    expect(plainWs.client).toBeUndefined()
    expect(plainWs.status).toBeUndefined()
    expect(plainWs.error).toBeTruthy()
    expect(await chatText()).not.toContain('a plain http line')
  })

  it('serves the built UI without the secret (the page loads, then reads its fragment); dotfiles and traversal stay out', async () => {
    const page = await phone('get', '/', null)
    expect(page.status).toBe(200)
    expect(page.text).toBe(INDEX_HTML)
    expect(page.headers['x-content-type-options']).toBe('nosniff')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    expect((await phone('get', '/sprites/a.png', null)).status).toBe(200)
    expect((await phone('head', '/index.html', null)).status).toBe(200)
    expect((await phone('get', '/', null).set('Origin', origin())).status).toBe(200)
    for (const path of ['/.env', '/../package.json', '/sprites/../.env']) {
      const anon = await phone('get', path, null)
      expect(anon.status, path).toBe(401)
      expect(anon.text).not.toContain(SECRET)
      const held = await phone('get', path)
      expect(held.status, path).toBe(404)
      expect(held.text).not.toContain(SECRET)
    }
  })

  it('without the phone secret every route is a 401: no secret, a wrong one, the office token, the UI token, the viewer key', async () => {
    const wrong: Array<[string, string | null]> = [
      ['no secret', null], ['a wrong secret', '0'.repeat(64)], ['a truncated secret', lan.secret.slice(0, 63)], ['the secret in upper case', lan.secret.toUpperCase()],
      ['the office token', office.server.AUTH_TOKEN], ['the UI token', office.server.UI_TOKEN], ['the viewer key', viewerKey],
    ]
    for (const [label, credential] of wrong) {
      for (const path of ['/config', '/settings', '/agents/a1', '/health', '/nope']) {
        expect((await phone('get', path, credential)).status, `${label}: GET ${path}`).toBe(401)
      }
      const line = await phone('post', '/chat', credential).send({ sender: 'x', text: `refused line (${label})` })
      expect(line.status, `${label}: POST /chat`).toBe(401)
      expect(line.body.error).toMatch(/phone secret/)
      expect((await phone('post', '/event', credential).send({ type: 'agent_spawned', agent: { id: 'toolu_x', name: 'X', role: 'debugger' } })).status, `${label}: POST /event`).toBe(401)
      expect((await phone('post', '/settings', credential).send({ answerPermissions: false })).status, `${label}: POST /settings`).toBe(401)
      // Why a good request between the batches: twenty wrong secrets in a row
      // lock this address out (the lockout has its own tests below)
      expect((await phone('get', '/config')).status).toBe(200)
    }
    // A secret in the query string or the body is not a secret
    expect((await phone('get', `/config?phone=${lan.secret}&token=${lan.secret}`, null)).status).toBe(401)
    expect((await phone('post', '/chat', null).send({ sender: 'x', text: 'refused line (body)', phone: lan.secret })).status).toBe(401)
    // ...and nothing reached the office
    expect(office.server.activeAgents.size).toBe(0)
    expect(office.server.settings.answerPermissions).toBe(true)
    expect(await chatText()).not.toContain('refused line')
  })

  it('with the secret the allowlisted routes work, each as the office page uses it', async () => {
    const config = await phone('get', '/config')
    expect(config.status).toBe(200)
    expect(config.body).toMatchObject({ boss: expect.any(Object), version: expect.any(String) })
    // Answers carry the conversation: never into a cache on the phone
    expect(config.headers['cache-control']).toBe('no-store')

    const roster = await phone('get', '/roster')
    expect(roster.status).toBe(200)
    expect(Array.isArray(roster.body.mcpServers)).toBe(true)

    const recap = await phone('get', '/recap')
    expect(recap.status).toBe(200)
    expect(recap.body.today).toBe(true)
    expect((await phone('get', '/recap?date=nope')).status).toBe(400)

    const settings = await phone('get', '/settings')
    expect(settings.status).toBe(200)
    expect(settings.body).toMatchObject({ answerPermissions: true, notifyPermissions: true, logPrompts: 'summary' })
    const changed = await phone('post', '/settings').set('Origin', origin()).send({ notifyPermissions: false })
    expect(changed.status).toBe(200)
    expect(changed.body).toMatchObject({ ok: true, notifyPermissions: false })
    expect(office.server.settings.notifyPermissions).toBe(false)
    expect((await phone('post', '/settings').send({ notifyPermissions: 'no' })).status).toBe(400)
    expect((await phone('post', '/settings').send({ notifyPermissions: true })).status).toBe(200)

    expect((await phone('get', '/chat/cron-state')).body).toMatchObject({ paused: false })
    expect((await phone('post', '/chat/cron-state').send({ paused: true })).body).toEqual({ ok: true, paused: true })
    expect((await phone('get', '/chat/cron-state')).body).toMatchObject({ paused: true })
    expect((await phone('post', '/chat/cron-state').send({ paused: false })).body).toEqual({ ok: true, paused: false })

    const line = await phone('post', '/chat').set('Origin', origin()).send({ sender: 'Boss', text: 'hello from the phone' })
    expect(line.status).toBe(200)
    expect(line.body).toEqual({ ok: true })
    expect(await chatText()).toContain('hello from the phone')
    expect((await phone('post', '/chat').send({ sender: 'Boss' })).status).toBe(400)

    office.server.processEvent({ type: 'agent_spawned', sessionId: SID, agent: { id: 'toolu_inspect', name: 'Dev', role: 'frontend-developer', task: 'look at me' } })
    const card = await phone('get', '/agents/toolu_inspect')
    expect(card.status).toBe(200)
    expect(card.body).toMatchObject({ id: 'toolu_inspect', name: 'Dev' })
    expect(card.headers['cache-control']).toBe('no-store')
    const missing = await phone('get', '/agents/toolu_nobody')
    expect(missing.status).toBe(404)
    expect(missing.body).toEqual({ error: 'Unknown agent' })
    office.server.processEvent({ type: 'agent_completed', sessionId: SID, agentId: 'toolu_inspect', result: 'done' })
  })

  it('with the secret everything off the allowlist is a 404, and nothing reaches the office', async () => {
    const before = office.server.activeAgents.size
    for (const [method, path] of OFF_LIST) {
      // The UI's own files, and shapes an HTTP client cannot send
      if (path === '/' || !path.startsWith('/') || method === 'get') continue
      const verb = method.toLowerCase() as 'get'
      const call = phone(verb, path)
      const res = await (method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
        ? call
        : call.send({ type: 'agent_spawned', agent: { id: 'toolu_lan', name: 'Lan', role: 'debugger' }, sender: 'Dev', text: 'an off-list line', enabled: true }))
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(office.server.activeAgents.size).toBe(before)
    expect(await chatText()).not.toContain('an off-list line')
    // The hook's long-poll for a real pending permission is a 404 here too: only the local hook asks
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup', title: 'login fix' })
    const pending = await postEvent(office.server, { type: 'session_needs_you', kind: 'permission', ...ALPHA, promptId: 'p-0', toolName: 'Bash', summary: 'ls', detail: 'ls -la', answerable: true, nonce: NONCE })
    expect((await phone('get', `/permission/${pending.body.permissionId}?wait=0`)).status).toBe(404)
    office.server.permissions.resolveSession(SID, '')
  })

  it('/clear typed on the phone is refused: the phone acts as the page, never as the office token', async () => {
    const res = await phone('post', '/chat').send({ sender: 'Boss', text: '/clear' })
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/office auth token/)
    // The history is still there
    expect(await chatText()).toContain('hello from the phone')
    // ...also when the phone sends the office token's proof-of-possession headers
    const signed = await phone('post', '/chat').set('X-Office-Timestamp', String(Date.now())).set('X-Office-Signature', 'a'.repeat(64)).send({ sender: 'Boss', text: '/clear' })
    expect(signed.status).toBe(401)
    expect(await chatText()).toContain('hello from the phone')
  })

  it('an @-mention typed on the phone queues nothing: queuing a prompt is the Mac page\'s alone', async () => {
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    const res = await phone('post', '/chat').send({ sender: 'Boss', text: '@alpha run the deploy from the phone' })
    expect(res.status).toBe(401)
    expect(office.server.promptQueue.list(SID)).toEqual([])
    // The prompt text is not stored as a chat line either; the refusal is
    expect(await chatText()).not.toContain('run the deploy from the phone')
    expect(await chatText()).toContain('Only the office page on this Mac')
  })

  it('refuses any other Host (421) or Origin (403), with the secret and for the static files alike', async () => {
    for (const host of [`evil.example:${lan.port}`, '127.0.0.1', `127.0.0.1:${lan.port + 1}`, `localhost:${lan.port}`]) {
      // Why disableTLSCerts: Node names the certificate check after the Host
      // header, so a strict client would stop itself before the server could refuse
      expect((await request(base).get('/config').disableTLSCerts().set('Host', host).set('Authorization', bearer(lan.secret))).status, host).toBe(421)
      expect((await request(base).get('/').disableTLSCerts().set('Host', host)).status, host).toBe(421)
    }
    for (const bad of ['null', 'https://evil.example', `http://127.0.0.1:${lan.port}`, `https://localhost:${lan.port}`, `https://127.0.0.1:${lan.port + 1}`, 'http://127.0.0.1:3334', 'http://localhost:3333']) {
      expect((await phone('get', '/config').set('Origin', bad)).status, bad).toBe(403)
      expect((await phone('post', '/chat').set('Origin', bad).send({ sender: 'x', text: 'a cross-origin line' })).status, bad).toBe(403)
      expect((await phone('get', '/', null).set('Origin', bad)).status, bad).toBe(403)
    }
    expect(await chatText()).not.toContain('a cross-origin line')
    // No CORS grant on anything: the page is same-origin
    const ok = await phone('get', '/config').set('Origin', origin())
    expect(ok.status).toBe(200)
    expect(ok.headers).not.toHaveProperty('access-control-allow-origin')
  })

  it('a request the loopback app sees as remote (what a real phone is) passes with the secret and only with it', async () => {
    // Here the peer is 127.0.0.1; a forwarding header takes the branch a phone's own address takes
    const probe = { headers: { host: `127.0.0.1:${lan.port}`, 'x-forwarded-for': '192.168.1.50' }, socket: { remoteAddress: '127.0.0.1' } }
    expect(office.server.isRemoteRequest(probe as any)).toBe(true)
    const remote = (method: 'get' | 'post', path: string, credential: string | null = lan.secret) => phone(method, path, credential).set('X-Forwarded-For', '192.168.1.50')
    expect((await remote('get', '/config')).status).toBe(200)
    expect((await remote('get', '/settings')).status).toBe(200)
    expect((await remote('post', '/chat').send({ sender: 'Boss', text: 'a line from a remote peer' })).status).toBe(200)
    expect((await remote('post', '/settings').send({ notifyPermissions: true })).status).toBe(200)
    expect(await chatText()).toContain('a line from a remote peer')
    expect((await remote('get', '/config', null)).status).toBe(401)
    expect((await remote('get', '/config', office.server.AUTH_TOKEN)).status).toBe(401)
    // Tailscale Funnel's mark is refused by the loopback app as ever
    expect((await phone('get', '/config').set('Tailscale-Funnel-Request', '?1')).status).toBe(403)
  })

  it('the WebSocket is refused before the upgrade without the phone secret: 401, never an open socket', async () => {
    const refused: Array<[string, string[]]> = [
      ['nothing offered', ['agent-office']],
      ['a wrong secret', phoneProtocols('0'.repeat(64))],
      ['a truncated secret', phoneProtocols(lan.secret.slice(0, 63))],
      ['the office token', officeProtocols(office.server)],
      ['the office token as a phone secret', phoneProtocols(office.server.AUTH_TOKEN)],
      ['the UI token', phoneProtocols(office.server.UI_TOKEN)],
      ['the viewer key', viewerProtocols(viewerKey)],
      ['the viewer key as a phone secret', phoneProtocols(viewerKey)],
      ['the phone secret as an office token', officeProtocols(office.server, lan.secret)],
      ['the phone secret as a viewer key', viewerProtocols(lan.secret)],
    ]
    for (const [label, protocols] of refused) {
      const res = await openWs(wsUrl, protocols, { ca })
      expect(res.client, label).toBeUndefined()
      expect(res.status, label).toBe(401)
    }
    // Reset the wrong-secret count (see the lockout tests)
    expect((await phone('get', '/config')).status).toBe(200)
  })

  it('the WebSocket with the secret: wrong Host 421, wrong Origin 403, wrong path 404', async () => {
    expect((await openWs(wsUrl, phoneProtocols(lan.secret), { ca, headers: { Host: `evil.example:${lan.port}` } })).status).toBe(421)
    expect((await openWs(wsUrl, phoneProtocols(lan.secret), { ca, headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect((await openWs(wsUrl, phoneProtocols(lan.secret), { ca, headers: { Origin: `http://127.0.0.1:${lan.port}` } })).status).toBe(403)
    expect((await openWs(`wss://127.0.0.1:${lan.port}/`, phoneProtocols(lan.secret), { ca })).status).toBe(404)
    expect((await openWs(`wss://127.0.0.1:${lan.port}/ws/extra`, phoneProtocols(lan.secret), { ca })).status).toBe(404)
    expect(office.server.wss.clients.size).toBe(0)
  })

  it('a phone gets auth (trusted, phone), a snapshot with the meters and no UI token, and the whole stream', async () => {
    const opened = await openWs(wsUrl, phoneProtocols(lan.secret), { ca, headers: { Origin: origin() } })
    const client = opened.client!
    sockets.push(client.ws)
    expect(client.ws.protocol).toBe('agent-office')
    await until(() => client.messages.length >= 2)
    expect(client.messages[0]).toEqual({ type: 'auth', trusted: true, phone: true })
    const snap = client.messages[1]
    expect(snap.type).toBe('snapshot')
    expect(snap).toHaveProperty('statuses')
    expect(snap).toHaveProperty('pendingPermissions')
    // The UI token stays on this machine: the phone's requests ride on the phone secret
    expect(snap).not.toHaveProperty('uiToken')

    // A trusted loopback page beside it sees the same events
    const trusted = (await openWs(loopbackUrl, officeProtocols(office.server))).client!
    sockets.push(trusted.ws)
    const S = { ...ALPHA, project: `${SECRET}proj` }
    for (const event of [
      { type: 'session_prompt', ...S, promptId: 'p1', text: `${SECRET} prompt` },
      { type: 'agent_spawned', ...S, agent: { id: 'toolu_1', name: 'Dev', role: 'frontend-developer', task: `${SECRET} task` } },
      { type: 'agent_working', ...S, agentId: 'toolu_1', status: `running: ${SECRET}` },
      { type: 'session_turn_end', ...S, text: `${SECRET} reply` },
      { type: 'agent_completed', ...S, agentId: 'toolu_1', result: `${SECRET} result` },
    ]) expect((await postEvent(office.server, event)).status, event.type).toBe(200)
    await phone('post', '/chat').send({ sender: 'Boss', text: `${SECRET} chat line` })
    await until(() => client.messages.some(m => m.type === 'chat_message' && String(m.text).includes('chat line')))

    const types = new Set(client.messages.map(m => m.type))
    for (const t of ['session_prompt', 'agent_spawned', 'agent_working', 'session_turn_end', 'agent_completed', 'chat_message']) expect(types, t).toContain(t)
    const text = JSON.stringify(client.messages)
    // Unlike a watch-only viewer, the phone reads the work
    for (const want of [`${SECRET} prompt`, `${SECRET} task`, `running: ${SECRET}`, `${SECRET} reply`, `${SECRET} chat line`]) expect(text, want).toContain(want)
    // ...but no credential ever travels in the stream
    for (const never of [office.server.AUTH_TOKEN, office.server.UI_TOKEN, lan.secret, viewerKey]) expect(text).not.toContain(never)
    // Event for event what the trusted page got. Why compare from the end: the
    // phone's socket opened first, so it may also hold a broadcast from before
    // the trusted page joined (a session_needs_you from an earlier test's
    // session, seen on CI); everything since must match
    const streamed = (list: Message[]) => list.filter(m => m.type !== 'auth' && m.type !== 'snapshot').map(m => m.type)
    await until(() => streamed(trusted.messages).length >= 6)
    const theirs = streamed(trusted.messages)
    expect(streamed(client.messages).slice(-theirs.length)).toEqual(theirs)
  })

  it('answering a permission from the phone works end to end: the card arrives, the tap allows, the hook is released with its proof', async () => {
    const opened = await openWs(wsUrl, phoneProtocols(lan.secret), { ca })
    const client = opened.client!
    sockets.push(client.ws)

    // The hook, on this machine: a PermissionRequest the office may answer
    const asked = await postEvent(office.server, {
      type: 'session_needs_you', kind: 'permission', ...ALPHA, promptId: 'p-1', toolName: 'Write', summary: 'probe.txt',
      detail: '/home/me/alpha/probe.txt', answerable: true, permissionMode: 'default',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], nonce: NONCE,
    })
    expect(asked.status).toBe(200)
    const id = asked.body.permissionId as string
    expect(id).toMatch(/^[0-9a-f]{16}$/)

    // The card reaches the phone with what it needs to decide
    await until(() => client.messages.some(m => m.type === 'permission_request' && m.permission?.id === id))
    const card = client.messages.find(m => m.type === 'permission_request' && m.permission?.id === id)!
    expect(card.permission).toMatchObject({ id, toolName: 'Write', summary: 'probe.txt', detail: '/home/me/alpha/probe.txt', status: 'pending' })

    // The hook waits (loopback, office token), the phone taps Allow (HTTPS, phone secret)
    const waiting = request(office.server.app).get(`/permission/${id}?wait=10`).set('Authorization', bearer(office.server.AUTH_TOKEN))
    const hookAnswer = waiting.then(res => res)
    await sleep(100)
    // A wrong secret does not answer it
    expect((await phone('post', `/permission/${id}`, '0'.repeat(64)).send({ decision: 'allow' })).status).toBe(401)
    expect(office.server.permissions.get(id).status).toBe('pending')
    const tap = await phone('post', `/permission/${id}`).set('Origin', origin()).send({ decision: 'allow' })
    expect(tap.status).toBe(200)
    expect(tap.body).toEqual({ ok: true, permissionId: id, status: 'allowed' })

    const released = await hookAnswer
    expect(released.status).toBe(200)
    const proof = createHmac('sha256', office.server.AUTH_TOKEN).update(`${NONCE}${id}allow`).digest('hex')
    expect(released.body).toEqual({ status: 'allowed', deadline: expect.any(Number), decision: 'allow', proof })

    // The phone hears it is over, and by whom
    await until(() => client.messages.some(m => m.type === 'permission_resolved' && m.permissionId === id))
    expect(client.messages.find(m => m.type === 'permission_resolved' && m.permissionId === id)).toMatchObject({ status: 'allowed', decidedBy: 'office' })
    // The proof is the hook's alone: it never went to the phone
    expect(JSON.stringify(client.messages)).not.toContain(proof)
    expect(JSON.stringify(tap.body)).not.toContain(proof)

    // A second tap is a conflict, an unknown id a 404, a bad word a 400; deny works the same way
    expect((await phone('post', `/permission/${id}`).send({ decision: 'deny' })).status).toBe(409)
    expect((await phone('post', '/permission/ffffffffffffffff').send({ decision: 'allow' })).status).toBe(404)
    const second = (await postEvent(office.server, { type: 'session_needs_you', kind: 'permission', ...ALPHA, promptId: 'p-2', toolName: 'Bash', summary: 'rm -rf', detail: 'rm -rf build', answerable: true, nonce: NONCE })).body.permissionId
    expect((await phone('post', `/permission/${second}`).send({ decision: 'maybe' })).status).toBe(400)
    expect((await phone('post', `/permission/${second}`).send({ decision: 'deny' })).body).toEqual({ ok: true, permissionId: second, status: 'denied' })
    office.server.permissions.resolveSession(SID, '')
  })

  it('the loopback listener is untouched: it refuses the phone secret\'s Host, and the secret is no credential there', async () => {
    const app = office.server.app
    expect((await request(app).get('/health').set('Host', `192.168.1.23:${lan.port}`)).status).toBe(421)
    expect((await request(app).get('/health')).status).toBe(200)
    // On loopback the phone secret is just not the office token
    expect((await request(app).post('/event').set('Authorization', bearer(lan.secret)).send({ type: 'agent_spawned', agent: { id: 'toolu_p', name: 'P', role: 'debugger' } })).status).toBe(401)
    expect((await request(app).post('/settings').set('Authorization', bearer(lan.secret)).send({ answerPermissions: false })).status).toBe(401)
    const readOnly = (await openWs(loopbackUrl, phoneProtocols(lan.secret))).client!
    sockets.push(readOnly.ws)
    await until(() => readOnly.messages.length >= 1)
    expect(readOnly.messages[0]).toEqual({ type: 'auth', trusted: false })
  })

  it('stopLan closes it: the port stops answering', async () => {
    const other = await loadOffice()
    const started = await startFull(other.server)
    const cert = readFileSync(join(other.dir, LAN_CERT_FILE), 'utf8')
    expect((await request(`https://127.0.0.1:${started.port}`).get('/config').ca(cert).set('Authorization', bearer(started.secret))).status).toBe(200)
    other.server.stopLan()
    await sleep(50)
    await expect(request(`https://127.0.0.1:${started.port}`).get('/config').ca(cert).set('Authorization', bearer(started.secret))).rejects.toThrow()
    removeOffice(other)
  })
})

// ---------------------------------------------------------------------------
// Lockout and the client cap, each in an office of its own
// ---------------------------------------------------------------------------

describe('the full-mode listener: wrong secrets lock an address out', () => {
  let office: Office
  let lan: FullLan
  let ca: string
  let base: string

  beforeAll(async () => {
    office = await loadOffice()
    lan = await startFull(office.server)
    ca = readFileSync(join(office.dir, LAN_CERT_FILE), 'utf8')
    base = `https://127.0.0.1:${lan.port}`
  })

  afterAll(() => {
    office.server.stopLan()
    removeOffice(office)
  })

  it('a missing secret never counts; the 20th wrong one starts a lock that the right secret does not lift', async () => {
    const get = (credential: string | null) => {
      const req = request(base).get('/config').ca(ca)
      return credential === null ? req : req.set('Authorization', `Bearer ${credential}`)
    }
    // A page opened without its link asks with nothing, again and again: not a guess
    for (let i = 0; i < 25; i++) expect((await get(null)).status).toBe(401)
    expect((await get(lan.secret)).status).toBe(200)

    for (let i = 0; i < 20; i++) expect((await get('f'.repeat(64))).status, `wrong #${i + 1}`).toBe(401)
    const locked = await get('f'.repeat(64))
    expect(locked.status).toBe(429)
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(60)
    // While locked the gate does not look at what is offered: a right guess learns nothing
    expect((await get(lan.secret)).status).toBe(429)
    expect((await get(null)).status).toBe(429)
    const post = await request(base).post('/chat').ca(ca).set('Authorization', `Bearer ${lan.secret}`).send({ sender: 'x', text: 'locked out' })
    expect(post.status).toBe(429)
    // The WebSocket is behind the same lock
    const ws = await openWs(`wss://127.0.0.1:${lan.port}/ws`, phoneProtocols(lan.secret), { ca })
    expect(ws.status).toBe(429)
    expect(Number(ws.retryAfter)).toBeGreaterThan(0)
    // The page itself still loads (static files need no secret), so the phone can show why
    expect(JSON.stringify((await request(office.server.app).get('/chat')).body)).not.toContain('locked out')
  })
})

describe('the full-mode listener: wrong secrets on the WebSocket count too', () => {
  it('20 handshakes with a wrong credential lock the address; a bare handshake does not count', async () => {
    const office = await loadOffice()
    const lan = await startFull(office.server)
    const ca = readFileSync(join(office.dir, LAN_CERT_FILE), 'utf8')
    const wsUrl = `wss://127.0.0.1:${lan.port}/ws`
    try {
      for (let i = 0; i < 22; i++) expect((await openWs(wsUrl, ['agent-office'], { ca })).status).toBe(401)
      // The office token and the viewer key shape count like any wrong secret
      for (let i = 0; i < 20; i++) {
        const protocols = i % 2 ? officeProtocols(office.server) : phoneProtocols('e'.repeat(64))
        expect((await openWs(wsUrl, protocols, { ca })).status, `wrong #${i + 1}`).toBe(401)
      }
      expect((await openWs(wsUrl, phoneProtocols(lan.secret), { ca })).status).toBe(429)
      expect((await request(`https://127.0.0.1:${lan.port}`).get('/config').ca(ca).set('Authorization', `Bearer ${lan.secret}`)).status).toBe(429)
    } finally {
      office.server.stopLan()
      removeOffice(office)
    }
  })
})

describe('the full-mode listener: at most eight phones', () => {
  it('the ninth socket is refused with 503 before the upgrade, and a place frees when one leaves', async () => {
    const office = await loadOffice()
    const lan = await startFull(office.server)
    const ca = readFileSync(join(office.dir, LAN_CERT_FILE), 'utf8')
    const wsUrl = `wss://127.0.0.1:${lan.port}/ws`
    const open: WebSocket[] = []
    try {
      for (let i = 0; i < 8; i++) {
        const res = await openWs(wsUrl, phoneProtocols(lan.secret), { ca })
        expect(res.client, `phone ${i + 1}`).toBeDefined()
        open.push(res.client!.ws)
      }
      const ninth = await openWs(wsUrl, phoneProtocols(lan.secret), { ca })
      expect(ninth.client).toBeUndefined()
      expect(ninth.status).toBe(503)
      expect(ninth.retryAfter).toBe('5')
      // HTTP is not behind the phone cap: a full house can still answer a permission
      expect((await request(`https://127.0.0.1:${lan.port}`).get('/config').ca(ca).set('Authorization', `Bearer ${lan.secret}`)).status).toBe(200)

      open.pop()!.close()
      await sleep(150)
      const again = await openWs(wsUrl, phoneProtocols(lan.secret), { ca })
      expect(again.client).toBeDefined()
      open.push(again.client!.ws)
    } finally {
      for (const ws of open) ws.terminate()
      office.server.stopLan()
      removeOffice(office)
    }
  })
})

// ---------------------------------------------------------------------------
// The files across restarts
// ---------------------------------------------------------------------------

describe('the phone secret and certificate files across restarts', () => {
  /** One full-mode start and stop of a fresh server process over `dir`. */
  async function run(dir?: string): Promise<{ office: Office; lan: FullLan }> {
    const office = await loadOffice(dir ? { dir } : {})
    const lan = await startFull(office.server)
    office.server.stopLan()
    return { office, lan }
  }

  it('both are reused while their files are safe to trust: same link, no new certificate warning', async () => {
    const first = await run()
    const second = await run(first.office.dir)
    expect(second.lan.secret).toBe(first.lan.secret)
    expect(second.lan.fingerprint).toBe(first.lan.fingerprint)
    expect(second.lan.certReused).toBe(true)
    expect(second.lan.certReason).toBeNull()
    removeOffice(first.office)
  })

  it.skipIf(!posix)('a loosened secret file, or one holding the office token or the viewer key, is replaced', async () => {
    const first = await run()
    const dir = first.office.dir
    const file = first.office.server.PHONE_SECRET_FILE

    chmodSync(file, 0o644)
    const second = await run(dir)
    expect(second.lan.secret).not.toBe(first.lan.secret)
    expect(statSync(file).mode & 0o777).toBe(0o600)

    // Someone copied the office token into the phone secret file: it must never travel to a phone
    const officeToken = 'c'.repeat(64)
    writeFileSync(join(dir, 'auth-token'), officeToken, { mode: 0o600 })
    writeFileSync(file, officeToken, { mode: 0o600 })
    const third = await run(dir)
    expect(third.office.server.AUTH_TOKEN).toBe(officeToken)
    expect(third.lan.secret).not.toBe(officeToken)
    expect(readFileSync(file, 'utf8')).toBe(third.lan.secret)

    // ...or the viewer key, which crosses the Wi-Fi in clear in watch-only mode
    const viewerKey = 'd'.repeat(64)
    writeFileSync(join(dir, 'lan-viewer-key'), viewerKey, { mode: 0o600 })
    writeFileSync(file, viewerKey, { mode: 0o600 })
    const fourth = await run(dir)
    expect(fourth.lan.secret).not.toBe(viewerKey)
    // The viewer key itself is left as it was
    expect(readFileSync(join(dir, 'lan-viewer-key'), 'utf8')).toBe(viewerKey)

    // Not a secret at all
    writeFileSync(file, 'not a secret', { mode: 0o600 })
    expect((await run(dir)).lan.secret).toMatch(/^[0-9a-f]{64}$/)
    removeOffice(first.office)
  })

  it.skipIf(!posix)('a secret file that is a symlink is not followed, and not written through', async () => {
    const first = await run()
    const dir = first.office.dir
    const file = first.office.server.PHONE_SECRET_FILE
    const elsewhere = join(dir, 'elsewhere')
    writeFileSync(elsewhere, 'e'.repeat(64), { mode: 0o600 })
    rmSync(file)
    symlinkSync(elsewhere, file)
    const second = await run(dir)
    expect(second.lan.secret).not.toBe('e'.repeat(64))
    expect(readFileSync(elsewhere, 'utf8')).toBe('e'.repeat(64))
    expect(statSync(file).isFile()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(second.lan.secret)
    removeOffice(first.office)
  })

  it.skipIf(!posix)('a loosened key file means a new certificate (and says why); the secret is kept', async () => {
    const first = await run()
    const dir = first.office.dir
    chmodSync(join(dir, LAN_KEY_FILE), 0o644)
    const second = await run(dir)
    expect(second.lan.certReused).toBe(false)
    expect(second.lan.certReason).toBe('none stored')
    expect(second.lan.fingerprint).not.toBe(first.lan.fingerprint)
    expect(statSync(join(dir, LAN_KEY_FILE)).mode & 0o777).toBe(0o600)
    expect(second.lan.secret).toBe(first.lan.secret)
    removeOffice(first.office)
  })

  it('--rotate: the phone secret is new and the old one is refused; the certificate is kept', async () => {
    const first = await run()
    const dir = first.office.dir
    expect(rotatePhoneSecret({ AGENT_OFFICE_HOME: dir })).toBe(join(dir, 'lan-phone-secret'))
    const office = await loadOffice({ dir })
    const lan = await startFull(office.server)
    try {
      expect(lan.secret).not.toBe(first.lan.secret)
      expect(lan.fingerprint).toBe(first.lan.fingerprint)
      const ca = readFileSync(join(dir, LAN_CERT_FILE), 'utf8')
      const get = (secret: string) => request(`https://127.0.0.1:${lan.port}`).get('/config').ca(ca).set('Authorization', `Bearer ${secret}`)
      expect((await get(first.lan.secret)).status).toBe(401)
      expect((await get(lan.secret)).status).toBe(200)
    } finally {
      office.server.stopLan()
      removeOffice(office)
    }
  })

  it('a second office that loses the port replaces neither file', async () => {
    const office = await loadOffice()
    const lan = await startFull(office.server)
    const before = { secret: readFileSync(office.server.PHONE_SECRET_FILE, 'utf8'), cert: readFileSync(join(office.dir, LAN_CERT_FILE), 'utf8') }
    try {
      // Loosen the secret file so a second start WOULD mint a new one if it got as far as writing
      if (posix) chmodSync(office.server.PHONE_SECRET_FILE, 0o644)
      const rival = await loadOffice({ dir: office.dir })
      await expect(rival.server.startLan({ host: '127.0.0.1', port: lan.port, full: true })).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(readFileSync(office.server.PHONE_SECRET_FILE, 'utf8')).toBe(before.secret)
      expect(readFileSync(join(office.dir, LAN_CERT_FILE), 'utf8')).toBe(before.cert)
    } finally {
      office.server.stopLan()
      removeOffice(office)
    }
  })
})
