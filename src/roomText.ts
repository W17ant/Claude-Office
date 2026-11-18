/**
 * roomText.ts - the words people read for each room, in the office's language.
 *
 * Room data (src/rooms.ts) keeps its English names as ids for code and the
 * placement tools; what the page shows goes through these maps.
 * Why maps of literal keys: the locale check (tests/locales.test.ts) can only
 * verify keys written out in full.
 */
import { t } from './i18n'
import type { RoomId } from './rooms'

/** A room's full name ("Meeting Room"). */
export function roomName(id: RoomId): string {
  switch (id) {
    case 'main-office': return t('ui.rooms.mainOffice')
    case 'corridor': return t('ui.rooms.corridor')
    case 'meeting-room': return t('ui.rooms.meetingRoom')
    case 'server-room': return t('ui.rooms.serverRoom')
    case 'lunch-room': return t('ui.rooms.lunchRoom')
    default: return String(id)
  }
}

/** A room's name on the floor plan ("Meeting"). */
export function roomShort(id: RoomId): string {
  switch (id) {
    case 'main-office': return t('ui.rooms.short.mainOffice')
    case 'corridor': return t('ui.rooms.short.corridor')
    case 'meeting-room': return t('ui.rooms.short.meetingRoom')
    case 'server-room': return t('ui.rooms.short.serverRoom')
    case 'lunch-room': return t('ui.rooms.short.lunchRoom')
    default: return String(id)
  }
}

/**
 * A piece of furniture's or a hotspot's name, shown on hover ("Coffee Machine").
 * Keyed by the item's id in src/rooms.ts; the data's own English label is the
 * fallback for an item added (e.g. by the placement tools) without a key yet.
 * @param id the FurnitureItem id
 * @param fallback the item's label from the room data
 */
export function furnitureLabel(id: string, fallback: string): string {
  switch (id) {
    case 'coffee':
    case 'lunch-coffee-machine': return t('ui.rooms.furniture.coffeeMachine')
    case 'filing-1': return t('ui.rooms.furniture.filingCabinet')
    case 'printer-1': return t('ui.rooms.furniture.printer')
    case 'fire-extinguisher': return t('ui.rooms.furniture.fireExtinguisher')
    case 'water-cooler':
    case 'lunch-water': return t('ui.rooms.furniture.waterCooler')
    case 'bell': return t('ui.rooms.furniture.bell')
    case 'kanban-board': return t('ui.rooms.furniture.kanbanBoard')
    case 'ship-it-poster': return t('ui.rooms.furniture.shipItPoster')
    case 'tv-monitor': return t('ui.rooms.furniture.dashboard')
    default: return fallback
  }
}

/**
 * A door's name, by the room it leads to ("Office" on the corridor's door to
 * the main office: shorter than the room's full name, as the data has it).
 * @param toRoom the room the door opens
 * @param fallback the connection's label from the room data
 */
export function doorLabel(toRoom: RoomId, fallback: string): string {
  switch (toRoom) {
    case 'main-office': return t('ui.rooms.doors.mainOffice')
    case 'corridor': return t('ui.rooms.doors.corridor')
    case 'meeting-room': return t('ui.rooms.doors.meetingRoom')
    case 'server-room': return t('ui.rooms.doors.serverRoom')
    case 'lunch-room': return t('ui.rooms.doors.lunchRoom')
    default: return fallback
  }
}

/**
 * A landmark's name in the room picture ("Lift" for the corridor's front door).
 * @param id the RoomLandmark id
 * @param fallback the landmark's label from the room data
 */
export function landmarkLabel(id: string, fallback: string): string {
  switch (id) {
    case 'front-door': return t('ui.rooms.landmarks.frontDoor')
    case 'manager-door': return t('ui.rooms.landmarks.managerDoor')
    default: return fallback
  }
}
