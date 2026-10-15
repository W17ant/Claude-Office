/**
 * src/inspector.ts — the inspector card's words and its fallback (no DOM:
 * AgentCard.tsx only draws these). The boss is named through BOSS_NAME, so
 * the tests pass with and without an office.config.json.
 */

import { describe, expect, it } from 'vitest'
import { officeHttpBase } from '../src/serverUrl'
import {
  inspectUrl, mainStateLabel, workerStateLabel, toolCountRows, recentHistory, atItFor, finishedStats,
  derivedNote, transcriptEmptyText, transcriptLine, fallbackInspection, promptAndReply, historyMark, cardSide, HISTORY_SHOWN,
  type HistoryEntry, type Inspection,
} from '../src/inspector'
import { BOSS_NAME } from '../src/config'
import type { Agent } from '../src/types'

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-toolu_1', name: 'Tester', type: 'subagent', role: 'test-engineer', state: 'working',
    position: { x: 10, y: 50 }, targetPosition: { x: 10, y: 50 }, deskPosition: { x: 10, y: 50 },
    room: 'main-office', assignedRoom: 'main-office', color: '#f39c12', emoji: '🧪', hiredAt: 1_000,
    task: 'Write tests', statusText: 'running: npm test', ...overrides,
  } as Agent
}

function inspection(overrides: Partial<Inspection> = {}): Inspection {
  return {
    id: 'agent-toolu_1', kind: 'worker', name: 'Tester', role: 'test-engineer', state: 'working',
    history: [], toolCounts: {}, stats: { spawnedAt: 1_000, parent: null, unread: 0 },
    transcriptAvailable: false, transcriptReason: 'no transcript path yet', ...overrides,
  }
}

describe('where the card fetches from', () => {
  it('GET /agents/:id on the office server, the id URL-encoded', () => {
    expect(inspectUrl('main-a b/c', 'http://localhost:4000')).toBe('http://localhost:4000/agents/main-a%20b%2Fc')
    // No window (Node): src/serverUrl.ts falls back to the default server
    expect(inspectUrl('agent-1')).toBe(`${officeHttpBase()}/agents/agent-1`)
  })
})

describe('state labels', () => {
  it('a session Claude: working, waiting on N workers, idle, needs you with what it waits on, API error, compacting', () => {
    expect(mainStateLabel({ state: 'working' })).toBe('working')
    expect(mainStateLabel({ state: 'waiting', waitingOn: 2 })).toBe('waiting on 2 workers')
    expect(mainStateLabel({ state: 'waiting', waitingOn: 1 })).toBe('waiting on 1 worker')
    expect(mainStateLabel({ state: 'idle' })).toBe('idle')
    expect(mainStateLabel({ state: 'needs-you', needsYou: { kind: 'permission', toolName: 'Bash', summary: 'npm test' } })).toBe('needs you: Bash · npm test')
    expect(mainStateLabel({ state: 'error', error: { error: 'rate_limit', detail: 'slow down' } })).toBe('API error: rate_limit — slow down')
    expect(mainStateLabel({ state: 'compacting' })).toBe('compacting')
    expect(mainStateLabel(undefined)).toBe('not heard from yet')
  })

  it('a worker', () => {
    expect(workerStateLabel('new-hire')).toBe('arriving')
    expect(workerStateLabel('completed')).toBe('finished')
    expect(workerStateLabel('waiting')).toBe('waiting for a desk')
    expect(workerStateLabel('something-new')).toBe('something-new')
  })
})

describe('tools and history', () => {
  it('counts busiest first, then by name', () => {
    expect(toolCountRows({ Read: 2, Bash: 5, Edit: 2 })).toEqual([{ tool: 'Bash', n: 5 }, { tool: 'Edit', n: 2 }, { tool: 'Read', n: 2 }])
    expect(toolCountRows(undefined)).toEqual([])
  })

  it('the last ten, newest first', () => {
    const history: HistoryEntry[] = Array.from({ length: 14 }, (_, i) => ({ at: i, kind: 'tool', tool: 'Read', text: `r${i}` }))
    const recent = recentHistory(history)
    expect(recent).toHaveLength(HISTORY_SHOWN)
    expect(recent[0].text).toBe('r13')
    expect(recent.at(-1)!.text).toBe('r4')
    expect(historyMark('failed')).toBe('✗')
    expect(historyMark('completed')).toBe('✓')
  })
})

describe('how long, and the totals', () => {
  it('a working worker: since spawn; a finished one: its reported duration, else spawn to completion; a Claude: time in its state', () => {
    expect(atItFor(inspection(), 61_000)).toBe('1m00s')
    expect(atItFor(inspection({ stats: { spawnedAt: 1_000, completedAt: 31_000, parent: null, unread: 0 } }), 99_000)).toBe('30s')
    expect(atItFor(inspection({ stats: { spawnedAt: 1_000, durationMs: 192_000, parent: null, unread: 0 } }), 99_000)).toBe('3m12s')
    expect(atItFor(inspection({ kind: 'main', main: { state: 'working', since: 10_000 } }), 25_000)).toBe('15s')
  })

  it('finished stats and the note on what the office worked out itself', () => {
    const stats = { tokens: 20_676, durationMs: 61_000, toolUses: 3, model: 'claude-haiku-5-5', parent: null, unread: 0 }
    expect(finishedStats(stats)).toEqual(['21k tok', '1m01s', '3 tool uses', 'haiku-5-5'])
    expect(finishedStats({ parent: null, unread: 0 })).toEqual([])
    expect(derivedNote({ derived: ['tokens', 'durationMs', 'toolUses', 'model'] }))
      .toBe('worked out by the office: tokens and model from its transcript, duration from spawn to finish, tool uses the hook saw')
    expect(derivedNote({ derived: ['model'] })).toBe('worked out by the office: model from its transcript')
    expect(derivedNote({})).toBeNull()
  })
})

describe('the transcript section', () => {
  it('says why it is empty: prompts off, no path yet, file gone, nothing said', () => {
    expect(transcriptEmptyText({ transcriptAvailable: false, transcriptReason: 'prompts off' })).toBe('transcript hidden: prompts off')
    // The server answers a request without the UI token like this; the page has one once the snapshot arrives
    expect(transcriptEmptyText({ transcriptAvailable: false, transcriptReason: 'needs the office token' })).toBe('transcript appears once the office is connected')
    expect(transcriptEmptyText({ transcriptAvailable: false, transcriptReason: 'no transcript path yet' })).toBe('no transcript yet')
    expect(transcriptEmptyText({ transcriptAvailable: false, transcriptReason: 'transcript file not found' })).toBe('transcript file not found')
    expect(transcriptEmptyText({ transcriptAvailable: true, transcript: [] })).toBe('nothing said yet')
    expect(transcriptEmptyText({ transcriptAvailable: true, transcript: [{ at: 1, kind: 'said', text: 'hi' }] })).toBeNull()
  })

  it('a tool entry names the tool, the input and anything said alongside', () => {
    expect(transcriptLine({ at: 1, kind: 'tool', tool: 'Bash', tools: ['Bash'], input: 'ls /etc' })).toBe('Bash — ls /etc')
    expect(transcriptLine({ at: 1, kind: 'tool', tool: 'Read', tools: ['Read', 'Grep'], input: '/a.ts', text: 'checking' })).toBe('Read +1 — /a.ts  “checking”')
    expect(transcriptLine({ at: 1, kind: 'said', text: 'done' })).toBe('done')
  })
})

describe('cardSide', () => {
  it('opens on the right when the character stands where the card would cover it', () => {
    expect(cardSide(25.8)).toBe('right')
    expect(cardSide(48.9)).toBe('left')
    expect(cardSide(undefined)).toBe('left')
    expect(cardSide(Number.NaN)).toBe('left')
  })
})

describe('fallbackInspection — what the office alone knows (?sim, a 404)', () => {
  it('a worker: its reducer fields, no history, no transcript', () => {
    const insp = fallbackInspection(agent({ unread: 2, sessionId: 's1', project: 'proj' }))
    expect(insp).toMatchObject({
      id: 'agent-toolu_1', kind: 'worker', name: 'Tester', role: 'test-engineer', task: 'Write tests', state: 'working',
      status: 'running: npm test', sessionId: 's1', project: 'proj', unread: 2, history: [], toolCounts: {},
      stats: { spawnedAt: 1_000, parent: null, unread: 2 }, transcriptAvailable: false,
    })
  })

  it('a session Claude: its main state and the session the socket knows (prompt text included)', () => {
    const claude = agent({ id: 'main-s1', name: 'Claude', role: 'assistant', sessionId: 's1', mainState: 'waiting', waitingOn: 1, model: 'claude-opus-4-1' })
    const sessions = [{ id: 's1', project: 'proj', cwd: '/home/me/proj', state: 'active' as const, main: { state: 'waiting' as const, waitingOn: 1, crons: 2, lastPrompt: 'fix it', lastReply: 'on it', since: 5 } }]
    const insp = fallbackInspection(claude, sessions)
    expect(insp).toMatchObject({ kind: 'main', state: 'waiting', project: 'proj', cwd: '/home/me/proj', model: 'claude-opus-4-1', crons: 2 })
    expect(mainStateLabel(insp.main)).toBe('waiting on 1 worker')
    expect(promptAndReply(insp, sessions[0])).toEqual({ prompt: 'fix it', reply: 'on it', hidden: false })
    expect(promptAndReply({ ...insp, transcriptReason: 'prompts off' }, undefined).hidden).toBe(true)
    // With the UI token the server's own answer carries the text; the socket's session is only the fallback
    const served = { ...insp, main: { state: 'idle' as const, lastPrompt: 'served prompt', lastReply: 'served reply' } }
    expect(promptAndReply(served, undefined)).toEqual({ prompt: 'served prompt', reply: 'served reply', hidden: false })
    expect(promptAndReply({ ...insp, main: { state: 'idle' as const } }, sessions[0])).toEqual({ prompt: 'fix it', reply: 'on it', hidden: false })
  })

  it('the boss', () => {
    const boss = fallbackInspection(agent({ id: `boss-${BOSS_NAME.toLowerCase()}`, name: BOSS_NAME, role: 'boss', task: undefined, statusText: undefined }))
    expect(boss).toMatchObject({ kind: 'worker', name: BOSS_NAME, role: 'boss' })
  })
})
