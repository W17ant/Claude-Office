import React from 'react'
import ResilientImg from './ResilientImg'
import { FurnitureItem } from '../rooms'
import { ASSETS } from '../assets'
import { seasonalUrl, useSeasonArt } from '../season'
import DeskScreens from './DeskScreens'
import { DESK_GEOMETRY, type DeskScreen } from '../screens'

interface FurnitureRendererProps {
  items: FurnitureItem[]
  onItemClick?: (itemId: string) => void
  /** A page the printer is printing (roomLife.ts printJob): a green one or a red one, keyed by when */
  printJob?: { ok: boolean; at: number } | null
  /** What each desk's two monitors show, by furniture id (screens.ts deskScreens) */
  screens?: Record<string, DeskScreen>
}

function resolveSpriteUrl(sprite: string): string | null {
  // Legacy sprite-sheet format "sheet-name:frame" — no image available
  if (!ASSETS[sprite] && sprite.includes(':')) return null
  // Why seasonalUrl: a desk or plant shows its seasonal copy (tinsel and a
  // Christmas tree in December, a pumpkin at Halloween; src/season.ts) once
  // that file exists, else the normal sprite
  return seasonalUrl(ASSETS[sprite] ? ASSETS[sprite].path : sprite)
}

function getSpriteHeight(sprite: string): number {
  const asset = ASSETS[sprite]
  return asset?.height ?? 64
}

// Why: still pictures instead of motion when the viewer asks for less
const MOVE = !(typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)

/** Wisps of steam curling up from a coffee machine that is on (over the sprite's own painted steam). */
function CoffeeSteam() {
  if (!MOVE) return null
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" style={{ position: 'absolute', left: '5%', bottom: '78%', width: '55%', height: '70%', pointerEvents: 'none', overflow: 'visible' }}>
      {[[30, '2.6s', '0s'], [55, '3.1s', '0.9s'], [75, '2.8s', '1.7s']].map(([x, dur, begin]) => (
        <path key={x as number} d={`M ${x} 100 q -10 -20 0 -40 q 10 -20 0 -40`} fill="none" stroke="#f1f5f9" strokeWidth={5} strokeLinecap="round" opacity={0}>
          <animate attributeName="opacity" values="0;0.7;0" dur={dur as string} begin={begin as string} repeatCount="indefinite" />
          <animateTransform attributeName="transform" type="translate" values="0 10;0 -20" dur={dur as string} begin={begin as string} repeatCount="indefinite" />
        </path>
      ))}
    </svg>
  )
}

/**
 * A page sliding out into the printer's tray when a build, test run or deploy
 * finishes, its top stripe green or red. Mounted afresh per job (keyed), so
 * its animation starts as it appears.
 */
function PrintedPage({ ok }: { ok: boolean }) {
  // Why these points: the tray's paper on printer-working.png, as % of the sprite
  const sheet = '15,72 37,63 48,75 25,83'
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}>
      <g opacity={MOVE ? 0 : 1}>
        {MOVE && <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.8;1" dur="5s" fill="freeze" />}
        {MOVE && <animateTransform attributeName="transform" type="translate" values="9 -9;0 0;0 0" keyTimes="0;0.35;1" dur="5s" fill="freeze" />}
        <polygon points={sheet} fill="#f8fafc" stroke="#94a3b8" strokeWidth={0.6} />
        <polygon points="17.5,72 37,64 39,66.5 19.5,74.5" fill={ok ? '#22c55e' : '#ef4444'} />
        {[0, 1, 2].map(i => <line key={i} x1={22 + i * 2} y1={76 + i * 2.2} x2={38 + i * 2} y2={69.5 + i * 2.2} stroke="#94a3b8" strokeWidth={0.8} />)}
      </g>
    </svg>
  )
}

// Items that the boss can interact with
const CLICKABLE_TYPES = new Set([
  'coffee-machine', 'filing-cabinet', 'printer',
  'plant-monstera', 'plant-snake', 'plant-money',
  'hotspot',
])

const FurnitureRenderer: React.FC<FurnitureRendererProps> = ({ items, onItemClick, screens, printJob }) => {
  useSeasonArt() // Why: memoised; re-render when a seasonal desk or plant file turns out to exist
  return (
    <>
      {items.map(item => {
        const clickable = CLICKABLE_TYPES.has(item.type) || item.interactive

        // Hotspots — invisible clickable zones over background art
        if (item.type === 'hotspot') {
          return (
            <div
              key={item.id}
              className="furniture-item interactive clickable-furniture hotspot"
              style={{
                position: 'absolute',
                left: `${item.x}%`,
                top: `${item.y}%`,
                transform: 'translate(-50%, -50%)',
                width: '6%',
                height: '8%',
                zIndex: 10,
                pointerEvents: 'auto',
                cursor: 'pointer',
              }}
              title={item.label}
              onClick={onItemClick ? () => onItemClick(item.id) : undefined}
            />
          )
        }

        const url = resolveSpriteUrl(item.sprite)
        if (!url) return null // skip items with no available sprite

        const h = getSpriteHeight(item.sprite)
        // A standing desk's monitors are drawn over it in code (DeskScreens)
        const desk = DESK_GEOMETRY[item.sprite]
        const deskScreen: DeskScreen | undefined = desk ? screens?.[item.id] ?? ['off', 'off'] : undefined

        return (
          <div
            key={item.id}
            className={`furniture-item${clickable ? ' interactive clickable-furniture' : ''}`}
            style={{
              position: 'absolute',
              left: `${item.x}%`,
              top: `${item.y}%`,
              transform: 'translate(-50%, -100%)',
              zIndex: item.zIndex ?? Math.round(item.y),
              pointerEvents: clickable ? 'auto' : 'none',
              cursor: clickable ? 'pointer' : 'default',
            }}
            title={item.label || (clickable ? 'Click to interact' : undefined)}
            onClick={clickable && onItemClick ? () => onItemClick(item.id) : undefined}
          >
            {desk && deskScreen && <DeskScreens geometry={desk} screens={deskScreen} layer="back" />}
            <ResilientImg
              src={url}
              alt={item.label || item.type}
              style={{
                height: h,
                width: 'auto',
                imageRendering: 'pixelated',
                display: 'block',
                filter: 'drop-shadow(0 0 0.5px #000) drop-shadow(0 0 0.5px #000)',
                // Why positioned: so a rear desk's glow (z 0) sits behind it and the screens (z 2) on it
                position: desk ? 'relative' : undefined,
                zIndex: desk ? 1 : undefined,
              }}
              draggable={false}
            />
            {desk && deskScreen && <DeskScreens geometry={desk} screens={deskScreen} layer="front" />}
            {item.sprite === 'coffee-on' && <CoffeeSteam />}
            {item.type === 'printer' && item.sprite !== 'printer-broken' && printJob && <PrintedPage key={printJob.at} ok={printJob.ok} />}
          </div>
        )
      })}
    </>
  )
}

// Why: items only change when a furniture state flips, not on every walking frame
export default React.memo(FurnitureRenderer)
