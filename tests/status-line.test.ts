/**
 * hooks/status-line.sh — the Claude Code statusLine command: POSTs the
 * session's cost / context / rate-limit numbers to /status and prints the
 * line Claude Code displays (or the output of a status line it was wrapped
 * around). Runs the real script against a capture server.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../hooks/status-line.sh', import.meta.url))

/**
 * The stdin JSON Claude Code 2.1.300 gives a statusLine command: the shape
 * from https://code.claude.com/docs/en/statusline with the numbers of a
 * captured haiku-5-5 session (REPORT.md §2/§3) and a Pro/Max rate_limits block.
 */
const STATUS_JSON = {
  hook_event_name: 'Status',
  session_id: '8cf68f64-5433-40f7-a130-557fc7f67e42',
  transcript_path: '/root/.claude/projects/-home-user-Claude-Office/8cf68f64-5433-40f7-a130-557fc7f67e42.jsonl',
  cwd: '/home/user/Claude-Office',
  model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
  workspace: { current_dir: '/home/user/Claude-Office/src', project_dir: '/home/user/Claude-Office' },
  version: '2.1.300',
  output_style: { name: 'default' },
  cost: { total_cost_usd: 0.014055975, total_duration_ms: 23245, total_api_duration_ms: 19074, total_lines_added: 156, total_lines_removed: 23 },
  context_window: {
    total_input_tokens: 44051,
    total_output_tokens: 358,
    context_window_size: 1000000,
    used_percentage: 4.4,
    remaining_percentage: 95.6,
    current_usage: { input_tokens: 2, output_tokens: 358, cache_creation_input_tokens: 14539, cache_read_input_tokens: 27861 },
  },
  exceeds_200k_tokens: false,
  effort: { level: 'medium' },
  thinking: { enabled: true },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
  vim: { mode: 'NORMAL' },
}

/** What the script is expected to POST for STATUS_JSON */
const EXPECTED_EVENT = {
  type: 'session_status',
  sessionId: '8cf68f64-5433-40f7-a130-557fc7f67e42',
  project: 'Claude-Office',
  model: 'Haiku 5.5',
  modelId: 'claude-haiku-5-5',
  cost: 0.014055975,
  durationMs: 23245,
  apiDurationMs: 19074,
  linesAdded: 156,
  linesRemoved: 23,
  context: { used: 4.4, size: 1000000, input: 44051, output: 358 },
  effort: 'medium',
  exceeds200k: false,
  version: '2.1.300',
  rateLimits: { fiveHour: 23.5, fiveHourResetsAt: 1738425600, sevenDay: 41.2, sevenDayResetsAt: 1738857600 },
}

/** The subagentStatusLine stdin: base hook fields + columns + one task per visible row */
const SUBAGENT_JSON = {
  hook_event_name: 'Status',
  session_id: '8cf68f64-5433-40f7-a130-557fc7f67e42',
  transcript_path: '/root/.claude/projects/-home-user-Claude-Office/8cf68f64-5433-40f7-a130-557fc7f67e42.jsonl',
  cwd: '/home/user/Claude-Office',
  columns: 120,
  tasks: [
    {
      id: 'ac5ff55b850b4fecf', type: 'local_agent', agentType: 'general-purpose', status: 'running',
      description: 'Count etc', label: 'Reading files', startTime: 1792004729080, model: 'claude-haiku-5-5',
      effort: 'medium', contextWindowSize: 1000000, tokenCount: 28170, tokenSamples: [1200, 9800, 28170],
      cwd: '/home/user/Claude-Office',
    },
    {
      id: 'b17c2d9e4f0a1b2c3', type: 'local_agent', agentType: 'Explore', status: 'completed',
      description: 'Find the config loader', label: 'done', startTime: 1792004731000,
      tokenCount: 5120, tokenSamples: [5120], cwd: '/home/user/Claude-Office',
    },
  ],
}

interface Captured { url: string; authorization?: string; body: any }

let server: Server
let serverUrl: string
let closedUrl: string
const captured: Captured[] = []
const homes: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      captured.push({ url: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(data) })
      res.setHeader('Content-Type', 'application/json')
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`

  // A port nothing listens on (bind, read, release)
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  closedUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/status`
  await new Promise<void>(resolve => probe.close(() => resolve()))
})

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

beforeEach(() => { captured.length = 0 })
afterEach(() => { while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true }) })

/** A fresh AGENT_OFFICE_HOME, optionally with an auth token and a chained command. */
function officeHome({ token, prev, subagentPrev }: { token?: string; prev?: string; subagentPrev?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-office-status-'))
  homes.push(home)
  if (token) writeFileSync(join(home, 'auth-token'), token)
  if (prev) writeFileSync(join(home, 'statusline-prev'), prev + '\n')
  if (subagentPrev) writeFileSync(join(home, 'subagent-statusline-prev'), subagentPrev + '\n')
  return home
}

function run(payload: unknown, home: string, { args = [], url = serverUrl, env = {} }: { args?: string[]; url?: string; env?: Record<string, string> } = {}) {
  const started = Date.now()
  const out = execFileSync('bash', [SCRIPT, ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, AGENT_OFFICE_STATUS_URL: url, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PREV_STATUSLINE: '', ...env },
  })
  return { out, ms: Date.now() - started }
}

/** The backgrounded curl lands shortly after the script exits. */
async function posted(count = 1, ms = 3000): Promise<Captured[]> {
  const deadline = Date.now() + ms
  while (captured.length < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
  return captured
}

describe('status-line.sh: statusLine', () => {
  it('prints "<model> · ctx <used>% · $<cost>" and POSTs a session_status with the bearer token', async () => {
    const home = officeHome({ token: 'secret-token' })
    const { out } = run(STATUS_JSON, home)
    expect(out).toBe('Haiku 5.5 · ctx 4% · $0.01\n')

    const [req] = await posted()
    expect(req).toBeDefined()
    expect(req.url).toBe('/status')
    expect(req.authorization).toBe('Bearer secret-token')
    expect(req.body).toEqual(EXPECTED_EVENT)
  })

  it('posts without an Authorization header when there is no token file', async () => {
    const { out } = run(STATUS_JSON, officeHome())
    expect(out).toBe('Haiku 5.5 · ctx 4% · $0.01\n')
    const [req] = await posted()
    expect(req.authorization).toBeUndefined()
    expect(req.body.type).toBe('session_status')
  })

  it('handles the early-session shape: null used_percentage, no rate_limits, no cost yet, no effort', async () => {
    const early = {
      hook_event_name: 'Status',
      session_id: 'sess-early',
      cwd: '/tmp/scratch/my-project/',
      model: { id: 'claude-opus-5-5', display_name: 'Opus' },
      workspace: { current_dir: '/tmp/scratch/my-project', project_dir: '/tmp/scratch/my-project' },
      version: '2.1.300',
      cost: { total_cost_usd: 0, total_duration_ms: 120, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 },
      context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 200000, used_percentage: null, remaining_percentage: null, current_usage: null },
      exceeds_200k_tokens: false,
    }
    const { out } = run(early, officeHome())
    expect(out).toBe('Opus · ctx 0% · $0.00\n')
    const [req] = await posted()
    expect(req.body).toEqual({
      type: 'session_status', sessionId: 'sess-early', project: 'my-project', model: 'Opus', modelId: 'claude-opus-5-5',
      cost: 0, durationMs: 120, apiDurationMs: 0, linesAdded: 0, linesRemoved: 0,
      context: { used: null, size: 200000, input: 0, output: 0 },
      effort: null, exceeds200k: false, version: '2.1.300',
    })
    expect(req.body).not.toHaveProperty('rateLimits')
  })

  it('falls back to cwd for the project when workspace is absent, and forwards spend_limit', async () => {
    const payload = { ...STATUS_JSON, workspace: undefined, cwd: '/srv/apps/billing-api', rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 1740787200, used_usd: 314.12, limit_usd: 500, period: 'monthly' } } }
    run(payload, officeHome())
    const [req] = await posted()
    expect(req.body.project).toBe('billing-api')
    expect(req.body.rateLimits).toEqual({ spendLimit: 62.8, spendLimitResetsAt: 1740787200 })
  })

  it('chains the status line it was wrapped around: same stdin, its output is printed, the POST still goes out', async () => {
    const prev = `python3 -I -c 'import json,sys; d=json.load(sys.stdin); print("prev:" + d["model"]["display_name"] + ":" + str(d["context_window"]["used_percentage"]))'`
    const home = officeHome({ token: 't', prev })
    const { out } = run(STATUS_JSON, home)
    expect(out).toBe('prev:Haiku 5.5:4.4\n')
    const [req] = await posted()
    expect(req.body).toEqual(EXPECTED_EVENT)
  })

  it('AGENT_OFFICE_PREV_STATUSLINE overrides the saved command', async () => {
    const { out } = run(STATUS_JSON, officeHome({ prev: 'echo from-file' }), { env: { AGENT_OFFICE_PREV_STATUSLINE: 'echo from-env' } })
    expect(out).toBe('from-env\n')
    expect(await posted()).toHaveLength(1)
  })

  it('prints the default line when the chained command fails or prints nothing', async () => {
    expect(run(STATUS_JSON, officeHome({ prev: 'exit 3' })).out).toBe('Haiku 5.5 · ctx 4% · $0.01\n')
    expect(run(STATUS_JSON, officeHome({ prev: 'cat > /dev/null' })).out).toBe('Haiku 5.5 · ctx 4% · $0.01\n')
    expect(await posted(2)).toHaveLength(2)
  })

  it('still prints the line, exits 0 and does not wait when the server is down', () => {
    const { out, ms } = run(STATUS_JSON, officeHome({ token: 't' }), { url: closedUrl })
    expect(out).toBe('Haiku 5.5 · ctx 4% · $0.01\n')
    // The curl is backgrounded with --max-time 1; the script itself is one python3 call
    expect(ms).toBeLessThan(1500)
    expect(captured).toHaveLength(0)
  })

  it('exits 0 on garbage stdin and posts nothing', async () => {
    const { out } = run('this is not json', officeHome())
    expect(out).toBe('Claude · ctx 0% · $0.00\n')
    await new Promise(r => setTimeout(r, 300))
    expect(captured).toHaveLength(0)
  })

  it('exits 0 and prints nothing on empty stdin', () => {
    expect(run('', officeHome()).out).toBe('')
  })
})

describe('status-line.sh --subagents: subagentStatusLine', () => {
  it('posts an agent_status with every visible row\'s tokens and context size, printing nothing (default rows kept)', async () => {
    const { out } = run(SUBAGENT_JSON, officeHome({ token: 'secret-token' }), { args: ['--subagents'] })
    expect(out).toBe('')
    const [req] = await posted()
    expect(req.authorization).toBe('Bearer secret-token')
    expect(req.body).toEqual({
      type: 'agent_status',
      sessionId: '8cf68f64-5433-40f7-a130-557fc7f67e42',
      agents: [
        { id: 'ac5ff55b850b4fecf', tokens: 28170, status: 'running', contextSize: 1000000, agentType: 'general-purpose', model: 'claude-haiku-5-5', description: 'Count etc' },
        { id: 'b17c2d9e4f0a1b2c3', tokens: 5120, status: 'completed', agentType: 'Explore', description: 'Find the config loader' },
      ],
    })
  })

  it('posts nothing when there are no rows', async () => {
    const { out } = run({ ...SUBAGENT_JSON, tasks: [] }, officeHome(), { args: ['--subagents'] })
    expect(out).toBe('')
    await new Promise(r => setTimeout(r, 300))
    expect(captured).toHaveLength(0)
  })

  it('prints the rows of a chained subagentStatusLine command', async () => {
    const prev = `python3 -I -c 'import json,sys; [print(json.dumps({"id": t["id"], "content": t["label"]})) for t in json.load(sys.stdin)["tasks"]]'`
    const { out } = run(SUBAGENT_JSON, officeHome({ subagentPrev: prev }), { args: ['--subagents'] })
    expect(out.trim().split('\n').map(l => JSON.parse(l))).toEqual([
      { id: 'ac5ff55b850b4fecf', content: 'Reading files' },
      { id: 'b17c2d9e4f0a1b2c3', content: 'done' },
    ])
    const [req] = await posted()
    expect(req.body.type).toBe('agent_status')
  })
})
