'use strict'

/**
 * The tray (menu-bar) icon: a pixel-art desk with the number of working
 * agents beside it, polled from the office server every few seconds, and a
 * menu to show/hide the office, switch the compact widget and always-on-top,
 * open the office in a browser, or quit.
 *
 * Icons come from electron/assets (scripts/generate-icons.mjs): the macOS
 * menu bar gets the monochrome `trayTemplate.png` (+ `@2x`), which macOS
 * tints for light/dark mode; Windows and Linux get the coloured ones.
 */

const { Menu, Tray, nativeImage } = require('electron')
const http = require('http')
const path = require('path')
const { APP_NAME, officeSummary, statusText, trayTitle, trayMenuTemplate } = require('./helpers.cjs')

const ASSETS_DIR = path.join(__dirname, 'assets')

function trayIconFile() {
  if (process.platform === 'darwin') return 'trayTemplate.png'
  if (process.platform === 'win32') return 'tray-16.png'
  return 'tray-32.png'
}

function trayIcon() {
  const image = nativeImage.createFromPath(path.join(ASSETS_DIR, trayIconFile()))
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

/** GET a JSON URL; null on any failure (server down, timeout, bad JSON). */
function fetchJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null)
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}

/**
 * Create the tray.
 *
 *   serverUrl  the office server (http://127.0.0.1:3334)
 *   getState   () => { visible, compact, alwaysOnTop } for the menu
 *   actions    { toggleWindow, setCompact, setAlwaysOnTop, openInBrowser, quit, onSummary? }
 *   pollMs     how often /agents and /sessions are read (default 5 s)
 *
 * Returns { tray, refresh, poll, dispose }. `refresh` rebuilds the menu after
 * the window state changes; `dispose` stops polling and removes the icon.
 */
function createTray({ serverUrl, getState, actions, pollMs = 5000 }) {
  const tray = new Tray(trayIcon())
  tray.setToolTip(APP_NAME)
  let summary = null
  let timer = null

  function refresh() {
    const template = trayMenuTemplate({ ...getState(), status: statusText(summary) }, actions)
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  async function poll() {
    const [agents, sessions] = await Promise.all([
      fetchJson(`${serverUrl}/agents`),
      fetchJson(`${serverUrl}/sessions`),
    ])
    if (tray.isDestroyed()) return
    summary = officeSummary({ agents, sessions })
    tray.setToolTip(`${APP_NAME} — ${statusText(summary)}`)
    if (process.platform === 'darwin') tray.setTitle(trayTitle(summary))
    refresh()
    if (actions.onSummary) actions.onSummary(summary)
  }

  // With a context menu set, a click opens the menu on macOS and Linux;
  // Windows emits 'click' for the left button (the menu is on the right).
  tray.on('click', () => {
    if (process.platform === 'win32') actions.toggleWindow()
  })

  refresh()
  poll()
  timer = setInterval(poll, pollMs)

  return {
    tray,
    refresh,
    poll,
    dispose() {
      if (timer) clearInterval(timer)
      timer = null
      if (!tray.isDestroyed()) tray.destroy()
    },
  }
}

module.exports = { createTray, fetchJson, trayIconFile }
