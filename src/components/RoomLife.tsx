/**
 * RoomLife - the room's wall props, animated in code over the room art.
 *
 * One SVG laid over the room in the art's own pixels (1508 x 1126, the size
 * the room images are exported at), so everything lines up with the picture
 * at any size:
 *   - the deploy TV: a status dashboard, a deploy shipping, then SHIPPED or
 *     ROLLBACK (roomLife.ts tvMode; the incident layer has the TV while prod
 *     is down)
 *   - the city through the windows: office lights flicking on and off and a
 *     plane's blinking light at night, clouds drifting by day
 *   - the water cooler: bubbles while someone is at it or waiting
 *   - the bell: rings (swings, with sound waves) when the boss shouts Claude a
 *     prompt or rings it himself
 *   - the fire extinguisher: rattles and glows red while prod is down
 * The bell and the extinguisher are the room art's own pixels, copied out
 * (both day and night layers, blended as the room is) so they can move.
 */

import React, { useEffect, useRef, useState } from 'react'
import '../styles/room-life.css'
import type { TvMode } from '../roomLife'

// Why: still pictures instead of motion when the viewer asks for less
const MOVE = !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

/** The room art's size in pixels: the overlay's coordinate space. */
const ROOM_W = 1508
const ROOM_H = 1126

// ---------------------------------------------------------------------------
// Where things are in the room art (measured on office-day.png, 1508 x 1126)
// ---------------------------------------------------------------------------

// The TV's screen: left edge at x 1318 from y 363.5, right edge at x 1407 from
// y 401, 62 px tall (the back wall falls to the right)
const TV = { a: 0.89, b: 0.375, c: 0, d: 0.62, e: 1318, f: 363.5 }
// Window glass: corner, along-the-top and down-the-side vectors
const GLASS = [
  { x: 152, y: 292, ux: 436, uy: -170, vx: 0, vy: 348 }, // the long window wall on the left
  { x: 672, y: 112, ux: 208, uy: 88, vx: 0, vy: 273 }, // the window in the back wall
]
// The two ceiling lights hang in front of the glass: their outlines (bar,
// tube and both rods, a couple of pixels out), so the sky is not drawn over them
const LIGHTS_IN_FRONT = [
  'M 331 256 L 362 244 L 568 329 L 564 354 L 549 372 L 343 287 L 331 270 Z',
  'M 371 158 L 382 158 L 382 262 L 371 262 Z',
  'M 515 215 L 525 215 L 525 332 L 515 332 Z',
  'M 663 162 L 692 148 L 899 239 L 895 259 L 871 274 L 678 192 L 663 176 Z',
  'M 702 60 L 714 60 L 714 172 L 702 172 Z',
  'M 847 120 L 858 120 L 858 232 L 847 232 Z',
]
const BOTTLE = { x: 835, y: 365, w: 35, h: 55 } // the water cooler's upturned bottle
// The bell (without its rope: a copied rope would swing beside the painted one), and where it hangs from
const BELL = { x: 917, y: 322, w: 44, h: 45, pivotX: 50, pivotY: 6 }
// The fire extinguisher on the left wall, and its bracket
const EXTINGUISHER = { x: 72, y: 565, w: 46, h: 87, pivotX: 22, pivotY: 11 }

/** A point on window pane `g` at (u, v), each 0..1 across and down it. */
function onGlass(g: typeof GLASS[number], u: number, v: number): [number, number] {
  return [g.x + u * g.ux + v * g.vx, g.y + u * g.uy + v * g.vy]
}

function glassPath(g: typeof GLASS[number]): string {
  const pts = [onGlass(g, 0, 0), onGlass(g, 1, 0), onGlass(g, 1, 1), onGlass(g, 0, 1)]
  return `M ${pts.map(p => p.join(' ')).join(' L ')} Z`
}

// A fixed scatter of lit office windows in the buildings: [pane, u, v, seconds per blink cycle]
// Why fixed (not random per render): the city must not reshuffle on every re-render
const LIGHTS: Array<[number, number, number, number]> = Array.from({ length: 44 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
  // Why v 0.35-0.68: the buildings' middle floors; lower down the glass is hidden
  // behind the water cooler and the desks, which are part of the art in front of it
  return [i % 3 === 0 ? 1 : 0, 0.04 + r(1) * 0.92, 0.35 + r(2) * 0.33, 6 + r(3) * 14]
})

// ---------------------------------------------------------------------------
// The deploy TV
// ---------------------------------------------------------------------------

function TvScreen({ mode }: { mode: TvMode }) {
  const label = (text: string, colour: string) => (
    // Why textLength: at 12 px monospace "DEPLOYING" ran 9 px past the screen's edge;
    // squeezed to 52 it ends at 96, inside the screen clip
    <text x={44} y={52} fontFamily="monospace" fontWeight="bold" fontSize={12} fill={colour} textLength={Math.min(52, text.length * 7.2)} lengthAdjust="spacingAndGlyphs">{text}</text>
  )
  return (
    <g transform={`matrix(${TV.a} ${TV.b} ${TV.c} ${TV.d} ${TV.e} ${TV.f})`}>
      {/* Why: the dashboard's chart is drawn 150 wide and scrolls sideways; without
          this it ran past the screen onto the TV's frame and the wall */}
      <clipPath id="room-life-tv-screen"><rect width={100} height={100} /></clipPath>
      <g clipPath="url(#room-life-tv-screen)">
      {mode === 'dashboard' && (
        <>
          <rect width={100} height={100} fill="#0b1220" />
          <rect width={100} height={14} fill="#1e293b" />
          <circle cx={7} cy={7} r={3} fill="#22c55e">
            {MOVE && <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />}
          </circle>
          <rect x={14} y={5} width={30} height={4} fill="#94a3b8" />
          <g>
            {MOVE && <animateTransform attributeName="transform" type="translate" from="0 0" to="-50 0" dur="5s" repeatCount="indefinite" />}
            <polyline points="0,60 10,52 20,58 30,40 40,48 50,60 60,52 70,58 80,40 90,48 100,60 110,52 120,58 130,40 140,48 150,60" fill="none" stroke="#22c55e" strokeWidth={3} />
          </g>
          {[8, 40, 72].map(x => <rect key={x} x={x} y={80} width={22} height={8} rx={4} fill="#166534" />)}
        </>
      )}
      {mode === 'deploying' && (
        <>
          <rect width={100} height={100} fill="#0b1220" />
          <circle cx={22} cy={46} r={12} fill="none" stroke="#1e293b" strokeWidth={5} />
          <circle cx={22} cy={46} r={12} fill="none" stroke="#38bdf8" strokeWidth={5} strokeDasharray="20 56">
            {MOVE && <animateTransform attributeName="transform" type="rotate" from="0 22 46" to="360 22 46" dur="1s" repeatCount="indefinite" />}
          </circle>
          {label('DEPLOYING', '#e2e8f0')}
          <rect x={44} y={66} width={50} height={6} fill="#1e293b" />
          <rect x={44} y={66} width={50} height={6} fill="#38bdf8">
            {MOVE && <animate attributeName="width" values="0;50" dur="6s" repeatCount="indefinite" />}
          </rect>
        </>
      )}
      {mode === 'shipped' && (
        <>
          <rect width={100} height={100} fill="#052e16" />
          <polyline points="10,46 20,58 36,30" fill="none" stroke="#22c55e" strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
          {label('SHIPPED', '#bbf7d0')}
        </>
      )}
      {mode === 'failed' && (
        <>
          {/* Why 1 s: one flash a second, far under the 3-a-second photosensitivity limit */}
          <rect width={100} height={100} fill="#450a0a">
            {MOVE && <animate attributeName="fill" values="#450a0a;#7f1d1d" dur="1s" calcMode="discrete" repeatCount="indefinite" />}
          </rect>
          <path d="M 12 32 L 34 58 M 34 32 L 12 58" stroke="#ef4444" strokeWidth={7} strokeLinecap="round" />
          {label('ROLLBACK', '#fecaca')}
        </>
      )}
      </g>
    </g>
  )
}

// ---------------------------------------------------------------------------
// The city through the windows
// ---------------------------------------------------------------------------

function City({ night, clipId }: { night: number; clipId: string }) {
  return (
    // Why a mask, not a clip: the sky shows through the glass but not through
    // the ceiling lights hanging in front of it, which a clip can't cut out
    <g mask={`url(#${clipId})`}>
      <mask id={clipId} maskUnits="userSpaceOnUse" x={0} y={0} width={ROOM_W} height={ROOM_H}>
        {GLASS.map((g, i) => <path key={i} d={glassPath(g)} fill="#fff" />)}
        {LIGHTS_IN_FRONT.map((d, i) => <path key={`l${i}`} d={d} fill="#000" />)}
      </mask>
      {/* Night: office windows across the city flick on and off; a plane crosses */}
      {night > 0.05 && (
        <g opacity={night}>
          {LIGHTS.map(([pane, u, v, dur], i) => {
            const [x, y] = onGlass(GLASS[pane], u, v)
            return (
              <rect key={i} x={x} y={y} width={3} height={4} fill="#fde68a" opacity={0.7}>
                {MOVE && <animate attributeName="opacity" values="0.7;0.7;0;0;0.7" keyTimes={`0;${0.5 + (i % 4) * 0.1};${0.52 + (i % 4) * 0.1};0.95;1`} dur={`${dur}s`} repeatCount="indefinite" />}
              </rect>
            )
          })}
          {MOVE && (
            <g>
              <animateMotion path={`M ${onGlass(GLASS[0], -0.05, 0.12).join(' ')} L ${onGlass(GLASS[0], 1.05, 0.12).join(' ')}`} dur="26s" repeatCount="indefinite" />
              <circle r={2.5} fill="#ef4444">
                <animate attributeName="opacity" values="1;0;0;1" keyTimes="0;0.1;0.9;1" dur="1.2s" repeatCount="indefinite" />
              </circle>
              <circle cx={-6} r={1.5} fill="#f8fafc" />
            </g>
          )}
        </g>
      )}
      {/* Day: clouds drift across the sky */}
      {night < 0.95 && MOVE && (
        <g opacity={(1 - night) * 0.75}>
          {[[0.1, 70, 0], [0.22, 95, -30], [0.05, 120, -70]].map(([v, dur, begin], i) => {
            const pane = GLASS[i === 1 ? 1 : 0]
            return (
              <g key={i}>
                <animateMotion path={`M ${onGlass(pane, -0.3, v).join(' ')} L ${onGlass(pane, 1.3, v).join(' ')}`} dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" />
                <ellipse rx={34} ry={10} fill="#ffffff" />
                <ellipse cx={-14} cy={-6} rx={16} ry={9} fill="#ffffff" />
                <ellipse cx={12} cy={-7} rx={18} ry={10} fill="#ffffff" />
              </g>
            )
          })}
        </g>
      )}
    </g>
  )
}

// ---------------------------------------------------------------------------
// Pieces of the art copied out so they can move
// ---------------------------------------------------------------------------

interface CropProps {
  box: { x: number; y: number; w: number; h: number; pivotX: number; pivotY: number }
  day: string
  night: string
  nightLevel: number
  className: string
  clipPath?: string
}

/** The room art inside `box` (day and night layers blended as the room is), as its own element. */
function Crop({ box, day, night, nightLevel, className, clipPath }: CropProps) {
  // Why these percentages: background-position p% puts p% of the image at p% of the box,
  // so the box's own corner lands on its spot in the room art
  const layer = (url: string, opacity: number) => (
    <div style={{
      backgroundImage: `url(${url})`,
      backgroundSize: `${(ROOM_W / box.w) * 100}% ${(ROOM_H / box.h) * 100}%`,
      backgroundPosition: `${(box.x / (ROOM_W - box.w)) * 100}% ${(box.y / (ROOM_H - box.h)) * 100}%`,
      opacity,
    }} />
  )
  return (
    <div
      className={`room-crop ${className}`}
      style={{
        left: `${(box.x / ROOM_W) * 100}%`, top: `${(box.y / ROOM_H) * 100}%`,
        width: `${(box.w / ROOM_W) * 100}%`, height: `${(box.h / ROOM_H) * 100}%`,
        transformOrigin: `${box.pivotX}% ${box.pivotY}%`,
        clipPath,
      }}
    >
      {layer(day, 1)}
      {nightLevel > 0 && layer(night, nightLevel)}
    </div>
  )
}

// Why this outline: the bell's own shape (narrow crown, flared mouth), so the
// wall around it does not swing with it
const BELL_SHAPE = 'polygon(36% 0, 64% 0, 100% 88%, 100% 100%, 0 100%, 0 88%)'

interface Props {
  tv: TvMode
  /** 0 = day, 1 = night: how much of the night art shows */
  night: number
  incident: boolean
  waterBusy: boolean
  /** Changes each time the bell should ring */
  bellKey: number
  dayImage: string
  nightImage: string
}

const RoomLife: React.FC<Props> = ({ tv, night, incident, waterBusy, bellKey, dayImage, nightImage }) => {
  const [ringing, setRinging] = useState(0)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return } // Why: no ring on page load
    setRinging(bellKey)
    const t = setTimeout(() => setRinging(0), 2400)
    return () => clearTimeout(t)
  }, [bellKey])

  return (
    <>
      <svg
        className="room-life"
        viewBox={`0 0 ${ROOM_W} ${ROOM_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}
      >
        <City night={night} clipId="room-life-glass" />
        {!incident && <TvScreen mode={tv} />}
        {waterBusy && MOVE && [843, 852, 861].map((x, i) => (
          <circle key={x} cx={x} cy={BOTTLE.y + BOTTLE.h} r={2.6} fill="none" stroke="#f0f9ff" strokeWidth={1.4} opacity={0}>
            <animate attributeName="cy" values={`${BOTTLE.y + BOTTLE.h};${BOTTLE.y + 4}`} dur={`${1.6 + i * 0.3}s`} begin={`${i * 0.5}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0;0.9;0" dur={`${1.6 + i * 0.3}s`} begin={`${i * 0.5}s`} repeatCount="indefinite" />
          </circle>
        ))}
      </svg>
      {ringing > 0 && MOVE && (
        // Why its own svg, keyed by the ring: SMIL time starts when its svg is created,
        // so a fresh one makes the waves start now, not at page load
        <svg key={`waves-${ringing}`} viewBox={`0 0 ${ROOM_W} ${ROOM_H}`} preserveAspectRatio="none" aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}>
          {[0, 0.35].map(begin => (
            <path key={begin} d={`M ${BELL.x + BELL.w + 4} ${BELL.y + 6} q 8 14 0 28`} fill="none" stroke="#fde68a" strokeWidth={2.5} strokeLinecap="round" opacity={0}>
              <animate attributeName="opacity" values="0;1;0" dur="0.7s" begin={`${begin}s`} repeatCount="3" />
              <animateTransform attributeName="transform" type="translate" values="0 0;8 0" dur="0.7s" begin={`${begin}s`} repeatCount="3" />
            </path>
          ))}
        </svg>
      )}
      {ringing > 0 && (
        <Crop key={`bell-${ringing}`} box={BELL} day={dayImage} night={nightImage} nightLevel={night} className="bell-ring" clipPath={BELL_SHAPE} />
      )}
      {incident && (
        <Crop box={EXTINGUISHER} day={dayImage} night={nightImage} nightLevel={night} className="extinguisher-alarm" clipPath="inset(0 round 30%)" />
      )}
    </>
  )
}

export default React.memo(RoomLife)
