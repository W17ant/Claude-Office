/**
 * seasonNames.ts - the eight seasons' names and the file suffix each one's art carries.
 *
 * "Season" covers two different ideas in the office (src/season.ts layers them):
 *   a holiday   a few days a year: Christmas, Halloween, Easter, Valentine's Day
 *   a quarter   one of the four seasons, so there is always exactly one
 *
 * This is the one list of them. Everything that needs a name or a suffix reads
 * it from here: the date rules and the image lookup (src/season.ts), what the
 * Settings panel may store and `?season=` may say (src/settings.ts), the
 * sprite-name pattern (src/hat.ts), and scripts/check-assets.mjs, which reads
 * SEASON_SUFFIX out of this file with a regex. scripts/walk-cycle.py keeps a
 * copy for `--season`, pinned to this one by tests/walk-cycle-script.test.ts.
 *
 * Why a file of its own: season.ts imports settings.ts (the stored choice), and
 * settings.ts needs the names to validate that choice. A leaf module both can
 * import keeps that from becoming an import cycle.
 */

/** The holidays: each is in force a few days a year and sits on top of the quarter. */
export const HOLIDAYS = ['christmas', 'halloween', 'easter', 'valentine'] as const

/** The four seasons of the year. */
export const QUARTERS = ['spring', 'summer', 'autumn', 'winter'] as const

export type Holiday = (typeof HOLIDAYS)[number]
export type Quarter = (typeof QUARTERS)[number]
/** Anything art can be drawn for: a holiday or a quarter. */
export type Season = Holiday | Quarter

/**
 * File-name suffix each season's art carries (before the .webp extension).
 * Why `-xmas` and not `-christmas`: the Christmas art shipped with that suffix
 * before the other seasons existed; renaming ~300 files would buy nothing.
 * Keep this a flat literal of quoted suffixes: scripts/check-assets.mjs parses it.
 */
export const SEASON_SUFFIX: Record<Season, string> = {
  christmas: '-xmas',
  halloween: '-halloween',
  easter: '-easter',
  valentine: '-valentine',
  spring: '-spring',
  summer: '-summer',
  autumn: '-autumn',
  winter: '-winter',
}

/**
 * Every suffix as a regular-expression alternation (`-xmas|-halloween|…`), for
 * code that takes a sprite's file name apart (src/hat.ts).
 */
export const SEASON_SUFFIX_PATTERN = Object.values(SEASON_SUFFIX)
  .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

/** Whether `name` is one of the holidays. */
export function isHoliday(name: string): name is Holiday {
  return (HOLIDAYS as readonly string[]).includes(name)
}

/** Whether `name` is one of the four seasons. */
export function isQuarter(name: string): name is Quarter {
  return (QUARTERS as readonly string[]).includes(name)
}
