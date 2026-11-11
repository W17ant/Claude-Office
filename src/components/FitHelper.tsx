/**
 * FitHelper - /?fithelper: place and size every worn accessory by hand (Halloween masks, the witch hat, the Santa hat), then export the tables.
 *
 * Each tab shows every cast sprite that wears that piece, large, wearing it
 * exactly as the office draws it (maskOnEyes / hatOnHead in src/hat.ts).
 * Click one, then:
 *
 *   arrow keys    move it (Shift: ten times further)
 *   + / -         make it bigger / smaller (Shift: faster)
 *   0             back to the table's value for this sprite
 *
 * Edits are kept in this browser (localStorage) until exported. **Export**
 * writes the text of src/eyes.ts's EYES (masks) and src/hatFit.ts's HAT_FIT
 * (hats), edited entries included, ready to paste.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ROLE_TO_CHAR } from '../config'
import { EYES, type EyeLine } from '../eyes'
import { SANTA_HAT, WITCH_HAT, halloweenPiece, hatMirrored, hatOnHead, maskOnEyes, useHeadAnchor, wearsOverlayHat, type HalloweenPiece } from '../hat'
import { HAT_FIT, type HatKind, type HatNudge } from '../hatFit'
import { SEASON_SUFFIX } from '../seasonNames'
import { getAllOfficeCharacters } from '../theme'

const STORE = 'agent-office.fit-tuning'
// Why 0.004: about one source pixel on these ~400 px wide sprites at the
// helper's size, fine enough to line a hole up with a pupil
const STEP = 0.004
// Why 4%: a visible but controllable change in size per press
const GROW = 1.04
const CARD_H = 320
const DIRS = ['/sprites/characters', '/sprites/office/characters']
const FACINGS = ['front-left', 'front-right', 'rear-left', 'rear-right']

type Tab = 'mask' | HatKind
interface Edits {
  mask: Record<string, EyeLine>
  santa: Record<string, HatNudge>
  witch: Record<string, HatNudge>
}
const NO_EDITS: Edits = { mask: {}, santa: {}, witch: {} }

function loadEdits(): Edits {
  try {
    return { ...NO_EDITS, ...(JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Edits>) }
  } catch {
    return NO_EDITS
  }
}

const n3 = (v: number) => v.toFixed(3)

/** src/eyes.ts's table as TypeScript, sorted like the file */
export function exportEyes(table: Record<string, EyeLine>): string {
  const lines = Object.keys(table).sort().map(k => {
    const e = table[k]
    return `  '${k}': { x: ${n3(e.x)}, y: ${n3(e.y)}, spacing: ${n3(e.spacing)}${e.width !== undefined ? `, width: ${n3(e.width)}` : ''} },`
  })
  return `export const EYES: Readonly<Record<string, EyeLine>> = {\n${lines.join('\n')}\n}\n`
}

/** src/hatFit.ts's table as TypeScript; a nudge that moves nothing is left out */
export function exportHatFit(table: Record<HatKind, Record<string, HatNudge>>): string {
  const kind = (k: HatKind) => Object.keys(table[k]).sort()
    .filter(s => { const v = table[k][s]; return n3(v.dx) !== '0.000' || n3(v.dy) !== '0.000' || n3(v.size) !== '1.000' })
    .map(s => { const v = table[k][s]; return `    '${s}': { dx: ${n3(v.dx)}, dy: ${n3(v.dy)}, size: ${n3(v.size)} },` })
  return `export const HAT_FIT: Readonly<Record<HatKind, Readonly<Record<string, HatNudge>>>> = {\n  santa: {\n${kind('santa').map(l => `${l}\n`).join('')}  },\n  witch: {\n${kind('witch').map(l => `${l}\n`).join('')}  },\n}\n`
}

/** The character of a sprite key: `dev-1-front-left` -> `dev-1` */
const characterOf = (key: string) => key.replace(/-(front|rear)-(left|right)$/, '')

/**
 * The URLs to try for a sprite, best first: its seasonal copy for the tab's
 * holiday (what the office draws then, e.g. a Christmas jumper), then the
 * plain sprite, in each cast's folder
 */
function candidates(key: string, tab: Tab): string[] {
  const suffix = tab === 'santa' ? SEASON_SUFFIX.christmas : SEASON_SUFFIX.halloween
  // Why joined with + and not a template: scripts/check-assets.mjs reads
  // templates as new asset paths; these are only the office's own sprite
  // paths (theme.ts getSpritePath and its seasonal copies), tried in turn
  return [...DIRS.map(d => d + '/' + key + suffix + '.webp'), ...DIRS.map(d => d + '/' + key + '.png')]
}

/** A sprite key as a file name, for the who-wears-what rules in src/hat.ts (they read only the name) */
const asFile = (key: string) => key + '.png'

/** One sprite, large, with what it wears drawn on top by `children(src)` */
const Frame: React.FC<{
  name: string; tab: Tab; selected: boolean; edited: boolean; onPick: () => void
  children: (src: string) => React.ReactNode
}> = ({ name, tab, selected, edited, onPick, children }) => {
  const srcs = useMemo(() => candidates(name, tab), [name, tab])
  const [i, setI] = useState(0)
  const src = srcs[Math.min(i, srcs.length - 1)]
  // Why the room above the sprite: a hat stands up off the hair, and a tall
  // mask (Frankenstein's flat head) can reach past the image's top
  const pad = tab === 'mask' ? CARD_H * 0.12 : CARD_H * 0.35
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        position: 'relative', height: CARD_H, padding: 0, margin: 4, overflow: 'hidden', cursor: 'pointer',
        background: '#3a6ea5', border: selected ? '3px solid #ffd54a' : edited ? '3px solid #6fdc8c' : '3px solid transparent',
        borderRadius: 6,
      }}
      title={name}
    >
      {/* Why 2.2 times the card's height: the head is the top part of the sprite */}
      <div style={{ position: 'relative', height: CARD_H * 2.2, marginTop: pad }}>
        <img
          src={src}
          alt={name}
          onError={() => setI(v => v + 1)}
          style={{ height: '100%', width: 'auto', display: 'block', imageRendering: 'pixelated' }}
          draggable={false}
        />
        {children(src)}
      </div>
      <span style={{ position: 'absolute', left: 4, bottom: 4, font: '11px monospace', color: '#fff', background: '#0008', padding: '1px 4px' }}>{name}</span>
    </button>
  )
}

const overlayStyle: React.CSSProperties = { position: 'absolute', height: 'auto', imageRendering: 'pixelated', pointerEvents: 'none' }

/** A mask on the eyes, as Character draws it */
const MaskOn: React.FC<{ piece: HalloweenPiece; eye: EyeLine; right: boolean }> = ({ piece, eye, right }) => {
  const on = maskOnEyes(piece, eye, right)
  if (!on) return null
  return (
    <img src={piece.src} alt="" draggable={false} style={{
      ...overlayStyle, left: `${on.left * 100}%`, top: `${on.top * 100}%`, width: `${on.width * 100}%`,
      transform: `translate(${on.shiftX * 100}%, ${on.shiftY * 100}%)${right ? ' scaleX(-1)' : ''}`,
    }} />
  )
}

/** A hat on the head measured from `src`, as Character draws it */
const HatOn: React.FC<{ piece: HalloweenPiece; src: string; nudge?: HatNudge; right: boolean; away: boolean }> = ({ piece, src, nudge, right, away }) => {
  const head = useHeadAnchor(src, true)
  if (!head) return null
  const on = hatOnHead(head, piece, nudge)
  return (
    <img src={piece.src} alt="" draggable={false} style={{
      ...overlayStyle, left: `${on.left * 100}%`, width: `${on.width * 100}%`, bottom: `${on.bottom * 100}%`,
      transform: hatMirrored(piece, right, away) ? 'scaleX(-1)' : undefined,
    }} />
  )
}

const FitHelper: React.FC = () => {
  const [edits, setEdits] = useState<Edits>(loadEdits)
  const [tab, setTab] = useState<Tab>('mask')
  const [picked, setPicked] = useState<string | null>(null)
  const [out, setOut] = useState('')

  // Who wears what: the masked front poses listed in src/eyes.ts; every
  // facing of each character wearing the Santa hat or the witch hat
  const lists = useMemo(() => {
    const cast = Array.from(new Set([...Object.values(ROLE_TO_CHAR), 'Claude-1', 'Me-1', ...getAllOfficeCharacters()])).sort()
    const sprites = (keep: (c: string) => boolean) => cast.filter(keep).flatMap(c => FACINGS.map(f => `${c}-${f}`))
    return {
      mask: Object.keys(EYES).filter(k => halloweenPiece(asFile(k))?.kind === 'mask').sort(),
      santa: sprites(c => wearsOverlayHat(asFile(c + '-front-left'))),
      witch: sprites(c => halloweenPiece(asFile(c + '-front-left'))?.src === WITCH_HAT.src),
    }
  }, [])

  const eyeOf = useCallback((k: string): EyeLine => edits.mask[k] ?? EYES[k], [edits])
  const nudgeOf = useCallback((kind: HatKind, k: string): HatNudge => edits[kind][k] ?? HAT_FIT[kind][k] ?? { dx: 0, dy: 0, size: 1 }, [edits])

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(edits)) } catch { /* private window: edits last this page only */ }
  }, [edits])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!picked) return
      const step = e.shiftKey ? STEP * 10 : STEP
      const grow = e.shiftKey ? GROW ** 3 : GROW
      const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key]
      const resize = e.key === '+' || e.key === '=' ? grow : e.key === '-' || e.key === '_' ? 1 / grow : null
      if (e.key === '0') {
        setEdits(prev => { const t = { ...prev[tab] }; delete t[picked]; return { ...prev, [tab]: t } })
      } else if (tab === 'mask' && (move || resize)) {
        const cur = eyeOf(picked)
        const piece = halloweenPiece(asFile(picked))
        const width = cur.width ?? (piece ? maskOnEyes(piece, cur, false)?.width : undefined) ?? 0.5
        const next = move ? { ...cur, x: cur.x + move[0], y: cur.y + move[1] } : { ...cur, width: width * resize! }
        setEdits(prev => ({ ...prev, mask: { ...prev.mask, [picked]: next } }))
      } else if (tab !== 'mask' && (move || resize)) {
        const cur = nudgeOf(tab, picked)
        const next = move ? { ...cur, dx: cur.dx + move[0], dy: cur.dy + move[1] } : { ...cur, size: cur.size * resize! }
        setEdits(prev => ({ ...prev, [tab]: { ...prev[tab], [picked]: next } }))
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked, tab, eyeOf, nudgeOf])

  const doExport = () => {
    const text = `// src/eyes.ts\n${exportEyes({ ...EYES, ...edits.mask })}\n// src/hatFit.ts\n${exportHatFit({
      santa: { ...HAT_FIT.santa, ...edits.santa },
      witch: { ...HAT_FIT.witch, ...edits.witch },
    })}`
    setOut(text)
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }

  const count = Object.keys(edits.mask).length + Object.keys(edits.santa).length + Object.keys(edits.witch).length
  const TABS: Array<[Tab, string]> = [['mask', 'Halloween masks'], ['witch', 'Witch hat'], ['santa', 'Santa hat']]

  return (
    <div style={{ background: '#15171c', color: '#ddd', minHeight: '100vh', padding: 12, font: '13px system-ui, sans-serif' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: '#15171c', paddingBottom: 8 }}>
        {TABS.map(([t, label]) => (
          <button key={t} type="button" onClick={() => { setTab(t); setPicked(null) }}
            style={{ marginRight: 4, fontWeight: tab === t ? 700 : 400 }}>
            {label} ({lists[t].length})
          </button>
        ))}
        {' '}&middot; click one, then arrows move, + / - size (Shift: faster), 0 resets &middot; {count} edited &middot;{' '}
        <button type="button" onClick={doExport}>Export tables</button>{' '}
        <button type="button" onClick={() => { setEdits(NO_EDITS); setOut('') }}>Discard edits</button>
        {picked && <span style={{ marginLeft: 12, color: '#ffd54a' }}>{picked}</span>}
      </div>
      {out && <textarea readOnly value={out} style={{ width: '100%', height: 160, font: '11px monospace' }} onFocus={e => e.currentTarget.select()} />}
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {lists[tab].map(k => {
          const right = k.endsWith('right')
          const piece = tab === 'santa' ? SANTA_HAT : tab === 'witch' ? WITCH_HAT : halloweenPiece(asFile(k))
          if (!piece) return null
          return (
            <Frame key={`${tab}:${k}`} name={k} tab={tab} selected={picked === k} edited={k in edits[tab]} onPick={() => setPicked(k)}>
              {src => tab === 'mask'
                ? <MaskOn piece={piece} eye={eyeOf(k)} right={right} />
                : <HatOn piece={piece} src={src} nudge={nudgeOf(tab, k)} right={right} away={k.includes('-rear-')} />}
            </Frame>
          )
        })}
      </div>
    </div>
  )
}

export default FitHelper
