/**
 * settings.test.ts - the page's remembered preferences (src/settings.ts:
 * sound, season, day/night) and the Today popover's rows (src/recap.ts).
 */

import { describe, expect, it } from 'vitest'
import {
  readSound, saveVolume, saveMuted, readSeasonPreference, saveSeasonPreference, seasonFromUrl,
  readDayNightMode, saveDayNightMode, DEFAULT_VOLUME, VOLUME_KEY, MUTED_KEY, SEASON_KEY, DAY_NIGHT_KEY,
  SEASON_PREFERENCES, type PrefStorage,
} from '../src/settings'
import { HOLIDAYS, QUARTERS } from '../src/seasonNames'
import { recapRows, formatUsd, type RecapStats } from '../src/recap'

/** An in-memory Storage. */
function memory(initial: Record<string, string> = {}): PrefStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) } }
}

/** A Storage that throws on every access (a private window, blocked site data). */
const blocked: PrefStorage = {
  getItem() { throw new Error('SecurityError') },
  setItem() { throw new Error('QuotaExceededError') },
}

describe('sound', () => {
  it('defaults to half volume, not muted', () => {
    expect(readSound(memory())).toEqual({ volume: DEFAULT_VOLUME, muted: false })
  })

  it('round-trips the volume and the mute flag separately', () => {
    const s = memory()
    saveVolume(0.8, s)
    saveMuted(true, s)
    expect(s.data).toEqual({ [VOLUME_KEY]: '0.8', [MUTED_KEY]: '1' })
    expect(readSound(s)).toEqual({ volume: 0.8, muted: true })
    saveMuted(false, s)
    expect(readSound(s)).toEqual({ volume: 0.8, muted: false })
  })

  it('never stores 0 or an out-of-range level (unmuting must not be silent)', () => {
    const s = memory()
    saveVolume(0.3, s)
    saveVolume(0, s)
    saveVolume(1.5, s)
    saveVolume(Number.NaN, s)
    expect(readSound(s).volume).toBe(0.3)
  })

  it('reads junk as the default', () => {
    for (const junk of ['0', '-1', '2', 'loud', '']) {
      expect(readSound(memory({ [VOLUME_KEY]: junk })).volume).toBe(DEFAULT_VOLUME)
    }
  })

  it('a storage that throws falls back to the defaults and swallows writes', () => {
    expect(readSound(blocked)).toEqual({ volume: DEFAULT_VOLUME, muted: false })
    expect(() => { saveVolume(0.7, blocked); saveMuted(true, blocked) }).not.toThrow()
    expect(readSound(null)).toEqual({ volume: DEFAULT_VOLUME, muted: false })
  })
})

describe('season preference', () => {
  it('offers Auto, the four holidays, the four seasons and Off', () => {
    expect(SEASON_PREFERENCES).toEqual([
      'auto', 'christmas', 'halloween', 'easter', 'valentine', 'spring', 'summer', 'autumn', 'winter', 'off',
    ])
  })

  it('defaults to auto, round-trips every choice, and ignores junk', () => {
    const s = memory()
    expect(readSeasonPreference(s)).toBe('auto')
    for (const pref of SEASON_PREFERENCES) {
      saveSeasonPreference(pref, s)
      expect(s.data[SEASON_KEY]).toBe(pref)
      expect(readSeasonPreference(s)).toBe(pref)
    }
    // SEASON_PREFERENCES ends with Off: a junk write after it changes nothing
    saveSeasonPreference('midsummer' as never, s)
    expect(readSeasonPreference(s)).toBe('off')
    expect(readSeasonPreference(memory({ [SEASON_KEY]: 'midsummer' }))).toBe('auto')
    // The suffix is not the name, and the URL's word for off is not the stored one
    expect(readSeasonPreference(memory({ [SEASON_KEY]: 'xmas' }))).toBe('auto')
    expect(readSeasonPreference(memory({ [SEASON_KEY]: 'none' }))).toBe('auto')
    expect(readSeasonPreference(blocked)).toBe('auto')
  })

  it('seasonFromUrl maps ?season=<a holiday or season> and none, and nothing else', () => {
    for (const name of [...HOLIDAYS, ...QUARTERS]) expect(seasonFromUrl(`?season=${name}`)).toBe(name)
    expect(seasonFromUrl('?sim&season=halloween')).toBe('halloween')
    expect(seasonFromUrl('?sim&season=none')).toBe('off')
    for (const unknown of ['off', 'auto', 'midsummer', 'Christmas', 'xmas', '']) expect(seasonFromUrl(`?season=${unknown}`)).toBeNull()
    expect(seasonFromUrl('?sim')).toBeNull()
    expect(seasonFromUrl('')).toBeNull()
  })
})

describe('day / night mode', () => {
  it('defaults to auto and round-trips day and night', () => {
    const s = memory()
    expect(readDayNightMode(s)).toBe('auto')
    saveDayNightMode('night', s)
    expect(s.data[DAY_NIGHT_KEY]).toBe('night')
    expect(readDayNightMode(s)).toBe('night')
    saveDayNightMode('dusk' as never, s)
    expect(readDayNightMode(s)).toBe('night')
    expect(readDayNightMode(memory({ [DAY_NIGHT_KEY]: 'noon' }))).toBe('auto')
    expect(readDayNightMode(blocked)).toBe('auto')
  })
})

describe('the Today popover rows (src/recap.ts)', () => {
  const day: RecapStats = {
    date: '2026-11-09', sessions: 2, agentsSpawned: 3, agentsCompleted: 3, tasksCompleted: 0,
    deploys: 1, buildsFailed: 0, testsFailed: 2, pushes: 0, incidents: 1, costUsd: 3.456,
  }

  it('one row per count, in reading order, zeros dim and failures red', () => {
    const rows = recapRows(day)
    expect(rows.map(r => [r.label, r.value, r.tone])).toEqual([
      ['Sessions', '2', 'plain'],
      ['Agents hired', '3', 'plain'],
      ['Clocked out', '3', 'plain'],
      ['Tasks closed', '0', 'dim'],
      ['Deploys', '1', 'good'],
      ['Pushes', '0', 'dim'],
      ['Failed builds', '0', 'dim'],
      ['Failed test runs', '2', 'bad'],
      ['Incidents', '1', 'bad'],
      ['Payroll', '$3.46', 'plain'],
    ])
  })

  it('formatUsd keeps a sub-cent day visible', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('$0.004')
    expect(formatUsd(12.5)).toBe('$12.50')
  })
})
