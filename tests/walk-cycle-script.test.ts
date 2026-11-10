/** scripts/walk-cycle.py - README › Make it walk: the prompt and commands it documents are the script's own. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WALK_FRAMES, walkFramePaths } from '../src/walk'
import { SEASON_SUFFIX } from '../src/seasonNames'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = `${ROOT}scripts/walk-cycle.py`
const README = readFileSync(`${ROOT}README.md`, 'utf8')

/** Run the script's `prompt` command (needs neither Pillow nor numpy). */
const prompt = (...options: string[]) => spawnSync('python3', ['-I', SCRIPT, 'prompt', ...options], { encoding: 'utf8' })

describe('walk-cycle.py', () => {
  it('the prompt in the README is the one the script prints (no Pillow or numpy needed for it)', () => {
    const run = spawnSync('python3', ['-I', SCRIPT, 'prompt'], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    const quoted = /<summary>The walk-cycle prompt<\/summary>\s*\n\s*> (.+)\n/.exec(README)
    expect(quoted?.[1]).toBe(run.stdout.trim())
  })

  it('the README runs its prepare and cut commands, and the frames it writes are the ones the office loads', () => {
    expect(README).toContain('python3 scripts/walk-cycle.py prepare MyChar-1')
    expect(README).toContain('python3 scripts/walk-cycle.py cut your-walk-sheet.png MyChar-1')
    const script = readFileSync(SCRIPT, 'utf8')
    // The script writes walk1 .. walk4 (k + 1 for 4 figures a row); walk.ts asks for WALK_FRAMES of them
    expect(script).toContain('-walk{k + 1}.webp')
    expect(script).toMatch(/expected 4 figures in its row/)
    expect(WALK_FRAMES).toBe(4)
    expect(walkFramePaths('/sprites/characters/MyChar-1-front-left.png')?.at(-1)).toBe('/sprites/characters/MyChar-1-front-left-walk4.webp')
  })

  it('its seasons and their file suffixes are the office\'s own (src/seasonNames.ts)', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    const table = /^SEASON_SUFFIX = \{([^}]*)\}/m.exec(script)?.[1] ?? ''
    const pairs = [...table.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(m => [m[1], m[2]])
    expect(Object.fromEntries(pairs)).toEqual(SEASON_SUFFIX)
    // A seasonal copy is read as <name>-<dir><suffix>.webp and its frames written beside it
    expect(script).toContain('f"{name}-{d}{SEASON_SUFFIX[season]}.webp"')
    expect(script).toContain('f"{name}-{d}{suffix}-walk{k + 1}.webp"')
  })

  it('--festive still works, and is --season christmas', () => {
    const festive = prompt('--festive')
    expect(festive.status).toBe(0)
    expect(festive.stdout).toContain('Keep the Christmas outfit exactly as it is')
    expect(festive.stdout.startsWith(prompt().stdout.trim())).toBe(true)
    expect(prompt('--season', 'christmas').stdout).toBe(festive.stdout)
    expect(prompt('--festive', '--season', 'christmas').stdout).toBe(festive.stdout)
    expect(README).toContain('`--festive`')
  })

  it('--season NAME takes every season, pins that outfit in the prompt, and refuses anything else', () => {
    const plain = prompt().stdout.trim()
    for (const season of Object.keys(SEASON_SUFFIX)) {
      const run = prompt('--season', season)
      expect([season, run.status]).toEqual([season, 0])
      expect(run.stdout.startsWith(plain)).toBe(true)
      expect(run.stdout).toMatch(/Keep the [A-Za-z' ]+ outfit exactly as it is/)
    }
    expect(prompt('--season', 'autumn').stdout).toContain('Keep the autumn outfit')
    expect(prompt('--season', 'midsummer').status).not.toBe(0)
    // Two different seasons at once is a mistake, not a choice the script makes for you
    const both = prompt('--festive', '--season', 'winter')
    expect(both.status).not.toBe(0)
    expect(both.stderr).toContain('--festive means --season christmas')
    expect(README).toContain('`--season')
  })
})
