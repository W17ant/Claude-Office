'use strict'

const { app, BrowserWindow, Menu, dialog, screen, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')
const {
  APP_NAME,
  serverPortFromEnv,
  serverUrls,
  viewportFor,
  minSizeFor,
  defaultSizeFor,
  fitZoom,
  compactCss,
  clampBounds,
  placeInWorkArea,
  readWindowState,
  writeWindowState,
  statusText,
  windowTitle,
  trayMenuTemplate,
} = require('./helpers.cjs')
const { createTray } = require('./tray.cjs')

// The server's port: AGENT_OFFICE_PORT, default 3334 (helpers.cjs mirrors
// server/config.js). The same number goes to the server child's environment,
// the window's load URL, the navigation allowlist and the tray's poller, so
// `AGENT_OFFICE_PORT=4000 electron .` — or the variable in the environment a
// packaged app is launched with — moves the whole desktop app at once.
const SERVER_PORT = serverPortFromEnv(process.env)
const { serverUrl: SERVER_URL, healthUrl: HEALTH_URL, viteUrl: VITE_URL, allowedOrigins } = serverUrls(SERVER_PORT)

// Allowed origins for navigation and new-window events: the Vite dev server
// (3333) and the office server (SERVER_PORT), by name or loopback IP.
const ALLOWED_ORIGINS = new Set(allowedOrigins)

// The server sits next to this file in both layouts: <repo>/server in dev and
// <app>/resources/app/server in a packaged build (asar is off — see the build
// section of package.json — so the server, dist/ and node_modules are plain
// files the server process can read).
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js')

// Window icon for Linux (macOS and Windows take it from the bundle / the exe).
const WINDOW_ICON = path.join(__dirname, 'assets', 'icon.png')

// Closing the window keeps the app in the tray on macOS (the Dock icon brings
// it back) and Windows. Linux desktops do not all show a tray, so there a
// close is a quit — nothing is left running invisibly.
const HIDE_ON_CLOSE = process.platform !== 'linux'

let win = null
let tray = null
let serverProcess = null
let quitting = false

// Window state: the full window's bounds, the compact widget's bounds, which
// mode is on and the always-on-top preference, in userData/window-state.json.
let state = {}
let compact = false
let compactCssKey = null
let saveTimer = null
let lastStatus = '' // the tray's last status line, for the right-click menu

function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json')
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Check if the server is already responding on SERVER_PORT.
 * Returns a Promise<boolean>.
 */
function isServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Poll /health until the server responds OK or we exhaust retries.
 * Returns a Promise<boolean> — true if ready, false if timed out.
 */
function waitForServer(retries = 30, intervalMs = 300) {
  return new Promise((resolve) => {
    let attempts = 0

    function attempt() {
      attempts++
      const req = http.get(HEALTH_URL, (res) => {
        if (res.statusCode === 200) {
          resolve(true)
        } else if (attempts < retries) {
          setTimeout(attempt, intervalMs)
        } else {
          resolve(false)
        }
      })
      req.on('error', () => {
        if (attempts < retries) {
          setTimeout(attempt, intervalMs)
        } else {
          resolve(false)
        }
      })
      req.setTimeout(1000, () => {
        req.destroy()
        if (attempts < retries) {
          setTimeout(attempt, intervalMs)
        } else {
          resolve(false)
        }
      })
    }

    attempt()
  })
}

/**
 * Start the Express/WebSocket server as a child process.
 *
 * Packaged: run it on the Node bundled inside Electron (ELECTRON_RUN_AS_NODE
 * turns this very binary into a plain Node). That is the ABI the packaged
 * better-sqlite3 is built for (see electron/after-pack.cjs), and it does not
 * depend on a `node` on the user's PATH — apps opened from Finder, the Dock or
 * a launcher get a bare system PATH without Homebrew/nvm.
 *
 * Dev: node_modules are built for the system Node, so use the Node that runs
 * npm (`npm_node_execpath`, set by `npm run ...`), or `node` from PATH.
 */
function startServer() {
  const packaged = app.isPackaged
  const command = packaged ? process.execPath : (process.env.npm_node_execpath || 'node')
  // The child binds the port this process resolved, so an unparsable
  // AGENT_OFFICE_PORT falls back to 3334 on both sides alike.
  const env = { ...process.env, AGENT_OFFICE_PORT: String(SERVER_PORT) }
  if (packaged) env.ELECTRON_RUN_AS_NODE = '1'

  console.log(`[main] Spawning server: ${command} ${SERVER_ENTRY} (port ${SERVER_PORT})`)

  serverProcess = spawn(command, [SERVER_ENTRY], {
    stdio: 'pipe',
    env,
  })

  serverProcess.stdout.on('data', (data) => {
    process.stdout.write(`[server] ${data}`)
  })

  serverProcess.stderr.on('data', (data) => {
    process.stderr.write(`[server] ${data}`)
  })

  serverProcess.on('exit', (code, signal) => {
    console.log(`[main] Server process exited — code=${code} signal=${signal}`)
    serverProcess = null
  })

  serverProcess.on('error', (err) => {
    console.error('[main] Failed to start server process:', err.message)
    serverProcess = null
  })
}

/**
 * Kill the server child process if we own it.
 */
function stopServer() {
  if (serverProcess) {
    console.log('[main] Stopping server process...')
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

// ---------------------------------------------------------------------------
// Debug aid: AGENT_OFFICE_SCREENSHOT=<file.png> captures the window a moment
// after the page has loaded (AGENT_OFFICE_SCREENSHOT_DELAY_MS, default 3000),
// then quits. Used to verify a packaged build headlessly (xvfb); with
// --compact it captures the compact widget.
// ---------------------------------------------------------------------------

function maybeCaptureScreenshot() {
  const file = process.env.AGENT_OFFICE_SCREENSHOT
  if (!file) return
  const delay = Number(process.env.AGENT_OFFICE_SCREENSHOT_DELAY_MS) || 3000
  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage()
      fs.writeFileSync(file, image.toPNG())
      const { width, height } = image.getSize()
      const [cw, ch] = win.getContentSize()
      console.log(`[main] Screenshot written to ${file} (${width}x${height}; content ${cw}x${ch}, zoom ${win.webContents.getZoomFactor().toFixed(3)}, compact=${compact})`)
    } catch (err) {
      console.error('[main] Screenshot failed:', err.message)
    }
    quitApp()
  }, delay)
}

// ---------------------------------------------------------------------------
// Window state and modes
// ---------------------------------------------------------------------------

/** Bounds for a mode: the saved ones, else the defaults, clamped on screen. */
function boundsFor(isCompact, near) {
  const saved = isCompact ? state.compactBounds : state.bounds
  const display = saved ? screen.getDisplayMatching(saved) : near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay()
  const { workArea } = display
  const wanted = saved ?? placeInWorkArea(defaultSizeFor(isCompact), workArea, isCompact ? 'top-right' : 'center')
  return clampBounds(wanted, workArea, minSizeFor(isCompact))
}

/** Record the current bounds for the current mode (not while minimized etc.). */
function rememberBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
  const bounds = win.getBounds()
  if (compact) state.compactBounds = bounds
  else state.bounds = bounds
}

function saveState() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  state.compact = compact
  if (!writeWindowState(stateFile(), state)) {
    console.error(`[main] Could not write ${stateFile()}`)
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { rememberBounds(); saveState() }, 500)
}

/** Zoom the page so the mode's viewport fits the window content area. */
function applyZoom() {
  if (!win || win.isDestroyed()) return
  const [width, height] = win.getContentSize()
  win.webContents.setZoomFactor(fitZoom({ width, height }, viewportFor(compact)))
}

/** Insert (compact) or remove (full) the CSS that centres the room column. */
async function applyCompactCss() {
  if (!win || win.isDestroyed()) return
  const contents = win.webContents
  if (compactCssKey) {
    const key = compactCssKey
    compactCssKey = null
    try { await contents.removeInsertedCSS(key) } catch {}
  }
  if (compact) {
    try { compactCssKey = await contents.insertCSS(compactCss()) } catch (err) {
      console.error('[main] Could not apply compact CSS:', err.message)
    }
  }
}

function isAlwaysOnTop() {
  return compact || state.alwaysOnTop === true
}

/** Switch between the full office and the compact widget. */
function setCompact(next) {
  next = !!next
  if (!win || win.isDestroyed() || next === compact) return
  rememberBounds()
  const near = win.getBounds()
  compact = next
  const min = minSizeFor(compact)
  win.setMinimumSize(min.width, min.height)
  win.setBounds(boundsFor(compact, near))
  win.setAlwaysOnTop(isAlwaysOnTop(), 'floating')
  win.setVisibleOnAllWorkspaces(compact, { visibleOnFullScreen: compact })
  applyCompactCss()
  applyZoom()
  console.log(`[main] ${compact ? 'Compact widget' : 'Full office'} (${win.getContentSize().join('x')})`)
  saveState()
  refreshMenus()
}

function setAlwaysOnTop(flag) {
  state.alwaysOnTop = !!flag
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(isAlwaysOnTop(), 'floating')
  saveState()
  refreshMenus()
}

/** Back to the mode's default size and spot. */
function resetBounds() {
  if (!win || win.isDestroyed()) return
  if (compact) delete state.compactBounds
  else delete state.bounds
  win.setBounds(boundsFor(compact, win.getBounds()))
  applyZoom()
  saveState()
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function toggleWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isVisible() && !win.isMinimized()) win.hide()
  else showWindow()
  refreshMenus()
}

function openInBrowser() {
  shell.openExternal(`${SERVER_URL}/`)
}

function quitApp() {
  quitting = true
  app.quit()
}

// ---------------------------------------------------------------------------
// Menus: the application menu (menu bar on macOS, accelerators everywhere),
// the tray menu and the window's right-click menu, which mirrors the tray.
// ---------------------------------------------------------------------------

function menuState() {
  return {
    visible: !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    compact,
    alwaysOnTop: state.alwaysOnTop === true,
  }
}

const menuActions = { toggleWindow, setCompact, setAlwaysOnTop, openInBrowser, quit: quitApp }

function applicationMenuTemplate() {
  const isMac = process.platform === 'darwin'
  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Office',
      submenu: [
        { label: 'Compact widget', type: 'checkbox', checked: compact, accelerator: 'CmdOrCtrl+Shift+C', click: () => setCompact(!compact) },
        { label: 'Always on top', type: 'checkbox', checked: isAlwaysOnTop(), enabled: !compact, accelerator: 'CmdOrCtrl+Shift+T', click: () => setAlwaysOnTop(!state.alwaysOnTop) },
        { label: 'Reset window size', click: resetBounds },
        { type: 'separator' },
        { label: 'Open in browser', accelerator: 'CmdOrCtrl+Shift+O', click: openInBrowser },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]
}

function refreshMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()))
  if (tray) tray.refresh()
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

async function createWindow() {
  // Check if a server is already running (e.g. launched separately during dev)
  const alreadyRunning = await isServerRunning()

  if (alreadyRunning) {
    console.log(`[main] Server already running on port ${SERVER_PORT} — skipping spawn`)
  } else {
    startServer()
    const ready = await waitForServer()
    if (ready) {
      console.log(`[main] Server is ready on ${SERVER_URL}`)
    } else if (app.isPackaged) {
      // The packaged app has nothing to show without its server — say so
      // instead of opening a blank window.
      console.error('[main] Server did not become ready in time')
      dialog.showErrorBox(
        APP_NAME,
        `The office server did not start on port ${SERVER_PORT}.\n\n` +
        `If something else is using that port, stop it and open ${APP_NAME} again, ` +
        `or launch it with AGENT_OFFICE_PORT set to a free port.`,
      )
      quitApp()
      return
    } else {
      console.error('[main] Server did not become ready in time — continuing anyway (start it with `npm run server`)')
    }
  }

  state = readWindowState(stateFile())
  compact = app.commandLine.hasSwitch('compact') || state.compact === true
  const bounds = boundsFor(compact)
  const min = minSizeFor(compact)
  console.log(`[main] Window ${compact ? 'compact' : 'full'} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} (state: ${stateFile()})`)

  win = new BrowserWindow({
    ...bounds,
    useContentSize: true,
    minWidth: min.width,
    minHeight: min.height,
    title: APP_NAME,
    icon: process.platform === 'linux' ? WINDOW_ICON : undefined,
    alwaysOnTop: isAlwaysOnTop(),
    // The office draws its own title bar (the drag region is in office.css)
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    skipTaskbar: false,
    backgroundColor: '#0a0a0f',
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      zoomFactor: fitZoom(bounds, viewportFor(compact)),
    },
  })

  // Prevent navigation away from the app origin
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const origin = new URL(url).origin
      if (!ALLOWED_ORIGINS.has(origin)) {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })

  // Prevent opening new windows (links, window.open, etc.)
  win.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  // Inserted CSS and the zoom do not survive a reload: apply them per load.
  win.webContents.on('dom-ready', applyZoom)
  win.webContents.on('did-finish-load', () => {
    console.log(`[main] Window loaded ${win.webContents.getURL()}`)
    compactCssKey = null
    applyCompactCss()
    applyZoom()
    maybeCaptureScreenshot()
  })

  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    console.error(`[main] Window failed to load ${failedUrl}: ${description} (${code})`)
  })

  // Right-click anywhere that is not a text field: the tray menu, so the
  // frameless window has its controls on every platform.
  win.webContents.on('context-menu', (event, params) => {
    if (params.isEditable) return
    event.preventDefault()
    Menu.buildFromTemplate(trayMenuTemplate({ ...menuState(), status: lastStatus }, menuActions)).popup({ window: win })
  })

  win.on('resize', () => { applyZoom(); scheduleSave() })
  win.on('move', scheduleSave)
  win.on('show', refreshMenus)
  win.on('hide', refreshMenus)
  win.on('minimize', refreshMenus)
  win.on('restore', refreshMenus)

  win.on('close', (event) => {
    rememberBounds()
    saveState()
    if (!quitting && HIDE_ON_CLOSE) {
      event.preventDefault()
      win.hide()
      refreshMenus()
    }
  })

  win.on('closed', () => { win = null })

  if (compact) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Dev: the Vite dev server. Packaged: the office server, which serves the
  // built UI from its root — one port for the page, its assets and the
  // WebSocket, with an http:// origin the server's allowlist accepts.
  const url = app.isPackaged ? `${SERVER_URL}/` : VITE_URL
  console.log(`[main] Loading ${url}`)
  win.loadURL(url)

  refreshMenus()
  createTrayIcon()
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTrayIcon() {
  try {
    tray = createTray({
      serverUrl: SERVER_URL,
      getState: menuState,
      actions: {
        ...menuActions,
        onSummary(summary) {
          lastStatus = statusText(summary)
          const title = windowTitle(summary)
          if (win && !win.isDestroyed() && win.getTitle() !== title) win.setTitle(title)
        },
      },
    })
    console.log('[main] Tray created')
  } catch (err) {
    tray = null
    console.error('[main] Tray unavailable:', err.message)
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// One packaged instance: opening the app again (from the Dock, a launcher or
// the Start menu) brings the existing window back instead of fighting over
// the port. Dev runs (`electron .`) are not locked, so one can run beside a
// packaged app.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(createWindow)

  app.on('window-all-closed', () => {
    stopServer()
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    if (tray) { tray.dispose(); tray = null }
    stopServer()
  })

  app.on('activate', () => {
    if (win && !win.isDestroyed()) showWindow()
    else if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}
