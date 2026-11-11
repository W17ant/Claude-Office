/**
 * eyes.ts - where the eyes are on each cast sprite facing the viewer, so a Halloween mask's eye holes sit on them.
 *
 * Generated once from the sprites (dark-and-white holes in the face, paired;
 * a few read off by hand where hair or glasses fooled that) and checked by
 * eye on every sprite. Fractions of the standing sprite's width and height;
 * a walk frame is drawn on its standing sprite's canvas, so they hold for the
 * frames too. `spacing` is the distance between the two pupils. Only
 * characters that can wear a mask are listed (not the ones in full costume),
 * and only the front poses (a mask is not drawn from behind). A sprite not
 * listed (a custom one) gets its mask placed from the measured head instead.
 * Each entry can be nudged and sized by hand in /?fithelper, which exports
 * this table again.
 */

export interface EyeLine {
  /** Midpoint between the eyes, 0..1 from the left */
  x: number
  /** Eye line, 0..1 from the top */
  y: number
  /** Distance between the pupils, 0..1 of the sprite's width */
  spacing: number
  /**
   * The mask's width, 0..1 of the sprite's width, when it was sized by hand
   * (/?fithelper); without it the mask is sized from `spacing`
   */
  width?: number
  /** The mask's tilt in degrees (clockwise), when set by hand (/?fithelper) */
  rot?: number
}

/** By standing sprite name without its extension: `<character>-front-left` / `-front-right` */
export const EYES: Readonly<Record<string, EyeLine>> = {
  'Frontend-dev-1-front-left': { x: 0.550, y: 0.205, spacing: 0.180 },
  'Frontend-dev-1-front-right': { x: 0.450, y: 0.205, spacing: 0.180 },
  'andy-bernard-front-left': { x: 0.558, y: 0.189, spacing: 0.225 },
  'andy-bernard-front-right': { x: 0.444, y: 0.190, spacing: 0.227 },
  'angela-martin-front-left': { x: 0.764, y: 0.178, spacing: 0.220 },
  'angela-martin-front-right': { x: 0.225, y: 0.178, spacing: 0.225 },
  'bob-vance-front-left': { x: 0.533, y: 0.161, spacing: 0.199 },
  'bob-vance-front-right': { x: 0.462, y: 0.161, spacing: 0.199 },
  'carol-stills-front-left': { x: 0.517, y: 0.160, spacing: 0.204 },
  'carol-stills-front-right': { x: 0.478, y: 0.160, spacing: 0.204 },
  'creed-bratton-front-left': { x: 0.552, y: 0.170, spacing: 0.211 },
  'creed-bratton-front-right': { x: 0.448, y: 0.170, spacing: 0.211 },
  'darryl-philbin-front-left': { x: 0.571, y: 0.173, spacing: 0.223 },
  'darryl-philbin-front-right': { x: 0.423, y: 0.173, spacing: 0.222 },
  'david-wallace-front-left': { x: 0.534, y: 0.164, spacing: 0.210 },
  'david-wallace-front-right': { x: 0.461, y: 0.164, spacing: 0.210 },
  'dev-1-front-left': { x: 0.549, y: 0.178, spacing: 0.212 },
  'dev-1-front-right': { x: 0.447, y: 0.178, spacing: 0.212 },
  'dev-2-front-left': { x: 0.490, y: 0.192, spacing: 0.205 },
  'dev-2-front-right': { x: 0.508, y: 0.192, spacing: 0.205 },
  'employee-1-front-left': { x: 0.552, y: 0.211, spacing: 0.156 },
  'employee-1-front-right': { x: 0.446, y: 0.211, spacing: 0.156 },
  'employee-2-front-left': { x: 0.492, y: 0.232, spacing: 0.263 },
  'employee-2-front-right': { x: 0.503, y: 0.232, spacing: 0.263 },
  'employee-3-front-left': { x: 0.553, y: 0.196, spacing: 0.202 },
  'employee-3-front-right': { x: 0.444, y: 0.196, spacing: 0.202 },
  'erin-hannon-front-left': { x: 0.577, y: 0.176, spacing: 0.223 },
  'erin-hannon-front-right': { x: 0.419, y: 0.176, spacing: 0.226 },
  'explore-1-front-left': { x: 0.606, y: 0.207, spacing: 0.215 },
  'explore-1-front-right': { x: 0.390, y: 0.207, spacing: 0.216 },
  'gabe-lewis-front-left': { x: 0.532, y: 0.172, spacing: 0.209 },
  'gabe-lewis-front-right': { x: 0.463, y: 0.172, spacing: 0.209 },
  'holly-flax-front-left': { x: 0.577, y: 0.167, spacing: 0.256 },
  'holly-flax-front-right': { x: 0.411, y: 0.167, spacing: 0.253 },
  'jan-levinson-front-left': { x: 0.670, y: 0.200, spacing: 0.260 },
  'jan-levinson-front-right': { x: 0.330, y: 0.200, spacing: 0.260 },
  'karen-filippelli-front-left': { x: 0.561, y: 0.172, spacing: 0.228 },
  'karen-filippelli-front-right': { x: 0.419, y: 0.136, spacing: 0.168 },
  'kelly-kapoor-front-left': { x: 0.550, y: 0.168, spacing: 0.226 },
  'kelly-kapoor-front-right': { x: 0.445, y: 0.168, spacing: 0.226 },
  'kevin-malone-front-left': { x: 0.660, y: 0.175, spacing: 0.220 },
  'kevin-malone-front-right': { x: 0.330, y: 0.175, spacing: 0.190 },
  'meredith-palmer-front-left': { x: 0.674, y: 0.156, spacing: 0.197 },
  'meredith-palmer-front-right': { x: 0.319, y: 0.156, spacing: 0.199 },
  'nellie-bertram-front-left': { x: 0.550, y: 0.169, spacing: 0.241 },
  'nellie-bertram-front-right': { x: 0.440, y: 0.170, spacing: 0.239 },
  'oscar-martinez-front-left': { x: 0.565, y: 0.199, spacing: 0.238 },
  'oscar-martinez-front-right': { x: 0.431, y: 0.199, spacing: 0.240 },
  'phyllis-vance-front-left': { x: 0.581, y: 0.189, spacing: 0.363 },
  'phyllis-vance-front-right': { x: 0.419, y: 0.189, spacing: 0.363 },
  'robert-california-front-left': { x: 0.553, y: 0.164, spacing: 0.200 },
  'robert-california-front-right': { x: 0.442, y: 0.164, spacing: 0.200 },
  'roy-anderson-front-left': { x: 0.587, y: 0.177, spacing: 0.209 },
  'roy-anderson-front-right': { x: 0.424, y: 0.179, spacing: 0.207 },
  'ryan-howard-front-left': { x: 0.572, y: 0.156, spacing: 0.219 },
  'ryan-howard-front-right': { x: 0.412, y: 0.154, spacing: 0.225 },
  'security-audit-1-front-left': { x: 0.497, y: 0.182, spacing: 0.214 },
  'security-audit-1-front-right': { x: 0.501, y: 0.182, spacing: 0.214 },
  'stanley-hudson-front-left': { x: 0.574, y: 0.170, spacing: 0.216 },
  'stanley-hudson-front-right': { x: 0.422, y: 0.169, spacing: 0.216 },
  'toby-flenderson-front-left': { x: 0.555, y: 0.170, spacing: 0.216 },
  'toby-flenderson-front-right': { x: 0.440, y: 0.170, spacing: 0.216 },
}
