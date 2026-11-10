/**
 * roomAccess.ts - which rooms are open, and which picture each one shows.
 *
 * A room is closed until its art is drawn. Closed means it does not exist as
 * far as the office is concerned: nobody is sent there, the floor plan does
 * not list it, and with every extra room closed the office behaves exactly
 * as it did when it was one room.
 *
 * Why a list in code (DRAWN_ROOMS) and not a runtime image probe like the
 * seasonal art (src/season.ts): a room changes who walks where, so the answer
 * has to be known before the first event is reduced and be the same on every
 * frame and in every test. A probe answers late (after the first agents have
 * been placed), differs between a cold and a warm cache, and asks for sixteen
 * files that do not exist on every page load until the art lands. Adding a
 * room is one line here, and scripts/check-assets.mjs then insists its files
 * are really in public/rooms (tests/rooms.test.ts checks the same).
 *
 * `?rooms=all` opens every room for a preview without art: a room that is
 * not drawn shows a placeholder drawn in code (src/components/RoomBackdrop.tsx).
 */

import { ROOMS, ROOM_IDS, HUB_ROOM, OFFICE_ROOM, type RoomId } from './rooms'

/**
 * The rooms whose backgrounds (day and night, plus the Dunder Mifflin pair
 * when the room lists one in `backgroundDm`) are in public/rooms. Add a
 * room's id here when its art lands and take its files off PLANNED in
 * scripts/check-assets.mjs. A room without its own Dunder Mifflin pair shows
 * its default pictures in that theme (roomArt).
 */
export const DRAWN_ROOMS: readonly RoomId[] = [OFFICE_ROOM, 'corridor', 'meeting-room', 'server-room', 'lunch-room']

/**
 * Whether the page asked for the art-less preview of every room.
 * @param search the page's query string (location.search)
 * @returns true for `?rooms=all`
 */
export function previewAllRooms(search: string): boolean {
  return new URLSearchParams(search).get('rooms') === 'all'
}

/**
 * The rooms in use. The office always is. Any other room needs the corridor,
 * because the corridor is the only way to reach it: a side room drawn before
 * the corridor stays closed.
 * @param drawn the rooms that have art
 * @param previewAll open everything regardless (`?rooms=all`)
 * @returns the open rooms, the office among them
 */
export function openRoomSet(drawn: readonly RoomId[] = DRAWN_ROOMS, previewAll = false): ReadonlySet<RoomId> {
  if (previewAll) return new Set(ROOM_IDS)
  const open = new Set<RoomId>([OFFICE_ROOM])
  if (!drawn.includes(HUB_ROOM)) return open
  for (const id of ROOM_IDS) if (drawn.includes(id)) open.add(id)
  return open
}

/**
 * The background files a room's art consists of, for both themes.
 * @param id the room (not the office: its pictures are chosen in src/theme.ts)
 * @returns the four paths under public/, or an empty list for the office
 */
export function roomArtFiles(id: RoomId): string[] {
  if (id === OFFICE_ROOM) return []
  const room = ROOMS[id]
  return [room.background.day, room.background.night, ...(room.backgroundDm ? [room.backgroundDm.day, room.backgroundDm.night] : [])]
}

/**
 * The day and night pictures to show for a room other than the office.
 * @param id the room
 * @param theme the theme in force ('office' is Dunder Mifflin)
 * @param drawn the rooms that have art
 * @returns the two paths, or null when the room has no art (draw the placeholder)
 */
export function roomArt(id: RoomId, theme: 'default' | 'office', drawn: readonly RoomId[] = DRAWN_ROOMS): { day: string; night: string } | null {
  if (id === OFFICE_ROOM || !drawn.includes(id)) return null
  const room = ROOMS[id]
  return theme === 'office' && room.backgroundDm ? room.backgroundDm : room.background
}
