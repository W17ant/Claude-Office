/**
 * server/config.js — the server's runtime configuration: AGENT_OFFICE_PORT
 * and AGENT_OFFICE_UI_PORT (readPort / readUiPort), AGENT_OFFICE_HOST
 * (readHost: loopback only, anything else refused with the reason) and
 * office.config.json next to package.json (readOfficeConfig / bossFromConfig).
 * Then the server on top of them: start() binds the configured port, a
 * non-loopback host still binds 127.0.0.1, GET /config with and without the
 * file, and the origin allowlist and A2A card following the port.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BOSS, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_UI_PORT,
  bossFromConfig, loadOfficeConfig, readHost, readOfficeConfig, readPort, readUiPort,
} from '../server/config.js'
import { loadOffice, removeOffice, type Office } from './helpers'

/** A logger that records instead of printing. */
function recorder() {
  const warn: string[] = []
  const error: string[] = []
  return { warn: (m: string) => { warn.push(m) }, error: (m: string) => { error.push(m) }, lines: { warn, error } }
}

/** A port nothing listens on right now (bind 0, read, release). */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

const dirs: string[] = []
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-config-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('readPort / readUiPort', () => {
  it('is 3334 when AGENT_OFFICE_PORT is unset or empty, without a warning', () => {
    const log = recorder()
    expect(readPort({}, log)).toBe(DEFAULT_PORT)
    expect(readPort({ AGENT_OFFICE_PORT: '' }, log)).toBe(DEFAULT_PORT)
    expect(log.lines.warn).toEqual([])
    expect(DEFAULT_PORT).toBe(3334)
  })

  it('parses a port, tolerating surrounding whitespace', () => {
    expect(readPort({ AGENT_OFFICE_PORT: '4000' })).toBe(4000)
    expect(readPort({ AGENT_OFFICE_PORT: ' 4123 ' })).toBe(4123)
    expect(readPort({ AGENT_OFFICE_PORT: '65535' })).toBe(65535)
    expect(readPort({ AGENT_OFFICE_PORT: '1' })).toBe(1)
  })

  it('falls back to 3334 with a warning naming the value when it is not a port', () => {
    for (const bad of ['abc', '0', '70000', '-1', '33.34', '3334abc', '0x3334']) {
      const log = recorder()
      expect(readPort({ AGENT_OFFICE_PORT: bad }, log)).toBe(DEFAULT_PORT)
      expect(log.lines.warn).toHaveLength(1)
      expect(log.lines.warn[0]).toContain(`AGENT_OFFICE_PORT=${JSON.stringify(bad)}`)
      expect(log.lines.warn[0]).toContain('using 3334')
    }
  })

  it('readUiPort reads AGENT_OFFICE_UI_PORT the same way, default 3333', () => {
    const log = recorder()
    expect(readUiPort({}, log)).toBe(DEFAULT_UI_PORT)
    expect(DEFAULT_UI_PORT).toBe(3333)
    expect(readUiPort({ AGENT_OFFICE_UI_PORT: '3400' }, log)).toBe(3400)
    expect(readUiPort({ AGENT_OFFICE_UI_PORT: 'vite' }, log)).toBe(3333)
    expect(log.lines.warn[0]).toContain('AGENT_OFFICE_UI_PORT="vite"')
  })

  it('reads from the env it is given, not process.env', () => {
    const before = process.env.AGENT_OFFICE_PORT
    process.env.AGENT_OFFICE_PORT = '5000'
    try {
      expect(readPort({})).toBe(DEFAULT_PORT)
      expect(readPort()).toBe(5000)
    } finally {
      if (before === undefined) delete process.env.AGENT_OFFICE_PORT
      else process.env.AGENT_OFFICE_PORT = before
    }
  })
})

describe('readHost', () => {
  it('is 127.0.0.1 when AGENT_OFFICE_HOST is unset or blank, silently', () => {
    const log = recorder()
    expect(readHost({}, log)).toBe(DEFAULT_HOST)
    expect(readHost({ AGENT_OFFICE_HOST: '' }, log)).toBe(DEFAULT_HOST)
    expect(readHost({ AGENT_OFFICE_HOST: '   ' }, log)).toBe(DEFAULT_HOST)
    expect(log.lines.error).toEqual([])
    expect(DEFAULT_HOST).toBe('127.0.0.1')
  })

  it('accepts 127.0.0.1 and localhost, and binds 127.0.0.1 for both (the resolver may answer ::1 for localhost)', () => {
    const log = recorder()
    expect(readHost({ AGENT_OFFICE_HOST: '127.0.0.1' }, log)).toBe('127.0.0.1')
    expect(readHost({ AGENT_OFFICE_HOST: 'localhost' }, log)).toBe('127.0.0.1')
    expect(readHost({ AGENT_OFFICE_HOST: 'LOCALHOST' }, log)).toBe('127.0.0.1')
    expect(readHost({ AGENT_OFFICE_HOST: ' localhost ' }, log)).toBe('127.0.0.1')
    expect(log.lines.error).toEqual([])
  })

  it('refuses IPv6 loopback with its own reason and binds 127.0.0.1: every client dials IPv4', () => {
    for (const host of ['::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      const log = recorder()
      expect(readHost({ AGENT_OFFICE_HOST: host }, log)).toBe('127.0.0.1')
      expect(log.lines.error).toHaveLength(1)
      const msg = log.lines.error[0]
      expect(msg).toContain(`AGENT_OFFICE_HOST=${JSON.stringify(host)} refused`)
      expect(msg).toMatch(/IPv4 loopback only/)
      expect(msg).toMatch(/dial 127\.0\.0\.1/)
      expect(msg).toMatch(/Binding 127\.0\.0\.1/)
    }
  })

  it('refuses anything else with the reason and binds 127.0.0.1', () => {
    for (const host of ['0.0.0.0', '192.168.1.20', '::', 'office.local', 'example.com', '127.0.0.1:4000']) {
      const log = recorder()
      expect(readHost({ AGENT_OFFICE_HOST: host }, log)).toBe('127.0.0.1')
      expect(log.lines.error).toHaveLength(1)
      const msg = log.lines.error[0]
      expect(msg).toContain(`AGENT_OFFICE_HOST=${JSON.stringify(host)} refused`)
      expect(msg).toMatch(/loopback only/)
      expect(msg).toMatch(/every GET, POST \/chat and the WebSocket are open on loopback by design/i)
      expect(msg).toMatch(/would expose/)
      expect(msg).toMatch(/UI token work would have to cover every route first/)
      expect(msg).toMatch(/Binding 127\.0\.0\.1/)
    }
  })
})

describe('readOfficeConfig / loadOfficeConfig', () => {
  it('is {} (and no file) when office.config.json is missing', () => {
    const root = tempRoot()
    expect(readOfficeConfig(root)).toEqual({})
    expect(loadOfficeConfig(root)).toEqual({ config: {}, file: null })
  })

  it('returns the parsed object and the path that was read', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'office.config.json'), JSON.stringify({ boss: { name: 'Ant', sprite: 'Me-1' }, extra: 1 }))
    expect(readOfficeConfig(root)).toEqual({ boss: { name: 'Ant', sprite: 'Me-1' }, extra: 1 })
    expect(loadOfficeConfig(root).file).toBe(join(root, 'office.config.json'))
  })

  it('is {} with a warning for a file that is not JSON, or not an object', () => {
    const root = tempRoot()
    const file = join(root, 'office.config.json')
    writeFileSync(file, '{ "boss": ')
    let log = recorder()
    expect(readOfficeConfig(root, log)).toEqual({})
    expect(log.lines.warn[0]).toContain(file)
    expect(log.lines.warn[0]).toMatch(/could not be read/)
    expect(loadOfficeConfig(root, recorder()).file).toBeNull()

    for (const notAnObject of ['[1, 2]', '"boss"', 'null', '42']) {
      writeFileSync(file, notAnObject)
      log = recorder()
      expect(readOfficeConfig(root, log)).toEqual({})
      expect(log.lines.warn).toHaveLength(1)
    }
  })
})

describe('bossFromConfig', () => {
  it('is the defaults for no config, an empty one, or a boss that is not an object', () => {
    expect(bossFromConfig()).toEqual(DEFAULT_BOSS)
    expect(bossFromConfig({})).toEqual(DEFAULT_BOSS)
    expect(bossFromConfig({ boss: 'Ant' } as never)).toEqual(DEFAULT_BOSS)
    expect(bossFromConfig({ boss: null } as never)).toEqual(DEFAULT_BOSS)
    expect(DEFAULT_BOSS).toEqual({ name: 'Boss', sprite: 'Me-1', color: '#ff4444', emoji: '👑' })
  })

  it('takes the file\'s string fields over the defaults, trimmed, and ignores the rest', () => {
    expect(bossFromConfig({ boss: { name: '  Ant ', color: '#123456' } })).toEqual({ name: 'Ant', sprite: 'Me-1', color: '#123456', emoji: '👑' })
    expect(bossFromConfig({ boss: { name: 42, sprite: '', emoji: ['x'] } as never })).toEqual(DEFAULT_BOSS)
    expect(bossFromConfig({ boss: { name: 'x'.repeat(500) } }).name).toHaveLength(120)
  })
})

describe('the server on a configured port', () => {
  const offices: Office[] = []
  const spies: Array<{ mockRestore: () => void }> = []

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore()
    for (const office of offices) {
      await new Promise<void>(res => office.server.wss.close(() => res()))
      await new Promise<void>(res => office.server.httpServer.close(() => res()))
      removeOffice(office)
    }
  })

  /** start() the office and wait for the socket (the banner is silenced). */
  function started(office: Office) {
    spies.push(vi.spyOn(console, 'log').mockImplementation(() => {}))
    const listening = new Promise<void>(res => office.server.httpServer.once('listening', res))
    office.server.start()
    return listening
  }

  it('start() with AGENT_OFFICE_PORT set listens there, writes the token and answers GET /health and /config', async () => {
    const port = await freePort()
    const office = await loadOffice({ env: { AGENT_OFFICE_PORT: String(port) } })
    offices.push(office)
    expect(office.server.PORT).toBe(port)
    await started(office)

    expect((office.server.httpServer.address() as AddressInfo).port).toBe(port)
    expect(existsSync(join(office.dir, 'auth-token'))).toBe(true)
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    const config = await (await fetch(`http://127.0.0.1:${port}/config`)).json()
    expect(config).toMatchObject({ port, host: '127.0.0.1' })
  })

  it('a non-loopback AGENT_OFFICE_HOST is logged as refused, with the reason, and 127.0.0.1 is bound', async () => {
    const port = await freePort()
    const office = await loadOffice({ env: { AGENT_OFFICE_PORT: String(port) } })
    offices.push(office)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    spies.push(error)

    process.env.AGENT_OFFICE_HOST = '0.0.0.0'
    try {
      await started(office)
    } finally {
      delete process.env.AGENT_OFFICE_HOST
    }

    const logged = error.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain('AGENT_OFFICE_HOST="0.0.0.0" refused')
    expect(logged).toMatch(/open on loopback by design/)
    expect(logged).toMatch(/UI token work would have to cover every route first/)
    expect(office.server.httpServer.address()).toMatchObject({ address: '127.0.0.1', port })
    const config = await (await fetch(`http://127.0.0.1:${port}/config`)).json()
    expect(config.host).toBe('127.0.0.1')
  })
})

describe('GET /config and the port-derived surfaces (AGENT_OFFICE_PORT=4000)', () => {
  let root: string
  let office: Office

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-office-config-root-'))
    office = await loadOffice({ env: { AGENT_OFFICE_PORT: '4000', AGENT_OFFICE_CONFIG_DIR: root } })
  })
  afterAll(() => {
    removeOffice(office)
    rmSync(root, { recursive: true, force: true })
  })

  it('without office.config.json: the default boss, configFile null, the port and the version', async () => {
    const res = await request(office.server.app).get('/config')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      port: 4000,
      host: '127.0.0.1',
      boss: { name: 'Boss', sprite: 'Me-1', color: '#ff4444', emoji: '👑' },
      configFile: null,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    })
  })

  it('with office.config.json next to package.json: the file over the defaults, read on every request', async () => {
    const file = join(root, 'office.config.json')
    writeFileSync(file, JSON.stringify({ boss: { name: 'Ant', sprite: 'Ant-1', emoji: 'crown' } }))
    let res = await request(office.server.app).get('/config')
    expect(res.body.boss).toEqual({ name: 'Ant', sprite: 'Ant-1', color: '#ff4444', emoji: 'crown' })
    expect(res.body.configFile).toBe(file)

    // A rename lands on the next request: no restart, no rebuild
    writeFileSync(file, JSON.stringify({ boss: { name: 'Antony' } }))
    res = await request(office.server.app).get('/config')
    expect(res.body.boss.name).toBe('Antony')
    expect(res.body.boss.sprite).toBe('Me-1')

    // A broken file is the defaults again, not a 500
    writeFileSync(file, '{ "boss": {')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      res = await request(office.server.app).get('/config')
    } finally {
      warn.mockRestore()
    }
    expect(res.status).toBe(200)
    expect(res.body.boss.name).toBe('Boss')
    expect(res.body.configFile).toBeNull()
    rmSync(file)
  })

  it('GET /config is open on loopback like GET /health: no token, no Origin', async () => {
    const res = await request(office.server.app).get('/config')
    expect(res.status).toBe(200)
    const fromPage = await request(office.server.app).get('/config').set('Origin', 'http://127.0.0.1:4000')
    expect(fromPage.status).toBe(200)
    expect(fromPage.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4000')
  })

  it('the origin allowlist accepts the configured port (and Vite) and rejects 3334', async () => {
    const { isAllowedOrigin } = office.server
    for (const origin of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000', 'http://localhost:3333', 'http://127.0.0.1:3333']) {
      expect(isAllowedOrigin(origin), origin).toBe(true)
      const res = await request(office.server.app).get('/health').set('Origin', origin)
      expect(res.status, origin).toBe(200)
    }
    for (const origin of ['http://localhost:3334', 'http://127.0.0.1:3334', 'http://localhost:4001', 'https://localhost:4000']) {
      expect(isAllowedOrigin(origin), origin).toBe(false)
      const res = await request(office.server.app).get('/health').set('Origin', origin)
      expect(res.status, origin).toBe(403)
    }
  })

  it('the A2A cards advertise the configured port', async () => {
    const card = await request(office.server.app).get('/.well-known/agent-card.json')
    expect(card.status).toBe(200)
    expect(card.body.url).toBe('http://localhost:4000/a2a')
  })
})

describe('AGENT_OFFICE_UI_PORT widens the origin allowlist', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice({ env: { AGENT_OFFICE_UI_PORT: '3400' } }) })
  afterAll(() => removeOffice(office))

  it('allows the configured Vite port and still 3333 and the server port', () => {
    expect(office.server.UI_DEV_PORT).toBe(3400)
    expect(office.server.isAllowedOrigin('http://localhost:3400')).toBe(true)
    expect(office.server.isAllowedOrigin('http://localhost:3333')).toBe(true)
    expect(office.server.isAllowedOrigin('http://localhost:3334')).toBe(true)
    expect(office.server.isAllowedOrigin('http://localhost:3401')).toBe(false)
  })
})
