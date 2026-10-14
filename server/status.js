/**
 * status.js — "Payroll, electricity and memory": what each Claude Code
 * session costs and how full its context window is, live.
 *
 * Fed by hooks/status-line.sh, the `statusLine` command Claude Code runs on
 * every state change of an interactive session (and, with --subagents, the
 * `subagentStatusLine` command that ticks while subagents are visible).
 * Nothing here parses transcripts: the numbers are the ones Claude Code hands
 * its status line.
 *
 *   POST /status  { type: 'session_status', sessionId, project, model, modelId,
 *                   cost, durationMs, apiDurationMs, linesAdded, linesRemoved,
 *                   context: { used, size, input, output },
 *                   rateLimits?: { fiveHour, sevenDay, spendLimit, <window>ResetsAt },
 *                   effort?, exceeds200k, version? }
 *   POST /status  { type: 'agent_status', sessionId,
 *                   agents: [{ id, tokens, contextSize?, status?, agentType?, name?, model?, description? }] }
 *   GET  /status  → { sessions: [...], totals: { costToday, tokensPerMin, dollarsPerMin } }
 *
 * Same bearer check as POST /event: server/index.js passes its `requireToken`
 * middleware (constant-time compare) in. Broadcasts `session_status` (one
 * session, with the totals) and `agent_status`; the WS snapshot carries the whole
 * summary as `statuses`. The store is keyed by session_id — the key of
 * server/index.js's `sessions` map — and borrows a session's project name
 * from there when the status line did not say. Memory only (v1); a session
 * nothing has been heard from for `staleMs` is dropped.
 *
 * Burn rate: the last HISTORY_POINTS status points per session feed a
 * 5-minute window. $/min is the cost delta across the window; tokens/min
 * counts the tokens every API round-trip in the window processed (the status
 * line's total_input_tokens + total_output_tokens of each new response —
 * context re-reads included, which is what you pay for).
 */

export const HISTORY_POINTS = 60
export const BURN_WINDOW_MS = 5 * 60_000
// Less than a minute of data is extrapolated as if it were a minute
const MIN_BURN_SPAN_MS = 60_000
const MAX_AGENTS = 32
const MAX_STRING_LEN = 200
const STATUS_TYPES = new Set(['session_status', 'agent_status'])

function clampString(val, max = MAX_STRING_LEN) {
  if (typeof val !== 'string') return undefined
  return val.slice(0, max)
}

/** A finite number clamped to [min, max], else null. */
function clampNumber(val, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return null
  return Math.min(max, Math.max(min, val))
}

const round = (n, digits) => Number(n.toFixed(digits))

/** Local calendar day of a timestamp — "today" for costToday. */
export function dayKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * Burn rate over the last BURN_WINDOW_MS of a session's history
 * ([{ t, cost, tokens }], oldest first). Needs two points inside the window;
 * both deltas are taken from the oldest point in it.
 */
export function computeBurn(history, now = Date.now()) {
  const window = (history ?? []).filter(p => p.t >= now - BURN_WINDOW_MS && p.t <= now)
  if (window.length < 2) return { dollarsPerMin: 0, tokensPerMin: 0 }
  const oldest = window[0]
  const latest = window[window.length - 1]
  const spanMin = Math.min(BURN_WINDOW_MS, Math.max(MIN_BURN_SPAN_MS, now - oldest.t)) / 60_000
  const dollars = Math.max(0, latest.cost - oldest.cost) / spanMin
  const tokens = window.slice(1).reduce((sum, p) => sum + (p.tokens ?? 0), 0) / spanMin
  return { dollarsPerMin: round(dollars, 6), tokensPerMin: Math.round(tokens) }
}

/** Body check for POST /status: an error string, or null when it can be ingested. */
export function validateStatus(body) {
  if (!body || typeof body !== 'object') return 'Missing body'
  if (!body.type || typeof body.type !== 'string') return 'Missing event type'
  if (!STATUS_TYPES.has(body.type)) return `Unknown status type: ${body.type}`
  if (!body.sessionId || typeof body.sessionId !== 'string') return 'Missing sessionId'
  if (body.type === 'agent_status' && !Array.isArray(body.agents)) return 'Missing agents'
  return null
}

function sanitiseRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const out = {}
  for (const window of ['fiveHour', 'sevenDay', 'spendLimit']) {
    // used_percentage runs 0-100; spend_limit can run past 100 once exceeded
    const pct = clampNumber(raw[window], 0, 999)
    if (pct !== null) out[window] = pct
    const resets = clampNumber(raw[`${window}ResetsAt`])
    if (resets !== null) out[`${window}ResetsAt`] = resets
  }
  return Object.keys(out).length ? out : undefined
}

function sanitiseAgents(raw) {
  return (Array.isArray(raw) ? raw : [])
    .slice(0, MAX_AGENTS)
    .filter(a => a && typeof a === 'object' && typeof a.id === 'string' && a.id)
    .map(a => {
      const agent = { id: clampString(a.id), tokens: clampNumber(a.tokens) ?? 0 }
      const contextSize = clampNumber(a.contextSize)
      if (contextSize) agent.contextSize = contextSize
      for (const key of ['status', 'agentType', 'name', 'model', 'description']) {
        const val = clampString(a[key])
        if (val) agent[key] = val
      }
      return agent
    })
}

/**
 * The store: statuses keyed by session id, burn history, daily totals.
 * `sessions` is server/index.js's session map (optional), used for the
 * project name; `now` is injectable for tests.
 */
export function createStatusStore({ staleMs = 120 * 60_000, sessions = null, now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} sessionId -> status record (+ history) */
  const statuses = new Map()
  // Cost of sessions that expired today, so costToday survives their removal
  let retired = { day: '', cost: 0 }

  function retire(cost, t) {
    const day = dayKey(t)
    if (retired.day !== day) retired = { day, cost: 0 }
    retired.cost += cost
  }

  /** Public shape of a record: no history, burn computed for `t`. */
  function toJSON(rec, t = now()) {
    const { history, lastSample, ...pub } = rec
    return { ...pub, burn: computeBurn(history, t) }
  }

  function totals(t = now()) {
    const day = dayKey(t)
    let costToday = retired.day === day ? retired.cost : 0
    let tokensPerMin = 0
    let dollarsPerMin = 0
    for (const rec of statuses.values()) {
      if (dayKey(rec.updatedAt) === day) costToday += rec.cost
      const burn = computeBurn(rec.history, t)
      tokensPerMin += burn.tokensPerMin
      dollarsPerMin += burn.dollarsPerMin
    }
    return { costToday: round(costToday, 6), tokensPerMin, dollarsPerMin: round(dollarsPerMin, 6) }
  }

  function stub(id, t) {
    return {
      sessionId: id,
      project: sessions?.get(id)?.project,
      model: undefined,
      modelId: undefined,
      cost: 0,
      durationMs: 0,
      apiDurationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
      context: { used: null, size: null, input: 0, output: 0 },
      rateLimits: undefined,
      effort: undefined,
      exceeds200k: false,
      version: undefined,
      agents: [],
      firstSeenAt: t,
      updatedAt: t,
      history: [],
      lastSample: null,
    }
  }

  function ingestSession(body, t) {
    const id = clampString(body.sessionId)
    let rec = statuses.get(id)
    if (!rec) {
      rec = stub(id, t)
      statuses.set(id, rec)
    }
    const ctx = body.context && typeof body.context === 'object' ? body.context : {}
    const input = clampNumber(ctx.input) ?? 0
    const output = clampNumber(ctx.output) ?? 0
    const cost = clampNumber(body.cost) ?? 0

    rec.project = clampString(body.project) || rec.project || sessions?.get(id)?.project
    rec.model = clampString(body.model) || rec.model
    rec.modelId = clampString(body.modelId) || rec.modelId
    rec.cost = cost
    rec.durationMs = clampNumber(body.durationMs) ?? 0
    rec.apiDurationMs = clampNumber(body.apiDurationMs) ?? 0
    rec.linesAdded = clampNumber(body.linesAdded) ?? 0
    rec.linesRemoved = clampNumber(body.linesRemoved) ?? 0
    rec.context = {
      used: clampNumber(ctx.used, 0, 100),
      size: clampNumber(ctx.size),
      input,
      output,
    }
    rec.rateLimits = sanitiseRateLimits(body.rateLimits)
    rec.effort = clampString(body.effort, 20)
    rec.exceeds200k = body.exceeds200k === true
    rec.version = clampString(body.version, 20)
    rec.updatedAt = t

    // One history point per change: the status line also re-runs for
    // permission-mode or vim toggles, which carry the same numbers
    const sample = `${input}:${output}`
    const last = rec.history[rec.history.length - 1]
    if (!last || last.cost !== cost || rec.lastSample !== sample) {
      const tokens = rec.lastSample === sample ? 0 : input + output
      rec.history.push({ t, cost, tokens })
      if (rec.history.length > HISTORY_POINTS) rec.history.shift()
      rec.lastSample = sample
    }

    const session = toJSON(rec, t)
    const used = session.context.used
    console.log(
      `[status] ${session.project ?? id} · ${session.model ?? '?'} · $${cost.toFixed(4)}` +
      ` · ctx ${used === null ? '?' : Math.round(used) + '%'} (${input}/${session.context.size ?? '?'})` +
      ` · ${session.burn.tokensPerMin} tok/min · $${session.burn.dollarsPerMin.toFixed(4)}/min` +
      (session.rateLimits?.fiveHour !== undefined ? ` · 5h ${session.rateLimits.fiveHour}%` : ''),
    )
    return { type: 'session_status', sessionId: id, session, totals: totals(t), timestamp: t }
  }

  function ingestAgents(body, t) {
    const id = clampString(body.sessionId)
    let rec = statuses.get(id)
    if (!rec) {
      rec = stub(id, t)
      statuses.set(id, rec)
    }
    rec.agents = sanitiseAgents(body.agents)
    rec.agentsUpdatedAt = t
    rec.updatedAt = t
    const total = rec.agents.reduce((sum, a) => sum + a.tokens, 0)
    console.log(`[status] ${rec.project ?? id} · ${rec.agents.length} subagent(s) · ${total} tokens`)
    return { type: 'agent_status', sessionId: id, agents: rec.agents, timestamp: t }
  }

  /** Ingest a validated body; returns the event to broadcast. */
  function ingest(body, t = now()) {
    return body.type === 'agent_status' ? ingestAgents(body, t) : ingestSession(body, t)
  }

  /** Drop sessions quiet for staleMs; returns the removal events to broadcast. */
  function expireStale(t = now()) {
    const events = []
    for (const [id, rec] of statuses) {
      if (rec.updatedAt >= t - staleMs) continue
      statuses.delete(id)
      retire(rec.cost, t)
      console.log(`[status] forgot ${rec.project ?? id}: quiet for ${Math.round(staleMs / 60_000)} min`)
      events.push({ type: 'session_status', sessionId: id, removed: true, totals: totals(t), timestamp: t })
    }
    return events
  }

  function summary(t = now()) {
    const list = Array.from(statuses.values())
      .map(rec => toJSON(rec, t))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { sessions: list, totals: totals(t) }
  }

  return {
    ingest,
    expireStale,
    summary,
    totals,
    get: id => statuses.get(id),
    has: id => statuses.has(id),
    get size() { return statuses.size },
  }
}

/**
 * Mount POST /status + GET /status on an Express app. `requireToken` is the
 * office's bearer middleware (server/index.js's constant-time token check),
 * handed in rather than imported so this module never pulls in index.js.
 * Returns the store, which is also reachable as app.locals.status. The stale
 * sweep runs every `sweepMs` on an unref'd timer, so importing the server
 * never keeps a process alive.
 */
export function mountStatus(app, { requireToken, broadcast, staleMs, sessions, sweepMs = 60_000 } = {}) {
  if (typeof requireToken !== 'function') throw new TypeError('mountStatus needs the requireToken middleware')
  const store = createStatusStore({ staleMs, sessions })
  app.locals.status = store

  app.post('/status', requireToken, (req, res) => {
    const validationError = validateStatus(req.body)
    if (validationError) {
      return res.status(400).json({ error: validationError })
    }
    const event = store.ingest(req.body)
    if (event) broadcast(event)
    res.json({ ok: true })
  })

  app.get('/status', (_req, res) => {
    res.json(store.summary())
  })

  const timer = setInterval(() => {
    for (const event of store.expireStale()) broadcast(event)
  }, sweepMs)
  timer.unref?.()

  return store
}
