/**
 * kimi.js - Kimi Code CLI hook payloads -> office events.
 *
 * Kimi's hooks ([[hooks]] in ~/.kimi/config.toml) send hook_event_name,
 * session_id and cwd on every event, plus each event's own fields, exactly as
 * src/kimi_cli/hooks/events.py in MoonshotAI/kimi-cli builds them:
 * SessionStart source, SessionEnd reason, UserPromptSubmit prompt,
 * PreToolUse / PostToolUse / PostToolUseFailure tool_name + tool_input (+ error),
 * StopFailure error_type + error_message, SubagentStart / SubagentStop
 * agent_name, Pre/PostCompact trigger. Kimi has no permission event, so a
 * Kimi session never shows "needs you"; its Notification event is for
 * background-task messages and is not shown.
 *
 * Event mapping from waguirre's fork (hooks/multi-client), MIT; credited in
 * CHANGELOG. Not yet checked against a live session.
 */

import { safely, sessionBase, short, toolStatus } from './common.js'

export const id = 'kimi'
export const label = 'Kimi'

/**
 * @param {object} p  the raw hook payload
 * @param {string} [event]  the hook event name (falls back to p.hook_event_name)
 * @returns {object[]} office events
 */
export function translate(p, event) {
  return safely(() => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return []
    const sid = short(p.session_id)
    if (!sid) return []
    const name = event || p.hook_event_name
    const base = sessionBase(id, sid, p.cwd)
    const tool = short(p.tool_name, 80)
    // Why session + name: Kimi's subagent events carry only agent_name (the subagent type), no id
    const sub = short(p.agent_name, 60)
    const agentId = sub ? `${id}:${sid}:${sub}` : undefined
    const out = (type, fields = {}) => ({ ...base, type, ...fields })

    switch (name) {
      case 'SessionStart':
        return [out('session_started', { source: short(p.source, 20) || 'startup' })]
      case 'SessionEnd':
        return [out('session_ended', { reason: short(p.reason, 40) || 'other' })]
      case 'UserPromptSubmit':
        return [out('session_prompt', { text: short(p.prompt, 2000) })]
      case 'PreToolUse':
        return [out('agent_working', { status: toolStatus(tool, p.tool_input), tool })]
      case 'PostToolUse':
        return [out('session_tool_done', { toolName: tool })]
      case 'PostToolUseFailure':
        return [out('agent_working', { status: `failed: ${tool ?? 'tool'}${short(p.error, 120) ? ` — ${short(p.error, 120)}` : ''}`, failed: true, tool })]
      case 'Stop':
        return [out('session_turn_end', {})]
      case 'StopFailure': {
        const kind = short(p.error_type, 60)
        const message = short(p.error_message, 200)
        return [out('session_error', { error: 'kimi_error', detail: kind && message ? `${kind}: ${message}` : kind || message })]
      }
      case 'PreCompact': case 'PostCompact':
        return [out('session_compact', { phase: name === 'PreCompact' ? 'pre' : 'post' })]
      case 'SubagentStart':
        if (!agentId) return []
        return [out('agent_spawned', { agent: { id: agentId, name: sub.slice(0, 40), role: 'general-purpose' } })]
      case 'SubagentStop':
        return agentId ? [out('agent_completed', { agentId })] : []
      default:
        return []
    }
  })
}

export default { id, label, translate }
