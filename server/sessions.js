/**
 * sessions.js — the registry roster: Claude Code sessions the office can see
 * before (or without) the hooks being installed, so a session strip answers
 * "why don't I see my session?" on screen.
 *
 * Claude Code keeps a live registry of its running CLI processes at
 * ~/.claude/sessions/<pid>.json ($CLAUDE_CONFIG_DIR/sessions when set): one
 * file per process, written on start, rewritten on every status change and
 * deleted on a clean exit, with a <pid>.<hash>.key file next to it. Observed
 * on 2.1.300: { pid, sessionId, cwd, startedAt (epoch ms), procStart, version,
 * peerProtocol, peerFeatures[], kind, entrypoint, pidDomain,
 * messagingSocketPath, name, nameSource, nameSince, updatedAt, status,
 * statusUpdatedAt } with kind in interactive | bg | daemon | daemon-worker and
 * status in busy | shell | idle | waiting. `name` is basename(cwd) plus two
 * hex digits of the id ("claude-office-75", nameSource "derived") unless the
 * session was named (--name, /rename: nameSource "user"). Headless `claude -p`
 * runs register too (kind "interactive", status "busy" for the whole run, idle
 * for a moment before the file goes). A crash leaves the files behind, so an
 * entry only counts while its pid answers process.kill(pid, 0) (EPERM = alive
 * but not ours, which is alive) AND that pid is still the process that wrote
 * the file: after a reboot or a pid wrap a leftover <pid>.json can name a pid
 * some other program now holds, and Claude Code itself never cleans such a
 * file up (it deletes leftovers only when the pid is dead). So, the way
 * Claude Code checks its own entries, the process's start time is compared
 * with the one the file recorded (processStart below): `procStart` is field
 * 22 of /proc/<pid>/stat on Linux (clock ticks since boot) and the output of
 * `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` on macOS, compared as written; a
 * file without one (an older Claude Code) is checked by `startedAt` instead —
 * the process cannot have started after the file says its session began (the
 * start in epoch ms is the boot time plus the ticks, or the parsed lstart). On
 * a platform where neither can be read (Windows) the pid check stands alone.
 * `claude agents --json` prints the same registry but takes about a second
 * per call; the directory is read instead.
 *
 * The module watches that directory — fs.watch where it works, plus a poll
 * (fs.watch is unreliable on macOS for some writers) with mtime/size change
 * detection, so a 50-file registry costs a readdir and a few stats every
 * pollMs — and joins the entries to the office's `sessions` map by session
 * id, the id every hook payload carries (the join is by id, never by pid):
 *
 *   - a live entry no hooked session claims becomes an UNHOOKED session
 *     record ({ hooked: false, registry, main from the registry status }) and
 *     is announced with session_started { hooked: false }; a status or name
 *     change is a session_registry broadcast; the file going (or the pid
 *     dying) ends it (session_ended { hooked: false })
 *   - a live entry for a HOOKED session is attached as `registry` ({ pid,
 *     name, nameSource, status, kind, version, startedAt, statusUpdatedAt })
 *     and announced with session_registry, nothing more: the hooks are the
 *     truth for its main state and the registry never overwrites it (save the
 *     closed dialog below); losing the entry just drops `registry`
 *   - the first hook event from an unhooked session flips it to hooked with
 *     the same id (server/index.js, touchSession / session_started)
 *   - a status change of an attached entry is also reported to
 *     `onStatusChange(session, before, after, entry, t)` (after and entry are
 *     undefined when the entry went). server/index.js uses the one transition
 *     the hooks cannot see: "waiting" -> anything else means the permission
 *     dialog on screen was answered or dismissed in the terminal (an Esc fires
 *     no hook at all), so the office card for it is released and the hand
 *     comes down — the only thing the registry ever changes on a hooked session
 *
 * Presence and status only, by design: what a session is doing stays
 * hook-only (no transcript tailing). Registry status -> main.state is
 * REGISTRY_STATES: busy and shell are a running turn (working), idle is idle,
 * waiting is needs-you with needsYou { kind: 'registry', summary: 'waiting in
 * the terminal' } — Claude Code sets "waiting" while a permission dialog or a
 * question is on screen (checked live, see the PR that added this).
 *
 * Own bot. The chat watcher (scripts/chat-ai-watcher.sh) runs `claude -p` for
 * every reply; those register too, for a few seconds each, and would flicker
 * through the strip as unhooked sessions. `claude -p` takes `--name <display
 * name>`, which lands in the registry as name with nameSource "user" even
 * under --safe-mode and --no-session-persistence (checked live), so the
 * watcher names its calls BOT_SESSION_NAME and the roster skips entries with
 * that name. Chosen over a pid file because it needs no shared state between
 * the two processes and survives a watcher restart.
 *
 * Mounted by server/index.js the way server/status.js is: the `sessions`
 * map and the lifecycle helpers are handed in rather than imported, so this
 * module never pulls in index.js, and the watcher only starts with the
 * server (start()), never on import — the tests point registryDir at a temp
 * dir and drive scan() themselves.
 *
 *   GET /registry  -> { dir, watching, lastScanAt, count, entries: [{ sessionId,
 *                       pid, name, status, kind, hooked }] }  (open, like GET /sessions)
 */

import { execFileSync } from 'child_process'
import { readdirSync, readFileSync, statSync, watch } from 'fs'
import { basename, join } from 'path'

/** The display name the chat watcher gives its `claude -p` calls; such entries are not sessions of yours. */
export const BOT_SESSION_NAME = 'agent-office-bot'
export const DEFAULT_POLL_MS = 2_000
// fs.watch fires once per write syscall; one scan shortly after the burst is enough
const WATCH_DEBOUNCE_MS = 100
// A registry file is a few hundred bytes; anything bigger is not one
const MAX_FILE_BYTES = 64 * 1024
const MAX_STRING_LEN = 200

/** Registry status -> the session's main.state (see the module header). */
export const REGISTRY_STATES = Object.freeze({
  busy: 'working',
  shell: 'working',
  idle: 'idle',
  waiting: 'needs-you',
})

/** What an unhooked session is waiting on when the registry says "waiting". */
export const REGISTRY_WAIT_SUMMARY = 'waiting in the terminal'

/** Whether a pid is a running process (EPERM: alive, somebody else's — still alive). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

// Clock ticks per second of /proc/<pid>/stat's start time. Claude Code
// assumes 100 (USER_HZ on every mainstream Linux) when it does the same sum.
const CLOCK_TICKS_PER_S = 100
// A start time read back may sit up to a second before the real one (btime
// and lstart are whole seconds); a file's startedAt is written after the
// process started. Past this margin the process started after its file: the
// pid was reused.
const START_SLACK_MS = 5_000
// How long one reading of a pid's start time is trusted (see readRegistry)
const START_CACHE_MS = 30_000

let bootTimeS
/** The boot time from /proc/stat (constant for as long as this process lives), or null. */
function linuxBootTime() {
  if (bootTimeS === undefined) {
    try {
      const m = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))
      bootTimeS = m ? Number(m[1]) : null
    } catch {
      bootTimeS = null
    }
  }
  return bootTimeS
}

/**
 * When a process started, the way Claude Code records it in its registry
 * file (see the module header): `procStart`, the raw value it writes, and
 * `startMs`, the same instant in epoch ms. null when the platform does not say
 * (Windows, a pid that is gone, /proc or ps unavailable).
 */
export function processStart(pid, { platform = process.platform } = {}) {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // The command name in field 2 may hold spaces and parentheses: count from the last ')'
      const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (!/^\d+$/.test(ticks ?? '')) return null
      const boot = linuxBootTime()
      return { procStart: ticks, startMs: boot === null ? null : boot * 1000 + (Number(ticks) / CLOCK_TICKS_PER_S) * 1000 }
    }
    if (platform === 'darwin') {
      const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }).trim()
      if (!lstart) return null
      const startMs = Date.parse(`${lstart} UTC`)
      return { procStart: lstart, startMs: Number.isFinite(startMs) ? startMs : null }
    }
  } catch {
    // Gone between the liveness check and here, or nothing to read
  }
  return null
}

/** Whitespace-insensitive form of a procStart (lstart pads one-digit days). */
const startKey = value => String(value).trim().split(/\s+/).join(' ')

/**
 * Whether the live process `start` (processStart's reading, or null) is the
 * one that wrote `entry`: its procStart when the file has one, else its
 * startedAt (see the module header). Can't tell is yes.
 */
export function sameProcess(entry, start) {
  if (!start) return true
  if (entry.procStart !== undefined && start.procStart !== undefined && start.procStart !== null) {
    return startKey(entry.procStart) === startKey(start.procStart)
  }
  if (typeof entry.startedAt === 'number' && typeof start.startMs === 'number') {
    return start.startMs <= entry.startedAt + START_SLACK_MS
  }
  return true
}

/** The chat watcher's own `claude -p` call (see the module header). */
export function isBotSession(entry) {
  return entry?.name === BOT_SESSION_NAME
}

/**
 * The fields of one registry file the office keeps, or null when the text is
 * not a registry entry: not JSON, not an object, no positive integer pid, no
 * session id. Strings are clamped like every other input.
 */
export function parseRegistryEntry(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) return null
  const str = (val, max = MAX_STRING_LEN) => (typeof val === 'string' && val ? val.slice(0, max) : undefined)
  const num = val => (typeof val === 'number' && Number.isFinite(val) ? val : undefined)
  const entry = { pid: raw.pid, sessionId: raw.sessionId.slice(0, 80) }
  const cwd = str(raw.cwd, 400)
  if (cwd) entry.cwd = cwd
  for (const [key, max] of [['name', MAX_STRING_LEN], ['nameSource', 40], ['kind', 40], ['status', 40], ['version', 40], ['entrypoint', 40]]) {
    const val = str(raw[key], max)
    if (val) entry[key] = val
  }
  for (const key of ['startedAt', 'updatedAt', 'statusUpdatedAt']) {
    const val = num(raw[key])
    if (val !== undefined) entry[key] = val
  }
  // What the liveness check compares (sameProcess); procStartFt is the form
  // Claude Code writes on Windows, and it reads that one first as well
  const procStart = str(raw.procStartFt, 64) ?? str(raw.procStart, 64)
  if (procStart) entry.procStart = procStart
  return entry
}

/**
 * The live entries of a registry directory, oldest first, one per session id
 * (two live files naming the same session keep the newer start). Missing
 * directory (Claude Code has never run), .key files, non-JSON, non-entries,
 * dead pids and pids now held by another process (`startOf`, processStart by
 * default, and sameProcess) are skipped. `cache` (a Map the caller keeps
 * between scans) avoids re-reading files whose mtime and size have not
 * changed; liveness is re-checked every scan regardless, a crash leaves the
 * file as it was. The start time of a live pid is read again at most every
 * START_CACHE_MS per file (on macOS each reading forks `ps`), and at once
 * after the pid was seen dead or the file changed.
 */
export function readRegistry(dir, { alive = pidAlive, cache = null, startOf = processStart } = {}) {
  const t = Date.now()
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const bySession = new Map()
  const seen = new Set()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    seen.add(name)
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue                                     // deleted between readdir and stat
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
    let entry
    let cached = cache?.get(name)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size) {
      entry = cached.entry
    } else {
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      entry = parseRegistryEntry(text)
      cached = { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, entry }
      cache?.set(name, cached)
    }
    if (!entry) continue
    if (!alive(entry.pid)) {
      // A dead pid's next owner is a different process: read its start afresh
      if (cached) delete cached.start
      continue
    }
    let start = cached?.start
    if (!start || t - start.at >= START_CACHE_MS) {
      start = { at: t, value: startOf(entry.pid) }
      if (cached) cached.start = start
    }
    if (!sameProcess(entry, start.value)) continue
    const prev = bySession.get(entry.sessionId)
    if (!prev || (entry.startedAt ?? 0) > (prev.startedAt ?? 0)) bySession.set(entry.sessionId, entry)
  }
  if (cache) for (const name of Array.from(cache.keys())) if (!seen.has(name)) cache.delete(name)
  return Array.from(bySession.values()).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
}

/** The part of an entry that travels on a session record as `registry`. */
export function registryInfo(entry) {
  const info = { pid: entry.pid }
  for (const key of ['name', 'nameSource', 'status', 'kind', 'version', 'startedAt', 'statusUpdatedAt']) {
    if (entry[key] !== undefined) info[key] = entry[key]
  }
  return info
}

/** An unhooked session's main record, from the registry status alone. */
export function mainFromRegistry(entry, now = Date.now()) {
  const state = REGISTRY_STATES[entry.status] ?? 'idle'
  const since = entry.statusUpdatedAt ?? entry.updatedAt ?? now
  const main = { state, since, waitingOn: 0 }
  if (state === 'needs-you') main.needsYou = { kind: 'registry', summary: REGISTRY_WAIT_SUMMARY, since }
  return main
}

/** Last path segment of a cwd, as server/index.js names a hooked session's project. */
function projectOf(cwd) {
  if (!cwd) return undefined
  return basename(cwd.replace(/\/+$/, '')) || cwd
}

/**
 * Registry entry -> an unhooked session record in the shape of server/index.js's
 * sessions (hooked: false, source 'registry', no agents, main from the status).
 */
export function registryToSession(entry, now = Date.now()) {
  const session = {
    id: entry.sessionId,
    hooked: false,
    project: projectOf(entry.cwd),
    source: 'registry',
    state: 'active',
    startedAt: entry.startedAt ?? now,
    lastActivityAt: entry.updatedAt ?? entry.startedAt ?? now,
    agentIds: new Set(),
    registry: registryInfo(entry),
    main: mainFromRegistry(entry, now),
  }
  if (entry.cwd) session.cwd = entry.cwd
  return session
}

/**
 * Watch `registryDir` and keep `sessions` (server/index.js's map) in step with
 * it. Handed in from index.js: `broadcast`, `toEvent(session, type)` (its
 * sessionEvent), `endSession(session, reason, now)` and `forgetSession(id)`,
 * so an unhooked session ends, lingers and is forgotten exactly like a hooked
 * one. `isOwnSession(entry)` skips the office's own bot. `onStatusChange`
 * hears every status change of an entry attached to an active session (see
 * the module header). `alive`, `startOf` and `now` are injectable for tests.
 * Returns { start, stop, scan, stats, dir }, also reachable as
 * app.locals.registry; nothing runs until start().
 */
export function mountRegistry(app, {
  sessions,
  broadcast,
  registryDir,
  pollMs = DEFAULT_POLL_MS,
  isOwnSession = isBotSession,
  toEvent,
  endSession,
  forgetSession,
  onStatusChange = () => {},
  alive = pidAlive,
  startOf = processStart,
  now = () => Date.now(),
  log = (...args) => console.log(...args),
} = {}) {
  if (!(sessions instanceof Map)) throw new TypeError('mountRegistry needs the sessions map')
  for (const [name, fn] of Object.entries({ broadcast, toEvent, endSession, forgetSession })) {
    if (typeof fn !== 'function') throw new TypeError(`mountRegistry needs ${name}`)
  }
  if (typeof registryDir !== 'string' || !registryDir) throw new TypeError('mountRegistry needs registryDir')

  /** @type {Map<string, object>} file name -> { mtimeMs, ctimeMs, size, entry } */
  const cache = new Map()
  /** @type {Map<string, object>} sessionId -> the live entry as of the last scan (own bot excluded) */
  const known = new Map()
  let timer = null
  let watcher = null
  let debounce = null
  let lastScanAt = null

  const label = entry => `${entry.name ?? entry.sessionId} (pid ${entry.pid})`
  const sameInfo = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

  /** A live entry nobody has hooks for: a new unhooked session. */
  function arrive(entry, t) {
    const session = registryToSession(entry, t)
    sessions.set(session.id, session)
    log(`[registry] + ${label(entry)}: ${entry.status ?? '?'} -> ${session.main.state}, not hooked`)
    broadcast(toEvent(session, 'session_started'))
  }

  /**
   * One pass over the directory, diffed against the last one. Synchronous,
   * so a scan never interleaves with a hook event.
   */
  function scan(t = now()) {
    lastScanAt = t
    const entries = readRegistry(registryDir, { alive, cache, startOf })
    const seen = new Set()

    for (const entry of entries) {
      if (isOwnSession(entry)) continue
      const id = entry.sessionId
      seen.add(id)
      const prev = known.get(id)
      known.set(id, entry)
      const session = sessions.get(id)
      if (!session) {
        arrive(entry, t)
        continue
      }
      if (session.state === 'ended') {
        // A hooked session whose SessionEnd fired before its file went: nothing
        // to do, the file follows. An unhooked one that ended (file gone) and is
        // back under the same id with a new pid (a quick --resume): start over.
        if (session.hooked === false && prev?.pid !== entry.pid) {
          forgetSession(id)
          arrive(entry, t)
        }
        continue
      }
      const info = registryInfo(entry)
      if (sameInfo(session.registry, info)) continue
      const before = session.registry?.status
      session.registry = info
      if (session.hooked === false) {
        // Only an unhooked session takes its state from the registry
        session.main = mainFromRegistry(entry, t)
        session.lastActivityAt = entry.updatedAt ?? t
        if (!session.cwd && entry.cwd) {
          session.cwd = entry.cwd
          session.project = session.project ?? projectOf(entry.cwd)
        }
        log(`[registry] ${label(entry)}: ${before ?? '?'} -> ${entry.status ?? '?'} (${session.main.state})`)
      } else {
        log(`[registry] ${label(entry)}: ${before ? `${before} -> ${entry.status ?? '?'}` : 'attached to the hooked session'}`)
      }
      broadcast(toEvent(session, 'session_registry'))
      if (before && before !== entry.status) onStatusChange(session, before, entry.status, entry, t)
    }

    for (const [id, prev] of Array.from(known)) {
      if (seen.has(id)) continue
      known.delete(id)
      const session = sessions.get(id)
      if (!session) continue
      if (session.hooked === false) {
        if (session.state === 'ended') continue
        log(`[registry] - ${label(prev)}: gone`)
        endSession(session, 'exited', t)
        broadcast(toEvent(session, 'session_ended'))
      } else if (session.registry) {
        // The hooks keep reporting this session; it just lost its registry entry
        const before = session.registry.status
        delete session.registry
        log(`[registry] - ${label(prev)}: gone (hooked session stays)`)
        if (session.state === 'active') {
          broadcast(toEvent(session, 'session_registry'))
          if (before) onStatusChange(session, before, undefined, undefined, t)
        }
      }
    }
  }

  function safeScan() {
    try {
      scan()
    } catch (err) {
      console.warn('[registry] scan failed:', err.message)
    }
  }

  function schedule() {
    if (debounce) return
    debounce = setTimeout(() => {
      debounce = null
      safeScan()
    }, WATCH_DEBOUNCE_MS)
    debounce.unref?.()
  }

  /** fs.watch on the directory; retried from the poll while the directory does not exist yet. */
  function attachWatcher() {
    if (watcher) return
    try {
      const w = watch(registryDir, { persistent: false }, schedule)
      w.on('error', () => {
        try { w.close() } catch {}
        if (watcher === w) watcher = null
      })
      watcher = w
    } catch {
      watcher = null
    }
  }

  function start({ pollMs: ms = pollMs } = {}) {
    if (timer) return api
    log(`[registry] watching ${registryDir} (poll every ${ms} ms)`)
    safeScan()
    attachWatcher()
    timer = setInterval(() => {
      attachWatcher()
      safeScan()
    }, ms)
    timer.unref?.()
    return api
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    if (debounce) clearTimeout(debounce)
    debounce = null
    if (watcher) {
      try { watcher.close() } catch {}
      watcher = null
    }
  }

  function stats() {
    return { dir: registryDir, watching: timer !== null, count: known.size, lastScanAt }
  }

  app.get('/registry', (_req, res) => {
    const entries = Array.from(known.values()).map(entry => ({
      sessionId: entry.sessionId,
      pid: entry.pid,
      name: entry.name,
      status: entry.status,
      kind: entry.kind,
      hooked: sessions.get(entry.sessionId)?.hooked !== false,
    }))
    res.json({ ...stats(), entries })
  })

  const api = { start, stop, scan, stats, dir: registryDir, get running() { return timer !== null } }
  app.locals.registry = api
  return api
}
