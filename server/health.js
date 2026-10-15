/**
 * health.js — pipeline health: is the server up, have Claude Code hooks ever
 * reached it, how long ago, and what is it running.
 *
 * The most common support question is "nothing appears", and until now the
 * office had no way to answer it: no connection indicator, no sign of whether
 * hooks are installed and firing. This module is the server half of that
 * answer; src/components/StatusStrip.tsx shows it along the bottom of the
 * office and scripts/doctor.mjs prints it.
 *
 *   GET /health → { status: 'ok', agents, clients, sessions,
 *                   lastHookAt (ms epoch | null), hooksSeen (since boot),
 *                   uiAvailable, version (package.json), uptimeMs }
 *
 * server/index.js calls `markHook()` from POST /event once a body has passed
 * validation. Every call bumps `hooksSeen` / `lastHookAt` and broadcasts a
 * `health` event — throttled to one per `throttleMs` (5 s): the first hook
 * after a quiet spell goes out at once, a burst of tool calls is coalesced
 * into one trailing broadcast, so a busy session costs clients at most one
 * small message every five seconds. The WebSocket snapshot carries the same
 * object as `health`, so a page that connects knows at once.
 *
 *   { type: 'health', health: <GET /health body>, timestamp }
 *
 * `counts` is injected (agents / clients / sessions live in index.js), as are
 * `now` and the timer functions, so the throttle is unit-testable without
 * waiting. The timer is unref'd: importing the server never keeps a process
 * alive.
 */

import { readFileSync } from 'fs'

export const HEALTH_THROTTLE_MS = 5_000

/** The version in package.json, or '0.0.0' when it cannot be read (a stripped install). */
export function readVersion(pkgUrl = new URL('../package.json', import.meta.url)) {
  try {
    const version = JSON.parse(readFileSync(pkgUrl, 'utf8')).version
    return typeof version === 'string' && version ? version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * The health record and its throttled broadcast.
 * @param {object} [opts]
 * @param {() => { agents?: number, clients?: number, sessions?: number }} [opts.counts]
 * @param {(event: object) => void} [opts.broadcast]
 * @param {boolean} [opts.uiAvailable]
 * @param {string} [opts.version]
 * @param {number} [opts.throttleMs]
 * @param {() => number} [opts.now]
 * @param {typeof setTimeout} [opts.setTimer]
 * @param {typeof clearTimeout} [opts.clearTimer]
 */
export function createHealth({
  counts = () => ({}),
  broadcast = () => {},
  uiAvailable = false,
  version = readVersion(),
  throttleMs = HEALTH_THROTTLE_MS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const bootAt = now()
  let hooksSeen = 0
  let lastHookAt = null
  let lastBroadcastAt = -Infinity
  let timer = null

  /** The GET /health body. */
  function snapshot(t = now()) {
    const c = counts() ?? {}
    return {
      status: 'ok',
      agents: c.agents ?? 0,
      clients: c.clients ?? 0,
      sessions: c.sessions ?? 0,
      lastHookAt,
      hooksSeen,
      uiAvailable: !!uiAvailable,
      version,
      uptimeMs: Math.max(0, t - bootAt),
    }
  }

  /** The WebSocket event carrying the snapshot. */
  function event(t = now()) {
    return { type: 'health', health: snapshot(t), timestamp: t }
  }

  function flush(t) {
    lastBroadcastAt = t
    broadcast(event(t))
  }

  /** Broadcast now if the last one is older than throttleMs, else once at the end of the window. */
  function schedule(t) {
    if (timer !== null) return
    const wait = throttleMs - (t - lastBroadcastAt)
    if (wait <= 0) {
      flush(t)
      return
    }
    timer = setTimer(() => {
      timer = null
      flush(now())
    }, wait)
    timer?.unref?.()
  }

  /** A hook event reached POST /event. */
  function markHook(t = now()) {
    hooksSeen += 1
    lastHookAt = t
    schedule(t)
  }

  /** Drop a pending trailing broadcast (tests, shutdown). */
  function stop() {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    snapshot,
    event,
    markHook,
    stop,
    get hooksSeen() { return hooksSeen },
    get lastHookAt() { return lastHookAt },
    /** A trailing broadcast is waiting for the window to end. */
    get pending() { return timer !== null },
  }
}

/**
 * Mount GET /health on an Express app and return the health record (also
 * reachable as app.locals.health). The route stays open, like every other
 * GET: scripts/doctor.mjs, the start script and the plugin command poll it
 * without a token.
 */
export function mountHealth(app, opts = {}) {
  const health = createHealth(opts)
  app.locals.health = health

  // GET /health?challenge=<hex> also answers `proof`: HMAC-SHA256 of the
  // office token over 'office-health:' + the challenge (opts.prove). The
  // openers (npm run open, start-office.sh, the desktop app) check it before
  // they hand the token to whatever answers on the port: a process that
  // squats the port while the office is down cannot produce it
  app.get('/health', (req, res) => {
    const challenge = typeof req.query.challenge === 'string' ? req.query.challenge : ''
    const proof = opts.prove && /^[0-9a-f]{16,128}$/.test(challenge) ? opts.prove(challenge) : undefined
    res.json(proof ? { ...health.snapshot(), proof } : health.snapshot())
  })

  return health
}
