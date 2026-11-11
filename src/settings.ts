/**
 * settings.ts - the page's own preferences, remembered per browser in
 * localStorage: sound (volume + mute, ambience on/off), season and day/night mode.
 *
 * These are this browser's choices, not the office's: the server settings
 * (answer permissions, prompt logging, the AI chat monitor) live in
 * src/serverSettings.ts and on the server. The theme keeps its own key in
 * src/theme.ts (`agent-office-theme`), which already persists.
 *
 * Every reader and writer takes the storage as a parameter (defaulting to the
 * page's localStorage) so the tests run in plain Node, and every access is
 * wrapped: private windows and blocked site data throw on localStorage, and
 * the page must then simply fall back to the defaults.
 */

import { HOLIDAYS, QUARTERS, isHoliday, isQuarter, type Season } from './seasonNames'

/** The part of Storage these helpers use. */
export interface PrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const VOLUME_KEY = 'agent-office-volume'
export const MUTED_KEY = 'agent-office-muted'
export const AMBIENCE_KEY = 'agent-office-ambience'
export const SEASON_KEY = 'agent-office-season'
export const DAY_NIGHT_KEY = 'agent-office-daynight'

/**
 * What the season setting can say: follow the date, always one holiday or
 * one of the four seasons (src/seasonNames.ts), or no seasonal art at all.
 */
export type SeasonPreference = 'auto' | Season | 'off'
export const SEASON_PREFERENCES: readonly SeasonPreference[] = ['auto', ...HOLIDAYS, ...QUARTERS, 'off']

export type DayNightMode = 'auto' | 'day' | 'night'
export const DAY_NIGHT_MODES: readonly DayNightMode[] = ['auto', 'day', 'night']

// Why 0.5: src/sounds.ts starts at half volume; a first visit sounds the same as before
export const DEFAULT_VOLUME = 0.5

/** The page's localStorage, or null where touching it throws. */
function pageStorage(): PrefStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(key: string, storage: PrefStorage | null): string | null {
  try { return storage?.getItem(key) ?? null } catch { return null }
}

function write(key: string, value: string, storage: PrefStorage | null): void {
  try { storage?.setItem(key, value) } catch { /* storage blocked: the choice lasts this page only */ }
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/**
 * The remembered sound settings.
 * @returns volume in 0..1 (the level to come back to, even while muted) and whether it is muted
 */
export function readSound(storage: PrefStorage | null = pageStorage()): { volume: number; muted: boolean } {
  const stored = read(VOLUME_KEY, storage)
  const raw = stored === null ? NaN : Number(stored)
  // Why > 0: a stored 0 would make unmuting silent; mute is its own flag
  const volume = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_VOLUME
  return { volume, muted: read(MUTED_KEY, storage) === '1' }
}

/**
 * Remember the volume (ignored when 0 or out of range — see readSound).
 * @param volume 0..1
 */
export function saveVolume(volume: number, storage: PrefStorage | null = pageStorage()): void {
  if (!Number.isFinite(volume) || volume <= 0 || volume > 1) return
  write(VOLUME_KEY, String(Math.round(volume * 100) / 100), storage)
}

/** Remember whether the office is muted. */
export function saveMuted(muted: boolean, storage: PrefStorage | null = pageStorage()): void {
  write(MUTED_KEY, muted ? '1' : '0', storage)
}

/**
 * Whether the ambient office bed is on (src/sounds.ts). It plays at the main
 * volume and goes with mute; this only turns it off while keeping the event cues.
 * @returns true unless '0' is stored — Why default on: the bed replaced the
 *   bleeps as the office's sound, so a first visit hears it
 */
export function readAmbience(storage: PrefStorage | null = pageStorage()): boolean {
  return read(AMBIENCE_KEY, storage) !== '0'
}

/** Remember the Ambience setting. */
export function saveAmbience(on: boolean, storage: PrefStorage | null = pageStorage()): void {
  write(AMBIENCE_KEY, on ? '1' : '0', storage)
}

// ---------------------------------------------------------------------------
// Season
// ---------------------------------------------------------------------------

/** The remembered season choice; 'auto' when none (or junk) is stored. */
export function readSeasonPreference(storage: PrefStorage | null = pageStorage()): SeasonPreference {
  const v = read(SEASON_KEY, storage)
  return (SEASON_PREFERENCES as readonly string[]).includes(v ?? '') ? (v as SeasonPreference) : 'auto'
}

/** Remember the season choice (src/season.ts reads it on the next load). */
export function saveSeasonPreference(pref: SeasonPreference, storage: PrefStorage | null = pageStorage()): void {
  if (!(SEASON_PREFERENCES as readonly string[]).includes(pref)) return
  write(SEASON_KEY, pref, storage)
}

/**
 * What ?season= in the URL forces, as a preference: a holiday or quarter by
 * name (`?season=halloween`, `?season=summer`), or `none` for off.
 * @param search the page's query string (location.search)
 * @returns the preference, or null when the URL says nothing it knows, so a
 *   mistyped name falls through to the stored choice and the date
 */
export function seasonFromUrl(search: string): SeasonPreference | null {
  const forced = new URLSearchParams(search).get('season')
  if (forced === null) return null
  if (forced === 'none') return 'off'
  // Why not `auto` or `off`: a link exists to pin a look; the words the
  // stored setting uses are not part of the URL's vocabulary
  return isHoliday(forced) || isQuarter(forced) ? forced : null
}

// ---------------------------------------------------------------------------
// Day / night
// ---------------------------------------------------------------------------

/** The remembered day/night mode; 'auto' (follow the clock) when none is stored. */
export function readDayNightMode(storage: PrefStorage | null = pageStorage()): DayNightMode {
  const v = read(DAY_NIGHT_KEY, storage)
  return (DAY_NIGHT_MODES as readonly string[]).includes(v ?? '') ? (v as DayNightMode) : 'auto'
}

/** Remember the day/night mode. */
export function saveDayNightMode(mode: DayNightMode, storage: PrefStorage | null = pageStorage()): void {
  if (!(DAY_NIGHT_MODES as readonly string[]).includes(mode)) return
  write(DAY_NIGHT_KEY, mode, storage)
}
