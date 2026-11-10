/**
 * auto-update.test.ts - the update flow (electron/auto-update.cjs), run
 * without Electron: a found release is downloaded in the background, becomes
 * "Restart to update" with one notification, and every failure ends at the
 * download page. The backends are fakes here; the macOS one is exercised for
 * real in tests/mac-update.test.ts, and the Windows/Linux one is driven
 * through a stand-in for electron-updater's `autoUpdater`.
 */

import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const a = require('../electron/auto-update.cjs')
const u = require('../electron/update-check.cjs')

const PAGE = 'https://github.com/W17ant/Claude-Office/releases/tag/v1.2.0'
const UPDATE = { version: 'v1.2.0', url: PAGE }
const NEXT = { version: 'v1.3.0', url: 'https://github.com/W17ant/Claude-Office/releases/tag/v1.3.0' }

const stateFile = () => join(mkdtempSync(join(tmpdir(), 'agent-office-auto-update-')), 'update-check.json')
/** Let the promise chain inside `offer` run to its end. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A backend whose downloads succeed at once, unless told otherwise. */
function fakeBackend(over: Record<string, unknown> = {}) {
  return {
    quitsItself: false,
    prepare: vi.fn(async (update: { version: string }) => ({ version: update.version })),
    apply: vi.fn(() => true),
    applyOnQuit: vi.fn(() => true),
    setEnabled: vi.fn(),
    ...over,
  }
}

function make(over: Record<string, unknown> = {}) {
  const hooks = { onChange: vi.fn(), notifyReady: vi.fn(), announce: vi.fn(), quit: vi.fn() }
  const backend = (over.backend as ReturnType<typeof fakeBackend>) || fakeBackend()
  const file = (over.stateFile as string) || stateFile()
  const updater = a.createAutoUpdater({ currentVersion: '1.1.2', stateFile: file, backend, log: () => {}, ...hooks, ...over })
  return { updater, backend, file, ...hooks }
}

describe('createAutoUpdater: found, downloaded, ready', () => {
  it('downloads in the background, then is ready with one notification', async () => {
    const { updater, backend, notifyReady, announce, onChange, file } = make()
    expect(updater.menuState()).toEqual({ enabled: true, phase: 'idle', version: null })

    expect(updater.offer(UPDATE)).toBe(true)
    expect(updater.menuState()).toEqual({ enabled: true, phase: 'downloading', version: 'v1.2.0' })
    // A second check while it downloads starts nothing new
    expect(updater.offer(UPDATE)).toBe(true)
    await settle()

    expect(backend.prepare).toHaveBeenCalledTimes(1)
    expect(backend.prepare).toHaveBeenCalledWith(UPDATE)
    expect(updater.menuState()).toEqual({ enabled: true, phase: 'ready', version: 'v1.2.0' })
    expect(notifyReady).toHaveBeenCalledTimes(1)
    expect(notifyReady).toHaveBeenCalledWith({ version: 'v1.2.0' })
    expect(announce).not.toHaveBeenCalled()
    // The menus were rebuilt for each phase
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(u.readUpdateState(file).readyNotifiedVersion).toBe('v1.2.0')

    // Six hours later the same release is found again: still ready, nothing fetched
    expect(updater.offer(UPDATE)).toBe(true)
    await settle()
    expect(backend.prepare).toHaveBeenCalledTimes(1)
    expect(notifyReady).toHaveBeenCalledTimes(1)
  })

  it('after a restart the same version is downloaded again but not announced again', async () => {
    const file = stateFile()
    const first = make({ stateFile: file })
    first.updater.offer(UPDATE)
    await settle()
    const second = make({ stateFile: file })
    expect(second.updater.offer(UPDATE)).toBe(true)
    await settle()
    expect(second.updater.menuState().phase).toBe('ready')
    expect(second.notifyReady).not.toHaveBeenCalled()
  })

  it('a newer release while one is ready replaces it', async () => {
    const { updater, backend, notifyReady } = make()
    updater.offer(UPDATE)
    await settle()
    expect(updater.offer(NEXT)).toBe(true)
    await settle()
    expect(backend.prepare).toHaveBeenCalledTimes(2)
    expect(updater.menuState()).toEqual({ enabled: true, phase: 'ready', version: 'v1.3.0' })
    expect(notifyReady).toHaveBeenCalledTimes(2)
  })

  it('never a downgrade: an equal or older release is not handled, and a backend that fetched one is a failure', async () => {
    const { updater, backend } = make()
    expect(updater.offer({ version: 'v1.1.2', url: PAGE })).toBe(false)
    expect(updater.offer({ version: 'v1.0.0', url: PAGE })).toBe(false)
    expect(updater.offer({ version: 'nightly', url: PAGE })).toBe(false)
    expect(updater.offer(null)).toBe(false)
    expect(backend.prepare).not.toHaveBeenCalled()

    const old = make({ backend: fakeBackend({ prepare: vi.fn(async () => ({ version: 'v1.1.0' })) }) })
    old.updater.offer(UPDATE)
    await settle()
    expect(old.updater.menuState().phase).toBe('failed')
    expect(old.notifyReady).not.toHaveBeenCalled()
    expect(old.updater.apply()).toBe(false)
    expect(old.backend.apply).not.toHaveBeenCalled()
  })
})

describe('createAutoUpdater: every failure ends at the download page', () => {
  it('a failed download (or checksum) is announced as "is available", and nothing can be applied', async () => {
    const backend = fakeBackend({ prepare: vi.fn(async () => { throw new Error('checksum mismatch') }) })
    const log = vi.fn()
    const { updater, announce, notifyReady } = make({ backend, log })
    expect(updater.offer(UPDATE)).toBe(true)
    await settle()
    expect(updater.menuState()).toEqual({ enabled: true, phase: 'failed', version: 'v1.2.0' })
    expect(announce).toHaveBeenCalledWith(UPDATE)
    expect(notifyReady).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('checksum mismatch'))
    expect(updater.apply()).toBe(false)
    expect(updater.applyOnQuit()).toBe(false)
    expect(backend.apply).not.toHaveBeenCalled()
    expect(backend.applyOnQuit).not.toHaveBeenCalled()
  })

  it('a later check tries again, three times in all for one version', async () => {
    const backend = fakeBackend({ prepare: vi.fn(async () => { throw new Error('offline') }) })
    const { updater } = make({ backend })
    for (let attempt = 0; attempt < a.MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      expect(updater.offer(UPDATE)).toBe(true)
      await settle()
    }
    expect(updater.offer(UPDATE)).toBe(false)
    expect(backend.prepare).toHaveBeenCalledTimes(3)
    // A different release starts its own count
    expect(updater.offer(NEXT)).toBe(true)
  })

  it('a retry that works ends ready', async () => {
    let calls = 0
    const backend = fakeBackend({ prepare: vi.fn(async (update: { version: string }) => { if (++calls === 1) throw new Error('offline'); return { version: update.version } }) })
    const { updater, notifyReady } = make({ backend })
    updater.offer(UPDATE)
    await settle()
    updater.offer(UPDATE)
    await settle()
    expect(updater.menuState().phase).toBe('ready')
    expect(notifyReady).toHaveBeenCalledTimes(1)
  })

  it('an install that could not start: the marker is cleared and the download page is offered', async () => {
    for (const apply of [vi.fn(() => false), vi.fn(() => { throw new Error('spawn failed') })]) {
      const ready = make({ backend: fakeBackend({ apply }) })
      ready.updater.offer(UPDATE)
      await settle()
      expect(ready.updater.apply()).toBe(false)
      expect(apply).toHaveBeenCalledTimes(1)
      expect(ready.quit).not.toHaveBeenCalled()
      expect(ready.updater.menuState().phase).toBe('failed')
      expect(u.readUpdateState(ready.file).applying).toBeUndefined()
    }
  })
})

describe('createAutoUpdater: "Update automatically"', () => {
  it('off: nothing is downloaded and the check is told to carry on as before', async () => {
    const file = stateFile()
    u.writeUpdateState(file, { autoUpdate: false })
    const { updater, backend, notifyReady, announce } = make({ stateFile: file })
    expect(backend.setEnabled).toHaveBeenCalledWith(false)
    expect(updater.menuState().enabled).toBe(false)
    expect(updater.offer(UPDATE)).toBe(false)
    await settle()
    expect(backend.prepare).not.toHaveBeenCalled()
    expect(notifyReady).not.toHaveBeenCalled()
    expect(announce).not.toHaveBeenCalled()
    expect(updater.apply()).toBe(false)
    expect(updater.applyOnQuit()).toBe(false)
  })

  it('is remembered, and switching it on starts on the release already found', async () => {
    const file = stateFile()
    u.writeUpdateState(file, { autoUpdate: false })
    const { updater, backend, onChange } = make({ stateFile: file })
    updater.setEnabled(true, UPDATE)
    expect(u.readAutoUpdate(file)).toBe(true)
    expect(backend.setEnabled).toHaveBeenLastCalledWith(true)
    expect(onChange).toHaveBeenCalled()
    await settle()
    expect(updater.menuState()).toEqual({ enabled: true, phase: 'ready', version: 'v1.2.0' })

    updater.setEnabled(false)
    expect(u.readAutoUpdate(file)).toBe(false)
    expect(make({ stateFile: file }).updater.menuState().enabled).toBe(false)
  })

  it('switched off with a download ready: it is not applied, on click or on quit, and is still there when switched back on', async () => {
    const { updater, backend } = make()
    updater.offer(UPDATE)
    await settle()
    updater.setEnabled(false)
    expect(updater.apply()).toBe(false)
    expect(updater.applyOnQuit()).toBe(false)
    expect(backend.apply).not.toHaveBeenCalled()
    expect(backend.applyOnQuit).not.toHaveBeenCalled()
    updater.setEnabled(true, UPDATE)
    await settle()
    expect(backend.prepare).toHaveBeenCalledTimes(1)
    expect(updater.menuState().phase).toBe('ready')
  })

  it('switched off while downloading: the download finishes quietly, with no notification', async () => {
    const { updater, notifyReady } = make()
    updater.offer(UPDATE)
    updater.setEnabled(false)
    await settle()
    expect(notifyReady).not.toHaveBeenCalled()
    expect(updater.menuState()).toEqual({ enabled: false, phase: 'ready', version: 'v1.2.0' })
  })
})

describe('createAutoUpdater: applying', () => {
  it('"Restart to update": the marker is written, the backend installs with a relaunch, the app quits; once', async () => {
    const { updater, backend, quit, file } = make()
    expect(updater.apply()).toBe(false)
    updater.offer(UPDATE)
    await settle()
    expect(updater.apply()).toBe(true)
    expect(backend.apply).toHaveBeenCalledWith({ relaunch: true })
    expect(quit).toHaveBeenCalledTimes(1)
    expect(u.readUpdateState(file).applying).toBe('v1.2.0')
    // The quit that follows must not start a second install, nor a second click
    expect(updater.applyOnQuit()).toBe(false)
    expect(updater.apply()).toBe(false)
    expect(backend.apply).toHaveBeenCalledTimes(1)
    expect(backend.applyOnQuit).not.toHaveBeenCalled()
    // Nor does a check that lands before the app has gone start a download
    expect(updater.offer(NEXT)).toBe(false)
  })

  it('a backend that quits the app itself is not followed by a second quit', async () => {
    const { updater, quit } = make({ backend: fakeBackend({ quitsItself: true }) })
    updater.offer(UPDATE)
    await settle()
    expect(updater.apply()).toBe(true)
    expect(quit).not.toHaveBeenCalled()
  })

  it('quitting with an update ready installs it on the way out, where the backend can', async () => {
    const { updater, backend, quit, file } = make()
    expect(updater.applyOnQuit()).toBe(false)
    updater.offer(UPDATE)
    await settle()
    expect(updater.applyOnQuit()).toBe(true)
    expect(backend.applyOnQuit).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    expect(u.readUpdateState(file).applying).toBe('v1.2.0')

    const none = make({ backend: fakeBackend({ applyOnQuit: vi.fn(() => false) }) })
    none.updater.offer(UPDATE)
    await settle()
    expect(none.updater.applyOnQuit()).toBe(false)
    expect(u.readUpdateState(none.file).applying).toBeUndefined()
  })
})

describe('createAutoUpdater: the start after an install', () => {
  it('running the new version: the marker is cleared', () => {
    const file = stateFile()
    u.writeUpdateState(file, { applying: 'v1.2.0', failedVersion: 'v1.1.9' })
    const { updater } = make({ stateFile: file, currentVersion: '1.2.0' })
    expect(updater.lastOutcome).toBe('applied')
    expect(u.readUpdateState(file)).toEqual({})
  })

  it('still the old version: that release is offered as a download from now on, the next one is tried afresh', async () => {
    const file = stateFile()
    u.writeUpdateState(file, { applying: 'v1.2.0' })
    const first = make({ stateFile: file })
    expect(first.updater.lastOutcome).toBe('failed')
    expect(u.readUpdateState(file)).toEqual({ failedVersion: 'v1.2.0' })
    expect(first.updater.offer(UPDATE)).toBe(false)
    expect(first.backend.prepare).not.toHaveBeenCalled()

    // Remembered across starts
    const second = make({ stateFile: file })
    expect(second.updater.lastOutcome).toBe('none')
    expect(second.updater.offer(UPDATE)).toBe(false)
    expect(second.updater.offer(NEXT)).toBe(true)
    await settle()
    expect(second.updater.menuState()).toEqual({ enabled: true, phase: 'ready', version: 'v1.3.0' })
  })

  it('a failure recorded for a version since installed by hand is forgotten', () => {
    const file = stateFile()
    u.writeUpdateState(file, { failedVersion: 'v1.2.0' })
    make({ stateFile: file, currentVersion: '1.2.0' })
    expect(u.readUpdateState(file)).toEqual({})
  })
})

describe('createElectronUpdaterBackend (Windows and Linux)', () => {
  /** What the backend uses of electron-updater's `autoUpdater`, with its real defaults. */
  function fakeElectronUpdater(version = '1.2.0') {
    const calls: string[] = []
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: true,
      allowDowngrade: false,
      allowPrerelease: false,
      autoInstallOnAppQuit: true,
      logger: null as unknown,
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version }, cancellationToken: 'token' })),
      downloadUpdate: vi.fn(async () => ['/tmp/installer']),
      quitAndInstall: vi.fn(() => { calls.push('quitAndInstall') }),
    })
    return { updater, calls }
  }

  function backendFor(platform: string, version?: string) {
    const fake = fakeElectronUpdater(version)
    const load = vi.fn(() => ({ autoUpdater: fake.updater }))
    const beforeInstall = vi.fn(() => { fake.calls.push('beforeInstall') })
    const backend = a.createElectronUpdaterBackend({ currentVersion: '1.1.2', platform, beforeInstall, log: () => {}, load })
    return { backend, load, beforeInstall, ...fake }
  }

  it('electron-updater is not loaded until a download is asked for', async () => {
    const { backend, load } = backendFor('win32')
    backend.setEnabled(true)
    expect(backend.applyOnQuit()).toBe(false)
    expect(backend.apply({ relaunch: true })).toBe(false)
    expect(load).not.toHaveBeenCalled()
    await backend.prepare(UPDATE)
    await backend.prepare(UPDATE)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('prepare: nothing downloads by itself, no downgrade, no pre-release; then check and download', async () => {
    const { backend, updater } = backendFor('win32')
    expect(await backend.prepare(UPDATE)).toEqual({ version: 'v1.2.0' })
    expect(updater.autoDownload).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.downloadUpdate).toHaveBeenCalledWith('token')
    // An 'error' event with no listener would throw
    expect(() => updater.emit('error', new Error('net::ERR_FAILED'))).not.toThrow()
  })

  it('reports the version electron-updater found, not the one the check passed in', async () => {
    const { backend } = backendFor('win32', '1.3.0')
    expect(await backend.prepare(UPDATE)).toEqual({ version: 'v1.3.0' })
  })

  it('nothing newer in the feed (a draft not yet published, an older build): no download, a rejection', async () => {
    for (const version of ['1.1.2', '1.0.0', 'garbage']) {
      const { backend, updater } = backendFor('win32', version)
      await expect(backend.prepare(UPDATE)).rejects.toThrow('no newer version')
      expect(updater.downloadUpdate).not.toHaveBeenCalled()
      expect(backend.apply({ relaunch: true })).toBe(false)
    }
    const none = backendFor('win32')
    none.updater.checkForUpdates.mockResolvedValueOnce(null as never)
    await expect(none.backend.prepare(UPDATE)).rejects.toThrow('no newer version')
  })

  it('a failed check or download rejects, and nothing can be applied', async () => {
    const { backend, updater, beforeInstall } = backendFor('linux')
    updater.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'))
    await expect(backend.prepare(UPDATE)).rejects.toThrow('sha512 checksum mismatch')
    expect(backend.apply({ relaunch: true })).toBe(false)
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('apply: beforeInstall, then quitAndInstall(silent, run after) — the assisted NSIS installer needs both', async () => {
    const { backend, updater, calls } = backendFor('win32')
    await backend.prepare(UPDATE)
    expect(backend.apply({ relaunch: true })).toBe(true)
    expect(calls).toEqual(['beforeInstall', 'quitAndInstall'])
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(backend.quitsItself).toBe(true)
  })

  it('install on quit: Windows only, and only while "Update automatically" is on', async () => {
    const win = backendFor('win32')
    await win.backend.prepare(UPDATE)
    expect(win.updater.autoInstallOnAppQuit).toBe(true)
    expect(win.backend.applyOnQuit()).toBe(true)
    win.backend.setEnabled(false)
    expect(win.updater.autoInstallOnAppQuit).toBe(false)
    expect(win.backend.applyOnQuit()).toBe(false)
    win.backend.setEnabled(true)
    expect(win.updater.autoInstallOnAppQuit).toBe(true)

    // Switched off before electron-updater was ever loaded
    const off = backendFor('win32')
    off.backend.setEnabled(false)
    await off.backend.prepare(UPDATE)
    expect(off.updater.autoInstallOnAppQuit).toBe(false)

    const linux = backendFor('linux')
    await linux.backend.prepare(UPDATE)
    expect(linux.updater.autoInstallOnAppQuit).toBe(false)
    expect(linux.backend.applyOnQuit()).toBe(false)
  })

  it('under createAutoUpdater: ready after the download, and the app is not asked to quit twice', async () => {
    const { backend, updater } = backendFor('win32')
    const { updater: flow, quit, notifyReady } = make({ backend })
    expect(flow.offer(UPDATE)).toBe(true)
    await settle()
    expect(flow.menuState()).toEqual({ enabled: true, phase: 'ready', version: 'v1.2.0' })
    expect(notifyReady).toHaveBeenCalledTimes(1)
    expect(flow.apply()).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(quit).not.toHaveBeenCalled()
  })

  it('the real module is installed, at a version with the API used here', () => {
    const version = require('electron-updater/package.json').version
    expect(u.compareVersions(version, '6.0.0')).toBe(1)
  })
})
