/** hat.ts - finding a sprite's head from its alpha channel. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { headAnchorFromAlpha, wearsOverlayHat } from '../src/hat'
import { SEASON_SUFFIX } from '../src/seasonNames'

/** An alpha map of w x h with opaque rectangles [x0, y0, x1, y1) */
function alphaWith(w: number, h: number, rects: Array<[number, number, number, number]>) {
  const a = new Uint8Array(w * h)
  for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255
  return a
}

describe('headAnchorFromAlpha', () => {
  it('top of the hair is the first opaque row; the head span is measured 8% of the height below it', () => {
    // 100 x 200: a 4-px tuft at the top, the head 40..60 wide from y 10, a wide body lower down
    const a = alphaWith(100, 200, [[48, 2, 52, 10], [40, 10, 60, 60], [20, 60, 80, 200]])
    expect(headAnchorFromAlpha(a, 100, 200)).toEqual({ x: 0.5, top: 0.01, width: 0.2 })
  })

  it('ignores half-transparent outline pixels', () => {
    const a = alphaWith(10, 10, [[2, 5, 8, 10]])
    a[0] = 100 // a faint speck above the head
    expect(headAnchorFromAlpha(a, 10, 10)?.top).toBe(0.5)
  })

  it('an empty image has no head', () => {
    expect(headAnchorFromAlpha(new Uint8Array(100), 10, 10)).toBeNull()
  })

  it('the hat it is drawn from exists', () => {
    expect(readFileSync(new URL('../public/sprites/effects/santa-hat.png', import.meta.url)).length).toBeGreaterThan(1000)
  })
})

describe('wearsOverlayHat', () => {
  it('everyone gets the hat, jumper or not, except the NO_HAT list (ponytails, big hair, own festive hat)', () => {
    expect(wearsOverlayHat('/sprites/characters/dev-1-front-left.png')).toBe(true)
    expect(wearsOverlayHat('/sprites/characters/dev-1-front-left-xmas.webp')).toBe(true)
    expect(wearsOverlayHat('/sprites/office/characters/jim-halpert-rear-right.png')).toBe(true)
    expect(wearsOverlayHat('/sprites/characters/Claude-1-front-left-xmas.webp')).toBe(false)
    expect(wearsOverlayHat('/sprites/characters/Me-1-rear-right-xmas.webp')).toBe(false)
    expect(wearsOverlayHat('/sprites/characters/employee-2-front-right.png')).toBe(false)
    expect(wearsOverlayHat('/sprites/office/characters/erin-hannon-rear-left.png')).toBe(false)
    expect(wearsOverlayHat('/sprites/characters/Me-1-front-left.png')).toBe(false)
  })

  it('knows a character in any season\'s copy: at Christmas a sprite may be showing its winter one', () => {
    for (const suffix of Object.values(SEASON_SUFFIX)) {
      expect(wearsOverlayHat(`/sprites/characters/dev-1-front-left${suffix}.webp`)).toBe(true)
      expect(wearsOverlayHat(`/sprites/characters/Claude-1-rear-left${suffix}.webp`)).toBe(false)
      expect(wearsOverlayHat(`/sprites/office/characters/erin-hannon-front-right${suffix}.webp`)).toBe(false)
    }
  })

  it('a suffix that is no season is not taken off the name', () => {
    // "Claude-1-front-left-midsummer" is then the character's name, and nobody by that name is in NO_HAT
    expect(wearsOverlayHat('/sprites/characters/Claude-1-front-left-midsummer.webp')).toBe(true)
  })
})
