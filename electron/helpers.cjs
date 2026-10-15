'use strict'

/**
 * Pure helpers for the desktop app: window geometry, the window-state file,
 * the tray's status text and menu, and the office link (the page URL with
 * the office token). Nothing here needs Electron, so
 * tests/electron-helpers.test.ts runs it in plain Node; main.cjs and tray.cjs
 * supply the `screen`, `BrowserWindow` and `Tray` side, and
 * scripts/open-office.mjs (`npm run open`) shares the link helpers.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const APP_NAME = 'Agent Office'

// ---------------------------------------------------------------------------
// The server's port
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_PORT = 3334
const VITE_DEV_PORT = 3333

/**
 * The office server's port from AGENT_OFFICE_PORT: the same parse as
 * server/config.js readPort (which this file cannot import: the server is
 * ESM and the Electron main process is CommonJS), so the app, the server it
 * spawns and the hooks always agree. Anything that is not a port is 3334.
 */
function serverPortFromEnv(env = process.env) {
  const raw = env && env.AGENT_OFFICE_PORT
  if (typeof raw !== 'string' || raw === '') return DEFAULT_SERVER_PORT
  const text = raw.trim()
  if (!/^\d{1,5}$/.test(text)) return DEFAULT_SERVER_PORT
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : DEFAULT_SERVER_PORT
}

/**
 * Every URL the main process derives from the port: the server (what the
 * packaged window loads and the tray polls), its health route, the Vite dev
 * server (what `electron .` loads), and the origins the window may navigate
 * to — both servers, by name or loopback IP.
 */
function serverUrls(port = DEFAULT_SERVER_PORT, uiPort = VITE_DEV_PORT) {
  const serverUrl = `http://127.0.0.1:${port}`
  const viteUrl = `http://127.0.0.1:${uiPort}`
  return {
    port,
    serverUrl,
    healthUrl: `${serverUrl}/health`,
    viteUrl,
    allowedOrigins: [
      viteUrl,
      serverUrl,
    ],
  }
}

// ---------------------------------------------------------------------------
// Reusing a server that is already on the port
//
// The app first asks GET /health whether an office server already answers on
// its port (one started with start-office.sh, `npm run server`, another copy
// of the app). The packaged window loads the page from that server, so a
// server with no built UI — a checkout run with the Vite dev server, which
// answers GET / with a 404 JSON body — is no use to it, and spawning a second
// server on the same port would only fail (and must not overwrite the token
// file the first one wrote). The dev window loads the page from Vite and
// reuses any office server.
// ---------------------------------------------------------------------------

/**
 * What GET /health said: 'none' (no answer, or not a 200: no office server
 * there), 'usable' (it serves the office page: `uiAvailable: true`), 'no-ui'
 * (`uiAvailable: false`, or a 200 that is not the office's JSON), 'unknown'
 * (an office server too old to report `uiAvailable`: ask GET / instead).
 */
function classifyHealth(statusCode, bodyText) {
  if (statusCode !== 200) return 'none'
  let body
  try { body = JSON.parse(String(bodyText)) } catch { return 'no-ui' }
  if (!body || typeof body !== 'object' || body.status !== 'ok') return 'no-ui'
  if (body.uiAvailable === true) return 'usable'
  if (body.uiAvailable === false) return 'no-ui'
  return 'unknown'
}

/** What GET / said, for a server whose /health did not tell: the office page is a 200 HTML document. */
function classifyIndex(statusCode, contentType) {
  return statusCode === 200 && /^text\/html\b/i.test(String(contentType || '')) ? 'usable' : 'no-ui'
}

/**
 * What to do about the server found on the port: 'start' one (nothing is
 * there), 'reuse' it, or report a 'conflict' (the packaged window would show
 * an error body instead of the office).
 */
function serverPlan(found, packaged) {
  if (found === 'none') return 'start'
  if (found === 'usable' || !packaged) return 'reuse'
  return 'conflict'
}

/** The dialog for a 'conflict': what is on the port and the ways out. */
function serverConflictMessage(port) {
  return `Another Agent Office server is already running on port ${port}, but it has no built office page to show ` +
    '(a checkout started with start-office.sh or `npm run dev:all`, say).\n\n' +
    `Stop that server, or run \`npm run build\` in its checkout, or launch ${APP_NAME} with AGENT_OFFICE_PORT set to a free port.`
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/**
 * Run `fn` at most once at a time: a call while one is in flight gets that
 * call's promise instead of a second run. The app's startup (probe the port,
 * spawn the server, wait for it, open the window) takes seconds, and macOS
 * sends 'activate' for a Dock click during it; a second run would spawn a
 * second server and open a second window. `pending()` says whether a run is
 * in flight.
 */
function singleFlight(fn) {
  let inFlight = null
  const run = (...args) => {
    if (inFlight) return inFlight
    inFlight = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => { inFlight = null })
    return inFlight
  }
  run.pending = () => inFlight !== null
  return run
}

/**
 * What the app does when it is opened again (macOS 'activate', or a second
 * instance): nothing while it is still starting (the window is on its way)
 * or on its way out (a startup that ended in an error dialog quits), show
 * the window it has, or create one when there is none.
 */
function reopenAction({ quitting = false, starting, hasWindow, windowCount }) {
  if (quitting || starting) return 'none'
  if (hasWindow) return 'show'
  return windowCount === 0 ? 'create' : 'none'
}

/**
 * The server child this app owns. An 'exit' or 'error' from a child that is
 * no longer the current one — a duplicate that lost the port — leaves the
 * slot alone, so the app never loses track of the server it must stop.
 */
function childSlot() {
  let current = null
  return {
    get: () => current,
    adopt(child) { current = child; return child },
    release(child) { if (current === child) current = null },
    take() { const child = current; current = null; return child },
  }
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
//
// The window is frameless, and on Windows and Linux a frameless window draws
// no menu bar, so nothing there shows the application menu or promises its
// accelerators. The window handles these keys itself (main.cjs, before the
// page or a menu sees them); the application menu lists the same
// accelerators, from this table, so the two cannot drift apart.
// ---------------------------------------------------------------------------

const SHORTCUTS = Object.freeze([
  Object.freeze({ action: 'toggleCompact', accelerator: 'CmdOrCtrl+Shift+C', code: 'KeyC' }),
  Object.freeze({ action: 'toggleAlwaysOnTop', accelerator: 'CmdOrCtrl+Shift+T', code: 'KeyT' }),
  Object.freeze({ action: 'openInBrowser', accelerator: 'CmdOrCtrl+Shift+O', code: 'KeyO' }),
  // Cmd/Ctrl+0 resets the zoom in a browser; with Shift it resets the window
  Object.freeze({ action: 'resetBounds', accelerator: 'CmdOrCtrl+Shift+0', code: 'Digit0' }),
])

/** The accelerator string for an action, for the application menu. */
function acceleratorFor(action) {
  const shortcut = SHORTCUTS.find(s => s.action === action)
  return shortcut ? shortcut.accelerator : undefined
}

/**
 * The action an Electron `before-input-event` input asks for, or null:
 * Cmd+Shift (macOS) or Ctrl+Shift (elsewhere) and the key, matched by its
 * physical position (`code`) so a keyboard layout cannot move it. A held key
 * repeating does not toggle a mode back and forth.
 */
function shortcutFor(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat) return null
  const mac = platform === 'darwin'
  const primary = mac ? input.meta : input.control
  const other = mac ? input.control : input.meta
  if (!primary || other || !input.shift || input.alt) return null
  const shortcut = SHORTCUTS.find(s => s.code === input.code)
  return shortcut ? shortcut.action : null
}

// ---------------------------------------------------------------------------
// The office link
//
// The office page shows conversation text and may answer permission dialogs
// only once its WebSocket presents the office token, the contents of the
// 0600 auth-token file in the runtime dir (server/index.js, "The
// WebSocket"). The page cannot read files, so it is handed the token in the
// URL fragment, http://127.0.0.1:3334/#token=<token>, which a browser never
// sends to a server; the page keeps it and strips it from the address bar
// (src/officeToken.ts). The window loads that link directly. A browser is
// sent a small redirect page in the runtime dir instead of the link itself:
// an opener's command line — and that of a browser it starts — can be read
// by every local user (`ps`, /proc/<pid>/cmdline) while it runs, a file in
// the 0700 runtime dir cannot. Jupyter opens its notebook the same way.
// ---------------------------------------------------------------------------

// What the server writes: 32 random bytes as 64 lowercase hex digits
const OFFICE_TOKEN_PATTERN = /^[0-9a-f]{64}$/

/** The runtime dir, as the server resolves it: AGENT_OFFICE_HOME, else ~/.agent-office. */
function runtimeDirFromEnv(env = process.env, home = os.homedir()) {
  const dir = env && env.AGENT_OFFICE_HOME
  return typeof dir === 'string' && dir !== '' ? dir : path.join(home, '.agent-office')
}

/** The office token in `file`, or null when it is missing, unreadable or not a token. */
function readOfficeToken(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    return OFFICE_TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  }
}

/**
 * Whether a /health answer proves it comes from the office holding `token`:
 * `proof` must be HMAC-SHA256(token, 'office-health:' + challenge), the
 * challenge being fresh random hex the caller sent (server/index.js
 * officeProof). Compared in constant time. The desktop app and npm run open
 * check it before they hand the token to whatever answers on the port.
 */
function officeProofMatches(token, challenge, proof) {
  if (typeof token !== 'string' || !token || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false
  const { createHmac, timingSafeEqual } = require('crypto')
  const expected = createHmac('sha256', token).update(`office-health:${challenge}`).digest()
  return timingSafeEqual(expected, Buffer.from(proof, 'hex'))
}

/** A fresh /health challenge: 16 random bytes as hex. */
function healthChallenge() {
  return require('crypto').randomBytes(16).toString('hex')
}

/** The page URL with the token in its fragment (the bare page without a token). */
function officeLink(base, token) {
  const root = `${String(base).replace(/\/+$/, '')}/`
  return typeof token === 'string' && OFFICE_TOKEN_PATTERN.test(token) ? `${root}#token=${token}` : root
}

/** A URL fit for a log line: a token in its fragment is masked. */
function redactLink(url) {
  return String(url).replace(/#token=[^&]*/, '#token=…')
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

/** The redirect page a browser is sent to: straight on to `link`, a plain link as the fallback. */
function redirectPage(link) {
  const href = escapeHtml(link)
  const target = JSON.stringify(String(link)).replace(/</g, '\\u003c')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    `<meta http-equiv="refresh" content="0;url=${href}">`,
    '<title>Agent Office</title></head>',
    `<body><script>location.replace(${target})</script>`,
    `<p><a href="${href}">Open Agent Office</a></p></body></html>`,
    '',
  ].join('\n')
}

/**
 * Write the redirect page for `link` to `file`, readable by this user only:
 * an old file is unlinked and the new one created exclusively, so a symlink
 * planted there is replaced, not written through. Returns the path.
 */
function writeRedirectPage(file, link) {
  try { fs.unlinkSync(file) } catch (err) { if (err.code !== 'ENOENT') throw err }
  fs.writeFileSync(file, redirectPage(link), { mode: 0o600, flag: 'wx' })
  try { fs.chmodSync(file, 0o600) } catch {}
  return file
}

// ---------------------------------------------------------------------------
// The office layout
// ---------------------------------------------------------------------------

/**
 * The office UI is a fixed layout, centred in the page: `.app-wrapper` in
 * src/styles/office.css is 1056×682 (border-box, 1px border) and never
 * reflows. The window therefore shows it at a zoom factor that fits — the
 * whole layout in the full window, the room column (everything left of the
 * 300px `.slack-panel` and its 1px border) in the compact widget.
 */
const LAYOUT = Object.freeze({ width: 1056, height: 682 })
const LAYOUT_BORDER = 1
const CHAT_PANEL_WIDTH = 300 + 1
const ROOM_VIEWPORT = Object.freeze({
  width: LAYOUT.width - LAYOUT_BORDER - CHAT_PANEL_WIDTH, // 754: left border + room column
  height: LAYOUT.height,
})

/** Smallest window per mode (content size); the office is zoomed to fit. */
const MIN_SIZE = Object.freeze({
  full: Object.freeze({ width: 528, height: 341 }),    // half scale
  compact: Object.freeze({ width: 302, height: 273 }), // 0.4 scale of the room column
})

/** The compact widget opens at this scale of the room column. */
const COMPACT_DEFAULT_ZOOM = 0.6
const ZOOM_RANGE = Object.freeze({ min: 0.25, max: 3 })

/** Margin from the work-area edge when a window is first placed top-right. */
const EDGE_MARGIN = 20

/** The CSS-pixel area the window should show for a mode. */
function viewportFor(compact) {
  return compact ? ROOM_VIEWPORT : LAYOUT
}

function minSizeFor(compact) {
  return compact ? MIN_SIZE.compact : MIN_SIZE.full
}

/** Default content size: the layout at 1:1, or the room column at 0.6. */
function defaultSizeFor(compact) {
  if (!compact) return { width: LAYOUT.width, height: LAYOUT.height }
  return {
    width: Math.round(ROOM_VIEWPORT.width * COMPACT_DEFAULT_ZOOM),
    height: Math.round(ROOM_VIEWPORT.height * COMPACT_DEFAULT_ZOOM),
  }
}

/**
 * Zoom factor at which `viewport` CSS pixels fit a content area of `size`
 * device pixels, letterboxed: the smaller of the two ratios, kept within
 * ZOOM_RANGE and rounded to three decimals (Chromium ignores tiny changes).
 */
function fitZoom(size, viewport) {
  const zoom = Math.min(size.width / viewport.width, size.height / viewport.height)
  if (!Number.isFinite(zoom)) return 1
  return Math.round(Math.min(Math.max(zoom, ZOOM_RANGE.min), ZOOM_RANGE.max) * 1000) / 1000
}

/**
 * CSS injected in compact mode. `.app-wrapper` centres itself with
 * `left: 50%; transform: translate(-50%, -50%)`; this moves it so the room
 * column — not the whole layout — is centred in the viewport, pushing the chat
 * panel off the right edge (the page has `overflow: hidden`). Nothing in the
 * layout changes size, so sprite positions are untouched.
 */
function compactCss() {
  const left = Math.round(ROOM_VIEWPORT.width / 2)
  const top = Math.round(ROOM_VIEWPORT.height / 2)
  return `.app-wrapper{left:calc(50% - ${left}px)!important;top:calc(50% - ${top}px)!important;transform:none!important}`
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A {x, y, width, height} with four finite numbers and a positive size. */
function isRect(value) {
  return !!value && typeof value === 'object' &&
    ['x', 'y', 'width', 'height'].every(key => isFiniteNumber(value[key])) &&
    value.width > 0 && value.height > 0
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Fit `bounds` inside `workArea` (a display's area minus taskbar/dock):
 * never smaller than `min`, never larger than the work area, and moved so
 * every edge is on screen. A missing position centres the window. The
 * result is whole pixels.
 */
function clampBounds(bounds, workArea, min = { width: 1, height: 1 }) {
  const b = bounds && typeof bounds === 'object' ? bounds : {}
  const width = Math.round(clampNumber(isFiniteNumber(b.width) ? b.width : min.width, min.width, Math.max(min.width, workArea.width)))
  const height = Math.round(clampNumber(isFiniteNumber(b.height) ? b.height : min.height, min.height, Math.max(min.height, workArea.height)))
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const x = isFiniteNumber(b.x)
    ? Math.round(clampNumber(b.x, workArea.x, Math.max(workArea.x, maxX)))
    : Math.round(workArea.x + (workArea.width - width) / 2)
  const y = isFiniteNumber(b.y)
    ? Math.round(clampNumber(b.y, workArea.y, Math.max(workArea.y, maxY)))
    : Math.round(workArea.y + (workArea.height - height) / 2)
  return { x, y, width, height }
}

/**
 * Where a window of `size` goes on first use: centred, or in the top-right
 * corner (the widget's spot) with a small margin. Clamped to the work area.
 */
function placeInWorkArea(size, workArea, anchor = 'center') {
  if (anchor === 'top-right') {
    return clampBounds({
      x: workArea.x + workArea.width - size.width - EDGE_MARGIN,
      y: workArea.y + EDGE_MARGIN,
      width: size.width,
      height: size.height,
    }, workArea)
  }
  return clampBounds({ width: size.width, height: size.height }, workArea)
}

// ---------------------------------------------------------------------------
// window-state.json
// ---------------------------------------------------------------------------

/**
 * Keep only what the file is meant to hold, with the right types; anything
 * else (an older format, a hand edit, a truncated write) is dropped rather
 * than trusted.
 */
function sanitizeWindowState(raw) {
  const state = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state
  if (isRect(raw.bounds)) state.bounds = pickRect(raw.bounds)
  if (isRect(raw.compactBounds)) state.compactBounds = pickRect(raw.compactBounds)
  if (typeof raw.compact === 'boolean') state.compact = raw.compact
  if (typeof raw.alwaysOnTop === 'boolean') state.alwaysOnTop = raw.alwaysOnTop
  return state
}

function pickRect({ x, y, width, height }) {
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** Read the state file; a missing or unreadable file is an empty state. */
function readWindowState(file) {
  try {
    return sanitizeWindowState(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Write the state file (creating its directory), through a temp file and a
 * rename so a crash mid-write leaves the previous state intact. Returns
 * false, and logs nothing, when the directory cannot be written: window
 * state is a convenience, never a reason to fail.
 */
function writeWindowState(file, state) {
  const clean = sanitizeWindowState(state)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n')
    fs.renameSync(tmp, file)
    return true
  } catch {
    try { fs.unlinkSync(tmp) } catch {}
    return false
  }
}

// ---------------------------------------------------------------------------
// Tray status
// ---------------------------------------------------------------------------

/**
 * What the tray shows, from `GET /agents` ({ agents: [...] }) and
 * `GET /sessions` ({ sessions: [...] }); either may be null when the request
 * failed. Returns null when neither answered (server not reachable).
 *
 *   agents   subagents in the office (not completed)
 *   sessions live Claude Code sessions (each one's own Claude is `main`)
 *   working  subagents working + sessions whose Claude is working
 *   needsYou sessions whose Claude waits on the human (permission, question)
 */
function officeSummary({ agents, sessions } = {}) {
  if (!agents && !sessions) return null
  const agentList = Array.isArray(agents?.agents) ? agents.agents : []
  const live = agentList.filter(a => a && typeof a === 'object' && a.state !== 'completed' && a.state !== 'ended')
  const sessionList = (Array.isArray(sessions?.sessions) ? sessions.sessions : [])
    .filter(s => s && typeof s === 'object' && s.state !== 'ended')
  return {
    agents: live.length,
    sessions: sessionList.length,
    working: live.filter(a => a.state === 'working').length +
      sessionList.filter(s => s.main?.state === 'working').length,
    needsYou: sessionList.filter(s => s.main?.state === 'needs-you').length,
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** One line for the tooltip and the window title. */
function statusText(summary) {
  if (!summary) return 'server not reachable'
  const present = summary.agents + summary.sessions
  if (present === 0) return 'the office is empty'
  const parts = []
  parts.push(summary.working > 0 ? `${summary.working} working` : `${plural(present, 'agent')} in, none working`)
  if (summary.needsYou > 0) parts.push(`${summary.needsYou} need${summary.needsYou === 1 ? 's' : ''} you`)
  return parts.join(', ')
}

/**
 * The text beside the macOS menu-bar icon: the number working, and `N!`
 * when N sessions need you. Empty when the office is quiet or unreachable.
 */
function trayTitle(summary) {
  if (!summary) return ''
  const parts = []
  if (summary.working > 0) parts.push(String(summary.working))
  if (summary.needsYou > 0) parts.push(`${summary.needsYou}!`)
  return parts.join(' ')
}

function windowTitle(summary) {
  return summary ? `${APP_NAME} — ${statusText(summary)}` : APP_NAME
}

/**
 * The tray / right-click menu. `state` is { visible, compact, alwaysOnTop,
 * status }; `actions` supplies toggleWindow, setCompact, setAlwaysOnTop,
 * resetBounds, openInBrowser and quit. Compact mode is always on top, so the
 * toggle is shown checked and disabled there. Every window control is here,
 * because on Windows and Linux the frameless window shows no menu bar: this
 * menu (the tray's, and the window's right-click) is the only one there is.
 */
function trayMenuTemplate(state, actions) {
  // The shortcuts are shown, not registered: the window handles the keys itself
  const hint = action => ({ accelerator: acceleratorFor(action), registerAccelerator: false })
  return [
    { label: state.status ? `${APP_NAME} — ${state.status}` : APP_NAME, enabled: false },
    { type: 'separator' },
    { label: state.visible ? 'Hide office' : 'Show office', click: () => actions.toggleWindow() },
    { type: 'separator' },
    {
      label: 'Compact widget',
      type: 'checkbox',
      checked: !!state.compact,
      ...hint('toggleCompact'),
      click: () => actions.setCompact(!state.compact),
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: !!state.compact || !!state.alwaysOnTop,
      enabled: !state.compact,
      ...hint('toggleAlwaysOnTop'),
      click: () => actions.setAlwaysOnTop(!state.alwaysOnTop),
    },
    { label: 'Reset window size', ...hint('resetBounds'), click: () => actions.resetBounds() },
    { type: 'separator' },
    { label: 'Open in browser', ...hint('openInBrowser'), click: () => actions.openInBrowser() },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => actions.quit() },
  ]
}

module.exports = {
  APP_NAME,
  DEFAULT_SERVER_PORT,
  VITE_DEV_PORT,
  serverPortFromEnv,
  serverUrls,
  classifyHealth,
  officeProofMatches,
  healthChallenge,
  classifyIndex,
  serverPlan,
  serverConflictMessage,
  singleFlight,
  reopenAction,
  childSlot,
  SHORTCUTS,
  acceleratorFor,
  shortcutFor,
  OFFICE_TOKEN_PATTERN,
  runtimeDirFromEnv,
  readOfficeToken,
  officeLink,
  redactLink,
  redirectPage,
  writeRedirectPage,
  LAYOUT,
  ROOM_VIEWPORT,
  MIN_SIZE,
  COMPACT_DEFAULT_ZOOM,
  ZOOM_RANGE,
  viewportFor,
  minSizeFor,
  defaultSizeFor,
  fitZoom,
  compactCss,
  isRect,
  clampBounds,
  placeInWorkArea,
  sanitizeWindowState,
  readWindowState,
  writeWindowState,
  officeSummary,
  statusText,
  trayTitle,
  windowTitle,
  trayMenuTemplate,
}
