/** tools - the other AI tools the office can show (server/tools), and which one a session is. */

/**
 * Tool id -> display name; the same ids and labels as server/tools.
 * Why a copy here: the UI bundle does not import server code.
 */
export const CLIENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
})

/**
 * Which tool a session is: its explicit `client`, else the prefix the server
 * gives every other tool's session id ("codex:<id>"). Undefined for Claude Code.
 */
export function clientOf(sessionId: string | undefined, client?: string): string | undefined {
  if (client && Object.prototype.hasOwnProperty.call(CLIENT_LABELS, client)) return client
  const prefix = sessionId?.split(':', 1)[0]
  return prefix && sessionId!.includes(':') && Object.prototype.hasOwnProperty.call(CLIENT_LABELS, prefix) ? prefix : undefined
}

/** The tool's display name for a session, or undefined for Claude Code. */
export function clientLabel(sessionId: string | undefined, client?: string): string | undefined {
  const id = clientOf(sessionId, client)
  return id ? CLIENT_LABELS[id] : undefined
}
