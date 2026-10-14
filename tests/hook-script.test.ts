/**
 * hooks/agent-tracker.sh — the Python section that turns a Claude Code hook
 * payload into an office event. The bash wrapper only reads stdin and curls
 * the result, so the heredoc is lifted out (the same awk the repo uses by
 * hand) and run against real 2.1.x payload shapes.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TRACKER = fileURLToPath(new URL('../hooks/agent-tracker.sh', import.meta.url))

const PYTHON = execFileSync('awk', ["/<<'PYEOF'/{f=1;next} /^PYEOF$/{f=0} f", TRACKER], { encoding: 'utf8' })
if (!PYTHON.includes('hook_event_name')) throw new Error('could not extract the Python section from agent-tracker.sh')

/** Run the hook's Python against a payload; null when it printed nothing. */
function runHook(payload: unknown): Record<string, any> | null {
  const out = execFileSync('python3', ['-I', '-'], {
    input: PYTHON,
    encoding: 'utf8',
    env: { ...process.env, HOOK_PAYLOAD: typeof payload === 'string' ? payload : JSON.stringify(payload) },
  }).trim()
  return out ? JSON.parse(out) : null
}

describe('agent-tracker.sh: Agent tool', () => {
  it('PreToolUse Agent -> agent_spawned, with the role hinted from the task and background flag', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_01X',
      tool_input: { description: 'Write tests for parser', prompt: '...', subagent_type: 'general-purpose', run_in_background: true },
    })).toEqual({
      type: 'agent_spawned',
      agent: {
        id: 'agent-toolu_01X',
        name: 'Tester',
        role: 'test-engineer',
        task: 'Write tests for parser',
        agentType: 'general-purpose',
        background: true,
      },
    })
  })

  it('PreToolUse Agent with an explicit subagent_type keeps that role (Task alias too)', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'toolu_02Y',
      tool_input: { description: 'Look into the crash', prompt: '...', subagent_type: 'debugger' },
    })).toEqual({
      type: 'agent_spawned',
      agent: { id: 'agent-toolu_02Y', name: 'Debugger', role: 'debugger', task: 'Look into the crash', agentType: 'debugger', background: false },
    })

    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_03Z',
      tool_input: { description: 'Find the config loader', prompt: '...', subagent_type: 'Explore' },
    })?.agent).toMatchObject({ name: 'Explorer', role: 'Explore', agentType: 'Explore' })
  })

  it('PostToolUse Agent (background launch) -> agent_linked with the subagent id', () => {
    expect(runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_01X',
      tool_input: { description: 'Write tests for parser', prompt: '...', subagent_type: 'general-purpose', run_in_background: true },
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1921bf97b0af9fd1', description: 'Write tests for parser' },
    })).toEqual({ type: 'agent_linked', agentId: 'agent-toolu_01X', subagentId: 'a1921bf97b0af9fd1' })
  })

  it('PostToolUse Agent (foreground) -> agent_completed with the result text', () => {
    expect(runHook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_use_id: 'toolu_02Y',
      tool_input: { description: 'What is the date', prompt: '...', subagent_type: 'general-purpose' },
      tool_response: {
        status: 'completed',
        agentId: 'afbfba07a82436af6',
        agentType: 'general-purpose',
        content: [{ type: 'text', text: 'The current date is Tuesday, October 14, 2026.' }],
      },
    })).toEqual({ type: 'agent_completed', agentId: 'agent-toolu_02Y', result: 'The current date is Tuesday, October 14, 2026.' })
  })

  it('truncates long results to 120 characters', () => {
    const long = 'z'.repeat(500)
    const ev = runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_02Y',
      tool_input: { subagent_type: 'general-purpose' },
      tool_response: { status: 'completed', content: [{ type: 'text', text: long }] },
    })
    expect(ev?.result).toHaveLength(120)
  })
})

describe('agent-tracker.sh: inside a subagent', () => {
  it('PreToolUse Bash with agent_id -> agent_working tagged with the subagent', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      agent_id: 'a1921bf97b0af9fd1',
      agent_type: 'general-purpose',
      tool_input: { command: 'ls /etc | wc -l' },
    })).toEqual({
      type: 'agent_working',
      status: 'running: ls /etc | wc -l',
      agentId: 'a1921bf97b0af9fd1',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
    })
  })

  it('PreToolUse Read on the main thread -> agent_working without an agent id', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/server/index.js' },
    })).toEqual({ type: 'agent_working', status: 'reading index.js' })
  })

  it('SubagentStop -> agent_completed with the last assistant message', () => {
    expect(runHook({
      hook_event_name: 'SubagentStop',
      agent_id: 'af4d4090b68ebb5f9',
      agent_type: 'general-purpose',
      last_assistant_message: 'The Bash command ran and printed hi.',
    })).toEqual({ type: 'agent_completed', agentId: 'af4d4090b68ebb5f9', result: 'The Bash command ran and printed hi.' })

    expect(runHook({ hook_event_name: 'SubagentStop', agent_id: 'af4d4090b68ebb5f9' })?.result).toBe('done')
    expect(runHook({ hook_event_name: 'SubagentStop' })).toBeNull()
  })
})

describe('agent-tracker.sh: MCP tools', () => {
  it('PreToolUse mcp__github__get_me -> mcp_call', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__get_me', tool_input: {} }))
      .toEqual({ type: 'mcp_call', server: 'github', tool: 'get_me' })
  })

  it('PostToolUse mcp__github__get_me -> mcp_done', () => {
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__github__get_me', tool_input: {}, tool_response: { login: 'w17ant' } }))
      .toEqual({ type: 'mcp_done', server: 'github' })
  })

  it('splits server and tool on the first "__" only', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-code-remote__list_sessions' }))
      .toEqual({ type: 'mcp_call', server: 'claude-code-remote', tool: 'list_sessions' })
  })
})

describe('agent-tracker.sh: ignored payloads', () => {
  it('prints nothing for tools the office does not visualise', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })).toBeNull()
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' })).toBeNull()
  })

  it('prints nothing without a tool_name', () => {
    expect(runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })).toBeNull()
    expect(runHook({})).toBeNull()
  })

  it('prints nothing (and exits 0) for a payload that is not JSON', () => {
    expect(runHook('not json at all')).toBeNull()
    expect(runHook('')).toBeNull()
  })
})
