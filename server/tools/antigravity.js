/**
 * antigravity.js - Antigravity CLI (agy) hook payloads -> office events.
 *
 * agy's hooks (~/.gemini/config/hooks.json, under a hook name of our own)
 * fire on SessionStart, PreToolUse, PostToolUse, PreInvocation,
 * PostInvocation and Stop. The payload is camelCase and carries NO event
 * name, so the relay passes it (?event=): conversationId, workspacePaths
 * (no cwd), transcriptPath, modelName; PreToolUse/PostToolUse toolCall
 * {name, args} (+ error after); Stop terminationReason, error, fullyIdle.
 * There is no prompt, permission or session-end hook: the session ends by
 * the server's usual idle handling.
 *
 * From antigravity.google/docs/hooks and EooL's fork research
 * (docs/hooks-other-clis-research.md), MIT; credited in CHANGELOG. Not yet
 * checked against a live session.
 */

import { safely, sessionBase, short, toolStatus } from './common.js'

export const id = 'antigravity'
export const label = 'Antigravity'

/**
 * @param {object} p  the raw hook payload
 * @param {string} [event]  the hook event name the relay passed
 * @returns {object[]} office events
 */
export function translate(p, event) {
  return safely(() => {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !event) return []
    const sid = short(p.conversationId)
    if (!sid) return []
    const cwd = Array.isArray(p.workspacePaths) ? p.workspacePaths[0] : undefined
    const base = sessionBase(id, sid, cwd)
    const tool = short(p.toolCall?.name, 80)
    const out = (type, fields = {}) => ({ ...base, type, ...fields })

    switch (event) {
      case 'SessionStart':
        return [out('session_started', { source: 'startup', model: short(p.modelName, 80) })]
      case 'PreInvocation':
        return [out('agent_working', { status: 'thinking' })]
      case 'PreToolUse':
        return [out('agent_working', { status: toolStatus(tool, p.toolCall?.args), tool })]
      case 'PostToolUse': {
        const error = short(p.error, 120)
        if (error) return [out('agent_working', { status: `failed: ${tool ?? 'tool'} — ${error}`, failed: true, tool })]
        return [out('session_tool_done', { toolName: tool })]
      }
      case 'Stop':
        if (short(p.error)) return [out('session_error', { error: 'agy_error', detail: short(p.error) })]
        return [out('session_turn_end', {})]
      default:
        return []
    }
  })
}

export default { id, label, translate }
