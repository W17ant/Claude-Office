/**
 * season.ts - seasonal art (Christmas) layered over the normal office art.
 *
 * A season swaps an image for a festive copy saved next to it with a suffix:
 * `/rooms/office-day.png` -> `/rooms/office-day-xmas.webp`, a sprite
 * `Claude-1-front-left.png` -> `Claude-1-front-left-xmas.webp`. WebP, not PNG:
 * the festive copies are optional extras, and at quality 90 a room is ~200 KB
 * instead of ~2 MB, which keeps public/ inside its size budget
 * (scripts/check-assets.mjs). Every festive
 * file is optional: until it exists (checked with the same runtime image probe
 * the incident art uses) the normal image is shown, so the art can arrive one
 * file at a time with no code change.
 *
 * When it is on:
 *   ?season=christmas   always (a demo, a screenshot in July)
 *   ?season=none        never
 *   otherwise           1 December to 6 January (Twelfth Night), local time
 */

import { useSyncExternalStore } from 'react'
import { probeImage, subscribeIncidentAssets } from './incidentAssets'

export type Season = 'christmas'

/** File-name suffix each season's art carries (before the .webp extension). */
export const SEASON_SUFFIX: Record<Season, string> = { christmas: '-xmas' }

/**
 * The season in force, from the URL override or the date.
 * @param now the local date to judge by
 * @param search the page's query string (location.search)
 * @returns the season, or null outside one
 */
export function seasonFor(now: Date, search: string): Season | null {
  const forced = new URLSearchParams(search).get('season')
  if (forced === 'christmas') return 'christmas'
  if (forced === 'none') return null
  const month = now.getMonth() // 0 = January
  const day = now.getDate()
  // Why 6 January: Twelfth Night, when the decorations traditionally come down
  if (month === 11 || (month === 0 && day <= 6)) return 'christmas'
  return null
}

// Why judged once per page load: a season flipping mid-session (midnight on
// 30 November) would swap every sprite at once with no reason the user sees;
// the next reload picks it up.
const season: Season | null = seasonFor(new Date(), typeof location === 'undefined' ? '' : location.search)

/** The season this page loaded in (null outside one). */
export function currentSeason(): Season | null {
  return season
}

/** The festive copy's URL for `url` in `s`: `name.png` -> `name<suffix>.webp`. */
export function seasonalVariant(url: string, s: Season): string {
  return url.replace(/\.png$/, `${SEASON_SUFFIX[s]}.webp`)
}

const known = new Map<string, boolean>()

/**
 * `url`, or its festive copy once that copy is known to exist. The first call
 * for a URL starts its probe and returns `url`; when the probe answers,
 * subscribers re-render (useSeasonArt) and the next call returns the copy.
 * @param url a .png under public/
 * @param s the season (defaults to the one in force; null = no swap)
 */
export function seasonalUrl(url: string, s: Season | null = season): string {
  if (!s || !url.endsWith('.png')) return url
  const variant = seasonalVariant(url, s)
  const ok = known.get(variant)
  if (ok === undefined) {
    known.set(variant, false) // Why: one probe per file, however often it renders
    void probeImage(variant).then(found => { known.set(variant, found); bump() })
    return url
  }
  return ok ? variant : url
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
 * A number that changes whenever a festive file turns out to exist. Call it in
 * a component that renders seasonalUrl() so a memoised component re-renders
 * when its art arrives.
 */
export function useSeasonArt(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** Test hook: pretend a probe already answered. */
export function _setSeasonProbeForTests(url: string, found: boolean) {
  known.set(url, found)
}
