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
  'Frontend-dev-1-front-left': { x: 0.578, y: 0.169, spacing: 0.180 },
  'Frontend-dev-1-front-right': { x: 0.414, y: 0.169, spacing: 0.180 },
  'andy-bernard-front-left': { x: 0.586, y: 0.213, spacing: 0.225, width: 0.764 },
  'andy-bernard-front-right': { x: 0.424, y: 0.210, spacing: 0.227, width: 0.771 },
  'angela-martin-front-left': { x: 0.736, y: 0.150, spacing: 0.220 },
  'angela-martin-front-right': { x: 0.265, y: 0.146, spacing: 0.225 },
  'bob-vance-front-left': { x: 0.629, y: 0.137, spacing: 0.199 },
  'bob-vance-front-right': { x: 0.390, y: 0.133, spacing: 0.199 },
  'carol-stills-front-left': { x: 0.617, y: 0.164, spacing: 0.204, width: 0.573 },
  'carol-stills-front-right': { x: 0.358, y: 0.160, spacing: 0.204, width: 0.573 },
  'creed-bratton-front-left': { x: 0.608, y: 0.194, spacing: 0.211, width: 0.716 },
  'creed-bratton-front-right': { x: 0.392, y: 0.190, spacing: 0.211, width: 0.716 },
  'darryl-philbin-front-left': { x: 0.703, y: 0.173, spacing: 0.223, width: 0.725 },
  'darryl-philbin-front-right': { x: 0.291, y: 0.169, spacing: 0.222, width: 0.722 },
  'david-wallace-front-left': { x: 0.534, y: 0.164, spacing: 0.210 },
  'david-wallace-front-right': { x: 0.461, y: 0.164, spacing: 0.210 },
  'dev-1-front-left': { x: 0.577, y: 0.198, spacing: 0.212, width: 0.749 },
  'dev-1-front-right': { x: 0.423, y: 0.198, spacing: 0.212, width: 0.749 },
  'dev-2-front-left': { x: 0.490, y: 0.192, spacing: 0.205 },
  'dev-2-front-right': { x: 0.508, y: 0.192, spacing: 0.205 },
  'employee-1-front-left': { x: 0.640, y: 0.151, spacing: 0.156, width: 0.542 },
  'employee-1-front-right': { x: 0.338, y: 0.151, spacing: 0.156, width: 0.542 },
  'employee-2-front-left': { x: 0.708, y: 0.196, spacing: 0.263, width: 0.632 },
  'employee-2-front-right': { x: 0.275, y: 0.204, spacing: 0.263, width: 0.657 },
  'employee-3-front-left': { x: 0.649, y: 0.136, spacing: 0.202 },
  'employee-3-front-right': { x: 0.352, y: 0.132, spacing: 0.202 },
  'erin-hannon-front-left': { x: 0.633, y: 0.200, spacing: 0.223, width: 0.757 },
  'erin-hannon-front-right': { x: 0.379, y: 0.196, spacing: 0.226, width: 0.767 },
  'explore-1-front-left': { x: 0.666, y: 0.139, spacing: 0.215, width: 0.639 },
  'explore-1-front-right': { x: 0.334, y: 0.147, spacing: 0.216, width: 0.642 },
  'gabe-lewis-front-left': { x: 0.532, y: 0.172, spacing: 0.209 },
  'gabe-lewis-front-right': { x: 0.463, y: 0.172, spacing: 0.209 },
  'holly-flax-front-left': { x: 0.677, y: 0.131, spacing: 0.256 },
  'holly-flax-front-right': { x: 0.311, y: 0.123, spacing: 0.253 },
  'jan-levinson-front-left': { x: 0.598, y: 0.216, spacing: 0.260 },
  'jan-levinson-front-right': { x: 0.402, y: 0.212, spacing: 0.260 },
  'karen-filippelli-front-left': { x: 0.697, y: 0.148, spacing: 0.228, width: 0.666 },
  'karen-filippelli-front-right': { x: 0.287, y: 0.148, spacing: 0.168, width: 0.699 },
  'kelly-kapoor-front-left': { x: 0.670, y: 0.168, spacing: 0.226, width: 0.595 },
  'kelly-kapoor-front-right': { x: 0.313, y: 0.168, spacing: 0.226 },
  'kevin-malone-front-left': { x: 0.608, y: 0.191, spacing: 0.220, width: 0.747 },
  'kevin-malone-front-right': { x: 0.382, y: 0.191, spacing: 0.190, width: 0.755 },
  'meredith-palmer-front-left': { x: 0.710, y: 0.172, spacing: 0.197, width: 0.623 },
  'meredith-palmer-front-right': { x: 0.299, y: 0.156, spacing: 0.199, width: 0.605 },
  'nellie-bertram-front-left': { x: 0.646, y: 0.137, spacing: 0.241 },
  'nellie-bertram-front-right': { x: 0.344, y: 0.150, spacing: 0.239 },
  'oscar-martinez-front-left': { x: 0.697, y: 0.159, spacing: 0.238 },
  'oscar-martinez-front-right': { x: 0.319, y: 0.155, spacing: 0.240 },
  'phyllis-vance-front-left': { x: 0.713, y: 0.189, spacing: 0.363 },
  'phyllis-vance-front-right': { x: 0.295, y: 0.189, spacing: 0.363 },
  'robert-california-front-left': { x: 0.649, y: 0.148, spacing: 0.200, width: 0.562 },
  'robert-california-front-right': { x: 0.334, y: 0.152, spacing: 0.200, width: 0.562 },
  'roy-anderson-front-left': { x: 0.711, y: 0.161, spacing: 0.209, width: 0.679 },
  'roy-anderson-front-right': { x: 0.276, y: 0.163, spacing: 0.207, width: 0.673 },
  'ryan-howard-front-left': { x: 0.732, y: 0.176, spacing: 0.219 },
  'ryan-howard-front-right': { x: 0.252, y: 0.174, spacing: 0.225 },
  'security-audit-1-front-left': { x: 0.697, y: 0.142, spacing: 0.214 },
  'security-audit-1-front-right': { x: 0.301, y: 0.142, spacing: 0.214 },
  'stanley-hudson-front-left': { x: 0.678, y: 0.138, spacing: 0.216, width: 0.710 },
  'stanley-hudson-front-right': { x: 0.322, y: 0.141, spacing: 0.216, width: 0.710 },
  'toby-flenderson-front-left': { x: 0.603, y: 0.190, spacing: 0.216, width: 0.733 },
  'toby-flenderson-front-right': { x: 0.392, y: 0.182, spacing: 0.216, width: 0.733 },
}
