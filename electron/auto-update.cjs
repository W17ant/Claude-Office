'use strict'

/**
 * auto-update.cjs - the update flow: download in the background, then "Restart to update".
 *
 * update-check.cjs finds a newer release; this decides what happens next.
 *
 *   offer(update)   the check found one. With "Update automatically" on, the
 *                   backend downloads and verifies it (phase "downloading"),
 *                   then the menus show "Restart to update to vX.Y.Z" and one
 *                   notification says it is ready (phase "ready").
 *   apply()         that menu item: install, quit, start the new version.
 *   applyOnQuit()   the app is quitting with an update ready: install it on
 *                   the way out, where the platform can do that quietly.
 *
 * Anything that goes wrong (a failed download, a checksum mismatch, an
 * install that did not take) ends at the same place: the "Update available —
 * Download" item that opens the release page, exactly what the app did before
 * it could update itself. `offer` returning false means "not handled here,
 * show that".
 *
 * A backend does the platform's work and has this shape:
 *
 *   prepare(update) -> Promise<{ version }>   download and verify; rejects on any failure
 *   apply({ relaunch }) -> boolean            start the install; false when it could not
 *   applyOnQuit() -> boolean                  the quiet install on quit; false when there is none
 *   setEnabled(flag)                          "Update automatically" changed
 *   quitsItself                               true when apply() also quits the app
 *
 * macOS: mac-update.cjs createMacBackend. Windows and Linux:
 * createElectronUpdaterBackend below, around electron-updater.
 *
 * Plain Node, no Electron (tests/auto-update.test.ts drives it with fakes).
 * main.cjs builds it only in a packaged app that update-plan.cjs
 * updateStrategy says can update itself.
 */

const { compareVersions, normaliseTag, readUpdateState, writeUpdateState } = require('./update-check.cjs')
const { applyOutcome } = require('./update-plan.cjs')

// Why 3: the check runs every six hours, so three tries cover most of a day
// of bad network. A download that still fails (or a checksum that never
// matches) is not going to fix itself; the download page takes over until
// the app is next started.
const MAX_DOWNLOAD_ATTEMPTS = 3

/**
 * The update flow for one running app.
 *
 * @param {object} opts
 * @param {string} opts.currentVersion  app.getVersion()
 * @param {string} opts.stateFile  update-check.json (update-check.cjs documents its keys)
 * @param {object} opts.backend  see the file header
 * @param {() => void} [opts.onChange]  the menus need rebuilding
 * @param {(ready: {version: string}) => void} [opts.notifyReady]  show the "ready" notification (once per version)
 * @param {(update: {version: string, url: string}) => void} [opts.announce]  fall back: show the "is available" notification (update-check.cjs announce)
 * @param {() => void} [opts.quit]  quit the app (after apply(), for a backend that does not)
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ offer: (update: {version: string, url: string}) => boolean, apply: () => boolean, applyOnQuit: () => boolean, setEnabled: (flag: boolean, update?: {version: string, url: string} | null) => void, menuState: () => {enabled: boolean, phase: string, version: string | null}, readonly lastOutcome: 'none' | 'applied' | 'failed' }}
 */
function createAutoUpdater({ currentVersion, stateFile, backend, onChange = () => {}, notifyReady = () => {}, announce = () => {}, quit = () => {}, log = console.log }) {
  const saved = readUpdateState(stateFile)
  let enabled = saved.autoUpdate !== false
  /** @type {'idle' | 'downloading' | 'ready' | 'failed'} */
  let phase = 'idle'
  /** The version being downloaded, ready, or last failed. */
  let version = null
  let failedVersion = saved.failedVersion || null
  // Set once an install has been handed to the backend: nothing runs twice
  let installing = false
  const attempts = new Map()

  // What became of an install started before the last quit
  const lastOutcome = applyOutcome({ applying: saved.applying, currentVersion })
  if (lastOutcome === 'applied') {
    log(`[update] Now running ${currentVersion}`)
    writeUpdateState(stateFile, { applying: null, failedVersion: null })
    failedVersion = null
  } else if (lastOutcome === 'failed') {
    // Why remembered: an install that did not take (the move was refused, the
    // installer was cancelled) would fail the same way on every start. This
    // version is offered as a download from now on; the next one is tried afresh.
    log(`[update] The update to ${saved.applying} did not install; offering the download instead`)
    failedVersion = saved.applying
    writeUpdateState(stateFile, { applying: null, failedVersion })
  }
  // Why: a failure recorded for a version this app has since reached or
  // passed (installed by hand) no longer means anything.
  if (failedVersion && compareVersions(failedVersion, currentVersion) !== 1) {
    failedVersion = null
    writeUpdateState(stateFile, { failedVersion: null })
  }

  backend.setEnabled(enabled)

  function setPhase(next, nextVersion) {
    phase = next
    version = nextVersion
    onChange()
  }

  function download(update) {
    attempts.set(update.version, (attempts.get(update.version) || 0) + 1)
    setPhase('downloading', update.version)
    Promise.resolve()
      .then(() => backend.prepare(update))
      .then((ready) => {
        const readyVersion = normaliseTag(ready && ready.version)
        // Why checked again: the backend reports what it actually fetched,
        // and nothing at or below the running version is ever offered.
        if (!readyVersion || compareVersions(readyVersion, currentVersion) !== 1) throw new Error('the download is not a newer version')
        setPhase('ready', readyVersion)
        if (!enabled) return
        if (readUpdateState(stateFile).readyNotifiedVersion !== readyVersion) {
          // Why written first: a notifier that throws must not notify again
          writeUpdateState(stateFile, { readyNotifiedVersion: readyVersion })
          notifyReady({ version: readyVersion })
        }
      })
      .catch((err) => {
        log(`[update] Could not prepare ${update.version}: ${err && err.message}`)
        setPhase('failed', update.version)
        if (enabled) announce(update)
      })
  }

  /**
   * The check found a newer release.
   * @returns {boolean} true when this is handling it (the caller holds back
   *   its "is available" notification); false to show the download item
   */
  function offer(update) {
    if (!enabled || installing || !update || update.version === failedVersion) return false
    if (compareVersions(update.version, currentVersion) !== 1) return false
    if (phase === 'downloading') return true
    if (phase === 'ready' && compareVersions(update.version, version) !== 1) return true
    if ((attempts.get(update.version) || 0) >= MAX_DOWNLOAD_ATTEMPTS) return false
    // Why true on a retry too: its "is available" notification was already
    // shown when the first attempt failed (announce is once per version).
    download(update)
    return true
  }

  /** "Restart to update": install the ready update and restart. */
  function apply() {
    if (!enabled || installing || phase !== 'ready') return false
    // Why before the install: the next start compares this with the version
    // it is running, which is how a swap or installer that failed is noticed.
    writeUpdateState(stateFile, { applying: version })
    installing = true
    let started = false
    try { started = backend.apply({ relaunch: true }) === true } catch (err) { log(`[update] Install failed to start: ${err && err.message}`) }
    if (!started) {
      installing = false
      writeUpdateState(stateFile, { applying: null })
      setPhase('failed', version)
      return false
    }
    if (!backend.quitsItself) quit()
    return true
  }

  /** The app is quitting: install a ready update on the way out, without relaunching. */
  function applyOnQuit() {
    if (!enabled || installing || phase !== 'ready') return false
    let started = false
    try { started = backend.applyOnQuit() === true } catch (err) { log(`[update] Install on quit failed to start: ${err && err.message}`) }
    if (!started) return false
    installing = true
    writeUpdateState(stateFile, { applying: version })
    return true
  }

  /**
   * The "Update automatically" checkbox.
   * @param {boolean} flag
   * @param {{version: string, url: string} | null} [update]  the release the check last found, to start on when switched on
   */
  function setEnabled(flag, update = null) {
    enabled = flag === true
    writeUpdateState(stateFile, { autoUpdate: enabled })
    backend.setEnabled(enabled)
    // Why nothing is thrown away when switched off: a finished download is
    // kept (the menu just stops offering it), so switching back on does not
    // fetch 160 MB again.
    if (enabled && update) offer(update)
    onChange()
  }

  return {
    offer,
    apply,
    applyOnQuit,
    setEnabled,
    menuState: () => ({ enabled, phase, version }),
    get lastOutcome() { return lastOutcome },
  }
}

// ---------------------------------------------------------------------------
// Windows and Linux: electron-updater
// ---------------------------------------------------------------------------

/**
 * A backend around electron-updater (NSIS on Windows, AppImage on Linux). It
 * reads its feed from the app-update.yml electron-builder writes into the
 * packaged app from package.json `build.publish` (this repository's GitHub
 * releases); it has no feed override, and none is set here.
 *
 * @param {object} opts
 * @param {string} opts.currentVersion  app.getVersion()
 * @param {string} opts.platform  process.platform
 * @param {() => void} [opts.beforeInstall]  called just before the installer starts
 * @param {(msg: string) => void} [opts.log]
 * @param {() => { autoUpdater: any }} [opts.load]  how the module is loaded.
 *   Why lazy: package.json is also the npm package (`npx agent-office`),
 *   where neither Electron nor this module is ever loaded; requiring it at
 *   the top of a file would make every desktop start pay for it too,
 *   including macOS, which does not use it.
 * @returns {{ quitsItself: true, prepare: (update: {version: string}) => Promise<{version: string}>, apply: (opts: {relaunch: boolean}) => boolean, applyOnQuit: () => boolean, setEnabled: (flag: boolean) => void }}
 */
function createElectronUpdaterBackend({ currentVersion, platform, beforeInstall = () => {}, log = console.log, load = () => require('electron-updater') }) {
  // Why Windows only: there electron-updater runs the installer silently as
  // the app exits. On Linux its install-on-quit starts the new AppImage and
  // waits for it, which would bring the app straight back after a quit.
  const installsOnQuit = platform === 'win32'
  let updater = null
  let enabled = true
  let downloaded = false

  function get() {
    if (updater) return updater
    updater = load().autoUpdater
    // Why all four are set, not left to defaults: nothing downloads until
    // `prepare` asks, an older or pre-release build is never taken, and the
    // quiet install on quit follows the checkbox.
    updater.autoDownload = false
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.autoInstallOnAppQuit = installsOnQuit && enabled
    updater.logger = {
      info: (msg) => log(`[update] ${msg}`),
      warn: (msg) => log(`[update] ${msg}`),
      error: (msg) => log(`[update] ${msg}`),
      debug: () => {},
    }
    // Why: an EventEmitter with no 'error' listener throws. Failures reach
    // the caller through the rejected promises below.
    updater.on('error', () => {})
    return updater
  }

  async function prepare() {
    const u = get()
    const result = await u.checkForUpdates()
    const found = normaliseTag(result && result.updateInfo && result.updateInfo.version)
    // Why its version and not the one the check passed in: electron-updater
    // reads the release's own latest.yml, and that file is what it verifies
    // the download against (sha512). It must still be newer than this app.
    if (!found || compareVersions(found, currentVersion) !== 1) throw new Error('electron-updater found no newer version')
    await u.downloadUpdate(result.cancellationToken)
    downloaded = true
    return { version: found }
  }

  function apply() {
    if (!downloaded) return false
    beforeInstall()
    // Why (silent, run after): the Windows installer is the assisted kind
    // (`oneClick: false`), which without /S shows its wizard again and with
    // /S only relaunches when told to. A per-machine install still shows
    // Windows' own elevation prompt.
    get().quitAndInstall(true, true)
    return true
  }

  return {
    quitsItself: true,
    prepare,
    apply,
    // electron-updater's own quit handler does the work; this only says whether it will
    applyOnQuit: () => installsOnQuit && downloaded && enabled,
    setEnabled(flag) {
      enabled = flag === true
      if (updater) updater.autoInstallOnAppQuit = installsOnQuit && enabled
    },
  }
}

module.exports = {
  MAX_DOWNLOAD_ATTEMPTS,
  createAutoUpdater,
  createElectronUpdaterBackend,
}
