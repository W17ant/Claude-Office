/**
 * RoomBackdrop - the picture behind a room other than the office: its art, or a placeholder drawn in code.
 *
 * A drawn room (src/roomAccess.ts DRAWN_ROOMS) shows its day and night
 * pictures crossfaded like the office's. A room without art is only ever on
 * screen in the `?rooms=all` preview and in /?helper, and gets a placeholder
 * built from its layout in src/rooms.ts: a plain floor and back wall in the
 * theme's colours, every door where the layout has it (with where it leads),
 * the front door and the manager's nameplate door in the corridor, a mark per
 * agent spot with the furniture its kind implies (a rack, a counter, a seat),
 * and the room's name. No image files: it is an inline SVG, so nothing has to
 * exist in public/ for the preview to work, and it follows the layout as the
 * layout is edited.
 *
 * Rendered as a sibling inside .room-container, under the characters.
 */

import React from 'react'
import { ROOMS, type AgentSpot, type RoomId } from '../rooms'
import { DRAWN_ROOMS, roomArt } from '../roomAccess'
import '../styles/room-switcher.css'

interface RoomBackdropProps {
  room: RoomId
  /** The theme in force: 'office' is Dunder Mifflin */
  theme: 'default' | 'office'
  /** 0 day … 1 night, as the office's night art is faded in */
  night: number
  /** The rooms that have art (the default is the real list; tests and the helper pass their own) */
  drawn?: readonly RoomId[]
}

// The placeholder's drawing surface: the room picture's 4800 x 3584 at a
// tenth, so one unit is ten art pixels and text keeps its proportions (a
// 0-100 box stretched to the picture would squash it).
const W = 480
const H = 358.4
const px = (x: number) => (x / 100) * W
const py = (y: number) => (y / 100) * H

// Door leaf size in room percent. Why 7 x 17: about a character's width and
// a head taller than one (a sprite stands roughly 14 % of the room high).
const DOOR_W = 7
const DOOR_H = 17

/** A door standing on the floor line at (x, y), which is where an agent walks through it */
const Door: React.FC<{ x: number; y: number; label: string; kind: 'door' | 'front-door' | 'decor-door' }> = ({ x, y, label, kind }) => (
  <g className={`ph-door ph-${kind}`}>
    <rect x={px(x - DOOR_W / 2)} y={py(y - DOOR_H)} width={px(DOOR_W)} height={py(DOOR_H)} rx={2} />
    {/* The nameplate on the manager's door; a handle on the others */}
    {kind === 'decor-door'
      ? <rect className="ph-plate" x={px(x - 2.2)} y={py(y - DOOR_H + 3)} width={px(4.4)} height={py(2.2)} />
      : <circle className="ph-handle" cx={px(x + DOOR_W / 2 - 1.3)} cy={py(y - DOOR_H / 2)} r={2} />}
    <text className="ph-label" x={px(x)} y={py(y - DOOR_H) - 5} textAnchor="middle">{label}</text>
  </g>
)

/** What a spot's kind implies stands there, drawn behind the spot's floor mark */
const SpotFurniture: React.FC<{ spot: AgentSpot }> = ({ spot }) => {
  const { x, y } = spot
  switch (spot.type) {
    case 'standing':
      // A rack against the wall, the agent in front of it
      return <rect className="ph-furniture" x={px(x - 3.5)} y={py(y - 26)} width={px(7)} height={py(20)} rx={1.5} />
    case 'coffee':
    case 'water':
      // A stretch of counter with the machine on it
      return (
        <g>
          <rect className="ph-furniture" x={px(x - 6)} y={py(y - 12)} width={px(12)} height={py(7)} rx={1.5} />
          <text className="ph-label" x={px(x)} y={py(y - 14)} textAnchor="middle">{spot.type}</text>
        </g>
      )
    case 'meeting-seat':
    case 'lounge':
      return <rect className="ph-seat" x={px(x - 2)} y={py(y - 2)} width={px(4)} height={py(4)} rx={2} />
    default:
      return null
  }
}

/**
 * The tables the seats imply: seats that share a row (the same y) and stand
 * close together sit at one table edge, and a table lies between a row and
 * the row in front of it. Drawn as one slab per cluster of seats.
 */
function tables(spots: AgentSpot[]): { x: number; y: number; w: number; h: number }[] {
  const seats = spots.filter(s => s.type === 'meeting-seat' || s.type === 'lounge')
  const clusters: AgentSpot[][] = []
  for (const seat of seats) {
    // Why 16: seats at one table are placed at most a table's width apart;
    // the lunch room's two tables are further apart than that
    const home = clusters.find(c => c.some(o => Math.abs(o.x - seat.x) <= 16 && Math.abs(o.y - seat.y) <= 20))
    if (home) home.push(seat)
    else clusters.push([seat])
  }
  return clusters.filter(c => c.length > 1).map(c => {
    const xs = c.map(s => s.x)
    const ys = c.map(s => s.y)
    const top = Math.min(...ys)
    const bottom = Math.max(...ys)
    return { x: Math.min(...xs) - 4, y: top + 3, w: Math.max(...xs) - Math.min(...xs) + 8, h: Math.max(bottom - top - 6, 5) }
  })
}

/**
 * The backdrop for one room.
 * @returns the room's two pictures, or the code-drawn placeholder when it has no art
 */
export default function RoomBackdrop({ room, theme, night, drawn = DRAWN_ROOMS }: RoomBackdropProps) {
  const art = roomArt(room, theme, drawn)
  if (art) {
    return (
      <>
        <div key={`day-${room}-${theme}`} className="room-background" style={{ backgroundImage: `url(${art.day})` }} />
        <div
          key={`night-${room}-${theme}`}
          className="room-background room-background-night"
          style={{ backgroundImage: `url(${art.night})`, opacity: night }}
        />
      </>
    )
  }

  const def = ROOMS[room]
  const floor = def.walkableArea ?? [{ x: 5, y: 50 }, { x: 95, y: 50 }, { x: 95, y: 90 }, { x: 5, y: 90 }]
  const xs = floor.map(p => p.x)
  const ys = floor.map(p => p.y)
  // The floor is the walkable area and a margin around it (the walkable area
  // is where feet go; the floor a sprite stands on reaches a little further)
  const left = Math.max(Math.min(...xs) - 4, 0)
  const right = Math.min(Math.max(...xs) + 4, 100)
  const wallBase = Math.min(...ys)
  const bottom = Math.min(Math.max(...ys) + 8, 100)
  // Why 30: the back wall is the door's height and room above it for the
  // door labels and the room's name
  const wallTop = Math.max(wallBase - 30, 2)

  return (
    <svg
      className={`room-placeholder theme-${theme}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${def.name}: placeholder, its art is not drawn yet`}
      data-testid="room-placeholder"
      data-room={room}
    >
      <rect className="ph-void" x={0} y={0} width={W} height={H} />
      <rect className="ph-wall" x={px(left)} y={py(wallTop)} width={px(right - left)} height={py(wallBase - wallTop)} />
      <rect className="ph-floor" x={px(left)} y={py(wallBase)} width={px(right - left)} height={py(bottom - wallBase)} />
      <line className="ph-skirting" x1={px(left)} y1={py(wallBase)} x2={px(right)} y2={py(wallBase)} />

      {/* Both on the wall and the floor, never on the surround: the ink is chosen against those */}
      <text className="ph-title" x={W / 2} y={py(wallTop) + 20} textAnchor="middle">{def.name.toUpperCase()}</text>
      <text className="ph-note" x={W / 2} y={py(bottom) - 6} textAnchor="middle">placeholder: this room's art is not drawn yet</text>

      {def.agentSpots.map(spot => <SpotFurniture key={`f-${spot.id}`} spot={spot} />)}
      {tables(def.agentSpots).map((t, i) => (
        <rect key={`t-${i}`} className="ph-furniture" x={px(t.x)} y={py(t.y)} width={px(t.w)} height={py(t.h)} rx={3} />
      ))}

      {def.connections.map(c => (
        <Door key={`d-${c.toRoom}`} x={c.position.x} y={c.position.y} label={ROOMS[c.toRoom].name} kind="door" />
      ))}
      {(def.landmarks ?? []).map(l => <Door key={`l-${l.id}`} x={l.x} y={l.y} label={l.label} kind={l.kind} />)}

      {def.agentSpots.map(spot => (
        <ellipse key={`s-${spot.id}`} className="ph-spot" cx={px(spot.x)} cy={py(spot.y)} rx={5} ry={2.2} />
      ))}

      {/* Night: the same dimming the office's night art gives, as a wash */}
      <rect className="ph-night" x={0} y={0} width={W} height={H} style={{ opacity: night }} />
    </svg>
  )
}
