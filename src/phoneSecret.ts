/**
 * phoneSecret.ts - Phone full mode's secret, as the page gets and keeps it.
 *
 * `npm run lan -- --full` prints (and shows as a QR code) a link to the
 * full-mode LAN listener, which speaks HTTPS only:
 *
 *   https://<lan ip>:3335/#phone=<64 hex digits>
 *
 * The secret is neither the office token nor the viewer key. It opens the
 * full-mode listener and nothing else: the trusted WebSocket stream and the
 * short list of API routes the full office needs (server/lan.js
 * LAN_FULL_ROUTES), at the page's own tier — it can answer a permission card
 * and post in the chat, it cannot `/clear` or rotate anything.
 *
 * The page handles it the way src/officeToken.ts handles `#token=`:
 *
 *   capture   on load (src/pageAuth.ts, before anything else runs)
 *             capturePhoneSecret takes it out of the address, keeps it in
 *             localStorage under its own key (this origin — the https LAN
 *             address — only) and puts the address back without it. A
 *             fragment is never sent to a server, so the secret is in no
 *             request line and no log.
 *   present   as `Authorization: Bearer <secret>` on the page's fetches
 *             (src/officeAuth.ts, src/permissions.ts) and as the WebSocket
 *             subprotocol `agent-office.phone.<secret>` (browsers cannot set
 *             headers on a WebSocket; a protocol value never becomes part of
 *             a URL). Read from storage each time, so a new link opened in
 *             another tab after `--rotate` fixes this one at its next try.
 *   forget    `#phone=off`
 *
 * Where it may live: ONLY on a page served over https from a private (RFC
 * 1918) IPv4 literal — isPhoneFullLocation. That shape can only be the
 * full-mode listener's page: the loopback office is http on 127.0.0.1, the
 * watch-only listener is plain http, and a `tailscale serve` page has a
 * name (the server's AGENT_OFFICE_ALLOWED_HOSTS refuses IP literals). On any
 * other page `#phone=` is stripped from the address and thrown away, so the
 * secret can never be presented over plain HTTP, whatever link is opened.
 *
 * Like its two siblings, the helpers take the location, history and storages
 * as arguments so tests pass fakes; nothing runs at import time.
 */

import {
  WS_PROTOCOL, pageStorages, splitHashParam,
  type HashLocation, type ReplaceHistory, type TokenStorage,
} from './officeToken'

export const PHONE_SECRET_STORAGE = 'agent-office.phone'
/** The server's phone secret: 32 random bytes as 64 lowercase hex digits (server/lan.js). */
export const PHONE_SECRET_PATTERN = /^[0-9a-f]{64}$/
/** The subprotocol that carries the secret (server/lan.js WS_PHONE_PROTOCOL_PREFIX). */
export const WS_PHONE_PROTOCOL_PREFIX = 'agent-office.phone.'
/** `#phone=off`: forget the secret on this origin. */
export const PHONE_OFF = 'off'

/** The parts of window.location that say what kind of page this is. */
export interface PageKind {
  protocol: string
  hostname: string
}

export function isPhoneSecret(value: unknown): value is string {
  return typeof value === 'string' && PHONE_SECRET_PATTERN.test(value)
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * True for an RFC 1918 private IPv4 literal: 10/8, 172.16/12, 192.168/16 —
 * the same rule as the server's isPrivateIPv4 (server/lan.js), which is what
 * the full-mode listener may bind. Loopback, link-local, CGNAT (Tailscale's
 * range), public addresses and every name are false.
 * @param hostname location.hostname
 * @returns whether it is a private IPv4 literal
 */
export function isPrivateIPv4Host(hostname: string): boolean {
  const m = IPV4.exec(typeof hostname === 'string' ? hostname : '')
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (!o.every(n => n <= 255)) return false
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
}

/**
 * Whether a page at this location is the full-mode LAN listener's: https AND
 * a private IPv4 literal. The one place a phone secret may be kept and
 * presented.
 * @param loc the page location (tests pass a fake)
 * @returns true only for https://<RFC 1918 address>
 */
export function isPhoneFullLocation(loc: PageKind): boolean {
  return loc.protocol === 'https:' && isPrivateIPv4Host(loc.hostname)
}

/** isPhoneFullLocation for the page itself; false where there is no window (Node, the tests). */
export function onPhoneFullPage(): boolean {
  return typeof window !== 'undefined' && !!window.location && isPhoneFullLocation(window.location)
}

// The secret when no storage would take it (a private window)
let memorySecret: string | null = null

/**
 * The kept phone secret, or null. Storage is read every time, so a secret
 * another tab captured (a new link after `--rotate`) is used at this tab's
 * next request.
 * @param storages where to look (tests pass fakes)
 * @returns the secret or null
 */
export function getPhoneSecret(storages: TokenStorage[] = pageStorages()): string | null {
  for (const storage of storages) {
    try {
      const value = storage.getItem(PHONE_SECRET_STORAGE)
      if (isPhoneSecret(value)) return value
    } catch { /* unreadable: try the next */ }
  }
  return memorySecret
}

function setPhoneSecret(secret: string, storages: TokenStorage[]): void {
  memorySecret = secret
  for (const storage of storages) {
    try {
      storage.setItem(PHONE_SECRET_STORAGE, secret)
      return
    } catch {
      // Why remove: a storage that refuses the new secret must not keep
      // shadowing it with an older one
      try { storage.removeItem(PHONE_SECRET_STORAGE) } catch { /* nothing to do */ }
    }
  }
}

/** Forget the phone secret everywhere it was kept. */
export function clearPhoneSecret(storages: TokenStorage[] = pageStorages()): void {
  memorySecret = null
  for (const storage of storages) {
    try { storage.removeItem(PHONE_SECRET_STORAGE) } catch { /* nothing to do */ }
  }
}

/**
 * Take `#phone=` out of the address. On a phone-full location: keep a
 * well-formed secret (replacing an older one, e.g. after `--rotate`), forget
 * it on `#phone=off`. On ANY other location: strip it and keep nothing — a
 * phone link opened over plain HTTP, or pasted into the desktop office, must
 * leave no secret behind and nothing to present.
 * @param location the page location (hash, path and what kind of page it is)
 * @param history where the address is rewritten
 * @param storages where the secret is kept
 * @returns the secret the page now holds, or null (always null off a phone-full location)
 */
export function capturePhoneSecret(
  location: HashLocation & PageKind = window.location,
  history: ReplaceHistory = window.history,
  storages: TokenStorage[] = pageStorages(),
): string | null {
  const mayKeep = isPhoneFullLocation(location)
  const { found, value, raw, rest } = splitHashParam(location.hash, 'phone', isPhoneSecret)
  if (found) {
    if (mayKeep && value) setPhoneSecret(value, storages)
    else if (mayKeep && raw === PHONE_OFF) clearPhoneSecret(storages)
    try {
      history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`)
    } catch { /* an address we may not rewrite: the secret is kept either way */ }
  }
  return mayKeep ? getPhoneSecret(storages) : null
}

/**
 * The subprotocols a phone-full page offers: the office's own and the
 * secret. Never the office token, never the viewer key.
 * @param secret the kept secret, or null
 * @returns the list for `new WebSocket(url, protocols)`
 */
export function phoneWsProtocols(secret: string | null): string[] {
  return isPhoneSecret(secret) ? [WS_PROTOCOL, `${WS_PHONE_PROTOCOL_PREFIX}${secret}`] : [WS_PROTOCOL]
}

/** Tests: forget the in-memory copy. */
export function resetPhoneSecretMemory(): void {
  memorySecret = null
}
