/**
 * hook-smoke - runs the real hooks/agent-tracker.sh end to end against a stub
 * office, the way Claude Code runs it (`bash agent-tracker.sh`, payload on
 * stdin). Built for the Windows CI job, where the vitest suite cannot run
 * (POSIX signals, /bin/bash, fake binaries), but it works on any OS:
 *
 *   node tests/hook-smoke.mjs            # uses `bash` from PATH
 *   HOOK_BASH='C:\Program Files\Git\bin\bash.exe' node tests/hook-smoke.mjs
 *
 * It catches, on the platform it runs on:
 * - CRLF line endings in the hook files (#72): bash cannot run them
 * - a hang (#74: Git Bash deadlocked on a heredoc over 64 KiB)
 * - a hook that exits non-zero (exit 2 blocks the tool call in Claude Code)
 * - a hook that never reaches the office
 *
 * Not named *.test.* so vitest does not pick it up; exits 1 on failure.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url))
const TRACKER = join(HOOKS, 'agent-tracker.sh')
const BASH = process.env.HOOK_BASH || 'bash'

// Why: a healthy run takes well under a second; the hang in #74 never ends.
// 20 s leaves room for a cold Windows runner without letting a hang pass.
const HANG_MS = 20_000

// Why: a tool_response this big is what real Read/Bash calls send, and it is
// over the 32 KB Windows command-line limit (#72), so it proves the payload
// travels on stdin and never through an argument.
const BIG_RESPONSE = 'x'.repeat(200_000)

const failures = []
const fail = msg => { failures.push(msg); console.error(`FAIL ${msg}`) }

// ---------------------------------------------------------------------------
// 1. Line endings: every hook file must be LF in this checkout
// ---------------------------------------------------------------------------
for (const name of readdirSync(HOOKS).filter(n => /\.(sh|py)$/.test(n))) {
  if (readFileSync(join(HOOKS, name), 'utf8').includes('\r')) fail(`hooks/${name} has CRLF line endings (.gitattributes not applied?)`)
}

// ---------------------------------------------------------------------------
// 2. The hook against a stub office
// ---------------------------------------------------------------------------
const posts = []
const server = createServer((req, res) => {
  let body = ''
  req.setEncoding('utf8').on('data', c => { body += c }).on('end', () => {
    if (req.method === 'POST' && req.url === '/event') posts.push(body)
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
})
await new Promise(res => server.listen(0, '127.0.0.1', res))
const port = server.address().port

// An empty office home: no auth-token, no answer-permissions marker, so the
// hook posts once and never waits for a permission answer
const home = mkdtempSync(join(tmpdir(), 'agent-office-smoke-'))

const payload = {
  session_id: 'smoke-session',
  transcript_path: join(home, 'transcript.jsonl'),
  cwd: home,
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
  tool_response: { stdout: BIG_RESPONSE, stderr: '', interrupted: false },
}

const env = { ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(port) }
delete env.AGENT_OFFICE_EVENT_URL

const started = Date.now()
const result = await new Promise(resolve => {
  const child = spawn(BASH, [TRACKER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', c => { stderr += c })
  const timer = setTimeout(() => { child.kill(); resolve({ status: 'hung', stderr }) }, HANG_MS)
  child.on('error', err => { clearTimeout(timer); resolve({ status: `spawn error: ${err.message}`, stderr }) })
  child.on('close', status => { clearTimeout(timer); resolve({ status, stderr }) })
  child.stdin.on('error', () => {}) // a hook that dies early closes stdin under us
  child.stdin.end(JSON.stringify(payload))
})
const ms = Date.now() - started

// Why: the hook backgrounds its curl and exits at once (it never makes Claude
// Code wait on the office), so the POST lands just after. Its curl has
// --max-time 1; 5 s covers a slow runner starting curl.
for (let waited = 0; posts.length === 0 && waited < 5000; waited += 50) await new Promise(res => setTimeout(res, 50))

if (result.status === 'hung') fail(`the hook was still running after ${HANG_MS / 1000} s`)
else if (result.status !== 0) fail(`the hook exited ${result.status}`)
if (result.stderr.trim()) fail(`the hook wrote to stderr:\n${result.stderr.trim()}`)
if (posts.length !== 1) fail(`expected 1 POST /event, got ${posts.length}`)
else {
  try {
    const event = JSON.parse(posts[0])
    if (event.sessionId !== 'smoke-session' && event.session_id !== 'smoke-session') fail(`the event is for another session: ${posts[0].slice(0, 200)}`)
  } catch {
    fail(`the POST body is not JSON: ${posts[0].slice(0, 200)}`)
  }
}

server.close()
rmSync(home, { recursive: true, force: true })

if (failures.length) process.exit(1)
console.log(`ok: hook ran in ${ms} ms under ${BASH}, posted ${posts[0].length} bytes to the stub office`)
