/**
 * hatFit.ts - hand-set nudges for the Santa hat and the witch hat on each cast sprite.
 *
 * A hat is placed from the head measured on the sprite itself (src/hat.ts);
 * where that lands a little off (big hair, a turned head), an entry here moves
 * and sizes it for that one sprite. Keys are the standing sprite's name
 * without extension or season suffix (`<character>-<front|rear>-<left|right>`),
 * so a walk frame and a seasonal copy wear the same nudge. `dx` / `dy` are
 * fractions of the sprite's width / height (down is positive), `size`
 * multiplies the hat's width and `rot` tilts it. Written by /?fithelper's Export.
 */

/** A hand-set correction to one sprite's hat */
export interface HatNudge {
  dx: number
  dy: number
  size: number
  /** Tilt in degrees, clockwise, about the hat's bottom centre */
  rot?: number
}

/** Which hat a nudge is for */
export type HatKind = 'santa' | 'witch'

export const HAT_FIT: Readonly<Record<HatKind, Readonly<Record<string, HatNudge>>>> = {
  santa: {
  },
  witch: {
  },
}
