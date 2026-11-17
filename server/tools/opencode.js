/**
 * opencode.js - OpenCode plugin events -> office events.
 *
 * OpenCode has no command hooks; hooks/opencode-plugin.js (installed in
 * ~/.config/opencode/plugins/) posts each bus event as { type, properties,
 * directory }, and rebuilds tool.execute.before/after into the same shape
 * ({ tool, sessionID, callID, args }). The session id is
 * properties.sessionID, or properties.info.sessionID / .id. A session.created
 * with a parentID is a subagent of that parent: its later events (tool
 * calls, permission asks, going idle) go to that worker. OpenCode has no prompt-text
 * event the plugin forwards (a user message.updated marks the prompt), and
 * session.idle is the turn's end.
 *
 * From OpenCode's plugin docs and SDK types via EooL's fork
 * (hooks/cli-tracker.mjs), MIT; credited in CHANGELOG. Not yet checked
 * against a live session.
 */

import { safely, sessionBase, short, toolStatus } from './common.js'

export const id = 'opencode'
export const label = 'OpenCode'

// Child session id -> parent session id, filled by session.created with a parentID.
// Why state in a translator: a subagent's own events carry only the child's id;
// without this each would start a ghost session and its worker would never finish.
// Why 500: far past the subagents one office sees at once; the oldest goes first.
const parents = new Map()
const MAX_CHILDREN = 500

function rememberChild(child, parent) {
  parents.delete(child)
  parents.set(child, parent)
  if (parents.size > MAX_CHILDREN) parents.delete(parents.keys().next().value)
}

/** A subagent's own event, as an event on its worker in the parent session. */
function childEvent(name, props, tool, workerOut) {
  switch (name) {
    case 'tool.execute.before':
      return [workerOut('agent_working', { status: toolStatus(tool, props.args), tool })]
    case 'permission.asked': case 'permission.updated':
      return [workerOut('session_needs_you', { kind: 'permission', toolName: short(props.permission, 80) || short(props.type, 80), summary: short(props.title) || 'An OpenCode agent needs your OK' })]
    // Why idle ends it: a subagent's session goes idle when its task is done
    case 'session.idle': case 'session.deleted': case 'session.error':
      return [workerOut('agent_completed', {})]
    default:
      return []  // its prompts, tool ends and compaction are the subagent's own business
  }
}

/**
 * @param {object} p  { type, properties, directory } from the plugin
 * @param {string} [event]  unused: the event type is in the payload
 * @returns {object[]} office events
 */
export function translate(p, event) {
  return safely(() => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return []
    const name = short(p.type, 80) || event
    const props = p.properties && typeof p.properties === 'object' ? p.properties : {}
    const info = props.info && typeof props.info === 'object' ? props.info : {}
    const sid = short(props.sessionID) || short(info.sessionID) || (String(name).startsWith('session.') ? short(info.id) : undefined)
    if (!sid) return []
    const cwd = short(info.directory, 400) || short(p.directory, 400)
    const tool = short(props.tool, 80)
    const out = (type, fields = {}, sessionId = sid) => ({ ...sessionBase(id, sessionId, cwd), type, ...fields })
    const parent = parents.get(sid)
    if (parent && name !== 'session.created') {
      if (name === 'session.deleted') parents.delete(sid)
      return childEvent(name, props, tool, (type, fields) => out(type, { ...fields, agentId: `${id}:${sid}` }, parent))
    }

    switch (name) {
      case 'session.created':
        // Why: OpenCode runs a subagent as a child session; show it as a worker in its parent's office
        if (short(info.parentID)) {
          rememberChild(sid, short(info.parentID))
          return [out('agent_spawned', { agent: { id: `${id}:${sid}`, name: 'OpenCode agent', role: 'general-purpose', task: short(info.title) } }, short(info.parentID))]
        }
        return [out('session_started', { source: 'startup', title: info.title && info.title !== 'New session' ? short(info.title) : undefined })]
      case 'session.deleted':
        return [out('session_ended', { reason: 'deleted' })]
      case 'message.updated':
        return info.role === 'user' ? [out('session_prompt', {})] : []
      case 'tool.execute.before':
        return [out('agent_working', { status: toolStatus(tool, props.args), tool })]
      case 'tool.execute.after':
        return [out('session_tool_done', { toolName: tool })]
      case 'permission.asked': case 'permission.updated':
        return [out('session_needs_you', { kind: 'permission', toolName: short(props.permission, 80) || short(props.type, 80), summary: short(props.title) || 'OpenCode needs your OK' })]
      case 'session.idle':
        return [out('session_turn_end', {})]
      case 'session.error':
        return [out('session_error', { error: 'opencode_error', detail: short(props.error?.name) })]
      case 'session.compacted':
        return [out('session_compact', { phase: 'post' })]
      default:
        return []
    }
  })
}

export default { id, label, translate }
