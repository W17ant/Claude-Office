/**
 * Guess binding (C23): a SubagentStart, or a subagent's first tool call when
 * no start reached the server, names only an agent type, so it is tied to the
 * earliest unbound agent of that type spawned shortly before it. A launch
 * whose start never came, or an agent restored from agents.json, must not
 * capture the next subagent of its type; explicit ids are not guesses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOffice, removeOffice, spawnAgent, type Office } from './helpers'

const FRESH = { sessionId: 'cccccccc-3333-4333-8333-333333333333', project: 'fresh', cwd: '/home/me/fresh' }
const MINUTE = 60_000

function gp(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: 'Agent', role: 'general-purpose', task: id, agentType: 'general-purpose', ...extra }
}

describe('guess binding', () => {
  const offices: Office[] = []
  async function office(dir?: string) {
    const o = await loadOffice(dir ? { dir } : {})
    offices.push(o)
    return o
  }
  afterEach(() => {
    vi.useRealTimers()
    while (offices.length) removeOffice(offices.pop())
  })

  it('skips an agent restored from agents.json, on a start and on a first tool call, even one spawned seconds before the restart', async () => {
    // An older hook sent no session, so the restored agent matches any session
    const first = await office()
    spawnAgent(first.server, gp('agent-restored'))

    const { server } = await office(first.dir)
    expect(server.activeAgents.get('agent-restored')).toMatchObject({ restored: true })
    expect(server.activeAgents.get('agent-restored').subagentId).toBeUndefined()

    // A fresh session's start overtakes its spawn: parked, not bound to the restored agent
    server.processEvent({ type: 'session_started', ...FRESH, source: 'startup' })
    server.processEvent({ type: 'agent_started', subagentId: 'sub-fresh', agentType: 'general-purpose', ...FRESH })
    expect(server.activeAgents.get('agent-restored').subagentId).toBeUndefined()
    expect(server.pendingStarts.has('sub-fresh')).toBe(true)
    server.processEvent({ type: 'agent_spawned', ...FRESH, agent: gp('agent-fresh') })
    expect(server.activeAgents.get('agent-fresh').subagentId).toBe('sub-fresh')

    // A subagent whose start never reached us gets an agent of its own
    const ev = server.processEvent({ type: 'agent_working', agentId: 'sub-unseen', agentType: 'general-purpose', status: 'reading a.ts', ...FRESH })
    expect(ev.agentId).toBe('agent-sub-unseen')
    expect(server.activeAgents.get('agent-restored').subagentId).toBeUndefined()
  })

  it('a launch whose start never came does not capture a start minutes later', async () => {
    const { server } = await office()
    vi.useFakeTimers({ toFake: ['Date'] })
    spawnAgent(server, gp('agent-cancelled'))

    vi.setSystemTime(Date.now() + 3 * MINUTE)
    // With nothing recent to take it the start is parked, not handed to the stale launch
    server.processEvent({ type: 'agent_started', subagentId: 'sub-1', agentType: 'general-purpose' })
    expect(server.activeAgents.get('agent-cancelled').subagentId).toBeUndefined()
    expect(server.pendingStarts.has('sub-1')).toBe(true)

    // ...and the spawn it overtook picks it up
    spawnAgent(server, gp('agent-new'))
    expect(server.activeAgents.get('agent-new').subagentId).toBe('sub-1')

    // The usual order (spawn, then start) binds the new launch, not the stale one
    spawnAgent(server, gp('agent-newer'))
    server.processEvent({ type: 'agent_started', subagentId: 'sub-2', agentType: 'general-purpose' })
    expect(server.activeAgents.get('agent-newer').subagentId).toBe('sub-2')
    expect(server.activeAgents.get('agent-cancelled').subagentId).toBeUndefined()
  })

  it('a start held back inside the window still binds; a first tool call has the longer window', async () => {
    const { server } = await office()
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    spawnAgent(server, gp('agent-slow-start'))
    vi.setSystemTime(t0 + server.START_BIND_MS)
    server.processEvent({ type: 'agent_started', subagentId: 'sub-slow', agentType: 'general-purpose' })
    expect(server.activeAgents.get('agent-slow-start').subagentId).toBe('sub-slow')

    // No SubagentStart hook: the subagent's first tool call comes a model turn later
    vi.setSystemTime(t0)
    spawnAgent(server, gp('agent-slow-turn'))
    vi.setSystemTime(t0 + 2 * MINUTE)
    const bound = server.processEvent({ type: 'agent_working', agentId: 'sub-turn', agentType: 'general-purpose', status: 'running: ls' })
    expect(bound.agentId).toBe('agent-slow-turn')

    // Past that window it is not a guess any more: the subagent gets its own agent
    spawnAgent(server, gp('agent-gone'))
    vi.setSystemTime(t0 + 2 * MINUTE + server.FIRST_TOOL_BIND_MS + 1)
    const own = server.processEvent({ type: 'agent_working', agentId: 'sub-late', agentType: 'general-purpose', status: 'running: ls' })
    expect(own.agentId).toBe('agent-sub-late')
    expect(server.activeAgents.get('agent-gone').subagentId).toBeUndefined()
  })

  it('three parallel launches of one type bind in launch order, past a stale launch of that type', async () => {
    const { server } = await office()
    vi.useFakeTimers({ toFake: ['Date'] })
    spawnAgent(server, gp('agent-stale'))
    vi.setSystemTime(Date.now() + 5 * MINUTE)

    // Parallel Agent calls: their PreToolUse hooks land in the same millisecond
    for (const id of ['agent-p1', 'agent-p2', 'agent-p3']) spawnAgent(server, gp(id, { background: true }))
    for (const sub of ['sub-p1', 'sub-p2', 'sub-p3']) {
      expect(server.processEvent({ type: 'agent_started', subagentId: sub, agentType: 'general-purpose' })).toBeNull()
    }
    expect(server.activeAgents.get('agent-p1').subagentId).toBe('sub-p1')
    expect(server.activeAgents.get('agent-p2').subagentId).toBe('sub-p2')
    expect(server.activeAgents.get('agent-p3').subagentId).toBe('sub-p3')
    expect(server.activeAgents.get('agent-stale').subagentId).toBeUndefined()
    expect(server.pendingStarts.size).toBe(0)

    // Their tool calls land on their own agents
    expect(server.processEvent({ type: 'agent_working', agentId: 'sub-p3', status: 'reading c' }).agentId).toBe('agent-p3')
    expect(server.processEvent({ type: 'agent_working', agentId: 'sub-p1', status: 'reading a' }).agentId).toBe('agent-p1')
  })

  it('explicit ids are not guesses: a late PostToolUse link binds an old or restored agent, and its start and tool calls follow', async () => {
    const first = await office()
    spawnAgent(first.server, gp('agent-restored-bg', { background: true }))
    const { server } = await office(first.dir)

    vi.useFakeTimers({ toFake: ['Date'] })
    spawnAgent(server, gp('agent-old-bg', { background: true }))
    vi.setSystemTime(Date.now() + 10 * MINUTE)

    server.processEvent({ type: 'agent_linked', agentId: 'agent-old-bg', subagentId: 'sub-old' })
    server.processEvent({ type: 'agent_linked', agentId: 'agent-restored-bg', subagentId: 'sub-restored' })
    expect(server.activeAgents.get('agent-old-bg').subagentId).toBe('sub-old')
    expect(server.activeAgents.get('agent-restored-bg').subagentId).toBe('sub-restored')

    // The start of an already-linked subagent only confirms it, however late
    server.processEvent({ type: 'agent_started', subagentId: 'sub-old', agentType: 'general-purpose' })
    server.processEvent({ type: 'agent_started', subagentId: 'sub-restored', agentType: 'general-purpose' })
    expect(server.pendingStarts.size).toBe(0)

    expect(server.processEvent({ type: 'agent_working', agentId: 'sub-old', agentType: 'general-purpose', status: 'x' }).agentId).toBe('agent-old-bg')
    expect(server.processEvent({ type: 'agent_working', agentId: 'sub-restored', agentType: 'general-purpose', status: 'y' }).agentId).toBe('agent-restored-bg')
  })
})
