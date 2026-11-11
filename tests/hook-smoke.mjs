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
 * - a Stop that cannot claim a prompt queued in the office chat (the one
 *   path where the hook reads the office's answer and prints it: a CRLF from
 *   Python or a broken signature would lose the prompt)
 *
 * Not named *.test.* so vitest does not pick it up; exits 1 on failure.
 */

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
// Each POST's X-Office-Signature ('' when unsigned): tells a failing claim's cause apart
const signed = []
// The token the claim run (3. below) signs with and the stub proves it holds
const TOKEN = 'smoke-token'
const PROMPT = { id: 'abcd1234abcd1234', text: 'run the smoke test — twice' }
const server = createServer((req, res) => {
  let body = ''
  req.setEncoding('utf8').on('data', c => { body += c }).on('end', () => {
    if (req.method === 'POST' && req.url === '/event') {
      posts.push(body)
      signed.push(typeof req.headers['x-office-signature'] === 'string' ? req.headers['x-office-signature'] : '')
    }
    let reply = { ok: true }
    try {
      const event = JSON.parse(body)
      // Answer a Stop's claim as server/index.js does (promptProof)
      if (event.claim && event.nonce) {
        const proof = createHmac('sha256', TOKEN).update(`office-prompt\n${event.nonce}\n${PROMPT.id}\n${PROMPT.text}`).digest('hex')
        reply = { ok: true, prompt: { ...PROMPT, proof } }
      }
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
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

/** The hook on one payload: its exit status ('hung' past HANG_MS), stdout and stderr. */
function runHook(hookPayload) {
  return new Promise(resolve => {
    const child = spawn(BASH, [TRACKER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', c => { stdout += c })
    child.stderr.setEncoding('utf8').on('data', c => { stderr += c })
    const timer = setTimeout(() => { child.kill(); resolve({ status: 'hung', stdout, stderr }) }, HANG_MS)
    child.on('error', err => { clearTimeout(timer); resolve({ status: `spawn error: ${err.message}`, stdout, stderr }) })
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
    child.stdin.on('error', () => {}) // a hook that dies early closes stdin under us
    child.stdin.end(JSON.stringify(hookPayload))
  })
}

const started = Date.now()
const result = await runHook(payload)
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

// ---------------------------------------------------------------------------
// 3. A Stop claims a prompt queued in the office chat
// ---------------------------------------------------------------------------
// The session's marker and a token file: the hook signs, POSTs in the
// foreground, checks the stub's proof and prints the block decision
writeFileSync(join(home, 'auth-token'), `${TOKEN}\n`)
mkdirSync(join(home, 'prompt-queue'))
writeFileSync(join(home, 'prompt-queue', 'smoke-session'), '')
const claim = await runHook({
  session_id: 'smoke-session', transcript_path: join(home, 'transcript.jsonl'), cwd: home,
  hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done', background_tasks: [], session_crons: [],
})
if (claim.status === 'hung') fail(`the Stop claim was still running after ${HANG_MS / 1000} s`)
else if (claim.status !== 0) fail(`the Stop claim exited ${claim.status}`)
if (claim.stderr.trim()) fail(`the Stop claim wrote to stderr:\n${claim.stderr.trim()}`)
try {
  const out = JSON.parse(claim.stdout)
  if (out.decision !== 'block' || !String(out.reason).endsWith(`\n\n${PROMPT.text}`)) fail(`the Stop claim printed the wrong decision: ${claim.stdout.slice(0, 300)}`)
} catch {
  // Say which step broke: no POST at all, a POST without claim (the marker
  // was not seen), an unsigned one (no token read), or a reply not acted on.
  // A backgrounded POST lands after the hook exits, so give it a moment.
  for (let waited = 0; posts.length < 2 && waited < 3000; waited += 50) await new Promise(res => setTimeout(res, 50))
  let seen = 'no POST reached the stub'
  if (posts.length >= 2) {
    let claimed = false
    try { claimed = JSON.parse(posts[posts.length - 1]).claim === true } catch {}
    seen = `the POST had claim=${claimed}, signature=${JSON.stringify(signed[signed.length - 1])}`
  }
  fail(`the Stop claim printed no block decision: ${JSON.stringify(claim.stdout.slice(0, 300))} (${seen})`)
}

server.close()
rmSync(home, { recursive: true, force: true })

if (failures.length) process.exit(1)
console.log(`ok: hook ran in ${ms} ms under ${BASH}, posted ${posts[0].length} bytes to the stub office, and a Stop claimed a queued prompt`)
