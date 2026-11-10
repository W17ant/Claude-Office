/**
 * advent.ts - what the office advent calendar shows on a given day.
 *
 * Through the Christmas season (season.ts: 1 December to 6 January) an advent
 * calendar hangs on the back wall (AdventCalendar.tsx): 24 doors opened up to
 * today and "N sleeps" to Christmas, Christmas Day itself, then a countdown to
 * the New Year, then the New Year until the decorations come down.
 */

export type AdventState =
  /** 1-24 December: doors 1..`day` are open, `sleeps` nights until Christmas Day */
  | { kind: 'advent'; day: number; sleeps: number }
  /** 25 December: every door open */
  | { kind: 'christmas' }
  /** 26-31 December: `days` until 1 January of `year` */
  | { kind: 'new-year-countdown'; days: number; year: number }
  /** 1-6 January: the New Year has arrived */
  | { kind: 'new-year'; year: number }

/** Doors on the calendar: one a day up to Christmas Eve. */
export const ADVENT_DOORS = 24

/**
 * The calendar for local date `now`, or null outside 1 December to 6 January.
 * @param now the local date (only its year, month and day are read)
 */
export function adventFor(now: Date): AdventState | null {
  const month = now.getMonth() // 0 = January
  const day = now.getDate()
  if (month === 11 && day <= ADVENT_DOORS) return { kind: 'advent', day, sleeps: 25 - day }
  if (month === 11 && day === 25) return { kind: 'christmas' }
  if (month === 11) return { kind: 'new-year-countdown', days: 32 - day, year: now.getFullYear() + 1 }
  // Why 6: Twelfth Night, the same end as season.ts
  if (month === 0 && day <= 6) return { kind: 'new-year', year: now.getFullYear() }
  return null
}

/**
 * The date the calendar is drawn for: `?advent=YYYY-MM-DD` (to see any day of
 * it, e.g. with `?season=christmas` in July), else `now`.
 */
export function adventDate(now: Date, search: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(new URLSearchParams(search).get('advent') ?? '')
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : now
}

/** What the calendar says when hovered. */
export function adventLabel(s: AdventState): string {
  switch (s.kind) {
    case 'advent': return s.sleeps === 1 ? 'Advent calendar: 1 sleep till Christmas!' : `Advent calendar: ${s.sleeps} sleeps till Christmas`
    case 'christmas': return 'Merry Christmas!'
    case 'new-year-countdown': return s.days === 1 ? `1 day till ${s.year}` : `${s.days} days till ${s.year}`
    case 'new-year': return `Happy New Year ${s.year}!`
  }
}
