/**
 * walk.ts - optional walk-cycle frames for character sprites.
 *
 * A character sprite `name-<direction>.png` may have a four-frame walk cycle
 * saved beside it, `name-<direction>-walk1.webp` .. `-walk4.webp`: left foot
 * down, passing, right foot down, passing. While a character is actually
 * moving it loops through those four, so its legs move instead of the whole
 * figure gliding. The standing sprite is never one of the steps (Why: it is
 * drawn facing the camera and the stride art is not; mixing them made the
 * figure snap between angles every frame). Frames are optional per sprite:
 * they are found with the same runtime image probe the incident and festive
 * art use, and a sprite without all four keeps gliding as before. A festive copy has frames of
 * its own beside it (`name-xmas.webp` -> `name-xmas-walk1.webp`), so a
 * character in a Christmas jumper never flashes back to its everyday clothes
 * mid-stride; without them it glides.
 */

import { useSyncExternalStore } from 'react'
import { probeImage, subscribeIncidentAssets } from './incidentAssets'

// Why 140 ms: the office walks at WALK_SPEED 0.08 %/frame, about 5 % of the
// room per second; four 140 ms frames per cycle (~0.56 s, two steps) puts a
// step every ~1.4 % of the room, which matches the sprites' stride length at the
// office's scale (faster looks like scurrying, slower like moonwalking).
export const WALK_FRAME_MS = 140

/** Frames in one walk cycle: contact, passing, contact, passing. */
export const WALK_FRAMES = 4

/**
 * The walk-cycle frames for `src` (a sprite `.png`, or a festive `.webp` copy),
 * in order, or null when `src` cannot have any.
 */
export function walkFramePaths(src: string): string[] | null {
  const m = /^(.*)\.(png|webp)$/.exec(src)
  if (!m || /-walk\d$/.test(m[1])) return null // not a sprite, or already a walk frame
  return Array.from({ length: WALK_FRAMES }, (_, i) => `${m[1]}-walk${i + 1}.webp`)
}

const found = new Map<string, boolean>()
let version = 0
const listeners = new Set<() => void>()

/**
 * The sprite to draw this instant for a character showing `src`.
 * @param src the standing sprite (getSpritePath's result)
 * @param stepping whether the character moved since the last render
 * @param now the clock to step by (ms)
 * @returns `src`, or one of its walk frames once all of them are known to exist
 */
export function walkFrame(src: string, stepping: boolean, now: number): string {
  const frames = walkFramePaths(src)
  if (!stepping || !frames) return src
  for (const f of frames) {
    if (!found.has(f)) {
      found.set(f, false) // Why: one probe per file however often it renders
      void probeImage(f).then(ok => { found.set(f, ok); version++; listeners.forEach(l => l()) })
    }
  }
  if (!frames.every(f => found.get(f))) return src
  return frames[Math.floor(now / WALK_FRAME_MS) % WALK_FRAMES]
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  const off = subscribeIncidentAssets(fn)
  return () => { listeners.delete(fn); off() }
}

/** Changes when a walk frame turns out to exist, so a memoised sprite re-renders. */
export function useWalkFrames(): number {
  return useSyncExternalStore(subscribe, () => version, () => version)
}

/** Test hook: pretend a probe already answered. */
export function _setWalkFrameForTests(url: string, ok: boolean) {
  found.set(url, ok)
}
