/**
 * The session's own Claude: session_prompt / session_turn_end /
 * session_needs_you / session_tool_done / session_error / session_compact /
 * session_cwd / session_model (from the main-thread hooks) drive one `main`
 * record per session — working, waiting, idle, needs-you, error, compacting —
 * persist the boss's prompts and Claude's replies as chat rows behind the
 * token (at the logPrompts level), and travel on GET /sessions, the WS
 * snapshot and agents.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, postAuthed, postEvent, removeOffice, type Office } from './helpers'

const ALPHA = {
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
  project: 'alpha',
  cwd: '/home/me/alpha',
  transcriptPath: '/root/.claude/projects/-home-me-alpha/aaaaaaaa-1111-4111-8111-111111111111.jsonl',
}
const BETA = {
  sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
  project: 'beta',
  cwd: '/home/me/beta',
  transcriptPath: '/root/.claude/projects/-home-me-beta/bbbbbbbb-2222-4222-8222-222222222222.jsonl',
}

const DEBOUNCE_MS = 300
const TIMEOUT_MS = 10 * 60_000

const gp = (id: string, task: string) => ({ id, name: 'Agent', role: 'general-purpose', task, agentType: 'general-purpose', background: true })

/** GET /chat with the office token: the transcript rows included. */
const chatRows = async (office: Office) =>
  (await request(office.server.app).get('/chat').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)).body.messages as Array<Record<string, any>>
/** GET /chat as any other local process sees it. */
const openChatRows = async (office: Office) => (await request(office.server.app).get('/chat')).body.messages as Array<Record<string, any>>
const main = (office: Office, sessionId: string) => office.server.sessions.get(sessionId)?.main

/** The `[main] ...` lines the server logged while `fn` ran. */
function mainLog(fn: () => void): string[] {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    fn()
    return spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[main]'))
  } finally {
    spy.mockRestore()
  }
}

/**
 * Raise a needs-you and let the debounce run out. processEvent itself says
 * nothing (the wait is parked); the state and the broadcast come 300 ms later.
 */
function raise(office: Office, body: Record<string, unknown>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    expect(office.server.processEvent({ type: 'session_needs_you', ...body })).toBeNull()
    vi.advanceTimersByTime(DEBOUNCE_MS)
  } finally {
    vi.useRealTimers()
  }
}

describe('session_prompt (UserPromptSubmit)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('a new session starts with an idle main record', () => {
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    expect(main(office, ALPHA.sessionId)).toEqual({ state: 'idle', since: expect.any(Number), waitingOn: 0 })
  })

  it('moves Claude to working, remembers the prompt, persists a Boss row (role boss, msg_type prompt) and logs the transition', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let res: any
    let lines: string[]
    try {
      res = await postEvent(office.server, { type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'fix the login bug', isWakeup: false })
      lines = spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[main]'))
    } finally {
      spy.mockRestore()
    }
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(lines).toEqual(['[main] alpha: idle -> working (prompt)', '[main] alpha: prompt: fix the login bug'])

    const m = main(office, ALPHA.sessionId)
    expect(m).toMatchObject({ state: 'working', lastPrompt: 'fix the login bug', promptId: 'p-1', waitingOn: 0 })
    expect(m.lastPromptAt).toBeTypeOf('number')
    expect(m.since).toBeLessThanOrEqual(m.lastPromptAt)

    expect(await chatRows(office)).toEqual([
      expect.objectContaining({ sender: 'Boss', role: 'boss', text: 'fix the login bug', msg_type: 'prompt', recipient: null, is_system: 0 }),
    ])
  })

  it('returns its own broadcast shape (not a chat_message) with the row id and main', () => {
    const ev = office.server.processEvent({ type: 'session_prompt', ...BETA, promptId: 'p-2', text: 'hello there' })
    expect(ev).toEqual({
      type: 'session_prompt', sessionId: BETA.sessionId, project: 'beta', promptId: 'p-2', text: 'hello there', isWakeup: false,
      messageId: expect.any(Number),
      main: { state: 'working', since: expect.any(Number), waitingOn: 0, lastPrompt: 'hello there', lastPromptAt: expect.any(Number), promptId: 'p-2' },
      timestamp: expect.any(Number),
    })
    // The session was created implicitly by the prompt
    expect(office.server.sessions.get(BETA.sessionId)).toMatchObject({ source: 'implicit', project: 'beta' })
  })

  it('a wake-up (a background worker reporting back) is not a Boss row and names the worker, resolved to its office agent', async () => {
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Count etc') })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-a1', subagentId: 'ac5ff55b850b4fecf', ...ALPHA })
    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'Waiting for the count.', backgroundTasks: [], crons: 0 })
    const before = (await chatRows(office)).length

    const ev = office.server.processEvent({
      type: 'session_prompt', ...ALPHA, promptId: 'p-3', text: 'Agent "Count etc" finished',
      isWakeup: true, wakeupAgentId: 'ac5ff55b850b4fecf', wakeupStatus: 'completed',
    })
    expect(ev).toMatchObject({
      type: 'session_prompt', isWakeup: true, text: 'Agent "Count etc" finished',
      wakeupAgentId: 'ac5ff55b850b4fecf', wakeupOfficeId: 'agent-a1', wakeupStatus: 'completed',
      main: expect.objectContaining({ state: 'working', lastPrompt: 'Agent "Count etc" finished', promptId: 'p-3' }),
    })
    expect(ev).not.toHaveProperty('messageId')
    expect((await chatRows(office)).length).toBe(before)

    // An unknown worker id is passed through without an office id
    const unknown = office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-4', text: 'Agent "x" finished', isWakeup: true, wakeupAgentId: 'nope' })
    expect(unknown).toMatchObject({ isWakeup: true, wakeupAgentId: 'nope' })
    expect(unknown).not.toHaveProperty('wakeupOfficeId')
  })

  it('clears a raised needs-you, a parked one, and an error', () => {
    raise(office, { ...ALPHA, kind: 'permission', promptId: 'p-4', toolName: 'Write', summary: 'probe.txt' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'needs-you', needsYou: expect.objectContaining({ kind: 'permission' }) })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-5', text: 'try again' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working', promptId: 'p-5' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('needsYou')

    // Parked (still inside the debounce) when the prompt arrives: never applied
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-5', toolName: 'Bash', summary: 'ls' })
    expect(office.server.pendingNeedsYou.has(ALPHA.sessionId)).toBe(true)
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-6', text: 'and again' })
    expect(office.server.pendingNeedsYou.has(ALPHA.sessionId)).toBe(false)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    vi.useRealTimers()
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working', promptId: 'p-6' })

    office.server.processEvent({ type: 'session_error', ...ALPHA, promptId: 'p-6', error: 'rate_limit', detail: '429' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'error', error: { error: 'rate_limit', detail: '429', since: expect.any(Number) } })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-7', text: 'once more' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('error')
  })

  it('POST /event clamps the text (2000 at logPrompts=full), the prompt id to 80, and reads isWakeup only as a real boolean', async () => {
    await postAuthed(office.server, '/settings', { logPrompts: 'full' })
    const res = await postEvent(office.server, { type: 'session_prompt', ...BETA, promptId: 'q'.repeat(200), text: 'x'.repeat(5000), isWakeup: 'yes', wakeupAgentId: 'w'.repeat(200) })
    expect(res.status).toBe(200)
    const m = main(office, BETA.sessionId)
    expect(m.lastPrompt).toHaveLength(2000)
    expect(m.promptId).toHaveLength(80)
    // Not a wake-up, so the prompt was persisted as the boss speaking
    const rows = await chatRows(office)
    expect(rows.at(-1)).toMatchObject({ sender: 'Boss', role: 'boss', msg_type: 'prompt' })
    expect(rows.at(-1)!.text).toHaveLength(2000)
    await postAuthed(office.server, '/settings', { logPrompts: 'summary' })
  })

  it('an empty prompt changes the state but persists no row; a prompt without a sessionId is ignored', async () => {
    const before = (await chatRows(office)).length
    office.server.processEvent({ type: 'session_turn_end', ...BETA, text: '', backgroundTasks: [], crons: 0 })
    const ev = office.server.processEvent({ type: 'session_prompt', ...BETA, promptId: 'p-7', text: '' })
    expect(ev).toMatchObject({ type: 'session_prompt', text: '', main: expect.objectContaining({ state: 'working' }) })
    expect(ev).not.toHaveProperty('messageId')
    expect((await chatRows(office)).length).toBe(before)

    expect(office.server.processEvent({ type: 'session_prompt', text: 'orphan', promptId: 'p' })).toBeNull()
    expect(office.server.sessions.size).toBe(2)
  })
})

describe('logPrompts: what of the conversation is kept (GET/POST /settings)', () => {
  const offices: Office[] = []
  afterEach(() => {
    while (offices.length) removeOffice(offices.pop())
  })

  it('defaults to summary (200 characters), is readable openly and changed with the token, and comes back after a restart from settings.json', async () => {
    const office = await loadOffice()
    offices.push(office)
    expect((await request(office.server.app).get('/settings')).body).toEqual({ logPrompts: 'summary', answerPermissions: true, logPromptsLevels: ['off', 'summary', 'full'] })
    expect(existsSync(join(office.dir, 'settings.json'))).toBe(false)  // nothing written until a change

    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'p'.repeat(500) })
    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'r'.repeat(500), backgroundTasks: [], crons: 0 })
    expect(main(office, ALPHA.sessionId).lastPrompt).toHaveLength(200)
    expect(main(office, ALPHA.sessionId).lastReply).toHaveLength(200)
    expect((await chatRows(office)).map(m => m.text.length)).toEqual([200, 200])

    const bad = await postAuthed(office.server, '/settings', { logPrompts: 'everything' })
    expect(bad.status).toBe(400)
    expect(bad.body).toEqual({ error: 'logPrompts must be one of off, summary, full' })
    expect((await request(office.server.app).post('/settings').send({ logPrompts: 'off' })).status).toBe(401)

    const set = await postAuthed(office.server, '/settings', { logPrompts: 'off' })
    expect(set.status).toBe(200)
    expect(set.body).toEqual({ ok: true, logPrompts: 'off', answerPermissions: true })
    expect(JSON.parse(readFileSync(join(office.dir, 'settings.json'), 'utf8'))).toEqual({ logPrompts: 'off', answerPermissions: true })

    const again = await loadOffice({ dir: office.dir })
    offices.push(again)
    expect(again.server.settings.logPrompts).toBe('off')
    expect((await request(again.server.app).get('/settings')).body.logPrompts).toBe('off')
  })

  it('off: state transitions only — no text stored, broadcast or persisted; full: the whole 2000-character clamp', async () => {
    const office = await loadOffice()
    offices.push(office)
    await postAuthed(office.server, '/settings', { logPrompts: 'off' })

    const prompt = office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'the secret plan' })
    expect(prompt).toMatchObject({ type: 'session_prompt', text: '', isWakeup: false, main: expect.objectContaining({ state: 'working', lastPrompt: '' }) })
    expect(prompt).not.toHaveProperty('messageId')
    const reply = office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'the secret answer', backgroundTasks: [], crons: 0 })
    expect(reply).toMatchObject({ type: 'session_turn_end', text: '', main: expect.objectContaining({ state: 'idle', lastReply: '' }) })
    expect(reply).not.toHaveProperty('messageId')
    expect(await chatRows(office)).toEqual([])
    expect(JSON.stringify(JSON.parse(readFileSync(join(office.dir, 'agents.json'), 'utf8')))).not.toMatch(/secret/)

    await postAuthed(office.server, '/settings', { logPrompts: 'full' })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'x'.repeat(3000) })
    expect(main(office, ALPHA.sessionId).lastPrompt).toHaveLength(2000)
    expect((await chatRows(office)).at(-1)!.text).toHaveLength(2000)
  })

  it('a settings.json with junk in it is ignored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ logPrompts: 'everything' }))
    const office = await loadOffice({ dir })
    offices.push(office)
    expect(office.server.settings.logPrompts).toBe('summary')
    writeFileSync(join(dir, 'settings.json'), '{not json')
    const again = await loadOffice({ dir })
    offices.push(again)
    expect(again.server.settings.logPrompts).toBe('summary')
  })
})

describe('the transcript stays behind the token', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Count etc') })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'count /etc please' })
    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: '/etc has 154 entries.', backgroundTasks: [], crons: 0 })
    await request(office.server.app).post('/chat').send({ sender: 'Antony', text: 'nice' })
    await postAuthed(office.server, '/chat/reply', { sender: 'Reviewer', role: 'code-reviewer', recipient: 'Agent', text: 'ping' })
  })
  afterAll(() => removeOffice(office))

  it('GET /chat without the token (the watcher, any local process) never returns prompt/reply rows; with it, it does; ?since and ?recipient behave the same', async () => {
    const open = await openChatRows(office)
    expect(open.map(m => m.text)).toEqual(['starting: Count etc', 'nice', 'ping'])
    expect(open.some(m => m.msg_type === 'prompt' || m.msg_type === 'reply')).toBe(false)

    const withToken = await chatRows(office)
    expect(withToken.map(m => [m.sender, m.msg_type])).toEqual([
      ['Agent', null], ['Boss', 'prompt'], ['Claude', 'reply'], ['Antony', null], ['Reviewer', 'message'],
    ])

    const since = await request(office.server.app).get('/chat?since=1')
    expect(since.body.messages.map((m: any) => m.text)).toEqual(['starting: Count etc', 'nice', 'ping'])
    const sinceToken = await request(office.server.app).get('/chat?since=1').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    expect(sinceToken.body.messages).toHaveLength(5)
    const inbox = await request(office.server.app).get('/chat?recipient=Agent')
    expect(inbox.body.messages.map((m: any) => m.text)).toEqual(['ping'])
  })

  it('GET /sessions leaves the prompt and reply text out of main unless the token is presented; the WS snapshot keeps them', async () => {
    const open = await request(office.server.app).get('/sessions')
    expect(open.body.sessions[0].main).toEqual({
      state: 'idle', since: expect.any(Number), waitingOn: 0, crons: 0, promptId: 'p-1',
      lastPromptAt: expect.any(Number), lastReplyAt: expect.any(Number),
    })
    const withToken = await request(office.server.app).get('/sessions').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    expect(withToken.body.sessions[0].main).toMatchObject({ lastPrompt: 'count /etc please', lastReply: '/etc has 154 entries.' })
  })
})

describe('main-thread tool calls (agent_working without an agent)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_started', ...BETA, source: 'startup' })
  })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('moves Claude to working and logs the change once, not on every tool call', () => {
    const first = mainLog(() => office.server.processEvent({ type: 'agent_working', status: 'reading index.js', ...ALPHA }))
    expect(first).toEqual(['[main] alpha: idle -> working (tool call: reading index.js)'])
    const second = mainLog(() => office.server.processEvent({ type: 'agent_working', status: 'editing index.js', ...ALPHA }))
    expect(second).toEqual([])
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(office.server.sessions.get(ALPHA.sessionId).lastStatus).toBe('editing index.js')
    // The broadcast shape is unchanged
    const ev = office.server.processEvent({ type: 'agent_working', status: 'running: make', ...ALPHA })
    expect(ev).toEqual({ type: 'agent_working', agentId: undefined, status: 'running: make', sessionId: ALPHA.sessionId, project: 'alpha', timestamp: expect.any(Number) })
  })

  it("a worker's tool call leaves main alone", () => {
    office.server.processEvent({ type: 'agent_spawned', ...BETA, agent: gp('agent-b1', 'beta work') })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-b1', subagentId: 'sub-b1', ...BETA })
    office.server.processEvent({ type: 'agent_working', agentId: 'sub-b1', status: 'running: ls', ...BETA })
    expect(main(office, BETA.sessionId)).toMatchObject({ state: 'idle' })
    expect(office.server.activeAgents.get('agent-b1')).toMatchObject({ state: 'working' })
  })

  it('does not lower a permission hand raised less than 1 s earlier (the PreToolUse POST can arrive after the PermissionRequest POST), but does after', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')

    // A working event does not cancel a parked wait either
    vi.advanceTimersByTime(200)
    office.server.processEvent({ type: 'agent_working', status: 'writing probe.txt', ...ALPHA })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'needs-you', needsYou: expect.objectContaining({ toolName: 'Write' }) })

    vi.advanceTimersByTime(600)
    office.server.processEvent({ type: 'agent_working', status: 'writing other.txt', ...ALPHA })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('needsYou')

    // Other kinds are lowered at once: Claude is visibly back at work
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'idle', promptId: 'p-1', notificationType: 'idle_prompt', message: 'waiting' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')
    office.server.processEvent({ type: 'agent_working', status: 'reading x', ...ALPHA })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    vi.useRealTimers()
  })
})

describe('session_needs_you (PermissionRequest / Notification)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'write probe.txt' })
  })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('PermissionRequest -> parked, then needs-you with {kind, toolName, summary, since, promptId} once the 300 ms debounce runs out', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const t0 = Date.now()
    let lines: string[] = []
    lines = mainLog(() => {
      expect(office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' })).toBeNull()
    })
    expect(lines).toEqual(['[main] alpha: needs-you requested (permission: Write probe.txt)'])
    expect(main(office, ALPHA.sessionId).state).toBe('working')
    expect(office.server.pendingNeedsYou.get(ALPHA.sessionId)).toMatchObject({ wait: { kind: 'permission', since: t0, promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' } })

    vi.advanceTimersByTime(DEBOUNCE_MS - 1)
    expect(main(office, ALPHA.sessionId).state).toBe('working')
    lines = mainLog(() => vi.advanceTimersByTime(1))
    expect(lines).toEqual(['[main] alpha: working -> needs-you (permission: Write probe.txt)'])
    expect(office.server.pendingNeedsYou.size).toBe(0)
    expect(main(office, ALPHA.sessionId)).toMatchObject({
      state: 'needs-you', since: t0 + DEBOUNCE_MS, promptId: 'p-1',
      needsYou: { kind: 'permission', since: t0, promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' },
    })
    vi.useRealTimers()
  })

  it('the Notification{permission_prompt} that follows ~6 s later for the same prompt is the same wait: nothing changes, nothing is parked', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const since = main(office, ALPHA.sessionId).needsYou.since
    vi.setSystemTime(Date.now() + 6_000)
    const dup = office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', notificationType: 'permission_prompt', message: 'Claude needs your permission' })
    expect(dup).toBeNull()
    expect(office.server.pendingNeedsYou.size).toBe(0)
    expect(main(office, ALPHA.sessionId).needsYou).toEqual({ kind: 'permission', since, promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' })
    // So is a replayed PermissionRequest for the same tool, and a second copy of a parked wait
    expect(office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' })).toBeNull()
    expect(office.server.pendingNeedsYou.size).toBe(0)
    vi.useRealTimers()
  })

  it('a different tool, another prompt, or more than 10 s later is a new wait (since reset)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const first = main(office, ALPHA.sessionId).needsYou.since
    vi.setSystemTime(first + 1_000)
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Bash', summary: 'rm -rf node_modules' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).needsYou).toMatchObject({ toolName: 'Bash', since: first + 1_000 })

    vi.setSystemTime(Date.now() + 1_000)
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-2', toolName: 'Bash', summary: 'rm -rf node_modules' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).needsYou).toMatchObject({ promptId: 'p-2' })
    expect(main(office, ALPHA.sessionId).promptId).toBe('p-2')

    vi.setSystemTime(Date.now() + 10_001)
    const requestedAt = Date.now()
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-2', toolName: 'Bash', summary: 'rm -rf node_modules' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).needsYou.since).toBe(requestedAt)
    vi.useRealTimers()
  })

  it('a newer parked wait replaces an older one; idle, quota and agent-input kinds carry the notification type and message; an unknown kind is ignored', async () => {
    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-2', text: 'Done.', backgroundTasks: [], crons: 0 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-3', toolName: 'Write', summary: 'a.txt' })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'idle', promptId: 'p-3', notificationType: 'idle_prompt', message: 'Claude is waiting for your input' })
    expect(office.server.pendingNeedsYou.get(ALPHA.sessionId).wait.kind).toBe('idle')
    vi.advanceTimersByTime(DEBOUNCE_MS)
    vi.useRealTimers()
    expect(main(office, ALPHA.sessionId).needsYou).toEqual({ kind: 'idle', since: expect.any(Number), promptId: 'p-3', notificationType: 'idle_prompt', message: 'Claude is waiting for your input' })

    for (const [kind, notificationType] of [['quota', 'quota_auto_resume_stale'], ['agent-input', 'agent_needs_input']]) {
      raise(office, { ...ALPHA, kind, promptId: 'p-3', notificationType, message: 'm' })
      expect(main(office, ALPHA.sessionId).needsYou).toMatchObject({ kind, notificationType, message: 'm' })
    }

    const before = { ...main(office, ALPHA.sessionId) }
    const res = await postEvent(office.server, { type: 'session_needs_you', ...ALPHA, kind: 'dance', promptId: 'p-3' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(office.server.pendingNeedsYou.size).toBe(0)
    expect(main(office, ALPHA.sessionId)).toEqual(before)
    expect(office.server.processEvent({ type: 'session_needs_you', ...ALPHA, promptId: 'p-3' })).toBeNull()
    expect(office.server.processEvent({ type: 'session_needs_you', kind: 'permission', promptId: 'p-3' })).toBeNull()
  })

  it('summary/message are clamped to 200 by POST /event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await postEvent(office.server, { type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-5', toolName: 'Bash', summary: 's'.repeat(500), message: 'm'.repeat(500) })
      vi.advanceTimersByTime(DEBOUNCE_MS)
    } finally {
      vi.useRealTimers()
    }
    expect(main(office, ALPHA.sessionId).needsYou.summary).toHaveLength(200)
    expect(main(office, ALPHA.sessionId).needsYou.message).toHaveLength(200)
  })

  it('a hand nobody answers comes down after 10 minutes (idle)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-6', text: 'go' })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-6', toolName: 'Write', summary: 'b.txt' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')

    vi.advanceTimersByTime(TIMEOUT_MS - 1)
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')
    const lines = mainLog(() => vi.advanceTimersByTime(1))
    expect(lines).toEqual(['[main] alpha: needs-you -> idle (needs-you unanswered for 10 min)'])
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'idle' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('needsYou')

    // Answered in time: the timer is gone with the hand
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-6', toolName: 'Write', summary: 'c.txt' })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    office.server.processEvent({ type: 'session_tool_done', ...ALPHA, toolName: 'Write' })
    expect(main(office, ALPHA.sessionId).state).toBe('working')
    vi.advanceTimersByTime(TIMEOUT_MS + 1)
    expect(main(office, ALPHA.sessionId).state).toBe('working')
    vi.useRealTimers()
  })
})

describe('session_tool_done (main-thread PostToolUse / PostToolBatch)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'write probe.txt' })
  })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('a headless auto-deny (PermissionRequest, PostToolBatch ~60 ms later) never shows: the parked wait is withdrawn, nothing is broadcast', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' })
    vi.advanceTimersByTime(60)
    let ev: any
    const lines = mainLog(() => {
      ev = office.server.processEvent({ type: 'session_tool_done', ...ALPHA, batch: true, count: 1 })
    })
    expect(ev).toBeNull()
    expect(lines).toEqual(['[main] alpha: needs-you withdrawn before it was shown (permission: Write probe.txt; tool batch of 1 done 60 ms later)'])
    expect(office.server.pendingNeedsYou.size).toBe(0)
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('needsYou')
    vi.useRealTimers()
  })

  it('a granted call lowers the hand: PostToolUse of that tool (not another tool in the same batch), or the batch ending; the change is broadcast as session_main', () => {
    raise(office, { ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Write', summary: 'probe.txt' })
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')

    // A Read that ran in parallel says nothing about the Write
    expect(office.server.processEvent({ type: 'session_tool_done', ...ALPHA, toolName: 'Read' })).toBeNull()
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')

    let ev: any
    const lines = mainLog(() => {
      ev = office.server.processEvent({ type: 'session_tool_done', ...ALPHA, toolName: 'Write' })
    })
    expect(lines).toEqual(['[main] alpha: needs-you -> working (Write ran)'])
    expect(ev).toEqual({
      type: 'session_main', sessionId: ALPHA.sessionId, project: 'alpha', reason: 'permission answered',
      main: expect.objectContaining({ state: 'working', promptId: 'p-1' }), timestamp: expect.any(Number),
    })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('needsYou')

    // The batch ending lowers any permission hand, even one without a tool name (a Notification alone raised it)
    raise(office, { ...ALPHA, kind: 'permission', promptId: 'p-1', notificationType: 'permission_prompt', message: 'Claude needs your permission' })
    expect(office.server.processEvent({ type: 'session_tool_done', ...ALPHA, toolName: 'Write' })).toBeNull()
    expect(office.server.processEvent({ type: 'session_tool_done', ...ALPHA, batch: true, count: 2 })).toMatchObject({ type: 'session_main', main: expect.objectContaining({ state: 'working' }) })
  })

  it('says nothing when no hand is up, for other kinds, or without a session', () => {
    expect(office.server.processEvent({ type: 'session_tool_done', ...ALPHA, toolName: 'Bash' })).toBeNull()
    expect(office.server.processEvent({ type: 'session_tool_done', ...ALPHA, batch: true, count: 3 })).toBeNull()
    expect(main(office, ALPHA.sessionId).state).toBe('working')

    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'done', backgroundTasks: [], crons: 0 })
    raise(office, { ...ALPHA, kind: 'idle', promptId: 'p-1', notificationType: 'idle_prompt', message: 'waiting' })
    expect(office.server.processEvent({ type: 'session_tool_done', ...ALPHA, batch: true, count: 1 })).toBeNull()
    expect(main(office, ALPHA.sessionId).state).toBe('needs-you')

    expect(office.server.processEvent({ type: 'session_tool_done', toolName: 'Write' })).toBeNull()
  })
})

describe('session_turn_end (Stop)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'count /etc' })
  })
  afterAll(() => removeOffice(office))

  it('with no background task: idle, the reply is stored and persisted as a Claude row (role assistant, msg_type reply), needs-you cleared', async () => {
    raise(office, { ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Bash', summary: 'ls /etc' })
    let ev: any
    const log = mainLog(() => {
      ev = office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: '/etc has 154 entries.', backgroundTasks: [], crons: 0, stopHookActive: false })
    })
    expect(log).toEqual(['[main] alpha: needs-you -> idle (turn ended)', '[main] alpha: reply: /etc has 154 entries.'])
    expect(ev).toEqual({
      type: 'session_turn_end', sessionId: ALPHA.sessionId, project: 'alpha', promptId: 'p-1', text: '/etc has 154 entries.',
      backgroundTasks: [], crons: 0, stopHookActive: false, messageId: expect.any(Number),
      main: { state: 'idle', since: expect.any(Number), waitingOn: 0, lastPrompt: 'count /etc', lastPromptAt: expect.any(Number), lastReply: '/etc has 154 entries.', lastReplyAt: expect.any(Number), crons: 0, promptId: 'p-1' },
      timestamp: expect.any(Number),
    })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('needsYou')
    expect(await chatRows(office)).toEqual([
      expect.objectContaining({ sender: 'Boss', role: 'boss', msg_type: 'prompt', text: 'count /etc' }),
      expect.objectContaining({ sender: 'Claude', role: 'assistant', msg_type: 'reply', text: '/etc has 154 entries.', recipient: null, is_system: 0 }),
    ])
  })

  it('with a running background task: waiting, waitingOn counts running/pending entries, subagent tasks are resolved to office agents', () => {
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Count etc') })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-a1', subagentId: 'ac5ff55b850b4fecf', ...ALPHA })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'count in the background' })
    const tasks = [
      { id: 'ac5ff55b850b4fecf', type: 'subagent', status: 'running', description: 'Count etc' },
      { id: 'sh1', type: 'shell', status: 'pending', description: 'npm test' },
      { id: 'sh0', type: 'shell', status: 'completed', description: 'npm ci' },
    ]
    let ev: any
    const log = mainLog(() => {
      ev = office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-2', text: 'Counting; I will reply DONE when it finishes.', backgroundTasks: tasks, crons: 1, stopHookActive: false })
    })
    expect(log[0]).toBe('[main] alpha: working -> waiting (turn ended, 2 background task(s) still running)')
    expect(ev).toMatchObject({
      type: 'session_turn_end', crons: 1,
      backgroundTasks: [
        { id: 'ac5ff55b850b4fecf', type: 'subagent', status: 'running', description: 'Count etc', officeId: 'agent-a1' },
        { id: 'sh1', type: 'shell', status: 'pending', description: 'npm test' },
        { id: 'sh0', type: 'shell', status: 'completed', description: 'npm ci' },
      ],
      main: expect.objectContaining({ state: 'waiting', waitingOn: 2, crons: 1, lastReply: 'Counting; I will reply DONE when it finishes.' }),
    })
    expect(ev.backgroundTasks[1]).not.toHaveProperty('officeId')

    // The wake-up prompt puts Claude back to work; its final Stop makes it idle
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-3', text: 'Agent "Count etc" finished', isWakeup: true, wakeupAgentId: 'ac5ff55b850b4fecf' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-3', text: 'DONE', backgroundTasks: [], crons: 0 })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'idle', waitingOn: 0, lastReply: 'DONE' })
  })

  it('an empty reply persists no row; a Stop without a sessionId is ignored', async () => {
    const before = (await chatRows(office)).length
    const ev = office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-4', text: '', backgroundTasks: [], crons: 0 })
    expect(ev).not.toHaveProperty('messageId')
    expect((await chatRows(office)).length).toBe(before)
    expect(office.server.processEvent({ type: 'session_turn_end', text: 'x', backgroundTasks: [] })).toBeNull()
  })

  it('POST /event keeps at most 10 tasks with four clamped fields each, clamps the text and drops junk', async () => {
    await postAuthed(office.server, '/settings', { logPrompts: 'full' })
    const res = await postEvent(office.server, {
      type: 'session_turn_end', ...ALPHA, promptId: 'p-5', text: 'r'.repeat(5000),
      backgroundTasks: [
        { id: 'x'.repeat(100), type: 't'.repeat(100), status: 'running', description: 'd'.repeat(500), command: 'secret --flag', extra: 1 },
        'junk', null,
        ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, type: 'monitor', status: 'pending', description: `m${i}` })),
      ],
      crons: -3, stopHookActive: 'yes',
    })
    expect(res.status).toBe(200)
    const m = main(office, ALPHA.sessionId)
    expect(m.lastReply).toHaveLength(2000)
    expect(m).toMatchObject({ state: 'waiting', waitingOn: 8, crons: 0 })
    const rows = await chatRows(office)
    expect(rows.at(-1)!.text).toHaveLength(2000)
    const saved = JSON.parse(readFileSync(join(office.dir, 'agents.json'), 'utf8'))
    expect(JSON.stringify(saved)).not.toContain('secret --flag')
  })
})

describe('session_error (StopFailure) and session_compact (Pre/PostCompact)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
  })
  afterAll(() => removeOffice(office))

  it('an API error -> error with {error, detail}; detail clamped to 200 by POST /event; the next tool call clears it', async () => {
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'go' })
    let ev: any
    const log = mainLog(() => {
      ev = office.server.processEvent({ type: 'session_error', ...ALPHA, promptId: 'p-1', error: 'rate_limit', detail: '429 Too Many Requests' })
    })
    expect(log).toEqual(['[main] alpha: working -> error (rate_limit: 429 Too Many Requests)'])
    expect(ev).toEqual({
      type: 'session_error', sessionId: ALPHA.sessionId, project: 'alpha', promptId: 'p-1', error: 'rate_limit', detail: '429 Too Many Requests',
      main: expect.objectContaining({ state: 'error', error: { error: 'rate_limit', detail: '429 Too Many Requests', since: expect.any(Number) } }),
      timestamp: expect.any(Number),
    })

    await postEvent(office.server, { type: 'session_error', ...ALPHA, promptId: 'p-1', error: 'overloaded', detail: 'x'.repeat(500) })
    expect(main(office, ALPHA.sessionId).error).toMatchObject({ error: 'overloaded' })
    expect(main(office, ALPHA.sessionId).error.detail).toHaveLength(200)
    expect(office.server.processEvent({ type: 'session_error', ...ALPHA })).toMatchObject({ error: 'unknown', detail: '' })

    office.server.processEvent({ type: 'agent_working', status: 'reading x', ...ALPHA })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('error')
  })

  it('pre -> compacting, post -> the state Claude was in (working stays working; idle stays idle)', () => {
    expect(main(office, ALPHA.sessionId).state).toBe('working')
    let ev: any
    const log = mainLog(() => {
      ev = office.server.processEvent({ type: 'session_compact', ...ALPHA, promptId: 'p-1', phase: 'pre', trigger: 'auto' })
      office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'compact', model: 'claude-haiku-5-5' })  // fires between the two
      office.server.processEvent({ type: 'session_compact', ...ALPHA, promptId: 'p-1', phase: 'post', trigger: 'auto' })
    })
    expect(log).toEqual(['[main] alpha: working -> compacting (auto compaction)', '[main] alpha: compacting -> working (compaction done)'])
    expect(ev).toEqual({
      type: 'session_compact', sessionId: ALPHA.sessionId, project: 'alpha', promptId: 'p-1', phase: 'pre', trigger: 'auto',
      main: expect.objectContaining({ state: 'compacting', beforeCompact: 'working' }), timestamp: expect.any(Number),
    })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('beforeCompact')
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ source: 'startup', model: 'claude-haiku-5-5' })

    office.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'ok', backgroundTasks: [], crons: 0 })
    office.server.processEvent({ type: 'session_compact', ...ALPHA, phase: 'pre', trigger: 'manual' })
    office.server.processEvent({ type: 'session_compact', ...ALPHA, phase: 'post', trigger: 'manual' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'idle' })
  })

  it('a pre without a post (compaction refused) is left behind by the next prompt or tool call; a post without a pre changes nothing; an unknown phase is ignored', async () => {
    office.server.processEvent({ type: 'session_compact', ...ALPHA, phase: 'pre', trigger: 'manual' })
    expect(main(office, ALPHA.sessionId).state).toBe('compacting')
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'carry on' })
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'working' })
    expect(main(office, ALPHA.sessionId)).not.toHaveProperty('beforeCompact')

    const ev = office.server.processEvent({ type: 'session_compact', ...ALPHA, phase: 'post', trigger: 'manual' })
    expect(ev).toMatchObject({ type: 'session_compact', phase: 'post', main: expect.objectContaining({ state: 'working' }) })

    expect(office.server.processEvent({ type: 'session_compact', ...ALPHA, phase: 'during' })).toBeNull()
    const res = await postEvent(office.server, { type: 'session_compact', ...ALPHA, phase: 'during' })
    expect(res.status).toBe(200)
    expect(main(office, ALPHA.sessionId).state).toBe('working')
    expect(office.server.processEvent({ type: 'session_compact', ...ALPHA, phase: 'pre' })).toMatchObject({ trigger: 'manual' })
  })
})

describe('session_cwd (CwdChanged) and session_model (PostModelSwitch)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup', model: 'claude-haiku-5-5' })
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Count etc') })
  })
  afterAll(() => removeOffice(office))

  it('a cd moves the session and its workers to the new project; the broadcast is the session with oldCwd', async () => {
    const ev = office.server.processEvent({ type: 'session_cwd', ...ALPHA, cwd: '/home/me/beta', project: 'beta', oldCwd: '/home/me/alpha' })
    expect(ev).toEqual(expect.objectContaining({
      type: 'session_cwd', sessionId: ALPHA.sessionId, project: 'beta', cwd: '/home/me/beta', oldCwd: '/home/me/alpha', agentIds: ['agent-a1'], timestamp: expect.any(Number),
    }))
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ cwd: '/home/me/beta', project: 'beta' })
    expect(office.server.activeAgents.get('agent-a1').project).toBe('beta')
    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents[0]).toMatchObject({ id: 'agent-a1', project: 'beta' })

    // The project is derived when the event has none; without a cwd nothing happens
    office.server.processEvent({ type: 'session_cwd', sessionId: ALPHA.sessionId, cwd: '/tmp/' })
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ cwd: '/tmp/', project: 'tmp' })
    expect(office.server.processEvent({ type: 'session_cwd', sessionId: ALPHA.sessionId })).toBeNull()
    expect(office.server.processEvent({ type: 'session_cwd', cwd: '/x' })).toBeNull()
  })

  it('a model switch updates the session model; the broadcast says where from', () => {
    const ev = office.server.processEvent({ type: 'session_model', ...ALPHA, model: 'claude-opus-4-1', fromModel: 'claude-haiku-5-5', switchSource: 'command' })
    expect(ev).toEqual(expect.objectContaining({ type: 'session_model', sessionId: ALPHA.sessionId, model: 'claude-opus-4-1', fromModel: 'claude-haiku-5-5', switchSource: 'command' }))
    expect(office.server.sessions.get(ALPHA.sessionId).model).toBe('claude-opus-4-1')
    // From the session's own record when the event has no fromModel
    expect(office.server.processEvent({ type: 'session_model', ...ALPHA, model: 'claude-sonnet-4-5' })).toMatchObject({ model: 'claude-sonnet-4-5', fromModel: 'claude-opus-4-1' })
    expect(office.server.processEvent({ type: 'session_model', ...ALPHA })).toBeNull()
  })

  it('POST /event accepts both and clamps their strings', async () => {
    const cwd = await postEvent(office.server, { type: 'session_cwd', ...ALPHA, cwd: '/p/' + 'x'.repeat(500), oldCwd: 'o'.repeat(500) })
    expect(cwd.status).toBe(200)
    expect(office.server.sessions.get(ALPHA.sessionId).cwd).toHaveLength(400)
    const model = await postEvent(office.server, { type: 'session_model', ...ALPHA, model: 'm'.repeat(300), fromModel: 'f'.repeat(300), switchSource: 's'.repeat(50) })
    expect(model.status).toBe(200)
    expect(office.server.sessions.get(ALPHA.sessionId).model).toHaveLength(200)
  })
})

describe('agent_completed carries what a foreground agent cost', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('tokens, durationMs, toolUses and model travel on the broadcast and the record; junk values are dropped by POST /event', async () => {
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: { ...gp('agent-fg', 'Find hostname'), background: false } })
    const ev = office.server.processEvent({ type: 'agent_completed', ...ALPHA, agentId: 'agent-fg', result: 'The hostname is vm.', tokens: 20442, durationMs: 2913, toolUses: 1, model: 'claude-haiku-5-5' })
    expect(ev).toMatchObject({ type: 'agent_completed', agentId: 'agent-fg', result: 'The hostname is vm.', tokens: 20442, durationMs: 2913, toolUses: 1, model: 'claude-haiku-5-5', sessionId: ALPHA.sessionId })
    expect(office.server.activeAgents.get('agent-fg')).toMatchObject({ state: 'completed', tokens: 20442, durationMs: 2913, toolUses: 1, model: 'claude-haiku-5-5' })

    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-bg', 'Count etc') })
    const res = await postEvent(office.server, { type: 'agent_completed', ...ALPHA, agentId: 'agent-bg', result: 'done', tokens: -1, durationMs: 'fast', toolUses: 2.5 })
    expect(res.status).toBe(200)
    const bg = office.server.activeAgents.get('agent-bg')
    expect(bg.state).toBe('completed')
    for (const key of ['tokens', 'durationMs', 'toolUses', 'model']) expect(bg).not.toHaveProperty(key)
    // Without the totals (a background agent's SubagentStop) the event is as before
    const plain = office.server.processEvent({ type: 'agent_completed', agentId: 'ghost', result: 'done' })
    expect(plain).toEqual({ type: 'agent_completed', agentId: 'ghost', result: 'done', timestamp: expect.any(Number) })
  })
})

describe('lifecycle: session_ended resets main, a resume starts it idle again', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('an ended session is idle with no prompt, reply or needs-you left (parked ones dropped); the resumed session starts idle', () => {
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'write it' })
    raise(office, { ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Write', summary: 'a.txt' })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    office.server.processEvent({ type: 'session_needs_you', ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Bash', summary: 'ls' })
    expect(office.server.pendingNeedsYou.has(ALPHA.sessionId)).toBe(true)
    const log = mainLog(() => office.server.processEvent({ type: 'session_ended', ...ALPHA, reason: 'prompt_input_exit' }))
    expect(log).toEqual(['[main] alpha: needs-you -> idle (session ended)'])
    expect(office.server.pendingNeedsYou.has(ALPHA.sessionId)).toBe(false)
    expect(main(office, ALPHA.sessionId)).toEqual({ state: 'idle', since: expect.any(Number), waitingOn: 0 })
    vi.advanceTimersByTime(DEBOUNCE_MS)
    expect(main(office, ALPHA.sessionId).state).toBe('idle')

    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'straggler' })  // does not revive the session, but main follows the event
    const ev = office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'resume' })
    expect(ev).toMatchObject({ type: 'session_started', state: 'active', main: { state: 'idle', since: expect.any(Number), waitingOn: 0 } })
    vi.useRealTimers()
  })
})

describe('where main travels', () => {
  let office: Office
  let ws: WebSocket | undefined
  const messages: any[] = []
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'ship it' })
    raise(office, { ...ALPHA, kind: 'permission', promptId: 'p-1', toolName: 'Bash', summary: 'git push' })
    office.server.processEvent({ type: 'session_prompt', ...BETA, promptId: 'p-9', text: 'hi' })
    office.server.processEvent({ type: 'session_turn_end', ...BETA, promptId: 'p-9', text: 'Hello!', backgroundTasks: [], crons: 0 })
  })
  afterAll(async () => {
    ws?.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('GET /sessions (with the token) carries main per session', async () => {
    const list = await request(office.server.app).get('/sessions').set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    const byId = Object.fromEntries(list.body.sessions.map((s: any) => [s.id, s]))
    expect(byId[ALPHA.sessionId].main).toEqual({
      state: 'needs-you', since: expect.any(Number), waitingOn: 0, lastPrompt: 'ship it', lastPromptAt: expect.any(Number), promptId: 'p-1',
      needsYou: { kind: 'permission', since: expect.any(Number), promptId: 'p-1', toolName: 'Bash', summary: 'git push' },
    })
    expect(byId[BETA.sessionId].main).toMatchObject({ state: 'idle', lastPrompt: 'hi', lastReply: 'Hello!', waitingOn: 0 })
  })

  it('the WS snapshot carries main (text included), and a needs-you that outlives the debounce is broadcast with needsYou and main', async () => {
    const port = await listen(office.server.httpServer)
    const snapshot = await new Promise<any>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString())
        messages.push(msg)
        if (msg.type === 'snapshot') resolve(msg)
      })
      ws.once('error', reject)
    })
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: ALPHA.sessionId, main: expect.objectContaining({ state: 'needs-you', lastPrompt: 'ship it', needsYou: expect.objectContaining({ toolName: 'Bash' }) }) }),
      expect.objectContaining({ id: BETA.sessionId, main: expect.objectContaining({ state: 'idle', lastReply: 'Hello!' }) }),
    ])

    // A real-time wait: parked, then broadcast ~300 ms later as its own event type
    office.server.processEvent({ type: 'session_prompt', ...BETA, promptId: 'p-10', text: 'write it' })
    office.server.processEvent({ type: 'session_needs_you', ...BETA, kind: 'permission', promptId: 'p-10', toolName: 'Write', summary: 'notes.md' })
    expect(messages.some(m => m.type === 'session_needs_you')).toBe(false)
    const announced = await new Promise<any>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('needs-you never broadcast')), 3000)
      const poll = setInterval(() => {
        const m = messages.find(x => x.type === 'session_needs_you')
        if (m) { clearInterval(poll); clearTimeout(deadline); resolve(m) }
      }, 20)
    })
    expect(announced).toEqual({
      type: 'session_needs_you', sessionId: BETA.sessionId, project: 'beta', kind: 'permission', promptId: 'p-10', toolName: 'Write', summary: 'notes.md',
      needsYou: { kind: 'permission', since: expect.any(Number), promptId: 'p-10', toolName: 'Write', summary: 'notes.md' },
      main: expect.objectContaining({ state: 'needs-you', promptId: 'p-10', lastPrompt: 'write it' }),
      timestamp: expect.any(Number),
    })
    expect(messages.filter(m => m.type === 'session_needs_you')).toHaveLength(1)
  })

  it('the session_started / session_ended broadcasts carry it as well', () => {
    const ev = office.server.processEvent({ type: 'session_started', ...BETA, source: 'startup' })
    expect(ev).toMatchObject({ type: 'session_started', main: expect.objectContaining({ state: 'needs-you', lastReply: 'Hello!' }) })
  })
})

describe('persistence', () => {
  const offices: Office[] = []
  afterEach(() => {
    while (offices.length) removeOffice(offices.pop())
  })

  it('main is saved in agents.json with its session and restored on a fresh import of the same runtime dir', async () => {
    const first = await loadOffice()
    offices.push(first)
    first.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    first.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-1', text: 'count in the background' })
    first.server.processEvent({ type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text: 'Counting.', backgroundTasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'Count etc' }], crons: 0 })

    const saved = JSON.parse(readFileSync(join(first.dir, 'agents.json'), 'utf8'))
    expect(saved.sessions[0].main).toEqual({
      state: 'waiting', since: expect.any(Number), waitingOn: 1, crons: 0, promptId: 'p-1',
      lastPrompt: 'count in the background', lastPromptAt: expect.any(Number), lastReply: 'Counting.', lastReplyAt: expect.any(Number),
    })

    const second = await loadOffice({ dir: first.dir })
    offices.push(second)
    expect(second.server.sessions.get(ALPHA.sessionId).main).toEqual(saved.sessions[0].main)
    const list = await request(second.server.app).get('/sessions')
    expect(list.body.sessions[0].main).toMatchObject({ state: 'waiting', waitingOn: 1 })
    // ...and the restored record keeps transitioning
    second.server.processEvent({ type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'Agent "Count etc" finished', isWakeup: true, wakeupAgentId: 'a1' })
    expect(second.server.sessions.get(ALPHA.sessionId).main).toMatchObject({ state: 'working', promptId: 'p-2' })
  })

  it('an agents.json from before main gets a fresh idle record; junk in main is replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    const now = Date.now()
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      agents: [],
      sessions: [
        { id: 'older', project: 'older', state: 'active', startedAt: now, lastActivityAt: now, agentIds: [] },
        { id: 'junk', project: 'junk', state: 'active', startedAt: now, lastActivityAt: now, agentIds: [], main: { state: 'dancing' } },
        { id: 'partial', project: 'partial', state: 'active', startedAt: now, lastActivityAt: now, agentIds: [], main: { state: 'working', since: now, lastPrompt: 'x' } },
      ],
    }))
    const office = await loadOffice({ dir })
    offices.push(office)
    expect(office.server.sessions.get('older').main).toEqual({ state: 'idle', since: expect.any(Number), waitingOn: 0 })
    expect(office.server.sessions.get('junk').main).toEqual({ state: 'idle', since: expect.any(Number), waitingOn: 0 })
    expect(office.server.sessions.get('partial').main).toEqual({ state: 'working', since: now, lastPrompt: 'x', waitingOn: 0 })
  })
})

describe('POST /event body limit', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('takes a session event well over 10 KB (2000 non-ASCII characters escape to six bytes each) and still refuses one over 64 KB; everything else keeps 10 KB', async () => {
    await postAuthed(office.server, '/settings', { logPrompts: 'full' })
    const text = '☃'.repeat(2000)
    const body = {
      type: 'session_turn_end', ...ALPHA, promptId: 'p-1', text,
      backgroundTasks: Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, type: 'subagent', status: 'running', description: '☃'.repeat(120) })),
      crons: 0,
    }
    // As the hook's Python sends it (json.dumps escapes non-ASCII to \uXXXX): ~20 KB on the wire
    const raw = JSON.stringify(body).replace(/☃/g, '\\u2603')
    expect(Buffer.byteLength(raw)).toBeGreaterThan(10 * 1024)
    const res = await request(office.server.app).post('/event')
      .set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
      .set('Content-Type', 'application/json')
      .send(raw)
    expect(res.status).toBe(200)
    expect(main(office, ALPHA.sessionId)).toMatchObject({ state: 'waiting', waitingOn: 10, lastReply: text })

    const huge = await postEvent(office.server, { type: 'session_prompt', ...ALPHA, promptId: 'p-2', text: 'x'.repeat(70 * 1024) })
    expect(huge.status).toBe(413)
    expect(huge.body).toEqual({ error: 'Request body too large' })

    const chat = await request(office.server.app).post('/chat').send({ sender: 'x', text: 'y'.repeat(20_000) })
    expect(chat.status).toBe(413)
    const settings = await postAuthed(office.server, '/settings', { logPrompts: 'summary', pad: 'z'.repeat(20_000) })
    expect(settings.status).toBe(413)
  })
})
