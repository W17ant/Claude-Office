import React from 'react'
import { FurnitureItem } from '../rooms'
import { ASSETS } from '../assets'

interface FurnitureRendererProps {
  items: FurnitureItem[]
  onItemClick?: (itemId: string) => void
}

function resolveSpriteUrl(sprite: string): string | null {
  // Direct asset key lookup
  if (ASSETS[sprite]) return ASSETS[sprite].path

  // Legacy sprite-sheet format "sheet-name:frame" — no image available
  if (sprite.includes(':')) return null

  // Try as direct path
  return sprite
}

function getSpriteHeight(sprite: string): number {
  const asset = ASSETS[sprite]
  return asset?.height ?? 64
}

// Items that the boss can interact with
const CLICKABLE_TYPES = new Set([
  'coffee-machine', 'filing-cabinet', 'printer',
  'plant-monstera', 'plant-snake', 'plant-money',
  'hotspot',
])

const FurnitureRenderer: React.FC<FurnitureRendererProps> = ({ items, onItemClick }) => {
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
            <img
              src={url}
              alt={item.label || item.type}
              style={{
                height: h,
                width: 'auto',
                imageRendering: 'pixelated',
                display: 'block',
                filter: 'drop-shadow(0 0 0.5px #000) drop-shadow(0 0 0.5px #000)',
              }}
              draggable={false}
            />
          </div>
        )
      })}
    </>
  )
}

export default FurnitureRenderer
