/**
 * viewerKey.ts - Phone mode's viewer key, as the page gets and keeps it.
 *
 * `npm run lan` prints (and shows as a QR code) a link to the watch-only LAN
 * listener:
 *
 *   http://<lan ip>:3335/#viewer=<64 hex digits>
 *
 * The key is not the office token: it opens only the LAN listener's
 * WebSocket, which carries the office scene stripped of everything that
 * names the user's work (server/index.js redactForLan). The page handles it
 * the way src/officeToken.ts handles `#token=`: on load (main.tsx)
 * captureViewerKey takes it out of the address, keeps it in localStorage
 * under its own key (this origin — the LAN address — only) and strips it from
 * the address bar. A page holding a viewer key is a *viewer page*: it shows
 * the phone layout, calls no API route (the LAN listener answers them all
 * 404) and presents the key as the subprotocol `agent-office.viewer.<key>`.
 * `#viewer=off` forgets it.
 *
 * The office token never travels from a viewer page, nor from any page
 * served over plain HTTP from a non-loopback host (mayCarryOfficeToken): on
 * the Wi-Fi it would be readable by anyone sniffing it.
 */

import {
  WS_PROTOCOL, officeWsProtocols, pageStorages, splitHashParam,
  type HashLocation, type ReplaceHistory, type TokenStorage,
} from './officeToken'

export const VIEWER_KEY_STORAGE = 'agent-office.viewer'
/** The server's viewer key: 32 random bytes as 64 lowercase hex digits (server/lan.js). */
export const VIEWER_KEY_PATTERN = /^[0-9a-f]{64}$/
/** The subprotocol that carries the key (server/lan.js WS_VIEWER_PROTOCOL_PREFIX). */
export const WS_VIEWER_PROTOCOL_PREFIX = 'agent-office.viewer.'
/** `#viewer=off`: leave viewer mode on this origin. */
export const VIEWER_OFF = 'off'

export function isViewerKey(value: unknown): value is string {
  return typeof value === 'string' && VIEWER_KEY_PATTERN.test(value)
}

// The key when no storage would take it
let memoryKey: string | null = null

/** The kept viewer key, or null: this page is a viewer page when it has one. */
export function getViewerKey(storages: TokenStorage[] = pageStorages()): string | null {
  for (const storage of storages) {
    try {
      const value = storage.getItem(VIEWER_KEY_STORAGE)
      if (isViewerKey(value)) return value
    } catch { /* unreadable: try the next */ }
  }
  return memoryKey
}

function setViewerKey(key: string, storages: TokenStorage[]): void {
  memoryKey = key
  for (const storage of storages) {
    try {
      storage.setItem(VIEWER_KEY_STORAGE, key)
      return
    } catch {
      try { storage.removeItem(VIEWER_KEY_STORAGE) } catch { /* nothing to do */ }
    }
  }
}

/** Forget the viewer key everywhere it was kept (the page is a normal office page again). */
export function clearViewerKey(storages: TokenStorage[] = pageStorages()): void {
  memoryKey = null
  for (const storage of storages) {
    try { storage.removeItem(VIEWER_KEY_STORAGE) } catch { /* nothing to do */ }
  }
}

/**
 * Take `#viewer=` out of the address: keep a well-formed key (replacing an
 * older one, e.g. after `npm run lan -- --rotate`), forget the key on
 * `#viewer=off`, and put the address back without it. Returns the key the
 * page now has, or null.
 */
export function captureViewerKey(
  location: HashLocation = window.location,
  history: ReplaceHistory = window.history,
  storages: TokenStorage[] = pageStorages(),
): string | null {
  const { found, value, raw, rest } = splitHashParam(location.hash, 'viewer', isViewerKey)
  if (!found) return getViewerKey(storages)
  if (value) setViewerKey(value, storages)
  else if (raw === VIEWER_OFF) clearViewerKey(storages)
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`)
  } catch { /* an address we may not rewrite: the key is kept either way */ }
  return getViewerKey(storages)
}

/** The subprotocols a viewer page offers: the office's own and the key. Never the office token. */
export function viewerWsProtocols(key: string): string[] {
  return isViewerKey(key) ? [WS_PROTOCOL, `${WS_VIEWER_PROTOCOL_PREFIX}${key}`] : [WS_PROTOCOL]
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Whether this page may keep and present the office token: it was served
 * over HTTPS (a `tailscale serve` page), or from loopback. A plain-HTTP page
 * from any other host (the LAN listener) would put the token on the network.
 */
export function mayCarryOfficeToken(loc: { protocol: string; hostname: string }): boolean {
  return loc.protocol === 'https:' || LOOPBACK_NAMES.has(loc.hostname)
}

/**
 * The subprotocols this page's WebSocket offers: the viewer key on a viewer
 * page, the office token where it may travel, else just the office's own.
 */
export function pageWsProtocols(opts: { viewerKey: string | null; safe: boolean; token?: string | null }): string[] {
  if (opts.viewerKey) return viewerWsProtocols(opts.viewerKey)
  if (!opts.safe) return [WS_PROTOCOL]
  return opts.token === undefined ? officeWsProtocols() : officeWsProtocols(opts.token)
}

/** Tests: forget the in-memory copy. */
export function resetViewerKeyMemory(): void {
  memoryKey = null
}
