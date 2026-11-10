/**
 * update-plan.test.ts - the desktop updater's decisions, run without Electron,
 * a network or a disk: whether an install can update itself (and the reasons
 * it falls back to the download page), reading latest-mac.yml, choosing the
 * zip for a version and architecture, the URL allowlist, the checksum gate,
 * the unpacked bundle's identity check and what a restart makes of an install
 * that was started.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const p = require('../electron/update-plan.cjs')
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))

const sha = (text: string) => createHash('sha512').update(text).digest('base64')
const ARM_SHA = sha('arm64 zip')
const X64_SHA = sha('x64 zip')

/** latest-mac.yml as electron-builder writes it for a release with a dmg and a zip per architecture. */
const feedText = (version = '1.2.0') => `version: ${version}
files:
  - url: Agent-Office-${version}-mac-arm64.zip
    sha512: ${ARM_SHA}
    size: 155311142
  - url: Agent-Office-${version}-mac-x64.zip
    sha512: ${X64_SHA}
    size: 160272051
  - url: Agent-Office-${version}-mac-arm64.dmg
    sha512: ${sha('arm64 dmg')}
    size: 158000000
path: Agent-Office-${version}-mac-arm64.zip
sha512: ${ARM_SHA}
releaseDate: '2026-11-09T19:55:55.327Z'
`

describe('updateStrategy: can this install update itself', () => {
  const mac = {
    platform: 'darwin', arch: 'arm64', packaged: true,
    execPath: '/Applications/Agent Office.app/Contents/MacOS/Agent Office',
    env: {}, canWrite: () => true,
  }

  it('a checkout never updates itself, on any platform', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(p.updateStrategy({ ...mac, platform, packaged: false })).toEqual({ kind: 'manual', reason: 'not-packaged' })
    }
  })

  it('macOS in a writable folder: swap the bundle in place', () => {
    expect(p.updateStrategy(mac)).toEqual({ kind: 'mac-swap', bundle: '/Applications/Agent Office.app', parent: '/Applications' })
    expect(p.updateStrategy({ ...mac, arch: 'x64' }).kind).toBe('mac-swap')
  })

  it('macOS falls back to the download page: translocated, not in a .app, a folder or bundle it may not write, no asset', () => {
    const reason = (over: object) => p.updateStrategy({ ...mac, ...over })
    expect(reason({ execPath: '/private/var/folders/ab/T/AppTranslocation/1234-ABCD/d/Agent Office.app/Contents/MacOS/Agent Office' }))
      .toEqual({ kind: 'manual', reason: 'translocated' })
    expect(reason({ execPath: '/usr/local/bin/agent-office' })).toEqual({ kind: 'manual', reason: 'not-app-bundle' })
    expect(reason({ execPath: '/opt/office/Contents/MacOS/Agent Office' })).toEqual({ kind: 'manual', reason: 'not-app-bundle' })
    expect(reason({ canWrite: () => false })).toEqual({ kind: 'manual', reason: 'parent-not-writable' })
    // A mounted dmg: /Volumes/<name> is read-only
    expect(reason({
      execPath: '/Volumes/Agent Office 1.1.2-arm64/Agent Office.app/Contents/MacOS/Agent Office',
      canWrite: (target: string) => !target.startsWith('/Volumes/'),
    })).toEqual({ kind: 'manual', reason: 'parent-not-writable' })
    expect(reason({ canWrite: (target: string) => target === '/Applications' })).toEqual({ kind: 'manual', reason: 'bundle-not-writable' })
    expect(reason({ arch: 'ia32' })).toEqual({ kind: 'manual', reason: 'no-asset' })
  })

  it('with no canWrite given, nothing is assumed writable', () => {
    const { canWrite: _omit, ...rest } = mac
    expect(p.updateStrategy(rest)).toEqual({ kind: 'manual', reason: 'parent-not-writable' })
  })

  it('Windows x64: electron-updater; any other architecture has no installer', () => {
    const win = { platform: 'win32', arch: 'x64', packaged: true, execPath: 'C:\\Program Files\\Agent Office\\Agent Office.exe' }
    expect(p.updateStrategy(win)).toEqual({ kind: 'electron-updater' })
    expect(p.updateStrategy({ ...win, arch: 'arm64' })).toEqual({ kind: 'manual', reason: 'no-asset' })
  })

  it('Linux: only an AppImage in a writable folder', () => {
    const linux = { platform: 'linux', arch: 'x64', packaged: true, execPath: '/tmp/.mount_AgentXYZ/agent-office', canWrite: () => true }
    expect(p.updateStrategy({ ...linux, env: { APPIMAGE: '/home/me/Apps/Agent-Office-1.1.2-linux-x86_64.AppImage' } })).toEqual({ kind: 'electron-updater' })
    expect(p.updateStrategy({ ...linux, env: {} })).toEqual({ kind: 'manual', reason: 'not-appimage' })
    expect(p.updateStrategy({ ...linux, env: { APPIMAGE: 'relative.AppImage' } })).toEqual({ kind: 'manual', reason: 'not-appimage' })
    expect(p.updateStrategy({ ...linux, env: { APPIMAGE: '/opt/office.AppImage' }, canWrite: () => false })).toEqual({ kind: 'manual', reason: 'appimage-not-writable' })
    expect(p.updateStrategy({ ...linux, arch: 'arm64', env: { APPIMAGE: '/home/me/office.AppImage' } })).toEqual({ kind: 'manual', reason: 'no-asset' })
  })

  it('any other platform: the download page', () => {
    expect(p.updateStrategy({ platform: 'freebsd', arch: 'x64', packaged: true, execPath: '/usr/bin/office' })).toEqual({ kind: 'manual', reason: 'no-asset' })
  })
})

describe('macBundlePath', () => {
  it('is the .app three levels above the executable, and nothing else', () => {
    expect(p.macBundlePath('/Applications/Agent Office.app/Contents/MacOS/Agent Office')).toBe('/Applications/Agent Office.app')
    expect(p.macBundlePath('/Users/me/Apps/A.app/Contents/MacOS/A')).toBe('/Users/me/Apps/A.app')
    expect(p.macBundlePath('/Applications/Agent Office.app/Contents/Frameworks/X.framework/X')).toBeNull()
    expect(p.macBundlePath('/.app/Contents/MacOS/A')).toBeNull()
    expect(p.macBundlePath('Agent Office.app/Contents/MacOS/Agent Office')).toBeNull()
    expect(p.macBundlePath(undefined)).toBeNull()
  })
})

describe('asset names and URLs', () => {
  it('the zip is named by package.json artifactName, for the two architectures a release builds', () => {
    const fromConfig = (version: string, arch: string) => pkg.build.artifactName
      .replace('${version}', version).replace('${os}', 'mac').replace('${arch}', arch).replace('${ext}', 'zip')
    expect(p.macAssetName('v1.2.0', 'arm64')).toBe(fromConfig('1.2.0', 'arm64'))
    expect(p.macAssetName('1.2.0', 'x64')).toBe('Agent-Office-1.2.0-mac-x64.zip')
    expect(p.macAssetName('1.2.0', 'ia32')).toBeNull()
    expect(p.macAssetName('latest', 'arm64')).toBeNull()
    expect(pkg.build.mac.target.find((t: any) => t.target === 'zip').arch).toEqual(p.MAC_ARCHES)
  })

  it('an asset URL is under the release for that tag, and a name cannot climb out of it', () => {
    expect(p.releaseAssetUrl('1.2.0', 'latest-mac.yml')).toBe('https://github.com/W17ant/Claude-Office/releases/download/v1.2.0/latest-mac.yml')
    expect(p.releaseAssetUrl('v1.2.0', 'Agent-Office-1.2.0-mac-arm64.zip')).toBe('https://github.com/W17ant/Claude-Office/releases/download/v1.2.0/Agent-Office-1.2.0-mac-arm64.zip')
    for (const name of ['../../other/file.zip', 'a/b.zip', 'x.zip?token=1', '', '.hidden', 'a b.zip']) {
      expect(p.releaseAssetUrl('1.2.0', name)).toBeNull()
    }
    expect(p.releaseAssetUrl('nightly', 'latest-mac.yml')).toBeNull()
    expect(pkg.repository.url).toContain('github.com/W17ant/Claude-Office')
  })

  it('the bundle id is the one the app is built with', () => {
    expect(p.APP_BUNDLE_ID).toBe(pkg.build.appId)
  })
})

describe('isAllowedDownloadUrl: https to GitHub and its asset hosts, nothing else', () => {
  it('allows github.com and the two hosts a release asset redirects to', () => {
    expect(p.isAllowedDownloadUrl('https://github.com/W17ant/Claude-Office/releases/download/v1.2.0/latest-mac.yml')).toBe(true)
    expect(p.isAllowedDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=abc')).toBe(true)
    expect(p.isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2?X-Amz-Signature=abc')).toBe(true)
  })

  it('refuses http, other hosts, look-alike hosts, ports, credentials and junk', () => {
    for (const url of [
      'http://github.com/W17ant/Claude-Office/releases/download/v1.2.0/latest-mac.yml',
      'https://example.com/Agent-Office-1.2.0-mac-arm64.zip',
      'https://github.com.evil.example/a.zip',
      'https://evilgithub.com/a.zip',
      'https://raw.githubusercontent.com/a/b/main/a.zip',
      'https://github.com:8443/a.zip',
      'https://user:pass@github.com/a.zip',
      'https://github.com@evil.example/a.zip',
      'file:///Applications/a.zip',
      'ftp://github.com/a.zip',
      '//github.com/a.zip',
      '',
      `https://github.com/${'a'.repeat(5000)}`,
    ]) {
      expect(p.isAllowedDownloadUrl(url), url).toBe(false)
    }
    expect(p.isAllowedDownloadUrl(undefined)).toBe(false)
    expect(p.isAllowedDownloadUrl({ href: 'https://github.com/' })).toBe(false)
  })
})

describe('parseUpdateFeed: latest-mac.yml', () => {
  it('reads the version and every file with its checksum and size', () => {
    const feed = p.parseUpdateFeed(feedText())
    expect(feed.version).toBe('1.2.0')
    expect(feed.files).toHaveLength(3)
    expect(feed.files[0]).toEqual({ url: 'Agent-Office-1.2.0-mac-arm64.zip', sha512: ARM_SHA, size: 155311142 })
    expect(feed.files[1].sha512).toBe(X64_SHA)
  })

  it('reads the real v1.1.2 feed (dmg only), CRLF line endings, quoted scalars and keys it does not know', () => {
    const real = [
      'version: 1.1.2',
      'files:',
      '  - url: Agent-Office-1.1.2-mac-arm64.dmg',
      '    sha512: 36KwlgLtg+J+vYgueQx8LWlC/uCO7XqhPbzihduDc5XqE+YSbt1wZoPHWklZB3XLsNv2NzzxNSpvar+YQDAHhg==',
      '    size: 155311142',
      '    blockMapSize: 163051',
      '  - url: "Agent-Office-1.1.2-mac-x64.dmg"',
      '    sha512: MzbwQ43QCBC1QW/AFPGvzDjBAJv0otpppjpu3quoLgv7u3i2bxZVejRCY28nuXm2+hWREQD1Hxb+lARdgGWwUg==',
      'path: Agent-Office-1.1.2-mac-arm64.dmg',
      'sha512: 36KwlgLtg+J+vYgueQx8LWlC/uCO7XqhPbzihduDc5XqE+YSbt1wZoPHWklZB3XLsNv2NzzxNSpvar+YQDAHhg==',
      "releaseDate: '2026-11-09T19:55:55.327Z'",
      '',
    ].join('\r\n')
    const feed = p.parseUpdateFeed(real)
    expect(feed.version).toBe('1.1.2')
    expect(feed.files.map((f: any) => f.url)).toEqual(['Agent-Office-1.1.2-mac-arm64.dmg', 'Agent-Office-1.1.2-mac-x64.dmg'])
    expect(feed.files[0].size).toBe(155311142)
    // No size line (the Windows feed has none): null, not 0
    expect(feed.files[1].size).toBeNull()
  })

  it('is null for anything that is not that file', () => {
    for (const text of [
      '',
      'not yaml at all',
      '<html><body>Not Found</body></html>',
      '{"version":"1.2.0"}',
      'files:\n  - url: a.zip\n',                       // no version
      'version: latest\nfiles:\n',                      // not a version
      'version: 1.2.0\n  stray: indent\n',              // indented outside the list
      'version: 1.2.0\nfiles:\n    sha512: abc\n',      // a continuation with no entry
      'version: 1.2.0\nfiles:\n  - url: a.zip\n      deep: 1\n',
      'version: 1.2.0\nfiles:\n\t- url: a.zip\n',       // a tab
      'version: 1.2.0\nfiles: [a, b]\n  - url: a.zip\n',
      `version: 1.2.0\nfiles:\n${'  - url: a.zip\n'.repeat(51)}`,
      `version: 1.2.0\n# ${'x'.repeat(p.MAX_FEED_BYTES)}\n`,
    ]) {
      expect(p.parseUpdateFeed(text), JSON.stringify(text.slice(0, 40))).toBeNull()
    }
    expect(p.parseUpdateFeed(null)).toBeNull()
    expect(p.parseUpdateFeed(Buffer.from(feedText()))).toBeNull()
  })

  it('a size that is not a plain number is no size', () => {
    const feed = p.parseUpdateFeed('version: 1.2.0\nfiles:\n  - url: a.zip\n    sha512: x\n    size: -5\n  - url: b.zip\n    size: 1e9\n')
    expect(feed.files.map((f: any) => f.size)).toEqual([null, null])
  })
})

describe('chooseMacAsset: the one zip for this version and architecture', () => {
  const feed = () => p.parseUpdateFeed(feedText())

  it('picks the zip for the architecture, with its URL, checksum and size', () => {
    expect(p.chooseMacAsset(feed(), { version: 'v1.2.0', arch: 'arm64' })).toEqual({
      name: 'Agent-Office-1.2.0-mac-arm64.zip',
      url: 'https://github.com/W17ant/Claude-Office/releases/download/v1.2.0/Agent-Office-1.2.0-mac-arm64.zip',
      sha512: ARM_SHA,
      size: 155311142,
    })
    const x64 = p.chooseMacAsset(feed(), { version: '1.2.0', arch: 'x64' })
    expect(x64.name).toBe('Agent-Office-1.2.0-mac-x64.zip')
    expect(x64.sha512).toBe(X64_SHA)
  })

  it('never the dmg, the other architecture, or a file from another version', () => {
    const dmgOnly = p.parseUpdateFeed('version: 1.1.2\nfiles:\n  - url: Agent-Office-1.1.2-mac-arm64.dmg\n    sha512: ' + ARM_SHA + '\n    size: 5\n')
    expect(p.chooseMacAsset(dmgOnly, { version: '1.1.2', arch: 'arm64' })).toBeNull()
    const armOnly = p.parseUpdateFeed(`version: 1.2.0\nfiles:\n  - url: Agent-Office-1.2.0-mac-arm64.zip\n    sha512: ${ARM_SHA}\n    size: 5\n`)
    expect(p.chooseMacAsset(armOnly, { version: '1.2.0', arch: 'x64' })).toBeNull()
    expect(p.chooseMacAsset(feed(), { version: '1.2.0', arch: 'ia32' })).toBeNull()
  })

  it('a feed for a different version than the release that was found is not followed, older or newer', () => {
    expect(p.chooseMacAsset(p.parseUpdateFeed(feedText('1.1.0')), { version: '1.2.0', arch: 'arm64' })).toBeNull()
    expect(p.chooseMacAsset(p.parseUpdateFeed(feedText('1.3.0')), { version: '1.2.0', arch: 'arm64' })).toBeNull()
  })

  it('no usable checksum, or a size past the cap: nothing to download', () => {
    const withEntry = (lines: string) => p.parseUpdateFeed(`version: 1.2.0\nfiles:\n  - url: Agent-Office-1.2.0-mac-arm64.zip\n${lines}`)
    expect(p.chooseMacAsset(withEntry('    size: 5\n'), { version: '1.2.0', arch: 'arm64' })).toBeNull()
    expect(p.chooseMacAsset(withEntry('    sha512: abc\n    size: 5\n'), { version: '1.2.0', arch: 'arm64' })).toBeNull()
    // A sha256 is the wrong length
    expect(p.chooseMacAsset(withEntry(`    sha512: ${createHash('sha256').update('x').digest('base64')}\n`), { version: '1.2.0', arch: 'arm64' })).toBeNull()
    expect(p.chooseMacAsset(withEntry(`    sha512: ${ARM_SHA}\n    size: ${p.MAX_UPDATE_BYTES + 1}\n`), { version: '1.2.0', arch: 'arm64' })).toBeNull()
    expect(p.chooseMacAsset(withEntry(`    sha512: ${ARM_SHA}\n    size: 0\n`), { version: '1.2.0', arch: 'arm64' })).toBeNull()
    // No size line: allowed, the cap applies while downloading
    expect(p.chooseMacAsset(withEntry(`    sha512: ${ARM_SHA}\n`), { version: '1.2.0', arch: 'arm64' })).toMatchObject({ size: null })
    expect(p.chooseMacAsset(null, { version: '1.2.0', arch: 'arm64' })).toBeNull()
  })

  it('the cap is about three times the size of a release today', () => {
    expect(p.MAX_UPDATE_BYTES).toBe(512 * 1024 * 1024)
    expect(p.MAX_UPDATE_BYTES).toBeGreaterThan(160272051 * 3)
  })
})

describe('sha512Matches: the checksum gate', () => {
  it('true only for two equal, well-formed sha512 digests', () => {
    expect(p.sha512Matches(ARM_SHA, sha('arm64 zip'))).toBe(true)
    expect(p.sha512Matches(ARM_SHA, X64_SHA)).toBe(false)
    expect(p.sha512Matches(ARM_SHA, ARM_SHA.toLowerCase())).toBe(false)
    expect(p.sha512Matches('', '')).toBe(false)
    expect(p.sha512Matches('abc', 'abc')).toBe(false)
    expect(p.sha512Matches(undefined, undefined)).toBe(false)
    expect(p.sha512Matches(ARM_SHA, undefined)).toBe(false)
    // Hex is not what the feed carries
    const hex = createHash('sha512').update('arm64 zip').digest('hex')
    expect(p.sha512Matches(hex, hex)).toBe(false)
  })
})

describe('checkBundle: the unpacked app is this app at the expected version', () => {
  const plist = (over: Record<string, string> = {}) => {
    const values: Record<string, string> = {
      CFBundleExecutable: 'Agent Office',
      CFBundleIdentifier: 'com.agentoffice.app',
      CFBundleShortVersionString: '1.2.0',
      ...over,
    }
    const body = Object.entries(values).map(([k, v]) => `\t<key>${k}</key>\n\t<string>${v}</string>`).join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
  }

  it('accepts the right bundle id and version, and names its executable', () => {
    expect(p.checkBundle(plist(), { version: 'v1.2.0' })).toEqual({ ok: true, executable: 'Agent Office' })
  })

  it('refuses another app, another version (older or newer), and an executable that is not one path segment', () => {
    expect(p.checkBundle(plist({ CFBundleIdentifier: 'com.example.other' }), { version: '1.2.0' })).toEqual({ ok: false, reason: 'wrong-bundle-id' })
    expect(p.checkBundle(plist({ CFBundleShortVersionString: '1.1.2' }), { version: '1.2.0' })).toEqual({ ok: false, reason: 'wrong-version' })
    expect(p.checkBundle(plist({ CFBundleShortVersionString: '1.3.0' }), { version: '1.2.0' })).toEqual({ ok: false, reason: 'wrong-version' })
    expect(p.checkBundle(plist({ CFBundleExecutable: '../../../bin/sh' }), { version: '1.2.0' })).toEqual({ ok: false, reason: 'no-executable' })
    expect(p.checkBundle(plist({ CFBundleExecutable: '..' }), { version: '1.2.0' })).toEqual({ ok: false, reason: 'no-executable' })
    expect(p.checkBundle('bplist00\u0000\u0001', { version: '1.2.0' })).toEqual({ ok: false, reason: 'wrong-bundle-id' })
    expect(p.checkBundle(undefined, { version: '1.2.0' }).ok).toBe(false)
  })

  it('plistString reads one string value and unescapes it', () => {
    expect(p.plistString(plist({ CFBundleExecutable: 'A &amp; B' }), 'CFBundleExecutable')).toBe('A & B')
    expect(p.plistString(plist(), 'CFBundleName')).toBeNull()
    expect(p.plistString(plist(), 'CFBundle.*')).toBeNull()
  })
})

describe('applyOutcome: what a restart makes of an install that was started', () => {
  it('none without a marker; applied when the running version reached it; failed when it did not', () => {
    expect(p.applyOutcome({ applying: undefined, currentVersion: '1.1.2' })).toBe('none')
    expect(p.applyOutcome({ applying: 'v1.2.0', currentVersion: '1.2.0' })).toBe('applied')
    expect(p.applyOutcome({ applying: 'v1.2.0', currentVersion: '1.3.0' })).toBe('applied')
    expect(p.applyOutcome({ applying: 'v1.2.0', currentVersion: '1.1.2' })).toBe('failed')
  })
})

describe('swapHelperArgs', () => {
  it('lays the arguments out as mac-swap.sh reads them, and drops pids that are not processes', () => {
    expect(p.swapHelperArgs({
      pids: [4321, undefined, 4400, 0, 1, NaN],
      bundle: '/Applications/Agent Office.app',
      staged: '/Applications/.agent-office-update-AbC123/unpacked/Agent Office.app',
      stageDir: '/Applications/.agent-office-update-AbC123',
      logFile: '/Users/me/Library/Application Support/agent-office/update-swap.log',
      relaunch: true,
      argv: ['--compact'],
    })).toEqual([
      '4321,4400',
      '/Applications/Agent Office.app',
      '/Applications/.agent-office-update-AbC123/unpacked/Agent Office.app',
      '/Applications/.agent-office-update-AbC123',
      '/Users/me/Library/Application Support/agent-office/update-swap.log',
      '1',
      '--compact',
    ])
    expect(p.swapHelperArgs({ pids: [], bundle: 'a', staged: 'b', stageDir: 'c', logFile: 'd', relaunch: false })[5]).toBe('0')
  })
})
