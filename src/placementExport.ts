/**
 * placementExport.ts - turns what was placed in /?helper into the text to paste into src/rooms.ts.
 *
 * The pure half of src/components/PlacementHelper.tsx (no React, no DOM), so
 * tests/roomSwitcher.test.ts can check what it emits. It knows the
 * building's shape (src/rooms.ts): every room's one door leads to the
 * corridor, so a door placed anywhere but the corridor gets
 * `toRoom: 'corridor'` without being asked; in the corridor each door says
 * which room it opens onto, or that it is a landmark (the front door, the
 * manager's nameplate door), which goes to `landmarks` and not `connections`.
 */

import { ROOMS, HUB_ROOM, OFFICE_ROOM, type RoomId, type RoomLandmark } from './rooms'

export type PlacementMode = 'furniture' | 'door' | 'spot' | 'entry' | 'floor' | 'waypoint'
export type SpotType = 'desk' | 'meeting-seat' | 'lounge' | 'standing' | 'water' | 'coffee'
export type SpriteFacingDir = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

/** Where a door placed in the helper leads: a room, or one of the corridor's landmarks */
export type DoorTarget = RoomId | RoomLandmark['kind']

/** One thing placed on the room in the helper */
export interface PlacedItem {
  id: string
  mode: PlacementMode
  assetKey?: string   // for furniture
  label?: string      // for doors/waypoints
  /** for doors: what is behind it (only asked in the corridor) */
  doorTarget?: DoorTarget
  spotType?: SpotType // for spots
  spriteFacing?: SpriteFacingDir // for spots
  waypointConnections?: string[] // for waypoints — ids of connected waypoints
  x: number           // percentage (0-100)
  y: number
}

/** A waypoint as the helper's route editor holds it */
export interface EditableWaypoint {
  id: string
  x: number
  y: number
  connections: string[]
}

/**
 * The prefix of a room's spot ids. Why per room: spot ids are unique across
 * the building (an agent's seat is looked up by id alone, src/rooms.ts
 * findSpot), and the office keeps `spot-N` because its saved layouts and the
 * desk-screen table (src/screens.ts) name its desks that way.
 */
export const SPOT_PREFIX: Record<RoomId, string> = {
  'main-office': 'spot',
  corridor: 'hall',
  'meeting-room': 'meet',
  'server-room': 'srv',
  'lunch-room': 'lunch',
}

const LANDMARK_LABEL: Record<RoomLandmark['kind'], string> = {
  'front-door': 'Front door / lift',
  'decor-door': 'Manager',
}

/**
 * The room the helper opens on.
 * @param search the page's query string (`?helper&room=server-room`)
 * @returns the room named by `room=`, or the office when it is missing or not a room
 */
export function helperRoom(search: string): RoomId {
  const wanted = new URLSearchParams(search).get('room')
  return wanted !== null && Object.prototype.hasOwnProperty.call(ROOMS, wanted) ? (wanted as RoomId) : OFFICE_ROOM
}

/**
 * What a door in `room` may lead to.
 * @param room the room being placed
 * @returns the corridor alone for the office and the side rooms; in the
 *   corridor every other room and the two landmark kinds
 */
export function doorTargets(room: RoomId): DoorTarget[] {
  if (room !== HUB_ROOM) return [HUB_ROOM]
  return [...(Object.keys(ROOMS) as RoomId[]).filter(id => id !== HUB_ROOM), 'front-door', 'decor-door']
}

/**
 * The name to show for a door target.
 * @param target a room id or a landmark kind
 * @returns the room's name, or the landmark's label
 */
export function doorTargetLabel(target: DoorTarget): string {
  return target === 'front-door' || target === 'decor-door' ? LANDMARK_LABEL[target] : ROOMS[target].name
}

/** The target a placed door really has: what was chosen when that is allowed here, else the room's first choice */
function resolveDoor(room: RoomId, item: PlacedItem): DoorTarget {
  const allowed = doorTargets(room)
  return item.doorTarget && allowed.includes(item.doorTarget) ? item.doorTarget : allowed[0]
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/**
 * The rooms.ts text for what was placed: the fields of `ROOMS[room]` that
 * the helper edits, ready to paste over the room's own.
 * @param room the room that was placed
 * @param placed everything placed (furniture, doors, spots, entry, floor corners)
 * @param waypoints the route editor's waypoints
 * @returns the lines, or an empty string when nothing was placed
 */
export function exportRoomLayout(room: RoomId, placed: readonly PlacedItem[], waypoints: readonly EditableWaypoint[] = []): string {
  const furniture = placed.filter(p => p.mode === 'furniture')
  const doors = placed.filter(p => p.mode === 'door').map(p => ({ p, target: resolveDoor(room, p) }))
  const connections = doors.filter(d => d.target !== 'front-door' && d.target !== 'decor-door')
  const landmarks = doors.filter(d => d.target === 'front-door' || d.target === 'decor-door')
  const spots = placed.filter(p => p.mode === 'spot')
  const entry = placed.find(p => p.mode === 'entry')
  const floor = placed.filter(p => p.mode === 'floor')

  const lines: string[] = []

  if (furniture.length) {
    lines.push('    furniture: [')
    furniture.forEach(p => {
      lines.push(`      { id: '${p.id}', type: '${p.assetKey}', sprite: '${p.assetKey}', x: ${p.x}, y: ${p.y}, label: '${p.assetKey}' },`)
    })
    lines.push('    ],')
  }

  if (connections.length) {
    lines.push('    connections: [')
    connections.forEach(({ p, target }) => {
      // Why the room's name unless a label was typed: the helper's label
      // field is free text and defaults to nothing useful in a new room
      const label = p.label?.trim() || doorTargetLabel(target)
      lines.push(`      { toRoom: '${target}', position: { x: ${p.x}, y: ${p.y} }, label: ${quote(label)} },`)
    })
    lines.push('    ],')
  }

  if (landmarks.length) {
    lines.push('    landmarks: [')
    landmarks.forEach(({ p, target }) => {
      const kind = target as RoomLandmark['kind']
      const id = kind === 'front-door' ? 'front-door' : 'manager-door'
      lines.push(`      { id: '${id}', kind: '${kind}', label: ${quote(p.label?.trim() || LANDMARK_LABEL[kind])}, x: ${p.x}, y: ${p.y} },`)
    })
    lines.push('    ],')
  }

  if (spots.length) {
    const prefix = SPOT_PREFIX[room]
    lines.push('    agentSpots: [')
    spots.forEach((p, i) => {
      lines.push(`      { id: '${prefix}-${i + 1}', type: '${p.spotType}', x: ${p.x}, y: ${p.y}, facing: 'down', spriteFacing: '${p.spriteFacing ?? 'front-right'}' },`)
    })
    lines.push('    ],')
  }

  if (entry) {
    lines.push(`    entryPoint: { x: ${entry.x}, y: ${entry.y} },`)
  }

  if (floor.length >= 3) {
    lines.push('    walkableArea: [')
    floor.forEach(p => {
      lines.push(`      { x: ${p.x}, y: ${p.y} },`)
    })
    lines.push('    ],')
  }

  if (waypoints.length > 0) {
    lines.push('    waypoints: [')
    waypoints.forEach(wp => {
      const conns = wp.connections.map(c => `'${c}'`).join(', ')
      const pad = ' '.repeat(Math.max(0, 18 - wp.id.length))
      lines.push(`      { id: '${wp.id}',${pad}x: ${wp.x}, y: ${wp.y}, connections: [${conns}] },`)
    })
    lines.push('    ],')
  }

  if (lines.length === 0) return ''
  // Why a heading: with five rooms the pasted block has to say whose it is
  const note = room === OFFICE_ROOM || !ROOMS[room].provisional
    ? ''
    : ' (placed over its art: also delete `provisional: true`)'
  return [`    // ROOMS['${room}'] in src/rooms.ts${note}`, ...lines].join('\n')
}
