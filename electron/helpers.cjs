'use strict'

/**
 * Pure helpers for the desktop app: window geometry, the window-state file,
 * the tray's status text and menu. Nothing here needs Electron, so
 * tests/electron-helpers.test.ts runs it in plain Node; main.cjs and tray.cjs
 * supply the `screen`, `BrowserWindow` and `Tray` side.
 */

const fs = require('fs')
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
  const viteUrl = `http://localhost:${uiPort}`
  return {
    port,
    serverUrl,
    healthUrl: `${serverUrl}/health`,
    viteUrl,
    allowedOrigins: [
      viteUrl,
      `http://127.0.0.1:${uiPort}`,
      `http://localhost:${port}`,
      serverUrl,
    ],
  }
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
 * openInBrowser and quit. Compact mode is always on top, so the toggle is
 * shown checked and disabled there.
 */
function trayMenuTemplate(state, actions) {
  return [
    { label: state.status ? `${APP_NAME} — ${state.status}` : APP_NAME, enabled: false },
    { type: 'separator' },
    { label: state.visible ? 'Hide office' : 'Show office', click: () => actions.toggleWindow() },
    { type: 'separator' },
    {
      label: 'Compact widget',
      type: 'checkbox',
      checked: !!state.compact,
      click: () => actions.setCompact(!state.compact),
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: !!state.compact || !!state.alwaysOnTop,
      enabled: !state.compact,
      click: () => actions.setAlwaysOnTop(!state.alwaysOnTop),
    },
    { type: 'separator' },
    { label: 'Open in browser', click: () => actions.openInBrowser() },
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
