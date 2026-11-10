/**
 * AdventCalendar - the advent calendar on the office's back wall at Christmas.
 *
 * Drawn in code (SVG), on the bit of back wall between the right-hand window
 * and the door, above the bell, and skewed to lie flat on that wall. 24 doors
 * in a shuffled grid, as on a real one: those before today are open (a little
 * star, tree or bauble inside), today's swings open when the page loads and
 * keeps a gold glow, the header counts the sleeps to Christmas. On Christmas
 * Day a star shines in the header; after it the header counts down to the New
 * Year, then shows the year with fireworks. Hovering says it in words.
 * advent.ts decides what to show; season.ts decides whether it hangs at all.
 */

import React from 'react'
import { ADVENT_DOORS, adventDate, adventFor, adventLabel, type AdventState } from '../advent'

// Why: a still calendar (today's door already open) when the viewer asks for less motion
const MOVE = !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

// Where it hangs, in % of the room (the room art is drawn at these proportions).
// Why these numbers: measured on office-day/night-xmas, the clear wall between
// the window frame (x 59.5) and the bell's Santa hat, under the garland
const BOX = { left: 59.8, top: 18.2, width: 3.8, height: 6.6 }
// Why 22 degrees: the back wall's top edge falls ~0.405 px per px to the right
// (measured from the corner above the window to the far corner), atan(0.405)
const WALL_SKEW_DEG = 22

// Door n (1-based) sits in grid slot DOOR_SLOT[n - 1]: shuffled, as real ones are
const DOOR_SLOT = [13, 2, 20, 7, 16, 0, 10, 22, 5, 18, 3, 11, 21, 8, 1, 15, 23, 6, 12, 19, 4, 17, 9, 14]
const COLS = 4
const DOOR_W = 7.4
const DOOR_H = 4.8
// Why these: what is behind a door, in turn (star, tree, bauble, snow, present)
const TREATS = ['#facc15', '#22c55e', '#ef4444', '#e0f2fe', '#f472b6']

function slotXY(slot: number): [number, number] {
  return [3 + (slot % COLS) * (DOOR_W + 1.33), 16 + Math.floor(slot / COLS) * (DOOR_H + 1)]
}

function Door({ n, state }: { n: number; state: AdventState }) {
  const [x, y] = slotXY(DOOR_SLOT[n - 1])
  const open = state.kind !== 'advent' || n < state.day
  const today = state.kind === 'advent' && n === state.day
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect width={DOOR_W} height={DOOR_H} fill="#1f2937" />
      {(open || today) && <circle cx={DOOR_W / 2} cy={DOOR_H / 2} r={1.4} fill={TREATS[n % TREATS.length]} />}
      {!open && (
        // The door panel, hinged on its left edge; today's swings open
        <rect width={DOOR_W} height={DOOR_H} fill="#fef3c7" stroke="#b45309" strokeWidth={0.4} transform={today && !MOVE ? 'scale(0.15 1)' : undefined}>
          {today && MOVE && <animateTransform attributeName="transform" type="scale" values="1 1;1 1;0.15 1" keyTimes="0;0.4;1" dur="2s" fill="freeze" />}
        </rect>
      )}
      {today && (
        <rect x={-0.6} y={-0.6} width={DOOR_W + 1.2} height={DOOR_H + 1.2} fill="none" stroke="#fbbf24" strokeWidth={0.9}>
          {MOVE && <animate attributeName="stroke-opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite" />}
        </rect>
      )}
    </g>
  )
}

function Header({ state }: { state: AdventState }) {
  const text = state.kind === 'advent' ? String(state.sleeps)
    : state.kind === 'new-year-countdown' ? String(state.days)
    : state.kind === 'new-year' ? String(state.year) : ''
  return (
    <g>
      <rect x={2} y={2} width={36} height={12} fill={state.kind.startsWith('new-year') ? '#1e3a8a' : '#166534'} />
      {state.kind === 'christmas' ? (
        <polygon points="20,3.5 21.6,7 25.4,7.3 22.5,9.7 23.4,13 20,11.2 16.6,13 17.5,9.7 14.6,7.3 18.4,7" fill="#fde047">
          {MOVE && <animate attributeName="opacity" values="1;0.45;1" dur="1.2s" repeatCount="indefinite" />}
        </polygon>
      ) : (
        <text x={20} y={11.6} textAnchor="middle" fontFamily="monospace" fontWeight="bold" fontSize={state.kind === 'new-year' ? 8 : 10} fill="#fde68a">{text}</text>
      )}
      {state.kind === 'new-year' && MOVE && [[7, 6, '#f472b6', '0s'], [33, 5, '#60a5fa', '0.7s'], [29, 10, '#facc15', '1.3s']].map(([cx, cy, c, begin]) => (
        <circle key={String(cx)} cx={cx as number} cy={cy as number} r={0} fill="none" stroke={c as string} strokeWidth={0.8}>
          <animate attributeName="r" values="0;4" dur="2s" begin={begin as string} repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0" dur="2s" begin={begin as string} repeatCount="indefinite" />
        </circle>
      ))}
    </g>
  )
}

const AdventCalendar: React.FC = () => {
  const state = adventFor(adventDate(new Date(), typeof location === 'undefined' ? '' : location.search))
  if (!state) return null
  const label = adventLabel(state)
  return (
    <div
      className="advent-calendar"
      title={label}
      style={{
        position: 'absolute',
        left: `${BOX.left}%`,
        top: `${BOX.top}%`,
        width: `${BOX.width}%`,
        height: `${BOX.height}%`,
        transform: `skewY(${WALL_SKEW_DEG}deg)`,
        transformOrigin: 'left top',
        zIndex: 3, // Why 3: on the wall, behind every character and piece of furniture
      }}
    >
      <svg viewBox="0 0 40 52" width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label={label}>
        <rect x={0.5} y={0.5} width={39} height={51} rx={1.5} fill="#991b1b" stroke="#fbbf24" strokeWidth={1.2} />
        <Header state={state} />
        {Array.from({ length: ADVENT_DOORS }, (_, i) => <Door key={i} n={i + 1} state={state} />)}
      </svg>
    </div>
  )
}

export default React.memo(AdventCalendar)
