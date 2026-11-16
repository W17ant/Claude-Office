/**
 * gemini.js - Gemini CLI hook payloads -> office events.
 *
 * Gemini CLI's command hooks (~/.gemini/settings.json `hooks`) send
 * session_id, transcript_path, cwd, hook_event_name, timestamp, plus per
 * event: SessionStart source; SessionEnd reason; BeforeAgent prompt;
 * AfterAgent prompt_response (the turn's end; there is no Stop event);
 * BeforeTool / AfterTool tool_name, tool_input, tool_response (with an
 * optional error); Notification notification_type ("ToolPermission");
 * PreCompress trigger. BeforeModel / AfterModel / BeforeToolSelection carry
 * whole LLM requests and mean nothing to the office.
 *
 * From geminicli.com/docs/hooks and waguirre's fork (hooks/multi-client),
 * MIT; credited in CHANGELOG. Not yet checked against a live session.
 */

import { safely, sessionBase, short, toolStatus } from './common.js'

export const id = 'gemini'
export const label = 'Gemini CLI'

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
    const out = (type, fields = {}) => ({ ...base, type, ...fields })

    switch (name) {
      case 'SessionStart':
        return [out('session_started', { source: short(p.source, 20) || 'startup' })]
      case 'SessionEnd':
        return [out('session_ended', { reason: short(p.reason, 40) || 'other' })]
      case 'BeforeAgent':
        return [out('session_prompt', { text: short(p.prompt, 2000) })]
      case 'AfterAgent':
        return [out('session_turn_end', { text: short(p.prompt_response, 2000) })]
      case 'BeforeTool':
        return [out('agent_working', { status: toolStatus(tool, p.tool_input), tool })]
      case 'AfterTool': {
        const error = short(p.tool_response?.error, 120)
        // Why: a failed call gets no separate event in Gemini; show it the way a Claude Code PostToolUseFailure shows
        if (error) return [out('agent_working', { status: `failed: ${tool ?? 'tool'} — ${error}`, failed: true, tool })]
        return [out('session_tool_done', { toolName: tool })]
      }
      case 'Notification':
        if (p.notification_type !== 'ToolPermission') return []
        return [out('session_needs_you', { kind: 'permission', toolName: short(p.details?.tool_name, 80), summary: short(p.message) || 'Gemini CLI needs your OK' })]
      case 'PreCompress':
        return [out('session_compact', { phase: 'pre', trigger: short(p.trigger, 20) })]
      default:
        return []
    }
  })
}

export default { id, label, translate }
