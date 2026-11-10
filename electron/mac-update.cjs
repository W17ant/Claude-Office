'use strict'

/**
 * mac-update.cjs - the macOS updater: download, verify, unpack, and hand over to the swap helper.
 *
 * Why the app has its own: the builds are not signed, and Squirrel.Mac (what
 * Electron's autoUpdater and electron-updater use on macOS) refuses to
 * install an update into an app with no Developer ID signature.
 *
 * The flow, in the order nothing may be skipped (update-plan.cjs decides
 * every step; this file only does the I/O):
 *
 *   1. GET latest-mac.yml from the release the check found; pick the zip for
 *      this version and architecture (chooseMacAsset).
 *   2. Download that zip into a staging directory beside the installed app:
 *      https only, GitHub's hosts only, every redirect re-checked, a size cap.
 *   3. Hash the file on disk and compare with the feed's sha512. A mismatch
 *      ends here: nothing is unpacked.
 *   4. Unpack with ditto; the result must be one real .app directory whose
 *      Info.plist names this app's bundle id and the expected version.
 *   5. `apply()`: start electron/mac-swap.sh detached. It waits for the app
 *      to quit, moves the old bundle aside, moves the new one in, puts the
 *      old one back if that fails, and relaunches.
 *
 * Any throw from `prepare()` means "offer the download page instead"
 * (auto-update.cjs); the staging directory is removed on the way out.
 *
 * No Electron here: tests/mac-update.test.ts runs the download against a
 * local server through the `get` option, and the real swap helper against a
 * fake bundle. The packaged app never passes `get`: main.cjs calls
 * createMacBackend without it, and nothing reads a URL from the environment.
 */

const fs = require('fs')
const https = require('https')
const path = require('path')
const crypto = require('crypto')
const { spawn, execFile } = require('child_process')
const { compareVersions } = require('./update-check.cjs')
const {
  MAX_REDIRECTS,
  MAX_FEED_BYTES,
  MAX_UPDATE_BYTES,
  MAC_FEED_NAME,
  STAGE_PREFIX,
  releaseAssetUrl,
  isAllowedDownloadUrl,
  parseUpdateFeed,
  chooseMacAsset,
  sha512Matches,
  checkBundle,
  swapHelperArgs,
} = require('./update-plan.cjs')

// Why 30 s of silence, not a total: 160 MB on a slow line takes many minutes
// and that is fine; a connection that has sent nothing for half a minute is
// dead (a captive portal, a sleeping laptop).
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

// Why 5 minutes: ditto unpacks the app in a few seconds on an SSD; this only
// stops a hung unpack from holding the staging directory for ever.
const UNPACK_TIMEOUT_MS = 5 * 60 * 1000

// Why an hour: a staging directory is in use for minutes (a download, then a
// swap). One older than this was left by a crash or a swap that gave up.
const STALE_STAGE_MS = 60 * 60 * 1000

// mkdtemp appends six characters to the prefix
const STAGE_NAME = new RegExp(`^${STAGE_PREFIX.replace(/[.]/g, '\\.')}[A-Za-z0-9]{6}$`)

const SWAP_HELPER = path.join(__dirname, 'mac-swap.sh')
const SWAP_LOG_NAME = 'update-swap.log'

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Open a GET, following redirects by hand so every hop is checked against
 * the host allowlist (Node's https does not follow them itself).
 *
 * @param {string} url
 * @param {{ get?: typeof https.get, userAgent: string, idleTimeoutMs?: number, redirectsLeft?: number }} opts
 * @returns {Promise<{ req: import('http').ClientRequest, res: import('http').IncomingMessage }>} a 200 response, not yet read
 */
function openDownload(url, { get = https.get, userAgent, idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS, redirectsLeft = MAX_REDIRECTS }) {
  return new Promise((resolve, reject) => {
    if (!isAllowedDownloadUrl(url)) return reject(new Error('refused a URL outside GitHub'))
    let req
    try {
      // Why no cookie, token or Accept header: the release is public, and the
      // signed asset URL carries its own authorisation.
      req = get(url, { headers: { 'User-Agent': userAgent }, timeout: idleTimeoutMs }, (res) => {
        const status = res.statusCode
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume()
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'))
          let next
          try { next = new URL(String(res.headers.location || ''), url).href } catch { return reject(new Error('bad redirect')) }
          return resolve(openDownload(next, { get, userAgent, idleTimeoutMs, redirectsLeft: redirectsLeft - 1 }))
        }
        if (status !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${status}`))
        }
        resolve({ req, res })
      })
    } catch (err) {
      return reject(err)
    }
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timed out')))
  })
}

/**
 * GET a small text file.
 * @param {string} url
 * @param {{ get?: typeof https.get, userAgent: string, maxBytes: number, idleTimeoutMs?: number }} opts
 * @returns {Promise<string>} rejects on any failure, or a body over `maxBytes`
 */
async function fetchText(url, { maxBytes, ...opts }) {
  const { req, res } = await openDownload(url, opts)
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    res.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { req.destroy(); return reject(new Error('response too large')) }
      chunks.push(chunk)
    })
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
    req.on('error', reject)
  })
}

/**
 * GET a file to disk.
 * @param {string} url
 * @param {string} dest  created exclusively: an existing file is an error
 * @param {{ get?: typeof https.get, userAgent: string, maxBytes: number, idleTimeoutMs?: number }} opts
 * @returns {Promise<number>} bytes written; rejects (and removes `dest`) on any failure or past `maxBytes`
 */
async function downloadFile(url, dest, { maxBytes, ...opts }) {
  const { req, res } = await openDownload(url, opts)
  return new Promise((resolve, reject) => {
    // Why the header too: a body that announces itself as too big is not
    // worth starting; the running count below is the limit that holds.
    const announced = Number(res.headers['content-length'])
    if (Number.isFinite(announced) && announced > maxBytes) {
      req.destroy()
      return reject(new Error('download too large'))
    }
    const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 })
    let size = 0
    let failed = false
    let created = false
    out.on('open', () => { created = true })
    const fail = (err) => {
      if (failed) return
      failed = true
      req.destroy()
      out.destroy()
      // Why only a file this call made: when `wx` refused, what is at `dest`
      // was there before and is not this function's to remove.
      if (!created) return reject(err)
      fs.rm(dest, { force: true }, () => reject(err))
    }
    res.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) fail(new Error('download too large'))
    })
    res.on('error', fail)
    req.on('error', fail)
    out.on('error', fail)
    out.on('finish', () => { if (!failed) resolve(size) })
    res.pipe(out)
  })
}

/**
 * The base64 sha512 of a file, read back from disk: what gets unpacked is
 * what was hashed, not what a stream said went past.
 * @param {string} file
 * @returns {Promise<string>}
 */
function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')))
  })
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Remove staging directories left beside the app by a crash or an abandoned
 * swap: only real directories with the staging name, older than an hour.
 *
 * @param {string} parent  the folder the app is in
 * @param {{ keep?: string | null, now?: number, maxAgeMs?: number }} [opts]  `keep` is a staging directory in use
 * @returns {string[]} the directories removed
 */
function cleanStaleStages(parent, { keep = null, now = Date.now(), maxAgeMs = STALE_STAGE_MS } = {}) {
  const removed = []
  let names
  try { names = fs.readdirSync(parent) } catch { return removed }
  for (const name of names) {
    if (!STAGE_NAME.test(name)) continue
    const dir = path.join(parent, name)
    if (dir === keep) continue
    try {
      // Why lstat: a symlink with a staging name is not ours to follow
      const stat = fs.lstatSync(dir)
      if (!stat.isDirectory() || now - stat.mtimeMs < maxAgeMs) continue
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {}
  }
  return removed
}

/** Unpack a zip with ditto (what Finder's Archive Utility uses: it restores symlinks, modes and extended attributes). */
function unpackZip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/ditto', ['-x', '-k', zip, dest], { timeout: UNPACK_TIMEOUT_MS }, (err) => {
      if (err) reject(new Error(`could not unpack: ${err.message}`))
      else resolve()
    })
  })
}

/**
 * The one app bundle in an unpacked zip, checked against what was expected.
 *
 * @param {string} dir  where the zip was unpacked
 * @param {{ version: string }} want
 * @returns {string} the bundle's path; throws when there is not exactly one
 *   real .app directory, or it is not this app at that version
 */
function findStagedApp(dir, { version }) {
  const apps = fs.readdirSync(dir).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error('the archive does not hold exactly one app')
  const bundle = path.join(dir, apps[0])
  if (!fs.lstatSync(bundle).isDirectory()) throw new Error('the archive does not hold an app bundle')
  const checked = checkBundle(fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'), { version })
  if (!checked.ok) throw new Error(`the unpacked app failed its check (${checked.reason})`)
  if (!fs.statSync(path.join(bundle, 'Contents', 'MacOS', checked.executable)).isFile()) throw new Error('the unpacked app has no executable')
  return bundle
}

// ---------------------------------------------------------------------------
// The backend auto-update.cjs drives
// ---------------------------------------------------------------------------

/**
 * The macOS update backend for one installed bundle.
 *
 * @param {object} opts
 * @param {string} opts.bundle  the installed .app (update-plan.cjs updateStrategy)
 * @param {string} opts.parent  the folder it is in; the staging directory is made here
 * @param {string} opts.currentVersion  app.getVersion()
 * @param {string} opts.arch  process.arch
 * @param {string} opts.userData  where the swap helper's log goes
 * @param {() => (number | undefined)[]} opts.getPids  the processes that must exit before the swap: this app and its server child
 * @param {string[]} [opts.argv]  arguments to relaunch with
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof https.get} [opts.get]  tests only: the transport. The URL checks apply whatever it is.
 * @param {string} [opts.helper]  tests only: the swap helper's path
 * @returns {{ quitsItself: false, prepare: (update: {version: string}) => Promise<{version: string}>, apply: (opts: {relaunch: boolean}) => boolean, applyOnQuit: () => boolean, setEnabled: (flag: boolean) => void, discard: () => void, readonly staged: {version: string, stageDir: string, app: string} | null }}
 */
function createMacBackend({ bundle, parent, currentVersion, arch, userData, getPids, argv = [], log = console.log, get, helper = SWAP_HELPER }) {
  const userAgent = `Agent-Office/${currentVersion}`
  /** @type {{ version: string, stageDir: string, app: string } | null} */
  let staged = null

  function discard() {
    if (!staged) return
    try { fs.rmSync(staged.stageDir, { recursive: true, force: true }) } catch {}
    staged = null
  }

  async function prepare(update) {
    // Why here as well as in the check: this is the last place a version is
    // compared before bytes are fetched, and an older build must never be
    // staged whatever the caller passed.
    if (compareVersions(update.version, currentVersion) !== 1) throw new Error('not a newer version')
    if (staged && staged.version === update.version && fs.existsSync(staged.app)) return { version: staged.version }

    cleanStaleStages(parent, { keep: staged && staged.stageDir })
    const feedUrl = releaseAssetUrl(update.version, MAC_FEED_NAME)
    if (!feedUrl) throw new Error('no feed for that version')
    const feed = parseUpdateFeed(await fetchText(feedUrl, { get, userAgent, maxBytes: MAX_FEED_BYTES }))
    const asset = chooseMacAsset(feed, { version: update.version, arch })
    if (!asset) throw new Error(`the release has no macOS ${arch} zip`)

    const stageDir = fs.mkdtempSync(path.join(parent, STAGE_PREFIX))
    try {
      const zip = path.join(stageDir, 'update.zip')
      log(`[update] Downloading ${asset.name}`)
      const size = await downloadFile(asset.url, zip, { get, userAgent, maxBytes: asset.size || MAX_UPDATE_BYTES })
      if (asset.size !== null && size !== asset.size) throw new Error('the download is not the size the release says')
      if (!sha512Matches(asset.sha512, await sha512File(zip))) throw new Error('checksum mismatch')
      const unpacked = path.join(stageDir, 'unpacked')
      await unpackZip(zip, unpacked)
      fs.rmSync(zip, { force: true })
      const app = findStagedApp(unpacked, { version: update.version })
      discard()
      staged = { version: update.version, stageDir, app }
      log(`[update] ${update.version} is downloaded and verified`)
      return { version: update.version }
    } catch (err) {
      try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch {}
      throw err
    }
  }

  function apply({ relaunch }) {
    if (!staged || !fs.existsSync(staged.app) || !fs.existsSync(bundle)) return false
    const args = swapHelperArgs({
      pids: getPids(),
      bundle,
      staged: staged.app,
      stageDir: staged.stageDir,
      logFile: path.join(userData, SWAP_LOG_NAME),
      relaunch,
      argv,
    })
    try {
      // Why detached, with no stdio and its own directory: it has to outlive
      // this process, and must not hold the bundle's folder open while it is
      // being moved.
      const child = spawn('/bin/sh', [helper, ...args], { detached: true, stdio: 'ignore', cwd: '/' })
      child.on('error', (err) => log(`[update] Could not start the swap helper: ${err.message}`))
      child.unref()
      // Why forgotten, not removed: the staging directory is the helper's now.
      staged = null
      return true
    } catch (err) {
      log(`[update] Could not start the swap helper: ${err.message}`)
      return false
    }
  }

  return {
    // The caller quits the app after apply(); the helper waits for that.
    quitsItself: false,
    prepare,
    apply,
    applyOnQuit: () => apply({ relaunch: false }),
    setEnabled() {},
    discard,
    get staged() { return staged },
  }
}

module.exports = {
  DOWNLOAD_IDLE_TIMEOUT_MS,
  STALE_STAGE_MS,
  SWAP_HELPER,
  SWAP_LOG_NAME,
  openDownload,
  fetchText,
  downloadFile,
  sha512File,
  cleanStaleStages,
  unpackZip,
  findStagedApp,
  createMacBackend,
}
