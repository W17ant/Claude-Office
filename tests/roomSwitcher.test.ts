/**
 * src/roomSwitcher.ts and src/placementExport.ts — the floor plan's model
 * (a dot per agent, the mark on a room that needs you, closed rooms left
 * out) and the text /?helper exports for a room.
 */

import { describe, expect, it } from 'vitest'
import { switcherModel, planOrder, viewableRoom, planRoomLabel, MAX_DOTS, type PlanRoom } from '../src/roomSwitcher'
import { exportRoomLayout, doorTargets, doorTargetLabel, helperRoom, SPOT_PREFIX, type PlacedItem } from '../src/placementExport'
import { ROOMS, ROOM_IDS, HUB_ROOM, OFFICE_ROOM, type RoomId } from '../src/rooms'
import { openRoomSet } from '../src/roomAccess'
import { createAgent } from '../src/agentManager'
import { mainId } from '../src/mainState'
import type { Agent } from '../src/types'

const ALL = openRoomSet([], true)
const OFFICE_ONLY = openRoomSet([OFFICE_ROOM])

/** An agent somewhere in the building */
function someone(id: string, room: RoomId = OFFICE_ROOM, over: Partial<Agent> = {}): Agent {
  const a = createAgent({ id, name: id, role: 'debugger', spot: ROOMS[OFFICE_ROOM].agentSpots[2], hiredAt: 1 })
  return { ...a, state: 'working', room, ...over }
}

const box = (model: PlanRoom[], id: RoomId) => model.find(r => r.id === id)!

// ---------------------------------------------------------------------------
// The floor plan
// ---------------------------------------------------------------------------

describe('the floor plan model', () => {
  it('is empty while the office is the only open room: no switcher at all', () => {
    expect(switcherModel([someone('a')], { open: OFFICE_ONLY, view: OFFICE_ROOM })).toEqual([])
  })

  it('lists the open rooms as their doors stand along the corridor, the corridor last', () => {
    expect(planOrder()).toEqual(['main-office', 'meeting-room', 'server-room', 'lunch-room'])
    const model = switcherModel([], { open: ALL, view: OFFICE_ROOM })
    expect(model.map(r => r.id)).toEqual(['main-office', 'meeting-room', 'server-room', 'lunch-room', 'corridor'])
    expect(model.map(r => r.place)).toEqual(['room', 'room', 'room', 'room', 'hub'])
    expect(model.map(r => r.short)).toEqual(['Office', 'Meeting', 'Server', 'Lunch', 'Corridor'])
  })

  it('leaves a closed room out', () => {
    const open = openRoomSet([OFFICE_ROOM, HUB_ROOM, 'server-room'])
    const model = switcherModel([someone('a', 'server-room')], { open, view: OFFICE_ROOM })
    expect(model.map(r => r.id)).toEqual(['main-office', 'server-room', 'corridor'])
  })

  it('puts a dot per agent in the room it is in, in its own colour', () => {
    const agents = [
      someone('a'), someone('b', OFFICE_ROOM, { color: '#123456' }),
      someone('c', 'meeting-room'), someone('d', 'corridor'),
      // Made before rooms existed: no room means the office
      someone('e', undefined as unknown as RoomId),
    ]
    const model = switcherModel(agents, { open: ALL, view: OFFICE_ROOM })
    expect(box(model, 'main-office').dots.map(d => d.id)).toEqual(['a', 'b', 'e'])
    expect(box(model, 'main-office').dots[1]).toEqual({ id: 'b', color: '#123456' })
    expect(box(model, 'meeting-room').count).toBe(1)
    expect(box(model, 'corridor').dots.map(d => d.id)).toEqual(['d'])
    expect(box(model, 'server-room')).toMatchObject({ dots: [], count: 0, more: 0, mark: null })
  })

  it(`draws at most ${MAX_DOTS} dots and counts the rest`, () => {
    const crowd = Array.from({ length: MAX_DOTS + 3 }, (_, i) => someone(`a${i}`))
    const office = box(switcherModel(crowd, { open: ALL, view: OFFICE_ROOM }), 'main-office')
    expect(office.dots).toHaveLength(MAX_DOTS)
    expect(office.more).toBe(3)
    expect(office.count).toBe(MAX_DOTS + 3)
  })

  it('highlights the room in view, and only that one', () => {
    const model = switcherModel([], { open: ALL, view: 'server-room' })
    expect(model.filter(r => r.current).map(r => r.id)).toEqual(['server-room'])
  })

  it("marks the room where a session's Claude waits on you: a hard needs-you, wherever that Claude sits", () => {
    const claude = someone(mainId('s1'), 'meeting-room', {
      sessionId: 's1', mainState: 'needs-you', needsYou: { kind: 'permission', toolName: 'Bash', summary: 'rm -rf dist', since: 1 },
    })
    const model = switcherModel([claude, someone('w', OFFICE_ROOM, { sessionId: 's1' })], { open: ALL, view: OFFICE_ROOM })
    expect(box(model, 'meeting-room').mark).toBe('needs-you')
    expect(box(model, 'main-office').mark).toBeNull()
  })

  it("a pending permission card marks the room its session's Claude is in; with no Claude seated, the office", () => {
    const claude = someone(mainId('s1'), 'lunch-room', { sessionId: 's1', mainState: 'working' })
    const seated = switcherModel([claude], { open: ALL, view: OFFICE_ROOM, pendingSessionIds: ['s1'] })
    expect(box(seated, 'lunch-room').mark).toBe('needs-you')
    expect(box(seated, 'main-office').mark).toBeNull()

    const stray = switcherModel([], { open: ALL, view: 'server-room', pendingSessionIds: ['s9'] })
    expect(box(stray, 'main-office').mark).toBe('needs-you')

    // Nothing pending: no mark
    expect(switcherModel([claude], { open: ALL, view: OFFICE_ROOM, pendingSessionIds: [] }).every(r => r.mark === null)).toBe(true)
  })

  it('marks trouble where something went wrong: an errored Claude, a failed step, a red scene, an incident in the office', () => {
    const errored = switcherModel([someone(mainId('s1'), 'meeting-room', { sessionId: 's1', mainState: 'error' })], { open: ALL, view: OFFICE_ROOM })
    expect(box(errored, 'meeting-room').mark).toBe('trouble')

    const failed = switcherModel([someone('w', 'server-room', { lastFailed: true })], { open: ALL, view: OFFICE_ROOM })
    expect(box(failed, 'server-room').mark).toBe('trouble')

    const red = switcherModel([someone('w', OFFICE_ROOM, { scene: { kind: 'red', until: 9 } as Agent['scene'] })], { open: ALL, view: OFFICE_ROOM })
    expect(box(red, 'main-office').mark).toBe('trouble')

    const incident = switcherModel([], { open: ALL, view: 'lunch-room', officeIncident: true })
    expect(box(incident, 'main-office').mark).toBe('trouble')
    expect(incident.filter(r => r.mark).map(r => r.id)).toEqual(['main-office'])
  })

  it('needs-you wins over trouble in the same room, and a leaver marks nothing', () => {
    const both = switcherModel([
      someone('w', OFFICE_ROOM, { lastFailed: true }),
      someone(mainId('s1'), OFFICE_ROOM, { sessionId: 's1', mainState: 'needs-you', needsYou: { kind: 'permission', summary: 'x', since: 1 } }),
    ], { open: ALL, view: OFFICE_ROOM })
    expect(box(both, 'main-office').mark).toBe('needs-you')

    const leaving = switcherModel([someone('w', 'corridor', { state: 'completed', lastFailed: true })], { open: ALL, view: OFFICE_ROOM })
    expect(box(leaving, 'corridor').mark).toBeNull()
    expect(box(leaving, 'corridor').count).toBe(1)   // still a dot until it is out of the door
  })

  it('viewableRoom keeps the picked room while it is open and falls back to the office when it is not', () => {
    expect(viewableRoom('server-room', ALL)).toBe('server-room')
    expect(viewableRoom('server-room', OFFICE_ONLY)).toBe(OFFICE_ROOM)
    expect(viewableRoom(OFFICE_ROOM, OFFICE_ONLY)).toBe(OFFICE_ROOM)
  })

  it('reads each room out for a screen reader: name, how many, the mark, whether it is in view', () => {
    const model = switcherModel([
      someone('a', 'meeting-room'), someone('b', 'meeting-room'),
      someone(mainId('s1'), 'meeting-room', { sessionId: 's1', mainState: 'needs-you', needsYou: { kind: 'permission', summary: 'x', since: 1 } }),
      someone('c', 'server-room', { lastFailed: true }),
    ], { open: ALL, view: 'meeting-room' })
    expect(planRoomLabel(box(model, 'meeting-room'))).toBe('Meeting Room, 3 people, needs you, in view')
    expect(planRoomLabel(box(model, 'server-room'))).toBe('Server Room, 1 person, something went wrong')
    expect(planRoomLabel(box(model, 'lunch-room'))).toBe('Lunch Room, empty')
  })
})

// ---------------------------------------------------------------------------
// /?helper's export
// ---------------------------------------------------------------------------

describe('the placement helper export', () => {
  const door = (x: number, y: number, over: Partial<PlacedItem> = {}): PlacedItem => ({ id: `door-${x}`, mode: 'door', x, y, ...over })
  const spotAt = (x: number, y: number, spotType: PlacedItem['spotType']): PlacedItem => ({ id: `spot-${x}`, mode: 'spot', spotType, x, y })

  it('nothing placed: nothing to paste', () => {
    expect(exportRoomLayout('server-room', [])).toBe('')
  })

  it("a door in any room but the corridor leads to the corridor, never 'TODO'", () => {
    for (const id of ROOM_IDS.filter(r => r !== HUB_ROOM)) {
      const out = exportRoomLayout(id, [door(18, 50)])
      expect(out).toContain("{ toRoom: 'corridor', position: { x: 18, y: 50 }, label: 'Corridor' },")
      expect(out).not.toContain('TODO')
      expect(doorTargets(id)).toEqual([HUB_ROOM])
    }
    // Even when a stale choice from the corridor is still on the item
    expect(exportRoomLayout('lunch-room', [door(18, 50, { doorTarget: 'server-room' })])).toContain("toRoom: 'corridor'")
  })

  it('in the corridor each door says which room it opens onto; the front door and the manager door are landmarks', () => {
    expect(doorTargets(HUB_ROOM)).toEqual(['main-office', 'meeting-room', 'server-room', 'lunch-room', 'front-door', 'decor-door'])
    const out = exportRoomLayout(HUB_ROOM, [
      door(22, 50, { doorTarget: 'main-office' }),
      door(70, 50, { doorTarget: 'server-room' }),
      door(6, 60, { doorTarget: 'front-door' }),
      door(55, 50, { doorTarget: 'decor-door' }),
    ])
    expect(out).toContain("{ toRoom: 'main-office', position: { x: 22, y: 50 }, label: 'Main Office' },")
    expect(out).toContain("{ toRoom: 'server-room', position: { x: 70, y: 50 }, label: 'Server Room' },")
    expect(out).toContain("{ id: 'front-door', kind: 'front-door', label: 'Front door / lift', x: 6, y: 60 },")
    expect(out).toContain("{ id: 'manager-door', kind: 'decor-door', label: 'Manager', x: 55, y: 50 },")
    // Landmarks are not ways into a room
    expect(out.match(/toRoom:/g)).toHaveLength(2)
    expect(doorTargetLabel('decor-door')).toBe('Manager')
    expect(doorTargetLabel('lunch-room')).toBe('Lunch Room')
  })

  it("spot ids carry the room's prefix so they stay unique across the building; the office keeps spot-N", () => {
    const spots = [spotAt(34, 60, 'standing'), spotAt(44, 60, 'standing')]
    const server = exportRoomLayout('server-room', spots)
    expect(server).toContain("{ id: 'srv-1', type: 'standing', x: 34, y: 60, facing: 'down', spriteFacing: 'front-right' },")
    expect(server).toContain("id: 'srv-2'")
    expect(exportRoomLayout('meeting-room', spots)).toContain("id: 'meet-1'")
    expect(exportRoomLayout(OFFICE_ROOM, spots)).toContain("id: 'spot-1'")
    expect(new Set(Object.values(SPOT_PREFIX)).size).toBe(ROOM_IDS.length)
    // The prefixes are the ones the provisional layouts already use
    for (const id of ['meeting-room', 'server-room'] as RoomId[]) {
      for (const s of ROOMS[id].agentSpots) expect(s.id.startsWith(`${SPOT_PREFIX[id]}-`)).toBe(true)
    }
  })

  it('says whose block it is, and reminds to drop `provisional` for a room placed over new art', () => {
    const server = exportRoomLayout('server-room', [door(18, 50)])
    expect(server.split('\n')[0]).toBe("    // ROOMS['server-room'] in src/rooms.ts (placed over its art: also delete `provisional: true`)")
    expect(exportRoomLayout(OFFICE_ROOM, [door(74, 44)]).split('\n')[0]).toBe("    // ROOMS['main-office'] in src/rooms.ts")
  })

  it('emits the entry point, the floor (three corners or more) and the waypoints as before', () => {
    const out = exportRoomLayout('lunch-room', [
      { id: 'entry-1', mode: 'entry', x: 18, y: 50 },
      { id: 'floor-1', mode: 'floor', x: 8, y: 50 }, { id: 'floor-2', mode: 'floor', x: 92, y: 50 }, { id: 'floor-3', mode: 'floor', x: 92, y: 88 },
    ], [{ id: 'W-a', x: 18, y: 50, connections: ['W-b'] }, { id: 'W-b', x: 50, y: 56, connections: ['W-a'] }])
    expect(out).toContain('    entryPoint: { x: 18, y: 50 },')
    expect(out).toContain('    walkableArea: [\n      { x: 8, y: 50 },\n      { x: 92, y: 50 },\n      { x: 92, y: 88 },\n    ],')
    expect(out).toContain("      { id: 'W-a',               x: 18, y: 50, connections: ['W-b'] },")
    // Two corners are not a floor
    expect(exportRoomLayout('lunch-room', [{ id: 'f1', mode: 'floor', x: 1, y: 1 }, { id: 'f2', mode: 'floor', x: 2, y: 2 }])).toBe('')
  })

  it('opens on the room named by ?room=, and on the office for anything else', () => {
    expect(helperRoom('?helper&room=server-room')).toBe('server-room')
    expect(helperRoom('?helper&room=corridor')).toBe('corridor')
    expect(helperRoom('?helper')).toBe(OFFICE_ROOM)
    expect(helperRoom('?helper&room=rooftop')).toBe(OFFICE_ROOM)
    expect(helperRoom('?helper&room=toString')).toBe(OFFICE_ROOM)
  })
})
