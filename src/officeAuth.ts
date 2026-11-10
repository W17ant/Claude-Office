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
 */

import { getOfficeToken } from './officeToken'
import { getUiToken } from './permissions'

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** True when the page came through an HTTPS proxy name rather than loopback (or the LAN listener's plain HTTP). */
export function isProxiedPage(loc: { protocol: string; hostname: string }): boolean {
  return loc.protocol === 'https:' && !LOOPBACK_NAMES.has(loc.hostname)
}

/**
 * Headers to spread into a fetch to the office server: `{}` on loopback,
 * `{ Authorization: 'Bearer …' }` on a proxied page that holds a token.
 * @param opts.method the request's method; only GET may fall back to the office token
 * @param opts.loc the page location (tests pass a fake)
 * @param opts.uiToken / opts.officeToken the tokens (tests pass them)
 * @returns headers for fetch
 */
export function officeAuthHeaders(opts: {
  method?: 'GET' | 'POST'
  loc?: { protocol: string; hostname: string }
  uiToken?: string | null
  officeToken?: string | null
} = {}): Record<string, string> {
  const loc = opts.loc ?? (typeof window !== 'undefined' ? window.location : { protocol: 'http:', hostname: '127.0.0.1' })
  if (!isProxiedPage(loc)) return {}
  const ui = opts.uiToken !== undefined ? opts.uiToken : getUiToken()
  const office = opts.officeToken !== undefined ? opts.officeToken : getOfficeToken()
  const token = ui ?? ((opts.method ?? 'GET') === 'GET' ? office : null)
  return token ? { Authorization: `Bearer ${token}` } : {}
}
