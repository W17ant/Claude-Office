/**
 * RoomSwitcher - the small floor plan in the stage's corner: who is where, and a click shows that room.
 *
 * Draws the model from src/roomSwitcher.ts: the open rooms as boxes standing
 * on the corridor strip, a dot per agent in each, a mark on a room where a
 * session waits on you (amber "!") or something went wrong (red "×"), and a
 * ring around the room the stage shows. With only the office open the model
 * is empty and this renders nothing, so an office without the extra rooms has
 * no switcher in its DOM.
 *
 * Every room is a real <button> (Tab reaches it, Enter / Space shows the
 * room); the arrow keys also move between them, as in a toolbar. It never
 * switches rooms by itself: the marks say where to look, the user decides.
 */

import React, { useRef } from 'react'
import type { RoomId } from '../rooms'
import { planRoomLabel, type PlanRoom } from '../roomSwitcher'
import '../styles/room-switcher.css'

interface RoomSwitcherProps {
  /** The plan (src/roomSwitcher.ts switcherModel); empty draws nothing */
  rooms: PlanRoom[]
  /** The theme in force: 'office' is Dunder Mifflin */
  theme: 'default' | 'office'
  /** The user picked a room */
  onSelect: (room: RoomId) => void
}

const MARK_TEXT: Record<NonNullable<PlanRoom['mark']>, string> = { 'needs-you': '!', trouble: '×' }

const RoomButton: React.FC<{ room: PlanRoom; onSelect: (room: RoomId) => void }> = ({ room, onSelect }) => (
  <button
    type="button"
    className={`plan-room plan-${room.place}${room.current ? ' current' : ''}${room.mark ? ` mark-${room.mark}` : ''}`}
    aria-pressed={room.current}
    aria-label={planRoomLabel(room)}
    title={planRoomLabel(room)}
    data-room={room.id}
    onClick={() => onSelect(room.id)}
  >
    <span className="plan-name" aria-hidden="true">{room.short}</span>
    <span className="plan-dots" aria-hidden="true">
      {room.dots.map(dot => <i key={dot.id} className="plan-dot" style={{ background: dot.color }} />)}
      {room.more > 0 && <i className="plan-more">+{room.more}</i>}
    </span>
    {room.mark && <span className="plan-mark" aria-hidden="true">{MARK_TEXT[room.mark]}</span>}
  </button>
)

/**
 * The floor plan.
 * @returns the plan, or null when there is no room to switch to
 */
export default function RoomSwitcher({ rooms, theme, onSelect }: RoomSwitcherProps) {
  const ref = useRef<HTMLDivElement>(null)
  if (rooms.length === 0) return null
  const boxes = rooms.filter(r => r.place === 'room')
  const hub = rooms.find(r => r.place === 'hub')

  // Arrow keys walk the buttons in DOM order (boxes left to right, then the
  // corridor); Up / Down hop between the row of boxes and the corridor
  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button.plan-room') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const last = buttons.length - 1
    let next = -1
    if (e.key === 'ArrowRight') next = at === last ? 0 : at + 1
    else if (e.key === 'ArrowLeft') next = at === 0 ? last : at - 1
    else if (e.key === 'ArrowDown') next = last
    else if (e.key === 'ArrowUp') next = at === last ? 0 : at
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    if (next < 0) return
    e.preventDefault()
    buttons[next]?.focus()
  }

  return (
    <div
      ref={ref}
      className={`room-switcher theme-${theme}`}
      role="group"
      aria-label="Floor plan: choose the room to show"
      data-testid="room-switcher"
      onKeyDown={onKeyDown}
    >
      <div className="plan-row">
        {boxes.map(room => <RoomButton key={room.id} room={room} onSelect={onSelect} />)}
      </div>
      {hub && <RoomButton room={hub} onSelect={onSelect} />}
    </div>
  )
}
