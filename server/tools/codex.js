/**
 * codex.js - Codex CLI hook payloads -> office events.
 *
 * Codex's command hooks (~/.codex/hooks.json) send a Claude-like payload:
 * session_id, transcript_path, cwd, hook_event_name, model, and per event
 * prompt / tool_name / tool_input / last_assistant_message / agent_id /
 * agent_type. Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
 * PostToolUse, PermissionRequest, PreCompact, PostCompact, SubagentStart,
 * SubagentStop, Stop, Interrupt.
 *
 * Mapping ported from EooL's fork (hooks/cli-tracker.mjs, normalizeEvent) and
 * the agent_type -> office role table from gilberth's fork
 * (server/codex-normalizer.js). Both MIT; credited in CHANGELOG.
 */

import { safely, sessionBase, short, toolStatus } from './common.js'

export const id = 'codex'
export const label = 'Codex'

// Why: Codex subagents name their type freely; map the common ones onto the
// office's roles so they sit at the right desks (gilberth's table)
const ROLE_ALIASES = {
  explore: 'Explore', explorer: 'Explore',
  general: 'general-purpose', 'general-purpose': 'general-purpose', worker: 'general-purpose', default: 'general-purpose',
  reviewer: 'code-reviewer', 'code-reviewer': 'code-reviewer',
  frontend: 'frontend-developer', 'frontend-developer': 'frontend-developer',
  fullstack: 'fullstack-developer', 'fullstack-developer': 'fullstack-developer',
  tester: 'test-engineer', 'test-engineer': 'test-engineer',
  security: 'security-auditor', 'security-auditor': 'security-auditor',
  architect: 'architect-reviewer', 'architect-reviewer': 'architect-reviewer',
  devops: 'devops-engineer', 'devops-engineer': 'devops-engineer',
  dba: 'database-architect', 'database-architect': 'database-architect',
  typescript: 'typescript-pro', 'typescript-pro': 'typescript-pro',
  ai: 'ai-engineer', 'ai-engineer': 'ai-engineer',
  debugger: 'debugger',
}

/** The office role for a Codex agent_type (general-purpose when unknown). */
export function roleFor(agentType) {
  const key = typeof agentType === 'string' ? agentType.trim().toLowerCase().replace(/_/g, '-') : ''
  return ROLE_ALIASES[key] ?? 'general-purpose'
}

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
    const model = short(p.model, 80)
    const sub = short(p.agent_id, 100)
    // A tool call or prompt inside a subagent belongs to that agent
    const agentId = sub ? `${id}:${sub}` : undefined
    const tool = short(p.tool_name, 80)
    const out = (type, fields = {}) => ({ ...base, type, ...fields })

    switch (name) {
      case 'SessionStart':
        return [out('session_started', { source: short(p.source, 20) || 'startup', model, transcriptPath: short(p.transcript_path, 400) })]
      case 'SessionEnd':
        return [out('session_ended', { reason: short(p.reason, 40) || 'other' })]
      case 'UserPromptSubmit':
        return [out('session_prompt', { text: short(p.prompt, 2000) })]
      case 'PreToolUse':
        return [out('agent_working', { status: toolStatus(tool, p.tool_input), tool, ...(agentId ? { agentId } : {}) })]
      case 'PostToolUse':
        return [out('session_tool_done', { toolName: tool, ...(agentId ? { agentId } : {}) })]
      case 'PermissionRequest':
        // Why not answerable: the office cannot answer Codex; the person does, in its terminal
        return [out('session_needs_you', { kind: 'permission', toolName: tool, summary: tool ? `${tool} needs your OK in Codex` : 'Codex needs your OK', ...(agentId ? { agentId } : {}) })]
      case 'Stop':
        return [out('session_turn_end', { text: short(p.last_assistant_message, 2000) })]
      case 'Interrupt':
        return [out('session_turn_end', {})]
      case 'PreCompact': case 'PostCompact':
        return [out('session_compact', { phase: name === 'PreCompact' ? 'pre' : 'post', trigger: short(p.trigger, 20) })]
      case 'SubagentStart': {
        if (!agentId) return []
        const role = roleFor(p.agent_type)
        return [out('agent_spawned', { agent: { id: agentId, name: short(p.agent_type, 40) || 'Codex agent', role, agentType: short(p.agent_type, 80) } })]
      }
      case 'SubagentStop':
        return agentId ? [out('agent_completed', { agentId, result: short(p.last_assistant_message, 2000) })] : []
      default:
        return []
    }
  })
}

export default { id, label, translate }
