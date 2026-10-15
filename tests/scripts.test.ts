/**
 * scripts/ — the shell helpers around the office. Each test runs the real
 * script with HOME and AGENT_OFFICE_HOME pointed at a temp dir and fake
 * `claude`, `osascript`, `notify-send`, `curl`, `uname` and `xdg-open`
 * binaries on a temp PATH, so nothing reaches the real ~/.agent-office, the
 * real CLI or a browser. The chat watcher talks to a real server/index.js
 * bound to an ephemeral port (AGENT_OFFICE_PORT).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, postAuthed, removeOffice, spawnAgent, type Office } from './helpers'

const SCRIPTS = fileURLToPath(new URL('../scripts', import.meta.url))
const WATCHER = join(SCRIPTS, 'chat-ai-watcher.sh')
const START = join(SCRIPTS, 'start-office.sh')
const STOP = join(SCRIPTS, 'stop-office.sh')
const NOTIFY = join(SCRIPTS, 'notify.sh')

const LOG_ARGS = `python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"`

// Fake `claude`: logs every call (one JSON array per line), answers from
// $FAKE_CLAUDE_DIR/mode — "ok" prints a reply, "empty" fails like a CLI that is
// not logged in.
const FAKE_CLAUDE = `
dir="\${FAKE_CLAUDE_DIR:?}"
${LOG_ARGS} >> "$dir/calls.jsonl"
mode=$(cat "$dir/mode" 2>/dev/null || echo ok)
case "$mode" in
  empty) echo "Not logged in · Please run /login" >&2; exit 1 ;;
  *) echo "On it, checking the error logs now" ;;
esac`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitForWithin<T>(what: string, fn: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}
const waitFor = <T,>(what: string, fn: () => T | Promise<T>, timeoutMs = 8000) => waitForWithin(what, fn, timeoutMs)

function alive(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

const tempDirs: string[] = []
function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Write an executable bash script `name` into `dir`. */
function fakeBin(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

/** A child process whose stdout/stderr are collected into `.out`. */
class Proc {
  out = ''
  exited: Promise<number | null>
  constructor(public child: ChildProcess) {
    child.stdout?.on('data', d => { this.out += d })
    child.stderr?.on('data', d => { this.out += d })
    this.exited = new Promise(resolve => child.on('exit', code => resolve(code)))
  }
  get pid() { return this.child.pid! }
  /** SIGTERM the whole process group (the script and its curl/sleep children). */
  async stop() {
    try { process.kill(-this.pid, 'SIGTERM') } catch {}
    try { this.child.kill('SIGTERM') } catch {}
    await Promise.race([this.exited, sleep(3000)])
    try { process.kill(-this.pid, 'SIGKILL') } catch {}
  }
}

const procs: Proc[] = []
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, detached = true) {
  const proc = new Proc(spawn(cmd, args, { env, detached, stdio: ['ignore', 'pipe', 'pipe'] }))
  procs.push(proc)
  return proc
}

afterAll(async () => {
  for (const p of procs) await p.stop()
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// chat-ai-watcher.sh
// ---------------------------------------------------------------------------

interface WatcherWorld {
  office: Office
  port: number
  claudeDir: string
  watcher: Proc
}

/** Real server on a free port + the watcher polling it every 200 ms with a fake `claude`. */
async function startWatcher(opts: { maxPerMinute?: number; staleLock?: boolean } = {}): Promise<WatcherWorld> {
  const office = await loadOffice()
  const port = await listen(office.server.httpServer)
  // What start() writes once the port is bound: the watcher reads it to post as an agent
  writeFileSync(join(office.dir, 'auth-token'), office.server.AUTH_TOKEN, { mode: 0o600 })
  const home = tempDir('agent-office-script-home-')
  const bin = join(home, 'bin')
  fakeBin(bin, 'claude', FAKE_CLAUDE)
  const claudeDir = join(home, 'fake-claude')
  mkdirSync(claudeDir)
  writeFileSync(join(claudeDir, 'mode'), 'ok')
  if (opts.staleLock) writeFileSync(join(office.dir, 'chat-ai.lock'), '')

  const watcher = run('bash', [WATCHER], {
    ...process.env,
    HOME: home,
    AGENT_OFFICE_HOME: office.dir,
    AGENT_OFFICE_PORT: String(port),
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CLAUDE_DIR: claudeDir,
    CHAT_AI_POLL_INTERVAL: '0.2',
    CHAT_AI_MAX_REPLIES_PER_MIN: String(opts.maxPerMinute ?? 50),
  })
  await waitFor('watcher pid file', () => existsSync(join(office.dir, 'chat-watcher.pid')))
  return { office, port, claudeDir, watcher }
}

function claudeCalls(w: WatcherWorld): string[][] {
  const file = join(w.claudeDir, 'calls.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

async function chat(w: WatcherWorld) {
  const res = await request(w.office.server.app).get('/chat')
  return res.body.messages as Array<Record<string, any>>
}

const say = (w: WatcherWorld, text: string, sender = 'Antony') =>
  request(w.office.server.app).post('/chat').send({ sender, text })

const FAKE_REPLY = 'On it, checking the error logs now'
/** Rows the watcher posted (announcements and directed messages carry an agent role too, but not this text). */
const replies = (msgs: Array<Record<string, any>>) => msgs.filter(m => m.text === FAKE_REPLY)

describe('chat-ai-watcher.sh', () => {
  let w: WatcherWorld
  beforeAll(async () => { w = await startWatcher({ maxPerMinute: 3 }) })
  afterAll(async () => { await w.watcher.stop(); removeOffice(w.office) })

  it('answers a message a person typed exactly once, as the routed persona, with a cheap model and hooks/MCP off', async () => {
    await say(w, 'hey there is a bug in login')
    const reply = await waitFor('the Debugger reply', async () => (await chat(w)).find(m => m.sender === 'Debugger'))
    expect(reply).toMatchObject({ role: 'debugger', text: FAKE_REPLY, recipient: null })

    // Several more polls: the reply itself must not be answered
    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
    expect(replies(await chat(w))).toHaveLength(1)

    const args = claudeCalls(w)[0]
    expect(args.slice(0, 2)).toEqual(['-p', expect.stringContaining('You are responding as Debugger, the office debugger')])
    expect(args[1]).toContain('Antony: hey there is a bug in login')
    for (const flag of ['--max-turns', '--model', '--safe-mode', '--strict-mcp-config', '--tools', '--no-session-persistence', '--name']) {
      expect(args, `missing ${flag}`).toContain(flag)
    }
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-5-5')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    // Named so the registry roster (server/sessions.js) never shows the bot as a session
    expect(args[args.indexOf('--name') + 1]).toBe('agent-office-bot')

    // Its own reply is behind the watermark, not ahead of it
    const lastTs = Number(readFileSync(join(w.office.dir, 'chat-ai-last-ts'), 'utf8'))
    expect(lastTs).toBeGreaterThanOrEqual(reply!.timestamp)
  })

  it("ignores the server's starting:/done: announcements and directed agent-to-agent messages", async () => {
    spawnAgent(w.office.server, { id: 'agent-dbg', name: 'Debugger', role: 'debugger', task: 'fix the login bug' })
    spawnAgent(w.office.server, { id: 'agent-rev', name: 'Reviewer', role: 'code-reviewer', task: 'review the fix' })
    await postAuthed(w.office.server, '/chat/reply', { sender: 'Reviewer', role: 'code-reviewer', recipient: 'Debugger', text: 'is the login bug fixed?' })
    w.office.server.processEvent({ type: 'agent_completed', agentId: 'agent-dbg', result: 'fixed the bug in login' })

    const msgs = await chat(w)
    expect(msgs.map(m => m.text)).toEqual(expect.arrayContaining([
      'starting: fix the login bug', 'starting: review the fix', 'is the login bug fixed?', 'done: fixed the bug in login',
    ]))

    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
  })

  it("never sees the Boss prompt and Claude reply rows the main-thread events persist: GET /chat hides them without the token, and their roles are boss/assistant anyway", async () => {
    w.office.server.processEvent({ type: 'session_prompt', sessionId: 'sess-watch', project: 'watch', promptId: 'p1', text: 'there is a bug in login, fix it' })
    w.office.server.processEvent({ type: 'session_turn_end', sessionId: 'sess-watch', promptId: 'p1', text: 'Fixed the bug in login.', backgroundTasks: [], crons: 0 })

    // Stored, visible with the office token...
    const withToken = await request(w.office.server.app).get('/chat').set('Authorization', `Bearer ${w.office.server.AUTH_TOKEN}`)
    expect(withToken.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ sender: 'Boss', role: 'boss', msg_type: 'prompt', text: 'there is a bug in login, fix it' }),
      expect.objectContaining({ sender: 'Claude', role: 'assistant', msg_type: 'reply', text: 'Fixed the bug in login.' }),
    ]))
    // ...and absent from what the watcher polls
    const msgs = await chat(w)
    expect(msgs.some(m => m.msg_type === 'prompt' || m.msg_type === 'reply' || m.sender === 'Boss')).toBe(false)

    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
  })

  it('ignores slash commands and system lines', async () => {
    await say(w, '/nonsense there is a bug')
    await say(w, '/help')
    expect((await chat(w)).at(-1)).toMatchObject({ sender: 'system', is_system: 1 })
    await sleep(1000)
    expect(claudeCalls(w)).toHaveLength(1)
  })

  it('answers the next human message, then stops at the per-minute reply cap', async () => {
    await say(w, 'can you review the PR please')
    await waitFor('the Reviewer reply', async () => (await chat(w)).find(m => m.sender === 'Reviewer' && m.role === 'code-reviewer' && m.text === FAKE_REPLY))
    expect(claudeCalls(w)).toHaveLength(2)

    await say(w, 'another bug over here')
    await waitFor('a third claude call', () => claudeCalls(w).length === 3)
    await waitFor('the second Debugger reply', async () => replies(await chat(w)).filter(m => m.sender === 'Debugger').length === 2)

    // Cap is 3 per minute for this run: the fourth message is seen but not answered
    await say(w, 'one more bug for you')
    await waitFor('the cap log line', () => w.watcher.out.includes('Reply cap reached (3 per minute)'))
    await sleep(600)
    expect(claudeCalls(w)).toHaveLength(3)
    expect(replies(await chat(w))).toHaveLength(3)
  })
})

describe('chat-ai-watcher.sh lock', () => {
  let w: WatcherWorld
  beforeAll(async () => { w = await startWatcher({ staleLock: true }) })
  afterAll(async () => { await w.watcher.stop(); removeOffice(w.office) })

  // Two watcher round trips through a fake `claude -p` in one test: give it
  // room under full-suite load, where 8 s waits have timed out
  it('clears a stale lock at startup, and an empty/failed `claude -p` neither posts nor leaves the lock behind', async () => {
    const waitFor = <T,>(what: string, fn: () => T | Promise<T>) => waitForWithin(what, fn, 20_000)
    const lock = join(w.office.dir, 'chat-ai.lock')
    expect(existsSync(lock)).toBe(false)

    writeFileSync(join(w.claudeDir, 'mode'), 'empty')
    await say(w, 'there is a bug in checkout')
    await waitFor('the empty-reply log line', () => w.watcher.out.includes('Empty reply from claude'))
    expect(claudeCalls(w)).toHaveLength(1)
    expect(w.watcher.out).toContain('claude: Not logged in')
    // The watcher prints the empty-reply line inside do_reply and removes the
    // lock when it returns, so the log line can arrive a few ms before the
    // file is gone: wait for the release rather than asserting it at once
    await waitFor('the lock to be released after the empty reply', () => !existsSync(lock))
    expect(replies(await chat(w))).toHaveLength(0)

    // ...and the next message is answered once the CLI works again
    writeFileSync(join(w.claudeDir, 'mode'), 'ok')
    await say(w, 'still a bug in checkout')
    await waitFor('the Debugger reply', async () => (await chat(w)).find(m => m.sender === 'Debugger'))
    expect(claudeCalls(w)).toHaveLength(2)
    await waitFor('the lock to be released', () => !existsSync(lock))
    expect(w.watcher.out).not.toContain('already generating a reply')
  }, 45_000)
})

// ---------------------------------------------------------------------------
// stop-office.sh
// ---------------------------------------------------------------------------

const IDLE = 'setInterval(() => {}, 1000)'

/** A detached node process; its pid is what a pid file would hold. */
function idleNode() {
  return run('node', ['-e', IDLE], process.env)
}

/** A detached node TCP listener; resolves with its port. */
async function listener(): Promise<{ proc: Proc; port: number }> {
  const proc = run('node', ['-e', `const s = require('net').createServer(c => c.on('error', () => {})); s.listen(0, '127.0.0.1', () => console.log(s.address().port)); ${IDLE}`], process.env)
  const port = await waitFor('listener port', () => Number(proc.out.trim()) || 0)
  return { proc, port }
}

function runStop(officeDir: string, extra: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const proc = run('bash', [STOP, ...args], { ...process.env, HOME: officeDir, AGENT_OFFICE_HOME: officeDir, ...extra }, false)
  return proc.exited.then(code => ({ code, out: proc.out }))
}

describe('stop-office.sh', () => {
  it('stops only the processes named in the pid files and leaves clients and look-alikes alone', async () => {
    const dir = tempDir('agent-office-stop-')
    const server = idleNode()
    const vite = idleNode()
    const decoy = idleNode()
    writeFileSync(join(dir, 'chat-ai-watcher.sh'), 'while true; do sleep 1; done\n')
    const watcher = run('bash', [join(dir, 'chat-ai-watcher.sh')], process.env)
    const { proc: listening, port } = await listener()
    const client = run('node', ['-e', `require('net').connect(${port}, '127.0.0.1').on('error', () => {}); ${IDLE}`], process.env)
    await sleep(200)

    writeFileSync(join(dir, 'server.pid'), `${server.pid}\n`)
    writeFileSync(join(dir, 'vite.pid'), `${vite.pid}\n`)
    writeFileSync(join(dir, 'chat-watcher.pid'), `${watcher.pid}\n`)

    const { code, out } = await runStop(dir, { AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_UI_PORT: String(port) })
    expect(code).toBe(0)
    expect(out).toContain(`Chat watcher stopped (pid ${watcher.pid})`)
    expect(out).toContain(`Server stopped (pid ${server.pid})`)
    expect(out).toContain(`Vite dev server stopped (pid ${vite.pid})`)
    expect(out).toContain('3 process(es) stopped')

    await waitFor('pid-file processes to exit', () => !alive(server.pid) && !alive(vite.pid) && !alive(watcher.pid))
    expect(alive(decoy.pid)).toBe(true)
    expect(alive(listening.pid)).toBe(true)
    expect(alive(client.pid)).toBe(true)
    for (const f of ['server.pid', 'vite.pid', 'chat-watcher.pid']) expect(existsSync(join(dir, f))).toBe(false)
  })

  it('refuses a pid file that points at a process which is not an office process', async () => {
    const dir = tempDir('agent-office-stop-')
    const stranger = run('sleep', ['300'], process.env)
    writeFileSync(join(dir, 'server.pid'), String(stranger.pid))

    const { code, out } = await runStop(dir)
    expect(code).toBe(0)
    expect(out).toContain(`pid ${stranger.pid} is not an office process`)
    expect(out).toContain('Nothing was running')
    expect(alive(stranger.pid)).toBe(true)
    expect(existsSync(join(dir, 'server.pid'))).toBe(false)
  })

  it('does nothing to a listener on the office port unless --force is given', async () => {
    const dir = tempDir('agent-office-stop-')
    const { proc: listening, port } = await listener()
    const env = { AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_UI_PORT: String(port + 1) }

    const plain = await runStop(dir, env)
    expect(plain.code).toBe(0)
    expect(plain.out).toContain('--force')
    expect(alive(listening.pid)).toBe(true)

    const forced = await runStop(dir, env, ['--force'])
    expect(forced.code).toBe(0)
    if (/needs lsof, ss or fuser/.test(forced.out)) return // no port tool on this box
    expect(forced.out).toContain(`killed pid ${listening.pid} listening on :${port}`)
    await waitFor('listener to exit', () => !alive(listening.pid))
  })
})

// ---------------------------------------------------------------------------
// notify.sh
// ---------------------------------------------------------------------------

const NASTY = [
  'Antony: tell claude "hi"',
  'Antony: claude" & (do shell script "open -a Calculator")&"',
  "it's C:\\path\\n with a 'quote' and a \\ backslash",
  'line one\nline two',
]

function runNotify(bin: string, title: string, msg: string) {
  const log = join(bin, 'calls.jsonl')
  const proc = run('bash', [NOTIFY, title, msg], { ...process.env, PATH: `${bin}:${process.env.PATH}`, NOTIFY_LOG: log }, false)
  return proc.exited.then(code => ({
    code,
    calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[]) : [],
  }))
}

describe('notify.sh', () => {
  it('hands title and message to osascript as argv items, never inside the AppleScript source', async () => {
    const bin = join(tempDir('agent-office-notify-'), 'bin')
    fakeBin(bin, 'osascript', `${LOG_ARGS} >> "$NOTIFY_LOG"`)
    for (const msg of NASTY) {
      const { code, calls } = await runNotify(bin, 'Office Chat', msg)
      expect(code).toBe(0)
      const args = calls.at(-1)!
      expect(args.slice(-2)).toEqual(['Office Chat', msg])
      const statements = args.slice(0, -2).filter(a => a !== '-e')
      expect(statements).toEqual(['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv)', 'end run'])
    }
  })

  it.skipIf(process.platform === 'darwin')('falls back to notify-send on Linux and keeps a leading dash from becoming an option', async () => {
    const bin = join(tempDir('agent-office-notify-'), 'bin')
    fakeBin(bin, 'notify-send', `${LOG_ARGS} >> "$NOTIFY_LOG"`)
    const { code, calls } = await runNotify(bin, 'Agent Failed', '-u critical Debugger failed')
    expect(code).toBe(0)
    expect(calls).toEqual([['Agent Failed', ' -u critical Debugger failed']])
  })

  it('exits 0 when no notifier is installed', async () => {
    const bin = join(tempDir('agent-office-notify-'), 'bin')
    mkdirSync(bin)
    const { code, calls } = await runNotify(bin, 'Office Chat', NASTY[0])
    expect(code).toBe(0)
    expect(calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// start-office.sh
// ---------------------------------------------------------------------------

describe('start-office.sh', () => {
  it('runs on a Linux box without `open`, reports the URL instead, and tears the watcher down on Ctrl+C', async () => {
    const home = tempDir('agent-office-start-')
    const officeDir = join(home, 'office')
    const bin = join(home, 'bin')
    // Server and Vite "already running": every curl health check succeeds
    fakeBin(bin, 'curl', 'exit 0')
    fakeBin(bin, 'uname', 'echo Linux')
    // An opener that is present but broken, like Debian's openvt-backed `open`
    fakeBin(bin, 'xdg-open', `${LOG_ARGS} >> "$OPEN_LOG"; exit 1`)
    fakeBin(bin, 'open', `${LOG_ARGS} >> "$OPEN_LOG"; exit 0`)
    const openLog = join(home, 'open.jsonl')

    const proc = run('bash', [START], {
      ...process.env,
      HOME: home,
      AGENT_OFFICE_HOME: officeDir,
      AGENT_OFFICE_PORT: '3999',
      AGENT_OFFICE_UI_PORT: '3998',
      PATH: `${bin}:${process.env.PATH}`,
      OPEN_LOG: openLog,
      CHAT_AI_POLL_INTERVAL: '0.2',
    }, false)

    await waitFor('the running banner', () => proc.out.includes('Agent Office is running!'), 10_000)
    expect(proc.child.exitCode).toBeNull()
    expect(proc.out).toContain('Server already running on port 3999')
    expect(proc.out).toContain('Vite already running on port 3998')
    expect(proc.out).toContain('Chat AI watcher ready')
    expect(proc.out).toContain('Could not open a browser automatically — open http://localhost:3998 yourself')
    expect(proc.out).not.toContain('unbound variable')
    expect(readFileSync(openLog, 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual([['http://localhost:3998']])

    const pidFile = join(officeDir, 'chat-watcher.pid')
    const watcherPid = Number(readFileSync(pidFile, 'utf8'))
    expect(alive(watcherPid)).toBe(true)
    expect(existsSync(join(officeDir, 'chat-ai.log'))).toBe(true)
    expect(existsSync(join(officeDir, 'server.pid'))).toBe(false) // not ours to stop

    proc.child.kill('SIGINT')
    expect(await proc.exited).toBe(130)
    await waitFor('the watcher to exit', () => !alive(watcherPid))
    expect(existsSync(pidFile)).toBe(false)
  })
})
