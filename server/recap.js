/**
 * recap.js - the end-of-day recap: a small per-day summary of what the office
 * saw, kept in chat.db so it survives a restart.
 *
 * Everything else the office knows about a day (sessions, agents, the task
 * board, the signal ring, the meters) lives in memory and is gone at the next
 * start. This module counts it as it happens, from the paths server/index.js
 * already runs — processEvent, relaySignals, the incident slash commands and
 * POST /status — without changing what those paths do: every entry point is
 * a plain "note this" call, and server/index.js wraps each in a try/catch.
 *
 * ## The day
 *
 * A day is the server's LOCAL calendar date, `YYYY-MM-DD` (localDate()).
 * Every note is filed under the date of the moment it was noted, so the
 * counters roll over at local midnight with no timer: the first note after
 * midnight starts a new row.
 *
 * ## What each column counts (daily_stats)
 *
 *   sessions          distinct Claude Code sessions that sent at least one
 *                     hook event that day (other than SessionEnd) and were
 *                     active after it. A session that runs past midnight
 *                     counts on both days.
 *   agents_spawned    distinct office agents that clocked in (an
 *                     `agent_spawned` the office accepted, including the
 *                     stand-in it makes for a worker it never saw spawned).
 *                     A replayed spawn of the same agent is not counted again.
 *   agents_completed  distinct office agents that clocked out (an
 *                     `agent_completed` for an agent the office knew; the
 *                     second report of the same finish is not counted).
 *                     Agents sent home because their session ended count.
 *   tasks_completed   distinct task-board tasks completed (TaskCompleted),
 *                     keyed by session + task id.
 *   deploys           `deploy_success` signals — deploys that went out.
 *   builds_failed     `build_failed` signals, except a run stopped with Esc.
 *   tests_failed      `test_failed` signals, except a run stopped with Esc.
 *   pushes            `push_done` signals — pushes that went through.
 *   incidents         incident-mode openings the server can see: a
 *                     `/incident` declaration or a failed deploy
 *                     (`deploy_fail`, not interrupted) while no incident is
 *                     open. One stays open until `/all-clear`, a
 *                     `deploy_success`, or INCIDENT_QUIET_MS without another
 *                     failed deploy, build or test run — the page's own rules
 *                     (src/incident.ts). The page's other triggers (three
 *                     failed tool calls in 5 min, the simulated random
 *                     events) are decided in the browser and not counted.
 *   cost_usd          payroll: for every session the status line reported
 *                     that day, the highest cumulative `cost` seen that day
 *                     minus what the session had already cost by the end of
 *                     the previous day it was seen (0 for a session first
 *                     seen today), summed. So a session that runs past
 *                     midnight books its morning spend on the new day, not
 *                     its whole bill twice. Sessions with no status line (the
 *                     plugin install, `claude -p`) report no cost and add 0.
 *
 * ## Tables
 *
 *   daily_stats         one row per day, the columns above.
 *   daily_seen          (date, kind, key) — what was already counted that
 *                       day, so a replay never counts twice (kind: session,
 *                       spawn, complete, task).
 *   daily_session_cost  (date, session_id, base_usd, max_usd) — the payroll
 *                       readings behind cost_usd.
 *
 * The two helper tables hold session and agent ids only — no text — and are
 * pruned to the last KEEP_KEYS_DAYS days. daily_stats is kept: it is a
 * dozen numbers a day. Nothing here stores a prompt, reply, command line or
 * task subject, so GET /recap can stay open like the other read-only GETs.
 */

/** Counter columns of daily_stats, in display order (cost_usd is separate). */
export const COUNT_COLUMNS = [
  'sessions', 'agents_spawned', 'agents_completed', 'tasks_completed',
  'deploys', 'builds_failed', 'tests_failed', 'pushes', 'incidents',
]

// Why 7 days: the dedupe keys only matter for the day they were noted, and
// the payroll base looks back to the last day a session was seen; a week
// covers a long weekend with a session left open, and keeps the tables tiny.
const KEEP_KEYS_DAYS = 7

// Why 10 min: src/incident.ts INCIDENT_CONFIG.autoExitMs — an open incident
// closes after this long with no new failure, and the server mirrors it.
export const INCIDENT_QUIET_MS = 10 * 60_000

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The local calendar date of a timestamp, as YYYY-MM-DD.
 * @param {number} t epoch ms
 * @returns {string}
 */
export function localDate(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Whether a string is a real calendar date in YYYY-MM-DD form.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecapDate(value) {
  if (typeof value !== 'string') return false
  const m = DATE_PATTERN.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  // Why the round trip: new Date(2026, 1, 31) quietly becomes 3 March
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d
}

/** A date string `days` before `date` (both YYYY-MM-DD, local). */
function daysBefore(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y, m - 1, d - days, 12).getTime())
}

/** Round to whole micro-dollars, so float sums print cleanly. */
function roundUsd(n) {
  return Math.round(n * 1e6) / 1e6
}

/**
 * Create the recap store on a better-sqlite3 database (the chat.db handle in
 * production, an in-memory one in tests).
 * @param {import('better-sqlite3').Database} db
 * @param {{ now?: () => number }} [opts] `now` is the clock, injectable for tests
 * @returns the store: note(), signal(), incident(), cost(), get(), today()
 */
export function createRecap(db, { now = () => Date.now() } = {}) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS daily_stats (' +
    '  date             TEXT    PRIMARY KEY,' + // local YYYY-MM-DD
    COUNT_COLUMNS.map(c => `  ${c} INTEGER NOT NULL DEFAULT 0,`).join('') +
    '  cost_usd         REAL    NOT NULL DEFAULT 0' +
    ')'
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS daily_seen (' +
    '  date TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,' +
    '  PRIMARY KEY (date, kind, key)' +
    ') WITHOUT ROWID'
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS daily_session_cost (' +
    '  date TEXT NOT NULL, session_id TEXT NOT NULL,' +
    '  base_usd REAL NOT NULL, max_usd REAL NOT NULL,' +
    '  PRIMARY KEY (date, session_id)' +
    ') WITHOUT ROWID'
  )

  const stmtEnsure = db.prepare('INSERT INTO daily_stats (date) VALUES (?) ON CONFLICT(date) DO NOTHING')
  // Why one statement per column: a column name cannot be a bound parameter,
  // and building SQL from a whitelist once beats interpolating per call
  const stmtBump = Object.fromEntries(COUNT_COLUMNS.map(c => [c, db.prepare(`UPDATE daily_stats SET ${c} = ${c} + 1 WHERE date = ?`)]))
  const stmtSeen = db.prepare('INSERT OR IGNORE INTO daily_seen (date, kind, key) VALUES (?, ?, ?)')
  const stmtGet = db.prepare('SELECT * FROM daily_stats WHERE date = ?')
  const stmtCostRow = db.prepare('SELECT base_usd, max_usd FROM daily_session_cost WHERE date = ? AND session_id = ?')
  const stmtCostBefore = db.prepare('SELECT max_usd FROM daily_session_cost WHERE session_id = ? AND date < ? ORDER BY date DESC LIMIT 1')
  const stmtCostInsert = db.prepare('INSERT INTO daily_session_cost (date, session_id, base_usd, max_usd) VALUES (?, ?, ?, ?)')
  const stmtCostUpdate = db.prepare('UPDATE daily_session_cost SET max_usd = ? WHERE date = ? AND session_id = ?')
  const stmtCostTotal = db.prepare('UPDATE daily_stats SET cost_usd = (SELECT COALESCE(SUM(max_usd - base_usd), 0) FROM daily_session_cost WHERE date = ?) WHERE date = ?')
  const stmtPruneSeen = db.prepare('DELETE FROM daily_seen WHERE date < ?')
  const stmtPruneCost = db.prepare('DELETE FROM daily_session_cost WHERE date < ?')

  let prunedFor = ''
  // The server's mirror of incident mode: open until this time, null = closed
  let incidentOpenUntil = null

  /** Today's date, with its row in place and old keys pruned once a day. */
  function day(t = now()) {
    const date = localDate(t)
    stmtEnsure.run(date)
    if (prunedFor !== date) {
      prunedFor = date
      const cutoff = daysBefore(date, KEEP_KEYS_DAYS)
      stmtPruneSeen.run(cutoff)
      stmtPruneCost.run(cutoff)
    }
    return date
  }

  function bump(column, t = now()) {
    stmtBump[column].run(day(t))
  }

  /** Count `column` once per (day, kind, key). */
  function bumpOnce(column, kind, key, t = now()) {
    if (!key) return
    const date = day(t)
    if (stmtSeen.run(date, kind, String(key).slice(0, 200)).changes === 1) stmtBump[column].run(date)
  }

  /**
   * What one processed hook event meant, as server/index.js read it:
   *   session    a session id that was active after the event (not SessionEnd)
   *   spawned    the office id of an agent that clocked in
   *   completed  the office id of an agent that clocked out
   *   task       `${sessionId}:${taskId}` of a completed task
   * Every key is optional; each is counted at most once per day.
   */
  function note({ session, spawned, completed, task } = {}) {
    const t = now()
    if (session) bumpOnce('sessions', 'session', session, t)
    if (spawned) bumpOnce('agents_spawned', 'spawn', spawned, t)
    if (completed) bumpOnce('agents_completed', 'complete', completed, t)
    if (task) bumpOnce('tasks_completed', 'task', task, t)
  }

  /**
   * Open, extend or close the incident mirror (see the module header).
   * @param {'declare' | 'failure' | 'deploy_fail' | 'resolved'} what
   *   declare      /incident        failure  a failed build or test run
   *   deploy_fail  a failed deploy  resolved /all-clear or a deploy that went out
   */
  function incident(what, t = now()) {
    const open = incidentOpenUntil !== null && t < incidentOpenUntil
    if (what === 'resolved') { incidentOpenUntil = null; return }
    // A failed build or test only keeps an open incident going (opening one
    // on failures is the page's 3-in-5-min rule, which the server cannot see)
    if (what === 'failure') { if (open) incidentOpenUntil = t + INCIDENT_QUIET_MS; return }
    // /incident while one is open changes nothing (src/incident.ts does the same)
    if (what === 'declare' && open) return
    if (!open) bump('incidents', t)
    incidentOpenUntil = t + INCIDENT_QUIET_MS
  }

  /**
   * One signal the office relayed (server/index.js relaySignals).
   * @param {{ kind: string, interrupted?: boolean }} signal
   */
  function signal(signal) {
    if (!signal || typeof signal.kind !== 'string') return
    const t = now()
    // Why: a run stopped with Esc failed nobody (src/incident.ts ignores it too)
    const stopped = signal.interrupted === true
    switch (signal.kind) {
      case 'deploy_success': bump('deploys', t); incident('resolved', t); break
      case 'deploy_fail':    if (!stopped) incident('deploy_fail', t); break
      case 'build_failed':   if (!stopped) { bump('builds_failed', t); incident('failure', t) } break
      case 'test_failed':    if (!stopped) { bump('tests_failed', t); incident('failure', t) } break
      case 'push_done':      bump('pushes', t); break
    }
  }

  /**
   * A status-line reading: the session's cumulative cost so far (USD).
   * @param {string} sessionId
   * @param {number} costUsd
   */
  function cost(sessionId, costUsd) {
    if (!sessionId || typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) return
    const id = String(sessionId).slice(0, 200)
    const date = day()
    const row = stmtCostRow.get(date, id)
    if (!row) {
      // What the session had cost by the last day it was seen: spent before today
      const before = stmtCostBefore.get(id, date)?.max_usd ?? 0
      stmtCostInsert.run(date, id, before, Math.max(costUsd, before))
    } else if (costUsd > row.max_usd) {
      stmtCostUpdate.run(costUsd, date, id)
    } else {
      return
    }
    stmtCostTotal.run(date, date)
  }

  /**
   * The counts for one day (zeros for a day with nothing noted).
   * @param {string} [date] YYYY-MM-DD, local; today when omitted
   * @returns {{ date: string, sessions: number, agentsSpawned: number, agentsCompleted: number,
   *   tasksCompleted: number, deploys: number, buildsFailed: number, testsFailed: number,
   *   pushes: number, incidents: number, costUsd: number }}
   */
  function get(date = localDate(now())) {
    const row = stmtGet.get(date) ?? {}
    return {
      date,
      sessions: row.sessions ?? 0,
      agentsSpawned: row.agents_spawned ?? 0,
      agentsCompleted: row.agents_completed ?? 0,
      tasksCompleted: row.tasks_completed ?? 0,
      deploys: row.deploys ?? 0,
      buildsFailed: row.builds_failed ?? 0,
      testsFailed: row.tests_failed ?? 0,
      pushes: row.pushes ?? 0,
      incidents: row.incidents ?? 0,
      costUsd: roundUsd(row.cost_usd ?? 0),
    }
  }

  return { note, signal, incident, cost, get, today: () => get(localDate(now())) }
}

// ---------------------------------------------------------------------------
// The /recap chat line
// ---------------------------------------------------------------------------

/** "1 deploy" / "3 deploys" */
function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The office manager's end-of-day line for one day's counts. Deterministic
 * (no random pick) so the chat line and its test agree.
 * @param {ReturnType<ReturnType<typeof createRecap>['get']>} s
 * @returns {string}
 */
export function recapLine(s) {
  const busy = [s.sessions, s.agentsSpawned, s.agentsCompleted, s.tasksCompleted, s.deploys,
    s.buildsFailed, s.testsFailed, s.pushes, s.incidents, s.costUsd].some(n => n > 0)
  if (!busy) return '📋 Recap: quiet day so far — nothing on the books yet. Enjoy it while it lasts.'

  const parts = [
    count(s.sessions, 'session'),
    `${count(s.agentsSpawned, 'agent')} hired, ${s.agentsCompleted} clocked out`,
    `${count(s.tasksCompleted, 'task')} closed`,
  ]
  const shipping = []
  if (s.deploys) shipping.push(count(s.deploys, 'deploy') + ' shipped')
  if (s.pushes) shipping.push(count(s.pushes, 'push', 'pushes'))
  if (shipping.length) parts.push(shipping.join(', '))
  const red = []
  if (s.buildsFailed) red.push(count(s.buildsFailed, 'failed build'))
  if (s.testsFailed) red.push(count(s.testsFailed, 'failed test run'))
  if (red.length) parts.push(red.join(', '))
  parts.push(s.incidents ? `${count(s.incidents, 'incident')} (we don't talk about ${s.incidents === 1 ? 'it' : 'them'})` : 'no incidents')

  const payroll = s.costUsd > 0 ? ` Payroll: $${s.costUsd.toFixed(2)}.` : ''
  const signOff = s.incidents ? 'Postmortem notes on my desk by 10.' : s.deploys ? 'Good shipping, everyone.' : 'Nice work, team.'
  return `📋 Recap for today: ${parts.join(' · ')}.${payroll} ${signOff}`
}
