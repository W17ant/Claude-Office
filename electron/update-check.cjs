'use strict'

/**
 * update-check.cjs - finds a newer release of the desktop app and remembers what was done about it.
 *
 * On start and every six hours the packaged app reads the latest GitHub
 * release (unauthenticated, nothing about the user sent beyond a User-Agent
 * of "Agent-Office/<version>"). When its tag is newer than app.getVersion()
 * one of two things happens:
 *
 *   "Update automatically" on (the default)
 *     The update is downloaded in the background and the tray and right-click
 *     menus gain "Restart to update to vX.Y.Z", with one native notification
 *     when it is ready. Windows and Linux use electron-updater; macOS uses the
 *     app's own updater, because Squirrel.Mac (what electron-updater drives
 *     there) refuses an app with no Developer ID signature. See
 *     auto-update.cjs (the flow), update-plan.cjs (every decision, pure) and
 *     mac-update.cjs (the macOS download, verification and swap).
 *
 *   off, or the update cannot be installed from here (a translocated or
 *   read-only macOS app, no asset for this platform, a failed download or
 *   checksum)
 *     The menus gain "Update available: vX.Y.Z — Download", which opens the
 *     release page in the browser, with one notification per new version.
 *     This is what the app did before it could update itself, and it is
 *     always the fallback.
 *
 * update-check.json in the app's user-data directory holds what must survive
 * a restart: the "Update automatically" preference, the versions already
 * notified about, and an install in progress (so one that did not take is
 * not tried again). Every failure is silent (logged only).
 *
 * Everything here but `fetchLatestRelease`'s default getter is pure and runs
 * in plain Node (tests/update-check.test.ts); main.cjs supplies Electron's
 * Notification and shell.
 */

const fs = require('fs')
const https = require('https')
const path = require('path')

// The one endpoint read, and the only page the menu item may open
const RELEASES_API_URL = 'https://api.github.com/repos/W17ant/Claude-Office/releases/latest'
const RELEASE_PAGE_PREFIX = 'https://github.com/W17ant/Claude-Office/releases/'

// Why: six hours. Releases come out every few weeks, so checking more often
// buys nothing, and GitHub allows 60 unauthenticated requests an hour per IP,
// which a desktop app checking four times a day never comes near.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// Why: 10 s. The API answers in well under a second; a hung connection (a
// captive portal, a dead proxy) must not leave a socket open for minutes.
const UPDATE_CHECK_TIMEOUT_MS = 10_000

// Why: 1 MB. A release's JSON is a few KB (plus a line per installer); a body
// past this is not GitHub's answer and is not worth buffering.
const MAX_RELEASE_BYTES = 1024 * 1024

// Why: a page URL longer than this is not a GitHub release page.
const MAX_URL_LEN = 300

const STATE_FILE_NAME = 'update-check.json'

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const VERSION_PATTERN = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,64}))?$/

/**
 * Parse "v1.2.3", "1.2.3" or "1.2.3-beta.1" (no build metadata).
 * @param {unknown} value
 * @returns {{ major: number, minor: number, patch: number, pre: string[] } | null}
 */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const m = VERSION_PATTERN.exec(value.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence of two prerelease identifiers: numeric ones compare as numbers and sort first. */
function compareIdentifier(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an !== bn) return an ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare two versions by semver precedence: -1, 0 or 1, or null when either
 * does not parse. A prerelease sorts before its release (1.2.0-beta < 1.2.0).
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1 | null}
 */
function compareVersions(a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1
  }
  if (!va.pre.length || !vb.pre.length) {
    if (va.pre.length === vb.pre.length) return 0
    return va.pre.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    if (va.pre[i] === undefined) return -1
    if (vb.pre[i] === undefined) return 1
    const c = compareIdentifier(va.pre[i], vb.pre[i])
    if (c) return c
  }
  return 0
}

/** "v1.2.3" for any spelling parseVersion accepts. */
function normaliseTag(value) {
  const v = parseVersion(value)
  if (!v) return null
  return `v${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`
}

// ---------------------------------------------------------------------------
// The release page
// ---------------------------------------------------------------------------

/**
 * The release page to open, from the API's `html_url`: only an https URL on
 * github.com under /W17ant/Claude-Office/releases/, checked both as given and
 * after URL normalisation (so `releases/../../other` cannot climb out), with
 * no credentials, port, query or fragment. null for anything else.
 * @param {unknown} htmlUrl
 * @returns {string | null}
 */
function releasePageUrl(htmlUrl) {
  if (typeof htmlUrl !== 'string' || htmlUrl.length > MAX_URL_LEN) return null
  if (!htmlUrl.startsWith(RELEASE_PAGE_PREFIX)) return null
  // Why: whitespace, quotes, backslashes and control characters have no place
  // in a release URL and are how a URL gets read two different ways.
  if (/[\s"'<>\\`\u0000-\u001f\u007f]/.test(htmlUrl)) return null
  let url
  try { url = new URL(htmlUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) return null
  if (url.search || url.hash) return null
  if (!url.href.startsWith(RELEASE_PAGE_PREFIX) || url.href.length <= RELEASE_PAGE_PREFIX.length) return null
  return url.href
}

/**
 * What to offer, from the latest release and the running version: the
 * normalised tag and its page, or null when it is not newer, is a draft or a
 * prerelease, or anything about it does not check out.
 * @param {any} release  the API's JSON
 * @param {string} currentVersion  app.getVersion()
 * @returns {{ version: string, url: string } | null}
 */
function availableUpdate(release, currentVersion) {
  if (!release || typeof release !== 'object' || release.draft || release.prerelease) return null
  const version = normaliseTag(release.tag_name)
  if (!version || compareVersions(version, currentVersion) !== 1) return null
  const url = releasePageUrl(release.html_url)
  return url ? { version, url } : null
}

// ---------------------------------------------------------------------------
// The state file: update-check.json in the user-data directory
//
//   lastNotifiedVersion    the "is available" notification was shown for it
//   readyNotifiedVersion   the "is ready, restart to update" one was
//   autoUpdate             the "Update automatically" checkbox; absent = on
//   applying               an install of this version was started on the way
//                          out; the next start compares it with the version
//                          it is running (update-plan.cjs applyOutcome)
//   failedVersion          that install did not take: this version is offered
//                          as a download instead of being tried again
// ---------------------------------------------------------------------------

const STATE_VERSION_KEYS = ['lastNotifiedVersion', 'readyNotifiedVersion', 'applying', 'failedVersion']

/** Keep only the keys the file is meant to hold, with the right types (a hand edit or a truncated write is dropped, not trusted). */
function sanitizeUpdateState(raw) {
  const state = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state
  for (const key of STATE_VERSION_KEYS) {
    const version = normaliseTag(raw[key])
    if (version) state[key] = version
  }
  if (typeof raw.autoUpdate === 'boolean') state.autoUpdate = raw.autoUpdate
  return state
}

/**
 * Read the state file.
 * @param {string} file
 * @returns {{ lastNotifiedVersion?: string, readyNotifiedVersion?: string, applying?: string, failedVersion?: string, autoUpdate?: boolean }}
 *   only the keys that are set; a missing or unreadable file is {}
 */
function readUpdateState(file) {
  try {
    return sanitizeUpdateState(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Merge `patch` into the state file (temp file + rename, so a crash mid-write
 * leaves the previous state). A null or undefined value removes its key.
 * @param {string} file
 * @param {Record<string, string | boolean | null | undefined>} patch
 * @returns {boolean} false when the file cannot be written
 */
function writeUpdateState(file, patch) {
  const merged = { ...readUpdateState(file) }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === null || value === undefined) delete merged[key]
    else merged[key] = value
  }
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(sanitizeUpdateState(merged), null, 2) + '\n')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

/** The last version an "is available" notification was shown for, or null (no file, junk in it). */
function readLastNotified(file) {
  return readUpdateState(file).lastNotifiedVersion || null
}

/** Remember the version notified about; false when it cannot be written. */
function writeLastNotified(file, version) {
  return writeUpdateState(file, { lastNotifiedVersion: version })
}

/**
 * Whether "Update automatically" is on: yes unless the file says false.
 * @param {string} file
 * @returns {boolean}
 */
function readAutoUpdate(file) {
  return readUpdateState(file).autoUpdate !== false
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * GET the latest release. Resolves the parsed JSON, or null on any failure
 * (offline, timeout, rate limit, a non-200, a body too big or not JSON).
 * Sends no cookie, no token, nothing but the app's name and version.
 * @param {{ version: string, timeoutMs?: number, get?: typeof https.get, url?: string }} opts
 * @returns {Promise<any | null>}
 */
function fetchLatestRelease({ version, timeoutMs = UPDATE_CHECK_TIMEOUT_MS, get = https.get, url = RELEASES_API_URL }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (!done) { done = true; resolve(value) } }
    let req
    try {
      req = get(url, {
        headers: {
          'User-Agent': `Agent-Office/${version}`,
          Accept: 'application/vnd.github+json',
        },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null) }
        let body = ''
        let size = 0
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          size += Buffer.byteLength(chunk)
          if (size > MAX_RELEASE_BYTES) { req.destroy(); return finish(null) }
          body += chunk
        })
        res.on('end', () => {
          try { finish(JSON.parse(body)) } catch { finish(null) }
        })
        res.on('error', () => finish(null))
      })
    } catch {
      return finish(null)
    }
    req.on('error', () => finish(null))
    req.on('timeout', () => { req.destroy(); finish(null) })
  })
}

// ---------------------------------------------------------------------------
// The checker
// ---------------------------------------------------------------------------

/**
 * The periodic check. `check()` runs once; `start()` checks now and every
 * `intervalMs`; `stop()` ends it; `announce(update)` shows the "is available"
 * notification unless that version already had one.
 *
 * @param {object} opts
 * @param {string} opts.currentVersion  app.getVersion()
 * @param {string} opts.stateFile  where the last notified version is kept
 * @param {() => Promise<any>} opts.fetchRelease  resolves the release JSON or null
 * @param {(update: {version: string, url: string}) => unknown} opts.onUpdate  a newer release was found (every
 *   check that finds it). Returning true defers the notification: the caller is downloading the update and will
 *   either show its own "ready" notification or call `announce` when it has to fall back to the download page.
 * @param {(update: {version: string, url: string}) => void} opts.notify  show the native notification (once per version)
 * @param {number} [opts.intervalMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ check: () => Promise<{version: string, url: string} | null>, announce: (update: {version: string, url: string}) => boolean, start: () => void, stop: () => void, readonly update: {version: string, url: string} | null }}
 */
function createUpdateChecker({ currentVersion, stateFile, fetchRelease, onUpdate = () => {}, notify = () => {}, intervalMs = UPDATE_CHECK_INTERVAL_MS, log = console.log }) {
  let timer = null
  let update = null

  function announce(found) {
    if (!found || readLastNotified(stateFile) === found.version) return false
    // Why: remember first, so a notifier that throws cannot make every
    // later check notify again.
    writeLastNotified(stateFile, found.version)
    notify(found)
    return true
  }

  async function check() {
    try {
      const release = await fetchRelease()
      const found = availableUpdate(release, currentVersion)
      if (!found) return null
      update = found
      if (onUpdate(found) !== true) announce(found)
      return found
    } catch (err) {
      log(`[update] Check failed: ${err && err.message}`)
      return null
    }
  }

  return {
    check,
    announce,
    start() {
      if (timer) return
      check()
      timer = setInterval(check, intervalMs)
      if (timer.unref) timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    get update() { return update },
  }
}

module.exports = {
  RELEASES_API_URL,
  RELEASE_PAGE_PREFIX,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  STATE_FILE_NAME,
  parseVersion,
  compareVersions,
  normaliseTag,
  releasePageUrl,
  availableUpdate,
  readUpdateState,
  writeUpdateState,
  readLastNotified,
  writeLastNotified,
  readAutoUpdate,
  fetchLatestRelease,
  createUpdateChecker,
}
