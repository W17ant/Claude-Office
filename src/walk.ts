/**
 * walk.ts - optional walk-cycle frames for character sprites.
 *
 * A character sprite `name-<direction>.png` may have two stride frames saved
 * beside it, `name-<direction>-walk1.webp` (left leg forward) and
 * `-walk2.webp` (right leg forward). While a character is actually moving, it
 * cycles stand -> walk1 -> stand -> walk2, so its legs move instead of the
 * whole figure gliding. Frames are optional per sprite: they are found with the
 * same runtime image probe the incident and festive art use, and a sprite
 * without both frames keeps gliding as before. A festive copy has frames of
 * its own beside it (`name-xmas.webp` -> `name-xmas-walk1.webp`), so a
 * character in a Christmas jumper never flashes back to its everyday clothes
 * mid-stride; without them it glides.
 */

import { useSyncExternalStore } from 'react'
import { probeImage, subscribeIncidentAssets } from './incidentAssets'

// Why 140 ms: the office walks at WALK_SPEED 0.08 %/frame, about 5 % of the
// room per second; four 140 ms frames per stride cycle (~0.56 s) puts a step
// every ~1.4 % of the room, which matches the sprites' stride length at the
// office's scale (faster looks like scurrying, slower like moonwalking).
export const WALK_FRAME_MS = 140

/**
 * The two stride frames for `src` (a sprite `.png`, or a festive `.webp` copy),
 * or null when `src` cannot have any.
 */
export function walkFramePaths(src: string): [string, string] | null {
  const m = /^(.*)\.(png|webp)$/.exec(src)
  if (!m || /-walk[12]$/.test(m[1])) return null // not a sprite, or already a stride frame
  return [`${m[1]}-walk1.webp`, `${m[1]}-walk2.webp`]
}

const found = new Map<string, boolean>()
let version = 0
const listeners = new Set<() => void>()

/**
 * The sprite to draw this instant for a character showing `src`.
 * @param src the standing sprite (getSpritePath's result)
 * @param stepping whether the character moved since the last render
 * @param now the clock to step by (ms)
 * @returns `src`, or one of its stride frames once both are known to exist
 */
export function walkFrame(src: string, stepping: boolean, now: number): string {
  const frames = walkFramePaths(src)
  if (!stepping || !frames) return src
  const [a, b] = frames
  for (const f of frames) {
    if (!found.has(f)) {
      found.set(f, false) // Why: one probe per file however often it renders
      void probeImage(f).then(ok => { found.set(f, ok); version++; listeners.forEach(l => l()) })
    }
  }
  if (!found.get(a) || !found.get(b)) return src
  // stand, left stride, stand, right stride
  switch (Math.floor(now / WALK_FRAME_MS) % 4) {
    case 1: return a
    case 3: return b
    default: return src
  }
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
