/**
 * src/meters.ts — the frontend store behind the payroll / electricity /
 * memory panel: the pure reducer and the presentation helpers, in plain Node.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CLUTTER_THRESHOLD, contextTone, dispatchMeters, electricityLevel, electricityPeriod,
  formatMoney, formatTokens, getMeters, reduceMeters, resetMeters, subscribeMeters,
  type MetersState, type SessionStatus,
} from '../src/meters'

function session(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: 'sess-1', project: 'Claude-Office', model: 'Haiku 5.5', modelId: 'claude-haiku-5-5',
    cost: 0.014, durationMs: 23245, linesAdded: 156, linesRemoved: 23,
    context: { used: 4.4, size: 1000000, input: 44051, output: 358 },
    burn: { dollarsPerMin: 0, tokensPerMin: 0 }, updatedAt: 1000,
    ...overrides,
  }
}

const EMPTY: MetersState = { sessions: [], totals: null }

describe('reduceMeters', () => {
  it('upserts a session_status, most recent first, with the server totals', () => {
    const one = reduceMeters(EMPTY, { type: 'session_status', sessionId: 'sess-1', session: session(), totals: { costToday: 0.014, tokensPerMin: 0, dollarsPerMin: 0 } })
    expect(one.sessions.map(s => s.sessionId)).toEqual(['sess-1'])
    expect(one.totals).toEqual({ costToday: 0.014, tokensPerMin: 0, dollarsPerMin: 0 })

    const two = reduceMeters(one, { type: 'session_status', sessionId: 'sess-2', session: session({ sessionId: 'sess-2', project: 'other', updatedAt: 2000 }), totals: { costToday: 0.03, tokensPerMin: 10, dollarsPerMin: 0.01 } })
    expect(two.sessions.map(s => s.sessionId)).toEqual(['sess-2', 'sess-1'])

    const updated = reduceMeters(two, { type: 'session_status', sessionId: 'sess-1', session: session({ cost: 0.5, updatedAt: 3000 }) })
    expect(updated.sessions.map(s => s.sessionId)).toEqual(['sess-1', 'sess-2'])
    expect(updated.sessions[0].cost).toBe(0.5)
    // No totals on the event: summed locally
    expect(updated.totals).toEqual({ costToday: 0.514, tokensPerMin: 0, dollarsPerMin: 0 })
  })

  it('the snapshot form replaces everything', () => {
    const prev = reduceMeters(EMPTY, { type: 'session_status', sessionId: 'gone', session: session({ sessionId: 'gone' }) })
    const next = reduceMeters(prev, { type: 'session_status', statuses: [session({ sessionId: 'a', updatedAt: 1 }), session({ sessionId: 'b', updatedAt: 2 })], totals: { costToday: 1, tokensPerMin: 2, dollarsPerMin: 3 } })
    expect(next.sessions.map(s => s.sessionId)).toEqual(['b', 'a'])
    expect(next.totals).toEqual({ costToday: 1, tokensPerMin: 2, dollarsPerMin: 3 })
    expect(reduceMeters(next, { type: 'session_status', statuses: [] }).sessions).toEqual([])
  })

  it('removes an expired session and ignores removals of unknown ones', () => {
    const prev = reduceMeters(EMPTY, { type: 'session_status', sessionId: 'sess-1', session: session() })
    expect(reduceMeters(prev, { type: 'session_status', sessionId: 'nope', removed: true })).toBe(prev)
    const next = reduceMeters(prev, { type: 'session_status', sessionId: 'sess-1', removed: true, totals: { costToday: 0.014, tokensPerMin: 0, dollarsPerMin: 0 } })
    expect(next.sessions).toEqual([])
    expect(next.totals?.costToday).toBe(0.014)
  })

  it('agent_status attaches subagent rows, which later session updates keep', () => {
    const prev = reduceMeters(EMPTY, { type: 'session_status', sessionId: 'sess-1', session: session() })
    expect(reduceMeters(prev, { type: 'agent_status', sessionId: 'unknown', agents: [] })).toBe(prev)
    const withAgents = reduceMeters(prev, { type: 'agent_status', sessionId: 'sess-1', agents: [{ id: 'ac5', tokens: 28170, contextSize: 1000000 }] })
    expect(withAgents.sessions[0].agents).toEqual([{ id: 'ac5', tokens: 28170, contextSize: 1000000 }])
    const later = reduceMeters(withAgents, { type: 'session_status', sessionId: 'sess-1', session: session({ cost: 0.02, updatedAt: 5000 }) })
    expect(later.sessions[0].agents).toEqual([{ id: 'ac5', tokens: 28170, contextSize: 1000000 }])
  })

  it('leaves other events alone', () => {
    const prev = reduceMeters(EMPTY, { type: 'session_status', sessionId: 'sess-1', session: session() })
    expect(reduceMeters(prev, { type: 'agent_working', status: 'reading x' })).toBe(prev)
    expect(reduceMeters(prev, { type: 'session_status' })).toBe(prev)
  })
})

describe('store', () => {
  beforeEach(() => resetMeters())

  it('dispatch updates the state and notifies subscribers once per change', () => {
    let calls = 0
    const unsubscribe = subscribeMeters(() => { calls++ })
    dispatchMeters({ type: 'session_status', sessionId: 'sess-1', session: session() })
    dispatchMeters({ type: 'chat_typing' })
    expect(calls).toBe(1)
    expect(getMeters().sessions).toHaveLength(1)
    unsubscribe()
    dispatchMeters({ type: 'session_status', sessionId: 'sess-1', removed: true })
    expect(calls).toBe(1)
    expect(getMeters().sessions).toHaveLength(0)
  })
})

describe('presentation', () => {
  it('context tone: amber above 70 %, red above 90 %', () => {
    expect(contextTone(null)).toBe('ok')
    expect(contextTone(70)).toBe('ok')
    expect(contextTone(70.1)).toBe('warn')
    expect(contextTone(90)).toBe('warn')
    expect(contextTone(90.1)).toBe('danger')
    expect(CLUTTER_THRESHOLD).toBe(85)
  })

  it('formats money and tokens compactly', () => {
    expect(formatMoney(0)).toBe('$0.00')
    expect(formatMoney(0.014055975)).toBe('$0.014')
    expect(formatMoney(0.42)).toBe('$0.42')
    expect(formatMoney(12.5)).toBe('$12.50')
    expect(formatMoney(1234)).toBe('$1,234')
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(44051)).toBe('44k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })

  it('electricity gauge: log scale to 1M tokens/min, stripes faster the more it burns', () => {
    expect(electricityLevel(0)).toBe(0)
    expect(electricityLevel(1000)).toBeCloseTo(50, 0)
    expect(electricityLevel(1_000_000)).toBeCloseTo(100, 0)
    expect(electricityLevel(1e9)).toBe(100)
    expect(electricityPeriod(0)).toBe(3)
    expect(electricityPeriod(1000)).toBeLessThan(electricityPeriod(10))
    expect(electricityPeriod(1e12)).toBe(0.4)
  })
})

