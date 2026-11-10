/**
 * tasks.js — the task board: each session's own task list (Claude Code's
 * TaskCreate / TaskUpdate tools) as post-its on the kanban whiteboard.
 *
 * Claude Code keeps a session's task list on disk at
 * ~/.claude/tasks/<session_id>/<n>.json ($CLAUDE_CONFIG_DIR/tasks when set):
 * one file per task, { id, subject, description, activeForm, status, blocks,
 * blockedBy } with status pending | in_progress | completed, plus `owner` (a
 * string) and `metadata` (an object) once a TaskUpdate sets them; a zero-byte
 * `.lock` sits beside them. Setting a task's status to "deleted" unlinks its
 * file. A `blockedBy` entry is not cleared when the blocker completes, so a
 * task is blocked only while a task it names is still open (the page works
 * that out; the board carries blockedBy as written). Checked on a live
 * session's directory.
 *
 * Agent teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1). Per the agent-teams
 * docs (https://code.claude.com/docs/en/agent-teams, "Architecture") and the
 * 2.1.321 binary, a team is set up at session start under a session-derived
 * name, `session-` + the first 8 characters of the session id:
 *   ~/.claude/teams/<team>/config.json  { name, createdAt, leadAgentId,
 *     leadSessionId, leadProcess, members: [{ agentId, name, agentType?,
 *     joinedAt, tmuxPaneId, cwd, ... }] } — removed when the session ends
 *   ~/.claude/tasks/<team>/<n>.json     the team's shared task list, the same
 *     file format as a session's; the lead's own list is MOVED here from
 *     tasks/<session id> when the team is set up, and it stays on disk after
 * So a lead session gets a second board, keyed `team:<team>`, read the same
 * way and named after the team; it carries the members' names (nothing else
 * of the config: cwd, pane ids and agent ids stay behind). The team of a
 * session is the config whose leadSessionId names it, else the derived name
 * (a config not written yet, or already removed). Never exercised live here:
 * agent teams are off on this machine.
 *
 * The files are the truth. The hooks only make the office look sooner:
 * TaskCreated fires for the TaskCreate tool and TaskCompleted for
 * TaskUpdate { status: completed } (schema-documented, never captured live),
 * and nothing fires for pending -> in_progress, an owner change or a delete.
 * Both hooks run while the change is being made — either may veto it — so a
 * rescan answering one is followed by a debounced second look.
 *
 * Only the directories of sessions the office knows are watched: a session
 * in server/index.js's `sessions` map is watched while it is active (its
 * first event, a TaskCreated, or the poll's reconcile starts the watch; the
 * session ending stops it). Each watched directory gets fs.watch where it
 * works plus the shared poll (pollMs, default 2 s) with an mtime / size cache,
 * so an idle session costs a readdir and a few stats per poll, and a session
 * that never made a task costs one failed readdir. A change is read once the
 * writes have settled (debounceMs, ~250 ms per session) and diffed against
 * the last board; only a real change is broadcast:
 *
 *   { type: 'task_board', sessionId, boardId?, board: { sessionId, boardId?,
 *     team?: { name, members }, project?, tasks: [{ id, subject, activeForm?,
 *     status, blockedBy, owner? }], counts: { pending, in_progress,
 *     completed }, updatedAt } | null, timestamp }
 *
 * boardId (and team) only on a team's board: `team:<team name>`; a
 * session's own board is identified by its sessionId, as before.
 *
 * `board: null` means the session has no tasks (any more) or has ended.
 * updatedAt is the newest mtime of the directory and its task files, so
 * "the board that changed last" means the same thing after a restart. The
 * WS snapshot carries every non-empty board as `taskBoards`.
 *
 * The task description is longer, conversation-derived text, so it stays out
 * of the broadcasts and the snapshot; GET /tasks serves it only to a caller
 * with the office token. Subjects stay open, like an agent's task on
 * GET /agents.
 *
 *   GET /tasks?sessionId=<id> -> { dir, running, watching, lastScanAt,
 *                                [teamsDir, teams,] boards } (a session's
 *                                own board and its team's; open on
 *                                loopback, like GET /sessions)
 *
 * Mounted by server/index.js the way server/sessions.js is: the `sessions`
 * map and `broadcast` are handed in, nothing is read or watched until
 * start(), and the tests point tasksDir at a temp dir.
 */

import { readdirSync, readFileSync, statSync, watch } from 'fs'
import { join } from 'path'

export const DEFAULT_POLL_MS = 2_000
// Claude Code writes a task file in more than one syscall, and a TaskUpdate
// can touch several files; one read once the burst is over is one broadcast
export const DEFAULT_DEBOUNCE_MS = 250
export const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed'])
const STATUS_SET = new Set(TASK_STATUSES)
// A task file is well under a kilobyte; anything this big is not one
const MAX_FILE_BYTES = 64 * 1024
// A board this long is already more than the wall shows; the open tasks are kept first
export const MAX_TASKS = 200
const MAX_ID_LEN = 40
const MAX_SUBJECT_LEN = 200
const MAX_OWNER_LEN = 80
const MAX_DESCRIPTION_LEN = 4000
const MAX_BLOCKED_BY = 50
// Session ids are UUIDs; anything else never becomes a path under tasksDir
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/

/** Whether a session id may name a directory under tasksDir (no separators, no dots). */
export function isSafeSessionId(id) {
  return typeof id === 'string' && SAFE_SESSION_ID.test(id)
}

function str(val, max) {
  return typeof val === 'string' && val ? val.slice(0, max) : undefined
}

/** A list of task ids (strings, or integers as Claude Code may one day write them), clamped. */
function idList(val) {
  if (!Array.isArray(val)) return []
  const out = []
  for (const item of val) {
    const id = typeof item === 'string' ? item : Number.isInteger(item) ? String(item) : ''
    if (id) out.push(id.slice(0, MAX_ID_LEN))
    if (out.length >= MAX_BLOCKED_BY) break
  }
  return out
}

/**
 * One task file's text -> the fields the office keeps, or null when it is not
 * a task: not JSON, not an object, no id, a status outside pending |
 * in_progress | completed (a "deleted" one that has not gone yet included).
 * The description is kept here and left out of the public board.
 */
export function parseTask(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : Number.isInteger(raw.id) ? String(raw.id) : ''
  if (!id || !STATUS_SET.has(raw.status)) return null
  const task = {
    id: id.slice(0, MAX_ID_LEN),
    subject: str(raw.subject, MAX_SUBJECT_LEN) ?? '',
    status: raw.status,
    blockedBy: idList(raw.blockedBy),
  }
  const activeForm = str(raw.activeForm, MAX_SUBJECT_LEN)
  if (activeForm) task.activeForm = activeForm
  const owner = str(raw.owner, MAX_OWNER_LEN)
  if (owner) task.owner = owner
  const description = str(raw.description, MAX_DESCRIPTION_LEN)
  if (description) task.description = description
  return task
}

/** Numeric ids in numeric order ("2" before "10"), anything else after them by text. */
export function compareTaskIds(a, b) {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b) || a.localeCompare(b)
  if (na !== nb) return na ? -1 : 1
  return a.localeCompare(b)
}

/**
 * The tasks of one directory with their file times: { tasks: [{ task,
 * mtimeMs }], dirMtimeMs }. A missing directory (the session never made a
 * task) is empty. Only *.json files count — the .lock and any temp file are
 * skipped — and a file that does not parse is skipped too, unless the cache
 * holds what it said before: a file caught half-written keeps its last good
 * content for this scan and is read again next time. Two files claiming one
 * id keep the newer.
 */
function readTaskFiles(dir, cache) {
  let names
  let dirMtimeMs = 0
  try {
    names = readdirSync(dir)
    dirMtimeMs = statSync(dir).mtimeMs
  } catch {
    if (cache) cache.clear()
    return { tasks: [], dirMtimeMs: 0 }
  }
  const byId = new Map()
  const seen = new Set()
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    seen.add(name)
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue                                     // unlinked between readdir and stat
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
    const cached = cache?.get(name)
    let task
    if (cached && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size) {
      task = cached.task
    } else {
      let text = null
      try {
        text = readFileSync(path, 'utf8')
      } catch {}
      task = text === null ? null : parseTask(text)
      if (task) cache?.set(name, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, task })
      else if (cached) task = cached.task         // mid-write: keep the last good read, re-read next scan
    }
    if (!task) continue
    const prev = byId.get(task.id)
    if (!prev || st.mtimeMs > prev.mtimeMs) byId.set(task.id, { task, mtimeMs: st.mtimeMs })
  }
  if (cache) for (const name of Array.from(cache.keys())) if (!seen.has(name)) cache.delete(name)
  const tasks = Array.from(byId.values()).sort((a, b) => compareTaskIds(a.task.id, b.task.id))
  return { tasks, dirMtimeMs }
}

/**
 * The tasks of a task-list directory, sorted by id (numeric ids in numeric
 * order), skipping the .lock, non-JSON and malformed files. `cache` (a Map the
 * caller keeps between reads) avoids re-reading files whose mtime and size
 * have not changed. Each task keeps its description; see publicTask.
 */
export function readTaskDir(dir, { cache = null } = {}) {
  return readTaskFiles(dir, cache).tasks.map(entry => entry.task)
}

/** A task as the board shows it: everything but the description. */
export function publicTask(task) {
  const { description, ...rest } = task
  return rest
}

/** How many tasks per status. */
export function countTasks(tasks) {
  const counts = { pending: 0, in_progress: 0, completed: 0 }
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
  return counts
}

/** At most MAX_TASKS: the open ones first, then the newest completed, back in id order. */
function capTasks(tasks, max = MAX_TASKS) {
  if (tasks.length <= max) return tasks
  const open = tasks.filter(t => t.status !== 'completed')
  const done = tasks.filter(t => t.status === 'completed')
  const keep = new Set([...open.slice(0, max), ...done.slice(Math.max(0, done.length - Math.max(0, max - open.length)))])
  return tasks.filter(t => keep.has(t))
}

// ---------------------------------------------------------------------------
// Agent teams (see the header): the team config and the team's name
// ---------------------------------------------------------------------------

// A team config holds a handful of members; anything this big is not one
const MAX_TEAM_CONFIG_BYTES = 256 * 1024
// Members named on a board (the wall shows none of them; the tooltip a few)
const MAX_TEAM_MEMBERS = 20
const MAX_MEMBER_NAME_LEN = 40
// Claude Code's team prefix: `${Etn}-${id.slice(0, 8)}` with Etn = "session" (2.1.321 binary, BHn)
const TEAM_PREFIX = 'session-'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The key a team's board goes by (its boardId), from the team's directory name. */
export function teamKey(teamName) {
  return `team:${teamName}`
}

/**
 * The team name Claude Code derives for a session: `session-` and the first
 * 8 characters of a UUID session id; null for any other id (Claude Code
 * falls back to another scheme there, which this does not guess).
 */
export function derivedTeamName(sessionId) {
  return typeof sessionId === 'string' && UUID_RE.test(sessionId) ? `${TEAM_PREFIX}${sessionId.slice(0, 8).toLowerCase()}` : null
}

/**
 * A team's config.json text -> { leadSessionId, members: [name, ...] }, or
 * null when it is not a team config (not JSON, no leadSessionId). Only the
 * members' names are kept — the lead first, as Claude Code lists it — never
 * their cwd, pane ids, agent ids or prompts.
 */
export function parseTeamConfig(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const leadSessionId = typeof raw.leadSessionId === 'string' ? raw.leadSessionId : ''
  if (!isSafeSessionId(leadSessionId)) return null
  const members = []
  for (const m of Array.isArray(raw.members) ? raw.members : []) {
    const memberName = m && typeof m === 'object' ? str(m.name, MAX_MEMBER_NAME_LEN) : undefined
    if (memberName && !members.includes(memberName)) members.push(memberName)
    if (members.length >= MAX_TEAM_MEMBERS) break
  }
  return { leadSessionId, members }
}

/**
 * Watch the task lists of the sessions in `sessions` (server/index.js's map)
 * — each session's own list and, with `teamsDir`, its agent team's shared
 * list — and broadcast a board when it changes. `hasToken(req)` says whether
 * a GET /tasks caller holds the office token (descriptions only then). `now`
 * and `log` are injectable for tests. Returns { start, stop, reconcile,
 * track, untrack, rescan, noteEvent, scan, boards, stats, dir }, also
 * reachable as app.locals.tasks; nothing runs until start().
 */
export function mountTasks(app, {
  sessions,
  broadcast,
  tasksDir,
  teamsDir = null,
  pollMs = DEFAULT_POLL_MS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  hasToken = () => false,
  now = () => Date.now(),
  log = (...args) => console.log(...args),
} = {}) {
  if (!(sessions instanceof Map)) throw new TypeError('mountTasks needs the sessions map')
  if (typeof broadcast !== 'function') throw new TypeError('mountTasks needs broadcast')
  if (typeof tasksDir !== 'string' || !tasksDir) throw new TypeError('mountTasks needs tasksDir')

  /**
   * boardId -> { sessionId, team (null, or { name, members }), dir, cache,
   * tasks (with descriptions), board (public, null while empty), sig (what
   * the board shows as JSON, for the diff), watcher, timer (the debounce) }.
   * A session's own board is keyed by its session id, a team's by
   * `team:<team name>` (teamKey).
   * @type {Map<string, object>}
   */
  const watched = new Map()
  /** team dir name -> { mtimeMs, size, info } — config.json parses, re-read only when it changes */
  const teamConfigs = new Map()
  let timer = null
  let lastScanAt = null
  let interval = pollMs

  const isActive = id => sessions.get(id)?.state === 'active'
  const name = id => sessions.get(id)?.project ?? id
  const label = entry => (entry.team ? `team ${entry.team.name}` : name(entry.sessionId))

  /** fs.watch on one board's directory; retried from the poll while the directory does not exist yet. */
  function attachWatcher(key, entry) {
    if (entry.watcher) return
    try {
      const w = watch(entry.dir, { persistent: false }, () => schedule(key))
      w.on('error', () => {
        try { w.close() } catch {}
        if (entry.watcher === w) entry.watcher = null
      })
      entry.watcher = w
    } catch {
      entry.watcher = null
    }
  }

  // -------------------------------------------------------------------------
  // Agent teams: which team (if any) a session leads
  // -------------------------------------------------------------------------

  /**
   * Every readable team config under teamsDir: Map<leadSessionId, [{ name,
   * members }]>. One readdir per call plus a stat per team (a config is
   * parsed again only when its mtime or size changed); a missing teamsDir is
   * an empty map. A config that is not JSON, names no lead session or sits
   * in a directory whose name is not safe as a path is skipped.
   */
  function readTeams() {
    const byLead = new Map()
    if (!teamsDir) return byLead
    let names
    try {
      names = readdirSync(teamsDir)
    } catch {
      teamConfigs.clear()
      return byLead
    }
    const seen = new Set()
    for (const dirName of names) {
      if (!isSafeSessionId(dirName)) continue
      const path = join(teamsDir, dirName, 'config.json')
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (!st.isFile() || st.size > MAX_TEAM_CONFIG_BYTES) continue
      seen.add(dirName)
      let cached = teamConfigs.get(dirName)
      if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
        let info = null
        try {
          info = parseTeamConfig(readFileSync(path, 'utf8'))
        } catch {}
        // Why: a config caught mid-write keeps what it said before, as a task file does
        if (!info && cached?.info) info = cached.info
        cached = { mtimeMs: st.mtimeMs, size: st.size, info }
        teamConfigs.set(dirName, cached)
      }
      const info = cached.info
      if (!info) continue
      const list = byLead.get(info.leadSessionId) ?? []
      list.push({ name: dirName, members: info.members })
      byLead.set(info.leadSessionId, list)
    }
    for (const dirName of Array.from(teamConfigs.keys())) if (!seen.has(dirName)) teamConfigs.delete(dirName)
    return byLead
  }

  /**
   * The teams session `id` leads: the configs naming it, else the name
   * Claude Code derives for it (`session-` + 8 characters of a UUID), so a
   * team list whose config is not written yet — or was already removed — is
   * still read. Without teamsDir, none.
   */
  function teamsOf(id, byLead) {
    if (!teamsDir) return []
    const found = byLead.get(id) ?? []
    const derived = derivedTeamName(id)
    if (derived && !found.some(t => t.name === derived)) found.push({ name: derived, members: [] })
    return found
  }

  // -------------------------------------------------------------------------
  // Reading a board
  // -------------------------------------------------------------------------

  /** Read one board's directory and broadcast it if it changed. Returns whether it did. */
  function scan(key, t = now()) {
    const entry = watched.get(key)
    if (!entry) return false
    lastScanAt = t
    const { tasks: files, dirMtimeMs } = readTaskFiles(entry.dir, entry.cache)
    const tasks = files.map(f => f.task)
    entry.tasks = tasks
    const shown = capTasks(tasks).map(publicTask)
    // A team's member list is on the board too, so a teammate joining is a change
    const sig = JSON.stringify(entry.team ? [shown, entry.team.members] : shown)
    if (sig === entry.sig) return false
    const hadBoard = entry.board !== null
    entry.sig = sig
    const project = sessions.get(entry.sessionId)?.project
    entry.board = shown.length
      ? {
          sessionId: entry.sessionId,
          ...(entry.team ? { boardId: key, team: { name: entry.team.name, members: entry.team.members } } : {}),
          ...(project ? { project } : {}),
          tasks: shown,
          counts: countTasks(tasks),
          updatedAt: Math.max(dirMtimeMs, ...files.map(f => f.mtimeMs)) || t,
        }
      : null
    if (!entry.board && !hadBoard) return false
    const c = entry.board?.counts
    log(`[tasks] ${label(entry)}: ${c ? `${c.pending} to do, ${c.in_progress} in progress, ${c.completed} done` : 'no tasks'}`)
    broadcast({ type: 'task_board', sessionId: entry.sessionId, ...(entry.team ? { boardId: key } : {}), board: entry.board, timestamp: t })
    return true
  }

  function safeScan(key) {
    try {
      scan(key)
    } catch (err) {
      console.warn(`[tasks] scan of ${key} failed:`, err.message)
    }
  }

  /** Read a board's directory once its writes have settled. */
  function schedule(key) {
    const entry = watched.get(key)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (watched.get(key) === entry) safeScan(key)
    }, debounceMs)
    entry.timer.unref?.()
  }

  function newEntry(sessionId, dir, team = null) {
    return { sessionId, team, dir, cache: new Map(), tasks: [], board: null, sig: '[]', watcher: null, timer: null }
  }

  /** Stop watching one board; its board goes (`why` for the log). */
  function drop(key, why) {
    const entry = watched.get(key)
    if (!entry) return false
    watched.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.watcher) {
      try { entry.watcher.close() } catch {}
    }
    if (entry.board) {
      log(`[tasks] ${label(entry)}: board taken down (${why})`)
      broadcast({ type: 'task_board', sessionId: entry.sessionId, ...(entry.team ? { boardId: key } : {}), board: null, timestamp: now() })
    }
    return true
  }

  /**
   * Keep session `id`'s team boards in step with the team configs: a team it
   * leads is watched (and read at once), one it no longer leads is dropped,
   * and a member list that changed is read again. `byLead` is readTeams().
   */
  function syncTeams(id, byLead) {
    const wanted = new Map(teamsOf(id, byLead).map(t => [teamKey(t.name), t]))
    for (const [key, entry] of Array.from(watched)) {
      if (entry.team && entry.sessionId === id && !wanted.has(key)) drop(key, 'no longer this session\'s team')
    }
    for (const [key, team] of wanted) {
      const entry = watched.get(key)
      if (!entry) {
        watched.set(key, newEntry(id, join(tasksDir, team.name), { name: team.name, members: team.members }))
        attachWatcher(key, watched.get(key))
        safeScan(key)
      } else if (entry.sessionId === id && JSON.stringify(entry.team.members) !== JSON.stringify(team.members) && team.members.length) {
        // Why: the derived fallback carries no members; a config that is gone
        // for a moment does not wipe the names the board already shows
        entry.team = { name: team.name, members: team.members }
        safeScan(key)
      }
    }
  }

  /**
   * Start watching a session's task list (an active session the office knows,
   * with an id that is safe as a directory name) and its team's, and read
   * them at once. Returns whether it is watched now.
   */
  function track(id, byLead = null) {
    if (timer === null || !isSafeSessionId(id) || !isActive(id)) return false
    if (!watched.has(id)) {
      const entry = newEntry(id, join(tasksDir, id))
      watched.set(id, entry)
      attachWatcher(id, entry)
      safeScan(id)
    }
    syncTeams(id, byLead ?? readTeams())
    return true
  }

  /** Stop watching a session (it ended, or the office forgot it): its board and its team's go. */
  function untrack(id) {
    let any = false
    for (const [key, entry] of Array.from(watched)) {
      if (entry.sessionId === id) any = drop(key, 'session ended') || any
    }
    return any
  }

  /** A TaskCreated / TaskCompleted / TeammateIdle: look now, and once more after the write the hook ran ahead of. */
  function rescan(id) {
    if (!track(id)) return false
    for (const [key, entry] of watched) {
      if (entry.sessionId !== id) continue
      safeScan(key)
      schedule(key)
    }
    return true
  }

  /** Keep the watched set in step with the sessions map: active sessions in, ended or forgotten ones out. */
  function reconcile() {
    const byLead = readTeams()
    for (const [id, session] of sessions) if (session?.state === 'active') track(id, byLead)
    for (const entry of Array.from(watched.values())) if (!isActive(entry.sessionId)) untrack(entry.sessionId)
  }

  /**
   * After POST /event processed a hook event: the session's first event
   * starts the watch, its end stops it, a task event or a teammate going
   * idle rescans. Cheap for every other event (a map lookup).
   */
  function noteEvent(body) {
    const id = body?.sessionId
    if (timer === null || !id) return
    try {
      if (body.type === 'session_ended') untrack(id)
      else if (body.type === 'task_created' || body.type === 'task_completed' || body.type === 'teammate_idle') rescan(id)
      else if (!watched.has(id)) track(id)
    } catch (err) {
      console.warn('[tasks] could not follow an event:', err.message)
    }
  }

  function tick() {
    reconcile()
    for (const [key, entry] of watched) {
      attachWatcher(key, entry)
      safeScan(key)
    }
  }

  function start({ pollMs: ms = pollMs } = {}) {
    if (timer) return api
    interval = ms
    log(`[tasks] watching task lists under ${tasksDir}${teamsDir ? ` and agent teams under ${teamsDir}` : ''} (poll every ${ms} ms)`)
    timer = setInterval(() => {
      try {
        tick()
      } catch (err) {
        console.warn('[tasks] poll failed:', err.message)
      }
    }, ms)
    timer.unref?.()
    reconcile()
    return api
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    for (const entry of watched.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.watcher) {
        try { entry.watcher.close() } catch {}
      }
    }
    watched.clear()
    teamConfigs.clear()
  }

  /** Every non-empty board, the most recently changed first (the WS snapshot's `taskBoards`). */
  function boards() {
    return Array.from(watched.values())
      .map(entry => entry.board)
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The session ids watched (a session's own board; its team board rides along). */
  function sessionIds() {
    return Array.from(watched.values()).filter(e => !e.team).map(e => e.sessionId)
  }

  function stats() {
    return {
      dir: tasksDir,
      running: timer !== null,
      watching: sessionIds().length,
      lastScanAt,
      ...(teamsDir ? { teamsDir, teams: watched.size - sessionIds().length } : {}),
    }
  }

  app.get('/tasks', (req, res) => {
    // The route stays open; a missing or wrong token only means no descriptions
    const withText = hasToken(req)
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
    const out = []
    for (const entry of watched.values()) {
      if (sessionId && entry.sessionId !== sessionId) continue
      if (!entry.board) continue
      if (!withText) {
        out.push(entry.board)
        continue
      }
      const full = new Map(entry.tasks.map(t => [t.id, t]))
      out.push({ ...entry.board, tasks: entry.board.tasks.map(t => (full.get(t.id)?.description ? { ...t, description: full.get(t.id).description } : t)) })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    res.json({ ...stats(), boards: out })
  })

  const api = {
    start, stop, reconcile, track, untrack, rescan, noteEvent, scan, boards, stats,
    dir: tasksDir,
    teamsDir,
    get running() { return timer !== null },
    get pollMs() { return interval },
    get watching() { return sessionIds() },
    /** The team boards watched (`team:<name>` keys) */
    get teams() { return Array.from(watched.keys()).filter(key => watched.get(key).team) },
  }
  app.locals.tasks = api
  return api
}
