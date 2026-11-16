/**
 * kimi.js - Kimi Code CLI hook payloads -> office events.
 *
 * Kimi's hooks ([[hooks]] in ~/.kimi-code/config.toml) send hook_event_name,
 * session_id, session_title, client_type and cwd on every event, Claude
 * Code-style event names (SessionStart source/model, UserPromptSubmit,
 * PreToolUse / PostToolUse / PostToolUseFailure, PermissionRequest, Stop,
 * StopFailure, SubagentStart / SubagentStop, Pre/PostCompact, SessionEnd,
 * Interrupt ...). Its docs list few per-event fields, so the Claude Code
 * names (prompt, tool_name, tool_input, agent_id) are read where present.
 *
 * From moonshotai.github.io/kimi-code/en/customization/hooks and waguirre's
 * fork (hooks/multi-client), MIT; credited in CHANGELOG. Not yet checked
 * against a live session.
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
    const sub = short(p.agent_id, 100)
    const agentId = sub ? `${id}:${sub}` : undefined
    const out = (type, fields = {}) => ({ ...base, type, ...fields })

    switch (name) {
      case 'SessionStart':
        return [out('session_started', { source: short(p.source, 20) || 'startup', model: short(p.model, 80), title: short(p.session_title) })]
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
      case 'PermissionRequest':
        return [out('session_needs_you', { kind: 'permission', toolName: tool, summary: tool ? `${tool} needs your OK in Kimi` : 'Kimi needs your OK' })]
      case 'Stop': case 'Interrupt':
        return [out('session_turn_end', {})]
      case 'StopFailure':
        return [out('session_error', { error: 'kimi_error', detail: short(p.error) })]
      case 'PreCompact': case 'PostCompact':
        return [out('session_compact', { phase: name === 'PreCompact' ? 'pre' : 'post' })]
      case 'SubagentStart':
        if (!agentId) return []
        return [out('agent_spawned', { agent: { id: agentId, name: short(p.agent_name, 40) || 'Kimi agent', role: 'general-purpose' } })]
      case 'SubagentStop':
        return agentId ? [out('agent_completed', { agentId })] : []
      default:
        return []
    }
  })
}

export default { id, label, translate }
