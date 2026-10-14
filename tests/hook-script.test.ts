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

    expect(runHook({ hook_event_name: 'SubagentStop', agent_id: 'af4d4090b68ebb5f9', agent_type: 'general-purpose' })?.result).toBe('done')
    expect(runHook({ hook_event_name: 'SubagentStop' })).toBeNull()
  })

  it('PostToolUseFailure with agent_id -> failed agent_working tagged with the subagent', () => {
    // Shape captured on the main thread (see below) plus the agent_id/agent_type
    // every hook fired inside a subagent carries — not captured inside one.
    expect(runHook({
      hook_event_name: 'PostToolUseFailure',
      agent_id: 'a29964dc791f62039',
      agent_type: 'general-purpose',
      tool_name: 'Bash',
      tool_input: { command: 'cat /definitely/not/here', description: 'Attempt to read a nonexistent file' },
      tool_use_id: 'toolu_01NT86yPHDT746zG29pswfa9',
      error: 'Exit code 1\ncat: /definitely/not/here: No such file or directory',
      is_interrupt: false,
      duration_ms: 135,
    })).toEqual({
      type: 'agent_working',
      status: 'failed: Bash — Exit code 1 cat: /definitely/not/here: No such file or direc',
      failed: true,
      agentId: 'a29964dc791f62039',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
    })
  })

  it('nested PreToolUse Agent (a subagent spawning a subagent) -> agent_spawned with parentSubagentId', () => {
    // The Agent call is made inside subagent a29964dc791f62039, so the hook
    // carries its agent_id/agent_type like any other tool call made in there.
    expect(runHook({
      hook_event_name: 'PreToolUse',
      agent_id: 'a29964dc791f62039',
      agent_type: 'general-purpose',
      tool_name: 'Agent',
      tool_input: { description: 'Find hostname', prompt: 'Read /etc/hostname and report it.', subagent_type: 'Explore', run_in_background: false },
      tool_use_id: 'toolu_012RzmXCF41YXYEnVbdvuQTT',
    })).toEqual({
      type: 'agent_spawned',
      agent: {
        id: 'agent-toolu_012RzmXCF41YXYEnVbdvuQTT',
        name: 'Explorer',
        role: 'Explore',
        task: 'Find hostname',
        agentType: 'Explore',
        background: false,
        parentSubagentId: 'a29964dc791f62039',
      },
    })
  })
})

/**
 * Payloads captured verbatim from Claude Code 2.1.300 (scratchpad/hookcap,
 * 2026-10-14). Only the capture's own bookkeeping keys were dropped.
 */
describe('agent-tracker.sh: captured 2.1.300 payloads', () => {
  const common = {
    session_id: '8cf68f64-5433-40f7-a130-557fc7f67e42',
    transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42.jsonl',
    cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
    scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/scratchpad',
    prompt_id: 'd0f0818e-428e-4732-b3f2-6830d470b485',
  }

  it('SubagentStart -> agent_started: agent_id is the new subagent, no parent is named', () => {
    expect(runHook({
      ...common,
      agent_id: 'ac5ff55b850b4fecf',
      agent_type: 'general-purpose',
      hook_event_name: 'SubagentStart',
    })).toEqual({ type: 'agent_started', subagentId: 'ac5ff55b850b4fecf', agentType: 'general-purpose' })

    // No agent_type: a sidechain, not a worker
    expect(runHook({ ...common, agent_id: 'a4b69979afca21afd', agent_type: '', hook_event_name: 'SubagentStart' })).toBeNull()
  })

  it('PreToolUse Agent (background) -> agent_spawned without parentSubagentId on the main thread', () => {
    expect(runHook({
      ...common,
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Count etc', prompt: 'Run ls /etc | wc -l with Bash and report it.', subagent_type: 'general-purpose', run_in_background: true },
      tool_use_id: 'toolu_01B8Zp1BDnyYNe7SEsseUD22',
    })).toEqual({
      type: 'agent_spawned',
      agent: { id: 'agent-toolu_01B8Zp1BDnyYNe7SEsseUD22', name: 'Agent', role: 'general-purpose', task: 'Count etc', agentType: 'general-purpose', background: true },
    })
  })

  it('PostToolUse Agent (async_launched) -> agent_linked', () => {
    expect(runHook({
      ...common,
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Count etc', prompt: 'Run ls /etc | wc -l with Bash and report it.', subagent_type: 'general-purpose', run_in_background: true },
      tool_response: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'ac5ff55b850b4fecf',
        description: 'Count etc',
        resolvedModel: 'claude-haiku-5-5',
        prompt: 'Run ls /etc | wc -l with Bash and report it.',
        outputFile: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/tasks/ac5ff55b850b4fecf.output',
        canReadOutputFile: true,
        canContinueAgent: true,
      },
      tool_use_id: 'toolu_01B8Zp1BDnyYNe7SEsseUD22',
      duration_ms: 10,
    })).toEqual({ type: 'agent_linked', agentId: 'agent-toolu_01B8Zp1BDnyYNe7SEsseUD22', subagentId: 'ac5ff55b850b4fecf' })
  })

  it('PreToolUse Bash inside the subagent -> agent_working on that subagent', () => {
    expect(runHook({
      session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad',
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      agent_id: 'a29964dc791f62039',
      agent_type: 'general-purpose',
      effort: { level: 'medium' },
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls /etc | wc -l', description: 'Count entries in /etc' },
      tool_use_id: 'toolu_01YUQ8UYuNroNSSpa5Qp26CW',
    })).toEqual({
      type: 'agent_working',
      status: 'running: ls /etc | wc -l',
      agentId: 'a29964dc791f62039',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
    })
  })

  it('SubagentStop of a real worker -> agent_completed with the first 120 chars of its last message', () => {
    const last = '`ls /etc | wc -l` returned **154**, so `/etc` has 154 entries.\n\nThe MCP connection failures in the system notice (design and sales plugin servers returning 403 from the proxy) are unrelated to this command and did not affect it.'
    expect(runHook({
      ...common,
      permission_mode: 'bypassPermissions',
      agent_id: 'ac5ff55b850b4fecf',
      agent_type: 'general-purpose',
      effort: { level: 'medium' },
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/subagents/agent-ac5ff55b850b4fecf.jsonl',
      last_assistant_message: last,
      background_tasks: [{ id: 'ac5ff55b850b4fecf', type: 'subagent', status: 'running', description: 'Count etc', agent_type: 'general-purpose' }],
      session_crons: [],
    })).toEqual({ type: 'agent_completed', agentId: 'ac5ff55b850b4fecf', result: last.slice(0, 120) })
  })

  it('phantom SubagentStop (compaction summariser, agent_type "") -> nothing', () => {
    expect(runHook({
      session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad',
      prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7',
      permission_mode: 'bypassPermissions',
      agent_id: 'a4b69979afca21afd',
      agent_type: '',
      effort: { level: 'medium' },
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/subagents/agent-a4b69979afca21afd.jsonl',
      last_assistant_message: '<analysis>\nThe conversation has three parts. The user first asked for two subagents: a background general-purpose agent described as "Count etc" to run `ls /etc | wc -l`, and a foreground Explore agent described as "Find hostname" to read `/etc/hostname`. They then asked me to wait for the background result and reply DONE. I launched both in one message. The foreground agent returned `vm` as the h...[+2447 chars]',
      background_tasks: [],
      session_crons: [],
    })).toBeNull()
  })

  it('phantom SubagentStop (prompt-suggestion sidechain, agent_type "") -> nothing', () => {
    expect(runHook({
      session_id: 'ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f/scratchpad',
      prompt_id: 'b09cb9a5-0ed7-4592-b4cb-94b9c030e211',
      permission_mode: 'bypassPermissions',
      agent_id: 'a876884f19e1485b2',
      agent_type: '',
      effort: { level: 'medium' },
      hook_event_name: 'SubagentStop',
      stop_hook_active: false,
      agent_transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/ce07e2db-35c7-42b0-b00b-fb2ebe9f8e3f/subagents/agent-a876884f19e1485b2.jsonl',
      last_assistant_message: 'try the team setup again',
      background_tasks: [],
      session_crons: [],
    })).toBeNull()

    // Missing agent_type altogether is treated the same way
    expect(runHook({ hook_event_name: 'SubagentStop', agent_id: 'a876884f19e1485b2', last_assistant_message: 'x' })).toBeNull()
  })

  it('PostToolUseFailure on the main thread (Bash exit 1) -> failed agent_working without an agent id', () => {
    const failure = {
      session_id: '17f46010-d2b1-4d95-bdde-34994b4b1d00',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/17f46010-d2b1-4d95-bdde-34994b4b1d00.jsonl',
      cwd: common.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/17f46010-d2b1-4d95-bdde-34994b4b1d00/scratchpad',
      prompt_id: '47795df5-e84a-4a57-8884-078b1e761a82',
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PostToolUseFailure',
    }
    expect(runHook({
      ...failure,
      tool_name: 'Bash',
      tool_input: { command: 'cat /definitely/not/here', description: 'Attempt to read a nonexistent file' },
      tool_use_id: 'toolu_01NT86yPHDT746zG29pswfa9',
      error: 'Exit code 1\ncat: /definitely/not/here: No such file or directory',
      is_interrupt: false,
      duration_ms: 135,
    })).toEqual({
      type: 'agent_working',
      status: 'failed: Bash — Exit code 1 cat: /definitely/not/here: No such file or direc',
      failed: true,
    })

    expect(runHook({
      ...failure,
      tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run false to exit with status 1' },
      tool_use_id: 'toolu_01CHztAKTp1SviXu1oRzVeh9',
      error: 'Exit code 1',
      is_interrupt: false,
      duration_ms: 53,
    })).toEqual({ type: 'agent_working', status: 'failed: Bash — Exit code 1', failed: true })
  })

  it('PostToolUseFailure of an MCP call -> mcp_done, of an Agent launch -> agent_completed', () => {
    expect(runHook({
      hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__github__get_me', tool_input: {}, tool_use_id: 'toolu_mcp',
      error: 'MCP error -32603: boom', is_interrupt: false, duration_ms: 20,
    })).toEqual({ type: 'mcp_done', server: 'github' })

    expect(runHook({
      hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_01X',
      tool_input: { description: 'Nope', prompt: '...', subagent_type: 'does-not-exist' },
      error: 'Agent type \'does-not-exist\' not found.', is_interrupt: false, duration_ms: 3,
    })).toEqual({ type: 'agent_completed', agentId: 'agent-toolu_01X', result: "failed: Agent type 'does-not-exist' not found." })
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
