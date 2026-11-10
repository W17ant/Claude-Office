/**
 * season.ts - which holiday and which season of the year are on, and how a
 * seasonal copy replaces an image: the holiday's, else the quarter's, else
 * the normal art.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  SEASON_KEY_ART, _resetSeasonProbesForTests, _seasonProbesForTests, _setSeasonProbeForTests,
  currentQuarter, currentSeason, easterSunday, holidayFor, quarterFor, seasonHasArt,
  seasonLookFor, seasonalUrl, seasonalVariant, type SeasonLook,
} from '../src/season'
import { HOLIDAYS, QUARTERS, SEASON_SUFFIX, type Season } from '../src/seasonNames'
import type { SeasonPreference } from '../src/settings'

const ALL: Season[] = [...HOLIDAYS, ...QUARTERS]

/** A local date; noon unless an hour is given, so the day is never in doubt. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min)
const holiday = (y: number, m: number, d: number, h?: number, min?: number) => holidayFor(at(y, m, d, h, min))
const quarter = (y: number, m: number, d: number) => quarterFor(at(y, m, d))
const look = (y: number, m: number, d: number, search = '', stored: SeasonPreference = 'auto') =>
  seasonLookFor(at(y, m, d), search, stored)

describe('easterSunday', () => {
  it('finds Western Easter for the year', () => {
    const easter = (y: number) => { const e = easterSunday(y); return [e.getFullYear(), e.getMonth() + 1, e.getDate()] }
    expect(easter(2024)).toEqual([2024, 3, 31])
    expect(easter(2025)).toEqual([2025, 4, 20])
    expect(easter(2026)).toEqual([2026, 4, 5])
    expect(easter(2027)).toEqual([2027, 3, 28])
    expect(easter(2030)).toEqual([2030, 4, 21])
    // The two ends of the range Easter can fall in: 22 March and 25 April
    expect(easter(2285)).toEqual([2285, 3, 22])
    expect(easter(2038)).toEqual([2038, 4, 25])
  })

  it('is always a Sunday at local midnight', () => {
    for (let y = 2020; y <= 2060; y++) {
      const e = easterSunday(y)
      expect([y, e.getDay(), e.getHours()]).toEqual([y, 0, 0])
    }
  })
})

describe('holidayFor', () => {
  it('Christmas: 1 December to 6 January, and not either side', () => {
    expect(holiday(2026, 11, 30, 23, 59)).toBeNull()
    expect(holiday(2026, 12, 1, 0, 0)).toBe('christmas')
    expect(holiday(2026, 12, 25)).toBe('christmas')
    expect(holiday(2026, 12, 31)).toBe('christmas')
    expect(holiday(2027, 1, 1)).toBe('christmas')
    expect(holiday(2027, 1, 6, 23, 59)).toBe('christmas')
    expect(holiday(2027, 1, 7, 0, 0)).toBeNull()
  })

  it('Halloween: 25 to 31 October', () => {
    expect(holiday(2026, 10, 24, 23, 59)).toBeNull()
    expect(holiday(2026, 10, 25, 0, 0)).toBe('halloween')
    expect(holiday(2026, 10, 28)).toBe('halloween')
    expect(holiday(2026, 10, 31, 23, 59)).toBe('halloween')
    expect(holiday(2026, 11, 1, 0, 0)).toBeNull()
  })

  it("Valentine's Day: 7 to 14 February, leap year or not", () => {
    for (const y of [2027, 2028]) { // 2028 is a leap year
      expect(holiday(y, 2, 6, 23, 59)).toBeNull()
      expect(holiday(y, 2, 7, 0, 0)).toBe('valentine')
      expect(holiday(y, 2, 14, 23, 59)).toBe('valentine')
      expect(holiday(y, 2, 15, 0, 0)).toBeNull()
    }
    expect(holiday(2028, 2, 29)).toBeNull()
  })

  it('Easter: Good Friday to Easter Monday, wherever Easter falls that year', () => {
    // 2026: Easter Sunday 5 April
    expect(holiday(2026, 4, 2, 23, 59)).toBeNull()
    expect(holiday(2026, 4, 3, 0, 0)).toBe('easter')
    expect(holiday(2026, 4, 5)).toBe('easter')
    expect(holiday(2026, 4, 6, 23, 59)).toBe('easter')
    expect(holiday(2026, 4, 7, 0, 0)).toBeNull()
    // 2027: 28 March, the night the UK's clocks go forward
    expect(holiday(2027, 3, 25, 23, 59)).toBeNull()
    expect(holiday(2027, 3, 26, 0, 0)).toBe('easter')
    expect(holiday(2027, 3, 28, 3, 0)).toBe('easter')
    expect(holiday(2027, 3, 29, 23, 59)).toBe('easter')
    expect(holiday(2027, 3, 30, 0, 0)).toBeNull()
    // 2030: 21 April
    expect(holiday(2030, 4, 18)).toBeNull()
    expect(holiday(2030, 4, 19)).toBe('easter')
    expect(holiday(2030, 4, 22)).toBe('easter')
    expect(holiday(2030, 4, 23)).toBeNull()
    // 2038: 25 April, as late as Easter gets
    expect(holiday(2038, 4, 22)).toBeNull()
    expect(holiday(2038, 4, 23)).toBe('easter')
    expect(holiday(2038, 4, 26)).toBe('easter')
    expect(holiday(2038, 4, 27)).toBeNull()
  })

  it('Easter: a weekend that straddles two months (2024: Good Friday 29 March, Easter Monday 1 April)', () => {
    expect(holiday(2024, 3, 28)).toBeNull()
    expect(holiday(2024, 3, 29)).toBe('easter')
    expect(holiday(2024, 3, 31)).toBe('easter')
    expect(holiday(2024, 4, 1)).toBe('easter')
    expect(holiday(2024, 4, 2)).toBeNull()
  })

  it('an ordinary day is no holiday', () => {
    expect(holiday(2027, 7, 14)).toBeNull()
    expect(holiday(2026, 11, 10)).toBeNull()
  })
})

describe('quarterFor', () => {
  it('goes by whole months: spring March to May, summer June to August, autumn September to November, winter December to February', () => {
    const byMonth = Array.from({ length: 12 }, (_, m) => quarter(2027, m + 1, 15))
    expect(byMonth).toEqual([
      'winter', 'winter', 'spring', 'spring', 'spring', 'summer',
      'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter',
    ])
  })

  it('turns on the first of the month', () => {
    expect([quarter(2027, 5, 31), quarter(2027, 6, 1)]).toEqual(['spring', 'summer'])
    expect([quarter(2027, 8, 31), quarter(2027, 9, 1)]).toEqual(['summer', 'autumn'])
    expect([quarter(2027, 11, 30), quarter(2027, 12, 1)]).toEqual(['autumn', 'winter'])
    expect([quarter(2027, 12, 31), quarter(2028, 1, 1)]).toEqual(['winter', 'winter'])
  })

  it('winter ends with February, on the 28th or the 29th', () => {
    expect([quarter(2027, 2, 28), quarter(2027, 3, 1)]).toEqual(['winter', 'spring'])
    expect([quarter(2028, 2, 28), quarter(2028, 2, 29), quarter(2028, 3, 1)]).toEqual(['winter', 'winter', 'spring'])
  })
})

describe('seasonLookFor: Auto (the date)', () => {
  it('always has a quarter, and a holiday on top on its days', () => {
    expect(look(2027, 7, 14)).toEqual({ holiday: null, quarter: 'summer' })
    expect(look(2026, 12, 25)).toEqual({ holiday: 'christmas', quarter: 'winter' })
    expect(look(2027, 1, 6)).toEqual({ holiday: 'christmas', quarter: 'winter' })
    expect(look(2026, 10, 31)).toEqual({ holiday: 'halloween', quarter: 'autumn' })
    expect(look(2027, 2, 14)).toEqual({ holiday: 'valentine', quarter: 'winter' })
    expect(look(2026, 4, 5)).toEqual({ holiday: 'easter', quarter: 'spring' })
  })
})

describe('seasonLookFor: ?season= in the URL', () => {
  it('a holiday by name is on any day, over the quarter the date is in', () => {
    for (const h of HOLIDAYS) expect(look(2027, 7, 14, `?season=${h}`)).toEqual({ holiday: h, quarter: 'summer' })
    expect(look(2027, 1, 20, '?season=halloween')).toEqual({ holiday: 'halloween', quarter: 'winter' })
  })

  it('a quarter by name shows no holiday, even on Christmas Day', () => {
    for (const q of QUARTERS) expect(look(2026, 12, 25, `?season=${q}`)).toEqual({ holiday: null, quarter: q })
  })

  it('?season=none turns everything off, beside other parameters too', () => {
    expect(look(2026, 12, 25, '?season=none')).toEqual({ holiday: null, quarter: null })
    expect(look(2026, 12, 25, '?sim&season=none')).toEqual({ holiday: null, quarter: null })
  })

  it('a value it does not know says nothing: the date decides', () => {
    for (const unknown of ['midsummer', 'Christmas', 'xmas', 'auto', 'off', '']) {
      expect(look(2026, 12, 25, `?season=${unknown}`)).toEqual({ holiday: 'christmas', quarter: 'winter' })
      expect(look(2027, 7, 14, `?season=${unknown}`)).toEqual({ holiday: null, quarter: 'summer' })
    }
  })
})

describe('seasonLookFor: the stored preference (Settings panel)', () => {
  it('Auto follows the date, as with nothing stored', () => {
    expect(look(2026, 12, 25, '', 'auto')).toEqual({ holiday: 'christmas', quarter: 'winter' })
    expect(look(2027, 7, 14, '', 'auto')).toEqual({ holiday: null, quarter: 'summer' })
  })

  it('a holiday beats the date and keeps the quarter the date is in under it', () => {
    for (const h of HOLIDAYS) expect(look(2027, 7, 14, '', h)).toEqual({ holiday: h, quarter: 'summer' })
    // Halloween picked by hand on Christmas Day: Halloween, not Christmas, over winter
    expect(look(2026, 12, 25, '', 'halloween')).toEqual({ holiday: 'halloween', quarter: 'winter' })
  })

  it('a quarter beats the date and shows no holiday', () => {
    for (const q of QUARTERS) expect(look(2026, 12, 25, '', q)).toEqual({ holiday: null, quarter: q })
  })

  it('Off shows nothing, in December too', () => {
    expect(look(2026, 12, 25, '', 'off')).toEqual({ holiday: null, quarter: null })
  })

  it('the URL beats the stored preference', () => {
    expect(look(2026, 12, 25, '?season=none', 'christmas')).toEqual({ holiday: null, quarter: null })
    expect(look(2027, 7, 14, '?season=christmas', 'off')).toEqual({ holiday: 'christmas', quarter: 'summer' })
    expect(look(2027, 7, 14, '?season=autumn', 'easter')).toEqual({ holiday: null, quarter: 'autumn' })
    expect(look(2027, 7, 14, '?season=easter', 'winter')).toEqual({ holiday: 'easter', quarter: 'summer' })
  })

  it('an unknown ?season= says nothing, so the stored choice decides', () => {
    expect(look(2026, 12, 25, '?season=midsummer', 'off')).toEqual({ holiday: null, quarter: null })
    expect(look(2026, 12, 25, '?season=midsummer', 'spring')).toEqual({ holiday: null, quarter: 'spring' })
  })
})

describe('the page this module loaded in', () => {
  it('has a holiday or none, and a quarter (no URL and nothing stored under node: the date)', () => {
    expect([null, ...HOLIDAYS]).toContain(currentSeason())
    expect(QUARTERS).toContain(currentQuarter())
  })

  it('the Christmas-only pieces ask for Christmas by name, so no other season hangs the advent calendar or hands out Santa hats', () => {
    const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
    expect(src('App.tsx')).toContain("currentSeason() === 'christmas' && <AdventCalendar")
    expect(src('components/Character.tsx')).toContain("currentSeason() === 'christmas' && wearsOverlayHat(")
  })
})

describe('seasonalVariant', () => {
  it('names the copy next to the original, with the season\'s suffix', () => {
    expect(seasonalVariant('/rooms/office-day.png', 'christmas')).toBe('/rooms/office-day-xmas.webp')
    expect(seasonalVariant('/sprites/characters/Claude-1-front-left.png', 'christmas')).toBe('/sprites/characters/Claude-1-front-left-xmas.webp')
    expect(ALL.map(s => seasonalVariant('/rooms/a.png', s))).toEqual([
      '/rooms/a-xmas.webp', '/rooms/a-halloween.webp', '/rooms/a-easter.webp', '/rooms/a-valentine.webp',
      '/rooms/a-spring.webp', '/rooms/a-summer.webp', '/rooms/a-autumn.webp', '/rooms/a-winter.webp',
    ])
  })
})

// ---------------------------------------------------------------------------
// The lookup. The probe test hook stands in for the files in public/: a
// season is "drawn" once its key file (the default day room's copy) exists.
// ---------------------------------------------------------------------------

/** Pretend these seasons have been drawn (their key file exists). */
function drawn(...seasons: Season[]) {
  for (const s of seasons) _setSeasonProbeForTests(seasonalVariant(SEASON_KEY_ART, s), true)
}
/** Pretend these seasons have not (the key file's probe answered no). */
function undrawn(...seasons: Season[]) {
  for (const s of seasons) _setSeasonProbeForTests(seasonalVariant(SEASON_KEY_ART, s), false)
}
/** Let the probes started so far answer (no Image in node: every one says no). */
const probesAnswer = () => new Promise(r => setTimeout(r, 0))

const CHRISTMAS_DAY: SeasonLook = { holiday: 'christmas', quarter: 'winter' }
const NOVEMBER: SeasonLook = { holiday: null, quarter: 'autumn' }
const OFF: SeasonLook = { holiday: null, quarter: null }

describe('seasonalUrl: holiday, then quarter, then the normal art', () => {
  beforeEach(() => _resetSeasonProbesForTests())

  it('on a holiday the holiday copy wins over the quarter copy', () => {
    drawn('christmas', 'winter')
    _setSeasonProbeForTests('/rooms/a-xmas.webp', true)
    _setSeasonProbeForTests('/rooms/a-winter.webp', true)
    expect(seasonalUrl('/rooms/a.png', CHRISTMAS_DAY)).toBe('/rooms/a-xmas.webp')
  })

  it('on a holiday a file with no holiday copy falls back to its quarter copy', () => {
    drawn('christmas', 'winter')
    _setSeasonProbeForTests('/rooms/a-xmas.webp', false)
    _setSeasonProbeForTests('/rooms/a-winter.webp', true)
    expect(seasonalUrl('/rooms/a.png', CHRISTMAS_DAY)).toBe('/rooms/a-winter.webp')
  })

  it('on a holiday a file with neither copy stays itself', () => {
    drawn('christmas', 'winter')
    _setSeasonProbeForTests('/rooms/a-xmas.webp', false)
    _setSeasonProbeForTests('/rooms/a-winter.webp', false)
    expect(seasonalUrl('/rooms/a.png', CHRISTMAS_DAY)).toBe('/rooms/a.png')
  })

  it('a holiday nobody has drawn shows the quarter', () => {
    undrawn('halloween')
    drawn('autumn')
    _setSeasonProbeForTests('/rooms/a-autumn.webp', true)
    expect(seasonalUrl('/rooms/a.png', { holiday: 'halloween', quarter: 'autumn' })).toBe('/rooms/a-autumn.webp')
  })

  it('a holiday that is drawn over a quarter that is not: the holiday copy, else the normal art', () => {
    drawn('christmas')
    undrawn('winter')
    _setSeasonProbeForTests('/rooms/a-xmas.webp', true)
    _setSeasonProbeForTests('/rooms/b-xmas.webp', false)
    expect(seasonalUrl('/rooms/a.png', CHRISTMAS_DAY)).toBe('/rooms/a-xmas.webp')
    expect(seasonalUrl('/rooms/b.png', CHRISTMAS_DAY)).toBe('/rooms/b.png')
  })

  it('outside a holiday: the quarter copy, else the normal art; a holiday copy lying there is not used', () => {
    drawn('christmas', 'autumn')
    _setSeasonProbeForTests('/rooms/a-autumn.webp', true)
    _setSeasonProbeForTests('/rooms/b-autumn.webp', false)
    _setSeasonProbeForTests('/rooms/b-xmas.webp', true)
    expect(seasonalUrl('/rooms/a.png', NOVEMBER)).toBe('/rooms/a-autumn.webp')
    expect(seasonalUrl('/rooms/b.png', NOVEMBER)).toBe('/rooms/b.png')
  })

  it('a quarter picked by hand on Christmas Day shows that quarter and no Christmas', () => {
    drawn('christmas', 'summer', 'winter')
    _setSeasonProbeForTests('/rooms/a-xmas.webp', true)
    _setSeasonProbeForTests('/rooms/a-winter.webp', true)
    _setSeasonProbeForTests('/rooms/a-summer.webp', true)
    const picked = seasonLookFor(at(2026, 12, 25), '?season=summer')
    expect(seasonalUrl('/rooms/a.png', picked)).toBe('/rooms/a-summer.webp')
  })

  it('every season swaps in its own copy', () => {
    for (const s of ALL) {
      _resetSeasonProbesForTests()
      drawn(s)
      _setSeasonProbeForTests(`/rooms/a${SEASON_SUFFIX[s]}.webp`, true)
      const on: SeasonLook = (HOLIDAYS as readonly string[]).includes(s)
        ? { holiday: s as SeasonLook['holiday'], quarter: null }
        : { holiday: null, quarter: s as SeasonLook['quarter'] }
      expect(seasonalUrl('/rooms/a.png', on)).toBe(`/rooms/a${SEASON_SUFFIX[s]}.webp`)
    }
  })

  it('the key file is its own copy: the room swaps on the one probe that says the season is drawn', () => {
    drawn('winter')
    expect(seasonalUrl(SEASON_KEY_ART, { holiday: null, quarter: 'winter' })).toBe('/rooms/office-day-winter.webp')
    expect(_seasonProbesForTests()).toEqual(['/rooms/office-day-winter.webp'])
  })

  it('Off, and anything but a .png, leaves the URL untouched and asks for nothing', () => {
    expect(seasonalUrl('/rooms/a.png', OFF)).toBe('/rooms/a.png')
    expect(seasonalUrl('/sounds/bell.mp3', CHRISTMAS_DAY)).toBe('/sounds/bell.mp3')
    expect(_seasonProbesForTests()).toEqual([])
  })

  it('a copy without its season\'s key file is not looked for: the key file comes first', () => {
    undrawn('autumn')
    _setSeasonProbeForTests('/rooms/a-autumn.webp', true)
    expect(seasonalUrl('/rooms/a.png', NOVEMBER)).toBe('/rooms/a.png')
  })
})

describe('seasonalUrl: with no seasonal art in public/ at all', () => {
  beforeEach(() => _resetSeasonProbesForTests())

  const URLS = [
    '/rooms/office-day.png', '/rooms/office-night.png', '/rooms/office-day-dm.png', '/rooms/office-night-dm.png',
    '/sprites/furniture/standing-desk-left-front.png', '/sprites/decoration/monstera-plant.png',
    '/sprites/characters/Claude-1-front-left.png', '/sprites/office/characters/jim-halpert-rear-right.png',
  ]
  const LOOKS: SeasonLook[] = [
    ...HOLIDAYS.flatMap(h => QUARTERS.map(q => ({ holiday: h, quarter: q }))),
    ...QUARTERS.map(q => ({ holiday: null, quarter: q })),
    OFF,
  ]

  it('every URL resolves to the normal art, in every look, before and after the probes answer', async () => {
    for (let pass = 0; pass < 4; pass++) {
      for (const l of LOOKS) for (const url of URLS) expect(seasonalUrl(url, l)).toBe(url)
      await probesAnswer()
    }
    for (const s of ALL) expect(seasonHasArt(s)).toBe(false)
  })

  it('costs one request per layer, however many images the office draws: the two key files on a holiday', async () => {
    const halloween: SeasonLook = { holiday: 'halloween', quarter: 'autumn' }
    for (let pass = 0; pass < 4; pass++) {
      for (const url of URLS) seasonalUrl(url, halloween)
      await probesAnswer()
    }
    expect(_seasonProbesForTests()).toEqual(['/rooms/office-day-halloween.webp', '/rooms/office-day-autumn.webp'])
  })

  it('and one outside a holiday', async () => {
    for (let pass = 0; pass < 4; pass++) {
      for (const url of URLS) seasonalUrl(url, NOVEMBER)
      await probesAnswer()
    }
    expect(_seasonProbesForTests()).toEqual(['/rooms/office-day-autumn.webp'])
  })
})

describe('seasonalUrl: while probes are in flight', () => {
  beforeEach(() => _resetSeasonProbesForTests())

  it('shows the normal art until a probe answers, and asks for the quarter copy only after the holiday copy said no', async () => {
    drawn('christmas', 'winter')
    expect(seasonalUrl('/rooms/c.png', CHRISTMAS_DAY)).toBe('/rooms/c.png')
    expect(_seasonProbesForTests()).toContain('/rooms/c-xmas.webp')
    expect(_seasonProbesForTests()).not.toContain('/rooms/c-winter.webp')
    await probesAnswer() // no Image in node: the holiday copy's probe says no
    expect(seasonalUrl('/rooms/c.png', CHRISTMAS_DAY)).toBe('/rooms/c.png')
    expect(_seasonProbesForTests()).toContain('/rooms/c-winter.webp')
    await probesAnswer()
    expect(seasonalUrl('/rooms/c.png', CHRISTMAS_DAY)).toBe('/rooms/c.png')
  })

  it('seasonHasArt is null while its key file is being asked about, then the answer', async () => {
    expect(seasonHasArt('spring')).toBeNull()
    await probesAnswer()
    expect(seasonHasArt('spring')).toBe(false)
    drawn('summer')
    expect(seasonHasArt('summer')).toBe(true)
  })
})
