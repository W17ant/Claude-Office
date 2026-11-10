/** walk.ts - stride frames chosen while a character moves. */
import { describe, expect, it } from 'vitest'
import { WALK_FRAME_MS, _setWalkFrameForTests, walkFrame, walkFramePaths } from '../src/walk'

const SRC = '/sprites/characters/X-1-front-left.png'

describe('walkFrame', () => {
  it('names the two stride frames beside a standing sprite, festive copies included', () => {
    expect(walkFramePaths(SRC)).toEqual(['/sprites/characters/X-1-front-left-walk1.webp', '/sprites/characters/X-1-front-left-walk2.webp'])
    expect(walkFramePaths('/sprites/characters/X-1-front-left-xmas.webp')).toEqual(['/sprites/characters/X-1-front-left-xmas-walk1.webp', '/sprites/characters/X-1-front-left-xmas-walk2.webp'])
    expect(walkFramePaths('/sprites/characters/X-1-front-left-walk1.webp')).toBeNull()
  })

  it('cycles stand, stride 1, stand, stride 2 while stepping, once both frames exist', () => {
    const [a, b] = walkFramePaths(SRC)!
    _setWalkFrameForTests(a, true)
    _setWalkFrameForTests(b, true)
    expect([0, 1, 2, 3].map(k => walkFrame(SRC, true, k * WALK_FRAME_MS + 1))).toEqual([SRC, a, SRC, b])
  })

  it('stands still when not stepping, and glides when a frame is missing', () => {
    expect(walkFrame(SRC, false, WALK_FRAME_MS + 1)).toBe(SRC)
    const other = '/sprites/characters/Y-1-rear-left.png'
    const [a] = walkFramePaths(other)!
    _setWalkFrameForTests(a, true) // walk2 unknown / missing
    expect(walkFrame(other, true, WALK_FRAME_MS + 1)).toBe(other)
  })
})
