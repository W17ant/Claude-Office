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

describe('agent_started (SubagentStart)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => {
    vi.useRealTimers()
    removeOffice(office)
  })

  it('links two same-type agents to their subagents in spawn order, so later working events land on the right one', async () => {
    spawnAgent(office.server, {
      id: 'agent-toolu_A', name: 'Agent', role: 'general-purpose', task: 'Count etc', agentType: 'general-purpose', background: true,
    })
    spawnAgent(office.server, {
      id: 'agent-toolu_B', name: 'Agent', role: 'general-purpose', task: 'Fail on purpose', agentType: 'general-purpose', background: true,
    })

    const first = await postEvent(office.server, { type: 'agent_started', subagentId: 'ac5ff55b850b4fecf', agentType: 'general-purpose' })
    expect(first.status).toBe(200)
    // Nothing is broadcast for a start — it only wires state up
    expect(office.server.processEvent({ type: 'agent_started', subagentId: 'a29964dc791f62039', agentType: 'general-purpose' })).toBeNull()

    expect(office.server.activeAgents.get('agent-toolu_A').subagentId).toBe('ac5ff55b850b4fecf')
    expect(office.server.activeAgents.get('agent-toolu_B').subagentId).toBe('a29964dc791f62039')
    expect(office.server.pendingStarts.size).toBe(0)

    // Tool calls inside each subagent reach their own agent, whichever order they come in
    const evB = office.server.processEvent({
      type: 'agent_working', agentId: 'a29964dc791f62039', agentType: 'general-purpose', status: 'running: cat /definitely/not/here',
    })
    expect(evB.agentId).toBe('agent-toolu_B')
    const evA = office.server.processEvent({
      type: 'agent_working', agentId: 'ac5ff55b850b4fecf', agentType: 'general-purpose', status: 'running: ls /etc | wc -l',
    })
    expect(evA.agentId).toBe('agent-toolu_A')
    expect(office.server.activeAgents.get('agent-toolu_A')).toMatchObject({ state: 'working', status: 'running: ls /etc | wc -l' })
    expect(office.server.activeAgents.get('agent-toolu_B')).toMatchObject({ state: 'working', status: 'running: cat /definitely/not/here' })

    // ...and so does the completion
    office.server.processEvent({ type: 'agent_completed', agentId: 'a29964dc791f62039', result: 'cat failed' })
    expect(office.server.activeAgents.get('agent-toolu_B').state).toBe('completed')
    expect(office.server.activeAgents.get('agent-toolu_A').state).toBe('working')
  })

  it('never binds across agent types: a start of another type is parked until that type is spawned', () => {
    spawnAgent(office.server, { id: 'agent-toolu_C', name: 'Agent', role: 'general-purpose', task: 'gp', agentType: 'general-purpose' })
    expect(office.server.processEvent({ type: 'agent_started', subagentId: 'a027f376ae8cdcbd0', agentType: 'Explore' })).toBeNull()
    expect(office.server.activeAgents.get('agent-toolu_C').subagentId).toBeUndefined()
    expect(office.server.pendingStarts.get('a027f376ae8cdcbd0')).toMatchObject({ agentType: 'Explore' })

    spawnAgent(office.server, { id: 'agent-toolu_D', name: 'Explorer', role: 'Explore', task: 'Find hostname', agentType: 'Explore' })
    expect(office.server.activeAgents.get('agent-toolu_D').subagentId).toBe('a027f376ae8cdcbd0')
    expect(office.server.pendingStarts.has('a027f376ae8cdcbd0')).toBe(false)
    expect(office.server.activeAgents.get('agent-toolu_C').subagentId).toBeUndefined()
  })

  it('a start that overtakes its spawn is parked, then linked by the spawn — oldest parked start first', async () => {
    // agent-toolu_C is the only unlinked general-purpose agent; use it up first
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-C', agentType: 'general-purpose' })
    expect(office.server.activeAgents.get('agent-toolu_C').subagentId).toBe('sub-C')

    // Two starts arrive with no agent to take them
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-early-1', agentType: 'general-purpose' })
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-early-2', agentType: 'general-purpose' })
    expect([...office.server.pendingStarts.keys()]).toEqual(['sub-early-1', 'sub-early-2'])

    // Working events for a parked start still don't invent agents (15 s window is tiny next to a model turn)
    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents.map((a: any) => a.id)).not.toContain('agent-sub-early-1')

    const spawn1 = await postEvent(office.server, {
      type: 'agent_spawned',
      agent: { id: 'agent-toolu_E', name: 'Agent', role: 'general-purpose', task: 'late 1', agentType: 'general-purpose', background: true },
    })
    expect(spawn1.status).toBe(200)
    expect(office.server.activeAgents.get('agent-toolu_E').subagentId).toBe('sub-early-1')
    expect([...office.server.pendingStarts.keys()]).toEqual(['sub-early-2'])

    spawnAgent(office.server, { id: 'agent-toolu_F', name: 'Agent', role: 'general-purpose', task: 'late 2', agentType: 'general-purpose' })
    expect(office.server.activeAgents.get('agent-toolu_F').subagentId).toBe('sub-early-2')
    expect(office.server.pendingStarts.size).toBe(0)

    // The usual path afterwards: the subagent's tool calls find the right agent
    const ev = office.server.processEvent({ type: 'agent_working', agentId: 'sub-early-2', agentType: 'general-purpose', status: 'reading x' })
    expect(ev.agentId).toBe('agent-toolu_F')
  })

  it('is a no-op when agent_linked already bound the subagent (PostToolUse won the race)', () => {
    spawnAgent(office.server, { id: 'agent-toolu_G', name: 'Agent', role: 'general-purpose', task: 'g', agentType: 'general-purpose', background: true })
    spawnAgent(office.server, { id: 'agent-toolu_H', name: 'Agent', role: 'general-purpose', task: 'h', agentType: 'general-purpose', background: true })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-toolu_H', subagentId: 'sub-H' })

    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-H', agentType: 'general-purpose' })
    expect(office.server.activeAgents.get('agent-toolu_H').subagentId).toBe('sub-H')
    // The older, still-unlinked G was not touched
    expect(office.server.activeAgents.get('agent-toolu_G').subagentId).toBeUndefined()
    expect(office.server.pendingStarts.size).toBe(0)

    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-G', agentType: 'general-purpose' })
    expect(office.server.activeAgents.get('agent-toolu_G').subagentId).toBe('sub-G')
  })

  it('drops a parked start after 15 s', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-stale', agentType: 'Explore' })
    expect(office.server.pendingStarts.has('sub-stale')).toBe(true)

    vi.setSystemTime(Date.now() + 14_000)
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-fresh', agentType: 'Explore' })
    expect(office.server.pendingStarts.has('sub-stale')).toBe(true)

    vi.setSystemTime(Date.now() + 1_001)
    spawnAgent(office.server, { id: 'agent-toolu_I', name: 'Explorer', role: 'Explore', task: 'i', agentType: 'Explore' })
    // The stale one expired; the spawn took the fresh one
    expect(office.server.pendingStarts.has('sub-stale')).toBe(false)
    expect(office.server.activeAgents.get('agent-toolu_I').subagentId).toBe('sub-fresh')
    vi.useRealTimers()
  })

  it('ignores a start without a subagentId', async () => {
    const res = await postEvent(office.server, { type: 'agent_started', agentType: 'general-purpose' })
    expect(res.status).toBe(200)
    expect(office.server.pendingStarts.size).toBe(0)
  })
})

describe('failed tool calls (agent_working with failed: true)', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    spawnAgent(office.server, {
      id: 'agent-toolu_01X', name: 'Agent', role: 'general-purpose', task: 'Fail on purpose', agentType: 'general-purpose', background: true,
    })
    office.server.processEvent({ type: 'agent_started', subagentId: 'a29964dc791f62039', agentType: 'general-purpose' })
  })
  afterAll(() => removeOffice(office))

  it('keeps the agent working, records lastError, and flags the broadcast event', async () => {
    const status = 'failed: Bash — Exit code 1 cat: /definitely/not/here: No such file or direc'
    const res = await postEvent(office.server, {
      type: 'agent_working', agentId: 'a29964dc791f62039', agentType: 'general-purpose', role: 'general-purpose', name: 'Agent',
      status, failed: true,
    })
    expect(res.status).toBe(200)

    const agent = office.server.activeAgents.get('agent-toolu_01X')
    expect(agent).toMatchObject({ state: 'working', status, lastError: status })

    const ev = office.server.processEvent({ type: 'agent_working', agentId: 'a29964dc791f62039', status: 'failed: Bash — Exit code 1', failed: true })
    expect(ev).toEqual({ type: 'agent_working', agentId: 'agent-toolu_01X', status: 'failed: Bash — Exit code 1', failed: true, timestamp: expect.any(Number) })
    expect(agent.lastError).toBe('failed: Bash — Exit code 1')

    // A later successful call moves status on but keeps the last error
    const ok = office.server.processEvent({ type: 'agent_working', agentId: 'a29964dc791f62039', status: 'running: echo done' })
    expect(ok).not.toHaveProperty('failed')
    expect(agent).toMatchObject({ state: 'working', status: 'running: echo done', lastError: 'failed: Bash — Exit code 1' })

    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents).toEqual([
      expect.objectContaining({ id: 'agent-toolu_01X', state: 'working', status: 'running: echo done', lastError: 'failed: Bash — Exit code 1' }),
    ])
  })

  it('a main-thread failure passes through without an agent id and only when failed is exactly true', async () => {
    const ev = office.server.processEvent({ type: 'agent_working', status: 'failed: Bash — Exit code 1', failed: true })
    expect(ev).toEqual({ type: 'agent_working', agentId: undefined, status: 'failed: Bash — Exit code 1', failed: true, timestamp: expect.any(Number) })

    await postEvent(office.server, { type: 'agent_working', agentId: 'a29964dc791f62039', status: 'reading y', failed: 'yes' })
    expect(office.server.activeAgents.get('agent-toolu_01X')).toMatchObject({ status: 'reading y', lastError: 'failed: Bash — Exit code 1' })
  })
})

describe('lineage (nested spawns)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('resolves parentSubagentId to the parent office id and lists both in /agents', async () => {
    spawnAgent(office.server, { id: 'agent-parent', name: 'Agent', role: 'general-purpose', task: 'orchestrate', agentType: 'general-purpose' })
    office.server.processEvent({ type: 'agent_started', subagentId: 'a29964dc791f62039', agentType: 'general-purpose' })

    // The Agent call made inside a29964dc791f62039 carries its agent_id -> parentSubagentId
    const res = await postEvent(office.server, {
      type: 'agent_spawned',
      agent: { id: 'agent-child', name: 'Explorer', role: 'Explore', task: 'Find hostname', agentType: 'Explore', parentSubagentId: 'a29964dc791f62039' },
    })
    expect(res.status).toBe(200)
    expect(office.server.activeAgents.get('agent-child')).toMatchObject({ parentSubagentId: 'a29964dc791f62039', parentId: 'agent-parent' })

    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents).toEqual([
      expect.objectContaining({ id: 'agent-parent' }),
      expect.objectContaining({ id: 'agent-child', parentId: 'agent-parent', parentSubagentId: 'a29964dc791f62039' }),
    ])
    expect(agents.body.agents[0]).not.toHaveProperty('parentId')
    expect(agents.body.agents[0]).not.toHaveProperty('parentSubagentId')
  })

  it('resolves the parent lazily in /agents when the parent is only linked later', async () => {
    spawnAgent(office.server, { id: 'agent-orphan', name: 'Agent', role: 'general-purpose', task: 'x', agentType: 'general-purpose', parentSubagentId: 'sub-late-parent' })
    expect(office.server.activeAgents.get('agent-orphan').parentId).toBeUndefined()

    spawnAgent(office.server, { id: 'agent-late-parent', name: 'Agent', role: 'general-purpose', task: 'y', agentType: 'general-purpose' })
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-late-parent', subagentId: 'sub-late-parent' })

    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents).toContainEqual(expect.objectContaining({ id: 'agent-orphan', parentId: 'agent-late-parent', parentSubagentId: 'sub-late-parent' }))
  })

  it('agent_started with a parentId records lineage on the agent it links', () => {
    // (debugger: the only agent of that type in this office, so the start can only land here)
    spawnAgent(office.server, { id: 'agent-nested', name: 'Debugger', role: 'debugger', task: 'z', agentType: 'debugger' })
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-nested', agentType: 'debugger', parentId: 'a29964dc791f62039' })
    expect(office.server.activeAgents.get('agent-nested')).toMatchObject({ subagentId: 'sub-nested', parentSubagentId: 'a29964dc791f62039', parentId: 'agent-parent' })
  })
})
