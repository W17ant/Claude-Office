'use strict'

const { app, BrowserWindow, dialog, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const http = require('http')

const SERVER_PORT = 3334
const SERVER_HOST = '127.0.0.1'
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`
const HEALTH_URL = `${SERVER_URL}/health`
const VITE_URL = 'http://localhost:3333'

// Allowed origins for navigation and new-window events: the Vite dev server
// (3333) and the office server (3334), by name or loopback IP.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3333',
  'http://127.0.0.1:3333',
  'http://localhost:3334',
  'http://127.0.0.1:3334',
])

// The server sits next to this file in both layouts: <repo>/server in dev and
// <app>/resources/app/server in a packaged build (asar is off — see the build
// section of package.json — so the server, dist/ and node_modules are plain
// files the server process can read).
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'index.js')

let win
let serverProcess = null

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Check if the server is already responding on port 3334.
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
  const env = { ...process.env }
  if (packaged) env.ELECTRON_RUN_AS_NODE = '1'

  console.log(`[main] Spawning server: ${command} ${SERVER_ENTRY}`)

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
// then quits. Used to verify a packaged build headlessly (xvfb).
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
      console.log(`[main] Screenshot written to ${file} (${width}x${height})`)
    } catch (err) {
      console.error('[main] Screenshot failed:', err.message)
    }
    app.quit()
  }, delay)
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
        'Agent Office',
        `The office server did not start on port ${SERVER_PORT}.\n\n` +
        'If something else is using that port, stop it and open Agent Office again.',
      )
      app.quit()
      return
    } else {
      console.error('[main] Server did not become ready in time — continuing anyway (start it with `npm run server`)')
    }
  }

  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width: 520,
    height: 720,
    x: screenW - 400,
    y: 20,
    alwaysOnTop: true,
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

  win.webContents.on('did-finish-load', () => {
    console.log(`[main] Window loaded ${win.webContents.getURL()}`)
    maybeCaptureScreenshot()
  })

  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    console.error(`[main] Window failed to load ${failedUrl}: ${description} (${code})`)
  })

  // Dev: the Vite dev server. Packaged: the office server, which serves the
  // built UI from its root — one port for the page, its assets and the
  // WebSocket, with an http:// origin the server's allowlist accepts.
  const url = app.isPackaged ? `${SERVER_URL}/` : VITE_URL
  console.log(`[main] Loading ${url}`)
  win.loadURL(url)

  // Make window level float above everything (like Clippy)
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true)
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  stopServer()
  app.quit()
})

app.on('before-quit', () => {
  stopServer()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
