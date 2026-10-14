/**
 * agents.json: written on every change, restored on startup, stale entries dropped.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOffice, postEvent, removeOffice, spawnAgent, type Office } from './helpers'

describe('agent persistence', () => {
  const offices: Office[] = []
  afterEach(() => {
    vi.useRealTimers()
    while (offices.length) removeOffice(offices.pop())
  })

  it('writes agents.json under the runtime dir on spawn (and nothing else outside it)', async () => {
    const office = await loadOffice()
    offices.push(office)
    const { server, dir } = office

    expect(server.RUNTIME_DIR).toBe(dir)
    expect(existsSync(join(dir, 'chat.db'))).toBe(true)
    // Importing the module must not write the token — only start() does
    expect(existsSync(join(dir, 'auth-token'))).toBe(false)
    expect(existsSync(join(dir, 'agents.json'))).toBe(false)

    await postEvent(server, {
      type: 'agent_spawned',
      agent: { id: 'agent-persist-1', name: 'Tester', role: 'test-engineer', task: 'Write tests', agentType: 'general-purpose' },
    })

    const saved = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'))
    expect(saved).toEqual({
      agents: [expect.objectContaining({
        id: 'agent-persist-1', name: 'Tester', role: 'test-engineer', task: 'Write tests', state: 'new-hire',
      })],
      sessions: [],
    })
  })

  it('restores working agents and their subagent aliases on a fresh import of the same runtime dir', async () => {
    const first = await loadOffice()
    offices.push(first)

    spawnAgent(first.server, {
      id: 'agent-restore-1', name: 'Agent', role: 'general-purpose', task: 'Long job', agentType: 'general-purpose', background: true,
    })
    first.server.processEvent({ type: 'agent_linked', agentId: 'agent-restore-1', subagentId: 'sub-restore-1' })
    first.server.processEvent({ type: 'agent_working', agentId: 'sub-restore-1', status: 'running: make' })

    // Completed agents and MCP workers are never persisted
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    spawnAgent(first.server, { id: 'agent-restore-2', name: 'Reviewer', role: 'code-reviewer', task: 'Quick review' })
    first.server.processEvent({ type: 'agent_completed', agentId: 'agent-restore-2', result: 'lgtm' })
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    first.server.processEvent({ type: 'mcp_call', server: 'github', tool: 'get_me' })

    const saved = JSON.parse(readFileSync(join(first.dir, 'agents.json'), 'utf8'))
    expect(saved.agents.map((a: any) => a.id)).toEqual(['agent-restore-1'])

    // "Restart": a fresh module instance pointed at the same runtime dir
    const second = await loadOffice({ dir: first.dir })
    expect(second.server).not.toBe(first.server)
    expect(Array.from(second.server.activeAgents.keys())).toEqual(['agent-restore-1'])
    expect(second.server.activeAgents.get('agent-restore-1')).toMatchObject({
      name: 'Agent', role: 'general-purpose', state: 'working', status: 'running: make', subagentId: 'sub-restore-1', background: true,
    })

    // The subagent alias came back too, so hook events by subagent id still find the agent
    const ev = second.server.processEvent({ type: 'agent_working', agentId: 'sub-restore-1', status: 'back at it' })
    expect(ev.agentId).toBe('agent-restore-1')
  })

  it('drops agents quiet for longer than AGENT_OFFICE_STALE_MINUTES on load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    const now = Date.now()
    const minutes = 60_000
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      agents: [
        { id: 'fresh', name: 'Fresh', role: 'debugger', state: 'working', spawnedAt: now - 5 * minutes, lastActivityAt: now - 5 * minutes },
        { id: 'stale', name: 'Stale', role: 'debugger', state: 'working', spawnedAt: now - 180 * minutes, lastActivityAt: now - 180 * minutes },
        // No lastActivityAt: spawnedAt is the fallback
        { id: 'stale-no-activity', name: 'Old', role: 'debugger', state: 'working', spawnedAt: now - 180 * minutes },
        { id: 'done', name: 'Done', role: 'debugger', state: 'completed', spawnedAt: now, lastActivityAt: now },
        { name: 'no-id', role: 'debugger', state: 'working', spawnedAt: now, lastActivityAt: now },
      ],
    }))

    const office = await loadOffice({ dir, env: { AGENT_OFFICE_STALE_MINUTES: '60' } })
    offices.push(office)
    expect(Array.from(office.server.activeAgents.keys())).toEqual(['fresh'])
  })

  it('ignores a corrupt agents.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    writeFileSync(join(dir, 'agents.json'), '{not json')
    const office = await loadOffice({ dir })
    offices.push(office)
    expect(office.server.activeAgents.size).toBe(0)
  })
})
