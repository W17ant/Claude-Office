/**
 * permissions.js — answer a Claude Code permission dialog from the office.
 *
 * When Claude Code stops at "Do you want to create probe.txt?" its
 * PermissionRequest hook fires, and whatever that hook prints decides the
 * dialog: `{"behavior":"allow"}` is option 1, the same with the dialog's own
 * `permission_suggestions` echoed back as `updatedPermissions` is option 2
 * (allow and remember), `{"behavior":"deny"}` is option 3, and printing
 * nothing leaves the terminal dialog in charge. The hook is never cancelled
 * when the user answers in the terminal; its late output is simply ignored.
 *
 * So the office works like this. The tracker POSTs the PermissionRequest as a
 * `session_needs_you {kind: permission, answerable: true}` and, for that one
 * event, waits for the answer: the /event response carries a permissionId and
 * the hook long-polls GET /permission/:id until the server says it is over.
 * A click in the office POSTs /permission/:id and the hook prints the
 * matching hookOutput. Everything else the session does afterwards —
 * PreToolUse, PostToolUse, PostToolBatch, Stop, UserPromptSubmit, a new
 * PermissionRequest, SessionEnd — means the dialog was answered elsewhere, and
 * the pending record is released as `resolved_elsewhere` so the hook exits
 * without printing. The terminal always wins.
 *
 * Expiry. A headless `claude -p` session auto-denies the call the moment all
 * PermissionRequest hooks finish and never fires a Notification, so a long
 * office wait would stall it: a pending permission expires after
 * PERMISSION_WAIT_MS (15 s) unless the session is known to be interactive, in
 * which case it may wait PERMISSION_WAIT_MAX_MS (10 min — the hook's default
 * timeout is 600 s). A session is "known to be interactive" once a
 * Notification-derived needs-you has been seen for its session_id, for this
 * request or earlier; Notification{permission_prompt} fires ~6 s after
 * PermissionRequest when the user is not looking at the terminal, which is
 * exactly when the office matters, so the deadline is extended then.
 *
 *   store.create(fields)                  -> { permission, wait: { pollMs, deadline } }
 *   GET  /permission/:id?wait=<s>         (token) long-poll: { status, deadline, hookOutput? }
 *   POST /permission/:id { decision }     (UI token or token) allow | allow-remember | deny
 *   GET  /permissions                     (open) the pending ones
 *
 * Broadcasts: permission_request on creation, permission_extended when a
 * deadline moves, permission_resolved {permissionId, status, decidedBy} on
 * every terminal state. decidedBy is 'office' (a click here), 'terminal'
 * (resolved elsewhere) or 'timeout'. The hookOutput printed by the hook is
 * built here and nowhere else; it never carries updatedInput.
 */

import { randomBytes } from 'crypto'

function envMs(name, fallback) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** How long a pending permission waits for the office before a headless session gets its auto-deny back. */
export const PERMISSION_WAIT_MS = envMs('AGENT_OFFICE_PERMISSION_WAIT_MS', 15_000)
/** The wait once the session is known to be interactive (Notification seen); under the hook's 600 s default timeout. */
export const PERMISSION_WAIT_MAX_MS = envMs('AGENT_OFFICE_PERMISSION_WAIT_MAX_MS', 10 * 60_000)
/** What the hook is told to use per long-poll; each of its curls is bounded to this plus a margin. */
export const PERMISSION_POLL_MS = 20_000
/** The longest GET /permission/:id?wait= the server honours, in seconds. */
export const MAX_LONG_POLL_S = 30
/** A terminal record stays readable this long, so a poll that raced the decision still gets the answer. */
export const RESOLVED_KEEP_MS = 60_000

export const PERMISSION_STATUSES = new Set(['pending', 'allowed', 'denied', 'resolved_elsewhere', 'expired'])
export const DECISIONS = new Set(['allow', 'allow-remember', 'deny'])
export const DENY_MESSAGE = 'Denied from Claude Office'

const MAX_SUGGESTIONS = 4
const MAX_LIST = 8
const MAX_KEYS = 12
const MAX_DEPTH = 3

/**
 * permission_suggestions as the hook forwards them: the PermissionUpdate shape
 * is kept whole (setMode has mode + destination; addRules has a rules[] of
 * {toolName, ruleContent}) because it goes back verbatim as updatedPermissions,
 * but every string, list and object is bounded. Anything that is not a list of
 * objects becomes [].
 */
export function sanitiseSuggestions(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(s => s && typeof s === 'object' && !Array.isArray(s)).slice(0, MAX_SUGGESTIONS).map(s => clampJson(s, 0))
}

function clampJson(value, depth) {
  if (typeof value === 'string') return value.slice(0, 200)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (depth >= MAX_DEPTH) return null
  if (Array.isArray(value)) return value.slice(0, MAX_LIST).map(v => clampJson(v, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) out[String(k).slice(0, 40)] = clampJson(v, depth + 1)
    return out
  }
  return null
}

/** The exact object the hook prints for a decision (the PermissionRequest hook output contract). */
export function hookOutputFor(decision, suggestions = []) {
  const wrap = d => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } })
  switch (decision) {
    case 'allow':          return wrap({ behavior: 'allow' })
    case 'allow-remember': return wrap({ behavior: 'allow', updatedPermissions: suggestions })
    case 'deny':           return wrap({ behavior: 'deny', message: DENY_MESSAGE, interrupt: false })
    default:               return null
  }
}

/** Public shape of a record (no timers, no waiters). */
function toJSON(rec) {
  const { timer, waiters, forget, ...pub } = rec
  return pub
}

/**
 * The pending-permission store. `broadcast` gets every WS event; `now` is
 * injectable for tests. Timers are unref'd so they never keep the process up.
 */
export function createPermissionStore({ broadcast = () => {}, now = Date.now } = {}) {
  /** @type {Map<string, object>} id -> record */
  const records = new Map()
  /** Sessions a Notification has been seen for: their permissions may wait the full PERMISSION_WAIT_MAX_MS. */
  const interactive = new Set()

  function armExpiry(rec) {
    if (rec.timer) clearTimeout(rec.timer)
    const delay = Math.max(0, rec.deadline - now())
    rec.timer = setTimeout(() => {
      rec.timer = null
      if (rec.status === 'pending') resolve(rec.id, 'expired', 'timeout')
    }, delay)
    rec.timer.unref?.()
  }

  function wake(rec) {
    const waiters = rec.waiters.splice(0)
    for (const w of waiters) {
      clearTimeout(w.timer)
      w.resolve(toJSON(rec))
    }
  }

  function create(fields) {
    const t = now()
    const sessionId = String(fields.sessionId)
    const isInteractive = interactive.has(sessionId)
    const rec = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      ...(fields.project ? { project: String(fields.project) } : {}),
      ...(fields.cwd ? { cwd: String(fields.cwd) } : {}),
      ...(fields.sessionTitle ? { sessionTitle: String(fields.sessionTitle) } : {}),
      toolName: String(fields.toolName || 'tool'),
      summary: String(fields.summary ?? ''),
      detail: String(fields.detail ?? ''),
      suggestions: sanitiseSuggestions(fields.suggestions),
      permissionMode: String(fields.permissionMode || 'default'),
      ...(fields.promptId ? { promptId: String(fields.promptId) } : {}),
      ...(fields.agentId ? { agentId: String(fields.agentId) } : {}),
      createdAt: t,
      deadline: t + (isInteractive ? PERMISSION_WAIT_MAX_MS : PERMISSION_WAIT_MS),
      status: 'pending',
      interactive: isInteractive,
      timer: null,
      waiters: [],
      forget: null,
    }
    records.set(rec.id, rec)
    armExpiry(rec)
    console.log(`[permission] ${rec.project ?? rec.sessionId}: ${rec.toolName} ${rec.summary} waits for the office (${rec.id}, ${Math.round((rec.deadline - t) / 1000)} s)`)
    broadcast({ type: 'permission_request', permission: toJSON(rec), timestamp: t })
    return { permission: toJSON(rec), wait: { pollMs: PERMISSION_POLL_MS, deadline: rec.deadline } }
  }

  /** A terminal state: wakes every poller, broadcasts, keeps the record a while for a late poll. */
  function resolve(id, status, decidedBy, decision) {
    const rec = records.get(id)
    if (!rec || rec.status !== 'pending' || !PERMISSION_STATUSES.has(status) || status === 'pending') return null
    const t = now()
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null }
    rec.status = status
    rec.decidedBy = decidedBy
    rec.decidedAt = t
    if (decision) {
      rec.decision = decision
      rec.hookOutput = hookOutputFor(decision, rec.suggestions)
    }
    console.log(`[permission] ${rec.project ?? rec.sessionId}: ${rec.toolName} ${rec.summary} -> ${status} (${decidedBy}${decision ? `: ${decision}` : ''})`)
    wake(rec)
    broadcast({ type: 'permission_resolved', permissionId: rec.id, sessionId: rec.sessionId, status, decidedBy, timestamp: t })
    rec.forget = setTimeout(() => records.delete(rec.id), RESOLVED_KEEP_MS)
    rec.forget.unref?.()
    return toJSON(rec)
  }

  /**
   * The office clicked: allow | allow-remember | deny. allow-remember needs
   * the dialog's own suggestions to echo back, else there is nothing to
   * remember. Returns { error, code } for the route to answer with.
   */
  function decide(id, decision) {
    const rec = records.get(id)
    if (!rec) return { error: 'Unknown permission', code: 404 }
    if (!DECISIONS.has(decision)) return { error: `decision must be one of ${Array.from(DECISIONS).join(', ')}`, code: 400 }
    if (rec.status !== 'pending') return { error: `Permission already ${rec.status}`, code: 409, status: rec.status }
    if (decision === 'allow-remember' && rec.suggestions.length === 0) return { error: 'Nothing to remember: the dialog offered no permission suggestions', code: 400 }
    return { permission: resolve(id, decision === 'deny' ? 'denied' : 'allowed', 'office', decision) }
  }

  /**
   * Later activity of the session (or its end): every pending permission of
   * it that `filter` accepts was answered in the terminal.
   */
  function resolveSession(sessionId, reason, filter = () => true) {
    let n = 0
    for (const rec of Array.from(records.values())) {
      if (rec.sessionId !== sessionId || rec.status !== 'pending' || !filter(toJSON(rec))) continue
      if (reason) console.log(`[permission] ${rec.project ?? rec.sessionId}: ${reason}`)
      resolve(rec.id, 'resolved_elsewhere', 'terminal')
      n++
    }
    return n
  }

  /**
   * A Notification arrived for the session: it is interactive, so its
   * pending permissions may wait the full PERMISSION_WAIT_MAX_MS from creation.
   */
  function markInteractive(sessionId) {
    interactive.add(sessionId)
    const extended = []
    for (const rec of records.values()) {
      if (rec.sessionId !== sessionId || rec.status !== 'pending' || rec.interactive) continue
      rec.interactive = true
      rec.deadline = rec.createdAt + PERMISSION_WAIT_MAX_MS
      armExpiry(rec)
      console.log(`[permission] ${rec.project ?? rec.sessionId}: session is interactive, ${rec.toolName} ${rec.summary} may wait ${PERMISSION_WAIT_MAX_MS / 60_000} min`)
      broadcast({ type: 'permission_extended', permissionId: rec.id, sessionId: rec.sessionId, deadline: rec.deadline, timestamp: now() })
      extended.push(toJSON(rec))
    }
    return extended
  }

  /**
   * Long-poll: resolves with the record as soon as it leaves `pending`, or
   * with its current state after `ms`. `cancel` drops the waiter (the hook
   * hung up). null for an unknown id.
   */
  function waitFor(id, ms) {
    const rec = records.get(id)
    if (!rec) return { promise: Promise.resolve(null), cancel() {} }
    if (rec.status !== 'pending' || ms <= 0) return { promise: Promise.resolve(toJSON(rec)), cancel() {} }
    let waiter
    const promise = new Promise(res => {
      waiter = { resolve: res, timer: setTimeout(() => { drop(); res(toJSON(rec)) }, ms) }
      waiter.timer.unref?.()
      rec.waiters.push(waiter)
    })
    const drop = () => { const i = rec.waiters.indexOf(waiter); if (i >= 0) rec.waiters.splice(i, 1) }
    return { promise, cancel() { drop(); clearTimeout(waiter.timer) } }
  }

  return {
    create,
    decide,
    resolve,
    resolveSession,
    markInteractive,
    waitFor,
    get: id => { const rec = records.get(id); return rec ? toJSON(rec) : null },
    pending: () => Array.from(records.values()).filter(r => r.status === 'pending').map(toJSON),
    isInteractive: sessionId => interactive.has(sessionId),
    get size() { return records.size },
  }
}

/**
 * Mount the routes on the Express app. `requireToken` guards the hook's
 * long-poll (only the hook, which read the 0600 token file, may learn a
 * decision), `requireUi` guards the decision itself (the office page's UI
 * token from the origin-gated WebSocket snapshot, or the token). `onDecided`
 * is called with the record after a click here, so server/index.js can lower
 * the session's needs-you hand.
 */
export function mountPermissions(app, { requireToken, requireUi, broadcast, onDecided = () => {}, store } = {}) {
  if (typeof requireToken !== 'function') throw new TypeError('mountPermissions needs the requireToken middleware')
  if (typeof requireUi !== 'function') throw new TypeError('mountPermissions needs the requireUi middleware')
  const permissions = store ?? createPermissionStore({ broadcast })
  app.locals.permissions = permissions

  app.get('/permissions', (_req, res) => {
    res.json({ permissions: permissions.pending() })
  })

  app.get('/permission/:id', requireToken, async (req, res) => {
    const id = String(req.params.id)
    if (!permissions.get(id)) return res.status(404).json({ error: 'Unknown permission' })
    const waitS = Math.min(MAX_LONG_POLL_S, Math.max(0, Number(req.query.wait) || 0))
    const { promise, cancel } = permissions.waitFor(id, waitS * 1000)
    // The hook hung up (its curl --max-time ran out, or it was killed): no answer owed
    res.on('close', cancel)
    const rec = await promise
    if (res.writableEnded || res.destroyed) return
    if (!rec) return res.status(404).json({ error: 'Unknown permission' })
    res.json({ status: rec.status, deadline: rec.deadline, ...(rec.hookOutput ? { hookOutput: rec.hookOutput } : {}) })
  })

  app.post('/permission/:id', requireUi, (req, res) => {
    const id = String(req.params.id)
    const decision = req.body?.decision
    const result = permissions.decide(id, typeof decision === 'string' ? decision : '')
    if (result.error) return res.status(result.code).json({ error: result.error, ...(result.status ? { status: result.status } : {}) })
    onDecided(result.permission)
    res.json({ ok: true, permissionId: id, status: result.permission.status })
  })

  return permissions
}
