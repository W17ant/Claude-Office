/** walk.ts - the four-frame walk cycle chosen while a character moves. */
import { describe, expect, it } from 'vitest'
import { WALK_FRAME_MS, _setWalkFrameForTests, walkFrame, walkFramePaths } from '../src/walk'
import { SEASON_SUFFIX } from '../src/seasonNames'

const SRC = '/sprites/characters/X-1-front-left.png'

describe('walkFrame', () => {
  it('names the four walk frames beside a standing sprite, festive copies included', () => {
    expect(walkFramePaths(SRC)).toEqual([1, 2, 3, 4].map(k => `/sprites/characters/X-1-front-left-walk${k}.webp`))
    expect(walkFramePaths('/sprites/characters/X-1-front-left-xmas.webp')).toEqual([1, 2, 3, 4].map(k => `/sprites/characters/X-1-front-left-xmas-walk${k}.webp`))
    expect(walkFramePaths('/sprites/characters/X-1-front-left-walk1.webp')).toBeNull()
    expect(walkFramePaths('/sprites/characters/X-1-front-left-xmas-walk4.webp')).toBeNull()
  })

  it('a seasonal copy has frames of its own beside it, whatever the season', () => {
    for (const suffix of Object.values(SEASON_SUFFIX)) {
      const copy = `/sprites/characters/X-1-front-left${suffix}.webp`
      const frames = [1, 2, 3, 4].map(k => `/sprites/characters/X-1-front-left${suffix}-walk${k}.webp`)
      expect(walkFramePaths(copy)).toEqual(frames)
      expect(walkFramePaths(frames[0])).toBeNull()
      // Stepping in that outfit loops its own frames, never the everyday ones
      for (const f of frames) _setWalkFrameForTests(f, true)
      expect(walkFrame(copy, true, WALK_FRAME_MS + 1)).toBe(frames[1])
    }
  })

  it('loops the four frames while stepping, never the standing pose, once all exist', () => {
    const frames = walkFramePaths(SRC)!
    for (const f of frames) _setWalkFrameForTests(f, true)
    expect([0, 1, 2, 3, 4].map(k => walkFrame(SRC, true, k * WALK_FRAME_MS + 1))).toEqual([...frames, frames[0]])
  })

  it('stands still when not stepping, and glides when any frame is missing', () => {
    expect(walkFrame(SRC, false, WALK_FRAME_MS + 1)).toBe(SRC)
    const other = '/sprites/characters/Y-1-rear-left.png'
    const frames = walkFramePaths(other)!
    for (const f of frames.slice(0, 3)) _setWalkFrameForTests(f, true) // walk4 unknown / missing
    expect(walkFrame(other, true, WALK_FRAME_MS + 1)).toBe(other)
  })
})
