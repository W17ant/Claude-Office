/**
 * hat.ts - where a Santa hat sits on a character sprite, measured from the sprite itself.
 *
 * Every character (the default cast, the Dunder Mifflin cast, a custom boss)
 * gets the same hat in December, so instead of a hand-made position per
 * sprite the head is found from the image's own pixels: the first opaque row
 * is the top of the hair, and the opaque span a little below it is the head.
 * One measurement per sprite file, cached; it needs a same-origin image (all
 * sprites are under public/).
 */

import { useEffect, useState } from 'react'
import { SEASON_SUFFIX_PATTERN } from './seasonNames'
import type { EyeLine } from './eyes'
import type { HatKind, HatNudge } from './hatFit'

export const HAT_SRC = '/sprites/effects/santa-hat.png'

// Why: on a ponytail, a bun or big hair the one-size hat sits wrong (judged
// on all four directions of every cast sprite), so those characters go
// without; Claude's elf costume and the boss's festive sprite already have a
// hat of their own
const NO_HAT = new Set(['employee-2', 'erin-hannon', 'Frontend-dev-1', 'Me-1', 'Claude-1'])

// A standing sprite's file name after the character's base name: the facing,
// then `.png` or a seasonal copy's `<suffix>.webp`. Why every suffix and not
// only -xmas: at Christmas a sprite with no jumper of its own falls back to
// its winter copy (src/season.ts), and it must still be recognised.
const FACING_AND_SEASON = new RegExp(`-(front|rear)-(left|right)((${SEASON_SUFFIX_PATTERN})\\.webp|\\.png)$`)

/**
 * Whether a sprite gets the overlay hat. A seasonal copy (a Christmas jumper
 * `-xmas.webp`, a winter coat `-winter.webp`) still does; the characters in
 * NO_HAT never do. Whether it is Christmas at all is the caller's question.
 * @param src the standing sprite URL being drawn
 * @returns false for the characters in NO_HAT, true for everyone else
 */
export function wearsOverlayHat(src: string): boolean {
  const file = src.slice(src.lastIndexOf('/') + 1)
  return !NO_HAT.has(file.replace(FACING_AND_SEASON, ''))
}

// ---------------------------------------------------------------------------
// Halloween: a witch hat or a mask for everyone not in a full costume
// ---------------------------------------------------------------------------

/**
 * Characters with a whole Halloween costume of their own (`-halloween` copies
 * of every sprite): Claude the vampire, the boss the wizard, and the Dunder
 * Mifflin leads (Michael's monster, Dwight's dark lord, Jim's three-hole
 * punch, Pam's cat). Nothing is worn on top of those.
 */
const FULL_HALLOWEEN_COSTUME = new Set(['Claude-1', 'Me-1', 'michael-scott', 'dwight-schrute', 'jim-halpert', 'pam-beesly'])

/** Something worn over a sprite at Halloween, placed from the measured head. */
export interface HalloweenPiece {
  /** A hat sits on the hair (bottom edge at the forehead); a mask covers the face (top edge at the hair) */
  kind: 'hat' | 'mask'
  src: string
  /** Width as a multiple of the measured head width */
  scale: number
  /**
   * A hat: how far below the top of the hair its bottom edge sits; a mask:
   * how far below the top of the hair its top edge sits. Fractions of the
   * sprite's height, like HeadAnchor.top.
   */
  offset: number
  /**
   * A mask's eye holes as fractions of its own image (midpoint and the
   * distance between them), measured on the art, so on a listed sprite
   * (src/eyes.ts) the holes are put on the character's eyes. `size` scales
   * the mask up around its holes when matching the eye spacing alone leaves
   * it too small for the head (holes set wide on a small mask)
   */
  eyes?: { x: number; y: number; spacing: number; size?: number }
}

// Why these numbers: tuned on every cast sprite facing the viewer (both
// casts), the same way as the Santa hat. They place a mask from the head on a
// sprite not listed in src/eyes.ts (a custom one); on a listed sprite the
// mask's eye holes (`eyes`, measured on each mask's art) go on the character's
// eyes instead. Masks that are a whole head (pumpkin, skull, the hooded
// ghost, the pale rubber mask with hair) start at the top of the hair; the
// hockey mask and the Frankenstein half mask cover only the face and brow.
export const WITCH_HAT: HalloweenPiece = { kind: 'hat', src: '/sprites/effects/witch-hat.png', scale: 1.3, offset: 0.12 }
const MASKS: readonly HalloweenPiece[] = [
  { kind: 'mask', src: '/sprites/effects/mask-pumpkin.png', scale: 1.0, offset: 0, eyes: { x: 0.62, y: 0.45, spacing: 0.35 } },
  { kind: 'mask', src: '/sprites/effects/mask-skull.png', scale: 0.95, offset: 0.01, eyes: { x: 0.63, y: 0.51, spacing: 0.37 } },
  { kind: 'mask', src: '/sprites/effects/mask-ghost.png', scale: 1.05, offset: -0.01, eyes: { x: 0.59, y: 0.45, spacing: 0.28 } },
  { kind: 'mask', src: '/sprites/effects/mask-pale.png', scale: 1.1, offset: -0.02, eyes: { x: 0.69, y: 0.57, spacing: 0.32 } },
  { kind: 'mask', src: '/sprites/effects/mask-hockey.png', scale: 0.8, offset: 0.05, eyes: { x: 0.66, y: 0.51, spacing: 0.38 } },
  // Why lower than the others: its flat top is hair, so its eye holes have to land on the eyes
  // Why size 1.35: its eye holes are wide-set, so by the eye spacing alone it only covered the eyes, not the head
  { kind: 'mask', src: '/sprites/effects/mask-frankenstein.png', scale: 1.0, offset: 0.055, eyes: { x: 0.56, y: 0.72, spacing: 0.43, size: 1.35 } },
]

// Why 1.2: the fur band overhangs the head a little on each side, like a
// real hat; tuned on all 30+ cast sprites (wider looked like a sombrero).
// Why 0.13: the band sits 13% of the sprite's height below the top of the
// hair, at the forehead, so the hat is worn rather than balanced on the hair
export const SANTA_HAT: HalloweenPiece = { kind: 'hat', src: HAT_SRC, scale: 1.2, offset: 0.13 }

/** Every image a Halloween piece can use (for the asset check and the tests) */
export const HALLOWEEN_PIECE_SRCS: readonly string[] = [WITCH_HAT.src, ...MASKS.map(m => m.src)]

/** A small stable hash of a name, so a character keeps its piece on every sprite and every load */
function nameHash(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h
}

/**
 * What a character wears over its sprite at Halloween: nothing for the ones
 * in a full costume, a mask for those whose hair a hat sits wrong on (NO_HAT),
 * and for everyone else the witch hat or one of the six masks, picked from the
 * character's name so it never changes between sprites or reloads. A mask
 * covers the face, so it is only drawn while the sprite faces the viewer;
 * from behind the character just shows the back of its head.
 * @param src the standing sprite URL being drawn
 * @returns the piece, or null when nothing is worn
 */
export function halloweenPiece(src: string): HalloweenPiece | null {
  const name = src.slice(src.lastIndexOf('/') + 1).replace(FACING_AND_SEASON, '')
  if (FULL_HALLOWEEN_COSTUME.has(name)) return null
  const h = nameHash(name)
  if (NO_HAT.has(name)) return MASKS[h % MASKS.length]
  // Why one in seven: the hat is one choice among the hat and six masks
  const pick = h % (MASKS.length + 1)
  return pick === MASKS.length ? WITCH_HAT : MASKS[pick]
}

/** Where the hat goes, as fractions of the sprite's width and height. */
export interface HeadAnchor {
  /** Centre of the head, 0..1 from the left */
  x: number
  /** Top of the hair, 0..1 from the top */
  top: number
  /** Head width, 0..1 of the sprite width */
  width: number
}

// Why 8%: measured 8% of the sprite's height below the top of the hair is
// mid-forehead on every cast sprite, below any quiff or cap brim and above the
// shoulders, so its opaque span is the head's width
const HEAD_PROBE = 0.08
// Why 128: half-transparent edge pixels are outline anti-aliasing, not head
const OPAQUE = 128

/**
 * The head of a sprite from its alpha channel.
 * @param alpha one byte per pixel, row-major (0 = transparent)
 * @param w image width
 * @param h image height
 * @returns the anchor, or null for an empty image
 */
export function headAnchorFromAlpha(alpha: ArrayLike<number>, w: number, h: number): HeadAnchor | null {
  let top = -1
  for (let y = 0; y < h && top < 0; y++) {
    for (let x = 0; x < w; x++) if (alpha[y * w + x] > OPAQUE) { top = y; break }
  }
  if (top < 0) return null
  const probe = Math.min(h - 1, top + Math.round(h * HEAD_PROBE))
  let left = -1
  let right = -1
  for (let x = 0; x < w; x++) {
    if (alpha[probe * w + x] > OPAQUE) {
      if (left < 0) left = x
      right = x
    }
  }
  if (left < 0) return null
  return { x: (left + right + 1) / 2 / w, top: top / h, width: (right - left + 1) / w }
}

const anchors = new Map<string, HeadAnchor | null>()
const pending = new Map<string, Promise<HeadAnchor | null>>()

/** Measure `src` once (cached); null when it cannot be read. */
export function measureHead(src: string): Promise<HeadAnchor | null> {
  if (anchors.has(src)) return Promise.resolve(anchors.get(src) ?? null)
  const inFlight = pending.get(src)
  if (inFlight) return inFlight
  const p = new Promise<HeadAnchor | null>(resolve => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') { resolve(null); return }
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) { resolve(null); return }
        ctx.drawImage(img, 0, 0)
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        const alpha = new Uint8Array(canvas.width * canvas.height)
        for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
        resolve(headAnchorFromAlpha(alpha, canvas.width, canvas.height))
      } catch {
        resolve(null) // a tainted canvas (cross-origin sprite): no hat rather than a crash
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  }).then(anchor => {
    anchors.set(src, anchor)
    pending.delete(src)
    return anchor
  })
  pending.set(src, p)
  return p
}

/** The head anchor of `src` once measured (null until then, or with `enabled` false). */
export function useHeadAnchor(src: string, enabled: boolean): HeadAnchor | null {
  const [anchor, setAnchor] = useState<HeadAnchor | null>(() => (enabled ? anchors.get(src) ?? null : null))
  useEffect(() => {
    if (!enabled) { setAnchor(null); return }
    let live = true
    // Why keep the previous anchor: while a walk frame is measured for the
    // first time the hat stays where it was rather than vanishing for a frame
    setAnchor(prev => anchors.get(src) ?? prev)
    void measureHead(src).then(a => { if (live) setAnchor(a) })
    return () => { live = false }
  }, [src, enabled])
  return anchor
}

/**
 * Where a mask goes on a sprite whose eyes are listed (src/eyes.ts): its
 * width makes its eye holes as far apart as the character's eyes, and its
 * eye holes' midpoint lands on theirs. Fractions of the sprite's box; the
 * `shift` is a translate in the mask's own size, so no sprite size is needed.
 * @param piece the mask (with its eye holes measured)
 * @param eye the character's eye line
 * @param mirrored whether the sprite faces right (the mask is drawn for the left, so its holes flip)
 * @returns left, top and width of the mask as fractions, and the shift, or null without eye data
 */
export function maskOnEyes(piece: HalloweenPiece, eye: EyeLine | undefined, mirrored: boolean): { left: number; top: number; width: number; shiftX: number; shiftY: number } | null {
  if (!eye || !piece.eyes) return null
  // Why the clamp: a sprite whose pupils sit unusually close (a turned head)
  // must not get a doll-sized mask, nor a huge one for wide-set eyes
  // (0.75 of the sprite's width is a big head's full width with its hair)
  // Why a hand-set width wins: some faces are drawn turned or with hair over
  // the eyes, and the eye spacing alone sizes those masks wrong (/?fithelper)
  const width = eye.width ?? Math.min(0.75, Math.max(0.35, (eye.spacing / piece.eyes.spacing) * (piece.eyes.size ?? 1)))
  const holeX = mirrored ? 1 - piece.eyes.x : piece.eyes.x
  return { left: eye.x, top: eye.y, width, shiftX: -holeX, shiftY: -piece.eyes.y }
}

/**
 * A sprite's key in the hand-set tables (src/eyes.ts, src/hatFit.ts): its
 * file name without the extension or a season suffix.
 * @param src a standing sprite URL (`.png` or a seasonal `.webp`)
 * @returns e.g. `dev-1-front-left`
 */
export function spriteKey(src: string): string {
  const file = src.slice(src.lastIndexOf('/') + 1)
  return file.replace(new RegExp(`((${SEASON_SUFFIX_PATTERN})\\.webp|\\.png)$`), '')
}

/** Which hat table (src/hatFit.ts) a piece is tuned in, or null for a mask */
export function hatKindOf(piece: HalloweenPiece): HatKind | null {
  if (piece.src === SANTA_HAT.src) return 'santa'
  if (piece.src === WITCH_HAT.src) return 'witch'
  return null
}

/**
 * Where a hat goes on a measured head, with that sprite's hand-set nudge if it
 * has one: centred on the head, as wide as the head times the hat's scale,
 * its bottom edge `offset` below the top of the hair. Fractions of the sprite.
 * @param head the measured head
 * @param piece the hat
 * @param nudge the sprite's entry in src/hatFit.ts, if any
 * @returns left, width and bottom (from the sprite's bottom edge)
 */
export function hatOnHead(head: HeadAnchor, piece: HalloweenPiece, nudge?: HatNudge): { left: number; width: number; bottom: number } {
  const width = head.width * piece.scale * (nudge?.size ?? 1)
  return {
    left: head.x + (nudge?.dx ?? 0) - width / 2,
    width,
    bottom: 1 - head.top - piece.offset - (nudge?.dy ?? 0),
  }
}
