/** roomLife.ts - what the room's props do, from what the office is doing. */
import { describe, expect, it } from 'vitest'
import { filingOpen, printJob, tvMode, waterBusy } from '../src/roomLife'
import type { Agent } from '../src/types'

const NOW = 1_000_000_000
function agent(over: Partial<Agent> = {}): Agent {
  const at = { x: 30, y: 60 }
  return { id: 'a', name: 'A', type: 'subagent', role: 'x', state: 'working', position: at, targetPosition: at, deskPosition: at,
    room: 'main', assignedRoom: 'main', color: '', emoji: '', hiredAt: 0, ...over } as Agent
}

describe('tvMode', () => {
  it('a status dashboard when nothing is shipping', () => {
    expect(tvMode([agent()], null, NOW)).toBe('dashboard')
  })

  it('DEPLOYING while a deploy is out, by scene or by the last signal (for up to 10 minutes)', () => {
    expect(tvMode([agent({ scene: { kind: 'shipping', until: NOW + 1 } })], null, NOW)).toBe('deploying')
    expect(tvMode([], { kind: 'deploy_start', at: NOW - 60_000 }, NOW)).toBe('deploying')
    expect(tvMode([], { kind: 'deploy_start', at: NOW - 11 * 60_000 }, NOW)).toBe('dashboard')
  })

  it('SHIPPED or ROLLBACK for a minute after the deploy reports back, then the dashboard again', () => {
    expect(tvMode([], { kind: 'deploy_success', at: NOW - 5_000 }, NOW)).toBe('shipped')
    expect(tvMode([], { kind: 'deploy_fail', at: NOW - 5_000 }, NOW)).toBe('failed')
    expect(tvMode([], { kind: 'deploy_fail', at: NOW - 61_000 }, NOW)).toBe('dashboard')
    // A result beats another deploy still marked shipping
    expect(tvMode([agent({ scene: { kind: 'shipping', until: NOW + 1 } })], { kind: 'deploy_fail', at: NOW }, NOW)).toBe('failed')
  })
})

describe('printJob', () => {
  it('prints a green page for a passing build, test run or deploy, a red one for a failing one', () => {
    expect(printJob({ kind: 'test_ok', at: 5 })).toEqual({ ok: true, at: 5 })
    expect(printJob({ kind: 'build_failed', at: 6 })).toEqual({ ok: false, at: 6 })
    expect(printJob({ kind: 'deploy_success', at: 7 })).toEqual({ ok: true, at: 7 })
  })

  it('nothing for a run that has only started, a push, or no signal', () => {
    expect(printJob({ kind: 'test_start', at: 5 })).toBeNull()
    expect(printJob({ kind: 'push', at: 5 })).toBeNull()
    expect(printJob(null)).toBeNull()
  })
})

describe('waterBusy and filingOpen', () => {
  it('the cooler bubbles while someone stands at it or a Claude waits on its workers', () => {
    const spots = [{ x: 53, y: 45 }]
    expect(waterBusy([agent()], spots)).toBe(false)
    expect(waterBusy([agent({ position: { x: 53.5, y: 45.5 } })], spots)).toBe(true)
    expect(waterBusy([agent({ mainState: 'waiting' })], spots)).toBe(true)
  })

  it('the filing cabinet opens while an agent at work reads or searches files', () => {
    expect(filingOpen([agent({ statusText: 'reading App.tsx' })])).toBe(true)
    expect(filingOpen([agent({ statusText: "searching for 'TODO'" })])).toBe(true)
    expect(filingOpen([agent({ statusText: 'finding files: **/*.ts' })])).toBe(true)
    expect(filingOpen([agent({ statusText: 'editing App.tsx' })])).toBe(false)
    expect(filingOpen([agent({ state: 'idle', statusText: 'reading App.tsx' })])).toBe(false)
  })
})
