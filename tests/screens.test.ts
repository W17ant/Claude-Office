/** screens.ts - what each desk's monitors show. */
import { describe, expect, it } from 'vitest'
import { DESK_GEOMETRY, SPOT_DESK, deskScreens, previewScreenMode, screenMode } from '../src/screens'
import { ROOMS } from '../src/rooms'
import type { Agent } from '../src/types'

const MAIN_ROOM = ROOMS['main-office']

/** A worker standing at spot-2's desk, overridable */
function worker(over: Partial<Agent> = {}): Agent {
  const at = { x: 37.9, y: 68.2 }
  return {
    id: 'a1', name: 'A', type: 'subagent', role: 'frontend-developer', state: 'working',
    position: at, targetPosition: at, deskPosition: at, room: 'main', assignedRoom: 'main',
    assignedSpotId: 'spot-2', color: '#fff', emoji: '', hiredAt: 0, ...over,
  } as Agent
}

describe('screenMode', () => {
  it('a working agent at its desk scrolls code; the security auditor shows the warning sign', () => {
    expect(screenMode(worker())).toBe('code')
    expect(screenMode(worker({ role: 'security-auditor' }))).toBe('security')
  })

  it('a failed tool call, a red test run or an API error shows the bug, ahead of everything else', () => {
    expect(screenMode(worker({ lastFailed: true }))).toBe('bug')
    expect(screenMode(worker({ role: 'security-auditor', scene: { kind: 'red' } as Agent['scene'] }))).toBe('bug')
    expect(screenMode(worker({ mainState: 'error' }))).toBe('bug')
  })

  it('idle at the desk keeps the lit screens; typing counts as busy', () => {
    expect(screenMode(worker({ state: 'idle' }))).toBe('idle')
    expect(screenMode(worker({ state: 'idle' }), true)).toBe('code')
  })

  it('nobody, or someone still walking to the desk, leaves the screens off', () => {
    expect(screenMode(undefined)).toBe('off')
    expect(screenMode(worker({ state: 'walking-to-desk' }))).toBe('off')
    expect(screenMode(worker({ position: { x: 20, y: 68.2 } }))).toBe('off')
  })
})

describe('deskScreens', () => {
  it('every desk is listed, off unless someone works at it', () => {
    const modes = deskScreens([worker()])
    expect(modes['desk-2b']).toBe('code')
    expect(Object.values(modes).filter(m => m === 'off')).toHaveLength(Object.keys(SPOT_DESK).length - 1)
  })

  it('someone passing a desk does not switch off the screens of the one working at it', () => {
    const passer = worker({ id: 'b', state: 'walking-to-desk', assignedSpotId: 'spot-2' })
    expect(deskScreens([worker(), passer])['desk-2b']).toBe('code')
    expect(deskScreens([passer, worker()])['desk-2b']).toBe('code')
  })
})

describe('desk wiring', () => {
  it('each spot names a real desk of the main room, and every desk sprite has its screens measured', () => {
    const desks = new Map(MAIN_ROOM.furniture.map(f => [f.id, f]))
    for (const [spot, desk] of Object.entries(SPOT_DESK)) {
      expect(MAIN_ROOM.agentSpots.some(s => s.id === spot)).toBe(true)
      expect(DESK_GEOMETRY[desks.get(desk)!.sprite]).toBeDefined()
    }
  })

  it('?screens= previews a mode on every desk; anything else is ignored', () => {
    expect(previewScreenMode('?sim&screens=bug')).toBe('bug')
    expect(previewScreenMode('?screens=disco')).toBeNull()
    expect(previewScreenMode('')).toBeNull()
  })
})
