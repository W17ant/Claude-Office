/**
 * lan.js - Phone mode: the opt-in LAN viewer listener's pure helpers, and the
 * Tailscale host allowlist for the loopback listener.
 *
 * Two opt-in exceptions to "loopback only" (docs/reference.md › Security):
 *
 *   AGENT_OFFICE_LAN=1          a SECOND listener on this machine's private
 *                               LAN IPv4 (never 0.0.0.0), port
 *                               AGENT_OFFICE_LAN_PORT (3335). It serves the
 *                               built UI's static files and a watch-only
 *                               WebSocket that needs the viewer key; every
 *                               API route is a 404 there, the office token is
 *                               never accepted, and the stream is stripped to
 *                               the scene (redactForLan in server/index.js).
 *   AGENT_OFFICE_ALLOWED_HOSTS  extra host names (a `tailscale serve` name)
 *                               the loopback listener's Host guard and origin
 *                               allowlist accept, with https origins. Trust
 *                               still needs the office token.
 *
 * Everything here is pure (env, interfaces and headers come in as arguments)
 * so the tests need no network; server/index.js owns the sockets.
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
 * `1` / `true`. The host is AGENT_OFFICE_LAN_HOST when set (it must itself be
 * an RFC 1918 IPv4 literal — a public address, 0.0.0.0 or a name is refused
 * and LAN mode stays off), else the first private address of this machine.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ interfaces?: object, log?: { warn?: Function } }} [opts]
 * @returns {{ enabled: false, reason?: string } | { enabled: true, host: string, port: number }}
 */
export function readLanConfig(env = process.env, { interfaces, log = console } = {}) {
  const flag = String(env?.AGENT_OFFICE_LAN ?? '').trim().toLowerCase()
  if (flag !== '1' && flag !== 'true') return { enabled: false }
  const off = reason => {
    log?.warn?.(`[lan] ${reason}; LAN mode is off, the office stays loopback-only`)
    return { enabled: false, reason }
  }

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
    return { enabled: true, host, port }
  }
  const host = pickLanAddress(interfaces)
  if (!host) return off('no private (RFC 1918) IPv4 address on this machine')
  return { enabled: true, host, port }
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
