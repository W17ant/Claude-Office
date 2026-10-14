/**
 * Sessions: one Claude Code terminal per session_id. Created by SessionStart
 * (or implicitly by the first event that names an unknown session), listed by
 * GET /sessions and the WS snapshot, ended by SessionEnd — its agents clock
 * out and the session is forgotten after 60 s. Two terminals never share
 * workers.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { listen, loadOffice, postEvent, removeOffice, spawnAgent, type Office } from './helpers'

// Two terminals: the fields the tracker puts on every event of each
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

const gp = (id: string, task: string) => ({ id, name: 'Agent', role: 'general-purpose', task, agentType: 'general-purpose', background: true })

describe('session_started (SessionStart)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('creates an active session and lists it in GET /sessions with agent counts', async () => {
    const res = await postEvent(office.server, { type: 'session_started', ...ALPHA, source: 'startup', model: 'claude-haiku-5-5' })
    expect(res.status).toBe(200)

    const session = office.server.sessions.get(ALPHA.sessionId)
    expect(session).toMatchObject({
      id: ALPHA.sessionId, project: 'alpha', cwd: ALPHA.cwd, source: 'startup', model: 'claude-haiku-5-5', state: 'active',
    })
    expect(session.startedAt).toBeTypeOf('number')
    expect(session.lastActivityAt).toBe(session.startedAt)
    expect(session.agentIds).toBeInstanceOf(Set)

    const list = await request(office.server.app).get('/sessions')
    expect(list.status).toBe(200)
    expect(list.body).toEqual({
      sessions: [expect.objectContaining({
        id: ALPHA.sessionId, project: 'alpha', cwd: ALPHA.cwd, source: 'startup', model: 'claude-haiku-5-5', state: 'active',
        agentIds: [], agentCount: 0, workingCount: 0,
      })],
    })
  })

  it('returns the broadcast shape', () => {
    const ev = office.server.processEvent({ type: 'session_started', ...BETA, source: 'startup' })
    expect(ev).toEqual(expect.objectContaining({
      type: 'session_started', sessionId: BETA.sessionId, project: 'beta', cwd: BETA.cwd, source: 'startup', state: 'active',
      agentIds: [], agentCount: 0, workingCount: 0, timestamp: expect.any(Number),
    }))
    expect(ev).not.toHaveProperty('id')
  })

  it('a replayed start updates the record instead of creating another: compact keeps the source, resume replaces it', () => {
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'compact', model: 'claude-opus-4-1' })
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ source: 'startup', model: 'claude-opus-4-1' })

    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'resume', title: 'office refactor' })
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ source: 'resume', model: 'claude-opus-4-1', title: 'office refactor' })
    expect(office.server.sessions.size).toBe(2)
  })

  it('ignores a start without a sessionId', () => {
    expect(office.server.processEvent({ type: 'session_started', source: 'startup' })).toBeNull()
    expect(office.server.sessions.size).toBe(2)
  })

  it('clamps the session strings (cwd and transcriptPath up to 400 characters)', async () => {
    const long = 'x'.repeat(500)
    await postEvent(office.server, { type: 'session_started', sessionId: 'clamp', project: long, cwd: `/${long}`, source: long, model: long, title: long })
    const session = office.server.sessions.get('clamp')
    expect(session.project).toHaveLength(200)
    expect(session.cwd).toHaveLength(400)
    expect(session.source).toHaveLength(200)
    expect(session.model).toHaveLength(200)
    expect(session.title).toHaveLength(200)
  })
})

describe('implicit sessions (hooks that start mid-session)', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('the first event naming an unknown session creates it with source "implicit" and files the agent under it', async () => {
    await postEvent(office.server, { type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Count etc') })

    const session = office.server.sessions.get(ALPHA.sessionId)
    expect(session).toMatchObject({ id: ALPHA.sessionId, project: 'alpha', cwd: ALPHA.cwd, source: 'implicit', state: 'active' })
    expect(Array.from(session.agentIds)).toEqual(['agent-a1'])
    expect(office.server.activeAgents.get('agent-a1')).toMatchObject({ sessionId: ALPHA.sessionId, project: 'alpha' })
  })

  it('main-thread agent_working (no agentId) creates the session, remembers the status on it and names it in the broadcast', async () => {
    const ev = office.server.processEvent({ type: 'agent_working', status: 'reading index.js', ...BETA })
    expect(ev).toEqual({
      type: 'agent_working', agentId: undefined, status: 'reading index.js',
      sessionId: BETA.sessionId, project: 'beta', timestamp: expect.any(Number),
    })
    const session = office.server.sessions.get(BETA.sessionId)
    expect(session).toMatchObject({ source: 'implicit', lastStatus: 'reading index.js' })
    expect(session.lastStatusAt).toBeTypeOf('number')
    expect(office.server.activeAgents.size).toBe(1)  // no worker was invented for it

    const list = await request(office.server.app).get('/sessions')
    expect(list.body.sessions).toContainEqual(expect.objectContaining({ id: BETA.sessionId, lastStatus: 'reading index.js', agentCount: 0 }))
  })

  it('derives the project from cwd when the event has none; a bare sessionId still makes a session', () => {
    office.server.processEvent({ type: 'agent_working', status: 'x', sessionId: 'gamma-id', cwd: '/x/y/gamma/' })
    expect(office.server.sessions.get('gamma-id')).toMatchObject({ project: 'gamma', cwd: '/x/y/gamma/' })
    office.server.processEvent({ type: 'agent_working', status: 'x', sessionId: 'bare-id' })
    expect(office.server.sessions.get('bare-id')).toMatchObject({ id: 'bare-id', source: 'implicit' })
    expect(office.server.sessions.get('bare-id').project).toBeUndefined()
  })

  it('the agent auto-spawned for an unknown subagent id is filed under the event\'s session', () => {
    const ev = office.server.processEvent({
      type: 'agent_working', agentId: 'af4d4090b68ebb5f9', agentType: 'general-purpose', role: 'debugger', name: 'Debugger',
      status: 'running: pytest', ...BETA,
    })
    expect(ev).toMatchObject({ agentId: 'agent-af4d4090b68ebb5f9', sessionId: BETA.sessionId })
    expect(office.server.activeAgents.get('agent-af4d4090b68ebb5f9')).toMatchObject({ sessionId: BETA.sessionId, project: 'beta', state: 'working' })
    expect(office.server.sessions.get(BETA.sessionId).agentIds.has('agent-af4d4090b68ebb5f9')).toBe(true)
  })
})

describe('agents carry their session', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
  })
  afterAll(() => removeOffice(office))

  it('agent records and /agents entries have sessionId and project', async () => {
    spawnAgent(office.server, { ...gp('agent-a1', 'Write tests') })  // no session on the spawn itself
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a2', 'Review') })

    const agents = await request(office.server.app).get('/agents')
    expect(agents.body.agents).toEqual([
      expect.objectContaining({ id: 'agent-a1' }),
      expect.objectContaining({ id: 'agent-a2', sessionId: ALPHA.sessionId, project: 'alpha' }),
    ])
    expect(agents.body.agents[0]).not.toHaveProperty('sessionId')
    expect(agents.body.agents[0]).not.toHaveProperty('project')
  })

  it('an agent spawned before the hook knew its session learns it from its first working event (and never moves again)', () => {
    office.server.processEvent({ type: 'agent_linked', agentId: 'agent-a1', subagentId: 'sub-a1' })
    const ev = office.server.processEvent({ type: 'agent_working', agentId: 'sub-a1', status: 'running: make', ...ALPHA })
    expect(ev).toMatchObject({ agentId: 'agent-a1', sessionId: ALPHA.sessionId })
    expect(office.server.activeAgents.get('agent-a1')).toMatchObject({ sessionId: ALPHA.sessionId, project: 'alpha', state: 'working' })
    expect(Array.from(office.server.sessions.get(ALPHA.sessionId).agentIds).sort()).toEqual(['agent-a1', 'agent-a2'])

    // A later event claiming another session does not re-file it
    office.server.processEvent({ type: 'agent_working', agentId: 'sub-a1', status: 'still here', ...BETA })
    expect(office.server.activeAgents.get('agent-a1').sessionId).toBe(ALPHA.sessionId)
    expect(office.server.sessions.get(BETA.sessionId).agentIds.size).toBe(0)
  })

  it('every event with a sessionId bumps that session\'s activity clock', () => {
    const session = office.server.sessions.get(ALPHA.sessionId)
    for (const body of [
      { type: 'agent_linked', agentId: 'agent-a2', subagentId: 'sub-a2', ...ALPHA },
      { type: 'agent_started', subagentId: 'sub-a2', agentType: 'general-purpose', ...ALPHA },
      { type: 'agent_working', agentId: 'sub-a2', status: 'x', ...ALPHA },
      { type: 'mcp_call', server: 'github', tool: 'get_me', ...ALPHA },
      { type: 'mcp_done', server: 'github', ...ALPHA },
      { type: 'agent_completed', agentId: 'ghost', result: 'done', ...ALPHA },
    ]) {
      session.lastActivityAt = 0
      office.server.processEvent(body)
      expect(session.lastActivityAt, body.type).toBeGreaterThan(0)
    }
  })

  it('agent_completed and mcp_call broadcasts name the session too', () => {
    const mcp = office.server.processEvent({ type: 'mcp_call', server: 'github', tool: 'get_me', ...ALPHA })
    expect(mcp).toMatchObject({ type: 'mcp_call', sessionId: ALPHA.sessionId })
    expect(office.server.activeAgents.get(mcp.agentId)).toMatchObject({ sessionId: ALPHA.sessionId, project: 'alpha' })
    office.server.processEvent({ type: 'mcp_done', server: 'github', ...ALPHA })

    const done = office.server.processEvent({ type: 'agent_completed', agentId: 'sub-a2', result: 'ok' })
    expect(done).toMatchObject({ type: 'agent_completed', agentId: 'agent-a2', result: 'ok', sessionId: ALPHA.sessionId })
  })
})

describe('two sessions are kept apart', () => {
  let office: Office
  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'session_started', ...BETA, source: 'startup' })
  })
  afterAll(() => removeOffice(office))

  it('a SubagentStart binds to an unlinked agent of its own session, not to an older one in another terminal', () => {
    // alpha spawned first; beta's SubagentStart arrives before alpha's
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'alpha work') })
    office.server.processEvent({ type: 'agent_spawned', ...BETA, agent: gp('agent-b1', 'beta work') })
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-b1', agentType: 'general-purpose', ...BETA })
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-a1', agentType: 'general-purpose', ...ALPHA })

    expect(office.server.activeAgents.get('agent-b1').subagentId).toBe('sub-b1')
    expect(office.server.activeAgents.get('agent-a1').subagentId).toBe('sub-a1')
  })

  it('a first-tool-call binding (no SubagentStart seen) stays inside the session as well', () => {
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a2', 'alpha more') })
    office.server.processEvent({ type: 'agent_spawned', ...BETA, agent: gp('agent-b2', 'beta more') })
    const ev = office.server.processEvent({ type: 'agent_working', agentId: 'sub-b2', agentType: 'general-purpose', status: 'running: ls', ...BETA })
    expect(ev.agentId).toBe('agent-b2')
    expect(office.server.activeAgents.get('agent-a2').subagentId).toBeUndefined()
  })

  it('a parked SubagentStart is adopted by a spawn from the same session only', () => {
    office.server.processEvent({ type: 'agent_started', subagentId: 'sub-b3', agentType: 'Explore', ...BETA })
    expect(office.server.pendingStarts.has('sub-b3')).toBe(true)
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: { id: 'agent-a3', name: 'Explorer', role: 'Explore', agentType: 'Explore' } })
    expect(office.server.activeAgents.get('agent-a3').subagentId).toBeUndefined()
    expect(office.server.pendingStarts.has('sub-b3')).toBe(true)
    office.server.processEvent({ type: 'agent_spawned', ...BETA, agent: { id: 'agent-b3', name: 'Explorer', role: 'Explore', agentType: 'Explore' } })
    expect(office.server.activeAgents.get('agent-b3').subagentId).toBe('sub-b3')
    expect(office.server.pendingStarts.has('sub-b3')).toBe(false)
  })

  it('working events land on their own session\'s agent and the sessions list counts them separately', async () => {
    office.server.processEvent({ type: 'agent_working', agentId: 'sub-a1', status: 'alpha busy', ...ALPHA })
    expect(office.server.activeAgents.get('agent-a1')).toMatchObject({ state: 'working', status: 'alpha busy' })
    expect(office.server.activeAgents.get('agent-b1').state).toBe('new-hire')

    const list = await request(office.server.app).get('/sessions')
    const byId = Object.fromEntries(list.body.sessions.map((s: any) => [s.id, s]))
    expect(byId[ALPHA.sessionId]).toMatchObject({ project: 'alpha', agentCount: 3, workingCount: 1 })
    expect(byId[BETA.sessionId]).toMatchObject({ project: 'beta', agentCount: 3, workingCount: 1 })
    expect(byId[ALPHA.sessionId].agentIds.sort()).toEqual(['agent-a1', 'agent-a2', 'agent-a3'])
    expect(byId[BETA.sessionId].agentIds.sort()).toEqual(['agent-b1', 'agent-b2', 'agent-b3'])
  })

  it('main-thread activity in one terminal is attributed to that session, not painted on the other\'s worker', () => {
    const ev = office.server.processEvent({ type: 'agent_working', status: 'editing App.tsx', ...BETA })
    expect(ev).toMatchObject({ agentId: undefined, status: 'editing App.tsx', sessionId: BETA.sessionId, project: 'beta' })
    expect(office.server.activeAgents.get('agent-a1').status).toBe('alpha busy')
    expect(office.server.sessions.get(BETA.sessionId).lastStatus).toBe('editing App.tsx')
    expect(office.server.sessions.get(ALPHA.sessionId).lastStatus).toBeUndefined()
  })

  it('mcp_done clears only its own session\'s MCP workers (all of them when the event names no session)', () => {
    office.server.processEvent({ type: 'mcp_call', server: 'github', tool: 'get_me', ...ALPHA })
    office.server.processEvent({ type: 'mcp_call', server: 'github', tool: 'get_me', ...BETA })
    const mcps = () => Array.from(office.server.activeAgents.values()).filter(a => a.server === 'github')
    expect(mcps()).toHaveLength(2)

    office.server.processEvent({ type: 'mcp_done', server: 'github', ...ALPHA })
    expect(mcps().map(a => a.sessionId)).toEqual([BETA.sessionId])

    office.server.processEvent({ type: 'mcp_done', server: 'github' })
    expect(mcps()).toHaveLength(0)
  })
})

describe('session_ended (SessionEnd)', () => {
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

  it('marks the session ended, walks its still-active agents out ("session ended"), and forgets it after 60 s', async () => {
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Long job') })
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a2', 'Done already') })
    office.server.processEvent({ type: 'agent_spawned', ...BETA, agent: gp('agent-b1', 'Other terminal') })
    office.server.processEvent({ type: 'agent_working', agentId: 'agent-a1', status: 'running: make', ...ALPHA })

    // Only fake setTimeout so Date.now() and the HTTP stack stay real
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    office.server.processEvent({ type: 'agent_completed', agentId: 'agent-a2', result: 'lgtm' })

    const ev = office.server.processEvent({ type: 'session_ended', ...ALPHA, reason: 'other' })
    expect(ev).toEqual(expect.objectContaining({
      type: 'session_ended', sessionId: ALPHA.sessionId, project: 'alpha', state: 'ended', reason: 'other',
      endedAt: expect.any(Number), timestamp: expect.any(Number),
    }))
    const session = office.server.sessions.get(ALPHA.sessionId)
    expect(session).toMatchObject({ state: 'ended', reason: 'other' })

    // Its agents clocked out; the other terminal's agent did not
    expect(office.server.activeAgents.get('agent-a1').state).toBe('completed')
    expect(office.server.activeAgents.get('agent-b1').state).toBe('new-hire')

    // Agents leave after the usual 10 s grace; the session is listed as ended until 60 s
    vi.advanceTimersByTime(10_000)
    expect(office.server.activeAgents.has('agent-a1')).toBe(false)
    expect(office.server.activeAgents.has('agent-a2')).toBe(false)
    expect(office.server.activeAgents.has('agent-b1')).toBe(true)
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ state: 'ended' })
    expect(office.server.sessions.get(ALPHA.sessionId).agentIds.size).toBe(0)

    vi.advanceTimersByTime(49_999)
    expect(office.server.sessions.has(ALPHA.sessionId)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(office.server.sessions.has(ALPHA.sessionId)).toBe(false)
    expect(office.server.sessions.has(BETA.sessionId)).toBe(true)
    vi.useRealTimers()

    const chat = await request(office.server.app).get('/chat')
    const done = chat.body.messages.filter((m: any) => m.text.startsWith('done:'))
    expect(done).toEqual([
      expect.objectContaining({ text: 'done: lgtm' }),
      expect.objectContaining({ text: 'done: session ended' }),
    ])
  })

  it('a straggling event does not revive an ended session, but a SessionStart (resume) with the same id does', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    office.server.processEvent({ type: 'session_ended', ...BETA, reason: 'prompt_input_exit' })
    expect(office.server.sessions.get(BETA.sessionId)).toMatchObject({ state: 'ended', reason: 'prompt_input_exit' })

    office.server.processEvent({ type: 'agent_working', status: 'late', ...BETA })
    expect(office.server.sessions.get(BETA.sessionId).state).toBe('ended')

    const ev = office.server.processEvent({ type: 'session_started', ...BETA, source: 'resume' })
    expect(ev).toMatchObject({ type: 'session_started', sessionId: BETA.sessionId, state: 'active', source: 'resume' })
    const session = office.server.sessions.get(BETA.sessionId)
    expect(session.endedAt).toBeUndefined()
    expect(session.reason).toBeUndefined()

    vi.advanceTimersByTime(60_000)
    expect(office.server.sessions.has(BETA.sessionId)).toBe(true)
    vi.useRealTimers()
  })

  it('an end for an unknown session passes through without creating one; a duplicate end is a no-op', () => {
    const ev = office.server.processEvent({ type: 'session_ended', sessionId: 'ghost', reason: 'other' })
    expect(ev).toEqual({ type: 'session_ended', sessionId: 'ghost', reason: 'other', timestamp: expect.any(Number) })
    expect(office.server.sessions.has('ghost')).toBe(false)
    expect(office.server.processEvent({ type: 'session_ended', reason: 'other' })).toBeNull()

    office.server.processEvent({ type: 'session_ended', ...BETA, reason: 'other' })
    const { endedAt } = office.server.sessions.get(BETA.sessionId)
    office.server.processEvent({ type: 'session_ended', ...BETA, reason: 'later' })
    expect(office.server.sessions.get(BETA.sessionId)).toMatchObject({ state: 'ended', reason: 'other', endedAt })
  })

  it('POST /event accepts session_ended and session_started', async () => {
    const res = await postEvent(office.server, { type: 'session_ended', sessionId: 'nobody', reason: 'other' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('stale sessions', () => {
  let office: Office | undefined
  afterEach(() => {
    vi.useRealTimers()
    removeOffice(office)
    office = undefined
  })

  it('a session with no events for AGENT_OFFICE_STALE_MINUTES ends on the sweep, taking its agents with it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    office = await loadOffice({ env: { AGENT_OFFICE_STALE_MINUTES: '1' } })
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Quiet job') })
    office.server.processEvent({ type: 'session_started', ...BETA, source: 'startup' })

    const stale = Date.now() - 2 * 60_000
    office.server.sessions.get(ALPHA.sessionId).lastActivityAt = stale
    office.server.activeAgents.get('agent-a1').lastActivityAt = stale

    vi.advanceTimersByTime(5 * 60_000)
    expect(office.server.sessions.get(ALPHA.sessionId)).toMatchObject({ state: 'ended', reason: 'stale' })
    expect(office.server.activeAgents.get('agent-a1').state).toBe('completed')
    expect(office.server.sessions.get(BETA.sessionId).state).toBe('active')
  })
})

describe('persistence', () => {
  const offices: Office[] = []
  afterEach(() => {
    while (offices.length) removeOffice(offices.pop())
  })

  it('sessions are saved next to the agents and restored on a fresh import of the same runtime dir (ended ones are not)', async () => {
    const first = await loadOffice()
    offices.push(first)
    first.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup', model: 'claude-haiku-5-5' })
    first.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'Long job') })
    first.server.processEvent({ type: 'agent_linked', agentId: 'agent-a1', subagentId: 'sub-a1', ...ALPHA })
    first.server.processEvent({ type: 'agent_working', status: 'reading x', ...ALPHA })
    first.server.processEvent({ type: 'session_started', ...BETA, source: 'startup' })
    first.server.processEvent({ type: 'session_ended', ...BETA, reason: 'other' })

    const saved = JSON.parse(readFileSync(join(first.dir, 'agents.json'), 'utf8'))
    expect(saved.agents.map((a: any) => a.id)).toEqual(['agent-a1'])
    expect(saved.sessions).toEqual([expect.objectContaining({
      id: ALPHA.sessionId, project: 'alpha', cwd: ALPHA.cwd, source: 'startup', model: 'claude-haiku-5-5', state: 'active',
      agentIds: ['agent-a1'], lastStatus: 'reading x',
    })])

    const second = await loadOffice({ dir: first.dir })
    expect(Array.from(second.server.sessions.keys())).toEqual([ALPHA.sessionId])
    const session = second.server.sessions.get(ALPHA.sessionId)
    expect(session).toMatchObject({ project: 'alpha', source: 'startup', model: 'claude-haiku-5-5', state: 'active', lastStatus: 'reading x' })
    expect(Array.from(session.agentIds)).toEqual(['agent-a1'])
    expect(second.server.activeAgents.get('agent-a1')).toMatchObject({ sessionId: ALPHA.sessionId, project: 'alpha' })

    const list = await request(second.server.app).get('/sessions')
    expect(list.body.sessions).toEqual([expect.objectContaining({ id: ALPHA.sessionId, agentCount: 1, agentIds: ['agent-a1'] })])
  })

  it('drops sessions quiet for longer than AGENT_OFFICE_STALE_MINUTES on load; an older agents.json without sessions still loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    const now = Date.now()
    const minutes = 60_000
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      agents: [{ id: 'fresh-agent', name: 'Fresh', role: 'debugger', state: 'working', spawnedAt: now, lastActivityAt: now, sessionId: 'fresh' }],
      sessions: [
        { id: 'fresh', project: 'fresh', state: 'active', startedAt: now - 5 * minutes, lastActivityAt: now - 5 * minutes, agentIds: ['fresh-agent', 'gone-agent'] },
        { id: 'stale', project: 'stale', state: 'active', startedAt: now - 180 * minutes, lastActivityAt: now - 180 * minutes, agentIds: [] },
        { id: 'stale-no-activity', project: 'old', state: 'active', startedAt: now - 180 * minutes },
        { id: 'ended', project: 'ended', state: 'ended', startedAt: now, lastActivityAt: now, agentIds: [] },
        { project: 'no-id', state: 'active', startedAt: now, lastActivityAt: now },
      ],
    }))
    const office = await loadOffice({ dir, env: { AGENT_OFFICE_STALE_MINUTES: '60' } })
    offices.push(office)
    expect(Array.from(office.server.sessions.keys())).toEqual(['fresh'])
    // Agent ids that did not survive are dropped from the restored set
    expect(Array.from(office.server.sessions.get('fresh').agentIds)).toEqual(['fresh-agent'])

    const legacyDir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    writeFileSync(join(legacyDir, 'agents.json'), JSON.stringify({
      agents: [{ id: 'legacy', name: 'Legacy', role: 'debugger', state: 'working', spawnedAt: now, lastActivityAt: now }],
    }))
    const legacy = await loadOffice({ dir: legacyDir })
    offices.push(legacy)
    expect(Array.from(legacy.server.activeAgents.keys())).toEqual(['legacy'])
    expect(legacy.server.sessions.size).toBe(0)
  })
})

describe('WebSocket snapshot', () => {
  let office: Office
  let ws: WebSocket | undefined

  beforeAll(async () => {
    office = await loadOffice()
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup' })
    office.server.processEvent({ type: 'agent_spawned', ...ALPHA, agent: gp('agent-a1', 'fix it') })
    office.server.processEvent({ type: 'agent_working', status: 'reading App.tsx', ...BETA })
  })

  afterAll(async () => {
    ws?.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('includes the sessions, and the agents in it say which session they belong to', async () => {
    const port = await listen(office.server.httpServer)
    const snapshot = await new Promise<any>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.once('message', raw => resolve(JSON.parse(raw.toString())))
      ws.once('error', reject)
    })
    expect(snapshot.type).toBe('snapshot')
    expect(snapshot.activeAgents).toEqual([expect.objectContaining({ id: 'agent-a1', sessionId: ALPHA.sessionId, project: 'alpha' })])
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ id: ALPHA.sessionId, project: 'alpha', source: 'startup', state: 'active', agentIds: ['agent-a1'], agentCount: 1 }),
      expect.objectContaining({ id: BETA.sessionId, project: 'beta', source: 'implicit', state: 'active', agentCount: 0, lastStatus: 'reading App.tsx' }),
    ])
  })
})
