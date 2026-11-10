/**
 * officeAuth.ts - The Authorization header for the page's own fetches when it is served through an HTTPS proxy name.
 *
 * On loopback the office's read routes are open to the page (and to any
 * local process) by design, and the page sends no header: nothing changes
 * there. Served through `tailscale serve` (https://<name>, a name in the
 * server's AGENT_OFFICE_ALLOWED_HOSTS) every route but the static files
 * needs a bearer token, because "any local process" would otherwise mean
 * "any device on the tailnet". So a proxied page sends one:
 *
 *   the UI token     once the WebSocket snapshot handed it over — for every
 *                    request, the token the page is meant to act with
 *   the office token before that, on reads only (GET /config at start-up):
 *                    a POST never carries the file token, so a `/clear`
 *                    typed in the chat stays refused here as on loopback
 *
 * A phone-full page (https on the private Wi-Fi address, the full-mode LAN
 * listener: src/phoneSecret.ts) is a third case: it sends the phone secret
 * on every request, GET or POST, and never either of the two tokens above —
 * that listener refuses them, and the office token has no business on the
 * Wi-Fi at all.
 */

import { getOfficeToken } from './officeToken'
import { getUiToken } from './permissions'
import { getPhoneSecret, isPhoneFullLocation } from './phoneSecret'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** True when the page came through an HTTPS proxy name rather than loopback (or the LAN listener's plain HTTP). */
export function isProxiedPage(loc: { protocol: string; hostname: string }): boolean {
  return loc.protocol === 'https:' && !LOOPBACK_NAMES.has(loc.hostname)
}

/**
 * Headers to spread into a fetch to the office server: `{}` on loopback,
 * `{ Authorization: 'Bearer …' }` on a proxied page that holds a token, and
 * on a phone-full page that holds the phone secret.
 * @param opts.method the request's method; only GET may fall back to the office token
 * @param opts.loc the page location (tests pass a fake)
 * @param opts.uiToken / opts.officeToken the tokens (tests pass them)
 * @param opts.phoneSecret the phone secret (tests pass it)
 * @returns headers for fetch
 */
export function officeAuthHeaders(opts: {
  method?: 'GET' | 'POST'
  loc?: { protocol: string; hostname: string }
  uiToken?: string | null
  officeToken?: string | null
  phoneSecret?: string | null
} = {}): Record<string, string> {
  const loc = opts.loc ?? (typeof window !== 'undefined' ? window.location : { protocol: 'http:', hostname: '127.0.0.1' })
  // Why first, and why it returns either way: on the full-mode listener's
  // page the phone secret is the only credential that may leave the page.
  // Falling through to the token rules below would offer the office token to
  // a listener that refuses it (and counts it as a wrong secret).
  if (isPhoneFullLocation(loc)) {
    const phone = opts.phoneSecret !== undefined ? opts.phoneSecret : getPhoneSecret()
    return phone ? { Authorization: `Bearer ${phone}` } : {}
  }
  if (!isProxiedPage(loc)) return {}
  const ui = opts.uiToken !== undefined ? opts.uiToken : getUiToken()
  const office = opts.officeToken !== undefined ? opts.officeToken : getOfficeToken()
  const token = ui ?? ((opts.method ?? 'GET') === 'GET' ? office : null)
  return token ? { Authorization: `Bearer ${token}` } : {}
}
