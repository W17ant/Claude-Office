/** hat.ts - finding a sprite's head from its alpha channel. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HALLOWEEN_PIECE_SRCS, SANTA_HAT, WITCH_HAT, halloweenPiece, hatKindOf, hatMirrored, hatOnHead, pieceTransform, headAnchorFromAlpha, maskOnEyes, spriteKey, wearsOverlayHat } from '../src/hat'
import { HAT_FIT } from '../src/hatFit'
import { EYES } from '../src/eyes'
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

describe('halloweenPiece', () => {
  it('the leads in full costume wear nothing on top: Claude, the boss, Michael, Dwight, Jim and Pam', () => {
    for (const name of ['Claude-1', 'Me-1']) expect(halloweenPiece(`/sprites/characters/${name}-front-left-halloween.webp`)).toBeNull()
    for (const name of ['michael-scott', 'dwight-schrute', 'jim-halpert', 'pam-beesly']) {
      expect(halloweenPiece(`/sprites/office/characters/${name}-rear-right.png`)).toBeNull()
    }
  })

  it('everyone else gets a hat or a mask, the same one on every sprite and in every season copy', () => {
    const piece = halloweenPiece('/sprites/characters/dev-1-front-left.png')
    expect(piece).not.toBeNull()
    for (const src of ['/sprites/characters/dev-1-rear-right.png', '/sprites/characters/dev-1-front-right-autumn.webp']) {
      expect(halloweenPiece(src)).toEqual(piece)
    }
  })

  it('a character a hat sits wrong on (NO_HAT: ponytails, big hair) gets a mask, never the hat', () => {
    for (const name of ['employee-2', 'Frontend-dev-1']) expect(halloweenPiece(`/sprites/characters/${name}-front-left.png`)?.kind).toBe('mask')
    expect(halloweenPiece('/sprites/office/characters/erin-hannon-front-left.png')?.kind).toBe('mask')
  })

  it('both casts get a mix: the hat and more than one mask', () => {
    const cast = ['dev-1', 'dev-2', 'employee-1', 'employee-3', 'explore-1', 'security-audit-1', 'andy-bernard', 'angela-martin', 'kevin-malone', 'oscar-martinez', 'stanley-hudson', 'creed-bratton', 'kelly-kapoor', 'ryan-howard', 'toby-flenderson', 'phyllis-vance']
    const srcs = new Set(cast.map(n => halloweenPiece(`/sprites/x/${n}-front-left.png`)!.src))
    expect(srcs.size).toBeGreaterThanOrEqual(4)
  })

  it('every piece it can pick exists', () => {
    for (const src of HALLOWEEN_PIECE_SRCS) expect(readFileSync(new URL(`../public${src}`, import.meta.url)).length).toBeGreaterThan(1000)
  })
})

describe('maskOnEyes', () => {
  const mask = { kind: 'mask' as const, src: '/x.png', scale: 1, offset: 0, eyes: { x: 0.6, y: 0.5, spacing: 0.4 } }

  it('puts the mask\'s eye holes on the eyes, sized so the holes are as far apart as the pupils', () => {
    expect(maskOnEyes(mask, { x: 0.5, y: 0.2, spacing: 0.2 }, false)).toEqual({ left: 0.5, top: 0.2, width: 0.5, shiftX: -0.6, shiftY: -0.5, rot: 0 })
  })

  it('a mask with a size factor grows around its holes (the holes stay on the eyes)', () => {
    const big = { ...mask, eyes: { ...mask.eyes, size: 1.2 } }
    expect(maskOnEyes(big, { x: 0.5, y: 0.2, spacing: 0.2 }, false)).toEqual({ left: 0.5, top: 0.2, width: 0.6, shiftX: -0.6, shiftY: -0.5, rot: 0 })
  })

  it('a width set by hand in the eye table (/?maskhelper) wins over the one worked out from the spacing', () => {
    expect(maskOnEyes(mask, { x: 0.5, y: 0.2, spacing: 0.2, width: 0.62 }, false)!.width).toBe(0.62)
  })

  it('a sprite facing right wears it mirrored, so the holes flip with it', () => {
    expect(maskOnEyes(mask, { x: 0.5, y: 0.2, spacing: 0.2 }, true)!.shiftX).toBeCloseTo(-0.4)
  })

  it('stays a sensible size, and without eye data the head placement is used instead (null)', () => {
    expect(maskOnEyes(mask, { x: 0.5, y: 0.2, spacing: 0.9 }, false)!.width).toBe(0.75)
    expect(maskOnEyes(mask, { x: 0.5, y: 0.2, spacing: 0.01 }, false)!.width).toBe(0.35)
    expect(maskOnEyes(mask, undefined, false)).toBeNull()
  })

  it('every listed eye line is on the face: in the top half, inside the sprite', () => {
    for (const [name, e] of Object.entries(EYES)) {
      expect(e.y, name).toBeGreaterThan(0.05)
      expect(e.y, name).toBeLessThan(0.4)
      expect(e.x, name).toBeGreaterThan(0.1)
      expect(e.x, name).toBeLessThan(0.9)
    }
  })
})

describe('hatOnHead', () => {
  const head = { x: 0.5, top: 0.1, width: 0.4 }
  const hat = { kind: 'hat' as const, src: '/x.png', scale: 1.5, offset: 0.1 }

  it('centres the hat on the head, scale times its width, its bottom edge offset below the top of the hair', () => {
    const on = hatOnHead(head, hat)
    expect(on.width).toBeCloseTo(0.6)
    expect(on.left).toBeCloseTo(0.2)
    expect(on.bottom).toBeCloseTo(0.8)
  })

  it('a hand-set nudge moves it (down is positive) and sizes it about its centre', () => {
    const on = hatOnHead(head, hat, { dx: 0.05, dy: 0.02, size: 0.5 })
    expect(on.width).toBeCloseTo(0.3)
    expect(on.left).toBeCloseTo(0.55 - 0.15)
    expect(on.bottom).toBeCloseTo(0.78)
  })
})

describe('the hand-set tables', () => {
  it('a sprite is keyed without its folder, extension or season suffix', () => {
    expect(spriteKey('/sprites/characters/dev-1-front-left.png')).toBe('dev-1-front-left')
    expect(spriteKey('/sprites/office/characters/kevin-malone-rear-right-xmas.webp')).toBe('kevin-malone-rear-right')
    expect(spriteKey('/sprites/characters/dev-1-front-left-winter.webp')).toBe('dev-1-front-left')
  })

  it('each hat has its own table; a mask has none', () => {
    expect(hatKindOf(SANTA_HAT)).toBe('santa')
    expect(hatKindOf(WITCH_HAT)).toBe('witch')
    expect(hatKindOf(halloweenPiece('/sprites/characters/employee-2-front-left.png')!)).toBeNull()
  })

  it('every hat nudge is a small move on a real sprite name', () => {
    for (const table of Object.values(HAT_FIT)) {
      for (const [key, n] of Object.entries(table)) {
        expect(key, key).toMatch(/-(front|rear)-(left|right)$/)
        expect(Math.abs(n.dx), key).toBeLessThan(0.3)
        expect(Math.abs(n.dy), key).toBeLessThan(0.3)
        expect(n.size, key).toBeGreaterThan(0.4)
        expect(n.size, key).toBeLessThan(2.5)
      }
    }
  })
})

describe('hatMirrored', () => {
  it('a hat is mirrored with a sprite facing right', () => {
    expect(hatMirrored(WITCH_HAT, false, false)).toBe(false)
    expect(hatMirrored(WITCH_HAT, true, false)).toBe(true)
    expect(hatMirrored(WITCH_HAT, true, true)).toBe(true)
  })

  it('the Santa hat goes the other way round while the face shows, so its bobble hangs at the back of the head', () => {
    expect(hatMirrored(SANTA_HAT, false, false)).toBe(true)
    expect(hatMirrored(SANTA_HAT, true, false)).toBe(false)
    // from behind it was already at the back
    expect(hatMirrored(SANTA_HAT, false, true)).toBe(false)
    expect(hatMirrored(SANTA_HAT, true, true)).toBe(true)
  })
})

describe('pieceTransform', () => {
  it('shifts a mask onto the eyes, tilts it in screen terms, then mirrors the art', () => {
    expect(pieceTransform({ shiftX: -0.6, shiftY: -0.5, rot: 4 }, true)).toBe('translate(-60%, -50%) rotate(4deg) scaleX(-1)')
  })

  it('a hat with no tilt facing left needs no transform', () => {
    expect(pieceTransform({ rot: 0 }, false)).toBeUndefined()
    expect(pieceTransform({ rot: -3 }, false)).toBe('rotate(-3deg)')
  })

  it('a hand-set tilt travels from the tables', () => {
    expect(hatOnHead({ x: 0.5, top: 0.1, width: 0.4 }, WITCH_HAT, { dx: 0, dy: 0, size: 1, rot: 5 }).rot).toBe(5)
    const mask = { kind: 'mask' as const, src: '/x.png', scale: 1, offset: 0, eyes: { x: 0.6, y: 0.5, spacing: 0.4 } }
    expect(maskOnEyes(mask, { x: 0.5, y: 0.2, spacing: 0.2, rot: -2 }, false)!.rot).toBe(-2)
  })
})
