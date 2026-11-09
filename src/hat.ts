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

export const HAT_SRC = '/sprites/effects/santa-hat.png'

// Why: on a ponytail, a bun or big hair the one-size hat sits wrong (judged
// on all four directions of every cast sprite); these characters wear their
// own festive sprite instead (a Christmas jumper, -xmas.webp), and until that
// file exists they simply go without a hat rather than wear a bad one
const NO_HAT = new Set(['employee-2', 'erin-hannon', 'Frontend-dev-1', 'Me-1'])

/**
 * Whether a sprite gets the overlay hat: not when it is already a festive
 * copy (the elf, a jumper, a sprite with its own Santa hat), and not for the
 * characters in NO_HAT.
 * @param src the sprite URL being drawn
 */
export function wearsOverlayHat(src: string): boolean {
  if (src.endsWith('-xmas.webp')) return false
  const file = src.slice(src.lastIndexOf('/') + 1)
  const base = file.replace(/-(front|rear)-(left|right)\.png$/, '')
  return !NO_HAT.has(base)
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
    setAnchor(anchors.get(src) ?? null)
    void measureHead(src).then(a => { if (live) setAnchor(a) })
    return () => { live = false }
  }, [src, enabled])
  return anchor
}
