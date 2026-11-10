/** advent.ts - what the office advent calendar shows on a given day. */
import { describe, expect, it } from 'vitest'
import { adventDate, adventFor, adventLabel } from '../src/advent'

const on = (m: number, d: number, y = 2026) => new Date(y, m - 1, d)

describe('adventFor', () => {
  it('1-24 December: doors open up to today, sleeps count down to Christmas Day', () => {
    expect(adventFor(on(12, 1))).toEqual({ kind: 'advent', day: 1, sleeps: 24 })
    expect(adventFor(on(12, 12))).toEqual({ kind: 'advent', day: 12, sleeps: 13 })
    expect(adventFor(on(12, 24))).toEqual({ kind: 'advent', day: 24, sleeps: 1 })
  })

  it('Christmas Day, then a countdown to the New Year, then the New Year until Twelfth Night', () => {
    expect(adventFor(on(12, 25))).toEqual({ kind: 'christmas' })
    expect(adventFor(on(12, 26))).toEqual({ kind: 'new-year-countdown', days: 6, year: 2027 })
    expect(adventFor(on(12, 31))).toEqual({ kind: 'new-year-countdown', days: 1, year: 2027 })
    expect(adventFor(on(1, 1, 2027))).toEqual({ kind: 'new-year', year: 2027 })
    expect(adventFor(on(1, 6, 2027))).toEqual({ kind: 'new-year', year: 2027 })
  })

  it('is not up the rest of the year', () => {
    expect(adventFor(on(1, 7))).toBeNull()
    expect(adventFor(on(11, 30))).toBeNull()
    expect(adventFor(on(7, 15))).toBeNull()
  })
})

describe('adventDate and adventLabel', () => {
  it('?advent=YYYY-MM-DD draws any day; anything else is today', () => {
    const now = on(7, 15)
    expect(adventDate(now, '?season=christmas&advent=2026-12-24')).toEqual(on(12, 24))
    expect(adventDate(now, '?advent=christmas')).toBe(now)
    expect(adventDate(now, '')).toBe(now)
  })

  it('says it in words on hover, singular on the last night', () => {
    expect(adventLabel({ kind: 'advent', day: 12, sleeps: 13 })).toBe('Advent calendar: 13 sleeps till Christmas')
    expect(adventLabel({ kind: 'advent', day: 24, sleeps: 1 })).toBe('Advent calendar: 1 sleep till Christmas!')
    expect(adventLabel({ kind: 'new-year', year: 2027 })).toBe('Happy New Year 2027!')
  })
})
