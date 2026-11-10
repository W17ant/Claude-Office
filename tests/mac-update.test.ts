/**
 * mac-update.test.ts - the macOS updater's I/O (electron/mac-update.cjs) and
 * its swap helper (electron/mac-swap.sh), without Electron or the network.
 *
 * The download runs against a local server through the `get` option: the
 * updater still builds and checks real github.com URLs, and the transport
 * here only decides where the bytes come from. On macOS the unpack uses the
 * real ditto and the swap runs the real helper against a fake .app in a temp
 * directory; those tests are skipped elsewhere.
 */

import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const m = require('../electron/mac-update.cjs')
const p = require('../electron/update-plan.cjs')

const onMac = process.platform === 'darwin'
const RELEASE = 'github.com/W17ant/Claude-Office/releases/download'
const ZIP_NAME = 'Agent-Office-1.2.0-mac-arm64.zip'
const UPDATE = { version: 'v1.2.0', url: 'https://github.com/W17ant/Claude-Office/releases/tag/v1.2.0' }

const sha512 = (data: Buffer | string) => createHash('sha512').update(data).digest('base64')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `check` is true (the helper runs detached; its work shows up on disk). */
async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

// ---------------------------------------------------------------------------
// A local stand-in for GitHub: routes are keyed "<host><path>"
// ---------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void
const routes = new Map<string, Handler>()
let server: http.Server
let port = 0
/** Every URL the updater asked for, as it asked for it. */
let seen: string[] = []

/** The transport handed to the updater: the same call shape as https.get, answered locally. */
const get = (url: string, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
  seen.push(url)
  const target = new URL(url)
  return http.get(`http://127.0.0.1:${port}/${target.host}${target.pathname}${target.search}`, { headers: options.headers, timeout: options.timeout }, callback)
}

const body = (data: Buffer | string, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(data)), ...headers })
  res.end(data)
}
const redirect = (location: string, status = 302): Handler => (_req, res) => {
  res.writeHead(status, { Location: location })
  res.end()
}
/** A body sent with no Content-Length, so only the running count can stop it. */
const chunked = (data: Buffer): Handler => (_req, res) => {
  res.writeHead(200)
  res.write(data.subarray(0, data.length / 2))
  res.end(data.subarray(data.length / 2))
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const handler = routes.get((req.url || '').slice(1).split('?')[0])
    if (handler) return handler(req, res)
    res.writeHead(404)
    res.end('Not Found')
  })
  // Why port 0: any free port; nothing here may touch the office's own ports
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const dirs: string[] = []
/** A scratch directory, by its real path (macOS's temp dir is behind a symlink, and `ps` reports real paths). */
function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-office-mac-update-')))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  routes.clear()
  seen = []
  for (const dir of dirs.splice(0)) {
    // Why: some tests take write permission away from a bundle to make a move fail
    try { execFileSync('/bin/chmod', ['-R', 'u+w', dir]) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

const opts = { get, userAgent: 'Agent-Office/1.1.2' }

describe('openDownload: https, GitHub hosts only, every redirect checked', () => {
  it('a URL outside the allowlist is refused before anything is sent', async () => {
    const spy = vi.fn(get)
    for (const url of ['http://github.com/a', 'https://example.com/a.zip', 'https://github.com:8443/a', 'file:///etc/passwd']) {
      await expect(m.openDownload(url, { ...opts, get: spy })).rejects.toThrow('outside GitHub')
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('sends only a User-Agent, and follows a redirect to GitHub\'s asset host', async () => {
    let headers: http.IncomingHttpHeaders = {}
    routes.set(`${RELEASE}/v1.2.0/a.zip`, redirect('https://release-assets.githubusercontent.com/asset/1?sig=abc'))
    routes.set('release-assets.githubusercontent.com/asset/1', (req, res) => { headers = req.headers; body('zip bytes')(req, res) })
    expect(await m.fetchText(`https://${RELEASE}/v1.2.0/a.zip`, { ...opts, maxBytes: 100 })).toBe('zip bytes')
    expect(seen).toEqual([`https://${RELEASE}/v1.2.0/a.zip`, 'https://release-assets.githubusercontent.com/asset/1?sig=abc'])
    expect(headers['user-agent']).toBe('Agent-Office/1.1.2')
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
  })

  it('a redirect anywhere else is refused: another host, plain http, a relative path off the allowlist is still GitHub', async () => {
    routes.set(`${RELEASE}/v1.2.0/evil.zip`, redirect('https://downloads.example.com/a.zip'))
    routes.set(`${RELEASE}/v1.2.0/plain.zip`, redirect('http://release-assets.githubusercontent.com/asset/1'))
    routes.set(`${RELEASE}/v1.2.0/local.zip`, redirect('http://127.0.0.1:1/a.zip'))
    routes.set(`${RELEASE}/v1.2.0/relative.zip`, redirect('/W17ant/Claude-Office/elsewhere.zip', 301))
    routes.set('github.com/W17ant/Claude-Office/elsewhere.zip', body('moved'))
    for (const name of ['evil.zip', 'plain.zip', 'local.zip']) {
      await expect(m.fetchText(`https://${RELEASE}/v1.2.0/${name}`, { ...opts, maxBytes: 100 })).rejects.toThrow('outside GitHub')
    }
    // Only the first hop of each was ever requested
    expect(seen.filter((url) => !url.includes('github.com/W17ant'))).toEqual([])
    expect(await m.fetchText(`https://${RELEASE}/v1.2.0/relative.zip`, { ...opts, maxBytes: 100 })).toBe('moved')
  })

  it('a redirect loop ends after five hops; a redirect with no Location is refused', async () => {
    routes.set(`${RELEASE}/v1.2.0/loop.zip`, redirect(`https://${RELEASE}/v1.2.0/loop.zip`))
    await expect(m.fetchText(`https://${RELEASE}/v1.2.0/loop.zip`, { ...opts, maxBytes: 100 })).rejects.toThrow('too many redirects')
    expect(seen).toHaveLength(p.MAX_REDIRECTS + 1)
    routes.set(`${RELEASE}/v1.2.0/nowhere.zip`, (_req, res) => { res.writeHead(302); res.end() })
    // With no Location the "next" URL is the same one again, until the hops run out
    await expect(m.fetchText(`https://${RELEASE}/v1.2.0/nowhere.zip`, { ...opts, maxBytes: 100 })).rejects.toThrow('too many redirects')
  })

  it('anything but a 200 is an error', async () => {
    await expect(m.fetchText(`https://${RELEASE}/v1.2.0/missing.yml`, { ...opts, maxBytes: 100 })).rejects.toThrow('HTTP 404')
    routes.set(`${RELEASE}/v1.2.0/limited.yml`, (_req, res) => { res.writeHead(403); res.end('rate limited') })
    await expect(m.fetchText(`https://${RELEASE}/v1.2.0/limited.yml`, { ...opts, maxBytes: 100 })).rejects.toThrow('HTTP 403')
  })

  it('a server that goes silent times out', async () => {
    routes.set(`${RELEASE}/v1.2.0/slow.yml`, () => { /* never answers */ })
    await expect(m.fetchText(`https://${RELEASE}/v1.2.0/slow.yml`, { ...opts, maxBytes: 100, idleTimeoutMs: 150 })).rejects.toThrow('timed out')
  })
})

describe('fetchText and downloadFile: the size cap', () => {
  it('fetchText refuses a body over the cap', async () => {
    routes.set(`${RELEASE}/v1.2.0/big.yml`, body('x'.repeat(200)))
    await expect(m.fetchText(`https://${RELEASE}/v1.2.0/big.yml`, { ...opts, maxBytes: 100 })).rejects.toThrow('too large')
    expect(await m.fetchText(`https://${RELEASE}/v1.2.0/big.yml`, { ...opts, maxBytes: 200 })).toHaveLength(200)
  })

  it('downloadFile writes the bytes to a new private file and says how many', async () => {
    const data = Buffer.from('a'.repeat(70_000))
    routes.set(`${RELEASE}/v1.2.0/a.zip`, body(data))
    const dest = join(scratch(), 'update.zip')
    expect(await m.downloadFile(`https://${RELEASE}/v1.2.0/a.zip`, dest, { ...opts, maxBytes: 70_000 })).toBe(70_000)
    expect(readFileSync(dest).equals(data)).toBe(true)
    expect(statSync(dest).mode & 0o077).toBe(0)
    expect(await m.sha512File(dest)).toBe(sha512(data))
  })

  it('a download that announces itself as too large is not started', async () => {
    routes.set(`${RELEASE}/v1.2.0/a.zip`, body(Buffer.alloc(5000)))
    const dest = join(scratch(), 'update.zip')
    await expect(m.downloadFile(`https://${RELEASE}/v1.2.0/a.zip`, dest, { ...opts, maxBytes: 4999 })).rejects.toThrow('too large')
    expect(existsSync(dest)).toBe(false)
  })

  it('one that does not announce its size is stopped at the cap, and the partial file removed', async () => {
    routes.set(`${RELEASE}/v1.2.0/a.zip`, chunked(Buffer.alloc(200_000)))
    const dest = join(scratch(), 'update.zip')
    await expect(m.downloadFile(`https://${RELEASE}/v1.2.0/a.zip`, dest, { ...opts, maxBytes: 100_000 })).rejects.toThrow('too large')
    expect(existsSync(dest)).toBe(false)
  })

  it('never writes over a file that is already there, and leaves it alone', async () => {
    routes.set(`${RELEASE}/v1.2.0/a.zip`, body('new'))
    const dest = join(scratch(), 'update.zip')
    writeFileSync(dest, 'already here')
    await expect(m.downloadFile(`https://${RELEASE}/v1.2.0/a.zip`, dest, { ...opts, maxBytes: 100 })).rejects.toThrow()
    expect(readFileSync(dest, 'utf8')).toBe('already here')
  })
})

describe('cleanStaleStages', () => {
  it('removes only real staging directories older than an hour', () => {
    const parent = scratch()
    const old = new Date(Date.now() - m.STALE_STAGE_MS - 60_000)
    const stage = (name: string, aged: boolean) => {
      const dir = join(parent, name)
      mkdirSync(dir)
      writeFileSync(join(dir, 'update.zip'), 'x')
      if (aged) utimesSync(dir, old, old)
      return dir
    }
    const stale = stage(`${p.STAGE_PREFIX}AbC123`, true)
    const fresh = stage(`${p.STAGE_PREFIX}fresh1`, false)
    const inUse = stage(`${p.STAGE_PREFIX}inUse1`, true)
    const otherName = stage('.agent-office-update-toolong1', true)
    const someoneElses = stage('Some Other.app', true)
    // A symlink with a staging name is not followed
    const target = stage('precious', true)
    const link = join(parent, `${p.STAGE_PREFIX}link12`)
    symlinkSync(target, link)

    expect(m.cleanStaleStages(parent, { keep: inUse })).toEqual([stale])
    for (const kept of [fresh, inUse, otherName, someoneElses, target, link]) expect(existsSync(kept), kept).toBe(true)
    expect(existsSync(join(target, 'update.zip'))).toBe(true)
    expect(m.cleanStaleStages(join(parent, 'no-such-folder'))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The backend: prepare (download, verify, unpack) and apply (the swap helper)
// ---------------------------------------------------------------------------

/** A minimal app bundle. Its "executable" writes its version and arguments to launched.txt beside the bundle. */
function makeApp(dir: string, { version, id = 'com.agentoffice.app', name = 'Agent Office' }: { version: string, id?: string, name?: string }) {
  const app = join(dir, `${name}.app`)
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(app, 'Contents', 'Resources'))
  writeFileSync(join(app, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `\t<key>CFBundleExecutable</key>\n\t<string>${name}</string>`,
    `\t<key>CFBundleIdentifier</key>\n\t<string>${id}</string>`,
    `\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n'))
  const exe = join(app, 'Contents', 'MacOS', name)
  writeFileSync(exe, `#!/bin/sh\nprintf '%s\\n' "${version}" "$@" > "$(dirname "$0")/../../../launched.txt"\n`)
  chmodSync(exe, 0o755)
  writeFileSync(join(app, 'Contents', 'Resources', 'version.txt'), version)
  return app
}

const installedVersion = (app: string) => readFileSync(join(app, 'Contents', 'Resources', 'version.txt'), 'utf8')
const stagesIn = (parent: string) => readdirSync(parent).filter((name) => name.startsWith(p.STAGE_PREFIX))

/** latest-mac.yml for one zip. */
const feed = (zip: Buffer, { version = '1.2.0', name = ZIP_NAME, sha = sha512(zip), size = zip.length as number | null } = {}) =>
  `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n${size === null ? '' : `    size: ${size}\n`}path: ${name}\nsha512: ${sha}\nreleaseDate: '2026-11-10T10:00:00.000Z'\n`

/** Publish a release on the local server: the feed, and the zip behind the redirect GitHub answers with. */
function publish(zip: Buffer, feedText = feed(zip)) {
  routes.set(`${RELEASE}/v1.2.0/latest-mac.yml`, body(feedText))
  routes.set(`${RELEASE}/v1.2.0/${ZIP_NAME}`, redirect('https://release-assets.githubusercontent.com/asset/1?sig=abc'))
  routes.set('release-assets.githubusercontent.com/asset/1', body(zip))
}

/** An installed 1.1.2 in a scratch "Applications" folder, and a backend for it. */
function installed(over: Record<string, unknown> = {}) {
  const parent = scratch()
  const bundle = makeApp(parent, { version: '1.1.2' })
  const userData = scratch()
  const log = vi.fn()
  const backend = m.createMacBackend({ bundle, parent, currentVersion: '1.1.2', arch: 'arm64', userData, getPids: () => [], log, get, ...over })
  return { parent, bundle, userData, log, backend, swapLog: join(userData, m.SWAP_LOG_NAME) }
}

/** Zip a fake app the way a release does: the .app at the top of the archive. */
function zipOf(options: { version: string, id?: string, name?: string }, extra?: (app: string) => void) {
  const dir = scratch()
  const app = makeApp(dir, options)
  if (extra) extra(app)
  const zip = join(dir, 'app.zip')
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip])
  return readFileSync(zip)
}

describe('createMacBackend.prepare: what stops an update before anything is unpacked', () => {
  const junkZip = Buffer.from('PK\u0003\u0004 not really a zip')

  it('never an equal or older version: nothing is requested', async () => {
    const { backend, parent } = installed()
    await expect(backend.prepare({ version: 'v1.1.2' })).rejects.toThrow('not a newer version')
    await expect(backend.prepare({ version: 'v1.0.0' })).rejects.toThrow('not a newer version')
    await expect(backend.prepare({ version: 'latest' })).rejects.toThrow('not a newer version')
    expect(seen).toEqual([])
    expect(stagesIn(parent)).toEqual([])
  })

  it('asks GitHub for that release\'s latest-mac.yml, and stops when it is not there', async () => {
    const { backend, parent } = installed()
    await expect(backend.prepare(UPDATE)).rejects.toThrow('HTTP 404')
    expect(seen).toEqual(['https://github.com/W17ant/Claude-Office/releases/download/v1.2.0/latest-mac.yml'])
    expect(stagesIn(parent)).toEqual([])
    expect(backend.staged).toBeNull()
  })

  it('a feed with no zip for this architecture, for another version, or that is not a feed: nothing is downloaded', async () => {
    const { backend, parent } = installed()
    const cases = [
      feed(junkZip, { name: 'Agent-Office-1.2.0-mac-x64.zip' }),
      feed(junkZip, { name: 'Agent-Office-1.2.0-mac-arm64.dmg' }),
      feed(junkZip, { version: '1.3.0' }),
      feed(junkZip, { sha: 'not-a-checksum' }),
      '<html>Sign in to continue</html>',
    ]
    for (const text of cases) {
      seen = []
      routes.set(`${RELEASE}/v1.2.0/latest-mac.yml`, body(text))
      await expect(backend.prepare(UPDATE)).rejects.toThrow('no macOS arm64 zip')
      expect(seen).toHaveLength(1)
    }
    expect(stagesIn(parent)).toEqual([])
  })

  it('a checksum that does not match: nothing is unpacked, nothing is left behind, nothing can be applied', async () => {
    const { backend, parent, bundle } = installed()
    publish(junkZip, feed(junkZip, { sha: sha512('a different file') }))
    await expect(backend.prepare(UPDATE)).rejects.toThrow('checksum mismatch')
    expect(seen).toHaveLength(3)
    expect(stagesIn(parent)).toEqual([])
    expect(backend.staged).toBeNull()
    expect(backend.apply({ relaunch: true })).toBe(false)
    expect(backend.applyOnQuit()).toBe(false)
    expect(installedVersion(bundle)).toBe('1.1.2')
  })

  it('a download that is not the size the release says, shorter or longer', async () => {
    const { backend, parent } = installed()
    publish(junkZip, feed(junkZip, { size: junkZip.length + 1 }))
    await expect(backend.prepare(UPDATE)).rejects.toThrow('not the size')
    publish(junkZip, feed(junkZip, { size: junkZip.length - 1 }))
    await expect(backend.prepare(UPDATE)).rejects.toThrow('too large')
    expect(stagesIn(parent)).toEqual([])
  })

  it.skipIf(!onMac)('a file with the right checksum that is not a zip fails to unpack, and is cleaned up', async () => {
    const { backend, parent } = installed()
    publish(junkZip)
    await expect(backend.prepare(UPDATE)).rejects.toThrow('could not unpack')
    expect(stagesIn(parent)).toEqual([])
  })
})

describe.skipIf(!onMac)('createMacBackend.prepare on macOS: the real unpack', () => {
  it('downloads, verifies and unpacks the app beside the installed one, modes and symlinks intact', async () => {
    const zip = zipOf({ version: '1.2.0' }, (app) => symlinkSync('version.txt', join(app, 'Contents', 'Resources', 'current')))
    publish(zip)
    const { backend, parent, bundle, log } = installed()
    expect(await backend.prepare(UPDATE)).toEqual({ version: 'v1.2.0' })

    const staged = backend.staged
    expect(stagesIn(parent)).toHaveLength(1)
    expect(staged.stageDir).toBe(join(parent, stagesIn(parent)[0]))
    expect(staged.app).toBe(join(staged.stageDir, 'unpacked', 'Agent Office.app'))
    expect(installedVersion(staged.app)).toBe('1.2.0')
    expect(statSync(join(staged.app, 'Contents', 'MacOS', 'Agent Office')).mode & 0o111).toBe(0o111)
    expect(readFileSync(join(staged.app, 'Contents', 'Resources', 'current'), 'utf8')).toBe('1.2.0')
    // The zip is gone once unpacked; the installed app is untouched until apply
    expect(existsSync(join(staged.stageDir, 'update.zip'))).toBe(false)
    expect(installedVersion(bundle)).toBe('1.1.2')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('downloaded and verified'))

    // Asked again for the same version: what is staged is reused, nothing is fetched
    seen = []
    expect(await backend.prepare(UPDATE)).toEqual({ version: 'v1.2.0' })
    expect(seen).toEqual([])
    backend.discard()
    expect(stagesIn(parent)).toEqual([])
    expect(backend.staged).toBeNull()
  })

  it('a feed with no size still downloads (the Windows feed has none), under the overall cap', async () => {
    const zip = zipOf({ version: '1.2.0' })
    publish(zip, feed(zip, { size: null }))
    const { backend } = installed()
    expect(await backend.prepare(UPDATE)).toEqual({ version: 'v1.2.0' })
  })

  it('refuses an archive that is another app, another version, two apps, or has no executable', async () => {
    const check = async (zip: Buffer, message: string) => {
      publish(zip)
      const { backend, parent } = installed()
      await expect(backend.prepare(UPDATE)).rejects.toThrow(message)
      expect(stagesIn(parent)).toEqual([])
      expect(backend.staged).toBeNull()
    }
    await check(zipOf({ version: '1.2.0', id: 'com.example.other' }), 'wrong-bundle-id')
    // A correctly checksummed older build under the new name: the downgrade a swapped asset would be
    await check(zipOf({ version: '1.1.0' }), 'wrong-version')
    await check(zipOf({ version: '1.3.0' }), 'wrong-version')
    await check(zipOf({ version: '1.2.0' }, (app) => rmSync(join(app, 'Contents', 'MacOS', 'Agent Office'))), 'ENOENT')

    // Two bundles in one archive
    const dir = scratch()
    const both = join(dir, 'both')
    mkdirSync(both)
    makeApp(both, { version: '1.2.0' })
    makeApp(both, { version: '1.2.0', name: 'Second' })
    const zip = join(dir, 'both.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', both, zip])
    await check(readFileSync(zip), 'exactly one app')
  })

  it('stale staging directories from an earlier crash are cleared on the way', async () => {
    const zip = zipOf({ version: '1.2.0' })
    publish(zip)
    const { backend, parent } = installed()
    const stale = join(parent, `${p.STAGE_PREFIX}oldOne`)
    mkdirSync(stale)
    const old = new Date(Date.now() - m.STALE_STAGE_MS - 60_000)
    utimesSync(stale, old, old)
    await backend.prepare(UPDATE)
    expect(existsSync(stale)).toBe(false)
    expect(stagesIn(parent)).toHaveLength(1)
  })
})

describe.skipIf(!onMac)('mac-swap.sh: the real helper against a fake app', () => {
  /** An installed 1.1.2 and a staged 1.2.0 beside it, as prepare() leaves them. */
  function staged() {
    const parent = scratch()
    const app = makeApp(parent, { version: '1.1.2' })
    const stage = mkdtempSync(join(parent, p.STAGE_PREFIX))
    mkdirSync(join(stage, 'unpacked'))
    const next = makeApp(join(stage, 'unpacked'), { version: '1.2.0' })
    const log = join(scratch(), 'update-swap.log')
    const args = (over: { pids?: number[], relaunch?: boolean, argv?: string[], staged?: string } = {}) => p.swapHelperArgs({
      pids: over.pids || [], bundle: app, staged: over.staged || next, stageDir: stage, logFile: log, relaunch: over.relaunch === true, argv: over.argv || [],
    })
    const run = (over?: Parameters<typeof args>[0]) => spawnSync('/bin/sh', [m.SWAP_HELPER, ...args(over)], { encoding: 'utf8', cwd: '/' })
    const launched = join(parent, 'launched.txt')
    return { parent, app, stage, next, log, args, run, launched }
  }

  it('swaps the new bundle in, removes the staging directory with the old bundle, and logs it', () => {
    const s = staged()
    const result = s.run()
    expect(result.status).toBe(0)
    expect(installedVersion(s.app)).toBe('1.2.0')
    expect(existsSync(s.stage)).toBe(false)
    expect(readdirSync(s.parent)).toEqual(['Agent Office.app'])
    expect(readFileSync(s.log, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ updated .*Agent Office\.app\n$/)
    // relaunch 0: nothing was started
    expect(existsSync(s.launched)).toBe(false)
    // Nothing is printed: the helper runs with no terminal
    expect(result.stdout + result.stderr).toBe('')
  })

  it('relaunch 1 starts the new app with the arguments the old one had', async () => {
    const s = staged()
    expect(s.run({ relaunch: true, argv: ['--compact', 'two words'] }).status).toBe(0)
    expect(await waitFor(() => existsSync(s.launched))).toBe(true)
    await waitFor(() => readFileSync(s.launched, 'utf8').split('\n').length >= 4)
    expect(readFileSync(s.launched, 'utf8')).toBe('1.2.0\n--compact\ntwo words\n')
  })

  it('the new bundle cannot be moved in: the old one is put back and started again (exit 1)', async () => {
    const s = staged()
    // Why this fails the second move only: renaming a directory into another
    // folder needs write permission on the directory itself.
    chmodSync(s.next, 0o555)
    const result = s.run({ relaunch: true })
    expect(result.status).toBe(1)
    expect(installedVersion(s.app)).toBe('1.1.2')
    expect(existsSync(join(s.stage, 'previous.app'))).toBe(false)
    expect(readFileSync(s.log, 'utf8')).toContain('the old one was put back')
    expect(await waitFor(() => existsSync(s.launched) && readFileSync(s.launched, 'utf8').startsWith('1.1.2'))).toBe(true)
  })

  it('the installed bundle cannot be moved aside (no permission): nothing changes (exit 1)', () => {
    const s = staged()
    chmodSync(s.app, 0o555)
    const result = s.run()
    expect(result.status).toBe(1)
    expect(installedVersion(s.app)).toBe('1.1.2')
    expect(installedVersion(s.next)).toBe('1.2.0')
    expect(readFileSync(s.log, 'utf8')).toContain('nothing changed')
  })

  it('refuses a new bundle outside the staging directory, or a missing one', () => {
    const s = staged()
    const elsewhere = makeApp(scratch(), { version: '1.2.0' })
    expect(s.run({ staged: elsewhere }).status).toBe(1)
    expect(s.run({ staged: join(s.stage, 'unpacked', 'Missing.app') }).status).toBe(1)
    expect(installedVersion(s.app)).toBe('1.1.2')
    expect(existsSync(elsewhere)).toBe(true)
    expect(readFileSync(s.log, 'utf8')).toMatch(/refused: the new app is not in the staging directory\n.*refused: the installed app or the new one is missing/)
  })

  it('waits for the app\'s processes to exit before it moves anything', async () => {
    const s = staged()
    const app = spawn('/bin/sleep', ['1.5'])
    const child = spawn('/bin/sleep', ['0.3'])
    const done = new Promise<number | null>((resolve) => {
      execFile('/bin/sh', [m.SWAP_HELPER, ...s.args({ pids: [app.pid!, child.pid!] })], { cwd: '/' }, (err) => resolve(err ? (err as { code?: number }).code ?? 1 : 0))
    })
    await sleep(800)
    // One of the two has gone, the other is still running: nothing has moved
    expect(installedVersion(s.app)).toBe('1.1.2')
    expect(existsSync(s.next)).toBe(true)
    expect(await done).toBe(0)
    expect(installedVersion(s.app)).toBe('1.2.0')
  }, 15_000)

  it('waits for anything still running from inside the bundle, whatever pids it was given', async () => {
    const s = staged()
    // A process whose executable is in the bundle, as the app reopened during the wait would be
    const exe = join(s.app, 'Contents', 'MacOS', 'still-running')
    // Why a copy of node and not of /bin/sleep: macOS kills a copied system
    // binary on launch. FICLONE makes the copy free on APFS.
    copyFileSync(process.execPath, exe, constants.COPYFILE_FICLONE)
    chmodSync(exe, 0o755)
    const running = spawn(exe, ['-e', 'setTimeout(() => {}, 1500)'])
    const exited = new Promise((resolve) => running.on('exit', resolve))
    // Give it time to be a process `ps` lists
    await sleep(300)
    expect(running.exitCode).toBeNull()
    const done = new Promise<number | null>((resolve) => {
      execFile('/bin/sh', [m.SWAP_HELPER, ...s.args()], { cwd: '/' }, (err) => resolve(err ? (err as { code?: number }).code ?? 1 : 0))
    })
    await sleep(600)
    expect(installedVersion(s.app)).toBe('1.1.2')
    await exited
    expect(await done).toBe(0)
    expect(installedVersion(s.app)).toBe('1.2.0')
  }, 15_000)

  it('createMacBackend.apply starts it detached with the right arguments: downloaded, verified, swapped, relaunched', async () => {
    const zip = zipOf({ version: '1.2.0' })
    publish(zip)
    const waited = spawn('/bin/sleep', ['0.5'])
    const { backend, parent, bundle, swapLog } = installed({ getPids: () => [waited.pid, undefined], argv: ['--compact'] })
    await backend.prepare(UPDATE)
    expect(backend.apply({ relaunch: true })).toBe(true)
    // The staging directory is the helper's from here
    expect(backend.staged).toBeNull()
    expect(backend.apply({ relaunch: true })).toBe(false)

    expect(await waitFor(() => existsSync(join(parent, 'launched.txt')) && installedVersion(bundle) === '1.2.0')).toBe(true)
    await waitFor(() => readFileSync(join(parent, 'launched.txt'), 'utf8').endsWith('--compact\n'))
    expect(readFileSync(join(parent, 'launched.txt'), 'utf8')).toBe('1.2.0\n--compact\n')
    expect(stagesIn(parent)).toEqual([])
    expect(readFileSync(swapLog, 'utf8')).toContain('updated ')
  }, 15_000)

  it('applyOnQuit swaps without starting the app', async () => {
    const zip = zipOf({ version: '1.2.0' })
    publish(zip)
    const { backend, parent, bundle, swapLog } = installed()
    await backend.prepare(UPDATE)
    expect(backend.applyOnQuit()).toBe(true)
    expect(await waitFor(() => existsSync(swapLog) && readFileSync(swapLog, 'utf8').includes('updated '))).toBe(true)
    expect(installedVersion(bundle)).toBe('1.2.0')
    await sleep(300)
    expect(existsSync(join(parent, 'launched.txt'))).toBe(false)
  }, 15_000)

  it('the helper is a POSIX script that parses, and is shipped inside the app', () => {
    expect(spawnSync('/bin/sh', ['-n', m.SWAP_HELPER]).status).toBe(0)
    expect(m.SWAP_HELPER.endsWith(join('electron', 'mac-swap.sh'))).toBe(true)
    // Why the last line matters: the script lives in the bundle it removes, so
    // it must be read in full before it starts (see its header).
    expect(readFileSync(m.SWAP_HELPER, 'utf8').trimEnd().split('\n').pop()).toBe('main "$@"; exit')
  })
})
