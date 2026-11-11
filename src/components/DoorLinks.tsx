/**
 * DoorLinks - the doors in the room on the stage, clickable: a click shows the room the door leads to.
 *
 * One transparent button over each door drawn in the room's picture (the
 * `door` rectangle on src/rooms.ts connections), so the office's door opens
 * the corridor and the corridor's doors open the rooms. Only doors to open
 * rooms (src/roomAccess.ts) are drawn. Like the floor plan (RoomSwitcher), it
 * only changes which room is shown; nobody walks.
 *
 * Rendered inside .room-container above the picture and under the characters,
 * so someone standing in a doorway is still the thing clicked.
 */

import React from 'react'
import { ROOMS, type RoomId } from '../rooms'
import '../styles/room-switcher.css'

interface DoorLinksProps {
  /** The room on the stage */
  room: RoomId
  /** The rooms that can be shown (closed rooms' doors stay plain picture) */
  open: ReadonlySet<RoomId>
  /** Show this room */
  onOpen: (room: RoomId) => void
}

/** The clickable doors of `room` */
export default function DoorLinks({ room, open, onOpen }: DoorLinksProps) {
  const doors = ROOMS[room].connections.filter(c => c.door && open.has(c.toRoom))
  return (
    <>
      {doors.map(c => (
        <button
          key={c.toRoom}
          type="button"
          className="door-link"
          data-to={c.toRoom}
          aria-label={`Go to ${c.label ?? ROOMS[c.toRoom].name}`}
          title={c.label ?? ROOMS[c.toRoom].name}
          style={{ left: `${c.door!.x}%`, top: `${c.door!.y}%`, width: `${c.door!.w}%`, height: `${c.door!.h}%` }}
          onClick={() => onOpen(c.toRoom)}
        />
      ))}
    </>
  )
}
