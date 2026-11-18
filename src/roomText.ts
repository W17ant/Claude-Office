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
