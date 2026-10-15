/**
 * hooks/agent-tracker.sh — the Python section that turns a Claude Code hook
 * payload into an office event. The bash wrapper reads stdin, pipes the
 * payload into the Python (never through an environment variable or an
 * argument: a big tool_response would hit the exec's single-argument limit)
 * and curls the result, so the heredoc is lifted out (the same awk the repo
 * uses by hand) and run against real 2.1.x payload shapes exactly as the
 * wrapper runs it: `python3 -I -c <source>` with the payload on stdin. The
 * last group runs the whole script with a fake `curl` on PATH.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const TRACKER = fileURLToPath(new URL('../hooks/agent-tracker.sh', import.meta.url))

const PYTHON = execFileSync('awk', ["/<<'PYEOF'/{f=1;next} /^PYEOF$/{f=0} f", TRACKER], { encoding: 'utf8' })
if (!PYTHON.includes('hook_event_name')) throw new Error('could not extract the Python section from agent-tracker.sh')

// The Python looks for $AGENT_OFFICE_HOME/answer-permissions (the server keeps
// that marker in step with its answerPermissions setting): point it at an
// empty dir so a marker in the developer's real ~/.agent-office never changes
// what the tests below see. The answer-from-the-office group sets its own.
const NO_MARKER_HOME = mkdtempSync(join(tmpdir(), 'agent-office-hook-home-'))
afterAll(() => rmSync(NO_MARKER_HOME, { recursive: true, force: true }))

/** The hook's Python against a payload (on stdin, as the wrapper does): its stdout lines. */
function runHookLines(payload: unknown, env: Record<string, string> = {}): string[] {
  const out = execFileSync('python3', ['-I', '-c', PYTHON], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENT_OFFICE_HOME: NO_MARKER_HOME, ...env },
  }).trim()
  return out ? out.split('\n') : []
}

/** Run the hook's Python against a payload; null when it printed nothing. */
function runHook(payload: unknown): Record<string, any> | null {
  const lines = runHookLines(payload)
  if (lines.length > 1) throw new Error(`expected one line, got ${lines.length}: ${lines.join(' | ')}`)
  return lines.length ? JSON.parse(lines[0]) : null
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
      tool: 'Bash',
      agentId: 'a1921bf97b0af9fd1',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
    })
  })

  it('PreToolUse Read on the main thread -> agent_working without an agent id', () => {
    expect(runHook({
      hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/server/index.js' },
    })).toEqual({ type: 'agent_working', status: 'reading index.js', tool: 'Read' })
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
      tool: 'Bash',
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
  // What every event made from `common` carries: the session it came from
  const session = {
    sessionId: common.session_id,
    project: 'hookcap',
    cwd: common.cwd,
    transcriptPath: common.transcript_path,
  }
  // The other capture session (c25c5511…) that some payloads below belong to
  const other = {
    session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
    transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
  }
  const otherSession = { sessionId: other.session_id, project: 'hookcap', cwd: common.cwd, transcriptPath: other.transcript_path }

  it('SubagentStart -> agent_started: agent_id is the new subagent, no parent is named', () => {
    expect(runHook({
      ...common,
      agent_id: 'ac5ff55b850b4fecf',
      agent_type: 'general-purpose',
      hook_event_name: 'SubagentStart',
    })).toEqual({ type: 'agent_started', subagentId: 'ac5ff55b850b4fecf', agentType: 'general-purpose', ...session })

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
      ...session,
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
    })).toEqual({ type: 'agent_linked', agentId: 'agent-toolu_01B8Zp1BDnyYNe7SEsseUD22', subagentId: 'ac5ff55b850b4fecf', ...session })
  })

  it('PreToolUse Bash inside the subagent -> agent_working on that subagent', () => {
    // A hook fired inside a subagent carries the PARENT session's session_id
    // (the subagent transcript lives under <session_id>/subagents/), so the
    // working event files the worker under the terminal that spawned it
    expect(runHook({
      ...other,
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
      tool: 'Bash',
      agentId: 'a29964dc791f62039',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
      ...otherSession,
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
    })).toEqual({
      type: 'agent_completed', agentId: 'ac5ff55b850b4fecf', result: last.slice(0, 120),
      // The worker's own transcript travels as a path string (the inspector card tails it)
      agentTranscriptPath: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/subagents/agent-ac5ff55b850b4fecf.jsonl',
      ...session,
    })
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
    const failureSession = { sessionId: failure.session_id, project: 'hookcap', cwd: failure.cwd, transcriptPath: failure.transcript_path }
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
      tool: 'Bash',
      ...failureSession,
    })

    expect(runHook({
      ...failure,
      tool_name: 'Bash',
      tool_input: { command: 'false', description: 'Run false to exit with status 1' },
      tool_use_id: 'toolu_01CHztAKTp1SviXu1oRzVeh9',
      error: 'Exit code 1',
      is_interrupt: false,
      duration_ms: 53,
    })).toEqual({ type: 'agent_working', status: 'failed: Bash — Exit code 1', failed: true, tool: 'Bash', ...failureSession })
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

/**
 * Sessions. SessionStart / SessionEnd payloads captured verbatim from Claude
 * Code 2.1.300 (scratchpad/hookcap/events.jsonl, 2026-10-14): session_id,
 * transcript_path and cwd are in the base schema of every hook event.
 */
describe('agent-tracker.sh: sessions', () => {
  const base = {
    session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
    transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
    cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
    scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad',
  }
  const session = { sessionId: base.session_id, project: 'hookcap', cwd: base.cwd, transcriptPath: base.transcript_path }

  it('SessionStart {source: startup} -> session_started (no model on a bare startup)', () => {
    expect(runHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' }))
      .toEqual({ type: 'session_started', source: 'startup', ...session })
  })

  it('SessionStart {source: startup, model} -> session_started with the model', () => {
    expect(runHook({
      session_id: '19616213-277c-4e70-9909-9883230a3394',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/19616213-277c-4e70-9909-9883230a3394.jsonl',
      cwd: base.cwd,
      scratchpad_dir: '/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/19616213-277c-4e70-9909-9883230a3394/scratchpad',
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'claude-haiku-5-5',
    })).toEqual({
      type: 'session_started',
      source: 'startup',
      model: 'claude-haiku-5-5',
      sessionId: '19616213-277c-4e70-9909-9883230a3394',
      project: 'hookcap',
      cwd: base.cwd,
      transcriptPath: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/19616213-277c-4e70-9909-9883230a3394.jsonl',
    })
  })

  it('SessionStart {source: resume} (claude -r) -> session_started with the same session id; token fields are dropped', () => {
    expect(runHook({
      ...base,
      hook_event_name: 'SessionStart',
      source: 'resume',
      seconds_since_last_response: 5,
      context_tokens: 44052,
      prompt_cache_likely_expired: false,
      estimated_cache_write_usd: 0.0088,
    })).toEqual({ type: 'session_started', source: 'resume', ...session })
  })

  it('SessionStart {source: compact, model} -> session_started with the model (the server treats it as an update)', () => {
    expect(runHook({
      ...base,
      prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7',
      hook_event_name: 'SessionStart',
      source: 'compact',
      model: 'claude-haiku-5-5',
    })).toEqual({ type: 'session_started', source: 'compact', model: 'claude-haiku-5-5', ...session })
  })

  it('a named session (session_title) -> title; source defaults to startup', () => {
    // session_title only exists when the session was named (--name / /rename)
    expect(runHook({ ...base, hook_event_name: 'SessionStart', source: 'fork', session_title: 'office refactor' }))
      .toEqual({ type: 'session_started', source: 'fork', title: 'office refactor', ...session })
    expect(runHook({ ...base, hook_event_name: 'SessionStart' })?.source).toBe('startup')
  })

  it('SessionEnd {reason: other} (every -p exit) and {reason: prompt_input_exit} (/exit) -> session_ended', () => {
    expect(runHook({ ...base, prompt_id: '54f01295-3ff5-45ab-a738-b0598eae881d', hook_event_name: 'SessionEnd', reason: 'other' }))
      .toEqual({ type: 'session_ended', reason: 'other', ...session })
    expect(runHook({
      session_id: '19616213-277c-4e70-9909-9883230a3394',
      transcript_path: '/t/19616213.jsonl',
      cwd: base.cwd,
      prompt_id: 'f2fb3821-dd71-4d36-95ff-ae5cdedfaf8f',
      hook_event_name: 'SessionEnd',
      reason: 'prompt_input_exit',
    })).toEqual({
      type: 'session_ended', reason: 'prompt_input_exit',
      sessionId: '19616213-277c-4e70-9909-9883230a3394', project: 'hookcap', cwd: base.cwd, transcriptPath: '/t/19616213.jsonl',
    })
  })

  it('SessionStart/SessionEnd without a session_id emit nothing', () => {
    expect(runHook({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull()
    expect(runHook({ hook_event_name: 'SessionEnd', reason: 'other' })).toBeNull()
  })

  it('every emitted event carries sessionId, project, cwd and transcriptPath', () => {
    const payloads: Array<Record<string, unknown>> = [
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { description: 'Count etc', subagent_type: 'general-purpose', run_in_background: true } },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { run_in_background: true }, tool_response: { status: 'async_launched', agentId: 'ac5ff55b850b4fecf' } },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_2', tool_input: {}, tool_response: { status: 'completed', content: [{ type: 'text', text: 'ok' }] } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_3', tool_input: {}, error: 'nope' },
      { hook_event_name: 'SubagentStart', agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose' },
      { hook_event_name: 'SubagentStop', agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose', last_assistant_message: 'done' },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose', tool_input: { command: 'ls' } },
      { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'Exit code 1' },
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__github__get_me', tool_input: {} },
      { hook_event_name: 'PostToolUse', tool_name: 'mcp__github__get_me', tool_input: {}, tool_response: {} },
      { hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', tool_input: { agent_id: 'ac5ff55b850b4fecf' }, tool_response: 'report' },
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'SessionEnd', reason: 'other' },
    ]
    const types = payloads.map(p => {
      const ev = runHook({ ...base, ...p })
      expect(ev, JSON.stringify(p)).toMatchObject(session)
      return ev?.type
    })
    expect(types).toEqual([
      'agent_spawned', 'agent_linked', 'agent_completed', 'agent_completed', 'agent_started', 'agent_completed',
      'agent_working', 'agent_working', 'agent_working', 'mcp_call', 'mcp_done', 'agent_completed',
      'session_started', 'session_ended',
    ])
  })

  it('project is the last path segment of cwd (trailing slash tolerated; "/" stays "/")', () => {
    const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, session_id: 's', transcript_path: '/t.jsonl' }
    expect(runHook({ ...read, cwd: '/home/me/Claude-Office' })?.project).toBe('Claude-Office')
    expect(runHook({ ...read, cwd: '/home/me/Claude-Office/' })?.project).toBe('Claude-Office')
    expect(runHook({ ...read, cwd: '/' })?.project).toBe('/')
    // No cwd: no project/cwd keys, but the session id still travels
    expect(runHook({ ...read })).toEqual({ type: 'agent_working', status: 'reading x', tool: 'Read', sessionId: 's', transcriptPath: '/t.jsonl' })
  })

  it('payloads without session fields (older hooks, hand-made events) emit the old shapes unchanged', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b.js' } }))
      .toEqual({ type: 'agent_working', status: 'reading b.js', tool: 'Read' })
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

describe('agent-tracker.sh: every tool call is activity', () => {
  it('PreToolUse of a tool without a specific status line -> a generic "using <tool>" working status, main thread or worker', () => {
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }))
      .toEqual({ type: 'agent_working', status: 'using WebFetch', tool: 'WebFetch' })
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', agent_id: 'a1921bf97b0af9fd1', agent_type: 'Explore', tool_input: { todos: [] } }))
      .toEqual({ type: 'agent_working', status: 'using TodoWrite', tool: 'TodoWrite', agentId: 'a1921bf97b0af9fd1', agentType: 'Explore', role: 'Explore', name: 'Explorer' })
    // The known tools keep their specific lines; a tool_input that is not an object does not crash the hook
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'needle' } })?.status).toBe("searching for 'needle'")
    expect(runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: null })).toEqual({ type: 'agent_working', status: 'reading ', tool: 'Read' })
  })

  it('PostToolUse of an ordinary tool on the main thread -> session_tool_done {toolName} (lowers a permission hand on the server); inside a worker, or without a session, nothing', () => {
    const session = { session_id: 's1', cwd: '/x/proj', transcript_path: '/t.jsonl', prompt_id: 'p' }
    expect(runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' }))
      .toEqual({ type: 'session_tool_done', toolName: 'Bash', promptId: 'p', sessionId: 's1', project: 'proj', cwd: '/x/proj', transcriptPath: '/t.jsonl' })
    expect(runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/x/probe.txt', content: 'hello' }, tool_response: { filePath: '/x/probe.txt', success: true } }))
      .toMatchObject({ type: 'session_tool_done', toolName: 'Write' })
    expect(runHook({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a1921bf97b0af9fd1', agent_type: 'general-purpose', tool_input: { command: 'ls' }, tool_response: 'ok' })).toBeNull()
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok' })).toBeNull()
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'WebFetch', tool_input: {}, tool_response: 'page' })).toBeNull()
  })

  it('PostToolUse Agent (foreground, captured) -> agent_completed with what the agent cost: tokens, durationMs, toolUses, model', () => {
    // Captured 2.1.300: the foreground Explore agent of session c25c5511 (prompt 60d87662)
    expect(runHook({
      session_id: 'c25c5511-f321-521a-825b-f189ac4d57e8',
      transcript_path: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
      cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_input: { description: 'Find hostname', prompt: 'Read /etc/hostname and report it.', subagent_type: 'Explore', run_in_background: false },
      tool_response: {
        status: 'completed', prompt: 'Read /etc/hostname and report it.', agentId: 'a090f8b6e472b3cf9', agentType: 'Explore',
        harnessNoteCount: 0, harnessTailCount: 0, harnessSectionHash: '71f94196794b0023',
        content: [{ type: 'text', text: 'The hostname in `/etc/hostname` is `vm`.' }],
        resolvedModel: 'claude-haiku-5-5', totalDurationMs: 2913, totalTokens: 20442, totalToolUseCount: 1,
        usage: { output_tokens_details: { thinking_tokens: 97 }, input_tokens: 2, cache_creation_input_tokens: 1497, cache_read_input_tokens: 18824, output_tokens: 119, service_tier: 'standard' },
        toolStats: { readCount: 1, searchCount: 0, bashCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, otherToolCount: 0 },
        canContinueAgent: true,
      },
      tool_use_id: 'toolu_01GxFiqPkJRKxd5Qkyus2tLN',
      duration_ms: 2926,
    })).toEqual({
      type: 'agent_completed', agentId: 'agent-toolu_01GxFiqPkJRKxd5Qkyus2tLN', result: 'The hostname in `/etc/hostname` is `vm`.',
      tokens: 20442, durationMs: 2913, toolUses: 1, model: 'claude-haiku-5-5',
      sessionId: 'c25c5511-f321-521a-825b-f189ac4d57e8', project: 'hookcap',
      cwd: '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap',
      transcriptPath: '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/c25c5511-f321-521a-825b-f189ac4d57e8.jsonl',
    })
    // Odd values are left out rather than forwarded
    expect(runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_x', tool_input: {},
      tool_response: { status: 'completed', content: 'ok', totalTokens: true, totalDurationMs: -5, totalToolUseCount: '3', resolvedModel: 7 },
    })).toEqual({ type: 'agent_completed', agentId: 'agent-toolu_x', result: 'ok' })
  })
})

describe('agent-tracker.sh: ignored payloads', () => {
  it('prints nothing for an empty payload or one with neither a tool_name nor a session', () => {
    expect(runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' })).toBeNull()
    expect(runHook({ hook_event_name: 'Stop', last_assistant_message: 'x' })).toBeNull()
    expect(runHook({})).toBeNull()
  })

  it('prints nothing (and exits 0) for a payload that is not JSON, or JSON that is not an object', () => {
    expect(runHook('not json at all')).toBeNull()
    expect(runHook('')).toBeNull()
    expect(runHook('[1, 2]')).toBeNull()
    expect(runHook('"a string"')).toBeNull()
  })
})

/**
 * The session's own Claude — the main-thread events. Payloads captured
 * verbatim from Claude Code 2.1.300 (scratchpad/hookcap/events.jsonl and the
 * session-a transcript, 2026-10-14) unless marked synthetic; only the
 * capture's own bookkeeping keys were dropped. None of these carries a
 * tool_name except PermissionRequest.
 */
describe('agent-tracker.sh: the main thread (session_* events)', () => {
  const HOOKCAP = '/tmp/claude-0/-home-user-Claude-Office/c25c5511-f321-521a-825b-f189ac4d57e8/scratchpad/hookcap'
  const PROJECTS = '/root/.claude/projects/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap'
  /** Common keys of a captured session: session_id, transcript_path, cwd, scratchpad_dir */
  const captured = (sid: string) => ({
    session_id: sid,
    transcript_path: `${PROJECTS}/${sid}.jsonl`,
    cwd: HOOKCAP,
    scratchpad_dir: `/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/${sid}/scratchpad`,
  })
  /** What every event made from that session carries */
  const forwarded = (sid: string) => ({ sessionId: sid, project: 'hookcap', cwd: HOOKCAP, transcriptPath: `${PROJECTS}/${sid}.jsonl` })
  const C = 'c25c5511-f321-521a-825b-f189ac4d57e8'   // the round-1 capture session (session a's twin)
  const A = '8cf68f64-5433-40f7-a130-557fc7f67e42'   // round-2 session a: background + foreground subagent

  it('UserPromptSubmit -> session_prompt with the prompt text and the prompt id', () => {
    const prompt = "Launch ONE background subagent with the Agent tool (run_in_background: true, subagent_type general-purpose, description 'Count etc') whose prompt is 'Run ls /etc | wc -l with Bash and report it.' Then launch ONE foreground subagent (subagent_type Explore, description 'Find hostname') with prompt 'Read /etc/hostname and report it.' Wait for the background result, then reply DONE."
    expect(runHook({
      ...captured(C),
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    })).toEqual({ type: 'session_prompt', text: prompt, isWakeup: false, promptId: '60d87662-ef42-4452-a6bd-cd9718825c5b', ...forwarded(C) })
  })

  it('a <task-notification> prompt (a background worker reporting back) -> session_prompt {isWakeup, wakeupAgentId}; only the <summary> travels', () => {
    // The full prompt as written to session a's transcript (the hook capture clipped it at 400 chars)
    const prompt = '<task-notification>\n<task-id>ac5ff55b850b4fecf</task-id>\n<tool-use-id>toolu_01B8Zp1BDnyYNe7SEsseUD22</tool-use-id>\n<output-file>/tmp/claude-0/-tmp-claude-0--home-user-Claude-Office-c25c5511-f321-521a-825b-f189ac4d57e8-scratchpad-hookcap/8cf68f64-5433-40f7-a130-557fc7f67e42/tasks/ac5ff55b850b4fecf.output</output-file>\n<status>completed</status>\n<summary>Agent "Count etc" finished</summary>\n<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>\n<result>`ls /etc | wc -l` returned **154**, so `/etc` has 154 entries.\n\nThe MCP connection failures in the system notice (design and sales plugin servers returning 403 from the proxy) are unrelated to this command and did not affect it.</result>\n<usage><subagent_tokens>29829</subagent_tokens><tool_uses>1</tool_uses><duration_ms>3973</duration_ms></usage>\n</task-notification>'
    const ev = runHook({
      ...captured(A),
      prompt_id: 'd0f0818e-428e-4732-b3f2-6830d470b485',
      permission_mode: 'bypassPermissions',
      hook_event_name: 'UserPromptSubmit',
      prompt,
    })
    expect(ev).toEqual({
      type: 'session_prompt',
      text: 'Agent "Count etc" finished',
      isWakeup: true,
      wakeupAgentId: 'ac5ff55b850b4fecf',   // the subagent id the server already resolves to its office agent
      wakeupStatus: 'completed',
      promptId: 'd0f0818e-428e-4732-b3f2-6830d470b485',
      ...forwarded(A),
    })
    // Neither the XML nor the worker's result leaks
    expect(JSON.stringify(ev)).not.toMatch(/<task-notification>|returned \*\*154\*\*|output-file/)
  })

  it('clamps a long prompt to 2000 characters hook-side (the server would refuse an oversize body whole)', () => {
    const ev = runHook({ ...captured(C), prompt_id: 'p', hook_event_name: 'UserPromptSubmit', prompt: 'z'.repeat(10_000) })
    expect(ev?.text).toHaveLength(2000)
    // A prompt that is not a string (never seen; schema says string) is forwarded as empty text, not a crash
    expect(runHook({ ...captured(C), hook_event_name: 'UserPromptSubmit', prompt: 42 })).toMatchObject({ type: 'session_prompt', text: '', isWakeup: false })
  })

  it('Stop -> session_turn_end with the reply, the (empty) task list and the cron count', () => {
    // Captured while the background agent was still running: background_tasks was [] all the same (see the synthetic case below)
    const last = "The foreground Explore agent reports that `/etc/hostname` contains `vm`.\n\nThe background agent that runs `ls /etc | wc -l` is still running. I'll reply DONE when its completion notification arrives."
    expect(runHook({
      ...captured(C),
      prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b',
      permission_mode: 'bypassPermissions',
      effort: { level: 'medium' },
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: last,
      background_tasks: [],
      session_crons: [],
    })).toEqual({
      type: 'session_turn_end', text: last, backgroundTasks: [], crons: 0, stopHookActive: false,
      promptId: '60d87662-ef42-4452-a6bd-cd9718825c5b', ...forwarded(C),
    })

    // The auto-continuation turn after the wake-up
    expect(runHook({
      ...captured(C), prompt_id: '54f01295-3ff5-45ab-a738-b0598eae881d', permission_mode: 'bypassPermissions', effort: { level: 'medium' },
      hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'DONE', background_tasks: [], session_crons: [],
    })).toMatchObject({ type: 'session_turn_end', text: 'DONE', promptId: '54f01295-3ff5-45ab-a738-b0598eae881d' })
  })

  it('Stop with a running background task (synthetic: the entry shape is the one SubagentStop carried) -> backgroundTasks, max 10, descriptions at 120', () => {
    const running = { id: 'a29964dc791f62039', type: 'subagent', status: 'running', description: 'Count etc', agent_type: 'general-purpose' }
    const ev = runHook({
      ...captured(C), prompt_id: 'p', permission_mode: 'bypassPermissions', effort: { level: 'medium' },
      hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'Waiting for the count.',
      background_tasks: [
        running,
        { id: 'sh1', type: 'shell', status: 'running', description: 'x'.repeat(500), command: 'sleep 1000' },
        'junk',
        ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, type: 'monitor', status: 'pending', description: `m${i}` })),
      ],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check CI' }],
    })
    expect(ev).toMatchObject({ type: 'session_turn_end', text: 'Waiting for the count.', crons: 1, stopHookActive: true })
    expect(ev?.backgroundTasks[0]).toEqual({ id: 'a29964dc791f62039', type: 'subagent', status: 'running', description: 'Count etc' })
    expect(ev?.backgroundTasks[1].description).toHaveLength(120)
    expect(ev?.backgroundTasks).toHaveLength(9)  // the first ten raw entries, minus the junk one
    expect(ev?.backgroundTasks.every((t: any) => Object.keys(t).sort().join() === 'description,id,status,type')).toBe(true)
    // A reply over 2000 characters is clamped here too
    expect(runHook({ ...captured(C), hook_event_name: 'Stop', last_assistant_message: 'r'.repeat(5000) })?.text).toHaveLength(2000)
  })

  it('PermissionRequest Write -> session_needs_you {kind: permission, toolName, summary: the file name}', () => {
    expect(runHook({
      ...captured('4a9dd43b-f941-406a-809a-01149a62b597'),
      prompt_id: '273fe3a9-5b8d-4724-bb83-0c5e06bca880',
      permission_mode: 'default',
      effort: { level: 'medium' },
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: `${HOOKCAP}/probe.txt`, content: 'hello' },
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })).toEqual({
      type: 'session_needs_you', kind: 'permission', toolName: 'Write', summary: 'probe.txt',
      promptId: '273fe3a9-5b8d-4724-bb83-0c5e06bca880', ...forwarded('4a9dd43b-f941-406a-809a-01149a62b597'),
    })
  })

  it('PermissionRequest Bash -> the first 80 characters of the command; other tools -> the tool name; inside a subagent -> agentId', () => {
    // Shapes from the hooks reference (only Write was captured)
    const base = { ...captured(C), prompt_id: 'p', permission_mode: 'default', hook_event_name: 'PermissionRequest' }
    const long = 'rm -rf node_modules && ' + 'echo again && '.repeat(20)
    expect(runHook({ ...base, tool_name: 'Bash', tool_input: { command: long, description: 'Remove node_modules directory' } }))
      .toMatchObject({ kind: 'permission', toolName: 'Bash', summary: long.slice(0, 80) })
    expect(runHook({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf\n  node_modules' } })?.summary).toBe('rm -rf node_modules')
    expect(runHook({ ...base, tool_name: 'Edit', tool_input: { file_path: '/repo/src/App.tsx', old_string: 'a', new_string: 'b' } })?.summary).toBe('App.tsx')
    expect(runHook({ ...base, tool_name: 'mcp__github__create_pull_request', tool_input: { title: 'x' } }))
      .toMatchObject({ toolName: 'mcp__github__create_pull_request', summary: 'mcp__github__create_pull_request' })
    expect(runHook({ ...base, tool_name: 'WebFetch', tool_input: null })?.summary).toBe('WebFetch')
    // Raised inside a subagent (schema-only, not captured): the worker is named as well
    expect(runHook({ ...base, agent_id: 'ac5ff55b850b4fecf', agent_type: 'general-purpose', tool_name: 'Write', tool_input: { file_path: '/x/y.txt', content: '' } }))
      .toMatchObject({ kind: 'permission', toolName: 'Write', summary: 'y.txt', agentId: 'ac5ff55b850b4fecf' })
  })

  it('Notification permission_prompt (interactive, ~6 s after PermissionRequest) -> session_needs_you {kind: permission, notificationType, message}', () => {
    expect(runHook({
      ...captured('19616213-277c-4e70-9909-9883230a3394'),
      prompt_id: 'a7c849b6-361e-4cf8-84c8-7f387f16fafc',
      hook_event_name: 'Notification',
      message: 'Claude needs your permission',
      notification_type: 'permission_prompt',
    })).toEqual({
      type: 'session_needs_you', kind: 'permission', notificationType: 'permission_prompt', message: 'Claude needs your permission',
      promptId: 'a7c849b6-361e-4cf8-84c8-7f387f16fafc', ...forwarded('19616213-277c-4e70-9909-9883230a3394'),
    })
  })

  it('Notification idle_prompt / quota_auto_resume_* / agent_needs_input -> idle / quota / agent-input; every other type -> nothing', () => {
    // Types from the binary's string table and the hooks reference (only permission_prompt was captured)
    const base = { ...captured(C), prompt_id: 'p', hook_event_name: 'Notification' }
    const kindOf = (notification_type: string, message = 'msg') => runHook({ ...base, notification_type, message })?.kind ?? null
    expect(kindOf('idle_prompt', 'Claude is waiting for your input')).toBe('idle')
    expect(kindOf('quota_auto_resume_fired')).toBe('quota')
    expect(kindOf('quota_auto_resume_stale')).toBe('quota')
    expect(kindOf('quota_auto_resume_disabled')).toBe('quota')
    expect(kindOf('agent_needs_input')).toBe('agent-input')
    for (const ignored of ['auth_success', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_completed', 'worker_permission_prompt', 'push_notification', 'model_refusal_fallback', 'plugin_notification', '']) {
      expect(kindOf(ignored), ignored).toBeNull()
    }
    expect(runHook({ ...base, notification_type: 'idle_prompt', message: 'm'.repeat(500) })?.message).toHaveLength(200)
  })

  it('StopFailure -> session_error {error, detail} (shape from the hooks reference; never fired locally)', () => {
    expect(runHook({
      ...captured(C), prompt_id: 'p', hook_event_name: 'StopFailure',
      error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error: Rate limit reached',
    })).toEqual({ type: 'session_error', error: 'rate_limit', detail: '429 Too Many Requests', promptId: 'p', ...forwarded(C) })
    // Without details the rendered error text is the detail; without either, an empty one
    expect(runHook({ ...captured(C), hook_event_name: 'StopFailure', error: 'overloaded', last_assistant_message: 'API Error: Overloaded' }))
      .toMatchObject({ error: 'overloaded', detail: 'API Error: Overloaded' })
    expect(runHook({ ...captured(C), hook_event_name: 'StopFailure' })).toMatchObject({ error: 'unknown', detail: '' })
    expect(runHook({ ...captured(C), hook_event_name: 'StopFailure', error: 'server_error', error_details: 'd'.repeat(500) })?.detail).toHaveLength(200)
  })

  it('PreCompact -> session_compact pre; PostCompact -> post, and the summary text stays behind', () => {
    expect(runHook({
      ...captured(C), prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null,
    })).toEqual({ type: 'session_compact', phase: 'pre', trigger: 'manual', promptId: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', ...forwarded(C) })

    const ev = runHook({
      ...captured(C), prompt_id: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', hook_event_name: 'PostCompact', trigger: 'manual',
      compact_summary: '<analysis>\nThe conversation has three parts. The user first asked for two subagents: a background general-purpose agent described as "Count etc" to run `ls /etc | wc -l`, and a foreground Explore agent described as "Find hostname" to read `/etc/hostname`. ...',
    })
    expect(ev).toEqual({ type: 'session_compact', phase: 'post', trigger: 'manual', promptId: 'e40b57ac-50aa-4bae-a043-8852cc9ba9c7', ...forwarded(C) })
    expect(JSON.stringify(ev)).not.toContain('Count etc')
    expect(runHook({ ...captured(C), hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null })).toMatchObject({ phase: 'pre', trigger: 'auto' })
  })

  it('PostToolBatch on the main thread -> session_tool_done {batch, count}; inside a worker -> nothing', () => {
    // Captured: the batch that launched the background and the foreground agent (session c25c5511)
    expect(runHook({
      ...captured(C), prompt_id: '60d87662-ef42-4452-a6bd-cd9718825c5b', permission_mode: 'bypassPermissions', effort: { level: 'medium' },
      hook_event_name: 'PostToolBatch',
      tool_calls: [
        { tool_name: 'Agent', tool_input: { description: 'Count etc', prompt: 'Run ls /etc | wc -l with Bash and report it.', subagent_type: 'general-purpose', run_in_background: true }, tool_use_id: 'toolu_01BqtWPXox4wWP2tR2CS8jVE', tool_response: [{ type: 'text', text: 'Async agent launched successfully. ...' }] },
        { tool_name: 'Agent', tool_input: { description: 'Find hostname', prompt: 'Read /etc/hostname and report it.', subagent_type: 'Explore', run_in_background: false }, tool_use_id: 'toolu_01GxFiqPkJRKxd5Qkyus2tLN', tool_response: [{ type: 'text', text: '[Subagent hand-back] ...' }] },
      ],
    })).toEqual({ type: 'session_tool_done', batch: true, count: 2, promptId: '60d87662-ef42-4452-a6bd-cd9718825c5b', ...forwarded(C) })
    // The denied Write's batch in a headless session (captured, session 4a9dd43b): one call, answered "you haven't granted it yet"
    expect(runHook({
      ...captured('4a9dd43b-f941-406a-809a-01149a62b597'), prompt_id: '273fe3a9-5b8d-4724-bb83-0c5e06bca880', permission_mode: 'default', effort: { level: 'medium' },
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Write', tool_input: { file_path: `${HOOKCAP}/probe.txt`, content: 'hello' }, tool_use_id: 'toolu_01W', tool_response: `Claude requested permissions to write to ${HOOKCAP}/probe.txt, but you haven't granted it yet.` }],
    })).toMatchObject({ type: 'session_tool_done', batch: true, count: 1 })
    // Inside a subagent (captured shape: agent_id + agent_type on the batch)
    expect(runHook({
      ...captured(C), prompt_id: 'p', permission_mode: 'bypassPermissions', agent_id: 'a027f376ae8cdcbd0', agent_type: 'Explore', effort: { level: 'medium' },
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Read', tool_input: { file_path: '/etc/hostname' }, tool_use_id: 'toolu_01XaBQyUGgXLSCM8GdEpBHFk', tool_response: '1\tvm\n2\t' }],
    })).toBeNull()
    expect(runHook({ ...captured(C), hook_event_name: 'PostToolBatch' })).toMatchObject({ type: 'session_tool_done', batch: true, count: 0 })
  })

  it('CwdChanged -> session_cwd with the new cwd and project (the payload\'s own cwd is still the old one)', () => {
    expect(runHook({
      ...captured('7d77f597-b547-42f9-823a-50fc2ecdbf3b'), prompt_id: 'd66959d4-65e0-4b8b-8b59-3e2796c5fb1a', hook_event_name: 'CwdChanged',
      old_cwd: HOOKCAP, new_cwd: '/tmp',
    })).toEqual({
      type: 'session_cwd', cwd: '/tmp', project: 'tmp', oldCwd: HOOKCAP, promptId: 'd66959d4-65e0-4b8b-8b59-3e2796c5fb1a',
      sessionId: '7d77f597-b547-42f9-823a-50fc2ecdbf3b', transcriptPath: `${PROJECTS}/7d77f597-b547-42f9-823a-50fc2ecdbf3b.jsonl`,
    })
    expect(runHook({ ...captured(C), hook_event_name: 'CwdChanged', old_cwd: HOOKCAP, new_cwd: '/' })).toMatchObject({ cwd: '/', project: '/' })
    expect(runHook({ ...captured(C), hook_event_name: 'CwdChanged', old_cwd: HOOKCAP })).toBeNull()
  })

  it('PostModelSwitch -> session_model {model, fromModel, switchSource} (shape from the schema; never fired locally)', () => {
    expect(runHook({
      ...captured(C), prompt_id: 'p', hook_event_name: 'PostModelSwitch',
      from_model: 'claude-haiku-5-5', to_model: 'claude-opus-4-1', requested_model: 'opus', source: 'command', context_tokens: 44052, prompt_cache_warm: true, cache_ttl: '5m',
    })).toEqual({ type: 'session_model', model: 'claude-opus-4-1', fromModel: 'claude-haiku-5-5', switchSource: 'command', promptId: 'p', ...forwarded(C) })
    expect(runHook({ ...captured(C), hook_event_name: 'PostModelSwitch', to_model: 'claude-sonnet-4-5', source: 'auto' })).toMatchObject({ model: 'claude-sonnet-4-5', switchSource: 'auto' })
    expect(runHook({ ...captured(C), hook_event_name: 'PostModelSwitch', from_model: 'x' })).toBeNull()
  })

  it('Setup and InstructionsLoaded -> nothing, like every other event the office does not listen to', () => {
    expect(runHook({ ...captured('149f6824-9a0a-4031-beff-0864614b9005'), hook_event_name: 'Setup', trigger: 'init' })).toBeNull()
    expect(runHook({ ...captured('10690f0a-fe94-4e15-9a2d-b59573025579'), hook_event_name: 'Setup', trigger: 'maintenance' })).toBeNull()
    expect(runHook({
      ...captured('7d77f597-b547-42f9-823a-50fc2ecdbf3b'), hook_event_name: 'InstructionsLoaded',
      file_path: `${HOOKCAP}/CLAUDE.md`, memory_type: 'Project', load_reason: 'session_start',
    })).toBeNull()
    for (const hook_event_name of ['MessageDisplay', 'ConfigChange', 'UserPromptExpansion', 'PreModelSwitch', 'PermissionDenied', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'Elicitation', 'ElicitationResult', 'WorktreeCreate', 'WorktreeRemove', 'FileChanged', 'DirectoryAdded']) {
      expect(runHook({ ...captured(C), prompt_id: 'p', hook_event_name }), hook_event_name).toBeNull()
    }
  })

  it('every main-thread event without a session id prints nothing', () => {
    for (const payload of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'hello', prompt_id: 'p' },
      { hook_event_name: 'Stop', last_assistant_message: 'x', background_tasks: [], session_crons: [] },
      { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/x' } },
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' },
      { hook_event_name: 'StopFailure', error: 'rate_limit' },
      { hook_event_name: 'PreCompact', trigger: 'manual' },
      { hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' },
      { hook_event_name: 'PostToolBatch', tool_calls: [] },
      { hook_event_name: 'CwdChanged', old_cwd: '/a', new_cwd: '/b' },
      { hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'b', source: 'command' },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: 'ok' },
    ]) {
      expect(runHook(payload), payload.hook_event_name).toBeNull()
    }
  })
})

/**
 * The whole script, with a fake `curl` on PATH that records its argv. The
 * payload reaches the Python on stdin, stdout stays empty (on UserPromptSubmit
 * it would be injected into Claude's context) and the exit code is 0.
 */
describe('agent-tracker.sh: the bash wrapper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-office-tracker-'))
  const bin = join(dir, 'bin')
  const officeHome = join(dir, 'office')
  const log = join(dir, 'curl.jsonl')
  mkdirSync(bin)
  mkdirSync(officeHome)
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\npython3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@" >> "$FAKE_CURL_LOG"\n`)
  chmodSync(join(bin, 'curl'), 0o755)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  /** Run the script on a payload; resolve with its stdout/status and what curl was given (the POST is backgrounded). */
  async function runScript(payload: unknown, extraEnv: Record<string, string> = {}) {
    rmSync(log, { force: true })
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_OFFICE_HOME: officeHome, FAKE_CURL_LOG: log }
    // The caller's own office settings must not leak into the script under test
    delete env.AGENT_OFFICE_EVENT_URL
    delete env.AGENT_OFFICE_PORT
    Object.assign(env, extraEnv)
    const res = spawnSync('bash', [TRACKER], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env,
    })
    // The fake curl's `>>` creates the log before its python has written the
    // line, so wait for a complete line, not just for the file (a read in that
    // window parsed '' and failed under full-suite load)
    const complete = () => existsSync(log) && readFileSync(log, 'utf8').endsWith('\n')
    for (let i = 0; i < 60 && !complete(); i++) await sleep(50)
    const calls = complete() ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]) : []
    const args = calls[0] ?? null
    const body = args ? JSON.parse(args[args.indexOf('-d') + 1]) : null
    return { stdout: res.stdout, stderr: res.stderr, status: res.status, calls, args, body }
  }

  const session = { session_id: 's-wrap', cwd: '/home/me/proj', transcript_path: '/t/s-wrap.jsonl' }

  it('UserPromptSubmit: nothing on stdout, exit 0, the session_prompt goes to curl as one JSON body', async () => {
    const run = await runScript({ ...session, prompt_id: 'p1', hook_event_name: 'UserPromptSubmit', prompt: 'fix the bug' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.calls).toHaveLength(1)
    expect(run.args?.slice(0, 4)).toEqual(['-sf', '-X', 'POST', 'http://localhost:3334/event'])
    expect(run.body).toEqual({ type: 'session_prompt', text: 'fix the bug', isWakeup: false, promptId: 'p1', sessionId: 's-wrap', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-wrap.jsonl' })
    // No token file: no Authorization header
    expect(run.args).not.toContain(expect.stringMatching(/^Authorization/))
  })

  it('a 300 KB tool_response reaches the Python (stdin, not an argument that would fail with E2BIG) and leaves as a 120-char result', async () => {
    const run = await runScript({
      ...session, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'toolu_BIG',
      tool_input: { description: 'Read everything', subagent_type: 'general-purpose' },
      tool_response: { status: 'completed', content: [{ type: 'text', text: 'x'.repeat(300_000) }] },
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.body).toMatchObject({ type: 'agent_completed', agentId: 'agent-toolu_BIG', sessionId: 's-wrap' })
    expect(run.body.result).toHaveLength(120)
  })

  it('sends the bearer token from $AGENT_OFFICE_HOME/auth-token when there is one; an ignored event never calls curl', async () => {
    writeFileSync(join(officeHome, 'auth-token'), 'secret-token\n')
    try {
      const run = await runScript({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } })
      expect(run.status).toBe(0)
      expect(run.args).toContain('Authorization: Bearer secret-token')
      expect(run.body).toMatchObject({ type: 'agent_working', status: 'reading y.js' })

      const quiet = await runScript({ ...session, hook_event_name: 'Setup', trigger: 'init' })
      expect(quiet.status).toBe(0)
      expect(quiet.stdout).toBe('')
      expect(quiet.calls).toEqual([])
    } finally {
      rmSync(join(officeHome, 'auth-token'), { force: true })
    }
  })

  it('posts to AGENT_OFFICE_EVENT_URL when set, else to localhost:$AGENT_OFFICE_PORT/event, else to port 3334', async () => {
    const read = { ...session, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/y.js' } }
    expect((await runScript(read)).args?.[3]).toBe('http://localhost:3334/event')
    expect((await runScript(read, { AGENT_OFFICE_PORT: '3998' })).args?.[3]).toBe('http://localhost:3998/event')
    expect((await runScript(read, { AGENT_OFFICE_PORT: '3998', AGENT_OFFICE_EVENT_URL: 'http://127.0.0.1:4100/event' })).args?.[3]).toBe('http://127.0.0.1:4100/event')
  })

  it('a deploy: the signals ride on the one JSON body the call sends, stdout stays empty, exit 0', async () => {
    const run = await runScript({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'vercel deploy --prod' } })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
    expect(run.calls).toHaveLength(1)
    expect(run.body).toMatchObject({
      type: 'agent_working', status: 'running: vercel deploy --prod', sessionId: 's-wrap',
      signals: [{ kind: 'deploy_start', target: 'proj', command: 'vercel deploy --prod' }],
    })
  })
})

/**
 * Answering a permission dialog from the office (server/permissions.js). With
 * the marker file present the Python adds answerable / permissionMode /
 * suggestions / detail and a second `wait` line; the wrapper then POSTs in the
 * foreground and long-polls GET /permission/<id> with the real curl against a
 * tiny Node server, printing the server's hookOutput verbatim on allowed or
 * denied and nothing otherwise. Without the marker nothing changes.
 */
describe('agent-tracker.sh: answering a permission from the office', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-office-answer-'))
  writeFileSync(join(home, 'answer-permissions'), 'on\n')
  writeFileSync(join(home, 'auth-token'), 'office-token\n')
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const session = { session_id: 's-perm', cwd: '/home/me/proj', transcript_path: '/t/s-perm.jsonl', prompt_id: 'p1', permission_mode: 'default' }
  const SUGGESTIONS = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const write = { ...session, hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/home/me/proj/probe.txt', content: 'hello' }, permission_suggestions: SUGGESTIONS }
  const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }

  it('the Python: with the marker the event gains answerable, permissionMode, suggestions and detail, and a `wait` line follows; without it, the event is as before on one line', () => {
    const lines = runHookLines(write, { AGENT_OFFICE_HOME: home })
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({
      type: 'session_needs_you', kind: 'permission', toolName: 'Write', summary: 'probe.txt',
      answerable: true, permissionMode: 'default', suggestions: SUGGESTIONS, detail: '/home/me/proj/probe.txt',
      promptId: 'p1', sessionId: 's-perm', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-perm.jsonl',
    })
    expect(lines[1]).toBe('wait')

    const plain = runHookLines(write)
    expect(plain).toHaveLength(1)
    expect(JSON.parse(plain[0])).toEqual({
      type: 'session_needs_you', kind: 'permission', toolName: 'Write', summary: 'probe.txt',
      promptId: 'p1', sessionId: 's-perm', project: 'proj', cwd: '/home/me/proj', transcriptPath: '/t/s-perm.jsonl',
    })
    // No session id: nothing at all, marker or not
    expect(runHookLines({ ...write, session_id: undefined }, { AGENT_OFFICE_HOME: home })).toEqual([])
    // Only PermissionRequest ever gets the second line
    expect(runHookLines({ ...session, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' }, { AGENT_OFFICE_HOME: home })).toHaveLength(1)
    expect(runHookLines({ ...session, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x' } }, { AGENT_OFFICE_HOME: home })).toHaveLength(1)
  })

  it('the Python: detail is the Bash command (newlines kept), the file path of a file tool, else the tool input as compact JSON, clamped to 400; suggestions keep their shape, at most 4', () => {
    const ev = (payload: unknown) => JSON.parse(runHookLines(payload, { AGENT_OFFICE_HOME: home })[0])
    const base = { ...session, hook_event_name: 'PermissionRequest' }
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf\n  node_modules', description: 'd' } })).toMatchObject({ summary: 'rm -rf node_modules', detail: 'rm -rf\n  node_modules' })
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'x'.repeat(1000) } }).detail).toHaveLength(400)
    expect(ev({ ...base, tool_name: 'Edit', tool_input: { file_path: '/repo/src/App.tsx', old_string: 'a', new_string: 'b' } }).detail).toBe('/repo/src/App.tsx')
    expect(ev({ ...base, tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } }).detail).toBe('/n.ipynb')
    expect(ev({ ...base, tool_name: 'WebFetch', tool_input: { url: 'https://x.test', prompt: 'read it' } }).detail).toBe('{"url":"https://x.test","prompt":"read it"}')
    expect(ev({ ...base, tool_name: 'WebFetch', tool_input: null })).toMatchObject({ detail: '{}', suggestions: [], permissionMode: 'default' })
    const addRules = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: [addRules, 'junk', ...new Array(6).fill(SUGGESTIONS[0])] }).suggestions)
      .toEqual([addRules, SUGGESTIONS[0], SUGGESTIONS[0], SUGGESTIONS[0]])
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [{ mode: 'm'.repeat(500) }] }).suggestions[0].mode).toHaveLength(200)
    expect(ev({ ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'acceptEdits' }).permissionMode).toBe('acceptEdits')
  })

  // ── The wrapper against a tiny office ────────────────────────────────────
  type Hit = { method: string; url: string; auth?: string; body: string }

  /** A fake office: `plan` answers each request in order of arrival (POST /event first, then the polls). */
  async function fakeOffice(plan: Array<(hit: Hit, res: import('node:http').ServerResponse) => void>) {
    const { createServer } = await import('node:http')
    const hits: Hit[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const hit = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body }
        hits.push(hit)
        const step = plan[hits.length - 1] ?? plan[plan.length - 1]
        step(hit, res)
      })
    })
    await new Promise<void>(res => server.listen(0, '127.0.0.1', () => res()))
    const port = (server.address() as import('node:net').AddressInfo).port
    return { port, hits, close: () => new Promise<void>(res => server.close(() => res())) }
  }
  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  /**
   * The whole script with the real curl, pointed at the fake office. Spawned
   * asynchronously: the fake office lives on this event loop, so a spawnSync
   * would starve it and every curl would time out.
   */
  function runLive(payload: unknown, port: number, extraEnv: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(port) }
    delete env.AGENT_OFFICE_EVENT_URL
    Object.assign(env, extraEnv)
    const started = Date.now()
    return new Promise<{ stdout: string; stderr: string; status: number | null; ms: number }>((resolve, reject) => {
      const child = spawn('bash', [TRACKER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', c => { stdout += c })
      child.stderr.setEncoding('utf8').on('data', c => { stderr += c })
      child.on('error', reject)
      child.on('close', status => resolve({ stdout, stderr, status, ms: Date.now() - started }))
      child.stdin.end(JSON.stringify(payload))
    })
  }

  it('allowed: the POST goes in the foreground with the token, the poll carries the token, and the hookOutput is printed verbatim', async () => {
    const office = await fakeOffice([
      (hit, res) => json(res, 200, { ok: true, permissionId: 'abc123', wait: { pollMs: 2000, deadline: Date.now() + 60_000 } }),
      (hit, res) => json(res, 200, { status: 'allowed', deadline: Date.now() + 60_000, hookOutput: ALLOW }),
    ])
    try {
      const run = await runLive(write, office.port)
      expect(run.status).toBe(0)
      expect(run.stderr).toBe('')
      expect(JSON.parse(run.stdout)).toEqual(ALLOW)
      expect(run.stdout.trim().split('\n')).toHaveLength(1)
      expect(office.hits.map(h => [h.method, h.url])).toEqual([['POST', '/event'], ['GET', '/permission/abc123?wait=2']])
      expect(office.hits[0].auth).toBe('Bearer office-token')
      expect(office.hits[1].auth).toBe('Bearer office-token')
      expect(JSON.parse(office.hits[0].body)).toMatchObject({ type: 'session_needs_you', answerable: true, suggestions: SUGGESTIONS })
    } finally {
      await office.close()
    }
  })

  it('keeps polling while the server says pending (the deadline may move) and prints a deny verbatim', async () => {
    const DENY = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from Claude Office', interrupt: false } } }
    const office = await fakeOffice([
      (hit, res) => json(res, 200, { ok: true, permissionId: 'p2', wait: { pollMs: 1000, deadline: Date.now() + 60_000 } }),
      (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() + 60_000 }),
      (hit, res) => json(res, 200, { status: 'pending', deadline: Date.now() + 600_000 }),
      (hit, res) => json(res, 200, { status: 'denied', deadline: Date.now() + 600_000, hookOutput: DENY }),
    ])
    try {
      const run = await runLive(write, office.port)
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout)).toEqual(DENY)
      expect(office.hits).toHaveLength(4)
      expect(office.hits.slice(1).every(h => h.url === '/permission/p2?wait=1')).toBe(true)
    } finally {
      await office.close()
    }
  })

  it('prints nothing on resolved_elsewhere, expired, a 404, a pending answer past the deadline, or a reply without a permissionId', async () => {
    for (const second of [
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 200, { status: 'resolved_elsewhere', deadline: Date.now() + 60_000 }),
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 200, { status: 'expired', deadline: Date.now() - 1 }),
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 404, { error: 'Unknown permission' }),
      (hit: Hit, res: import('node:http').ServerResponse) => json(res, 200, { status: 'pending', deadline: Date.now() - 5_000 }),
    ]) {
      const office = await fakeOffice([
        (hit, res) => json(res, 200, { ok: true, permissionId: 'p3', wait: { pollMs: 1000, deadline: Date.now() + 60_000 } }),
        second,
      ])
      try {
        const run = await runLive(write, office.port)
        expect(run.status).toBe(0)
        expect(run.stdout).toBe('')
        expect(run.stderr).toBe('')
        expect(office.hits).toHaveLength(2)
      } finally {
        await office.close()
      }
    }
    // An older server (or the setting off): a plain {ok} means no wait at all
    const plain = await fakeOffice([(hit, res) => json(res, 200, { ok: true })])
    try {
      const run = await runLive(write, plain.port)
      expect(run.stdout).toBe('')
      expect(plain.hits).toHaveLength(1)
    } finally {
      await plain.close()
    }
  })

  it('server down: exits 0 at once with nothing printed; without the marker a PermissionRequest never waits even with the server up', async () => {
    // Nothing listens on this port
    const probe = await fakeOffice([])
    const deadPort = probe.port
    await probe.close()
    const down = await runLive(write, deadPort)
    expect(down.status).toBe(0)
    expect(down.stdout).toBe('')
    expect(down.ms).toBeLessThan(5_000)

    // A server that never answers: with the marker gone the POST is the usual
    // backgrounded one (--max-time 1) and the script returns without waiting
    const noMarker = mkdtempSync(join(tmpdir(), 'agent-office-nomarker-'))
    const hanging = await fakeOffice([() => { /* never responds */ }])
    try {
      const run = await runLive(write, hanging.port, { AGENT_OFFICE_HOME: noMarker })
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.ms).toBeLessThan(3_000)
    } finally {
      await hanging.close()
      rmSync(noMarker, { recursive: true, force: true })
    }
  })

  it('never blocks any other event: a PostToolUse with the marker present is backgrounded even when the server hangs', async () => {
    const hanging = await fakeOffice([() => { /* never responds */ }])
    try {
      const run = await runLive({ ...session, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/x' }, tool_response: 'ok' }, hanging.port)
      expect(run.status).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.ms).toBeLessThan(3_000)
      const prompt = await runLive({ ...session, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, hanging.port)
      expect(prompt.stdout).toBe('')
      expect(prompt.ms).toBeLessThan(3_000)
    } finally {
      await hanging.close()
    }
  })
})

/**
 * Signals: what a Bash command means (the "Signals" section of the Python).
 * classify_command is pure, so its table is driven directly: the heredoc is
 * run with a tool-less payload (it defines everything and exits), the
 * classifier is loaded the way the hook loads it (load_signals) and called.
 * The rest drives whole payloads through the Python like every test above.
 */
describe('agent-tracker.sh: signals', () => {
  const DRIVER = [
    'import io, json, sys',
    'job = json.loads(sys.stdin.read())',
    "ns = {'__name__': '__main__'}",
    "sys.stdin = io.StringIO(json.dumps(job.get('payload') or {'tool_name': 'x'}))",
    'sys.stdout, real = io.StringIO(), sys.stdout',
    'try:',
    "    exec(compile(job['src'], 'agent-tracker', 'exec'), ns)",
    'except SystemExit:',
    '    pass',
    'sys.stdout = real',
    "loaded = ns.get('SIGNALS_LOADED')",
    "if job.get('commands') is not None:",
    "    ns['load_signals']()",
    "print(json.dumps({'classified': [ns['classify_command'](c, job.get('cwd')) for c in job.get('commands') or []],",
    "                  'prefilter': [ns['might_signal'](c) for c in job.get('commands') or []],",
    "                  'loaded': loaded}))",
  ].join('\n')

  function drive(job: Record<string, unknown>) {
    const out = execFileSync('python3', ['-I', '-c', DRIVER], {
      input: JSON.stringify({ src: PYTHON, ...job }),
      encoding: 'utf8',
      env: { ...process.env, AGENT_OFFICE_HOME: NO_MARKER_HOME },
    })
    return JSON.parse(out) as { classified: Array<Array<Record<string, unknown>>>; prefilter: boolean[]; loaded: boolean }
  }

  /** command -> what classify_command returns for it (cwd /home/me/api) */
  const TABLE: Array<[string, Array<Record<string, unknown>>]> = [
    // deploy
    ['vercel deploy --prod', [{ kind: 'deploy' }]],
    ['vercel --prod', [{ kind: 'deploy' }]],
    ['netlify deploy --prod', [{ kind: 'deploy' }]],
    ['fly deploy -a shop-api', [{ kind: 'deploy', target: 'shop-api' }]],
    ['flyctl deploy', [{ kind: 'deploy' }]],
    ['railway up', [{ kind: 'deploy' }]],
    ['heroku container:push web -a shop', [{ kind: 'deploy', target: 'shop' }]],
    ['gcloud run deploy api --region europe-west1', [{ kind: 'deploy', target: 'api' }]],
    ['gcloud app deploy app.yaml', [{ kind: 'deploy' }]],
    ['aws cloudformation deploy --stack-name billing', [{ kind: 'deploy', target: 'billing' }]],
    ['sam deploy', [{ kind: 'deploy' }]],
    ['serverless deploy --stage prod', [{ kind: 'deploy' }]],
    ['sls deploy', [{ kind: 'deploy' }]],
    ['kubectl apply -f k8s/', [{ kind: 'deploy' }]],
    ['kubectl -n prod rollout restart deployment/api', [{ kind: 'deploy', target: 'api' }]],
    ['helm upgrade --install web ./chart', [{ kind: 'deploy', target: 'web' }]],
    ['terraform -chdir=infra apply -auto-approve', [{ kind: 'deploy', target: 'infra' }]],
    ['pulumi up -s prod --yes', [{ kind: 'deploy', target: 'prod' }]],
    ['npx cdk deploy', [{ kind: 'deploy' }]],
    ['wrangler deploy', [{ kind: 'deploy' }]],
    ['npx wrangler publish', [{ kind: 'deploy' }]],
    ['firebase deploy --only hosting', [{ kind: 'deploy' }]],
    ['npm publish', [{ kind: 'deploy' }]],
    ['gh release create v1.4.0 --generate-notes', [{ kind: 'deploy' }]],
    ['docker push ghcr.io/me/api:1.4', [{ kind: 'deploy', target: 'api' }]],
    ['git push origin v1.4.0', [{ kind: 'deploy' }]],
    ['git push --tags', [{ kind: 'deploy' }]],
    // build
    ['npm run build', [{ kind: 'build' }]],
    ['npm run build:electron', [{ kind: 'build' }]],
    ['pnpm build', [{ kind: 'build' }]],
    ['pnpm --filter web build', [{ kind: 'build', target: 'web' }]],
    ['yarn build', [{ kind: 'build' }]],
    ['vite build', [{ kind: 'build' }]],
    ['tsc', [{ kind: 'build' }]],
    ['tsc --noEmit', [{ kind: 'build' }]],
    ['tsc -p packages/api/tsconfig.json', [{ kind: 'build', target: 'api' }]],
    ['next build', [{ kind: 'build' }]],
    ['cargo build --release', [{ kind: 'build' }]],
    ['go build ./...', [{ kind: 'build' }]],
    ['make', [{ kind: 'build' }]],
    ['make -j 8 -C services/api', [{ kind: 'build', target: 'api' }]],
    ['./gradlew assemble', [{ kind: 'build' }]],
    ['mvn package -DskipTests', [{ kind: 'build' }]],
    ['docker build -t api .', [{ kind: 'build', target: 'api' }]],
    ['webpack --mode production', [{ kind: 'build' }]],
    ['esbuild src/main.ts --bundle --outdir=dist', [{ kind: 'build' }]],
    // test
    ['npm test', [{ kind: 'test' }]],
    ['npm run test:unit', [{ kind: 'test' }]],
    ['npm t', [{ kind: 'test' }]],
    ['npx vitest run', [{ kind: 'test' }]],
    ['jest --ci', [{ kind: 'test' }]],
    ['pytest -q tests/', [{ kind: 'test' }]],
    ['python3 -m pytest', [{ kind: 'test' }]],
    ['uv run pytest', [{ kind: 'test' }]],
    ['cargo test -p core', [{ kind: 'test', target: 'core' }]],
    ['go test ./...', [{ kind: 'test' }]],
    ['mvn test', [{ kind: 'test' }]],
    ['gradle test', [{ kind: 'test' }]],
    ['bundle exec rspec', [{ kind: 'test' }]],
    ['vendor/bin/phpunit', [{ kind: 'test' }]],
    ['npx playwright test', [{ kind: 'test' }]],
    ['make test', [{ kind: 'test' }]],
    // push
    ['git push origin main', [{ kind: 'push', branch: 'main', toDefault: true }]],
    ['git push origin HEAD:master', [{ kind: 'push', branch: 'master', toDefault: true }]],
    ['git push -u origin feature/x', [{ kind: 'push', branch: 'feature/x', toDefault: false }]],
    ['git push', [{ kind: 'push' }]],
    ['git push origin main --follow-tags', [{ kind: 'deploy' }, { kind: 'push', branch: 'main', toDefault: true }]],
    // stripped prefixes, chains, directories
    ['FOO=1 sudo -E npx --yes vitest run', [{ kind: 'test' }]],
    ['timeout 120 npm test', [{ kind: 'test' }]],
    ['cd packages/web && npm run build', [{ kind: 'build', target: 'web' }]],
    ['(cd ../billing && npm test)', [{ kind: 'test', target: 'billing' }]],
    ['npm test --prefix /tmp/nonexistent-project', [{ kind: 'test', target: 'nonexistent-project' }]],
    ['npm run build && git push origin main', [{ kind: 'build' }, { kind: 'push', branch: 'main', toDefault: true }]],
    ['npm run lint; npm test 2>&1 | tail -20', [{ kind: 'test' }]],
    ['npm run build && npm run build:electron', [{ kind: 'build' }]],
    // false-positive guards
    ['echo deploy && false', []],
    ['git commit -m "deploy; npm test && git push origin main"', []],
    ["cat <<'EOF' > notes.md\nnpm test\nvercel deploy --prod\nEOF", []],
    ['echo $(npm test)', []],
    ['make clean', []],
    ['npm run lint', []],
    ['npm run builder', []],
    ['npm install', []],
    ['vercel env pull', []],
    ['terraform plan', []],
    ['kubectl get pods', []],
    ['aws s3 sync deploy s3://bucket', []],
    ['npm publish --dry-run', []],
    ['git push --dry-run origin main', []],
    ['git push --delete origin old-branch', []],
    ['tsc --version', []],
    ['grep -rn "npm test" docs/', []],
    ['git status && git log --oneline -5', []],
    ['ls /etc | wc -l', []],
  ]

  it('classify_command: the pattern table, chains, stripped prefixes and the false-positive guards', () => {
    const { classified } = drive({ commands: TABLE.map(([c]) => c), cwd: '/home/me/api' })
    const got = TABLE.map(([command], i) => [command, classified[i]])
    expect(got).toEqual(TABLE)
  })

  it('the prefilter lets every command the table classifies through, and keeps the classifier unloaded for the rest', () => {
    const { prefilter } = drive({ commands: TABLE.map(([c]) => c) })
    TABLE.forEach(([command, expected], i) => {
      if (expected.length) expect(prefilter[i], command).toBe(true)
    })
    expect(drive({ commands: ['git status', 'ls -la', 'cat README.md', 'sed -n 1,20p x'] }).prefilter).toEqual([false, false, false, false])
    // An ordinary Bash call never compiles the classifier at all; a test run does
    const plain = { session_id: 's', cwd: '/home/me/api', hook_event_name: 'PreToolUse', tool_name: 'Bash' }
    expect(drive({ payload: { ...plain, tool_input: { command: 'git status' } } }).loaded).toBe(false)
    expect(drive({ payload: { ...plain, tool_input: { command: 'npm test' } } }).loaded).toBe(true)
  })

  // The capture session these payloads borrow their shape from (2.1.300:
  // Bash PreToolUse / PostToolUse / PostToolUseFailure keys, the error as
  // "Exit code N\n<output>", the tool_response object)
  const base = {
    session_id: '17f46010-d2b1-4d95-bdde-34994b4b1d00',
    transcript_path: '/root/.claude/projects/-home-me-api/17f46010-d2b1-4d95-bdde-34994b4b1d00.jsonl',
    cwd: '/home/me/api',
    prompt_id: '47795df5-e84a-4a57-8884-078b1e761a82',
    permission_mode: 'bypassPermissions',
    effort: { level: 'medium' },
  }
  const session = { sessionId: base.session_id, project: 'api', cwd: base.cwd, transcriptPath: base.transcript_path }
  const bash = (command: string, extra: Record<string, unknown> = {}) => ({ ...base, tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_use_id: 'toolu_01SIG', ...extra })

  it('a deploy: PreToolUse -> deploy_start on agent_working, PostToolUse -> deploy_success on session_tool_done, PostToolUseFailure -> deploy_fail with the error', () => {
    expect(runHook(bash('vercel deploy --prod', { hook_event_name: 'PreToolUse' }))).toEqual({
      type: 'agent_working', status: 'running: vercel deploy --prod', tool: 'Bash',
      signals: [{ kind: 'deploy_start', target: 'api', command: 'vercel deploy --prod' }],
      ...session,
    })
    expect(runHook(bash('vercel deploy --prod', {
      hook_event_name: 'PostToolUse',
      tool_response: { stdout: 'Production: https://api-7f3k.vercel.app [42s]', stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      duration_ms: 42_113,
    }))).toEqual({
      type: 'session_tool_done', toolName: 'Bash', promptId: base.prompt_id,
      signals: [{ kind: 'deploy_success', target: 'api', command: 'vercel deploy --prod' }],
      ...session,
    })
    expect(runHook(bash('vercel deploy --prod', {
      hook_event_name: 'PostToolUseFailure',
      error: 'Exit code 1\nVercel CLI 39.1.0\n\nError: Deployment failed: the build step exited with 1\n',
      is_interrupt: false,
      duration_ms: 31_870,
    }))).toEqual({
      type: 'agent_working', status: 'failed: Bash — Exit code 1 Vercel CLI 39.1.0 Error: Deployment failed: the ', failed: true, tool: 'Bash',
      signals: [{
        kind: 'deploy_fail', target: 'api', command: 'vercel deploy --prod',
        error: 'Error: Deployment failed: the build step exited with 1', exitCode: 1,
      }],
      ...session,
    })
  })

  it('a failing `vitest run`: test_failed with the first meaningful line, the exit code and "3 failing"', () => {
    const ev = runHook(bash('npx vitest run', {
      hook_event_name: 'PostToolUseFailure',
      error: [
        'Exit code 1', '', ' RUN  v3.2.4 /home/me/api', '',
        ' ❯ tests/parser.test.ts (12 tests | 3 failed) 41ms',
        '   × parses dates 9ms',
        ' FAIL  tests/parser.test.ts > parses dates',
        'AssertionError: expected 2 to be 3',
        '',
        ' Test Files  1 failed | 30 passed (31)',
        '      Tests  3 failed | 593 passed (596)',
      ].join('\n'),
      is_interrupt: false,
    }))
    expect(ev?.signals).toEqual([{
      kind: 'test_failed', target: 'api', command: 'npx vitest run',
      error: '❯ tests/parser.test.ts (12 tests | 3 failed) 41ms', exitCode: 1, detail: '3 failing',
    }])
  })

  it('a chained `npm run build && git push origin main`: both start; both land; a failure is blamed on the segment the output points at', () => {
    const cmd = 'npm run build && git push origin main'
    expect(runHook(bash(cmd, { hook_event_name: 'PreToolUse' }))?.signals).toEqual([
      { kind: 'build_start', target: 'api', command: cmd },
      { kind: 'push', target: 'api', branch: 'main', toDefault: true, command: cmd },
    ])
    expect(runHook(bash(cmd, { hook_event_name: 'PostToolUse', tool_response: { stdout: '✓ built in 2.1s', stderr: '' } }))?.signals).toEqual([
      { kind: 'build_ok', target: 'api', command: cmd },
      { kind: 'push_done', target: 'api', branch: 'main', toDefault: true, command: cmd },
    ])
    // tsc failed: the push never ran, so it says nothing
    expect(runHook(bash(cmd, {
      hook_event_name: 'PostToolUseFailure',
      error: "Exit code 2\nsrc/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/db.ts(9,1): error TS2304: Cannot find name 'pool'.\n\nFound 2 errors in 2 files.",
      is_interrupt: false,
    }))?.signals).toEqual([{
      kind: 'build_failed', target: 'api', command: cmd,
      error: "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", exitCode: 2, detail: '2 errors',
    }])
    // The push was rejected: the build had passed
    expect(runHook(bash(cmd, {
      hook_event_name: 'PostToolUseFailure',
      error: 'Exit code 1\nTo github.com:me/api.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to \'github.com:me/api.git\'',
      is_interrupt: false,
    }))?.signals).toEqual([{
      kind: 'push_failed', target: 'api', branch: 'main', toDefault: true, command: cmd,
      error: '! [rejected]        main -> main (fetch first)', exitCode: 1,
    }])
  })

  it('a masked exit status (`npm test | tail`) is judged by the output: a failure count, a pass line, or nothing', () => {
    const cmd = 'npm test 2>&1 | tail -5'
    const post = (stdout: string) => runHook(bash(cmd, { hook_event_name: 'PostToolUse', tool_response: { stdout, stderr: '' } }))?.signals
    expect(post('      Tests  2 failed | 10 passed (12)')).toEqual([{ kind: 'test_failed', target: 'api', command: cmd, detail: '2 failing' }])
    expect(post('      Tests  12 passed (12)')).toEqual([{ kind: 'test_ok', target: 'api', command: cmd }])
    expect(post('done')).toBeUndefined()
    // `|| true` hides the status the same way
    expect(runHook(bash('npm test || true', { hook_event_name: 'PostToolUse', tool_response: { stdout: 'nothing to see', stderr: '' } }))?.signals).toBeUndefined()
  })

  it('where the call sends nothing of its own (a worker, no session id) the signals go out alone as a `signal` event', () => {
    expect(runHook(bash('npm test', {
      hook_event_name: 'PostToolUse', agent_id: 'a29964dc791f62039', agent_type: 'general-purpose',
      tool_response: { stdout: 'Tests  4 passed (4)', stderr: '' },
    }))).toEqual({
      type: 'signal',
      signals: [{ kind: 'test_ok', target: 'api', command: 'npm test' }],
      agentId: 'a29964dc791f62039', agentType: 'general-purpose', role: 'general-purpose', name: 'Agent',
      ...session,
    })
    expect(runHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: '/home/me/api', tool_input: { command: 'npm test' }, tool_response: { stdout: '', stderr: '' } }))
      .toEqual({ type: 'signal', signals: [{ kind: 'test_ok', target: 'api', command: 'npm test' }], project: 'api', cwd: '/home/me/api' })
    // An ordinary Bash call in a worker still sends nothing
    expect(runHook(bash('ls', { hook_event_name: 'PostToolUse', agent_id: 'a29964dc791f62039', agent_type: 'general-purpose', tool_response: { stdout: '', stderr: '' } }))).toBeNull()
  })

  it('a backgrounded run has no outcome on PostToolUse; an Esc is a failure marked interrupted', () => {
    expect(runHook(bash('vercel deploy --prod', {
      hook_event_name: 'PostToolUse', tool_input: { command: 'vercel deploy --prod', run_in_background: true },
      tool_response: { stdout: 'Command running in background with ID: bash_1', stderr: '' },
    }))).toEqual({ type: 'session_tool_done', toolName: 'Bash', promptId: base.prompt_id, ...session })
    expect(runHook(bash('npm test', { hook_event_name: 'PostToolUseFailure', error: 'Interrupted by user', is_interrupt: true }))?.signals)
      .toEqual([{ kind: 'test_failed', target: 'api', command: 'npm test', interrupted: true, error: 'Interrupted by user' }])
  })

  it('a bare `git push` reads the branch from .git/HEAD (a worktree\'s .git file too); unknown, it has no toDefault', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agent-office-signal-repo-'))
    try {
      mkdirSync(join(repo, '.git'))
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      mkdirSync(join(repo, 'web'))
      const pre = (cwd: string, command = 'git push') => runHook({ ...base, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })?.signals
      expect(pre(join(repo, 'web'))).toEqual([{ kind: 'push', target: 'web', branch: 'main', toDefault: true, command: 'git push' }])
      // A worktree: .git is a file naming its own git dir
      const wt = join(repo, 'wt')
      mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
      writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feature/signals\n')
      mkdirSync(wt)
      writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
      expect(pre(wt)).toEqual([{ kind: 'push', target: 'wt', branch: 'feature/signals', toDefault: false, command: 'git push' }])
      // Detached HEAD: a push, nothing said about the branch
      writeFileSync(join(repo, '.git', 'HEAD'), '4f449fe0c1a1d1d6c3d13d5b9e1c0e7a7c1ab0f2\n')
      expect(pre(repo)).toEqual([{ kind: 'push', target: repo.split('/').pop(), command: 'git push' }])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('false positives stay out of the events: `echo deploy && false` fails without signals, and the old shapes are unchanged', () => {
    expect(runHook(bash('echo deploy && false', { hook_event_name: 'PostToolUseFailure', error: 'Exit code 1', is_interrupt: false })))
      .toEqual({ type: 'agent_working', status: 'failed: Bash — Exit code 1', failed: true, tool: 'Bash', ...session })
    expect(runHook(bash('git commit -m "deploy; npm test"', { hook_event_name: 'PreToolUse' })))
      .toEqual({ type: 'agent_working', status: 'running: git commit -m "deploy; npm test"', tool: 'Bash', ...session })
    // A tool other than Bash never carries signals, whatever its input says
    expect(runHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'npm test', command: 'npm test' } }))
      .toEqual({ type: 'agent_working', status: "searching for 'npm test'", tool: 'Grep', ...session })
  })

  it('at most 8 signals per call, each string clamped; a command shlex cannot split still classifies', () => {
    const many = Array.from({ length: 12 }, (_, i) => `cd pkg${i} && npm test`).join(' && ')
    const ev = runHook(bash(many, { hook_event_name: 'PreToolUse' }))
    expect(ev?.signals).toHaveLength(8)
    expect(ev?.signals[0].command).toHaveLength(160)
    expect(runHook(bash(`fly deploy -a ${'x'.repeat(300)}`, { hook_event_name: 'PreToolUse' }))?.signals[0].target).toHaveLength(80)
    // An unbalanced quote: shlex gives up, the plain split still finds the test run
    expect(runHook(bash('npm test -- -t "unterminated', { hook_event_name: 'PreToolUse' }))?.signals?.[0]).toMatchObject({ kind: 'test_start' })
  })
})
