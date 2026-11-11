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
    'david-wallace-front-left': { dx: 0.008, dy: -0.020, size: 1.040 },
    'david-wallace-front-right': { dx: 0.000, dy: -0.012, size: 1.040 },
    'david-wallace-rear-left': { dx: 0.000, dy: -0.028, size: 1.082 },
    'david-wallace-rear-right': { dx: -0.012, dy: -0.024, size: 1.082 },
    'dev-2-front-left': { dx: -0.036, dy: -0.012, size: 1.082 },
    'dev-2-front-right': { dx: 0.040, dy: -0.012, size: 1.082 },
    'dev-2-rear-left': { dx: 0.024, dy: -0.020, size: 1.082 },
    'dev-2-rear-right': { dx: -0.020, dy: -0.020, size: 1.082 },
    'gabe-lewis-front-left': { dx: 0.000, dy: -0.012, size: 1.040 },
    'gabe-lewis-front-right': { dx: 0.032, dy: -0.016, size: 1.082 },
    'gabe-lewis-rear-left': { dx: -0.016, dy: -0.020, size: 1.082 },
    'gabe-lewis-rear-right': { dx: 0.020, dy: -0.020, size: 1.082 },
  },
}
