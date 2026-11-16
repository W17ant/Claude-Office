/** Tool translators — each other AI tool's hook payload becomes the office's existing events (server/tools). */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { translateFor, TOOLS } from '../server/tools/index.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/tools/', import.meta.url))
const fixture = (tool: string, name: string) => JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'))
// The event name the relay passes along (the payload's own hook_event_name when it has one)
const run = (tool: string, name: string, event?: string) => {
  const payload = fixture(tool, name)
  return translateFor(tool, payload, event ?? payload.hook_event_name) as any[]
}

describe('translateFor', () => {
  it('is null for a tool it does not know', () => {
    expect(translateFor('nope', {}, 'SessionStart')).toBeNull()
  })

  it('is empty for a payload it does not understand', () => {
    expect(translateFor('codex', 'garbage', 'SessionStart')).toEqual([])
    expect(translateFor('codex', {}, 'SessionStart')).toEqual([])
    expect(translateFor('codex', fixture('codex', 'session-start'), 'NoSuchEvent')).toEqual([])
  })

  it('labels every tool it knows', () => {
    for (const [id, mod] of Object.entries(TOOLS) as [string, any][]) {
      expect(mod.id).toBe(id)
      expect(mod.label).toBeTruthy()
    }
  })
})

describe('codex', () => {
  const SID = 'codex:019a-codex-sess-1'

  it('starts a session, prefixed and tagged, named after the folder', () => {
    const [e] = run('codex', 'session-start')
    expect(e).toMatchObject({ type: 'session_started', sessionId: SID, client: 'codex', project: 'demo-app', cwd: '/Users/someone/demo-app', model: 'gpt-5-codex' })
  })

  it('passes the prompt on', () => {
    expect(run('codex', 'user-prompt')[0]).toMatchObject({ type: 'session_prompt', text: 'add a test for the parser' })
  })

  it('shows the main thread working, with the tool name', () => {
    const [e] = run('codex', 'pre-tool-bash')
    expect(e).toMatchObject({ type: 'agent_working', tool: 'Bash', status: 'running: npm test' })
    expect(e.agentId).toBeUndefined()
  })

  it('marks the tool call done', () => {
    expect(run('codex', 'post-tool-bash')[0]).toMatchObject({ type: 'session_tool_done', toolName: 'Bash' })
  })

  it('raises a hand on a permission request, which the office cannot answer', () => {
    const [e] = run('codex', 'permission-request')
    expect(e).toMatchObject({ type: 'session_needs_you', kind: 'permission', toolName: 'Bash' })
    expect(e.answerable).not.toBe(true)
  })

  it('ends the turn', () => {
    expect(run('codex', 'stop')[0]).toMatchObject({ type: 'session_turn_end', text: 'Added the test.' })
  })

  it('ends the session', () => {
    expect(run('codex', 'session-end')[0]).toMatchObject({ type: 'session_ended', reason: 'exit' })
  })

  it('gives a subagent its office role from its agent_type, and completes the same agent', () => {
    const [start] = run('codex', 'subagent-start')
    expect(start).toMatchObject({ type: 'agent_spawned', agent: { id: 'codex:sub-7', role: 'code-reviewer' } })
    const [stop] = run('codex', 'subagent-stop')
    expect(stop).toMatchObject({ type: 'agent_completed', agentId: 'codex:sub-7' })
  })

  it('tags every event from every fixture with the tool and a prefixed session id', () => {
    for (const name of ['session-start', 'user-prompt', 'pre-tool-bash', 'post-tool-bash', 'permission-request', 'stop', 'session-end', 'subagent-start', 'subagent-stop']) {
      const events = run('codex', name)
      expect(events.length, name).toBeGreaterThan(0)
      for (const e of events) {
        expect(e.client, name).toBe('codex')
        expect(e.sessionId, name).toMatch(/^codex:/)
      }
    }
  })
})

// Every event a tool's fixtures produce carries the tool and a prefixed session id
function expectTagged(tool: string, names: string[], events: (name: string) => any[]) {
  for (const name of names) {
    const out = events(name)
    expect(out.length, `${tool}/${name}`).toBeGreaterThan(0)
    for (const e of out) {
      expect(e.client, name).toBe(tool)
      expect(e.sessionId, name).toMatch(new RegExp(`^${tool}:`))
    }
  }
}

describe('gemini', () => {
  const SID = 'gemini:gem-sess-1'

  it('starts and ends a session', () => {
    expect(run('gemini', 'session-start')[0]).toMatchObject({ type: 'session_started', sessionId: SID, project: 'demo-app', source: 'startup' })
    expect(run('gemini', 'session-end')[0]).toMatchObject({ type: 'session_ended', reason: 'exit' })
  })

  it('takes the prompt from BeforeAgent and the reply from AfterAgent', () => {
    expect(run('gemini', 'before-agent')[0]).toMatchObject({ type: 'session_prompt', text: 'fix the flaky test' })
    expect(run('gemini', 'after-agent')[0]).toMatchObject({ type: 'session_turn_end', text: 'Fixed it.' })
  })

  it('shows tool calls, and a failed one as failed', () => {
    expect(run('gemini', 'before-tool')[0]).toMatchObject({ type: 'agent_working', tool: 'run_shell_command', status: 'running: npm test' })
    expect(run('gemini', 'after-tool')[0]).toMatchObject({ type: 'session_tool_done', toolName: 'run_shell_command' })
    expect(run('gemini', 'after-tool-error')[0]).toMatchObject({ type: 'agent_working', failed: true, tool: 'run_shell_command' })
  })

  it('raises a hand on a ToolPermission notification, unanswerable', () => {
    const [e] = run('gemini', 'notification-permission')
    expect(e).toMatchObject({ type: 'session_needs_you', kind: 'permission', toolName: 'run_shell_command' })
    expect(e.answerable).not.toBe(true)
  })

  it('marks compaction, and ignores model events', () => {
    expect(run('gemini', 'pre-compress')[0]).toMatchObject({ type: 'session_compact', phase: 'pre' })
    expect(run('gemini', 'before-model')).toEqual([])
  })

  it('tags every event', () => {
    expectTagged('gemini', ['session-start', 'before-agent', 'before-tool', 'after-tool', 'after-tool-error', 'after-agent', 'notification-permission', 'pre-compress', 'session-end'], n => run('gemini', n))
  })
})

describe('antigravity', () => {
  // Antigravity payloads carry no event name: the relay passes it along
  const agy = (name: string, event: string) => run('antigravity', name, event)
  const SID = 'antigravity:agy-conv-1'

  it('starts a session in the first workspace folder', () => {
    expect(agy('session-start', 'SessionStart')[0]).toMatchObject({ type: 'session_started', sessionId: SID, project: 'demo-app', model: 'gemini-3-pro' })
  })

  it('shows tool calls, and a failed one as failed', () => {
    expect(agy('pre-tool', 'PreToolUse')[0]).toMatchObject({ type: 'agent_working', tool: 'run_command' })
    expect(agy('post-tool', 'PostToolUse')[0]).toMatchObject({ type: 'session_tool_done', toolName: 'run_command' })
    expect(agy('post-tool-error', 'PostToolUse')[0]).toMatchObject({ type: 'agent_working', failed: true })
  })

  it('shows thinking when an invocation starts, and ends the turn on Stop', () => {
    expect(agy('pre-invocation', 'PreInvocation')[0]).toMatchObject({ type: 'agent_working', status: 'thinking' })
    expect(agy('stop', 'Stop')[0]).toMatchObject({ type: 'session_turn_end' })
  })

  it('has nothing to say without an event name', () => {
    expect(translateFor('antigravity', fixture('antigravity', 'stop'), undefined)).toEqual([])
  })

  it('tags every event', () => {
    const pairs: Record<string, string> = { 'session-start': 'SessionStart', 'pre-tool': 'PreToolUse', 'post-tool': 'PostToolUse', 'pre-invocation': 'PreInvocation', stop: 'Stop' }
    expectTagged('antigravity', Object.keys(pairs), n => agy(n, pairs[n]))
  })
})

describe('kimi', () => {
  const SID = 'kimi:kimi-sess-1'

  it('starts a session with its title and model, and ends it', () => {
    expect(run('kimi', 'session-start')[0]).toMatchObject({ type: 'session_started', sessionId: SID, title: 'Parser tests', model: 'kimi-k2', project: 'demo-app' })
    expect(run('kimi', 'session-end')[0]).toMatchObject({ type: 'session_ended' })
  })

  it('passes the prompt on and ends the turn', () => {
    expect(run('kimi', 'user-prompt')[0]).toMatchObject({ type: 'session_prompt', text: 'add a test for the parser' })
    expect(run('kimi', 'stop')[0]).toMatchObject({ type: 'session_turn_end' })
    expect(run('kimi', 'stop-failure')[0]).toMatchObject({ type: 'session_error' })
  })

  it('shows tool calls, failures and permission requests', () => {
    expect(run('kimi', 'pre-tool')[0]).toMatchObject({ type: 'agent_working', tool: 'Bash', status: 'running: npm test' })
    expect(run('kimi', 'post-tool')[0]).toMatchObject({ type: 'session_tool_done', toolName: 'Bash' })
    expect(run('kimi', 'post-tool-failure')[0]).toMatchObject({ type: 'agent_working', failed: true })
    const [hand] = run('kimi', 'permission-request')
    expect(hand).toMatchObject({ type: 'session_needs_you', kind: 'permission', toolName: 'Bash' })
    expect(hand.answerable).not.toBe(true)
  })

  it('spawns and completes a subagent', () => {
    expect(run('kimi', 'subagent-start')[0]).toMatchObject({ type: 'agent_spawned', agent: { id: 'kimi:k-sub-1' } })
    expect(run('kimi', 'subagent-stop')[0]).toMatchObject({ type: 'agent_completed', agentId: 'kimi:k-sub-1' })
  })

  it('tags every event', () => {
    expectTagged('kimi', ['session-start', 'user-prompt', 'pre-tool', 'post-tool', 'post-tool-failure', 'permission-request', 'stop', 'stop-failure', 'subagent-start', 'subagent-stop', 'session-end'], n => run('kimi', n))
  })

  it('understands nothing from an empty payload', () => {
    for (const tool of ['gemini', 'antigravity', 'kimi']) expect(translateFor(tool, {}, 'SessionStart'), tool).toEqual([])
  })
})

describe('opencode', () => {
  const SID = 'opencode:ses_oc1'

  it('starts a session on session.created, and a subagent when it has a parent', () => {
    expect(run('opencode', 'session-created')[0]).toMatchObject({ type: 'session_started', sessionId: SID, project: 'demo-app' })
    expect(run('opencode', 'subagent-created')[0]).toMatchObject({ type: 'agent_spawned', sessionId: SID, agent: { id: 'opencode:ses_child' } })
  })

  it('marks a prompt on a user message only', () => {
    expect(run('opencode', 'user-message')[0]).toMatchObject({ type: 'session_prompt', sessionId: SID })
    expect(run('opencode', 'assistant-message')).toEqual([])
  })

  it('shows tool calls and permission requests', () => {
    expect(run('opencode', 'tool-before')[0]).toMatchObject({ type: 'agent_working', tool: 'bash', status: 'running: npm test' })
    expect(run('opencode', 'tool-after')[0]).toMatchObject({ type: 'session_tool_done', toolName: 'bash' })
    const [hand] = run('opencode', 'permission-asked')
    expect(hand).toMatchObject({ type: 'session_needs_you', kind: 'permission', toolName: 'bash' })
    expect(hand.answerable).not.toBe(true)
  })

  it('ends the turn when idle, and reports errors, compaction and deletion', () => {
    expect(run('opencode', 'session-idle')[0]).toMatchObject({ type: 'session_turn_end' })
    expect(run('opencode', 'session-error')[0]).toMatchObject({ type: 'session_error' })
    expect(run('opencode', 'session-compacted')[0]).toMatchObject({ type: 'session_compact', phase: 'post' })
    expect(run('opencode', 'session-deleted')[0]).toMatchObject({ type: 'session_ended' })
  })

  it('tags every event', () => {
    expectTagged('opencode', ['session-created', 'subagent-created', 'user-message', 'tool-before', 'tool-after', 'permission-asked', 'session-idle', 'session-error', 'session-compacted', 'session-deleted'], n => run('opencode', n))
  })
})
