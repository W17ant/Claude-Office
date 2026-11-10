#!/usr/bin/env node
/**
 * e2e-mac-update.mjs - prove the macOS self-update for real: two packaged builds, a local feed, one swap.
 *
 *   node scripts/e2e-mac-update.mjs [--work <dir>] [--keep] [--reuse]
 *
 * macOS only, by hand (it is not part of `npm test`: it takes minutes, needs
 * the network for the builds and opens the app's window twice). What it does:
 *
 *   1. `npm run build`, then two electron-builder runs for this Mac's
 *      architecture into the work directory: the app as it is (`--mac dir`),
 *      and the same code as the next patch version (`--mac zip`, which also
 *      writes latest-mac.yml). Nothing is signed, like the release builds.
 *   2. Copies the old app to <work>/Applications/Agent Office.app.
 *   3. Serves the new build's latest-mac.yml and zip on 127.0.0.1, behind the
 *      same 302 from github.com to the asset host that a real release answers.
 *   4. Starts the copied app and waits: it finds the update, downloads it,
 *      checks the sha512, unpacks it with ditto, checks the bundle, shows
 *      "Restart to update", and on that click hands over to mac-swap.sh,
 *      which swaps the bundle and starts the new version.
 *   5. Checks what is on disk and what is running afterwards, stops the app
 *      and removes the work directory (`--keep` leaves it).
 *
 * Why an injected entry file and not an option of the app: the packaged app
 * honours no feed URL from its environment or its arguments, and must not.
 * So the test edits its own throwaway COPY of the old app: one extra file,
 * electron/e2e-entry.cjs, and `main` in that copy's package.json pointing at
 * it. The entry replaces three things before it loads the real main.cjs:
 *
 *   - the GitHub "latest release" lookup (answers: the new version exists)
 *   - the socket the mac backend downloads through (https://<host>/<path>
 *     becomes http://127.0.0.1:<port>/<host>/<path>; the URL checks, the
 *     redirect handling, the size and checksum checks all still run on the
 *     real https URLs)
 *   - Notification.show (recorded, not shown) and Menu.buildFromTemplate
 *     (watched for the "Restart to update" item, whose click handler is then
 *     called, as a click on it would)
 *
 * The new version that is swapped in is the untouched build: the script
 * checks that its package.json `main` is electron/main.cjs and that no entry
 * file came with it.
 *
 * What this does not cover: a real GitHub release and TLS, the notification
 * actually appearing, /Applications and its permissions, a quarantined or
 * translocated download, and anything on Windows or Linux.
 *
 * Kept away from a real office: the app gets its own user-data directory
 * (`--user-data-dir`, which also keeps its single-instance lock apart from an
 * installed app's), its own AGENT_OFFICE_HOME and CLAUDE_CONFIG_DIR, and a
 * free port that is never 3333, 3334 or 3335. The relaunched app inherits all
 * of that through the swap helper. It is the real app, so on start it asks
 * api.github.com for the latest release, once.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = require('../package.json')
const { normaliseTag } = require('../electron/update-check.cjs')
const { APP_BUNDLE_ID, MAC_FEED_NAME, macAssetName, releaseAssetUrl } = require('../electron/update-plan.cjs')
const { restartMenuLabel, downloadingMenuLabel, updateMenuLabel } = require('../electron/helpers.cjs')

const APP_NAME = `${pkg.build.productName}.app`
// The ports a real office uses (Vite, the server, the plugin's): never these.
const RESERVED_PORTS = [3333, 3334, 3335]
// Why ten minutes: the download is a local file and the swap takes a second
// or two, so the wait is the app's own startup (it starts its server and
// opens its window before the first update check). Anything slower is stuck.
const UPDATE_TIMEOUT_MS = 10 * 60 * 1000
// Why one minute: after the swap the new app only has to start its server.
const RELAUNCH_TIMEOUT_MS = 60 * 1000
const ASSET_HOST = 'release-assets.githubusercontent.com'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** The next patch version: what the "new" build is packaged as. */
function nextPatch(version) {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

/** A free TCP port on 127.0.0.1 that is not one a real office uses. */
async function freePort() {
  for (let i = 0; i < 20; i++) {
    const port = await new Promise((done, fail) => {
      const probe = createNetServer()
      probe.once('error', fail)
      probe.listen(0, '127.0.0.1', () => {
        const { port: found } = probe.address()
        probe.close(() => done(found))
      })
    })
    if (!RESERVED_PORTS.includes(port)) return port
  }
  throw new Error('no free port')
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}

/** `Print :<key>` from a bundle's Info.plist. */
function plistValue(app, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
}

/** The one .app electron-builder left under `dir` (in mac/ or mac-arm64/). */
function findBuiltApp(dir) {
  for (const sub of readdirSync(dir)) {
    const candidate = join(dir, sub, APP_NAME)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no ${APP_NAME} under ${dir}`)
}

/** [{ pid, comm }] for every process whose executable is inside `app`. */
function bundleProcesses(app) {
  const out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8' })
  const found = []
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match && match[2].startsWith(`${app}/Contents/`)) found.push({ pid: Number(match[1]), comm: match[2] })
  }
  return found
}

/** Stop everything running from inside `app`: ask the main process first, then insist. */
async function stopBundle(app) {
  const main = join(app, 'Contents', 'MacOS')
  for (const proc of bundleProcesses(app)) {
    if (proc.comm.startsWith(main)) { try { process.kill(proc.pid, 'SIGTERM') } catch {} }
  }
  // Why 10 s: the app stops its server and closes its window on SIGTERM
  for (let i = 0; i < 50 && bundleProcesses(app).length; i++) await sleep(200)
  for (const proc of bundleProcesses(app)) { try { process.kill(proc.pid, 'SIGKILL') } catch {} }
}

function readEvents(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/**
 * The entry file written into the copied app (see the header for what it
 * replaces and why). Everything it needs is baked in: it reads no
 * environment variable and no argument.
 */
function entrySource(config) {
  return `'use strict'
// Written by scripts/e2e-mac-update.mjs into a throwaway copy of the app.
// It is in no build and no release.
const CONFIG = ${JSON.stringify(config, null, 2)}
const fs = require('fs')
const http = require('http')
const { app, Menu, Notification } = require('electron')
const record = (event) => fs.appendFileSync(CONFIG.events, JSON.stringify(event) + '\\n')

let userData = app.getPath('userData')
try { userData = fs.realpathSync(userData) } catch {}
if (userData !== CONFIG.userData) {
  // Not the test's directory: do nothing at all rather than run beside a real install
  record({ type: 'wrong-user-data', path: userData })
  app.exit(70)
} else {
  const updateCheck = require('./update-check.cjs')
  updateCheck.fetchLatestRelease = async () => {
    record({ type: 'check' })
    return { tag_name: CONFIG.tag, html_url: CONFIG.releasePage, draft: false, prerelease: false }
  }

  const macUpdate = require('./mac-update.cjs')
  const createMacBackend = macUpdate.createMacBackend
  const get = (url, options, onResponse) => {
    const target = new URL(url)
    record({ type: 'request', url: target.origin + target.pathname })
    return http.get('http://127.0.0.1:' + CONFIG.feedPort + '/' + target.host + target.pathname, options, onResponse)
  }
  macUpdate.createMacBackend = (opts) => {
    record({ type: 'backend', bundle: opts.bundle, parent: opts.parent, arch: opts.arch, currentVersion: opts.currentVersion })
    return createMacBackend({ ...opts, get })
  }

  Notification.prototype.show = function show() { record({ type: 'notification', title: this.title }) }

  const buildFromTemplate = Menu.buildFromTemplate
  const seen = new Set()
  let clicked = false
  const walk = (items) => {
    for (const item of items || []) {
      if (Array.isArray(item.submenu)) walk(item.submenu)
      if (typeof item.label !== 'string' || !/update/i.test(item.label)) continue
      if (!seen.has(item.label)) {
        seen.add(item.label)
        record({ type: 'menu', label: item.label, enabled: item.enabled !== false, checked: item.checked })
      }
      if (item.label === CONFIG.restartLabel && !clicked) {
        clicked = true
        setTimeout(() => { record({ type: 'click', label: item.label }); item.click() }, 1000)
      }
    }
  }
  Menu.buildFromTemplate = function (template) {
    try { walk(template) } catch (err) { record({ type: 'error', message: String(err && err.message) }) }
    return buildFromTemplate.call(Menu, template)
  }

  record({ type: 'start', version: app.getVersion(), packaged: app.isPackaged, argv: process.argv.slice(1) })
  require('./main.cjs')
}
`
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('e2e-mac-update: macOS only; nothing to do on this platform')
    return 0
  }
  const args = process.argv.slice(2)
  const keep = args.includes('--keep')
  const reuse = args.includes('--reuse')
  const workArg = args.includes('--work') ? args[args.indexOf('--work') + 1] : null
  if (workArg) mkdirSync(workArg, { recursive: true })
  // Why realpath: the app reports its own paths resolved (/private/var/...)
  const work = realpathSync(workArg || mkdtempSync(join(tmpdir(), 'agent-office-e2e-')))

  const arch = process.arch
  const oldVersion = pkg.version
  const newVersion = nextPatch(oldVersion)
  const tag = normaliseTag(newVersion)
  const zipName = macAssetName(newVersion, arch)
  if (!zipName) throw new Error(`no macOS build for ${arch}`)
  console.log(`e2e-mac-update: ${oldVersion} -> ${newVersion} (${arch}) in ${work}`)

  // --- 1. Two builds --------------------------------------------------------
  const oldOut = join(work, 'old')
  const newOut = join(work, 'new')
  const zip = join(newOut, zipName)
  const feed = join(newOut, MAC_FEED_NAME)
  if (!(reuse && existsSync(oldOut) && existsSync(zip) && existsSync(feed))) {
    // Why the variable: the release workflow builds unsigned the same way
    const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    run('npm', ['run', 'build'])
    run('npx', ['electron-builder', '--mac', 'dir', `--${arch}`, '--publish', 'never', `-c.directories.output=${oldOut}`], { env })
    run('npx', ['electron-builder', '--mac', 'zip', `--${arch}`, '--publish', 'never', `-c.extraMetadata.version=${newVersion}`, `-c.directories.output=${newOut}`], { env })
  }
  if (!existsSync(zip) || !existsSync(feed)) throw new Error(`electron-builder did not write ${zipName} and ${MAC_FEED_NAME}`)

  // --- 2. "Install" the old app, and give the copy the test's entry file ------
  const applications = join(work, 'Applications')
  const installed = join(applications, APP_NAME)
  const userData = join(work, 'user-data')
  const events = join(work, 'events.jsonl')
  for (const stale of [applications, userData, join(work, 'office-home'), join(work, 'claude-config'), events]) rmSync(stale, { recursive: true, force: true })
  for (const dir of [applications, userData, join(work, 'office-home'), join(work, 'claude-config')]) mkdirSync(dir, { recursive: true })
  execFileSync('/usr/bin/ditto', [findBuiltApp(oldOut), installed])

  const feedPort = await freePort()
  const appPackage = join(installed, 'Contents', 'Resources', 'app', 'package.json')
  const appPkg = JSON.parse(readFileSync(appPackage, 'utf8'))
  const pristineMain = appPkg.main
  writeFileSync(join(installed, 'Contents', 'Resources', 'app', 'electron', 'e2e-entry.cjs'), entrySource({
    events,
    userData,
    feedPort,
    tag,
    releasePage: `https://github.com/W17ant/Claude-Office/releases/tag/${tag}`,
    restartLabel: restartMenuLabel(tag),
  }))
  writeFileSync(appPackage, JSON.stringify({ ...appPkg, main: 'electron/e2e-entry.cjs' }, null, 2))

  // --- 3. The release, on 127.0.0.1 -------------------------------------------
  // github.com/<repo>/releases/download/<tag>/<name> answers 302 to the asset
  // host with a signed query, as GitHub does; the asset host serves the bytes.
  const assets = { [MAC_FEED_NAME]: feed, [zipName]: zip }
  const routes = new Map()
  for (const [name, file] of Object.entries(assets)) {
    const first = new URL(releaseAssetUrl(newVersion, name))
    routes.set(`/${first.host}${first.pathname}`, { redirect: `https://${ASSET_HOST}/e2e/${name}?sig=e2e` })
    routes.set(`/${ASSET_HOST}/e2e/${name}`, { file })
  }
  const served = []
  const feedServer = createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    served.push(`${route ? (route.redirect ? 302 : 200) : 404} ${req.url}`)
    if (!route) { res.writeHead(404); return res.end() }
    if (route.redirect) { res.writeHead(302, { Location: route.redirect }); return res.end() }
    res.writeHead(200, { 'Content-Length': statSync(route.file).size })
    createReadStream(route.file).pipe(res)
  })
  await new Promise((done) => feedServer.listen(feedPort, '127.0.0.1', done))

  // --- 4. Run the old app and let it update itself -----------------------------
  const officePort = await freePort()
  const env = {
    ...process.env,
    AGENT_OFFICE_PORT: String(officePort),
    AGENT_OFFICE_HOME: join(work, 'office-home'),
    CLAUDE_CONFIG_DIR: join(work, 'claude-config'),
  }
  // Why removed: either would change what the packaged app does (run as plain
  // Node; skip the update check and quit after a screenshot)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENT_OFFICE_SCREENSHOT

  const checks = []
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }

  let failure = null
  try {
    const executable = join(installed, 'Contents', 'MacOS', plistValue(installed, 'CFBundleExecutable'))
    const appLog = openSync(join(work, 'app.log'), 'a')
    console.log(`\nStarting ${executable} on port ${officePort}`)
    const child = spawn(executable, [`--user-data-dir=${userData}`], { env, stdio: ['ignore', appLog, appLog] })
    const exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))

    const first = await Promise.race([exited, sleep(UPDATE_TIMEOUT_MS).then(() => null)])
    if (!first) throw new Error('the old app was still running after ten minutes')
    console.log(`The old app exited (code ${first.code}, signal ${first.signal})`)

    // The swap helper is on its own now: wait for the new version to be running
    const newExecutable = () => bundleProcesses(installed).some((proc) => proc.comm.startsWith(join(installed, 'Contents', 'MacOS')))
    const swapLog = join(userData, 'update-swap.log')
    const deadline = Date.now() + RELAUNCH_TIMEOUT_MS
    let healthy = false
    while (Date.now() < deadline && !healthy) {
      await sleep(500)
      if (!existsSync(swapLog) || !newExecutable()) continue
      healthy = await fetch(`http://127.0.0.1:${officePort}/health`).then((res) => res.ok, () => false)
    }

    // --- 5. What happened ------------------------------------------------------
    const log = readEvents(events)
    const of = (type) => log.filter((event) => event.type === type)
    const start = of('start')[0]
    const backend = of('backend')[0]
    console.log('')
    check('the old app started packaged, at the old version', start && start.packaged === true && start.version === oldVersion, start && `${start.version}`)
    check('it used the test user-data directory', of('wrong-user-data').length === 0)
    check('it chose the mac backend for the copied bundle', backend && backend.bundle === installed && backend.parent === applications && backend.arch === arch, backend && backend.bundle)
    check('the menu showed the download, then "Restart to update"', of('menu').some((e) => e.label === downloadingMenuLabel(tag) && e.enabled === false) && of('menu').some((e) => e.label === restartMenuLabel(tag)), of('menu').map((e) => e.label).join(' | '))
    check('the "Download" fallback item never appeared', !of('menu').some((e) => e.label === updateMenuLabel({ version: tag })))
    check('"Update automatically" was offered, checked', of('menu').some((e) => e.label === 'Update automatically' && e.checked === true))
    check('one "is ready" notification, and no "is available" one', of('notification').length === 1 && of('notification')[0].title.endsWith(`${tag} is ready`), of('notification').map((e) => e.title).join(' | '))
    check('it asked github.com for the feed and the zip, and followed the redirect to the asset host',
      [MAC_FEED_NAME, zipName].every((name) => of('request').some((e) => e.url === releaseAssetUrl(newVersion, name)) && of('request').some((e) => e.url === `https://${ASSET_HOST}/e2e/${name}`)),
      `${served.length} requests served`)
    check('"Restart to update" was clicked and the app quit by itself', of('click').length === 1 && first.code === 0, `exit ${first.code}`)

    const swapText = existsSync(swapLog) ? readFileSync(swapLog, 'utf8') : ''
    check('the swap helper logged the update', swapText.includes(`updated ${installed}`), swapText.trim().split('\n').pop())
    check('the installed bundle is the new version', plistValue(installed, 'CFBundleShortVersionString') === newVersion && plistValue(installed, 'CFBundleIdentifier') === APP_BUNDLE_ID, plistValue(installed, 'CFBundleShortVersionString'))
    const swappedPkg = JSON.parse(readFileSync(appPackage, 'utf8'))
    check('it is the untouched build (its own main, no test entry)', swappedPkg.version === newVersion && swappedPkg.main === pristineMain && !existsSync(join(installed, 'Contents', 'Resources', 'app', 'electron', 'e2e-entry.cjs')), swappedPkg.main)
    const left = readdirSync(applications).filter((name) => name !== APP_NAME)
    check('nothing is left beside the app (no staging directory, no old bundle)', left.length === 0, left.join(', '))
    check('the new version is running from the same path', newExecutable())
    check('its server answers on the port the old app was started with', healthy, `port ${officePort}`)

    // Why polled: the relaunched app clears `applying` when it starts its
    // update check, a moment after its server is up
    let state = {}
    for (let i = 0; i < 40; i++) {
      try { state = JSON.parse(readFileSync(join(userData, 'update-check.json'), 'utf8')) } catch {}
      if (!('applying' in state)) break
      await sleep(500)
    }
    check('the new version saw the install had worked (update-check.json)', !('applying' in state) && !('failedVersion' in state) && state.readyNotifiedVersion === tag, JSON.stringify(state))
    check('the zip that was installed is the one the feed names', readFileSync(feed, 'utf8').includes(createHash('sha512').update(readFileSync(zip)).digest('base64')))
  } catch (err) {
    failure = err
  } finally {
    await stopBundle(installed)
    await new Promise((done) => feedServer.close(done))
  }

  if (failure) {
    console.error(`\ne2e-mac-update: ${failure.message}`)
    console.error(`The app's output is in ${join(work, 'app.log')}; the work directory is kept.`)
    return 1
  }
  const failed = checks.filter((item) => !item.ok)
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`)
  if (failed.length || keep) console.log(`Work directory kept: ${work}`)
  else rmSync(work, { recursive: true, force: true })
  return failed.length ? 1 : 0
}

main().then((code) => process.exit(code), (err) => {
  console.error(`e2e-mac-update: ${err.stack || err.message}`)
  process.exit(1)
})
