/** season.ts - when Christmas is on, and how a festive copy replaces an image. */
import { describe, expect, it } from 'vitest'
import { _setSeasonProbeForTests, seasonalUrl, seasonalVariant, seasonFor } from '../src/season'

const on = (y: number, m: number, d: number, search = '') => seasonFor(new Date(y, m - 1, d, 12), search)

describe('seasonFor', () => {
  it('is Christmas from 1 December to 6 January, and not either side', () => {
    expect(on(2026, 11, 30)).toBeNull()
    expect(on(2026, 12, 1)).toBe('christmas')
    expect(on(2026, 12, 25)).toBe('christmas')
    expect(on(2027, 1, 6)).toBe('christmas')
    expect(on(2027, 1, 7)).toBeNull()
    expect(on(2027, 7, 14)).toBeNull()
  })

  it('?season=christmas forces it on, ?season=none off, anything else follows the date', () => {
    expect(on(2027, 7, 14, '?season=christmas')).toBe('christmas')
    expect(on(2026, 12, 25, '?season=none')).toBeNull()
    expect(on(2026, 12, 25, '?season=easter')).toBe('christmas')
    expect(on(2026, 12, 25, '?sim&season=none')).toBeNull()
  })
})

describe('seasonFor: the stored preference (Settings panel)', () => {
  const stored = (pref: 'auto' | 'christmas' | 'off', y: number, m: number, d: number, search = '') =>
    seasonFor(new Date(y, m - 1, d, 12), search, pref)

  it('Christmas or Off from the Settings panel beats the date', () => {
    expect(stored('christmas', 2027, 7, 14)).toBe('christmas')
    expect(stored('off', 2026, 12, 25)).toBeNull()
  })

  it('Auto follows the date, as with nothing stored', () => {
    expect(stored('auto', 2026, 12, 25)).toBe('christmas')
    expect(stored('auto', 2027, 7, 14)).toBeNull()
  })

  it('the URL beats the stored preference: ?season=none over Christmas, ?season=christmas over Off', () => {
    expect(stored('christmas', 2026, 12, 25, '?season=none')).toBeNull()
    expect(stored('off', 2027, 7, 14, '?season=christmas')).toBe('christmas')
    // An unknown ?season= says nothing, so the stored choice decides
    expect(stored('off', 2026, 12, 25, '?season=easter')).toBeNull()
  })
})

describe('seasonalUrl', () => {
  it('names the festive copy next to the original', () => {
    expect(seasonalVariant('/rooms/office-day.png', 'christmas')).toBe('/rooms/office-day-xmas.webp')
    expect(seasonalVariant('/sprites/characters/Claude-1-front-left.png', 'christmas')).toBe('/sprites/characters/Claude-1-front-left-xmas.webp')
  })

  it('keeps the original until the copy is known to exist, then swaps', () => {
    _setSeasonProbeForTests('/rooms/a-xmas.webp', true)
    _setSeasonProbeForTests('/rooms/b-xmas.webp', false)
    expect(seasonalUrl('/rooms/a.png', 'christmas')).toBe('/rooms/a-xmas.webp')
    expect(seasonalUrl('/rooms/b.png', 'christmas')).toBe('/rooms/b.png')
  })

  it('outside a season, and for anything but a .png, the URL is untouched', () => {
    _setSeasonProbeForTests('/rooms/a-xmas.webp', true)
    expect(seasonalUrl('/rooms/a.png', null)).toBe('/rooms/a.png')
    expect(seasonalUrl('/sounds/bell.mp3', 'christmas')).toBe('/sounds/bell.mp3')
  })

  it('an unknown file starts a probe and shows the original meanwhile (no Image in node: the probe says no)', async () => {
    expect(seasonalUrl('/rooms/c.png', 'christmas')).toBe('/rooms/c.png')
    await new Promise(r => setTimeout(r, 0))
    expect(seasonalUrl('/rooms/c.png', 'christmas')).toBe('/rooms/c.png')
  })
})
