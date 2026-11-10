/** screens.ts - what each desk's monitors show. */
import { describe, expect, it } from 'vitest'
import { DESK_GEOMETRY, SPOT_DESK, deskScreens, previewScreens, roleScreens, screenMode } from '../src/screens'
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
  it('a busy worker has its role\'s two screens up: the frontend dev code and the page, the auditor the warning sign', () => {
    expect(screenMode(worker())).toEqual(['code', 'web'])
    expect(screenMode(worker({ role: 'security-auditor' }))).toEqual(['terminal', 'security'])
    expect(screenMode(worker({ role: 'test-engineer' }))).toEqual(['code', 'tests'])
  })

  it('a failed tool call, a red test run or an API error shows the bug on both, ahead of everything else', () => {
    expect(screenMode(worker({ lastFailed: true }))).toEqual(['bug', 'bug'])
    expect(screenMode(worker({ role: 'security-auditor', scene: { kind: 'red' } as Agent['scene'] }))).toEqual(['bug', 'bug'])
    expect(screenMode(worker({ mainState: 'error' }))).toEqual(['bug', 'bug'])
  })

  it('idle at the desk keeps the lit screens; typing counts as busy', () => {
    expect(screenMode(worker({ state: 'idle' }))).toEqual(['idle', 'idle'])
    expect(screenMode(worker({ state: 'idle' }), true)).toEqual(['code', 'web'])
  })

  it('nobody, or someone still walking to the desk, leaves the screens off', () => {
    expect(screenMode(undefined)).toEqual(['off', 'off'])
    expect(screenMode(worker({ state: 'walking-to-desk' }))).toEqual(['off', 'off'])
    expect(screenMode(worker({ position: { x: 20, y: 68.2 } }))).toEqual(['off', 'off'])
  })
})

describe('roleScreens', () => {
  it('a custom subagent type or another MCP server is matched by name, else code and a terminal', () => {
    expect(roleScreens('qa-tester')).toEqual(['code', 'tests'])
    expect(roleScreens('vercel')).toEqual(['terminal', 'pipeline'])
    expect(roleScreens('postgres-tuner')).toEqual(['data', 'terminal'])
    expect(roleScreens('something-else')).toEqual(['code', 'terminal'])
  })
})

describe('deskScreens', () => {
  it('every desk is listed, off unless someone works at it', () => {
    const modes = deskScreens([worker()])
    expect(modes['desk-2b']).toEqual(['code', 'web'])
    expect(Object.values(modes).filter(m => m[0] === 'off')).toHaveLength(Object.keys(SPOT_DESK).length - 1)
  })

  it('someone passing a desk does not switch off the screens of the one working at it', () => {
    const passer = worker({ id: 'b', state: 'walking-to-desk', assignedSpotId: 'spot-2' })
    expect(deskScreens([worker(), passer])['desk-2b']).toEqual(['code', 'web'])
    expect(deskScreens([passer, worker()])['desk-2b']).toEqual(['code', 'web'])
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

  it('?screens= previews a screen on every desk, ?screens=all a different pair on each; anything else is ignored', () => {
    const desks = [{ id: 'rear', front: false }, { id: 'd1', front: true }, { id: 'd2', front: true }]
    expect(previewScreens(desks, '?sim&screens=web')).toEqual({ rear: ['web', 'web'], d1: ['web', 'web'], d2: ['web', 'web'] })
    const all = previewScreens(desks, '?screens=all')!
    expect(all.d1).toEqual(['bug', 'bug']) // the first desk facing us
    expect(all.d2).toEqual(['code', 'terminal'])
    expect(all.rear).toEqual(['web', 'tests'])
    expect(previewScreens(desks, '?screens=disco')).toBeNull()
    expect(previewScreens(desks, '')).toBeNull()
  })
})
