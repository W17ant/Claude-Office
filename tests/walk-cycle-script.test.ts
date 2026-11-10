/** scripts/walk-cycle.py - README › Make it walk: the prompt and commands it documents are the script's own. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WALK_FRAMES, walkFramePaths } from '../src/walk'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = `${ROOT}scripts/walk-cycle.py`
const README = readFileSync(`${ROOT}README.md`, 'utf8')

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
})
