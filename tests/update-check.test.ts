/**
 * update-check.test.ts - the desktop app's release check, run without Electron:
 * semver compare, release-page URL validation, the request it sends, the
 * once-per-version notification and the tray menu's "Update available" item.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const u = require('../electron/update-check.cjs')
const h = require('../electron/helpers.cjs')

const PAGE = 'https://github.com/W17ant/Claude-Office/releases/tag/v1.2.0'
const release = (overrides: Record<string, unknown> = {}) => ({ tag_name: 'v1.2.0', html_url: PAGE, draft: false, prerelease: false, ...overrides })

describe('compareVersions', () => {
  it('orders by major, minor, patch, numerically', () => {
    expect(u.compareVersions('v1.2.0', '1.1.9')).toBe(1)
    expect(u.compareVersions('1.1.2', 'v1.1.2')).toBe(0)
    expect(u.compareVersions('1.1.2', '1.1.10')).toBe(-1)
    expect(u.compareVersions('2.0.0', '1.99.99')).toBe(1)
    expect(u.compareVersions('0.10.0', '0.9.0')).toBe(1)
  })

  it('a prerelease sorts before its release, and prerelease identifiers compare by semver rules', () => {
    expect(u.compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1)
    expect(u.compareVersions('1.2.0', '1.2.0-rc.1')).toBe(1)
    expect(u.compareVersions('1.2.0-beta.2', '1.2.0-beta.10')).toBe(-1)
    expect(u.compareVersions('1.2.0-alpha', '1.2.0-alpha.1')).toBe(-1)
    expect(u.compareVersions('1.2.0-1', '1.2.0-alpha')).toBe(-1)
    expect(u.compareVersions('1.2.0-rc.1', '1.1.9')).toBe(1)
  })

  it('null when either side is not a version', () => {
    for (const bad of ['', 'latest', '1.2', 'v1.2.3.4', '1.2.3+build', 'x1.2.3', null, 42]) {
      expect(u.compareVersions(bad, '1.0.0')).toBeNull()
    }
    expect(u.normaliseTag(' 1.2.3 ')).toBe('v1.2.3')
  })
})

describe('releasePageUrl', () => {
  it('accepts the repository\'s release pages', () => {
    expect(u.releasePageUrl(PAGE)).toBe(PAGE)
    expect(u.releasePageUrl('https://github.com/W17ant/Claude-Office/releases/latest')).toBe('https://github.com/W17ant/Claude-Office/releases/latest')
  })

  it('refuses anything else', () => {
    for (const bad of [
      undefined, null, 42, '',
      'http://github.com/W17ant/Claude-Office/releases/tag/v1.2.0',
      'https://github.com/W17ant/Claude-Office/releases/',
      'https://github.com/W17ant/Claude-Office/issues/1',
      'https://github.com/W17ant/Claude-Office-evil/releases/tag/v1',
      'https://github.com.evil.example/W17ant/Claude-Office/releases/tag/v1',
      'https://evil.example/https://github.com/W17ant/Claude-Office/releases/',
      'https://github.com/W17ant/Claude-Office/releases/../../../evil/repo',
      'https://github.com/W17ant/Claude-Office/releases/%2e%2e/%2e%2e/evil',
      'https://github.com/W17ant/Claude-Office/releases/tag/v1?redirect=https://evil.example',
      'https://github.com/W17ant/Claude-Office/releases/tag/v1#x',
      'https://github.com/W17ant/Claude-Office/releases/tag/v1 javascript:alert(1)',
      'https://github.com/W17ant/Claude-Office/releases/tag/v1\nSet-Cookie: x',
      'https://github.com/W17ant/Claude-Office/releases/tag/\\..\\evil',
      PAGE + 'x'.repeat(400),
    ]) {
      expect(u.releasePageUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('availableUpdate', () => {
  it('a newer, published release with a valid page', () => {
    expect(u.availableUpdate(release(), '1.1.2')).toEqual({ version: 'v1.2.0', url: PAGE })
    expect(u.availableUpdate(release({ tag_name: '1.2.0' }), '1.1.2')).toEqual({ version: 'v1.2.0', url: PAGE })
  })

  it('nothing for the same or an older version, a draft, a prerelease, a bad tag or a bad page', () => {
    expect(u.availableUpdate(release(), '1.2.0')).toBeNull()
    expect(u.availableUpdate(release(), '1.3.0')).toBeNull()
    expect(u.availableUpdate(release({ draft: true }), '1.1.2')).toBeNull()
    expect(u.availableUpdate(release({ prerelease: true }), '1.1.2')).toBeNull()
    expect(u.availableUpdate(release({ tag_name: 'nightly' }), '1.1.2')).toBeNull()
    expect(u.availableUpdate(release({ html_url: 'https://evil.example/' }), '1.1.2')).toBeNull()
    expect(u.availableUpdate(null, '1.1.2')).toBeNull()
    expect(u.availableUpdate({ message: 'API rate limit exceeded' }, '1.1.2')).toBeNull()
  })
})

describe('fetchLatestRelease', () => {
  /** A fake https.get: records the call and answers with `status` and `body`. */
  function fakeGet(status: number, body: string) {
    const calls: any[] = []
    const get = (url: string, opts: any, cb: (res: any) => void) => {
      calls.push({ url, opts })
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const res = Object.assign(new EventEmitter(), { statusCode: status, setEncoding() {}, resume() {} })
      setImmediate(() => { cb(res); res.emit('data', body); res.emit('end') })
      return req
    }
    return { get, calls }
  }

  it('GETs the releases API with only a User-Agent naming the app and version, and a timeout', async () => {
    const { get, calls } = fakeGet(200, JSON.stringify(release()))
    expect(await u.fetchLatestRelease({ version: '1.1.2', get })).toMatchObject({ tag_name: 'v1.2.0' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.github.com/repos/W17ant/Claude-Office/releases/latest')
    expect(calls[0].opts.headers).toEqual({ 'User-Agent': 'Agent-Office/1.1.2', Accept: 'application/vnd.github+json' })
    expect(calls[0].opts.timeout).toBe(u.UPDATE_CHECK_TIMEOUT_MS)
  })

  it('null on a non-200, bad JSON, a request error or a timeout', async () => {
    expect(await u.fetchLatestRelease({ version: '1', get: fakeGet(403, '{}').get })).toBeNull()
    expect(await u.fetchLatestRelease({ version: '1', get: fakeGet(200, 'not json').get })).toBeNull()
    for (const event of ['error', 'timeout']) {
      const req = Object.assign(new EventEmitter(), { destroy: vi.fn() })
      const get = () => { setImmediate(() => req.emit(event, new Error('x'))); return req }
      expect(await u.fetchLatestRelease({ version: '1', get })).toBeNull()
    }
    expect(await u.fetchLatestRelease({ version: '1', get: () => { throw new Error('no network') } })).toBeNull()
  })
})

describe('createUpdateChecker', () => {
  const stateDir = () => mkdtempSync(join(tmpdir(), 'agent-office-update-'))

  it('reports the update every check but notifies once per version, remembered across restarts', async () => {
    const stateFile = join(stateDir(), 'update-check.json')
    const onUpdate = vi.fn()
    const notify = vi.fn()
    let latest = release()
    const make = () => u.createUpdateChecker({ currentVersion: '1.1.2', stateFile, fetchRelease: async () => latest, onUpdate, notify, log: () => {} })

    const checker = make()
    expect(await checker.check()).toEqual({ version: 'v1.2.0', url: PAGE })
    await checker.check()
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(checker.update).toEqual({ version: 'v1.2.0', url: PAGE })
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ lastNotifiedVersion: 'v1.2.0' })

    // A restart: the same version is not notified again
    await make().check()
    expect(notify).toHaveBeenCalledTimes(1)

    // A newer one is
    latest = release({ tag_name: 'v1.3.0', html_url: 'https://github.com/W17ant/Claude-Office/releases/tag/v1.3.0' })
    await make().check()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenLastCalledWith({ version: 'v1.3.0', url: 'https://github.com/W17ant/Claude-Office/releases/tag/v1.3.0' })
  })

  it('failures are silent: a null fetch, a throwing fetch, junk in the state file', async () => {
    const dir = stateDir()
    const stateFile = join(dir, 'update-check.json')
    writeFileSync(stateFile, '{not json')
    const log = vi.fn()
    const notify = vi.fn()
    expect(await u.createUpdateChecker({ currentVersion: '1.1.2', stateFile, fetchRelease: async () => null, notify, log }).check()).toBeNull()
    expect(await u.createUpdateChecker({ currentVersion: '1.1.2', stateFile, fetchRelease: async () => { throw new Error('offline') }, notify, log }).check()).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'))
    expect(notify).not.toHaveBeenCalled()
    // Junk in the file reads as "never notified"
    await u.createUpdateChecker({ currentVersion: '1.1.2', stateFile, fetchRelease: async () => release(), notify, log }).check()
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('start checks at once and every six hours; stop ends it', async () => {
    vi.useFakeTimers()
    try {
      const fetchRelease = vi.fn(async () => null)
      const checker = u.createUpdateChecker({ currentVersion: '1.1.2', stateFile: join(stateDir(), 's.json'), fetchRelease, log: () => {} })
      checker.start()
      checker.start()
      expect(fetchRelease).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(u.UPDATE_CHECK_INTERVAL_MS)
      expect(fetchRelease).toHaveBeenCalledTimes(2)
      expect(u.UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
      checker.stop()
      vi.advanceTimersByTime(u.UPDATE_CHECK_INTERVAL_MS * 2)
      expect(fetchRelease).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the tray menu with an update', () => {
  const actions = {
    toggleWindow: vi.fn(), setCompact: vi.fn(), setAlwaysOnTop: vi.fn(), resetBounds: vi.fn(),
    openInBrowser: vi.fn(), openUpdate: vi.fn(), quit: vi.fn(),
  }
  const base = { visible: true, compact: false, alwaysOnTop: false, status: '' }

  it('no update: no item', () => {
    const t = h.trayMenuTemplate(base, actions)
    expect(t.some((i: any) => String(i.label ?? '').startsWith('Update available'))).toBe(false)
  })

  it('an update: "Update available: vX.Y.Z — Download" under the status line, which calls openUpdate', () => {
    const t = h.trayMenuTemplate({ ...base, update: { version: 'v1.2.0', url: PAGE } }, actions)
    expect(t[2]).toMatchObject({ label: 'Update available: v1.2.0 — Download' })
    expect(t[3]).toEqual({ type: 'separator' })
    t[2].click()
    expect(actions.openUpdate).toHaveBeenCalledTimes(1)
    expect(actions.openInBrowser).not.toHaveBeenCalled()
  })

  it('main.cjs opens only a URL that passes releasePageUrl, and checks only when packaged', () => {
    const main = readFileSync(join(__dirname, '..', 'electron/main.cjs'), 'utf8')
    expect(main).toMatch(/const url = availableUpdate && releasePageUrl\(availableUpdate\.url\)\s*\n\s*if \(url\) shell\.openExternal\(url\)/)
    expect(main).toMatch(/!app\.isPackaged/)
    expect(main).toContain('update: availableUpdate')
  })
})
