/**
 * common.js - helpers the tool translators (server/tools/<tool>.js) share.
 *
 * A translator turns one raw hook payload from another AI tool into the
 * office's existing events (the shapes documented above POST /event). These
 * helpers give every event the same identity fields: a session id prefixed
 * with the tool id, and `client`, which the session keeps so the UI can say
 * which tool it is.
 */

/** A string cut to n characters, or undefined when it is not a non-empty string. */
export function short(value, n = 200) {
  return typeof value === 'string' && value ? value.slice(0, n) : undefined
}

/** The folder name of a path ("/a/b/demo-app/" -> "demo-app"), either slash. */
export function folderName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return undefined
  const trimmed = cwd.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/**
 * The fields every event from a tool carries.
 * @param {string} client  the tool id (codex, gemini, ...)
 * @param {string} nativeId  the tool's own session id
 * @param {string} [cwd]  the folder the session runs in
 * @returns {{ sessionId: string, client: string, cwd?: string, project?: string }}
 */
export function sessionBase(client, nativeId, cwd) {
  // Why the prefix: two tools (or a tool and Claude Code) may use the same
  // native id, and the office keys sessions by id
  const base = { sessionId: `${client}:${nativeId}`.slice(0, 200), client }
  const dir = short(cwd, 400)
  if (dir) {
    base.cwd = dir
    base.project = folderName(dir)
  }
  return base
}

/**
 * The status line for a main-thread or worker tool call, worded the way
 * hooks/agent-tracker.py words Claude Code's ("running: npm test").
 * @param {string} tool  the tool's name as the payload gives it
 * @param {object} [input]  the tool's input
 */
export function toolStatus(tool, input) {
  const i = input && typeof input === 'object' ? input : {}
  const file = p => String(p ?? '').split(/[\\/]/).pop()
  switch (tool) {
    case 'Bash': case 'shell': case 'run_shell_command': case 'bash': case 'Shell':
      return `running: ${String(i.command ?? i.cmd ?? i.description ?? '').slice(0, 60)}`
    case 'Read': case 'read_file': case 'read':
      return `reading ${file(i.file_path ?? i.path ?? i.filePath)}`
    case 'Write': case 'write_file': case 'write':
      return `writing ${file(i.file_path ?? i.path ?? i.filePath)}`
    case 'Edit': case 'replace': case 'edit': case 'apply_patch':
      return i.file_path || i.path || i.filePath ? `editing ${file(i.file_path ?? i.path ?? i.filePath)}` : 'editing files'
    case 'Grep': case 'grep': case 'search_file_content':
      return `searching for '${String(i.pattern ?? '').slice(0, 30)}'`
    default:
      return `using ${String(tool || 'a tool').slice(0, 40)}`
  }
}

/** Run a translator body, turning any throw into "nothing to show" (a translator never breaks the route). */
export function safely(fn) {
  try {
    const out = fn()
    return Array.isArray(out) ? out.filter(Boolean) : []
  } catch {
    return []
  }
}
