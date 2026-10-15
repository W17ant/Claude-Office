/**
 * GET /agents/:id — what the inspector card reads: a worker's history (its
 * tool calls in order, failures marked), its counts per tool, its stats and
 * parent, the tail of its own transcript; a session's own Claude under
 * main-<sessionId> (main record, model, crons, prompt text only with the
 * token); 404s; the 50-entry ring buffer; and agents.json staying small
 * however much an agent does.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { loadOffice, postAuthed, postEvent, removeOffice, type Office } from './helpers'

const AT = '2026-10-14T19:05:35.842Z'

/** GET /agents/:id, as the office page (UI token), a token holder, or nobody in particular. */
function inspect(server: Office['server'], id: string, token?: string) {
  const req = request(server.app).get(`/agents/${id}`)
  return token ? req.set('Authorization', `Bearer ${token}`) : req
}

/** A few assistant records in the shape Claude Code writes (see tests/transcript.test.ts). */
function transcriptLines(said: string, tool = 'Bash', input: object = { command: 'ls /etc | wc -l' }): string {
  const rec = (id: string, block: object) => JSON.stringify({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, timestamp: AT, message: { id, role: 'assistant', content: [block] } })
  return [
    JSON.stringify({ type: 'user', timestamp: AT, message: { role: 'user', content: 'do the thing' } }),
    rec('m1', { type: 'thinking', thinking: '' }),
    rec('m1', { type: 'tool_use', id: 'toolu_1', name: tool, input }),
    rec('m2', { type: 'text', text: said }),
  ].join('\n') + '\n'
}

describe('GET /agents/:id for a worker', () => {
  let office: Office
  let sessionTranscript: string
  let workerTranscript: string
  const session = { sessionId: 's-insp', project: 'proj', cwd: '/home/me/proj' }

  beforeAll(async () => {
    office = await loadOffice()
    // The session transcript (its path is all the server needs) and the
    // worker's file where Claude Code would write it, next to it
    sessionTranscript = join(office.dir, 'transcripts', 's-insp.jsonl')
    workerTranscript = join(office.dir, 'transcripts', 's-insp', 'subagents', 'agent-sub-w1.jsonl')
    mkdirSync(join(office.dir, 'transcripts', 's-insp', 'subagents'), { recursive: true })
    writeFileSync(sessionTranscript, transcriptLines('main thread reply'))
    writeFileSync(workerTranscript, transcriptLines('`ls /etc | wc -l` returned 154.'))
  })
  afterAll(() => removeOffice(office))

  it('404 for an id nobody has', async () => {
    const res = await request(office.server.app).get('/agents/agent-nobody')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Unknown agent' })
  })

  it('shows the record, the history in order with the failed call marked, the tool counts, the stats and the parent', async () => {
    const ev = { ...session, transcriptPath: sessionTranscript }
    // A parent, linked to its Claude subagent id, then the worker it spawned
    expect((await postEvent(office.server, { type: 'agent_spawned', ...ev, agent: { id: 'agent-parent', name: 'Reviewer', role: 'code-reviewer', task: 'Review the PR', agentType: 'general-purpose' } })).status).toBe(200)
    await postEvent(office.server, { type: 'agent_linked', ...ev, agentId: 'agent-parent', subagentId: 'sub-p' })
    expect((await postEvent(office.server, { type: 'agent_spawned', ...ev, agent: { id: 'agent-w1', name: 'Tester', role: 'test-engineer', task: 'Write tests for the parser', agentType: 'general-purpose', background: true, parentSubagentId: 'sub-p' } })).status).toBe(200)
    await postEvent(office.server, { type: 'agent_linked', ...ev, agentId: 'agent-w1', subagentId: 'sub-w1' })

    const fresh = (await request(office.server.app).get('/agents/agent-w1')).body
    expect(fresh.history).toEqual([])
    expect(fresh.toolCounts).toEqual({})
    expect(fresh.state).toBe('new-hire')

    // Two tool calls by their subagent id — one with the hook's tool name, one
    // as an older hook sends it (status only) — and the second one failing
    // (its PostToolUseFailure: marked in the history, not counted again)
    await postEvent(office.server, { type: 'agent_working', ...ev, agentId: 'sub-w1', agentType: 'general-purpose', status: 'reading index.js', tool: 'Read' })
    await postEvent(office.server, { type: 'agent_working', ...ev, agentId: 'sub-w1', agentType: 'general-purpose', status: 'running: npm test' })
    await postEvent(office.server, { type: 'agent_working', ...ev, agentId: 'sub-w1', agentType: 'general-purpose', status: 'failed: Bash — Exit code 1 FAIL tests/parser.test.ts', failed: true, tool: 'Bash' })

    const res = await inspect(office.server, 'agent-w1', office.server.UI_TOKEN)
    expect(res.status).toBe(200)
    const body = res.body
    expect(body).toMatchObject({
      id: 'agent-w1', kind: 'worker', name: 'Tester', role: 'test-engineer', task: 'Write tests for the parser', agentType: 'general-purpose',
      background: true, state: 'working', status: 'failed: Bash — Exit code 1 FAIL tests/parser.test.ts', lastError: 'failed: Bash — Exit code 1 FAIL tests/parser.test.ts',
      unread: 0, parentId: 'agent-parent', parentSubagentId: 'sub-p', subagentId: 'sub-w1', sessionId: 's-insp', project: 'proj',
    })
    expect(body.history.map((h: any) => [h.kind, h.tool, h.text])).toEqual([
      ['tool', 'Read', 'reading index.js'],
      ['tool', 'Bash', 'running: npm test'],
      ['failed', 'Bash', 'failed: Bash — Exit code 1 FAIL tests/parser.test.ts'],
    ])
    for (const h of body.history) expect(typeof h.at).toBe('number')
    expect(body.history[0].at).toBeLessThanOrEqual(body.history[2].at)
    expect(body.toolCounts).toEqual({ Read: 1, Bash: 1 })
    expect(body.stats).toEqual({
      spawnedAt: body.spawnedAt, lastActivityAt: body.lastActivityAt,
      parent: { id: 'agent-parent', name: 'Reviewer' }, unread: 0,
    })
    expect(body.stats.completedAt).toBeUndefined()
    expect(body.stats.tokens).toBeUndefined()

    // The transcript tail comes from the file derived from the session transcript + the Claude agent id
    expect(body.transcriptAvailable).toBe(true)
    expect(body.transcript).toEqual([
      { at: Date.parse(AT), kind: 'tool', tool: 'Bash', tools: ['Bash'], input: 'ls /etc | wc -l' },
      { at: Date.parse(AT), kind: 'said', text: '`ls /etc | wc -l` returned 154.' },
    ])
    expect(body.transcriptPath).toBeUndefined()  // the path itself stays on the server

    // Who gets the tail: the office page (UI token, above) and a token holder;
    // nobody else, though the rest of the card — history, counts, stats — is
    // the same for everyone (tool names and status lines, as on GET /agents)
    const fileToken = (await inspect(office.server, 'agent-w1', office.server.AUTH_TOKEN)).body
    expect(fileToken.transcript).toEqual(body.transcript)
    for (const token of [undefined, 'not-the-token']) {
      const res = await inspect(office.server, 'agent-w1', token)
      expect(res.status).toBe(200)  // the route stays open: a wrong token is no token, not a 401
      expect(res.body.transcriptAvailable).toBe(false)
      expect(res.body.transcriptReason).toBe('needs the office token')
      expect(res.body.transcript).toBeUndefined()
      expect(res.body.history).toEqual(body.history)
      expect(res.body.toolCounts).toEqual(body.toolCounts)
      expect(res.body.stats).toEqual(body.stats)
      expect(res.body.task).toBe(body.task)
    }

    // The same card by the Claude subagent id
    expect((await request(office.server.app).get('/agents/sub-w1')).body.id).toBe('agent-w1')
    // The parent: spawning the worker was its Agent call; its own file does not exist
    const parent = (await inspect(office.server, 'agent-parent', office.server.UI_TOKEN)).body
    expect(parent.toolCounts).toEqual({ Agent: 1 })
    expect(parent.history).toEqual([expect.objectContaining({ kind: 'tool', tool: 'Agent', text: 'spawned Tester: Write tests for the parser' })])
    // ...and spawning the parent was the session Claude's
    expect((await request(office.server.app).get('/agents/main-s-insp')).body.toolCounts).toEqual({ Agent: 1 })
    expect(parent.stats.parent).toBeNull()
    expect(parent.transcriptAvailable).toBe(false)
    expect(parent.transcriptReason).toBe('transcript file not found')
  })

  it('a directed message the agent sends is in its history, and the recipient\'s unread count is in its stats', async () => {
    const sent = await postAuthed(office.server, '/chat/reply', { sender: 'Tester', role: 'test-engineer', text: 'tests are green, over to you', recipient: 'Reviewer' })
    expect(sent.status).toBe(200)
    const worker = (await request(office.server.app).get('/agents/agent-w1')).body
    expect(worker.history.at(-1)).toMatchObject({ kind: 'message', text: 'to Reviewer: tests are green, over to you' })
    expect(worker.toolCounts).toEqual({ Read: 1, Bash: 1 })  // a message is not a tool
    const parent = (await request(office.server.app).get('/agents/agent-parent')).body
    expect(parent.stats.unread).toBe(1)
    expect(parent.unread).toBe(1)
  })

  it('a completed agent carries its completion line, tokens, duration, tool uses and model, and still answers in its grace window', async () => {
    const res = await postEvent(office.server, {
      type: 'agent_completed', ...session, agentId: 'sub-w1', result: 'All 12 tests pass',
      tokens: 4200, durationMs: 61_000, toolUses: 3, model: 'claude-haiku-5-5',
      agentTranscriptPath: workerTranscript,
    })
    expect(res.status).toBe(200)
    const body = (await inspect(office.server, 'agent-w1', office.server.UI_TOKEN)).body
    expect(body.state).toBe('completed')
    expect(body.history.at(-1)).toMatchObject({ kind: 'completed', text: 'All 12 tests pass' })
    expect(body.stats).toMatchObject({ tokens: 4200, durationMs: 61_000, toolUses: 3, model: 'claude-haiku-5-5', parent: { id: 'agent-parent', name: 'Reviewer' } })
    expect(typeof body.stats.completedAt).toBe('number')
    expect(body.stats.completedAt).toBeGreaterThanOrEqual(body.stats.spawnedAt)
    expect(body.transcriptAvailable).toBe(true)
    expect(body.transcript).toHaveLength(2)
    expect(body.stats.derived).toBeUndefined()  // Claude Code reported every total
  })

  it('a background worker (SubagentStop carries no totals) gets tokens and model from its transcript, duration and tool uses from the office, all listed as derived', async () => {
    const ev = { ...session, transcriptPath: sessionTranscript }
    // The last message's usage, as captured from a 2.1.300 foreground agent whose totalTokens was 20676
    const usage = { input_tokens: 2, cache_creation_input_tokens: 1497, cache_read_input_tokens: 19054, output_tokens: 123 }
    const rec = (id: string, block: object) => JSON.stringify({ type: 'assistant', timestamp: AT, message: { id, model: 'claude-haiku-5-5', role: 'assistant', content: [block], usage } })
    writeFileSync(join(office.dir, 'transcripts', 's-insp', 'subagents', 'agent-sub-bg.jsonl'), [
      rec('m1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /etc' } }),
      rec('m2', { type: 'text', text: '154 entries' }),
    ].join('\n') + '\n')
    await postEvent(office.server, { type: 'agent_spawned', ...ev, agent: { id: 'agent-bg', name: 'Agent', role: 'general-purpose', task: 'Count etc', background: true } })
    await postEvent(office.server, { type: 'agent_linked', ...ev, agentId: 'agent-bg', subagentId: 'sub-bg' })

    // Working: tokens and model so far, nothing finished-only yet
    await postEvent(office.server, { type: 'agent_working', ...ev, agentId: 'sub-bg', agentType: 'general-purpose', status: 'running: ls /etc', tool: 'Bash' })
    const working = (await request(office.server.app).get('/agents/agent-bg')).body
    expect(working.stats).toMatchObject({ tokens: 20676, model: 'claude-haiku-5-5', derived: ['tokens', 'model'] })
    expect(working.stats.durationMs).toBeUndefined()
    expect(working.stats.toolUses).toBeUndefined()

    // SubagentStop: a result line and the transcript path, no totals
    await postEvent(office.server, { type: 'agent_completed', ...ev, agentId: 'sub-bg', result: '154 entries' })
    const done = (await request(office.server.app).get('/agents/agent-bg')).body
    expect(done.stats).toMatchObject({ tokens: 20676, model: 'claude-haiku-5-5', toolUses: 1, derived: ['tokens', 'durationMs', 'toolUses', 'model'] })
    expect(done.stats.durationMs).toBe(done.stats.completedAt - done.stats.spawnedAt)

    // The numbers are not conversation: no token needed (the GETs above sent
    // none), and logPrompts off hides the tail even from the office page
    await postAuthed(office.server, '/settings', { logPrompts: 'off' })
    const off = (await inspect(office.server, 'agent-bg', office.server.UI_TOKEN)).body
    expect(off.transcriptAvailable).toBe(false)
    expect(off.transcriptReason).toBe('prompts off')
    expect(off.transcript).toBeUndefined()
    expect(off.stats.tokens).toBe(20676)
    await postAuthed(office.server, '/settings', { logPrompts: 'summary' })
  })

  it('an agentTranscriptPath that is not a transcript path is dropped, an MCP record is not an agent', async () => {
    await postEvent(office.server, { type: 'agent_spawned', ...session, agent: { id: 'agent-w2', name: 'Agent', role: 'general-purpose' } })
    await postEvent(office.server, { type: 'agent_completed', ...session, agentId: 'agent-w2', result: 'done', agentTranscriptPath: '/etc/passwd' })
    expect(office.server.activeAgents.get('agent-w2').transcriptPath).toBeUndefined()
    const w2 = (await inspect(office.server, 'agent-w2', office.server.UI_TOKEN)).body
    expect(w2.transcriptAvailable).toBe(false)
    expect(w2.transcriptReason).toBe('no transcript path yet')  // never linked to a subagent

    await postEvent(office.server, { type: 'mcp_call', ...session, server: 'github', tool: 'list_prs' })
    const mcpId = Array.from(office.server.activeAgents.keys()).find(id => id.startsWith('mcp-github-'))!
    expect((await request(office.server.app).get(`/agents/${mcpId}`)).status).toBe(404)
  })
})

describe('the history is a ring buffer of 50 and agents.json stays small', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('keeps the last 50 of 60 tool calls, counts all 60, and persists none of them', async () => {
    await postEvent(office.server, { type: 'agent_spawned', sessionId: 's-ring', project: 'proj', agent: { id: 'agent-ring', name: 'Agent', role: 'debugger' } })
    for (let i = 0; i < 60; i++) {
      await postEvent(office.server, { type: 'agent_working', sessionId: 's-ring', agentId: 'agent-ring', status: `reading file-${i}.ts`, tool: 'Read' })
    }
    const body = (await request(office.server.app).get('/agents/agent-ring')).body
    expect(body.history).toHaveLength(50)
    expect(body.history[0].text).toBe('reading file-10.ts')
    expect(body.history.at(-1).text).toBe('reading file-59.ts')
    expect(body.toolCounts).toEqual({ Read: 60 })

    const file = join(office.dir, 'agents.json')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.agents).toHaveLength(1)
    expect(saved.agents[0].history).toBeUndefined()
    expect(saved.agents[0].toolCounts).toBeUndefined()
    expect(statSync(file).size).toBeLessThan(2048)
  })

  it('a subagent the office never saw spawned gets a stand-in; that is not an Agent call of the session\'s Claude', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 's-rec', project: 'proj', cwd: '/p', source: 'startup' })
    await postEvent(office.server, { type: 'agent_working', sessionId: 's-rec', agentId: 'sub-unseen', agentType: 'general-purpose', status: 'reading a.ts', tool: 'Read' })
    const standIn = (await request(office.server.app).get('/agents/sub-unseen')).body
    expect(standIn.id).toBe('agent-sub-unseen')
    expect(standIn.toolCounts).toEqual({ Read: 1 })
    expect((await request(office.server.app).get('/agents/main-s-rec')).body.toolCounts).toEqual({})
  })

  it('after a server restart the agent is back (restored) with an empty history: activity is never written to disk', async () => {
    await postEvent(office.server, { type: 'agent_spawned', sessionId: 's-restart', project: 'proj', agent: { id: 'agent-restart', name: 'Agent', role: 'debugger' } })
    await postEvent(office.server, { type: 'agent_working', sessionId: 's-restart', agentId: 'agent-restart', status: 'reading a.ts', tool: 'Read' })
    expect((await request(office.server.app).get('/agents/agent-restart')).body).toMatchObject({ restored: false, toolCounts: { Read: 1 } })

    const again = await loadOffice({ dir: office.dir })
    const back = (await request(again.server.app).get('/agents/agent-restart')).body
    expect(back).toMatchObject({ id: 'agent-restart', restored: true, history: [], toolCounts: {} })
  })

  it('a long status line is clamped to 160 characters in the history', async () => {
    await postEvent(office.server, { type: 'agent_working', sessionId: 's-ring', agentId: 'agent-ring', status: 'x'.repeat(200) })
    const body = (await request(office.server.app).get('/agents/agent-ring')).body
    expect(body.history.at(-1).text).toHaveLength(160)
    expect(body.history.at(-1).tool).toBeUndefined()  // no tool name in that phrasing
  })

  it('the agent still answers in its 10 s grace window; when the server forgets it, its activity goes too', async () => {
    expect(office.server.activity.has('agent-ring')).toBe(true)
    vi.useFakeTimers()
    try {
      office.server.processEvent({ type: 'agent_completed', sessionId: 's-ring', agentId: 'agent-ring', result: 'done' })
      vi.advanceTimersByTime(9_000)
      expect(office.server.activity.has('agent-ring')).toBe(true)
      vi.advanceTimersByTime(1_000)  // the grace timer runs forgetAgent
    } finally {
      vi.useRealTimers()
    }
    expect(office.server.activeAgents.has('agent-ring')).toBe(false)
    expect(office.server.activity.has('agent-ring')).toBe(false)
    expect((await request(office.server.app).get('/agents/agent-ring')).status).toBe(404)
  })
})

describe('GET /agents/main-<sessionId> — the session\'s own Claude', () => {
  let office: Office
  let sessionTranscript: string
  const sid = 's-main'

  beforeAll(async () => {
    office = await loadOffice()
    sessionTranscript = join(office.dir, 'transcripts', `${sid}.jsonl`)
    mkdirSync(join(office.dir, 'transcripts'), { recursive: true })
    writeFileSync(sessionTranscript, transcriptLines('Done, the parser is fixed.', 'Read', { file_path: '/home/me/proj/parser.ts' }))
  })
  afterAll(() => removeOffice(office))

  const ev = (extra: object) => ({ sessionId: sid, project: 'proj', cwd: '/home/me/proj', transcriptPath: '', ...extra })

  it('404 for a session nobody has', async () => {
    expect((await request(office.server.app).get('/agents/main-nope')).status).toBe(404)
  })

  it('answers with the main record, model, crons, its tool counts (main-thread and MCP calls) and its status lines; prompt text only with the token', async () => {
    await postEvent(office.server, { type: 'session_started', ...ev({ transcriptPath: sessionTranscript }), source: 'startup', model: 'claude-haiku-5-5' })
    await postEvent(office.server, { type: 'session_prompt', ...ev({ transcriptPath: sessionTranscript }), text: 'Fix the parser please', promptId: 'p1' })
    await postEvent(office.server, { type: 'agent_working', ...ev({ transcriptPath: sessionTranscript }), status: 'reading parser.ts', tool: 'Read' })
    await postEvent(office.server, { type: 'agent_working', ...ev({ transcriptPath: sessionTranscript }), status: 'editing parser.ts' })
    await postEvent(office.server, { type: 'mcp_call', ...ev({ transcriptPath: sessionTranscript }), server: 'github', tool: 'list_prs' })
    await postEvent(office.server, { type: 'session_turn_end', ...ev({ transcriptPath: sessionTranscript }), text: 'Done, the parser is fixed.', promptId: 'p1', backgroundTasks: [{ id: 'bg1', type: 'subagent', status: 'running', description: 'Count etc' }], crons: 2 })

    const open = await request(office.server.app).get(`/agents/main-${sid}`)
    expect(open.status).toBe(200)
    const body = open.body
    expect(body).toMatchObject({
      id: `main-${sid}`, kind: 'main', name: 'Claude', role: 'assistant', state: 'waiting', status: 'editing parser.ts',
      sessionId: sid, project: 'proj', cwd: '/home/me/proj', model: 'claude-haiku-5-5', crons: 2,
      main: { state: 'waiting', waitingOn: 1, crons: 2, promptId: 'p1' },
      session: { id: sid, project: 'proj', source: 'startup', state: 'active', agentCount: 0, workingCount: 0 },
      stats: { model: 'claude-haiku-5-5', parent: null, unread: 0 },
    })
    expect(typeof body.stats.spawnedAt).toBe('number')
    expect(typeof body.stats.since).toBe('number')
    // No token: the prompt and reply text stay out, as on GET /sessions
    expect(body.main.lastPrompt).toBeUndefined()
    expect(body.main.lastReply).toBeUndefined()
    expect(typeof body.main.lastPromptAt).toBe('number')

    expect(body.toolCounts).toEqual({ Read: 1, Edit: 1, mcp__github__list_prs: 1 })
    expect(body.history.map((h: any) => [h.kind, h.tool ?? null, h.text])).toEqual([
      ['status', null, 'working — prompt'],
      ['tool', 'Read', 'reading parser.ts'],
      ['tool', 'Edit', 'editing parser.ts'],
      ['tool', 'mcp__github__list_prs', 'github / list_prs'],
      ['status', null, 'waiting — turn ended, 1 background task(s) still running'],
    ])

    // No token: no transcript either, and the card is told why
    expect(body.transcriptAvailable).toBe(false)
    expect(body.transcriptReason).toBe('needs the office token')
    expect(body.transcript).toBeUndefined()

    // The office page (UI token) and a token holder get the prompt, the reply
    // and the session transcript — Claude's own
    for (const token of [office.server.UI_TOKEN, office.server.AUTH_TOKEN]) {
      const withText = (await inspect(office.server, `main-${sid}`, token)).body
      expect(withText.main.lastPrompt).toBe('Fix the parser please')
      expect(withText.main.lastReply).toBe('Done, the parser is fixed.')
      expect(withText.transcriptAvailable).toBe(true)
      expect(withText.transcript).toEqual([
        { at: Date.parse(AT), kind: 'tool', tool: 'Read', tools: ['Read'], input: '/home/me/proj/parser.ts' },
        { at: Date.parse(AT), kind: 'said', text: 'Done, the parser is fixed.' },
      ])
      // ...the rest of the card is the same with or without
      expect(withText.history).toEqual(body.history)
      expect(withText.toolCounts).toEqual(body.toolCounts)
    }

    // A wrong token is no token: still 200, still no text
    const wrong = await inspect(office.server, `main-${sid}`, 'not-the-token')
    expect(wrong.status).toBe(200)
    expect(wrong.body.main.lastPrompt).toBeUndefined()
    expect(wrong.body.transcriptReason).toBe('needs the office token')
  })

  it('logPrompts off hides the transcript tail and stores no new prompt text; summary brings the tail back at 200 characters', async () => {
    expect((await postAuthed(office.server, '/settings', { logPrompts: 'off' })).status).toBe(200)
    await postEvent(office.server, { type: 'session_prompt', ...ev({}), text: 'Another prompt', promptId: 'p2' })
    // Off wins over any token: no tail, no text
    for (const token of [office.server.AUTH_TOKEN, office.server.UI_TOKEN]) {
      const off = await inspect(office.server, `main-${sid}`, token)
      expect(off.body.transcriptAvailable).toBe(false)
      expect(off.body.transcriptReason).toBe('prompts off')
      expect(off.body.transcript).toBeUndefined()
      expect(off.body.main.lastPrompt).toBe('')
      expect(off.body.state).toBe('working')
    }

    // A long reply in the file: summary clamps each entry to 200 characters, full to 2000
    writeFileSync(sessionTranscript, transcriptLines('r'.repeat(600)))
    expect((await postAuthed(office.server, '/settings', { logPrompts: 'summary' })).status).toBe(200)
    const summary = (await inspect(office.server, `main-${sid}`, office.server.UI_TOKEN)).body
    expect(summary.transcriptAvailable).toBe(true)
    expect(summary.transcript.at(-1).text).toHaveLength(200)
    expect((await postAuthed(office.server, '/settings', { logPrompts: 'full' })).status).toBe(200)
    expect((await inspect(office.server, `main-${sid}`, office.server.UI_TOKEN)).body.transcript.at(-1).text).toHaveLength(600)
    // Even at full, nothing without a token
    expect((await inspect(office.server, `main-${sid}`)).body.transcript).toBeUndefined()
    await postAuthed(office.server, '/settings', { logPrompts: 'summary' })
  })

  it('a session whose transcript file is gone says so; a session without a path says so', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 's-gone', project: 'p', cwd: '/p', transcriptPath: join(office.dir, 'nowhere.jsonl'), source: 'startup' })
    expect((await inspect(office.server, 'main-s-gone', office.server.UI_TOKEN)).body).toMatchObject({ transcriptAvailable: false, transcriptReason: 'transcript file not found' })
    await postEvent(office.server, { type: 'session_started', sessionId: 's-bare', project: 'p', cwd: '/p', source: 'startup' })
    expect((await inspect(office.server, 'main-s-bare', office.server.UI_TOKEN)).body).toMatchObject({ transcriptAvailable: false, transcriptReason: 'no transcript path yet' })
  })

  it('a forgotten session takes its activity with it', async () => {
    expect(office.server.activity.has(`main-${sid}`)).toBe(true)
    await postEvent(office.server, { type: 'session_ended', sessionId: sid, reason: 'other' })
    // Ended sessions stay listed a minute; the card still answers with the reset main record
    const ended = (await request(office.server.app).get(`/agents/main-${sid}`)).body
    expect(ended.state).toBe('idle')
    expect(ended.session.state).toBe('ended')
  })
})
