'use strict'

/**
 * update-plan.cjs - every decision the desktop updater makes, as pure functions.
 *
 * Nothing here touches the network, the disk or Electron, so
 * tests/update-plan.test.ts runs all of it in plain Node:
 *
 *   updateStrategy     can this install update itself, and how
 *   parseUpdateFeed    electron-builder's latest-mac.yml, read strictly
 *   chooseMacAsset     the one zip for this version and architecture
 *   isAllowedDownloadUrl   https, GitHub's hosts, nothing else
 *   sha512Matches      the checksum gate
 *   checkBundle        is the unpacked app this app, at the expected version
 *   applyOutcome       did the install started before the last quit take
 *
 * mac-update.cjs does what these decide; auto-update.cjs runs the flow.
 *
 * The trust model, stated once: the app is not signed, so there is no
 * signature to check. An update is whatever the project's own GitHub release
 * serves over https, and the sha512 in latest-mac.yml (same release, same
 * transport) proves the zip arrived whole, not who built it. That is the
 * same trust as downloading the dmg from the release page by hand.
 */

const path = require('path')
const { compareVersions, normaliseTag } = require('./update-check.cjs')

// Must equal `build.appId` in package.json (tests/update-plan.test.ts checks):
// an unpacked bundle with any other identifier is not this app and is never
// swapped in.
const APP_BUNDLE_ID = 'com.agentoffice.app'

// Where release assets are fetched from. A literal, on purpose: there is no
// setting, argument or environment variable that points a packaged app's
// updater anywhere else.
const RELEASE_DOWNLOAD_PREFIX = 'https://github.com/W17ant/Claude-Office/releases/download/'

// Why these three: a release asset URL on github.com answers 302 to a signed
// URL on one of GitHub's two asset hosts (objects.* is the older, release-assets.*
// the current one). A redirect to anywhere else is refused.
const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']

// Why 5: github.com -> asset host is one hop; five leaves room for GitHub to
// add one without letting a redirect loop spin.
const MAX_REDIRECTS = 5

// Why 64 KB: latest-mac.yml is under 1 KB (a few lines per asset).
const MAX_FEED_BYTES = 64 * 1024

// Why 512 MB: the app is about 160 MB per architecture today (Electron plus
// the office's art). Three times that is room to grow; past it the download
// is not this app and is not worth the disk.
const MAX_UPDATE_BYTES = 512 * 1024 * 1024

// Why 4096: a signed asset URL runs to about 1 KB of query string.
const MAX_DOWNLOAD_URL_LEN = 4096

const MAC_FEED_NAME = 'latest-mac.yml'

// The staging directory's name prefix, beside the installed app (see
// mac-update.cjs): hidden, and recognisable so a stale one can be cleared.
const STAGE_PREFIX = '.agent-office-update-'

// The architectures a release carries a macOS zip for (package.json build.mac)
const MAC_ARCHES = ['arm64', 'x64']

// ---------------------------------------------------------------------------
// Can this install update itself
// ---------------------------------------------------------------------------

/**
 * The `.app` a macOS executable lives in, or null when it is not the main
 * executable of a bundle (`<X>.app/Contents/MacOS/<name>`).
 * @param {unknown} execPath  process.execPath
 * @returns {string | null}
 */
function macBundlePath(execPath) {
  if (typeof execPath !== 'string' || !path.posix.isAbsolute(execPath)) return null
  const macos = path.posix.dirname(execPath)
  const contents = path.posix.dirname(macos)
  const bundle = path.posix.dirname(contents)
  if (path.posix.basename(macos) !== 'MacOS' || path.posix.basename(contents) !== 'Contents') return null
  if (!bundle.endsWith('.app') || path.posix.basename(bundle) === '.app') return null
  return bundle
}

/**
 * How this install can be updated.
 *
 *   { kind: 'mac-swap', bundle, parent }   macOS: replace the .app in place
 *   { kind: 'electron-updater' }           Windows (NSIS) and Linux (AppImage)
 *   { kind: 'manual', reason }             it cannot: offer the download page
 *
 * @param {object} opts
 * @param {string} opts.platform  process.platform
 * @param {string} opts.arch  process.arch
 * @param {boolean} opts.packaged  app.isPackaged
 * @param {string} opts.execPath  process.execPath
 * @param {Record<string, string | undefined>} [opts.env]  process.env (only APPIMAGE is read)
 * @param {(target: string) => boolean} [opts.canWrite]  whether this user may write to a path
 * @returns {{ kind: 'mac-swap', bundle: string, parent: string } | { kind: 'electron-updater' } | { kind: 'manual', reason: string }}
 */
function updateStrategy({ platform, arch, packaged, execPath, env = {}, canWrite = () => false }) {
  const manual = (reason) => ({ kind: 'manual', reason })
  // Why first: a checkout (`npm run dev:electron`) updates with git, and must
  // never rewrite itself.
  if (!packaged) return manual('not-packaged')

  if (platform === 'darwin') {
    if (!MAC_ARCHES.includes(arch)) return manual('no-asset')
    // Why: an app opened straight from Downloads or a dmg runs from a random
    // read-only path under /private/var/folders/.../AppTranslocation/. The
    // real bundle is somewhere else and cannot be found from here.
    if (typeof execPath === 'string' && execPath.includes('/AppTranslocation/')) return manual('translocated')
    const bundle = macBundlePath(execPath)
    if (!bundle) return manual('not-app-bundle')
    const parent = path.posix.dirname(bundle)
    // Why both: moving the old bundle out and the new one in needs write on
    // the folder that holds it (a mounted dmg, another user's /Applications),
    // and renaming a directory into a different folder needs write on the
    // directory itself.
    if (!canWrite(parent)) return manual('parent-not-writable')
    if (!canWrite(bundle)) return manual('bundle-not-writable')
    return { kind: 'mac-swap', bundle, parent }
  }

  // Why x64 only: it is the one architecture the release builds for Windows
  // and Linux (package.json names no other).
  if (platform === 'win32') {
    return arch === 'x64' ? { kind: 'electron-updater' } : manual('no-asset')
  }

  if (platform === 'linux') {
    if (arch !== 'x64') return manual('no-asset')
    // Why: only an AppImage can replace itself (electron-updater needs the
    // path the runtime exports); an unpacked build has nothing to swap.
    const appImage = env && env.APPIMAGE
    if (typeof appImage !== 'string' || !path.posix.isAbsolute(appImage)) return manual('not-appimage')
    if (!canWrite(path.posix.dirname(appImage))) return manual('appimage-not-writable')
    return { kind: 'electron-updater' }
  }

  return manual('no-asset')
}

// ---------------------------------------------------------------------------
// Names and URLs
// ---------------------------------------------------------------------------

/** "1.2.3" for "v1.2.3" or "1.2.3"; null when it is not a version. */
function bareVersion(version) {
  const tag = normaliseTag(version)
  return tag ? tag.slice(1) : null
}

/**
 * The macOS zip's file name in a release: package.json `build.artifactName`
 * for os "mac" and ext "zip".
 * @param {string} version  "v1.2.3" or "1.2.3"
 * @param {string} arch  process.arch
 * @returns {string | null} null for a version or architecture no release has
 */
function macAssetName(version, arch) {
  const bare = bareVersion(version)
  if (!bare || !MAC_ARCHES.includes(arch)) return null
  return `Agent-Office-${bare}-mac-${arch}.zip`
}

/**
 * The URL of one asset of the release tagged for `version`.
 * @param {string} version
 * @param {string} name  a bare file name
 * @returns {string | null}
 */
function releaseAssetUrl(version, name) {
  const tag = normaliseTag(version)
  // Why so narrow: the name comes from the feed, and must not be able to
  // climb out of the release's folder or carry a query.
  if (!tag || typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return null
  return `${RELEASE_DOWNLOAD_PREFIX}${tag}/${name}`
}

/**
 * Whether a URL may be requested by the updater: https, on github.com or one
 * of its two asset hosts, default port, no credentials. Applied to the first
 * URL and to every redirect.
 * @param {unknown} value
 * @returns {boolean}
 */
function isAllowedDownloadUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_DOWNLOAD_URL_LEN) return false
  let url
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false
  return DOWNLOAD_HOSTS.includes(url.hostname)
}

// ---------------------------------------------------------------------------
// The feed: electron-builder's latest-mac.yml
//
//   version: 1.2.0
//   files:
//     - url: Agent-Office-1.2.0-mac-arm64.zip
//       sha512: <base64>
//       size: 155311142
//   path: Agent-Office-1.2.0-mac-arm64.zip
//   sha512: <base64>
//   releaseDate: '2026-11-09T19:55:55.327Z'
// ---------------------------------------------------------------------------

// Why a hand-written reader and no yaml dependency: the file has one shape,
// written by one tool. Reading exactly that shape and nothing else means
// there are no anchors, tags, flow collections or multi-line scalars for an
// odd file to surprise us with: a line that is not `key: scalar` in one of
// the three places below makes the whole feed unusable.
const FEED_LINE = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/

// Why 50: a release lists two to four files; a longer list is not this feed.
const MAX_FEED_FILES = 50

/** A scalar's text: the bare word, or the inside of one pair of matching quotes. */
function feedScalar(raw) {
  const text = (raw || '').trim()
  const quoted = /^'([^']*)'$/.exec(text) || /^"([^"\\]*)"$/.exec(text)
  return quoted ? quoted[1] : text
}

/**
 * Parse latest-mac.yml.
 * @param {unknown} text
 * @returns {{ version: string, files: { url: string, sha512: string, size: number | null }[] } | null}
 *   null for anything that is not that file
 */
function parseUpdateFeed(text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > MAX_FEED_BYTES) return null
  const top = {}
  const files = []
  let inFiles = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    if (rawLine.includes('\t')) return null
    const indent = rawLine.length - rawLine.trimStart().length
    const body = rawLine.slice(indent)

    if (indent === 0) {
      const m = FEED_LINE.exec(body)
      if (!m) return null
      inFiles = m[1] === 'files' && m[2] === undefined
      if (!inFiles) top[m[1]] = feedScalar(m[2])
      continue
    }
    if (!inFiles) return null
    // `  - key: value` opens an entry; `    key: value` adds to the open one
    if (indent === 2 && body.startsWith('- ')) {
      if (files.length >= MAX_FEED_FILES) return null
      const m = FEED_LINE.exec(body.slice(2))
      if (!m) return null
      files.push({ [m[1]]: feedScalar(m[2]) })
    } else if (indent === 4 && files.length) {
      const m = FEED_LINE.exec(body)
      if (!m) return null
      files[files.length - 1][m[1]] = feedScalar(m[2])
    } else {
      return null
    }
  }
  if (!bareVersion(top.version)) return null
  return {
    version: top.version,
    files: files.map((f) => ({
      url: typeof f.url === 'string' ? f.url : '',
      sha512: typeof f.sha512 === 'string' ? f.sha512 : '',
      size: /^\d{1,12}$/.test(f.size || '') ? Number(f.size) : null,
    })),
  }
}

// A sha512 digest is 64 bytes: 86 base64 characters and "==".
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/

/** Whether a value is a base64 sha512 digest. */
function isSha512(value) {
  return typeof value === 'string' && SHA512_BASE64.test(value)
}

/**
 * The zip to download for a version and architecture, from a parsed feed.
 *
 * @param {ReturnType<typeof parseUpdateFeed>} feed
 * @param {{ version: string, arch: string }} want  the release found by the check, and process.arch
 * @returns {{ name: string, url: string, sha512: string, size: number | null } | null}
 *   null when the feed is for another version, has no zip for this
 *   architecture, or the entry has no usable checksum or an impossible size
 */
function chooseMacAsset(feed, { version, arch }) {
  if (!feed || !Array.isArray(feed.files)) return null
  // Why: the feed is fetched from the release the check named; one that says
  // another version (an asset uploaded to the wrong release) is not followed.
  if (compareVersions(feed.version, version) !== 0) return null
  const name = macAssetName(version, arch)
  const url = name && releaseAssetUrl(version, name)
  if (!url) return null
  // Why by exact name: the dmg and the other architecture's zip are in the
  // same list, and nothing but this file is ever unpacked.
  const entry = feed.files.find((f) => f && f.url === name)
  if (!entry || !isSha512(entry.sha512)) return null
  if (entry.size !== null && (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_UPDATE_BYTES)) return null
  return { name, url, sha512: entry.sha512, size: entry.size }
}

/**
 * The checksum gate: does a file's digest equal the feed's.
 * @param {unknown} expected  base64 sha512 from the feed
 * @param {unknown} actual  base64 sha512 of the downloaded file
 * @returns {boolean} false unless both are well-formed digests and equal
 */
function sha512Matches(expected, actual) {
  return isSha512(expected) && isSha512(actual) && expected === actual
}

// ---------------------------------------------------------------------------
// The unpacked bundle
// ---------------------------------------------------------------------------

/**
 * A string value from an XML Info.plist (`<key>K</key><string>V</string>`).
 * @param {unknown} xml
 * @param {string} key
 * @returns {string | null} null when absent, or when the plist is binary
 */
function plistString(xml, key) {
  if (typeof xml !== 'string' || !/^[A-Za-z0-9]+$/.test(key)) return null
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  if (!m) return null
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

/**
 * Whether an unpacked bundle is this app at the expected version, from its
 * Info.plist. The zip's checksum already matched; this catches a release
 * whose zip holds the wrong build (another version, another app).
 *
 * @param {unknown} infoPlistXml  Contents/Info.plist as text
 * @param {{ version: string }} want
 * @returns {{ ok: true, executable: string } | { ok: false, reason: string }}
 */
function checkBundle(infoPlistXml, { version }) {
  if (plistString(infoPlistXml, 'CFBundleIdentifier') !== APP_BUNDLE_ID) return { ok: false, reason: 'wrong-bundle-id' }
  if (compareVersions(plistString(infoPlistXml, 'CFBundleShortVersionString') || '', version) !== 0) return { ok: false, reason: 'wrong-version' }
  const executable = plistString(infoPlistXml, 'CFBundleExecutable')
  // Why: the name is joined onto Contents/MacOS/ and launched; it must be one
  // path segment.
  if (!executable || executable.length > 100 || /[/\u0000]/.test(executable) || executable === '.' || executable === '..') {
    return { ok: false, reason: 'no-executable' }
  }
  return { ok: true, executable }
}

// ---------------------------------------------------------------------------
// After the restart
// ---------------------------------------------------------------------------

/**
 * What became of an install started before the last quit.
 *
 * @param {{ applying?: string | null, currentVersion: string }} opts
 *   `applying` is the version written to the state file just before the app
 *   quit to install it; `currentVersion` is the version now running
 * @returns {'none' | 'applied' | 'failed'}
 */
function applyOutcome({ applying, currentVersion }) {
  if (!applying) return 'none'
  const c = compareVersions(currentVersion, applying)
  // Why "failed" for anything older: the swap was rolled back, the installer
  // was cancelled (a declined UAC prompt), or macOS refused the move. That
  // version goes back to the download page instead of looping.
  return c === 0 || c === 1 ? 'applied' : 'failed'
}

/**
 * The swap helper's arguments (electron/mac-swap.sh documents them).
 *
 * @param {object} opts
 * @param {number[]} opts.pids  processes that must exit first: the app and its server child
 * @param {string} opts.bundle  the installed .app
 * @param {string} opts.staged  the unpacked, verified .app
 * @param {string} opts.stageDir  the directory `staged` is in (removed afterwards)
 * @param {string} opts.logFile
 * @param {boolean} opts.relaunch  start the app again afterwards
 * @param {string[]} [opts.argv]  arguments for the relaunched app
 * @returns {string[]}
 */
function swapHelperArgs({ pids, bundle, staged, stageDir, logFile, relaunch, argv = [] }) {
  const live = (pids || []).filter((pid) => Number.isSafeInteger(pid) && pid > 1)
  return [live.join(','), bundle, staged, stageDir, logFile, relaunch ? '1' : '0', ...argv]
}

module.exports = {
  APP_BUNDLE_ID,
  RELEASE_DOWNLOAD_PREFIX,
  DOWNLOAD_HOSTS,
  MAX_REDIRECTS,
  MAX_FEED_BYTES,
  MAX_UPDATE_BYTES,
  MAC_FEED_NAME,
  STAGE_PREFIX,
  MAC_ARCHES,
  macBundlePath,
  updateStrategy,
  bareVersion,
  macAssetName,
  releaseAssetUrl,
  isAllowedDownloadUrl,
  parseUpdateFeed,
  isSha512,
  chooseMacAsset,
  sha512Matches,
  plistString,
  checkBundle,
  applyOutcome,
  swapHelperArgs,
}
