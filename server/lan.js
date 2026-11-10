/**
 * lan.js - Phone mode: the opt-in LAN listener's pure helpers (watch-only and
 * full), and the Tailscale host allowlist for the loopback listener.
 *
 * Three opt-in exceptions to "loopback only" (docs/reference.md › Security):
 *
 *   AGENT_OFFICE_LAN=1          a SECOND listener on this machine's private
 *                               LAN IPv4 (never 0.0.0.0), port
 *                               AGENT_OFFICE_LAN_PORT (3335). It serves the
 *                               built UI's static files and a watch-only
 *                               WebSocket that needs the viewer key; every
 *                               API route is a 404 there, the office token is
 *                               never accepted, and the stream is stripped to
 *                               the scene (redactForLan in server/index.js).
 *   AGENT_OFFICE_LAN=full       the same address and port, but the listener
 *                               speaks HTTPS only (a certificate made on this
 *                               machine, server/lan-cert.js) and serves the
 *                               full office to a phone holding the phone
 *                               secret: the trusted WebSocket stream and the
 *                               routes in LAN_FULL_ROUTES below, nothing
 *                               else. See "Full mode" further down.
 *   AGENT_OFFICE_ALLOWED_HOSTS  extra host names (a `tailscale serve` name)
 *                               the loopback listener's Host guard and origin
 *                               allowlist accept, with https origins. Trust
 *                               still needs the office token.
 *
 * Everything here is pure (env, interfaces, headers and the clock come in as
 * arguments) so the tests need no network; server/index.js owns the sockets.
 */

import { networkInterfaces } from 'os'
import { timingSafeEqual } from 'crypto'
import { createRequire } from 'module'

/** 3335: the office's own port plus one, easy to remember next to 3334. */
export const DEFAULT_LAN_PORT = 3335

/** The subprotocol that carries the viewer key (src/viewerKey.ts builds the same). */
export const WS_VIEWER_PROTOCOL_PREFIX = 'agent-office.viewer.'

/** The viewer key: 32 random bytes as 64 lowercase hex digits, like the office token. */
export const VIEWER_KEY_PATTERN = /^[0-9a-f]{64}$/

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** The four octets of a dotted-quad IPv4 literal, or null. */
function octets(addr) {
  const m = IPV4.exec(typeof addr === 'string' ? addr : '')
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every(n => n <= 255) ? parts : null
}

/**
 * True for an RFC 1918 private IPv4 address: 10/8, 172.16/12, 192.168/16.
 * Loopback, link-local, CGNAT (100.64/10, Tailscale's range), 0.0.0.0 and
 * public addresses are all false: the LAN listener is for the home Wi-Fi only.
 * @param {string} addr
 * @returns {boolean}
 */
export function isPrivateIPv4(addr) {
  const o = octets(addr)
  if (!o) return false
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168)
}

/**
 * The first non-internal RFC 1918 IPv4 address among the interfaces, or null.
 * @param {ReturnType<typeof networkInterfaces>} [interfaces] os.networkInterfaces() or a fake
 * @returns {string | null}
 */
export function pickLanAddress(interfaces = networkInterfaces()) {
  for (const list of Object.values(interfaces ?? {})) {
    for (const entry of list ?? []) {
      // Node 18.0-18.3 reported family as the number 4
      const v4 = entry?.family === 'IPv4' || entry?.family === 4
      if (v4 && !entry.internal && isPrivateIPv4(entry.address)) return entry.address
    }
  }
  return null
}

/** A TCP port from an env string, or null. */
function parsePort(raw) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw.trim())) return null
  const port = Number(raw.trim())
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * LAN mode as the environment asks for it. Off unless AGENT_OFFICE_LAN is
 * `1` / `true` (watch-only, plain HTTP) or `full` (the full office over
 * HTTPS). The host is AGENT_OFFICE_LAN_HOST when set (it must itself be
 * an RFC 1918 IPv4 literal — a public address, 0.0.0.0 or a name is refused
 * and LAN mode stays off), else the first private address of this machine.
 *
 * Why one variable with a third value rather than a second flag: the two
 * modes share one port and exclude each other, and a lone "full" flag next
 * to AGENT_OFFICE_LAN=0 would have to mean something. Any other value is
 * off, as before, so a typo of `full` can only ever give less than was
 * asked for.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ interfaces?: object, log?: { warn?: Function } }} [opts]
 * @returns {{ enabled: false, reason?: string } | { enabled: true, host: string, port: number, full?: true }}
 *   `full: true` is present only in full mode
 */
export function readLanConfig(env = process.env, { interfaces, log = console } = {}) {
  const flag = String(env?.AGENT_OFFICE_LAN ?? '').trim().toLowerCase()
  const full = flag === 'full'
  if (flag !== '1' && flag !== 'true' && !full) return { enabled: false }
  const off = reason => {
    log?.warn?.(`[lan] ${reason}; LAN mode is off, the office stays loopback-only`)
    return { enabled: false, reason }
  }
  // Why the key only in full mode: watch-only keeps the exact shape it had
  const on = (host, port) => (full ? { enabled: true, host, port, full: true } : { enabled: true, host, port })

  let port = DEFAULT_LAN_PORT
  const rawPort = env?.AGENT_OFFICE_LAN_PORT
  if (rawPort !== undefined && rawPort !== '') {
    port = parsePort(rawPort)
    if (port === null) return off(`AGENT_OFFICE_LAN_PORT=${JSON.stringify(rawPort)} is not a port (1-65535)`)
  }

  const override = env?.AGENT_OFFICE_LAN_HOST
  if (override !== undefined && override !== '') {
    const host = override.trim()
    // Why: an explicit address is still held to the same rule as a picked one,
    // so a typo can never put the office on a public interface or on every one
    if (!isPrivateIPv4(host)) return off(`AGENT_OFFICE_LAN_HOST=${JSON.stringify(override)} is not a private (RFC 1918) IPv4 address`)
    return on(host, port)
  }
  const host = pickLanAddress(interfaces)
  if (!host) return off('no private (RFC 1918) IPv4 address on this machine')
  return on(host, port)
}

/**
 * The Host header the LAN listener accepts: exactly `<lan ip>:<lan port>`
 * (just `<lan ip>` when the port is 80, which browsers leave out). Anything
 * else — another name (a DNS-rebinding page), the IP on another port, a
 * missing header — is refused.
 * @param {string | undefined} hostHeader
 * @param {string} host the LAN IP
 * @param {number} port the LAN port actually bound
 * @returns {boolean}
 */
export function lanHostOk(hostHeader, host, port) {
  if (typeof hostHeader !== 'string') return false
  return hostHeader === `${host}:${port}` || (port === 80 && hostHeader === host)
}

/**
 * The Origin the LAN listener accepts when one is sent: the page it served
 * itself, `http://<lan ip>:<lan port>`. No Origin (a same-origin GET) is fine;
 * `null`, https, other hosts or ports are not.
 * @param {string | undefined} origin
 * @param {string} host
 * @param {number} port
 * @returns {boolean}
 */
export function lanOriginOk(origin, host, port) {
  if (origin === undefined || origin === '') return true
  return origin === `http://${host}:${port}` || (port === 80 && origin === `http://${host}`)
}

/**
 * The viewer key a LAN WebSocket handshake offered as a subprotocol
 * (`agent-office.viewer.<key>`), or ''. Mirrors wsTokenFrom in server/index.js.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {string}
 */
export function viewerKeyFrom(req) {
  const header = req?.headers?.['sec-websocket-protocol']
  if (typeof header !== 'string') return ''
  for (const part of header.split(',')) {
    const value = part.trim()
    if (value.startsWith(WS_VIEWER_PROTOCOL_PREFIX)) return value.slice(WS_VIEWER_PROTOCOL_PREFIX.length)
  }
  return ''
}

/**
 * Constant-time comparison of a supplied viewer key with the real one.
 * @param {unknown} supplied
 * @param {string} key
 * @returns {boolean}
 */
export function viewerKeyMatches(supplied, key) {
  if (typeof supplied !== 'string' || supplied.length === 0 || typeof key !== 'string' || !key) return false
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(key, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The phone link: the page on the LAN listener with the viewer key in its
 * fragment (never sent to a server; the page keeps it and strips it).
 * @param {string} host
 * @param {number} port
 * @param {string} key
 * @returns {string}
 */
export function viewerLink(host, port, key) {
  return `http://${host}:${port}/#viewer=${key}`
}

// ---------------------------------------------------------------------------
// Full mode (AGENT_OFFICE_LAN=full) — the whole office on the phone, HTTPS only
//
// The flow, end to end (server/index.js owns the sockets and runs it):
//
//   1. start     the listener is an https.Server on <lan ip>:<lan port> with a
//                certificate made here (server/lan-cert.js). There is no
//                plain-HTTP listener in this mode at all: a plain request to
//                the port fails the TLS handshake and is dropped.
//   2. the link  https://<lan ip>:<port>/#phone=<phone secret>, printed with
//                its QR code and the certificate's SHA-256 fingerprint. The
//                secret rides in the fragment, which no browser sends to a
//                server; the page takes it out of the address bar and keeps
//                it in that browser's storage (src/phoneSecret.ts).
//   3. the gate  every request and every WebSocket handshake passes, in this
//                order: exact Host (421) -> exact https Origin when one is
//                sent (403) -> static UI files for GET / HEAD (no secret:
//                the page has to load before it can read its fragment) ->
//                lockout (429) -> the phone secret, constant time (401) ->
//                LAN_FULL_ROUTES (404). Only then does the loopback app see
//                the request, acting with the page's UI tier — never with
//                the office token's.
//   4. the wire  the phone secret is a third secret, never the office token
//                or the viewer key; both of those are refused here like any
//                other wrong value, and count towards the lockout.
//
// What the gate does not do is make the first visit safe against someone
// already in the middle: the certificate is self-signed, so the phone trusts
// it on first use. That is what the printed fingerprint is for.
// ---------------------------------------------------------------------------

/** The subprotocol that carries the phone secret (src/phoneSecret.ts builds the same). */
export const WS_PHONE_PROTOCOL_PREFIX = 'agent-office.phone.'

/** The phone secret: 32 random bytes as 64 lowercase hex digits, like the office token. */
export const PHONE_SECRET_PATTERN = /^[0-9a-f]{64}$/

/**
 * The Host header the full-mode listener accepts: exactly `<lan ip>:<lan port>`
 * (just `<lan ip>` on 443, which browsers leave out of an https Host).
 * @param {string | undefined} hostHeader
 * @param {string} host the LAN IP
 * @param {number} port the LAN port actually bound
 * @returns {boolean}
 */
export function lanFullHostOk(hostHeader, host, port) {
  if (typeof hostHeader !== 'string') return false
  return hostHeader === `${host}:${port}` || (port === 443 && hostHeader === host)
}

/**
 * The Origin the full-mode listener accepts when one is sent: the page it
 * served itself, `https://<lan ip>:<lan port>`. Plain http is never accepted
 * here (and https never by lanOriginOk): the two modes share nothing.
 * @param {string | undefined} origin
 * @param {string} host
 * @param {number} port
 * @returns {boolean}
 */
export function lanFullOriginOk(origin, host, port) {
  if (origin === undefined || origin === '') return true
  return origin === `https://${host}:${port}` || (port === 443 && origin === `https://${host}`)
}

/**
 * The phone secret a WebSocket handshake offered as a subprotocol
 * (`agent-office.phone.<secret>`), or ''. A browser cannot set headers on a
 * WebSocket, so this is the one place it can put a secret that is not a URL.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {string}
 */
export function phoneSecretFrom(req) {
  const header = req?.headers?.['sec-websocket-protocol']
  if (typeof header !== 'string') return ''
  for (const part of header.split(',')) {
    const value = part.trim()
    if (value.startsWith(WS_PHONE_PROTOCOL_PREFIX)) return value.slice(WS_PHONE_PROTOCOL_PREFIX.length)
  }
  return ''
}

/**
 * True when a WebSocket handshake offered any credential at all — the phone
 * secret, the office token or the viewer key. A handshake that offered one
 * and is refused counts as a failed attempt; one that offered nothing (a
 * page opened without its link) does not.
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {boolean}
 */
export function offersWsCredential(req) {
  const header = req?.headers?.['sec-websocket-protocol']
  if (typeof header !== 'string') return false
  // Why a shape test: every credential subprotocol is `agent-office.<kind>.<value>`
  return header.split(',').some(part => /^agent-office\.[a-z]+\../.test(part.trim()))
}

/**
 * Constant-time comparison of a supplied phone secret with the real one.
 * @param {unknown} supplied
 * @param {string} secret
 * @returns {boolean}
 */
export function phoneSecretMatches(supplied, secret) {
  return viewerKeyMatches(supplied, secret)
}

/**
 * The full-mode phone link: the https page on the LAN listener with the
 * phone secret in its fragment (never a query string: a fragment is not sent
 * to the server, logged by it, or put in a Referer).
 * @param {string} host
 * @param {number} port
 * @param {string} secret
 * @returns {string}
 */
export function phoneLink(host, port, secret) {
  return `https://${host}:${port}/#phone=${secret}`
}

// One path segment that names a record (an agent id, a permission id). Why
// 200: the longest id the office mints is `main:<session uuid>` (41
// characters); 200 leaves room and still bounds what reaches the router.
const ID = '[^/]{1,200}'

/**
 * What the phone may call in full mode: an ALLOWLIST of exactly the requests
 * the office page itself makes (every fetch under src/; tests/lan-full.test.ts
 * holds the two lists against each other), each matched on method and exact,
 * case-sensitive path. A route added to the loopback app later stays off the
 * LAN until someone lists it here and says why.
 *
 *   route                    why the phone needs it              on loopback
 *   -----------------------  ----------------------------------  -----------
 *   GET  /config             the boss's name and sprite, read    open
 *                            once before the first render
 *   GET  /roster             the MCP servers at the wall rack,   open
 *                            read when the socket opens
 *   GET  /recap              the "today" popover's counts        open
 *                            (numbers only, no text)
 *   GET  /settings           the settings panel's three server   open
 *                            switches as they are now
 *   POST /settings           change them (prompt logging,        UI token
 *                            answer-from-office, notifications)
 *   GET  /chat/cron-state    is the chat monitor paused          open
 *   POST /chat/cron-state    the chat header's pause button      open
 *   POST /chat               a chat line typed on the phone;     open
 *                            `/clear` stays refused: it needs
 *                            the office token, which the phone
 *                            never has
 *   GET  /agents/:id         the inspector card, with the        text needs
 *                            transcript tail the desktop page    the UI token
 *                            sees
 *   POST /permission/:id     answer a permission card            UI token
 *
 * Deliberately NOT here, and so a 404 on the LAN even with the secret:
 *
 *   POST /event, POST /status, GET /permission/:id (the hook's long-poll)
 *       hook ingestion: only the local hook and status line call these, and
 *       they are what would let a caller invent agents, sessions or decisions
 *   POST /chat/reply, /chat/inbox/read, /chat/seen, /chat/react,
 *   /chat/video-mode, /chat/typing, POST /a2a, GET /a2a/agents,
 *   GET /.well-known/agent-card.json
 *       acting as an agent, and agent-to-agent traffic
 *   GET /chat, /agents, /sessions, /signals, /tasks, /registry, /permissions,
 *   /health, GET /status
 *       reads the page never makes: the WebSocket already carries what it draws
 *   OPTIONS, HEAD on a route, every other method
 *       the page is same-origin, so nothing preflights
 *
 * Token rotation has no route at all (npm run rotate-token, a local script).
 */
export const LAN_FULL_ROUTES = Object.freeze([
  ['GET', /^\/config$/],
  ['GET', /^\/roster$/],
  ['GET', /^\/recap$/],
  ['GET', /^\/settings$/],
  ['POST', /^\/settings$/],
  ['GET', /^\/chat\/cron-state$/],
  ['POST', /^\/chat\/cron-state$/],
  ['POST', /^\/chat$/],
  ['GET', new RegExp(`^/agents/${ID}$`)],
  ['POST', new RegExp(`^/permission/${ID}$`)],
])

/**
 * True when `method path` is on the full-mode allowlist.
 * @param {string} method the request method as Node reports it (upper case)
 * @param {string} path the URL's path, undecoded, without the query string
 * @returns {boolean}
 */
export function lanFullRouteAllowed(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return false
  return LAN_FULL_ROUTES.some(([m, pattern]) => m === method && pattern.test(path))
}

// Lockout defaults. The secret is 256 random bits, so no rate could let it be
// guessed; what the lockout bounds is the work and the log lines a device
// hammering the port costs, and it makes a scripted attempt visible.
//
// Why 20 in a minute: a phone still holding the old secret after `--rotate`
// retries its WebSocket on a backoff that reaches one try every 30 s — about
// 7 tries in its first minute, plus the page's own start-up fetches, then 2
// a minute. 20 keeps that phone (and a second tab on it) clear of the lock,
// so scanning the new code works at once.
const LOCKOUT_MAX_FAILURES = 20
const LOCKOUT_WINDOW_MS = 60_000
// Why a minute, fixed: long enough to make a loop pointless, short enough
// that a wrongly locked phone (see below) is back without anyone restarting
const LOCKOUT_LOCK_MS = 60_000
// Why 256: a home network has a handful of devices; this only bounds memory
// if something walks through source addresses
const LOCKOUT_MAX_ENTRIES = 256

/**
 * A per-address lockout for wrong secrets. `fail(ip)` records a wrong secret;
 * the LOCKOUT_MAX_FAILURES-th within LOCKOUT_WINDOW_MS locks that address
 * for LOCKOUT_LOCK_MS, during which the gate answers 429 without looking at
 * what was offered (so a locked address learns nothing, a right guess
 * included). The lock is fixed-length: attempts made while locked neither
 * extend it nor count. `ok(ip)` forgets an address after a good secret.
 *
 * Known limit: it keys on the peer address, and on a LAN an attacker can
 * borrow the phone's address. That can lock the phone out for a minute at a
 * time (a nuisance, not an entry), never let anyone in.
 * @param {{ maxFailures?: number, windowMs?: number, lockMs?: number, maxEntries?: number, now?: () => number }} [opts]
 * @returns {{ blockedFor: (ip: string) => number, fail: (ip: string) => boolean, ok: (ip: string) => void, size: () => number }}
 *   blockedFor: milliseconds the address is still locked (0 when it is not);
 *   fail: true when this failure started a lock
 */
export function createLockout({
  maxFailures = LOCKOUT_MAX_FAILURES, windowMs = LOCKOUT_WINDOW_MS, lockMs = LOCKOUT_LOCK_MS,
  maxEntries = LOCKOUT_MAX_ENTRIES, now = Date.now,
} = {}) {
  /** @type {Map<string, { failures: number[], lockedUntil: number }>} insertion order = age */
  const table = new Map()

  /** Drop entries with no live lock and no failure inside the window. */
  const sweep = t => {
    for (const [ip, entry] of table) {
      if (entry.lockedUntil <= t && !entry.failures.some(at => t - at < windowMs)) table.delete(ip)
    }
  }

  return {
    blockedFor(ip) {
      const entry = table.get(ip)
      return entry ? Math.max(0, entry.lockedUntil - now()) : 0
    },
    fail(ip) {
      const t = now()
      let entry = table.get(ip)
      if (entry && entry.lockedUntil > t) return false
      if (!entry) {
        if (table.size >= maxEntries) sweep(t)
        // Still full: every entry is live. Let the oldest go rather than grow
        if (table.size >= maxEntries) table.delete(table.keys().next().value)
        entry = { failures: [], lockedUntil: 0 }
        table.set(ip, entry)
      }
      entry.failures = entry.failures.filter(at => t - at < windowMs)
      entry.failures.push(t)
      if (entry.failures.length < maxFailures) return false
      entry.failures = []
      entry.lockedUntil = t + lockMs
      return true
    },
    ok(ip) {
      table.delete(ip)
    },
    size: () => table.size,
  }
}

// ---------------------------------------------------------------------------
// AGENT_OFFICE_ALLOWED_HOSTS — names a proxy such as `tailscale serve` uses
// ---------------------------------------------------------------------------

// One DNS label: letters, digits and inner hyphens, 1-63 characters
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * One AGENT_OFFICE_ALLOWED_HOSTS entry, `name` or `name:port`, checked
 * strictly: hostname characters only (no wildcard, scheme, path, user info
 * or brackets), at least one dot (an https certificate names an FQDN), not an
 * IPv4 literal, a port 1-65535 when given. Returns null for anything else.
 * @param {string} raw
 * @returns {{ host: string, port: number | null } | null}
 */
export function parseAllowedHost(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!text || text.length > 260) return null
  let host = text
  let port = null
  const colon = text.lastIndexOf(':')
  if (colon !== -1) {
    host = text.slice(0, colon)
    port = parsePort(text.slice(colon + 1))
    if (port === null) return null
  }
  if (host.length > 253 || !host.includes('.')) return null
  if (octets(host) || /^[\d.]+$/.test(host)) return null
  if (!host.split('.').every(label => LABEL.test(label))) return null
  return { host, port }
}

/**
 * AGENT_OFFICE_ALLOWED_HOSTS as a list of { host, port } entries. Bad entries
 * are logged and ignored; an unset variable is the empty list.
 * @param {string | undefined} raw comma-separated
 * @param {{ warn?: Function }} [log]
 * @returns {Array<{ host: string, port: number | null }>}
 */
export function parseAllowedHosts(raw, log = console) {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const out = []
  for (const part of raw.split(',')) {
    if (part.trim() === '') continue
    const entry = parseAllowedHost(part)
    if (entry) out.push(entry)
    else log?.warn?.(`[config] AGENT_OFFICE_ALLOWED_HOSTS entry ${JSON.stringify(part.trim())} ignored: give a host name such as my-mac.tail1234.ts.net (optionally :port) — no scheme, path, wildcard or IP address`)
  }
  return out
}

/**
 * True when a Host header names one of the allowed hosts: `name` (or
 * `name:443`) for an entry without a port, exactly `name:port` for one with.
 * @param {string | undefined} hostHeader
 * @param {Array<{ host: string, port: number | null }>} allowed
 * @returns {boolean}
 */
export function allowedHostMatches(hostHeader, allowed) {
  if (typeof hostHeader !== 'string' || !allowed.length) return false
  const text = hostHeader.toLowerCase()
  return allowed.some(({ host, port }) => (port === null ? text === host || text === `${host}:443` : text === `${host}:${port}`))
}

/**
 * True when an Origin is the https page of an allowed host:
 * `https://name` for an entry without a port, `https://name:port` with one.
 * @param {string} origin
 * @param {Array<{ host: string, port: number | null }>} allowed
 * @returns {boolean}
 */
export function allowedOriginMatches(origin, allowed) {
  if (typeof origin !== 'string' || !allowed.length) return false
  const text = origin.toLowerCase()
  return allowed.some(({ host, port }) => text === (port === null ? `https://${host}` : `https://${host}:${port}`))
}

// ---------------------------------------------------------------------------
// A QR code for the terminal
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

// Why: 4 modules of light border is the quiet zone the QR spec asks for;
// phone scanners miss codes that touch a dark terminal background
const QUIET_ZONE = 4

/**
 * `text` as a QR code drawn with half blocks: two module rows per line, with
 * explicit ANSI foreground/background colours so it scans on dark and light
 * terminal themes alike. Uses the encoder vendored in qrcode-terminal
 * (error correction L — the code is read off a screen, not a crumpled
 * label). Returns null when the encoder is not installed.
 * @param {string} text
 * @returns {string | null}
 */
export function renderQr(text) {
  let QRCode, Level
  try {
    QRCode = require('qrcode-terminal/vendor/QRCode')
    Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')
  } catch {
    return null
  }
  const qr = new QRCode(-1, Level.L)
  qr.addData(text)
  qr.make()
  const size = qr.getModuleCount()
  const full = size + QUIET_ZONE * 2
  const dark = (r, c) => {
    const row = r - QUIET_ZONE
    const col = c - QUIET_ZONE
    return row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col)
  }
  // 30/40 black, 97/107 bright white: fg paints the upper half, bg the lower
  const lines = []
  for (let r = 0; r < full; r += 2) {
    let line = ''
    for (let c = 0; c < full; c++) {
      const top = dark(r, c)
      const bottom = r + 1 < full ? dark(r + 1, c) : false
      line += `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m▀`
    }
    lines.push(`${line}\x1b[0m`)
  }
  return lines.join('\n')
}

/**
 * The module matrix renderQr draws (true = dark), without the quiet zone,
 * for the tests to decode. Null when the encoder is not installed.
 * @param {string} text
 * @returns {boolean[][] | null}
 */
export function qrModules(text) {
  try {
    const QRCode = require('qrcode-terminal/vendor/QRCode')
    const Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')
    const qr = new QRCode(-1, Level.L)
    qr.addData(text)
    qr.make()
    const size = qr.getModuleCount()
    return Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => qr.isDark(r, c)))
  } catch {
    return null
  }
}
