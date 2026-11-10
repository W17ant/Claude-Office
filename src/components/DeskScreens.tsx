/**
 * DeskScreens - animated monitors drawn over a standing desk sprite.
 *
 * screens.ts decides the mode (off, code, bug, security) and where the
 * screens are in the sprite's own pixels; this draws it as SVG on top of the
 * desk image (layer "front"), or as a glow behind a rear desk's monitor backs
 * (layer "back"). Each screen is drawn in a 100 x 100 box mapped onto the
 * slanted monitor face, so code lines and the warning sign follow its tilt.
 * Animation is SVG SMIL (no per-frame React work); with reduced motion the
 * same pictures are drawn still.
 */

import React, { useId } from 'react'
import type { DeskGeometry, ScreenMode, ScreenQuad } from '../screens'

// Why: a static picture instead of motion when the viewer asks for less
const REDUCED_MOTION = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The 100 x 100 screen box onto monitor face `q` (vertical sides, slanted top and bottom). */
function faceMatrix(q: ScreenQuad): string {
  return `matrix(${(q.x1 - q.x0) / 100} ${(q.y1 - q.y0) / 100} 0 ${q.h / 100} ${q.x0} ${q.y0})`
}

/** The middle of monitor face `q` in sprite pixels. */
function faceCentre(q: ScreenQuad): [number, number] {
  return [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2 + q.h / 2]
}

// One screenful of "code": [indent, width, colour] per line; drawn twice so the scroll loops
// Why these colours: a dark editor theme's keyword / string / comment / identifier hues
const CODE: Array<[number, number, string]> = [
  [0, 46, '#c4b5fd'], [1, 60, '#7dd3fc'], [2, 38, '#86efac'], [2, 52, '#e2e8f0'],
  [1, 24, '#fca5a5'], [0, 18, '#c4b5fd'], [0, 56, '#64748b'], [0, 40, '#c4b5fd'],
  [1, 66, '#7dd3fc'], [2, 30, '#fde68a'], [1, 44, '#e2e8f0'], [0, 14, '#c4b5fd'],
]
const LINE_GAP = 8 // Why 8 of 100: ~12 lines a screen, chunky enough to read as lines at ~20 px wide
const PERIOD = CODE.length * LINE_GAP

function CodeLines({ dim = false }: { dim?: boolean }) {
  const lines = [...CODE, ...CODE]
  return (
    <g opacity={dim ? 0.35 : 1}>
      {!REDUCED_MOTION && (
        <animateTransform attributeName="transform" type="translate" from="0 0" to={`0 ${-PERIOD}`} dur="3.6s" repeatCount="indefinite" />
      )}
      {lines.map(([indent, w, colour], i) => (
        <rect key={i} x={6 + indent * 7} y={6 + i * LINE_GAP} width={w * 0.8} height={4} fill={colour} />
      ))}
    </g>
  )
}

function Screen({ q, mode, clipId }: { q: ScreenQuad; mode: ScreenMode; clipId: string }) {
  if (mode === 'idle') return null // Why: the desk art's own lit-blue screens are the idle look
  return (
    <g transform={faceMatrix(q)} clipPath={`url(#${clipId})`}>
      <clipPath id={clipId}><rect x={0} y={0} width={100} height={100} /></clipPath>
      {mode === 'off' && <rect width={100} height={100} fill="#0b1018" opacity={0.9} />}
      {mode === 'code' && (
        <>
          <rect width={100} height={100} fill="#0d1526" />
          <CodeLines />
          {!REDUCED_MOTION && (
            <rect x={6} y={86} width={6} height={6} fill="#e2e8f0">
              <animate attributeName="opacity" values="1;0" dur="1s" calcMode="discrete" repeatCount="indefinite" />
            </rect>
          )}
        </>
      )}
      {mode === 'bug' && (
        <>
          {/* Why 1 s: one flash a second, far under the 3-a-second photosensitivity limit */}
          <rect width={100} height={100} fill="#7f1d1d">
            {!REDUCED_MOTION && <animate attributeName="fill" values="#7f1d1d;#dc2626" dur="1s" calcMode="discrete" repeatCount="indefinite" />}
          </rect>
          <CodeLines dim />
        </>
      )}
      {mode === 'security' && (
        <>
          <rect width={100} height={100} fill="#1c1607" />
          {!REDUCED_MOTION && (
            <rect x={0} width={100} height={5} fill="#facc15" opacity={0.25}>
              <animate attributeName="y" values="-5;100" dur="2.2s" repeatCount="indefinite" />
            </rect>
          )}
          <g>
            {!REDUCED_MOTION && <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />}
            <polygon points="50,14 84,80 16,80" fill="#facc15" stroke="#0a0a0a" strokeWidth={4} strokeLinejoin="round" />
            <rect x={46} y={34} width={8} height={26} fill="#0a0a0a" />
            <rect x={46} y={65} width={8} height={8} fill="#0a0a0a" />
          </g>
        </>
      )}
    </g>
  )
}

/** A top-down pixel bug, nose along +x, about 60 sprite pixels long. */
function Bug() {
  const legs = (side: 1 | -1, phase: string) => (
    <g>
      {!REDUCED_MOTION && <animateTransform attributeName="transform" type="rotate" values={phase} dur="0.3s" repeatCount="indefinite" />}
      {[-10, 0, 10].map(x => <line key={x} x1={x} y1={0} x2={x - 6} y2={side * 20} stroke="#0a0a0a" strokeWidth={4} strokeLinecap="round" />)}
    </g>
  )
  return (
    <g>
      {legs(1, '-12;12;-12')}
      {legs(-1, '12;-12;12')}
      <line x1={22} y1={-4} x2={34} y2={-14} stroke="#0a0a0a" strokeWidth={3} strokeLinecap="round" />
      <line x1={22} y1={4} x2={34} y2={14} stroke="#0a0a0a" strokeWidth={3} strokeLinecap="round" />
      <ellipse cx={0} cy={0} rx={18} ry={13} fill="#111" stroke="#fca5a5" strokeWidth={2} />
      <line x1={-18} y1={0} x2={14} y2={0} stroke="#fca5a5" strokeWidth={2} />
      <circle cx={21} cy={0} r={8} fill="#111" stroke="#fca5a5" strokeWidth={2} />
    </g>
  )
}

const GLOW: Partial<Record<ScreenMode, string>> = { code: '#60a5fa', bug: '#ef4444', security: '#facc15' }

interface Props {
  geometry: DeskGeometry
  mode: ScreenMode
  /** "back" draws behind the desk image (a rear desk's glow), "front" over it (the screens) */
  layer: 'back' | 'front'
}

const DeskScreens: React.FC<Props> = ({ geometry: g, mode, layer }) => {
  const id = useId().replace(/:/g, '')
  const glow = GLOW[mode]
  if (layer === 'back' && !(g.glow && glow)) return null
  if (layer === 'front' && !g.screens.length) return null
  return (
    <svg
      className={`desk-screens desk-screens-${layer}`}
      viewBox={`0 0 ${g.w} ${g.h}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: layer === 'back' ? 0 : 2 }}
    >
      {layer === 'back' && g.glow && glow && (
        <>
          <defs>
            <radialGradient id={`${id}-glow`}>
              <stop offset="0%" stopColor={glow} stopOpacity={0.75} />
              <stop offset="100%" stopColor={glow} stopOpacity={0} />
            </radialGradient>
          </defs>
          <ellipse cx={g.glow.cx} cy={g.glow.cy} rx={g.glow.rx} ry={g.glow.ry} fill={`url(#${id}-glow)`}>
            {!REDUCED_MOTION && (mode === 'bug'
              ? <animate attributeName="opacity" values="1;0.2" dur="1s" calcMode="discrete" repeatCount="indefinite" />
              : <animate attributeName="opacity" values="0.6;1;0.6" dur="2.4s" repeatCount="indefinite" />)}
          </ellipse>
        </>
      )}
      {layer === 'front' && (
        <>
          {g.screens.map((q, i) => <Screen key={i} q={q} mode={mode} clipId={`${id}-s${i}`} />)}
          {mode === 'bug' && g.screens.length >= 2 && (() => {
            // The bug walks from one monitor to the other (across the gap between them) and back
            const [ax, ay] = faceCentre(g.screens[0])
            const [bx, by] = faceCentre(g.screens[g.screens.length - 1])
            return REDUCED_MOTION ? (
              <g transform={`translate(${ax} ${ay})`}><Bug /></g>
            ) : (
              <g>
                {/* Why there and back as one path: rotate="auto" follows the path's direction, so the return leg must be its own segment or the bug would walk home backwards */}
                <animateMotion path={`M ${ax} ${ay} L ${bx} ${by} L ${ax} ${ay}`} keyPoints="0;0.5;0.5;1;1" keyTimes="0;0.42;0.5;0.92;1" calcMode="linear" dur="5s" rotate="auto" repeatCount="indefinite" />
                <Bug />
              </g>
            )
          })()}
        </>
      )}
    </svg>
  )
}

export default React.memo(DeskScreens)
