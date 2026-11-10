/**
 * permission-notify.js — one OS notification when a permission wait starts.
 *
 * When a PermissionRequest becomes a pending permission the office could
 * answer (server/permissions.js), the person may be in another app: a
 * desktop notification ("Claude needs you" / "proj · Bash wants to run a
 * command") calls them back. Three rules shape it:
 *
 *   - It waits the same NEEDS_YOU_DEBOUNCE_MS (300 ms) the office waits
 *     before it shows a needs-you hand, and fires only if the permission is
 *     still pending then: a headless `claude -p` session auto-denies the call
 *     and moves on faster than that, so it never notifies.
 *   - At most one per session per PERMISSION_NOTIFY_THROTTLE_MS, so a burst of
 *     tool calls that each ask does not stack up a pile of banners.
 *   - The text names the project and the tool only, never the command line,
 *     the path or any other tool input: notifications show on the lock
 *     screen, and the card in the office is where the detail lives.
 *
 * The `notifyPermissions` setting (server/index.js) turns it off.
 */

// Why: 60 s per session. One banner is enough to call someone back to the
// office, where every pending card is on show; a session that asks for five
// commands in a row would otherwise raise five banners within seconds. A
// minute is still short enough that a new, separate wait after the person has
// walked away again gets its own banner.
export const PERMISSION_NOTIFY_THROTTLE_MS = 60_000

// Why: the same 300 ms the office waits before it shows a permission wait
// (NEEDS_YOU_DEBOUNCE_MS in server/index.js); a headless session's auto-deny
// lands well inside it.
export const PERMISSION_NOTIFY_DELAY_MS = 300

export const PERMISSION_NOTIFY_TITLE = 'Claude needs you'

// Why: notification banners truncate long lines anyway; a project or tool name
// past this is junk or an attack on the banner, not something to show.
const MAX_NAME_LEN = 48

// What a tool wants, in words that carry none of its input
const PHRASE_BY_TOOL = {
  Bash: 'wants to run a command',
  PowerShell: 'wants to run a command',
  Write: 'wants to write a file',
  Edit: 'wants to edit a file',
  MultiEdit: 'wants to edit a file',
  NotebookEdit: 'wants to edit a notebook',
  Read: 'wants to read a file',
  WebFetch: 'wants to fetch a web page',
  WebSearch: 'wants to search the web',
}

/** A name fit for a banner: printable characters only, trimmed and clamped; '' when nothing is left. */
function cleanName(value) {
  if (typeof value !== 'string') return ''
  // Why: control characters (newlines included) could fake a second line in
  // the banner; everything else in a project name is fine to show.
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
  return flat.length > MAX_NAME_LEN ? flat.slice(0, MAX_NAME_LEN - 1) + '…' : flat
}

/** A tool name as Claude Code spells them (Bash, mcp__github__create_pull_request): word characters, dots, colons and dashes only. */
function cleanToolName(value) {
  const name = typeof value === 'string' ? value.replace(/[^\w.:-]/g, '').slice(0, MAX_NAME_LEN) : ''
  return name || 'A tool'
}

/**
 * The title and message for a pending permission. Built from the project (or
 * the session's working directory's last segment) and the tool name only:
 * `summary`, `detail`, suggestions and the rest of the record are never read.
 *
 * @param {{ project?: string, cwd?: string, toolName?: string }} permission
 * @returns {{ title: string, message: string }}
 */
export function permissionNotificationText(permission) {
  const fromCwd = typeof permission?.cwd === 'string' ? permission.cwd.split(/[\\/]/).filter(Boolean).pop() : ''
  const project = cleanName(permission?.project) || cleanName(fromCwd) || 'A session'
  const tool = cleanToolName(permission?.toolName)
  const phrase = PHRASE_BY_TOOL[tool] ?? 'wants permission'
  return { title: PERMISSION_NOTIFY_TITLE, message: `${project} · ${tool} ${phrase}` }
}

/**
 * The notifier. `schedule(permission)` is called the moment a pending
 * permission is created; after `delayMs` it notifies once if the setting is
 * on, the permission is still pending, and the session has not been notified
 * within `throttleMs`.
 *
 * @param {object} opts
 * @param {(title: string, message: string) => void} opts.notify  sends the OS notification (scripts/notify.sh)
 * @param {() => boolean} opts.isEnabled  the notifyPermissions setting, read when the delay is over
 * @param {(id: string) => boolean} opts.isPending  whether the permission still waits
 * @param {number} [opts.delayMs]
 * @param {number} [opts.throttleMs]
 * @param {() => number} [opts.now]  injectable clock for tests
 * @returns {{ schedule: (permission: object) => void, cancelAll: () => void, readonly scheduled: number }}
 */
export function createPermissionNotifier({
  notify,
  isEnabled = () => true,
  isPending = () => true,
  delayMs = PERMISSION_NOTIFY_DELAY_MS,
  throttleMs = PERMISSION_NOTIFY_THROTTLE_MS,
  now = Date.now,
} = {}) {
  if (typeof notify !== 'function') throw new TypeError('createPermissionNotifier needs a notify function')
  /** @type {Map<string, number>} sessionId -> when it was last notified */
  const lastSent = new Map()
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set()

  function fire(permission) {
    if (!isEnabled() || !isPending(permission.id)) return
    const t = now()
    const sessionId = String(permission.sessionId ?? '')
    const last = lastSent.get(sessionId)
    if (last !== undefined && t - last < throttleMs) return
    // Why: forget sessions whose window has passed, so the map never grows
    // with every session the office has ever seen.
    for (const [id, at] of lastSent) if (t - at >= throttleMs) lastSent.delete(id)
    lastSent.set(sessionId, t)
    const { title, message } = permissionNotificationText(permission)
    try { notify(title, message) } catch (err) { console.warn('[notify] Could not send the permission notification:', err.message) }
  }

  return {
    schedule(permission) {
      if (!permission || !permission.id) return
      const timer = setTimeout(() => { timers.delete(timer); fire(permission) }, delayMs)
      timer.unref?.()
      timers.add(timer)
    },
    cancelAll() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
    get scheduled() { return timers.size },
  }
}
