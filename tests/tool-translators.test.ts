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
