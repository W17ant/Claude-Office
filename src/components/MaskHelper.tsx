/**
 * MaskHelper - /?maskhelper: place and size each character's Halloween mask by hand, then export src/eyes.ts.
 *
 * Every sprite listed in src/eyes.ts that wears a mask (src/hat.ts
 * halloweenPiece) is shown large, wearing it exactly as the office draws it
 * (maskOnEyes). Click one, then:
 *
 *   arrow keys    move the mask (Shift: ten times further)
 *   + / -         make it bigger / smaller (Shift: faster)
 *   0             back to the table's value for this sprite
 *
 * Edits are kept in this browser (localStorage) until exported. **Export**
 * writes the whole table as the text of src/eyes.ts's EYES, with each edited
 * sprite's eye point and mask `width`, ready to paste.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { EYES, type EyeLine } from '../eyes'
import { halloweenPiece, maskOnEyes } from '../hat'

const STORE = 'agent-office.mask-tuning'
// Why 0.004: about one source pixel on these ~400 px wide sprites at the
// helper's size, fine enough to line a hole up with a pupil
const STEP = 0.004
// Why 4%: a visible but controllable change in size per press
const GROW = 1.04
const CARD_H = 320

type Edits = Record<string, EyeLine>

function loadEdits(): Edits {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as Edits
  } catch {
    return {}
  }
}

/** The table as TypeScript, edited entries included, sorted like the file */
export function exportEyes(table: Record<string, EyeLine>): string {
  const n = (v: number) => v.toFixed(3)
  const lines = Object.keys(table).sort().map(k => {
    const e = table[k]
    return `  '${k}': { x: ${n(e.x)}, y: ${n(e.y)}, spacing: ${n(e.spacing)}${e.width !== undefined ? `, width: ${n(e.width)}` : ''} },`
  })
  return `export const EYES: Readonly<Record<string, EyeLine>> = {\n${lines.join('\n')}\n}\n`
}

/** A sprite card: the head, large, with its mask on */
const Card: React.FC<{ name: string; eye: EyeLine; selected: boolean; edited: boolean; onPick: () => void }> = ({ name, eye, selected, edited, onPick }) => {
  const base = name.replace(/-front-(left|right)$/, '')
  const piece = halloweenPiece(`/x/${base}-front-left.png`)
  const [dir, setDir] = useState('/sprites/characters')
  const right = name.endsWith('right')
  const on = piece ? maskOnEyes(piece, eye, right) : null
  if (!piece || !on) return null
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
      {/* Why twice the card's height: the head is the top half of the sprite */}
      <div style={{ position: 'relative', height: CARD_H * 2.2 }}>
        <img
          src={`${dir}/${name}.png`}
          alt={name}
          onError={() => setDir('/sprites/office/characters')}
          style={{ height: '100%', width: 'auto', display: 'block', imageRendering: 'pixelated' }}
          draggable={false}
        />
        <img
          src={piece.src}
          alt=""
          style={{
            position: 'absolute', left: `${on.left * 100}%`, top: `${on.top * 100}%`, width: `${on.width * 100}%`, height: 'auto',
            transform: `translate(${on.shiftX * 100}%, ${on.shiftY * 100}%)${right ? ' scaleX(-1)' : ''}`,
            imageRendering: 'pixelated', pointerEvents: 'none',
          }}
          draggable={false}
        />
      </div>
      <span style={{ position: 'absolute', left: 4, bottom: 4, font: '11px monospace', color: '#fff', background: '#0008', padding: '1px 4px' }}>{name}</span>
    </button>
  )
}

const MaskHelper: React.FC = () => {
  const [edits, setEdits] = useState<Edits>(loadEdits)
  const [picked, setPicked] = useState<string | null>(null)
  const [out, setOut] = useState('')

  // Only the sprites that wear a mask (not the witch hat)
  const names = useMemo(() => Object.keys(EYES).filter(k => {
    const base = k.replace(/-front-(left|right)$/, '')
    return halloweenPiece(`/x/${base}-front-left.png`)?.kind === 'mask'
  }).sort(), [])

  const eyeOf = useCallback((k: string): EyeLine => edits[k] ?? EYES[k], [edits])

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(edits)) } catch { /* private window: edits last this page only */ }
  }, [edits])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!picked) return
      const cur = eyeOf(picked)
      const piece = halloweenPiece(`/x/${picked.replace(/-front-(left|right)$/, '')}-front-left.png`)
      const width = cur.width ?? (piece ? maskOnEyes(piece, cur, false)?.width : undefined) ?? 0.5
      const step = e.shiftKey ? STEP * 10 : STEP
      let next: EyeLine | null = null
      if (e.key === 'ArrowLeft') next = { ...cur, x: cur.x - step }
      else if (e.key === 'ArrowRight') next = { ...cur, x: cur.x + step }
      else if (e.key === 'ArrowUp') next = { ...cur, y: cur.y - step }
      else if (e.key === 'ArrowDown') next = { ...cur, y: cur.y + step }
      else if (e.key === '+' || e.key === '=') next = { ...cur, width: width * (e.shiftKey ? GROW ** 3 : GROW) }
      else if (e.key === '-' || e.key === '_') next = { ...cur, width: width / (e.shiftKey ? GROW ** 3 : GROW) }
      else if (e.key === '0') {
        setEdits(prev => { const { [picked]: _drop, ...rest } = prev; void _drop; return rest })
        e.preventDefault()
        return
      }
      if (next) {
        e.preventDefault()
        setEdits(prev => ({ ...prev, [picked]: next! }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [picked, eyeOf])

  const doExport = () => {
    const text = exportEyes({ ...EYES, ...edits })
    setOut(text)
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }

  return (
    <div style={{ background: '#15171c', color: '#ddd', minHeight: '100vh', padding: 12, font: '13px system-ui, sans-serif' }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: '#15171c', paddingBottom: 8 }}>
        <strong>Halloween masks</strong> &middot; click a face, then arrows move, + / - size (Shift: faster), 0 resets &middot;{' '}
        {Object.keys(edits).length} edited &middot;{' '}
        <button type="button" onClick={doExport}>Export src/eyes.ts table</button>{' '}
        <button type="button" onClick={() => { setEdits({}); setOut('') }}>Discard edits</button>
        {picked && <span style={{ marginLeft: 12, color: '#ffd54a' }}>{picked}</span>}
      </div>
      {out && <textarea readOnly value={out} style={{ width: '100%', height: 160, font: '11px monospace' }} onFocus={e => e.currentTarget.select()} />}
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {names.map(k => (
          <Card key={k} name={k} eye={eyeOf(k)} selected={picked === k} edited={k in edits} onPick={() => setPicked(k)} />
        ))}
      </div>
    </div>
  )
}

export default MaskHelper
