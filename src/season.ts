/**
 * season.ts - seasonal art layered over the normal office art: the four
 * seasons all year round, with the holidays on top.
 *
 * Two layers (their names and file suffixes are in src/seasonNames.ts):
 *   a holiday   Christmas, Halloween, Easter, Valentine's Day: a few days each
 *   a quarter   spring, summer, autumn, winter: always one of them
 *
 * A season swaps an image for a copy saved next to it with a suffix:
 * `/rooms/office-day.png` -> `/rooms/office-day-xmas.webp`, a sprite
 * `Claude-1-front-left.png` -> `Claude-1-front-left-autumn.webp`. WebP, not
 * PNG: the copies are optional extras, and at quality 90 a room is ~200 KB
 * instead of ~2 MB, which keeps public/ inside its size budget
 * (scripts/check-assets.mjs).
 *
 * The lookup, first file that exists wins:
 *   on a holiday   name-<holiday>.webp -> name-<quarter>.webp -> name.png
 *   otherwise      name-<quarter>.webp -> name.png
 * so on 25 December `office-day.png` tries `-xmas`, then `-winter`, then
 * stays itself. Every copy is optional: until it exists (checked with the same
 * runtime image probe the incident art uses) the next one down is shown, so
 * the art can arrive one file at a time with no code change. The one rule:
 * a season counts as drawn only once its key file exists, the default theme's
 * day room `/rooms/office-day-<suffix>.webp` (SEASON_KEY_ART below says why).
 *
 * When each is on (Auto), local time:
 *   Christmas     1 December to 6 January (Twelfth Night)
 *   Halloween     25 to 31 October
 *   Easter        Good Friday to Easter Monday (Western Easter, per year)
 *   Valentine's   7 to 14 February
 *   quarters      meteorological, northern hemisphere: spring March to May,
 *                 summer June to August, autumn September to November,
 *                 winter December to February. Someone south of the equator
 *                 picks their season by hand in Settings.
 *
 * What decides, first match wins:
 *   ?season=<name>      that holiday or quarter (a demo, a screenshot in July)
 *   ?season=none        no seasonal art at all
 *   the Settings panel  one of the eight, or Off, remembered in this browser
 *                       (src/settings.ts, `agent-office-season`)
 *   otherwise (Auto)    the date
 * A holiday chosen by hand still falls back to the quarter the date is in; a
 * quarter chosen by hand shows no holiday, even on Christmas Day.
 *
 * Public API
 *   currentSeason()    the holiday in force, or null. The Christmas-only
 *                      pieces (advent calendar, Santa hats) ask this.
 *   currentQuarter()   the quarter in force, or null when the season is Off
 *   seasonalUrl(url)   `url`, or the seasonal copy to draw instead
 *   useSeasonArt()     re-render when a copy turns out to exist
 *   seasonHasArt(s)    whether a season has been drawn at all
 *   seasonLookFor, holidayFor, quarterFor, easterSunday, seasonalVariant:
 *                      the pure rules behind those, exported for the tests
 */

import { useSyncExternalStore } from 'react'
import { probeImage, subscribeIncidentAssets } from './incidentAssets'
import { readSeasonPreference, seasonFromUrl, type SeasonPreference } from './settings'
import { SEASON_SUFFIX, isHoliday, type Holiday, type Quarter, type Season } from './seasonNames'

export type { Holiday, Quarter, Season }

/** What the page shows: the holiday on top (if any) and the quarter under it (null = Off). */
export interface SeasonLook {
  holiday: Holiday | null
  quarter: Quarter | null
}

// ---------------------------------------------------------------------------
// The date rules
// ---------------------------------------------------------------------------

/**
 * Easter Sunday in the Western (Gregorian) calendar.
 * @param year a Gregorian year, e.g. 2026
 * @returns local midnight on that Sunday (2026: 5 April, 2027: 28 March)
 */
export function easterSunday(year: number): Date {
  // The "anonymous Gregorian algorithm" (Meeus/Jones/Butcher): the first
  // Sunday after the first ecclesiastical full moon on or after 21 March.
  // Integer arithmetic only, exact for every Gregorian year; the letters are
  // the ones the published algorithm uses.
  const a = year % 19 // the year's place in the 19-year lunar (Metonic) cycle
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30 // days from 21 March to that full moon
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7 // days on from the full moon to Sunday
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  // n / 31 is the month (3 = March, 4 = April), the remainder the day before
  return new Date(year, Math.floor(n / 31) - 1, (n % 31) + 1)
}

/**
 * The holiday a date falls in.
 * @param now the local date to judge by
 * @returns the holiday, or null on an ordinary day
 */
export function holidayFor(now: Date): Holiday | null {
  const year = now.getFullYear()
  const month = now.getMonth() // 0 = January
  const day = now.getDate()
  // Why 6 January: Twelfth Night, when the decorations traditionally come down
  if (month === 11 || (month === 0 && day <= 6)) return 'christmas'
  // Why the 25th: the week running up to the night itself; by 1 November it is over
  if (month === 9 && day >= 25) return 'halloween'
  // Why the 7th: likewise a week, ending on the day
  if (month === 1 && day >= 7 && day <= 14) return 'valentine'
  // Why Good Friday to Easter Monday: the long weekend (both are UK bank
  // holidays). Built from local calendar days, not by adding 24 h, so the
  // clocks going forward that weekend cannot shift an edge.
  const easter = easterSunday(year)
  const goodFriday = new Date(year, easter.getMonth(), easter.getDate() - 2)
  const easterMonday = new Date(year, easter.getMonth(), easter.getDate() + 1)
  const today = new Date(year, month, day)
  if (today >= goodFriday && today <= easterMonday) return 'easter'
  return null
}

// Why meteorological seasons (whole months) and not the equinoxes: the edges
// are the same every year and need no astronomy. Northern hemisphere: the
// office's owner is in the UK. Index = getMonth(), 0 = January.
const QUARTER_BY_MONTH: readonly Quarter[] = [
  'winter', 'winter',
  'spring', 'spring', 'spring',
  'summer', 'summer', 'summer',
  'autumn', 'autumn', 'autumn',
  'winter',
]

/**
 * The season of the year a date falls in (meteorological, northern hemisphere).
 * @param now the local date to judge by
 */
export function quarterFor(now: Date): Quarter {
  return QUARTER_BY_MONTH[now.getMonth()]
}

/**
 * The look in force: the URL override, else the stored preference, else the date.
 * @param now the local date to judge by
 * @param search the page's query string (location.search)
 * @param stored the Settings panel's choice (src/settings.ts readSeasonPreference)
 * @returns the holiday on top (or null) and the quarter under it (null only when Off)
 */
export function seasonLookFor(now: Date, search: string, stored: SeasonPreference = 'auto'): SeasonLook {
  // Why the URL first: a demo or screenshot link must look the same in every browser
  const pref = seasonFromUrl(search) ?? stored
  if (pref === 'off') return { holiday: null, quarter: null }
  if (pref === 'auto') return { holiday: holidayFor(now), quarter: quarterFor(now) }
  // Why the date's quarter under a chosen holiday: the holiday's art may cover
  // only some files, and what shows through should be what Auto would show
  if (isHoliday(pref)) return { holiday: pref, quarter: quarterFor(now) }
  // Why no holiday over a chosen quarter: "Summer" has to mean summer, also on Christmas Day
  return { holiday: null, quarter: pref }
}

// Why judged once per page load: a season flipping mid-session (midnight on
// 30 November) would swap every sprite at once with no reason the user sees;
// the next reload picks it up.
// The Settings panel's season change therefore asks for a reload too.
const pageLook: SeasonLook = seasonLookFor(new Date(), typeof location === 'undefined' ? '' : location.search, readSeasonPreference())

/** The holiday this page loaded in (null outside one). */
export function currentSeason(): Holiday | null {
  return pageLook.holiday
}

/** The quarter this page loaded in (null only when the season is Off). */
export function currentQuarter(): Quarter | null {
  return pageLook.quarter
}

// ---------------------------------------------------------------------------
// Which copies exist
// ---------------------------------------------------------------------------

/** The seasonal copy's URL for `url` in `s`: `name.png` -> `name<suffix>.webp`. */
export function seasonalVariant(url: string, s: Season): string {
  return url.replace(/\.png$/, `${SEASON_SUFFIX[s]}.webp`)
}

/**
 * The image whose seasonal copy says a season has been drawn at all.
 *
 * Why: the quarters are on all year, so without this every swappable image
 * (the room, each desk and plant, a sprite per character and direction) would
 * cost one failed request on every page load for as long as a season has no
 * art, and two on a holiday. Instead one probe of this file answers for the
 * whole season: no key file, no further requests. That is at most one 404 per
 * layer in force (two on a holiday) however many images the office draws.
 * Why this and not a generated list of the files: a list has to be rebuilt
 * whenever art is added and is silently wrong when someone forgets; a file
 * that is either there or not cannot go stale, and "drop the file in, reload"
 * stays true. Why the default theme's day room: it is the first thing to draw
 * for a season, and in the default theme its probe is the one the room makes
 * anyway, so the check costs nothing extra there.
 */
export const SEASON_KEY_ART = '/rooms/office-day.png'

// A copy's URL -> whether it exists; null while its probe is in flight
const known = new Map<string, boolean | null>()

/** Whether `variant` exists; null until its probe (started by the first call) answers. */
function exists(variant: string): boolean | null {
  const state = known.get(variant)
  if (state !== undefined) return state
  known.set(variant, null) // Why: one probe per file, however often it renders
  void probeImage(variant).then(found => {
    // Why the check: an answer already set (the test hook) is not overwritten
    if (known.get(variant) === null) known.set(variant, found)
    bump()
  })
  return null
}

/**
 * Whether a season has any art, judged by its key file (SEASON_KEY_ART). The
 * first call starts that probe; subscribers re-render when it answers.
 * @returns true or false once known, null while the probe is in flight
 */
export function seasonHasArt(s: Season): boolean | null {
  return exists(seasonalVariant(SEASON_KEY_ART, s))
}

/**
 * `url`, or the seasonal copy to draw instead: the holiday's if it exists,
 * else the quarter's, else `url` itself. The first call for a URL starts a
 * probe and returns `url`; when the probe answers, subscribers re-render
 * (useSeasonArt) and the next call returns the copy.
 * @param url a .png under public/
 * @param look the holiday and quarter (defaults to the ones in force)
 * @returns the URL to draw
 */
export function seasonalUrl(url: string, look: SeasonLook = pageLook): string {
  if (!url.endsWith('.png')) return url
  for (const s of [look.holiday, look.quarter]) {
    if (!s) continue
    const drawn = seasonHasArt(s)
    const found = drawn ? exists(seasonalVariant(url, s)) : drawn
    if (found) return seasonalVariant(url, s)
    // Why stop at an unanswered probe: asking for the quarter's copy before
    // the holiday's has said no would double the requests on a holiday, and
    // could flash winter art on a sprite about to turn out to have a jumper
    if (found === null) return url
  }
  return url
}

// ---------------------------------------------------------------------------
// Re-render when a probe answers
// ---------------------------------------------------------------------------

let version = 0
const listeners = new Set<() => void>()
function bump() {
  version++
  listeners.forEach(l => l())
}
function subscribe(fn: () => void) {
  listeners.add(fn)
  const off = subscribeIncidentAssets(fn)
  return () => { listeners.delete(fn); off() }
}

/**
 * A number that changes whenever a seasonal file turns out to exist (or not).
 * Call it in a component that renders seasonalUrl() so a memoised component
 * re-renders when its art arrives.
 */
export function useSeasonArt(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Test hook: pretend a probe already answered. */
export function _setSeasonProbeForTests(url: string, found: boolean) {
  known.set(url, found)
}

/** Test hook: every URL asked about so far, in order (what a page load would request). */
export function _seasonProbesForTests(): string[] {
  return [...known.keys()]
}

/** Test hook: forget every answer. */
export function _resetSeasonProbesForTests() {
  known.clear()
}
