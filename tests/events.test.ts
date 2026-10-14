/**
 * POST /event + processEvent: the hook -> office pipeline.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { loadOffice, postEvent, removeOffice, spawnAgent, type Office } from './helpers'

describe('POST /event validation', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('returns 401 without a bearer token and does not process the event', async () => {
    const res = await request(office.server.app)
      .post('/event')
      .send({ type: 'agent_spawned', agent: { id: 'agent-unauth' } })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(office.server.activeAgents.has('agent-unauth')).toBe(false)
  })

  it('returns 401 for a wrong token', async () => {
    const res = await postEvent(office.server, { type: 'agent_spawned', agent: { id: 'agent-unauth' } }, 'not-the-token')
    expect(res.status).toBe(401)
    expect(office.server.activeAgents.has('agent-unauth')).toBe(false)
  })

  it('returns 400 for an unknown event type', async () => {
    const res = await postEvent(office.server, { type: 'agent_danced' })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Unknown event type: agent_danced' })
  })

  it('returns 400 when the type is missing', async () => {
    const res = await postEvent(office.server, { agent: { id: 'agent-typeless' } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Missing event type' })
  })

  it('clamps agent strings to 200 characters before they reach the office', async () => {
    const long = 'x'.repeat(500)
    const res = await postEvent(office.server, {
      type: 'agent_spawned',
      agent: { id: 'agent-clamp', name: long, role: 'debugger', task: long },
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const agent = office.server.activeAgents.get('agent-clamp')
    expect(agent.name).toHaveLength(200)
    expect(agent.task).toHaveLength(200)
  })
})

describe('agent_spawned', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('creates a new-hire record, lists it in /agents and announces the task in chat', async () => {
    const res = await postEvent(office.server, {
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
    expect(res.status).toBe(200)

    const agent = office.server.activeAgents.get('agent-toolu_01X')
    expect(agent).toMatchObject({
      id: 'agent-toolu_01X',
      name: 'Tester',
      role: 'test-engineer',
      task: 'Write tests for parser',
      agentType: 'general-purpose',
      background: true,
      state: 'new-hire',
    })
    expect(agent.spawnedAt).toBeTypeOf('number')
    expect(agent.lastActivityAt).toBe(agent.spawnedAt)

    const agents = await request(office.server.app).get('/agents')
    expect(agents.status).toBe(200)
    expect(agents.body.agents).toEqual([
      expect.objectContaining({ id: 'agent-toolu_01X', name: 'Tester', state: 'new-hire', unread: 0 }),
    ])

    const chat = await request(office.server.app).get('/chat')
    expect(chat.body.messages).toContainEqual(
      expect.objectContaining({ sender: 'Tester', role: 'test-engineer', text: 'starting: Write tests for parser' }),
    )
  })

  it('keeps the existing record when a spawn is replayed', async () => {
    const before = office.server.activeAgents.get('agent-toolu_01X')
    const ev = spawnAgent(office.server, { id: 'agent-toolu_01X', name: 'Impostor', role: 'debugger' })
    expect(ev.agent).toBe(before)
    expect(office.server.activeAgents.get('agent-toolu_01X').name).toBe('Tester')

    const chat = await request(office.server.app).get('/chat')
    const starts = chat.body.messages.filter((m: any) => m.text.startsWith('starting:'))
    expect(starts).toHaveLength(1)
  })

  it('spreads general-purpose agents across the least-used sprite roles', () => {
    // The pool is general-purpose, code-reviewer, test-engineer, debugger, ...
    // A test-engineer (Tester, above) is already in the office, so the third
    // general-purpose hire skips that sprite and lands on debugger.
    const roles = ['agent-gp-1', 'agent-gp-2', 'agent-gp-3'].map(id =>
      spawnAgent(office.server, { id, name: 'Agent', role: 'general-purpose', task: '' }).agent.role,
    )
    expect(roles).toEqual(['general-purpose', 'code-reviewer', 'debugger'])

    // The sprite role is cosmetic — agentType still says what Claude Code ran
    for (const id of ['agent-gp-1', 'agent-gp-2', 'agent-gp-3']) {
      expect(office.server.activeAgents.get(id).agentType).toBe('general-purpose')
    }

    // Explicit roles are never remapped
    const explicit = spawnAgent(office.server, { id: 'agent-sec', name: 'Security', role: 'security-auditor' })
    expect(explicit.agent.role).toBe('security-auditor')
  })
})

describe('agent_linked and agent_working', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnAgent(office.server, {
      id: 'agent-toolu_01X', name: 'Agent', role: 'general-purpose',
      task: 'Write tests for parser', agentType: 'general-purpose', background: true,
    })
  })
  afterAll(() => removeOffice(office))

  it('links a background agent to its subagent id and routes agent_working through it', async () => {
    const linked = await postEvent(office.server, {
      type: 'agent_linked', agentId: 'agent-toolu_01X', subagentId: 'a1921bf97b0af9fd1',
    })
    expect(linked.status).toBe(200)
    expect(office.server.activeAgents.get('agent-toolu_01X').subagentId).toBe('a1921bf97b0af9fd1')

    const working = await postEvent(office.server, {
      type: 'agent_working',
      agentId: 'a1921bf97b0af9fd1',
      agentType: 'general-purpose',
      role: 'general-purpose',
      name: 'Agent',
      status: 'running: ls /etc | wc -l',
    })
    expect(working.status).toBe(200)
    expect(office.server.activeAgents.get('agent-toolu_01X')).toMatchObject({
      state: 'working',
      status: 'running: ls /etc | wc -l',
    })

    // processEvent resolves the subagent id to the office id in the broadcast event
    const ev = office.server.processEvent({ type: 'agent_working', agentId: 'a1921bf97b0af9fd1', status: 'reading x' })
    expect(ev).toMatchObject({ type: 'agent_working', agentId: 'agent-toolu_01X', status: 'reading x' })
  })

  it('binds an unseen subagent id to the oldest unbound agent of the same type (foreground agent)', () => {
    spawnAgent(office.server, {
      id: 'agent-toolu_02Y', name: 'Agent', role: 'general-purpose',
      task: 'What is the date', agentType: 'general-purpose',
    })
    const ev = office.server.processEvent({
      type: 'agent_working', agentId: 'afbfba07a82436af6', agentType: 'general-purpose', status: 'running: date',
    })
    expect(ev.agentId).toBe('agent-toolu_02Y')
    expect(office.server.activeAgents.get('agent-toolu_02Y')).toMatchObject({
      subagentId: 'afbfba07a82436af6', state: 'working', status: 'running: date',
    })
  })

  it('auto-spawns an agent for an unknown subagent id when nothing is unbound', () => {
    const sizeBefore = office.server.activeAgents.size
    const ev = office.server.processEvent({
      type: 'agent_working',
      agentId: 'af4d4090b68ebb5f9',
      agentType: 'general-purpose',
      role: 'debugger',
      name: 'Debugger',
      status: 'running: pytest',
    })
    expect(ev).toMatchObject({ type: 'agent_working', agentId: 'agent-af4d4090b68ebb5f9', status: 'running: pytest' })
    expect(office.server.activeAgents.size).toBe(sizeBefore + 1)
    expect(office.server.activeAgents.get('agent-af4d4090b68ebb5f9')).toMatchObject({
      name: 'Debugger',
      role: 'debugger',
      agentType: 'general-purpose',
      task: 'Picking up where they left off',
      subagentId: 'af4d4090b68ebb5f9',
      state: 'working',
      status: 'running: pytest',
    })
  })

  it('treats an unknown id without agentType (or no id) as main-thread activity', () => {
    const sizeBefore = office.server.activeAgents.size
    const unknown = office.server.processEvent({ type: 'agent_working', agentId: 'nope', status: 'reading foo' })
    expect(unknown).toMatchObject({ type: 'agent_working', status: 'reading foo' })
    expect(unknown.agentId).toBeUndefined()
    const anonymous = office.server.processEvent({ type: 'agent_working', status: 'editing bar' })
    expect(anonymous.agentId).toBeUndefined()
    expect(office.server.activeAgents.size).toBe(sizeBefore)
  })
})

describe('agent_completed', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnAgent(office.server, {
      id: 'agent-toolu_01X', name: 'Agent', role: 'general-purpose',
      task: 'Run the thing', agentType: 'general-purpose', background: true,
    })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-toolu_01X', subagentId: 'a1921bf97b0af9fd1' })
  })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('completes via the subagent id, announces it once, ignores a duplicate, and forgets the agent after the grace period', async () => {
    // Only fake setTimeout so Date.now() and the HTTP stack stay real
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const ev = office.server.processEvent({
      type: 'agent_completed', agentId: 'a1921bf97b0af9fd1', result: 'The Bash command ran and printed hi.',
    })
    expect(ev).toMatchObject({
      type: 'agent_completed', agentId: 'agent-toolu_01X', result: 'The Bash command ran and printed hi.',
    })
    expect(office.server.activeAgents.get('agent-toolu_01X').state).toBe('completed')

    // Duplicate completion (SubagentStop after PostToolUse) is a no-op
    const dup = office.server.processEvent({ type: 'agent_completed', agentId: 'agent-toolu_01X', result: 'again' })
    expect(dup.agentId).toBe('agent-toolu_01X')
    expect(office.server.activeAgents.get('agent-toolu_01X').state).toBe('completed')

    // Grace period: the record stays for 10s so the UI can animate the exit
    vi.advanceTimersByTime(9_999)
    expect(office.server.activeAgents.has('agent-toolu_01X')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(office.server.activeAgents.has('agent-toolu_01X')).toBe(false)
    vi.useRealTimers()

    const chat = await request(office.server.app).get('/chat')
    const done = chat.body.messages.filter((m: any) => m.text.startsWith('done:'))
    expect(done).toEqual([expect.objectContaining({ sender: 'Agent', text: 'done: The Bash command ran and printed hi.' })])

    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents).toEqual([])
  })

  it('passes through a completion for an unknown id without creating anything', async () => {
    const ev = office.server.processEvent({ type: 'agent_completed', agentId: 'ghost', result: 'done' })
    expect(ev).toMatchObject({ type: 'agent_completed', agentId: 'ghost', result: 'done' })
    expect(office.server.activeAgents.has('ghost')).toBe(false)
  })
})

describe('mcp_call and mcp_done', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('tracks an MCP call as a transient worker and clears it on mcp_done', async () => {
    const call = await postEvent(office.server, { type: 'mcp_call', server: 'github', tool: 'get_me' })
    expect(call.status).toBe(200)

    const records = Array.from(office.server.activeAgents.values()).filter((a: any) => a.server === 'github')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ name: 'github', role: 'github', server: 'github', tool: 'get_me', state: 'working' })
    expect(records[0].id).toMatch(/^mcp-github-\d+$/)

    // Transient: visible in the roster/snapshot but not in the agent directory
    const roster = await request(office.server.app).get('/roster')
    expect(roster.body.activeAgents.map((a: any) => a.id)).toContain(records[0].id)
    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents).toEqual([])

    const done = await postEvent(office.server, { type: 'mcp_done', server: 'github' })
    expect(done.status).toBe(200)
    expect(office.server.activeAgents.has(records[0].id)).toBe(false)
  })

  it('returns the normalised events from processEvent', () => {
    const call = office.server.processEvent({ type: 'mcp_call', server: 'supabase', tool: 'execute_sql' })
    expect(call).toMatchObject({ type: 'mcp_call', server: 'supabase', tool: 'execute_sql' })
    expect(call.agentId).toMatch(/^mcp-supabase-\d+$/)
    const done = office.server.processEvent({ type: 'mcp_done', server: 'supabase' })
    expect(done).toMatchObject({ type: 'mcp_done', server: 'supabase' })
    expect(office.server.activeAgents.has(call.agentId)).toBe(false)
  })
})
