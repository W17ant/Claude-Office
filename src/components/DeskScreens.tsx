/**
 * DeskScreens - animated monitors drawn over a standing desk sprite.
 *
 * screens.ts decides what each of a desk's two monitors shows and where the
 * screens are in the sprite's own pixels; this draws them as SVG on top of the
 * desk image (layer "front"), or as a glow behind a rear desk's monitor backs
 * (layer "back"). Each screen is drawn in a 100 x 100 box mapped onto the
 * slanted monitor face, so its contents follow the monitor's tilt.
 * Animation is SVG SMIL (no per-frame React work); with reduced motion the
 * same pictures are drawn still.
 */

import React, { useId } from 'react'
import type { Affine, DeskGeometry, DeskScreen, ScreenMode, ScreenQuad } from '../screens'

// Why: a static picture instead of motion when the viewer asks for less
const MOVE = !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

/** The 100 x 100 screen box onto monitor face `q` (vertical sides, slanted top and bottom). */
function faceMatrix(q: ScreenQuad): string {
  return `matrix(${(q.x1 - q.x0) / 100} ${(q.y1 - q.y0) / 100} 0 ${q.h / 100} ${q.x0} ${q.y0})`
}

/** The middle of monitor face `q` in sprite pixels. */
function faceCentre(q: ScreenQuad): [number, number] {
  return [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2 + q.h / 2]
}

/** Fade in at `at` (0..1 of a `dur` loop) and stay until the loop restarts. */
function appear(at: number, dur = '4s') {
  return MOVE ? <animate attributeName="opacity" values="0;0;1;1" keyTimes={`0;${at};${Math.min(1, at + 0.04)};1`} dur={dur} repeatCount="indefinite" /> : null
}

// ---------------------------------------------------------------------------
// Scrolling text: code, a terminal, a diff
// ---------------------------------------------------------------------------

/** [indent, width (of 100), colour, row background] */
type Line = [number, number, string, string?]

// Why these colours: a dark editor theme's keyword / string / comment / identifier hues
const CODE: Line[] = [
  [0, 46, '#c4b5fd'], [1, 60, '#7dd3fc'], [2, 38, '#86efac'], [2, 52, '#e2e8f0'],
  [1, 24, '#fca5a5'], [0, 18, '#c4b5fd'], [0, 56, '#64748b'], [0, 40, '#c4b5fd'],
  [1, 66, '#7dd3fc'], [2, 30, '#fde68a'], [1, 44, '#e2e8f0'], [0, 14, '#c4b5fd'],
]
const TERMINAL: Line[] = [
  [0, 40, '#4ade80'], [0, 70, '#94a3b8'], [0, 58, '#94a3b8'], [0, 30, '#4ade80'],
  [0, 64, '#64748b'], [0, 22, '#22c55e'], [0, 48, '#4ade80'], [0, 76, '#94a3b8'],
  [0, 36, '#64748b'], [0, 52, '#4ade80'], [0, 26, '#22c55e'], [0, 60, '#94a3b8'],
]
const DIFF: Line[] = [
  [0, 50, '#94a3b8'], [0, 62, '#fca5a5', '#3f1d1d'], [0, 58, '#86efac', '#123222'], [0, 44, '#86efac', '#123222'],
  [0, 30, '#94a3b8'], [1, 52, '#94a3b8'], [1, 40, '#fca5a5', '#3f1d1d'], [1, 66, '#86efac', '#123222'],
  [0, 20, '#94a3b8'], [0, 48, '#94a3b8'], [1, 56, '#86efac', '#123222'], [0, 34, '#94a3b8'],
]
const GAP = 8 // Why 8 of 100: ~12 lines a screen, chunky enough to read as lines at ~20 px wide

function Lines({ lines, dur, dim = false, still = false }: { lines: Line[]; dur: string; dim?: boolean; still?: boolean }) {
  const period = lines.length * GAP
  return (
    <g opacity={dim ? 0.35 : 1}>
      {MOVE && !still && <animateTransform attributeName="transform" type="translate" from="0 0" to={`0 ${-period}`} dur={dur} repeatCount="indefinite" />}
      {(still ? lines : [...lines, ...lines]).map(([indent, w, colour, bg], i) => (
        <g key={i}>
          {bg && <rect x={0} y={4 + i * GAP} width={100} height={GAP} fill={bg} />}
          <rect x={6 + indent * 7} y={6 + i * GAP} width={w * 0.8} height={4} fill={colour} />
        </g>
      ))}
    </g>
  )
}

function Cursor({ x, y }: { x: number; y: number }) {
  return (
    <rect x={x} y={y} width={6} height={6} fill="#e2e8f0">
      {MOVE && <animate attributeName="opacity" values="1;0" dur="1s" calcMode="discrete" repeatCount="indefinite" />}
    </rect>
  )
}

// ---------------------------------------------------------------------------
// One kind of screen each
// ---------------------------------------------------------------------------

/** A web page building itself in a browser window, a mouse pointer wandering over it. */
function Web() {
  return (
    <>
      <rect width={100} height={100} fill="#f8fafc" />
      <rect width={100} height={12} fill="#cbd5e1" />
      <circle cx={6} cy={6} r={2.5} fill="#ef4444" /><circle cx={13} cy={6} r={2.5} fill="#f59e0b" /><circle cx={20} cy={6} r={2.5} fill="#22c55e" />
      <rect x={28} y={3} width={64} height={6} rx={3} fill="#f1f5f9" />
      <rect x={8} y={18} width={84} height={20} fill="#6366f1">{appear(0.08)}</rect>
      <rect x={14} y={24} width={40} height={4} fill="#e0e7ff">{appear(0.14)}</rect>
      {[8, 38, 68].map((x, i) => <rect key={x} x={x} y={44} width={24} height={20} fill="#cbd5e1">{appear(0.28 + i * 0.12)}</rect>)}
      <rect x={8} y={70} width={50} height={4} fill="#94a3b8">{appear(0.66)}</rect>
      <rect x={8} y={78} width={36} height={4} fill="#94a3b8">{appear(0.7)}</rect>
      <rect x={64} y={72} width={28} height={12} rx={3} fill="#22c55e">{appear(0.8)}</rect>
      <polygon points="0,0 0,13 3.5,10 6.5,16 9,15 6,9 11,9" fill="#0f172a" stroke="#fff" strokeWidth={1}>
        {MOVE && <animateMotion path="M 82 90 L 50 30 L 22 56 L 76 76 Z" dur="4s" repeatCount="indefinite" />}
      </polygon>
    </>
  )
}

/** A test run: results going green one by one, the progress bar filling. */
function Tests() {
  return (
    <>
      <rect width={100} height={100} fill="#0b1220" />
      {[56, 40, 66, 30, 50, 44].map((w, i) => {
        const t = 0.08 + i * 0.12
        return (
          <g key={i}>
            <rect x={8} y={8 + i * 12} width={7} height={7} fill="#22c55e">
              {MOVE && <animate attributeName="fill" values="#475569;#475569;#22c55e;#22c55e" keyTimes={`0;${t};${t + 0.02};1`} dur="4s" repeatCount="indefinite" />}
            </rect>
            <rect x={20} y={9.5 + i * 12} width={w} height={4} fill="#94a3b8" />
          </g>
        )
      })}
      <rect x={8} y={84} width={84} height={7} fill="#1e293b" />
      <rect x={8} y={84} width={84} height={7} fill="#22c55e">
        {MOVE && <animate attributeName="width" values="0;84;84" keyTimes="0;0.85;1" dur="4s" repeatCount="indefinite" />}
      </rect>
    </>
  )
}

/** A deploy pipeline: four stages lighting up yellow, then green, left to right. */
function Pipeline() {
  const xs = [6, 30, 54, 78]
  return (
    <>
      <rect width={100} height={100} fill="#0b1220" />
      <line x1={14} y1={32} x2={86} y2={32} stroke="#475569" strokeWidth={3} />
      {xs.map((x, i) => {
        const t = 0.05 + i * 0.2
        return (
          <rect key={x} x={x} y={24} width={16} height={16} rx={3} fill="#22c55e">
            {MOVE && <animate attributeName="fill" values="#334155;#334155;#facc15;#22c55e;#22c55e" keyTimes={`0;${t};${t + 0.01};${t + 0.18};1`} dur="5s" repeatCount="indefinite" />}
          </rect>
        )
      })}
      {[52, 60, 68, 76].map((y, i) => <rect key={y} x={6} y={y} width={[60, 42, 70, 30][i]} height={4} fill={i % 2 ? '#64748b' : '#4ade80'} />)}
      <Cursor x={40} y={75} />
    </>
  )
}

/** A live bar chart: the bars rise and fall. */
function Chart() {
  const loops = ['20;55;35;70;20', '50;30;65;40;50', '35;70;45;25;35', '60;40;20;55;60', '25;45;75;50;25', '45;65;30;60;45', '30;20;50;80;30']
  return (
    <>
      <rect width={100} height={100} fill="#0b1220" />
      <line x1={8} y1={8} x2={8} y2={88} stroke="#475569" strokeWidth={2} />
      <line x1={8} y1={88} x2={94} y2={88} stroke="#475569" strokeWidth={2} />
      {loops.map((v, i) => {
        const first = Number(v.split(';')[0])
        return (
          <rect key={i} x={14 + i * 11} y={88 - first} width={7} height={first} fill={i === 6 ? '#f472b6' : '#38bdf8'}>
            {MOVE && <animate attributeName="height" values={v} dur="3s" repeatCount="indefinite" />}
            {MOVE && <animate attributeName="y" values={v.split(';').map(h => 88 - Number(h)).join(';')} dur="3s" repeatCount="indefinite" />}
          </rect>
        )
      })}
    </>
  )
}

/** A table being scanned row by row. */
function Data() {
  return (
    <>
      <rect width={100} height={100} fill="#0f172a" />
      <rect x={0} y={8} width={100} height={10} fill="#334155" />
      {[0, 1, 2, 3, 4, 5, 6].map(i => (
        <g key={i}>
          <rect x={0} y={20 + i * 10} width={100} height={10} fill={i % 2 ? '#0f172a' : '#1e293b'} />
          {[8, 40, 70].map((x, c) => <rect key={x} x={x} y={23.5 + i * 10} width={[22, 20, 18][c] - ((i * 7 + c * 5) % 9)} height={3} fill="#94a3b8" />)}
        </g>
      ))}
      {[8, 40, 70].map(x => <rect key={x} x={x} y={11} width={18} height={4} fill="#e2e8f0" />)}
      <rect x={0} y={20} width={100} height={10} fill="#0ea5e9" opacity={0.35}>
        {MOVE && <animate attributeName="y" values="20;30;40;50;60;70;80" dur="2.8s" calcMode="discrete" repeatCount="indefinite" />}
      </rect>
    </>
  )
}

/** A chat: prompts and answers scrolling up. */
function Chat() {
  const bubbles: Array<[boolean, number, number]> = [[false, 52, 10], [true, 40, 8], [false, 64, 16], [true, 30, 8], [false, 48, 10], [true, 56, 12]]
  let y = 6
  const placed = bubbles.map(([mine, w, h]) => { const at = y; y += h + 6; return { mine, w, h, at } })
  const period = y
  return (
    <>
      <rect width={100} height={100} fill="#111827" />
      <g>
        {MOVE && <animateTransform attributeName="transform" type="translate" from="0 0" to={`0 ${-period}`} dur="6s" repeatCount="indefinite" />}
        {[0, period].map(off => placed.map((b, i) => (
          <rect key={`${off}-${i}`} x={b.mine ? 94 - b.w : 6} y={b.at + off} width={b.w} height={b.h} rx={3} fill={b.mine ? '#7c3aed' : '#374151'} />
        )))}
      </g>
    </>
  )
}

/** A file list with a magnifier sweeping it. */
function Search() {
  return (
    <>
      <rect width={100} height={100} fill="#0b1220" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
        <g key={i}>
          <rect x={8} y={8 + i * 10} width={5} height={6} fill={i % 3 ? '#64748b' : '#fbbf24'} />
          <rect x={17} y={9 + i * 10} width={[40, 56, 32, 48, 60, 28, 44, 36][i]} height={4} fill="#94a3b8" />
        </g>
      ))}
      <g>
        {MOVE && <animateTransform attributeName="transform" type="translate" values="0 0;0 20;0 40;0 60;0 30;0 0" dur="4s" repeatCount="indefinite" />}
        <rect x={4} y={6} width={92} height={10} fill="#fbbf24" opacity={0.25} />
        <circle cx={82} cy={11} r={6} fill="none" stroke="#fbbf24" strokeWidth={2.5} />
        <line x1={86} y1={15} x2={92} y2={21} stroke="#fbbf24" strokeWidth={3} strokeLinecap="round" />
      </g>
    </>
  )
}

/** Code stepped through line by line past a red breakpoint. */
function Debug() {
  return (
    <>
      <rect width={100} height={100} fill="#0d1526" />
      <Lines lines={CODE.slice(0, 11)} dur="0s" still />
      <circle cx={3} cy={8 + 4 * GAP} r={2.5} fill="#ef4444" />
      <rect x={0} y={4} width={100} height={GAP} fill="#facc15" opacity={0.22}>
        {MOVE && <animate attributeName="y" values="4;12;20;28;36;44;52" dur="3.5s" calcMode="discrete" repeatCount="indefinite" />}
      </rect>
    </>
  )
}

/** An inbox with a new message sliding in at the top. */
function Mail() {
  return (
    <>
      <rect width={100} height={100} fill="#f8fafc" />
      <rect width={100} height={10} fill="#e2e8f0" />
      <rect x={6} y={3} width={20} height={4} fill="#ef4444" />
      <g>
        {MOVE && <animateTransform attributeName="transform" type="translate" values="0 -12;0 0;0 0" keyTimes="0;0.2;1" dur="2.5s" repeatCount="indefinite" />}
        {[0, 1, 2, 3, 4, 5, 6].map(i => (
          <g key={i}>
            <rect x={6} y={14 + i * 12} width={10} height={7} fill="none" stroke="#64748b" strokeWidth={1.5} />
            <polyline points={`6,${14 + i * 12} 11,${18 + i * 12} 16,${14 + i * 12}`} fill="none" stroke="#64748b" strokeWidth={1.5} />
            <rect x={20} y={14 + i * 12} width={[24, 30, 20, 28, 22, 26, 18][i]} height={3} fill={i === 0 ? '#1d4ed8' : '#334155'} />
            <rect x={20} y={19 + i * 12} width={[56, 48, 62, 40, 52, 58, 44][i]} height={2.5} fill="#94a3b8" />
            {i === 0 && <circle cx={94} cy={17} r={2.5} fill="#2563eb" />}
          </g>
        ))}
      </g>
    </>
  )
}

/** The security auditor's yellow warning sign, a scan line passing over it. */
function Security() {
  return (
    <>
      <rect width={100} height={100} fill="#1c1607" />
      {MOVE && (
        <rect x={0} width={100} height={5} fill="#facc15" opacity={0.25}>
          <animate attributeName="y" values="-5;100" dur="2.2s" repeatCount="indefinite" />
        </rect>
      )}
      <g>
        {MOVE && <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />}
        <polygon points="50,14 84,80 16,80" fill="#facc15" stroke="#0a0a0a" strokeWidth={4} strokeLinejoin="round" />
        <rect x={46} y={34} width={8} height={26} fill="#0a0a0a" />
        <rect x={46} y={65} width={8} height={8} fill="#0a0a0a" />
      </g>
    </>
  )
}

function Screen({ q, mode, clipId }: { q: ScreenQuad; mode: ScreenMode; clipId: string }) {
  if (mode === 'idle') return null // Why: the desk art's own lit-blue screens are the idle look
  let body: React.ReactNode
  switch (mode) {
    case 'off': body = <rect width={100} height={100} fill="#0b1018" opacity={0.9} />; break
    case 'code': body = <><rect width={100} height={100} fill="#0d1526" /><Lines lines={CODE} dur="3.6s" /><Cursor x={6} y={86} /></>; break
    case 'terminal': body = <><rect width={100} height={100} fill="#050805" /><Lines lines={TERMINAL} dur="2.4s" /><Cursor x={6} y={86} /></>; break
    case 'diff': body = <><rect width={100} height={100} fill="#0d1117" /><Lines lines={DIFF} dur="5s" /></>; break
    case 'web': body = <Web />; break
    case 'tests': body = <Tests />; break
    case 'pipeline': body = <Pipeline />; break
    case 'chart': body = <Chart />; break
    case 'data': body = <Data />; break
    case 'chat': body = <Chat />; break
    case 'search': body = <Search />; break
    case 'debug': body = <Debug />; break
    case 'mail': body = <Mail />; break
    case 'security': body = <Security />; break
    case 'bug':
      body = (
        <>
          {/* Why 1 s: one flash a second, far under the 3-a-second photosensitivity limit */}
          <rect width={100} height={100} fill="#7f1d1d">
            {MOVE && <animate attributeName="fill" values="#7f1d1d;#dc2626" dur="1s" calcMode="discrete" repeatCount="indefinite" />}
          </rect>
          <Lines lines={CODE} dur="3.6s" dim />
        </>
      )
      break
  }
  return (
    <g transform={faceMatrix(q)} clipPath={`url(#${clipId})`}>
      <clipPath id={clipId}><rect x={0} y={0} width={100} height={100} /></clipPath>
      {body}
    </g>
  )
}

/** A top-down pixel bug, nose along +x, about 60 sprite pixels long. */
function Bug() {
  const legs = (side: 1 | -1, phase: string) => (
    <g>
      {MOVE && <animateTransform attributeName="transform" type="rotate" values={phase} dur="0.3s" repeatCount="indefinite" />}
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

const affine = (m: Affine) => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`

/** The laptop: a small screen in the colour of what the monitors show, a few lines on it. */
function Laptop({ m, mode }: { m: Affine; mode: ScreenMode }) {
  if (mode === 'idle') return null // the art's own lit screen
  const fill = mode === 'off' ? '#0b1018' : mode === 'bug' ? '#b91c1c' : '#0d1526'
  const ink = GLOW[mode] ?? '#94a3b8'
  return (
    <g transform={affine(m)}>
      <rect width={100} height={100} fill={fill} opacity={mode === 'off' ? 0.9 : 1}>
        {MOVE && mode === 'bug' && <animate attributeName="fill" values="#7f1d1d;#dc2626" dur="1s" calcMode="discrete" repeatCount="indefinite" />}
      </rect>
      {mode !== 'off' && [18, 38, 58, 78].map((y, i) => (
        <rect key={y} x={10} y={y} width={[70, 50, 62, 36][i]} height={9} fill={ink} opacity={0.8}>
          {MOVE && <animate attributeName="width" values={`${[70, 50, 62, 36][i]};${[40, 66, 30, 58][i]};${[70, 50, 62, 36][i]}`} dur={`${2 + i * 0.4}s`} repeatCount="indefinite" />}
        </rect>
      ))}
    </g>
  )
}

/** Keys lighting up under the worker's fingers while it is busy. */
function Keyboard({ m }: { m: Affine }) {
  if (!MOVE) return null
  // Why these: key positions spread over the board, each on its own beat so it reads as typing
  const keys: Array<[number, number, string]> = [[18, 30, '0.9s'], [42, 55, '0.7s'], [66, 25, '1.1s'], [30, 70, '0.8s'], [78, 60, '1.3s'], [55, 40, '0.6s']]
  return (
    <g transform={affine(m)}>
      {keys.map(([x, y, dur]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={9} height={14} fill="#e2e8f0" opacity={0}>
          <animate attributeName="opacity" values="0;0.85;0;0" keyTimes="0;0.1;0.3;1" dur={dur} repeatCount="indefinite" />
        </rect>
      ))}
    </g>
  )
}

// The colour a rear desk glows for what its (unseen) screens show
const GLOW: Partial<Record<ScreenMode, string>> = {
  bug: '#ef4444', security: '#facc15', code: '#60a5fa', terminal: '#4ade80', diff: '#86efac',
  web: '#e2e8f0', tests: '#4ade80', pipeline: '#facc15', chart: '#38bdf8', data: '#0ea5e9',
  chat: '#a78bfa', search: '#fbbf24', debug: '#f59e0b', mail: '#e2e8f0',
}

interface Props {
  geometry: DeskGeometry
  /** What the two monitors show, left then right */
  screens: DeskScreen
  /** "back" draws behind the desk image (a rear desk's glow), "front" over it (the screens) */
  layer: 'back' | 'front'
}

const DeskScreens: React.FC<Props> = ({ geometry: g, screens, layer }) => {
  const id = useId().replace(/:/g, '')
  const bug = screens[0] === 'bug'
  // Why the bug or else the first screen: on a rear desk only one colour shows
  const glow = GLOW[bug ? 'bug' : screens.find(m => GLOW[m]) ?? 'off']
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
            {MOVE && (bug
              ? <animate attributeName="opacity" values="1;0.2" dur="1s" calcMode="discrete" repeatCount="indefinite" />
              : <animate attributeName="opacity" values="0.6;1;0.6" dur="2.4s" repeatCount="indefinite" />)}
          </ellipse>
        </>
      )}
      {layer === 'front' && (
        <>
          {g.screens.map((q, i) => <Screen key={i} q={q} mode={screens[Math.min(i, 1)]} clipId={`${id}-s${i}`} />)}
          {g.laptop && <Laptop m={g.laptop} mode={screens[0]} />}
          {g.keyboard && screens[0] !== 'off' && screens[0] !== 'idle' && screens[0] !== 'bug' && <Keyboard m={g.keyboard} />}
          {bug && g.screens.length >= 2 && (() => {
            // The bug walks from one monitor to the other (across the gap between them) and back
            const [ax, ay] = faceCentre(g.screens[0])
            const [bx, by] = faceCentre(g.screens[g.screens.length - 1])
            return MOVE ? (
              <g>
                {/* Why there and back as one path: rotate="auto" follows the path's direction, so the return leg must be its own segment or the bug would walk home backwards */}
                <animateMotion path={`M ${ax} ${ay} L ${bx} ${by} L ${ax} ${ay}`} keyPoints="0;0.5;0.5;1;1" keyTimes="0;0.42;0.5;0.92;1" calcMode="linear" dur="5s" rotate="auto" repeatCount="indefinite" />
                <Bug />
              </g>
            ) : (
              <g transform={`translate(${ax} ${ay})`}><Bug /></g>
            )
          })()}
        </>
      )}
    </svg>
  )
}

export default React.memo(DeskScreens)
