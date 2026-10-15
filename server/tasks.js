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
 * session's directory; team task lists (~/.claude/tasks/session-xxxx,
 * ~/.claude/teams) are not read: agent teams could not be exercised here.
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
 *   { type: 'task_board', sessionId, board: { sessionId, project?, tasks:
 *     [{ id, subject, activeForm?, status, blockedBy, owner? }], counts:
 *     { pending, in_progress, completed }, updatedAt } | null, timestamp }
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
 *   GET /tasks?sessionId=<id> -> { dir, running, watching, lastScanAt, boards }
 *                                (open on loopback, like GET /sessions)
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

/**
 * Watch the task lists of the sessions in `sessions` (server/index.js's map)
 * and broadcast each session's board when it changes. `hasToken(req)` says
 * whether a GET /tasks caller holds the office token (descriptions only
 * then). `now` and `log` are injectable for tests. Returns { start, stop,
 * reconcile, track, untrack, rescan, noteEvent, scan, boards, stats, dir },
 * also reachable as app.locals.tasks; nothing runs until start().
 */
export function mountTasks(app, {
  sessions,
  broadcast,
  tasksDir,
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
   * sessionId -> { dir, cache, tasks (with descriptions), board (public, null
   * while empty), sig (the board's tasks as JSON, for the diff), watcher,
   * timer (the debounce) }
   * @type {Map<string, object>}
   */
  const watched = new Map()
  let timer = null
  let lastScanAt = null
  let interval = pollMs

  const isActive = id => sessions.get(id)?.state === 'active'
  const name = id => sessions.get(id)?.project ?? id

  /** fs.watch on one session's directory; retried from the poll while the directory does not exist yet. */
  function attachWatcher(id, entry) {
    if (entry.watcher) return
    try {
      const w = watch(entry.dir, { persistent: false }, () => schedule(id))
      w.on('error', () => {
        try { w.close() } catch {}
        if (entry.watcher === w) entry.watcher = null
      })
      entry.watcher = w
    } catch {
      entry.watcher = null
    }
  }

  /** Read one session's directory and broadcast its board if it changed. Returns whether it did. */
  function scan(id, t = now()) {
    const entry = watched.get(id)
    if (!entry) return false
    lastScanAt = t
    const { tasks: files, dirMtimeMs } = readTaskFiles(entry.dir, entry.cache)
    const tasks = files.map(f => f.task)
    entry.tasks = tasks
    const shown = capTasks(tasks).map(publicTask)
    const sig = JSON.stringify(shown)
    if (sig === entry.sig) return false
    const hadBoard = entry.board !== null
    entry.sig = sig
    entry.board = shown.length
      ? {
          sessionId: id,
          ...(sessions.get(id)?.project ? { project: sessions.get(id).project } : {}),
          tasks: shown,
          counts: countTasks(tasks),
          updatedAt: Math.max(dirMtimeMs, ...files.map(f => f.mtimeMs)) || t,
        }
      : null
    if (!entry.board && !hadBoard) return false
    const c = entry.board?.counts
    log(`[tasks] ${name(id)}: ${c ? `${c.pending} to do, ${c.in_progress} in progress, ${c.completed} done` : 'no tasks'}`)
    broadcast({ type: 'task_board', sessionId: id, board: entry.board, timestamp: t })
    return true
  }

  function safeScan(id) {
    try {
      scan(id)
    } catch (err) {
      console.warn(`[tasks] scan of ${id} failed:`, err.message)
    }
  }

  /** Read a session's directory once its writes have settled. */
  function schedule(id) {
    const entry = watched.get(id)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (watched.get(id) === entry) safeScan(id)
    }, debounceMs)
    entry.timer.unref?.()
  }

  /**
   * Start watching a session's task list (an active session the office knows,
   * with an id that is safe as a directory name) and read it at once. Returns
   * whether it is watched now.
   */
  function track(id) {
    if (timer === null || !isSafeSessionId(id) || !isActive(id)) return false
    if (watched.has(id)) return true
    const entry = { dir: join(tasksDir, id), cache: new Map(), tasks: [], board: null, sig: '[]', watcher: null, timer: null }
    watched.set(id, entry)
    attachWatcher(id, entry)
    safeScan(id)
    return true
  }

  /** Stop watching a session (it ended, or the office forgot it); its board goes. */
  function untrack(id) {
    const entry = watched.get(id)
    if (!entry) return false
    watched.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.watcher) {
      try { entry.watcher.close() } catch {}
    }
    if (entry.board) {
      log(`[tasks] ${name(id)}: board taken down (session ended)`)
      broadcast({ type: 'task_board', sessionId: id, board: null, timestamp: now() })
    }
    return true
  }

  /** A TaskCreated / TaskCompleted: look now, and once more after the write the hook ran ahead of. */
  function rescan(id) {
    if (!track(id)) return false
    safeScan(id)
    schedule(id)
    return true
  }

  /** Keep the watched set in step with the sessions map: active sessions in, ended or forgotten ones out. */
  function reconcile() {
    for (const [id, session] of sessions) if (session?.state === 'active') track(id)
    for (const id of Array.from(watched.keys())) if (!isActive(id)) untrack(id)
  }

  /**
   * After POST /event processed a hook event: the session's first event
   * starts the watch, its end stops it, a task event rescans. Cheap for
   * every other event (a map lookup).
   */
  function noteEvent(body) {
    const id = body?.sessionId
    if (timer === null || !id) return
    try {
      if (body.type === 'session_ended') untrack(id)
      else if (body.type === 'task_created' || body.type === 'task_completed') rescan(id)
      else if (!watched.has(id)) track(id)
    } catch (err) {
      console.warn('[tasks] could not follow an event:', err.message)
    }
  }

  function tick() {
    reconcile()
    for (const [id, entry] of watched) {
      attachWatcher(id, entry)
      safeScan(id)
    }
  }

  function start({ pollMs: ms = pollMs } = {}) {
    if (timer) return api
    interval = ms
    log(`[tasks] watching task lists under ${tasksDir} (poll every ${ms} ms)`)
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
  }

  /** Every non-empty board, the most recently changed first (the WS snapshot's `taskBoards`). */
  function boards() {
    return Array.from(watched.values())
      .map(entry => entry.board)
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function stats() {
    return { dir: tasksDir, running: timer !== null, watching: watched.size, lastScanAt }
  }

  app.get('/tasks', (req, res) => {
    // The route stays open; a missing or wrong token only means no descriptions
    const withText = hasToken(req)
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
    const list = sessionId ? (watched.has(sessionId) ? [sessionId] : []) : Array.from(watched.keys())
    const out = []
    for (const id of list) {
      const entry = watched.get(id)
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
    get running() { return timer !== null },
    get pollMs() { return interval },
    get watching() { return Array.from(watched.keys()) },
  }
  app.locals.tasks = api
  return api
}
