'use strict'

const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

// Allowed origins for navigation and new-window events
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3333',
  'http://localhost:3334',
])

const SERVER_PORT = 3334
const SERVER_HOST = '127.0.0.1'
const HEALTH_URL = `http://${SERVER_HOST}:${SERVER_PORT}/health`

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
 * In packaged builds the server files are placed in process.resourcesPath/server.
 * In dev the files are at <project-root>/server/index.js.
 */
function startServer() {
  const isDev = !app.isPackaged

  const serverEntry = isDev
    ? path.join(__dirname, '../server/index.js')
    : path.join(process.resourcesPath, 'server', 'index.js')

  console.log('[main] Spawning server:', serverEntry)

  serverProcess = spawn('node', [serverEntry], {
    stdio: 'pipe',
    env: { ...process.env },
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
// Window creation
// ---------------------------------------------------------------------------

async function createWindow() {
  // Check if a server is already running (e.g. launched separately during dev)
  const alreadyRunning = await isServerRunning()

  if (alreadyRunning) {
    console.log('[main] Server already running on port 3334 — skipping spawn')
  } else {
    startServer()
    const ready = await waitForServer()
    if (!ready) {
      console.error('[main] Server did not become ready in time — continuing anyway')
    } else {
      console.log('[main] Server is ready')
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

  // In dev, load from Vite server; in production, load the built index.html
  const isDev = !app.isPackaged
  if (isDev) {
    win.loadURL('http://localhost:3333')
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

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
