/**
 * status.js — "Payroll, electricity and memory": what each Claude Code
 * session costs and how full its context window is, live.
 *
 * Fed by hooks/status-line.sh, the `statusLine` command Claude Code runs on
 * every state change of an interactive session (and, with --subagents, the
 * `subagentStatusLine` command that ticks while subagents are visible): the
 * numbers are the ones Claude Code hands its status line, and every record
 * the status line has reported for carries `source: 'statusline'`.
 *
 * A session that never reports — the plugin install, which cannot register a
 * statusLine, and headless `claude -p` — still sends hook events, and
 * server/index.js hands each one to noteHook(): its MEMORY is then estimated
 * from the last reply's usage in its transcript (server/meterEstimate.js),
 * with `source: 'transcript'` and an `estimate` block saying how. Only the
 * context fields are estimated; cost, burn and rate limits stay at nothing,
 * and the first status-line report for the session ends the estimate for good.
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
 * Each session carries `source` ('statusline' | 'transcript'; absent on a
 * stub only agent_status has filled) and, when estimated,
 *   estimate: { tokens, basis: 'model' | '1m-tag' | 'unknown' | 'overflow', approximate, compacted? }
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
 * context re-reads included, which is what you pay for). The rate depends on
 * the clock as much as on the reports: an idle session sends nothing (the
 * status line re-runs only on a state change), so its burn has to fall to
 * zero without one. The sweep timer therefore re-reads every burn and, when
 * one differs from what the clients were last sent (or the totals do, at
 * midnight say), broadcasts the whole store in the snapshot form
 * { type: 'session_status', statuses, totals } that the meters reducer
 * already takes (refresh()).
 *
 * costToday: the sessions reported today plus `retired`, the cost of the ones
 * the sweep forgot today. A forgotten session can come back (a long lunch, a
 * `claude --resume`) with total_cost_usd still cumulative, so its retired
 * cost is taken back out of `retired` and kept on the record as `carried`:
 * the session counts max(cost, carried) — its own total once, and never less
 * than what was already booked today.
 */

import { createMeterEstimator, estimateMemory, ESTIMATE_THROTTLE_MS } from './meterEstimate.js'

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
  // Cost of sessions that expired today, so costToday survives their removal;
  // bySession says whose, so a session that comes back is not counted twice
  let retired = { day: '', cost: 0, bySession: new Map() }
  // The totals the clients were last sent (any event that carries them); an
  // empty store's to begin with, which is what a snapshot of it shows
  let shownTotals = { costToday: 0, tokensPerMin: 0, dollarsPerMin: 0 }

  function retire(id, cost, t) {
    const day = dayKey(t)
    if (retired.day !== day) retired = { day, cost: 0, bySession: new Map() }
    retired.cost += cost
    retired.bySession.set(id, (retired.bySession.get(id) ?? 0) + cost)
  }

  /** What a record adds to costToday: its own cumulative cost, at least what it had booked before it was forgotten. */
  function costOf(rec) {
    return rec.carried === undefined ? rec.cost : Math.max(rec.cost, rec.carried)
  }

  /** Public shape of a record: no history or bookkeeping, burn computed for `t`. */
  function toJSON(rec, t = now()) {
    const { history, lastSample, shownBurn, carried, ...pub } = rec
    return { ...pub, burn: computeBurn(history, t) }
  }

  function totals(t = now()) {
    const day = dayKey(t)
    let costToday = retired.day === day ? retired.cost : 0
    let tokensPerMin = 0
    let dollarsPerMin = 0
    for (const rec of statuses.values()) {
      if (dayKey(rec.updatedAt) === day) costToday += costOf(rec)
      const burn = computeBurn(rec.history, t)
      tokensPerMin += burn.tokensPerMin
      dollarsPerMin += burn.dollarsPerMin
    }
    return { costToday: round(costToday, 6), tokensPerMin, dollarsPerMin: round(dollarsPerMin, 6) }
  }

  /** totals(t), remembered as what the clients now show. */
  function shown(t) {
    shownTotals = totals(t)
    return shownTotals
  }

  /**
   * A new record. A session the sweep forgot earlier today takes its booked
   * cost back from `retired` as `carried` (see costOf and the module header).
   */
  function create(id, t) {
    const rec = stub(id, t)
    if (retired.day === dayKey(t) && retired.bySession.has(id)) {
      rec.carried = retired.bySession.get(id)
      retired.cost -= rec.carried
      retired.bySession.delete(id)
    }
    statuses.set(id, rec)
    return rec
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
    const rec = statuses.get(id) ?? create(id, t)
    const ctx = body.context && typeof body.context === 'object' ? body.context : {}
    const input = clampNumber(ctx.input) ?? 0
    const output = clampNumber(ctx.output) ?? 0
    const cost = clampNumber(body.cost) ?? 0

    // The status line wins over a transcript estimate, from now on
    if (rec.source === 'transcript') {
      delete rec.estimate
      console.log(`[status] ${rec.project ?? id}: the status line reports now; memory estimate stopped`)
    }
    rec.source = 'statusline'
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
    rec.shownBurn = session.burn
    const used = session.context.used
    console.log(
      `[status] ${session.project ?? id} · ${session.model ?? '?'} · $${cost.toFixed(4)}` +
      ` · ctx ${used === null ? '?' : Math.round(used) + '%'} (${input}/${session.context.size ?? '?'})` +
      ` · ${session.burn.tokensPerMin} tok/min · $${session.burn.dollarsPerMin.toFixed(4)}/min` +
      (session.rateLimits?.fiveHour !== undefined ? ` · 5h ${session.rateLimits.fiveHour}%` : ''),
    )
    return { type: 'session_status', sessionId: id, session, totals: shown(t), timestamp: t }
  }

  function ingestAgents(body, t) {
    const id = clampString(body.sessionId)
    const rec = statuses.get(id) ?? create(id, t)
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

  /** Whether the status line has reported for this session (then it is never estimated). */
  function reportsStatusLine(id) {
    return statuses.get(id)?.source === 'statusline'
  }

  /**
   * A transcript reading for a session (server/meterEstimate.js lastUsage)
   * becomes its MEMORY meter, unless the status line reports for it. Creates
   * the record on the first reading; fills only model and context, so the
   * cost, burn and rate limits stay empty. Returns the session_status event
   * to broadcast when what the meter shows changed, else null (a same reading
   * still counts as activity for the stale sweep).
   */
  function applyEstimate(sessionId, reading, t = now()) {
    const id = clampString(sessionId)
    if (!id || reportsStatusLine(id)) return null
    let rec = statuses.get(id)
    const est = estimateMemory(reading, rec?.source === 'transcript' ? rec : null)
    if (!est) return null
    const first = rec?.source !== 'transcript'
    const same = !first && JSON.stringify([rec.context, rec.estimate, rec.model]) === JSON.stringify([est.context, est.estimate, est.model])
    if (!rec) rec = create(id, t)
    rec.source = 'transcript'
    rec.project = rec.project || sessions?.get(id)?.project
    rec.model = est.model ?? rec.model
    rec.modelId = est.modelId ?? rec.modelId
    rec.context = est.context
    rec.estimate = est.estimate
    rec.updatedAt = t
    if (same) return null
    const { used, size } = est.context
    console.log(
      `[status] ${rec.project ?? id} · ${rec.model ?? '?'} · ctx ${used === null ? '?' : used + '%'}` +
      ` (${est.estimate.tokens ?? '?'}/${size}${est.estimate.approximate ? ', approximate' : ''})` +
      ` · estimated from the transcript${first ? ' (no status line)' : ''}`,
    )
    const session = toJSON(rec, t)
    rec.shownBurn = session.burn
    return { type: 'session_status', sessionId: id, session, totals: shown(t), timestamp: t }
  }

  /** Drop sessions quiet for staleMs; returns the removal events to broadcast. */
  function expireStale(t = now()) {
    const events = []
    for (const [id, rec] of statuses) {
      if (rec.updatedAt >= t - staleMs) continue
      statuses.delete(id)
      retire(id, costOf(rec), t)
      console.log(`[status] forgot ${rec.project ?? id}: quiet for ${Math.round(staleMs / 60_000)} min`)
      events.push({ type: 'session_status', sessionId: id, removed: true, totals: shown(t), timestamp: t })
    }
    return events
  }

  /**
   * The clock moved on: when a session's burn (it decays as its last reports
   * leave the window) or the totals differ from what the clients were last
   * sent, the whole store in the snapshot form, else null. The sweep timer
   * broadcasts it (see the module header).
   */
  function refresh(t = now()) {
    const sameBurn = (a, b) => !!a && !!b && a.tokensPerMin === b.tokensPerMin && a.dollarsPerMin === b.dollarsPerMin
    const totalsNow = totals(t)
    let changed = JSON.stringify(totalsNow) !== JSON.stringify(shownTotals)
    for (const rec of statuses.values()) {
      if (!sameBurn(computeBurn(rec.history, t), rec.shownBurn)) changed = true
    }
    if (!changed) return null
    const list = summary(t).sessions
    for (const s of list) statuses.get(s.sessionId).shownBurn = s.burn
    shownTotals = totalsNow
    return { type: 'session_status', statuses: list, totals: totalsNow, timestamp: t }
  }

  function summary(t = now()) {
    const list = Array.from(statuses.values())
      .map(rec => toJSON(rec, t))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { sessions: list, totals: totals(t) }
  }

  return {
    ingest,
    applyEstimate,
    reportsStatusLine,
    expireStale,
    refresh,
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
 * Returns the store, which is also reachable as app.locals.status, plus
 * `noteHook(event)`: POST /event calls it with every sanitised hook event, and
 * a session the status line does not report for gets its MEMORY estimated
 * from the transcript the event (or the session in `sessions`) names —
 * throttled per session and read after /event has answered (see
 * server/meterEstimate.js). The stale sweep runs every `sweepMs` on an
 * unref'd timer, so importing the server never keeps a process alive; it
 * also broadcasts the burn rates the clock has moved (store.refresh). `now`
 * is the store's clock, injectable for tests.
 */
export function mountStatus(app, { requireToken, broadcast, staleMs, sessions, sweepMs = 60_000, estimateThrottleMs = ESTIMATE_THROTTLE_MS, now = () => Date.now() } = {}) {
  if (typeof requireToken !== 'function') throw new TypeError('mountStatus needs the requireToken middleware')
  const store = createStatusStore({ staleMs, sessions, now })
  const estimator = createMeterEstimator({
    skip: id => store.reportsStatusLine(id),
    apply: (id, reading) => {
      const event = store.applyEstimate(id, reading)
      if (event) broadcast(event)
    },
    throttleMs: estimateThrottleMs,
  })
  store.estimator = estimator
  store.noteHook = body => {
    if (!body?.sessionId) return
    estimator.note(body.sessionId, body.transcriptPath || sessions?.get(body.sessionId)?.transcriptPath)
  }
  app.locals.status = store

  app.post('/status', requireToken, (req, res) => {
    const validationError = validateStatus(req.body)
    if (validationError) {
      return res.status(400).json({ error: validationError })
    }
    const event = store.ingest(req.body)
    if (req.body.type === 'session_status') estimator.forget(event.sessionId)
    if (event) broadcast(event)
    res.json({ ok: true })
  })

  app.get('/status', (_req, res) => {
    res.json(store.summary())
  })

  const timer = setInterval(() => {
    for (const event of store.expireStale()) broadcast(event)
    // An idle session sends nothing, so its burn only decays here
    const refreshed = store.refresh()
    if (refreshed) broadcast(refreshed)
    estimator.prune(now() - (staleMs ?? 120 * 60_000))
  }, sweepMs)
  timer.unref?.()

  return store
}
