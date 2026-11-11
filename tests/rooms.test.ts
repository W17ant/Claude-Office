/**
 * src/rooms.ts, src/roomAccess.ts and src/roomRules.ts — the building's shape
 * (five places in a star round the corridor), which rooms are open, and the
 * rules that say which room an agent belongs in.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ROOMS, ROOM_IDS, HUB_ROOM, OFFICE_ROOM, findRoomPath, getConnectedRooms, doorTo, getFreeSpot, findSpot, type RoomId,
} from '../src/rooms'
import { DRAWN_ROOMS, openRoomSet, previewAllRooms, roomArt, roomArtFiles } from '../src/roomAccess'
import {
  wantedRoom, isTeam, dwellMs, MEETING_MIN_WORKERS, MEETING_STAY_WORKERS, LUNCH_IDLE_MS, DWELL_MS,
  MEETING_ROOM, SERVER_ROOM, LUNCH_ROOM, type RoomFacts,
} from '../src/roomRules'
import { findWaypointPath } from '../src/agentManager'

const SIDE_ROOMS: RoomId[] = ['meeting-room', 'server-room', 'lunch-room']
const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))

// ---------------------------------------------------------------------------
// The star
// ---------------------------------------------------------------------------

describe('the building: five places in a star', () => {
  it('is the office, the corridor and three rooms, and nothing else', () => {
    expect([...ROOM_IDS].sort()).toEqual(['corridor', 'lunch-room', 'main-office', 'meeting-room', 'server-room'])
    for (const id of ROOM_IDS) expect(ROOMS[id].id).toBe(id)
  })

  it('every room but the corridor has exactly one door, onto the corridor; the corridor has one back to each', () => {
    for (const id of ROOM_IDS.filter(r => r !== HUB_ROOM)) {
      expect(getConnectedRooms(id)).toEqual([HUB_ROOM])
      expect(doorTo(id, HUB_ROOM)).not.toBeNull()
      expect(doorTo(HUB_ROOM, id)).not.toBeNull()
    }
    expect([...getConnectedRooms(HUB_ROOM)].sort()).toEqual(['lunch-room', 'main-office', 'meeting-room', 'server-room'])
  })

  it('findRoomPath goes through the corridor between any two rooms, and one step to or from it', () => {
    expect(findRoomPath('main-office', 'server-room')).toEqual(['main-office', 'corridor', 'server-room'])
    expect(findRoomPath('lunch-room', 'meeting-room')).toEqual(['lunch-room', 'corridor', 'meeting-room'])
    expect(findRoomPath('server-room', 'main-office')).toEqual(['server-room', 'corridor', 'main-office'])
    expect(findRoomPath('main-office', 'corridor')).toEqual(['main-office', 'corridor'])
    expect(findRoomPath('corridor', 'lunch-room')).toEqual(['corridor', 'lunch-room'])
    expect(findRoomPath('meeting-room', 'meeting-room')).toEqual(['meeting-room'])
    // Every pair of distinct non-corridor rooms is exactly two doors apart
    const rooms = ROOM_IDS.filter(r => r !== HUB_ROOM)
    for (const a of rooms) for (const b of rooms) if (a !== b) expect(findRoomPath(a, b)).toEqual([a, HUB_ROOM, b])
  })

  it('the corridor has the front door and the manager nameplate door as landmarks, and neither is a way anywhere', () => {
    const marks = ROOMS[HUB_ROOM].landmarks ?? []
    expect(marks.map(m => m.kind).sort()).toEqual(['decor-door', 'front-door'])
    const front = marks.find(m => m.kind === 'front-door')!
    expect({ x: front.x, y: front.y }).toEqual(ROOMS[HUB_ROOM].entryPoint)
    // No room behind the manager's door: nothing in the building is called that
    expect(ROOM_IDS.some(id => /manager|ceo/.test(id))).toBe(false)
    // Nobody is stationed in the corridor
    expect(ROOMS[HUB_ROOM].agentSpots).toEqual([])
  })

  it('spot ids are unique across the building, so findSpot needs only the id', () => {
    const ids = ROOM_IDS.flatMap(id => ROOMS[id].agentSpots.map(s => s.id))
    expect(new Set(ids).size).toBe(ids.length)
    expect(findSpot('srv-3')).toEqual({ room: 'server-room', spot: ROOMS['server-room'].agentSpots[2] })
    expect(findSpot('spot-1')?.room).toBe('main-office')
    expect(findSpot('nope')).toBeNull()
    expect(findSpot(undefined)).toBeNull()
  })

  it('getFreeSpot hands out a room\'s spots in order, by kind, and null when it is full', () => {
    expect(getFreeSpot('server-room', new Set(), 'standing')!.id).toBe('srv-1')
    expect(getFreeSpot('server-room', new Set(['srv-1', 'srv-2']), 'standing')!.id).toBe('srv-3')
    expect(getFreeSpot('lunch-room', new Set(), 'coffee')!.id).toBe('lunch-coffee')
    expect(getFreeSpot('lunch-room', new Set(['lunch-coffee']), 'coffee')).toBeNull()
    expect(getFreeSpot('meeting-room', new Set(ROOMS['meeting-room'].agentSpots.map(s => s.id)), 'meeting-seat')).toBeNull()
  })
})

describe('the new rooms\' layouts are sound', () => {
  const inside = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
    const xs = poly.map(q => q.x)
    const ys = poly.map(q => q.y)
    return p.x >= Math.min(...xs) && p.x <= Math.max(...xs) && p.y >= Math.min(...ys) && p.y <= Math.max(...ys)
  }

  it('no room is provisional: every layout was placed on its drawn art', () => {
    for (const id of ROOM_IDS) expect(ROOMS[id].provisional, id).toBeFalsy()
  })

  it('every door, spot, landmark and waypoint of a new room stands on its floor (the walkable rectangle)', () => {
    for (const id of [HUB_ROOM, ...SIDE_ROOMS]) {
      const room = ROOMS[id]
      const floor = room.walkableArea!
      expect(floor.length).toBeGreaterThanOrEqual(3)
      for (const c of room.connections) expect(inside(c.position, floor), `${id} door to ${c.toRoom}`).toBe(true)
      for (const s of room.agentSpots) expect(inside(s, floor), `${id} ${s.id}`).toBe(true)
      for (const l of room.landmarks ?? []) expect(inside(l, floor), `${id} ${l.id}`).toBe(true)
      for (const w of room.waypoints ?? []) expect(inside(w, floor), `${id} ${w.id}`).toBe(true)
      expect(inside(room.entryPoint, floor), `${id} entry`).toBe(true)
    }
  })

  it("the new rooms' waypoint graphs are symmetric and name only their own waypoints", () => {
    // The office's hand-placed graph has a few one-way links and is left as it is
    for (const id of [HUB_ROOM, ...SIDE_ROOMS]) {
      const wps = ROOMS[id].waypoints ?? []
      const byId = new Map(wps.map(w => [w.id, w]))
      expect(byId.size).toBe(wps.length)
      for (const w of wps) for (const c of w.connections) {
        expect(byId.has(c), `${id} ${w.id} -> ${c}`).toBe(true)
        expect(byId.get(c)!.connections, `${id} ${c} -> ${w.id}`).toContain(w.id)
      }
    }
  })

  it('a side room has room for what it is for: 8 meeting seats, 6 racks, a coffee and a water place and 8 lunch seats', () => {
    const kinds = (id: RoomId) => ROOMS[id].agentSpots.map(s => s.type)
    expect(kinds('meeting-room')).toEqual(Array(8).fill('meeting-seat'))
    expect(kinds('server-room')).toEqual(Array(6).fill('standing'))
    expect(kinds('lunch-room').sort()).toEqual(['coffee', ...Array(8).fill('lounge'), 'water'])
  })

  it('a waypoint stands at every door of a new room, and every waypoint is reachable from it', () => {
    for (const id of [HUB_ROOM, ...SIDE_ROOMS]) {
      const room = ROOMS[id]
      const wps = room.waypoints ?? []
      const byId = new Map(wps.map(w => [w.id, w]))
      for (const c of room.connections) {
        expect(wps.some(w => w.x === c.position.x && w.y === c.position.y), `${id} door to ${c.toRoom}`).toBe(true)
      }
      const seen = new Set([wps[0].id])
      const queue = [wps[0].id]
      while (queue.length) for (const next of byId.get(queue.shift()!)!.connections) {
        if (!seen.has(next)) { seen.add(next); queue.push(next) }
      }
      expect(seen.size, id).toBe(wps.length)
    }
  })

  it('a walk from the door to any spot of a side room stays on the floor', () => {
    // Why a margin: findWaypointPath nudges each waypoint by up to 1.5 so
    // walkers do not all tread the same line, and the door stands on the
    // floor's edge
    const JITTER = 1.5
    for (const id of SIDE_ROOMS) {
      const room = ROOMS[id]
      const door = doorTo(id, HUB_ROOM)!
      const floor = room.walkableArea!
      const grown = [
        { x: Math.min(...floor.map(p => p.x)) - JITTER, y: Math.min(...floor.map(p => p.y)) - JITTER },
        { x: Math.max(...floor.map(p => p.x)) + JITTER, y: Math.max(...floor.map(p => p.y)) + JITTER },
      ]
      for (const s of room.agentSpots) {
        const path = findWaypointPath(door.x, door.y, s.x, s.y, room.waypoints ?? [])
        expect(path.length).toBeGreaterThan(0)
        for (const p of path) expect(inside(p, grown), `${id} ${s.id}`).toBe(true)
      }
    }
  })

  it("the corridor's doors stand as drawn: lift and meeting room on the left wall, then manager, server room, lunch room and office along the right", () => {
    const xs = (id: RoomId) => doorTo(HUB_ROOM, id)!.x
    const lift = ROOMS[HUB_ROOM].landmarks!.find(l => l.kind === 'front-door')!
    const manager = ROOMS[HUB_ROOM].landmarks!.find(l => l.kind === 'decor-door')!
    expect(lift.x).toBeLessThan(xs('meeting-room'))
    expect(xs('meeting-room')).toBeLessThan(manager.x)
    expect(manager.x).toBeLessThan(xs('server-room'))
    expect(xs('server-room')).toBeLessThan(xs('lunch-room'))
    expect(xs('lunch-room')).toBeLessThan(xs('main-office'))
  })
})

// ---------------------------------------------------------------------------
// Open and closed
// ---------------------------------------------------------------------------

describe('a room is closed until its art is drawn (src/roomAccess.ts)', () => {
  it('only rooms whose files are really in public/ are listed as drawn', () => {
    expect(DRAWN_ROOMS).toContain(OFFICE_ROOM)
    for (const id of DRAWN_ROOMS) {
      for (const file of roomArtFiles(id)) expect(existsSync(PUBLIC + file), `${id}: ${file}`).toBe(true)
    }
  })

  it('with nothing but the office drawn, the office is the only open room', () => {
    expect([...openRoomSet([OFFICE_ROOM])]).toEqual([OFFICE_ROOM])
    expect([...openRoomSet([])]).toEqual([OFFICE_ROOM])
  })

  it('a side room drawn before the corridor stays closed: there is no way to reach it', () => {
    expect([...openRoomSet([OFFICE_ROOM, 'server-room', 'lunch-room'])]).toEqual([OFFICE_ROOM])
  })

  it('the corridor opens the rooms that are drawn, and only those', () => {
    expect([...openRoomSet([OFFICE_ROOM, HUB_ROOM])].sort()).toEqual(['corridor', 'main-office'])
    expect([...openRoomSet([OFFICE_ROOM, HUB_ROOM, 'server-room'])].sort()).toEqual(['corridor', 'main-office', 'server-room'])
  })

  it('?rooms=all opens every room whatever is drawn; any other value does not', () => {
    expect(previewAllRooms('?rooms=all')).toBe(true)
    expect(previewAllRooms('?sim&rooms=all&theme=office')).toBe(true)
    expect(previewAllRooms('?sim')).toBe(false)
    expect(previewAllRooms('?rooms=none')).toBe(false)
    expect(previewAllRooms('')).toBe(false)
    expect([...openRoomSet([OFFICE_ROOM], true)].sort()).toEqual([...ROOM_IDS].sort())
  })

  it("a room's art is named after it (day and night, plus a Dunder Mifflin pair when it has one); the office's live in the theme", () => {
    for (const id of [HUB_ROOM, ...SIDE_ROOMS]) {
      const dm = ROOMS[id].backgroundDm ? [`/rooms/${id}-day-dm.webp`, `/rooms/${id}-night-dm.webp`] : []
      expect(roomArtFiles(id)).toEqual([`/rooms/${id}-day.webp`, `/rooms/${id}-night.webp`, ...dm])
    }
    expect(roomArtFiles(OFFICE_ROOM)).toEqual([])
  })

  it('roomArt gives the theme\'s two pictures for a drawn room and null (draw the placeholder) otherwise', () => {
    expect(roomArt('server-room', 'default', [OFFICE_ROOM])).toBeNull()
    expect(roomArt('server-room', 'default', [OFFICE_ROOM, 'server-room'])).toEqual({ day: '/rooms/server-room-day.webp', night: '/rooms/server-room-night.webp' })
    // Dunder Mifflin: the room's own pair when it has one, else its default pictures
    expect(roomArt('server-room', 'office', [OFFICE_ROOM, 'server-room'])).toEqual(ROOMS['server-room'].backgroundDm ?? ROOMS['server-room'].background)
    expect(roomArt(OFFICE_ROOM, 'default', [OFFICE_ROOM])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe('which room an agent belongs in (src/roomRules.ts)', () => {
  const ALL = new Set<RoomId>(ROOM_IDS)
  const facts = (over: Partial<RoomFacts> = {}): RoomFacts =>
    ({ home: OFFICE_ROOM, current: OFFICE_ROOM, pinned: false, teamSize: 0, sessionNeedsYou: false, idleForMs: null, ...over })

  it('with nothing going on, home', () => {
    expect(wantedRoom(facts(), ALL)).toEqual({ room: OFFICE_ROOM, reason: 'home' })
    expect(wantedRoom(facts({ teamSize: 1 }), ALL).room).toBe(OFFICE_ROOM)
  })

  it('a session waiting on you meets', () => {
    expect(wantedRoom(facts({ sessionNeedsYou: true }), ALL)).toEqual({ room: MEETING_ROOM, reason: 'needs-you' })
  })

  it(`a session running ${MEETING_MIN_WORKERS} workers at once meets; ${MEETING_MIN_WORKERS - 1} do not`, () => {
    expect(wantedRoom(facts({ teamSize: MEETING_MIN_WORKERS }), ALL)).toEqual({ room: MEETING_ROOM, reason: 'team' })
    expect(wantedRoom(facts({ teamSize: MEETING_MIN_WORKERS - 1 }), ALL).room).toBe(OFFICE_ROOM)
  })

  it('no ping-pong: a team already in the meeting room stays down to the lower threshold, then goes home', () => {
    expect(MEETING_STAY_WORKERS).toBeLessThan(MEETING_MIN_WORKERS)
    expect(isTeam(MEETING_STAY_WORKERS, false)).toBe(false)
    expect(isTeam(MEETING_STAY_WORKERS, true)).toBe(true)
    const inMeeting = { current: MEETING_ROOM }
    expect(wantedRoom(facts({ ...inMeeting, teamSize: MEETING_STAY_WORKERS }), ALL).room).toBe(MEETING_ROOM)
    expect(wantedRoom(facts({ ...inMeeting, teamSize: MEETING_STAY_WORKERS - 1 }), ALL)).toEqual({ room: OFFICE_ROOM, reason: 'home' })
  })

  it('idle for the lunch threshold: the lunch room; a moment less, or not idle: home', () => {
    expect(wantedRoom(facts({ idleForMs: LUNCH_IDLE_MS }), ALL)).toEqual({ room: LUNCH_ROOM, reason: 'idle' })
    expect(wantedRoom(facts({ idleForMs: LUNCH_IDLE_MS - 1 }), ALL).room).toBe(OFFICE_ROOM)
    expect(wantedRoom(facts({ idleForMs: null }), ALL).room).toBe(OFFICE_ROOM)
  })

  it('waiting on you beats a team, and both beat lunch', () => {
    expect(wantedRoom(facts({ sessionNeedsYou: true, teamSize: 5, idleForMs: LUNCH_IDLE_MS * 2 }), ALL).reason).toBe('needs-you')
    expect(wantedRoom(facts({ teamSize: 5, idleForMs: LUNCH_IDLE_MS * 2 }), ALL).reason).toBe('team')
  })

  it('pinned staff (the boss, a server worker at its rack) never want anywhere but home', () => {
    expect(wantedRoom(facts({ pinned: true, sessionNeedsYou: true, teamSize: 9, idleForMs: LUNCH_IDLE_MS * 9 }), ALL)).toEqual({ room: OFFICE_ROOM, reason: 'home' })
    expect(wantedRoom(facts({ pinned: true, home: SERVER_ROOM, current: SERVER_ROOM, idleForMs: LUNCH_IDLE_MS * 9 }), ALL).room).toBe(SERVER_ROOM)
  })

  it('a closed room is never wanted: with only the office open the answer is always home', () => {
    const everything = facts({ sessionNeedsYou: true, teamSize: 9, idleForMs: LUNCH_IDLE_MS * 9 })
    expect(wantedRoom(everything, new Set<RoomId>([OFFICE_ROOM]))).toEqual({ room: OFFICE_ROOM, reason: 'home' })
    // Meeting room closed, lunch room open: the idle rule is all that is left
    expect(wantedRoom(everything, new Set<RoomId>([OFFICE_ROOM, HUB_ROOM, LUNCH_ROOM])).room).toBe(LUNCH_ROOM)
    // Lunch room closed: an idle agent stays at its desk
    expect(wantedRoom(facts({ idleForMs: LUNCH_IDLE_MS * 9 }), new Set<RoomId>([OFFICE_ROOM, HUB_ROOM, MEETING_ROOM])).room).toBe(OFFICE_ROOM)
  })

  it('every reason has a dwell, and going home is the shortest one that is not zero', () => {
    expect(dwellMs('needs-you')).toBe(DWELL_MS['needs-you'])
    expect(dwellMs('team')).toBeGreaterThan(0)
    expect(dwellMs('idle')).toBe(0)
    expect(dwellMs('home')).toBeGreaterThan(0)
    expect(dwellMs('home')).toBeLessThan(dwellMs('team'))
    expect(dwellMs('team')).toBeLessThan(dwellMs('needs-you'))
  })
})

describe('clickable doors (DoorLinks)', () => {
  it('every door between drawn rooms has a clickable area standing on its doorway', () => {
    for (const id of DRAWN_ROOMS) {
      for (const c of ROOMS[id].connections) {
        const where = `${id} -> ${c.toRoom}`
        expect(c.door, where).toBeDefined()
        const d = c.door!
        expect(d.x, where).toBeGreaterThanOrEqual(0)
        expect(d.y, where).toBeGreaterThanOrEqual(0)
        expect(d.x + d.w, where).toBeLessThanOrEqual(100)
        expect(d.y + d.h, where).toBeLessThanOrEqual(100)
        // Why: the walking point is the doorway's threshold, so the picture's
        // door is above it: across it, and with its foot within a few percent
        expect(c.position.x, where).toBeGreaterThan(d.x)
        expect(c.position.x, where).toBeLessThan(d.x + d.w)
        expect(Math.abs(d.y + d.h - c.position.y), where).toBeLessThan(2.5)
      }
    }
  })
})
