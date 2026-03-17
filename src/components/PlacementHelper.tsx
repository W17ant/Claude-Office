import React, { useState, useRef, useCallback } from 'react'
import { ASSETS } from '../assets'
import { ROOMS } from '../rooms'

/**
 * PlacementHelper — visual tool for positioning sprites AND mapping zones on a room background.
 *
 * Modes:
 *  - "furniture": place sprites (desks, plants, coffee machine, etc.)
 *  - "door":      mark door/connection hotspots
 *  - "spot":      mark agent spots (where characters can stand/sit)
 *  - "entry":     mark the room entry point
 *
 * Controls:
 *  - Left-click: place item / marker
 *  - Drag: reposition placed items
 *  - Right-click: remove item
 *  - Export: generates rooms.ts-compatible JSON
 */

type PlacementMode = 'furniture' | 'door' | 'spot' | 'entry' | 'floor' | 'waypoint'
type SpotType = 'desk' | 'meeting-seat' | 'lounge' | 'standing' | 'water' | 'coffee'

type SpriteFacingDir = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'
const DIRECTIONS: SpriteFacingDir[] = ['front-left', 'front-right', 'rear-left', 'rear-right']

interface PlacedItem {
  id: string
  mode: PlacementMode
  assetKey?: string   // for furniture
  label?: string      // for doors/waypoints
  spotType?: SpotType // for spots
  spriteFacing?: SpriteFacingDir // for spots
  waypointConnections?: string[] // for waypoints — ids of connected waypoints
  x: number           // percentage (0-100)
  y: number
}

const AVAILABLE_SPRITES = Object.entries(ASSETS).filter(
  ([, a]) => a.category !== 'character' && a.category !== 'room' && a.category !== 'effect'
)

const SPOT_COLORS: Record<SpotType, string> = {
  'desk': '#3498db',
  'meeting-seat': '#9b59b6',
  'lounge': '#e67e22',
  'standing': '#2ecc71',
  'water': '#00bcd4',
  'coffee': '#795548',
}

// Editable waypoint for the route editor
interface EditableWaypoint {
  id: string
  x: number
  y: number
  connections: string[]
}

const PlacementHelper: React.FC = () => {
  const [bgImage, setBgImage] = useState('/rooms/office-day.png')
  const [placed, setPlaced] = useState<PlacedItem[]>([])
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [mode, setMode] = useState<PlacementMode>('furniture')
  const [spotType, setSpotType] = useState<SpotType>('desk')
  const [doorLabel, setDoorLabel] = useState('Main Office')
  const [spotFacing, setSpotFacing] = useState<SpriteFacingDir>('front-right')
  const [spotDirOverrides, setSpotDirOverrides] = useState<Record<string, SpriteFacingDir>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null)
  const [hideCharacters, setHideCharacters] = useState(false)
  const [history, setHistory] = useState<PlacedItem[][]>([[]])

  // Waypoint editor state — loaded from rooms.ts on init
  const [waypoints, setWaypoints] = useState<EditableWaypoint[]>(() => {
    const room = ROOMS['main-office']
    return (room.waypoints ?? []).map(wp => ({ ...wp, connections: [...wp.connections] }))
  })
  const [selectedWp, setSelectedWp] = useState<string | null>(null)
  const [draggingWp, setDraggingWp] = useState<string | null>(null)
  const wpNextId = useRef(1)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const nextId = useRef(1)

  // Get the actual rendered image bounds (accounting for object-fit: contain)
  const getImageRect = useCallback(() => {
    const img = imgRef.current
    const container = containerRef.current
    if (!img || !container) return null

    const containerRect = container.getBoundingClientRect()
    const imgNatW = img.naturalWidth || 4800
    const imgNatH = img.naturalHeight || 3584
    const imgAspect = imgNatW / imgNatH
    const containerAspect = containerRect.width / containerRect.height

    let renderW: number, renderH: number, offsetX: number, offsetY: number

    if (containerAspect > imgAspect) {
      // Container wider than image — letterboxed left/right
      renderH = containerRect.height
      renderW = renderH * imgAspect
      offsetX = (containerRect.width - renderW) / 2
      offsetY = 0
    } else {
      // Container taller than image — letterboxed top/bottom
      renderW = containerRect.width
      renderH = renderW / imgAspect
      offsetX = 0
      offsetY = (containerRect.height - renderH) / 2
    }

    return {
      left: containerRect.left + offsetX,
      top: containerRect.top + offsetY,
      width: renderW,
      height: renderH,
    }
  }, [])

  // Push current state to history whenever placed changes
  const updatePlaced = useCallback((updater: (prev: PlacedItem[]) => PlacedItem[]) => {
    setPlaced(prev => {
      const next = updater(prev)
      setHistory(h => [...h, next])
      return next
    })
  }, [])

  const undo = useCallback(() => {
    setHistory(h => {
      if (h.length <= 1) return h
      const prev = h.slice(0, -1)
      setPlaced(prev[prev.length - 1])
      return prev
    })
  }, [])

  const handleRoomClick = useCallback((e: React.MouseEvent) => {
    if (dragging) return
    if (mode === 'furniture' && !selectedAsset) return

    const rect = containerRef.current!.getBoundingClientRect()
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10

    const item: PlacedItem = {
      id: `${mode}-${nextId.current++}`,
      mode,
      x,
      y,
    }

    if (mode === 'furniture') item.assetKey = selectedAsset!
    if (mode === 'door') item.label = doorLabel
    if (mode === 'spot') { item.spotType = spotType; item.spriteFacing = spotFacing }
    if (mode === 'entry') item.label = 'Entry'

    // Waypoint mode — add to separate waypoint state, not placed items
    if (mode === 'waypoint') {
      const newId = `W-new-${wpNextId.current++}`
      const newWp: EditableWaypoint = {
        id: newId,
        x,
        y,
        connections: selectedWp ? [selectedWp] : [],
      }
      setWaypoints(prev => {
        const updated = [...prev, newWp]
        // If there's a selected waypoint, add reverse connection
        if (selectedWp) {
          return updated.map(w =>
            w.id === selectedWp ? { ...w, connections: [...w.connections, newId] } : w
          )
        }
        return updated
      })
      setSelectedWp(newId) // auto-select the new waypoint for chaining
      return
    }

    updatePlaced(prev => [...prev, item])
  }, [selectedAsset, dragging, mode, spotType, doorLabel])

  const handleDragStart = useCallback((itemId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setDragging(itemId)

    const onMove = (me: MouseEvent) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = Math.round(((me.clientX - rect.left) / rect.width) * 1000) / 10
      const y = Math.round(((me.clientY - rect.top) / rect.height) * 1000) / 10

      setPlaced(prev => prev.map(p =>
        p.id === itemId ? { ...p, x, y } : p
      ))
    }

    const onUp = () => {
      setDragging(null)
      // Snapshot final position into history
      setPlaced(current => {
        setHistory(h => [...h, current])
        return current
      })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  const removeItem = useCallback((itemId: string) => {
    updatePlaced(prev => prev.filter(p => p.id !== itemId))
  }, [updatePlaced])

  // Generate rooms.ts compatible output
  const generateJson = () => {
    const furniture = placed.filter(p => p.mode === 'furniture')
    const doors = placed.filter(p => p.mode === 'door')
    const spots = placed.filter(p => p.mode === 'spot')
    const entry = placed.find(p => p.mode === 'entry')

    const lines: string[] = []

    if (furniture.length) {
      lines.push('    furniture: [')
      furniture.forEach(p => {
        lines.push(`      { id: '${p.id}', type: '${p.assetKey}', sprite: '${p.assetKey}', x: ${p.x}, y: ${p.y}, label: '${p.assetKey}' },`)
      })
      lines.push('    ],')
    }

    if (doors.length) {
      lines.push('    connections: [')
      doors.forEach(p => {
        lines.push(`      { toRoom: 'TODO', position: { x: ${p.x}, y: ${p.y} }, label: '${p.label}' },`)
      })
      lines.push('    ],')
    }

    if (spots.length) {
      lines.push('    agentSpots: [')
      spots.forEach((p, i) => {
        lines.push(`      { id: 'spot-${i + 1}', type: '${p.spotType}', x: ${p.x}, y: ${p.y}, facing: 'down', spriteFacing: '${p.spriteFacing ?? 'front-right'}' },`)
      })
      lines.push('    ],')
    }

    if (entry) {
      lines.push(`    entryPoint: { x: ${entry.x}, y: ${entry.y} },`)
    }

    const floor = placed.filter(p => p.mode === 'floor')
    if (floor.length >= 3) {
      lines.push('    walkableArea: [')
      floor.forEach(p => {
        lines.push(`      { x: ${p.x}, y: ${p.y} },`)
      })
      lines.push('    ],')
    }

    if (waypoints.length > 0) {
      lines.push('    waypoints: [')
      waypoints.forEach(wp => {
        const conns = wp.connections.map(c => `'${c}'`).join(', ')
        const pad = ' '.repeat(Math.max(0, 18 - wp.id.length))
        lines.push(`      { id: '${wp.id}',${pad}x: ${wp.x}, y: ${wp.y}, connections: [${conns}] },`)
      })
      lines.push('    ],')
    }

    return lines.join('\n')
  }

  // Ctrl+Z / Cmd+Z to undo
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [undo])

  const canPlace = mode === 'floor' || mode === 'waypoint' || mode !== 'furniture' || selectedAsset

  // Get floor polygon points in order
  const floorPoints = placed.filter(p => p.mode === 'floor')

  return (
    <div style={{
      display: 'flex',
      width: '100vw',
      height: '100vh',
      background: '#0a0a0f',
      fontFamily: 'JetBrains Mono, monospace',
      color: '#d1d2d3',
    }}>
      {/* Room canvas */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Toolbar */}
        <div style={{
          padding: '6px 12px',
          background: '#151210',
          borderBottom: '1px solid #2a2520',
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          fontSize: 10,
          flexWrap: 'wrap',
        }}>
          <span style={{ color: '#666' }}>BG:</span>
          <select
            value={bgImage}
            onChange={e => setBgImage(e.target.value)}
            style={{ background: '#222', color: '#ddd', border: '1px solid #444', padding: '2px 4px', fontSize: 10 }}
          >
            <option value="/rooms/office-day.png">Office Day</option>
            <option value="/rooms/office-night.png">Office Night</option>
          </select>

          <div style={{ width: 1, height: 16, background: '#333', margin: '0 4px' }} />

          {/* Mode buttons */}
          {(['furniture', 'door', 'spot', 'entry', 'floor', 'waypoint'] as PlacementMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                background: mode === m ? '#2bac76' : '#222',
                color: mode === m ? '#fff' : '#888',
                border: 'none',
                padding: '3px 8px',
                borderRadius: 3,
                cursor: 'pointer',
                fontSize: 10,
                textTransform: 'uppercase',
              }}
            >
              {m === 'furniture' ? 'Furniture' : m === 'door' ? 'Door' : m === 'spot' ? 'Agent Spot' : m === 'entry' ? 'Entry' : m === 'waypoint' ? 'Waypoint' : 'Floor'}
            </button>
          ))}

          {mode === 'spot' && (
            <select
              value={spotType}
              onChange={e => setSpotType(e.target.value as SpotType)}
              style={{ background: '#222', color: '#ddd', border: '1px solid #444', padding: '2px 4px', fontSize: 10 }}
            >
              <option value="desk">Desk</option>
              <option value="meeting-seat">Meeting Seat</option>
              <option value="lounge">Lounge</option>
              <option value="standing">Standing</option>
              <option value="water">Water</option>
              <option value="coffee">Coffee</option>
            </select>
          )}

          {mode === 'door' && (
            <input
              value={doorLabel}
              onChange={e => setDoorLabel(e.target.value)}
              placeholder="Door label"
              style={{ background: '#222', color: '#ddd', border: '1px solid #444', padding: '2px 6px', fontSize: 10, width: 100 }}
            />
          )}

          <div style={{ flex: 1 }} />

          {mode === 'waypoint' && (
            <span style={{ color: '#00ff88', fontSize: 9, background: '#1a2e1a', padding: '2px 6px', borderRadius: 3 }}>
              {waypoints.length} waypoints
              {selectedWp && ` • Selected: ${selectedWp.replace('W-', '')}`}
            </span>
          )}

          <span style={{ color: '#555', fontSize: 9 }}>
            {mode === 'waypoint'
              ? selectedWp
                ? 'Click waypoint to connect • Click empty to place+chain • Shift+drag to move • Right-click to delete • Click selected to deselect'
                : 'Click empty to place • Click waypoint to select • Right-click to delete'
              : canPlace
                ? `Click to place ${mode}${mode === 'furniture' ? `: ${selectedAsset}` : ''}`
                : 'Select a sprite from palette'
            }
          </span>

          <button
            onClick={() => setShowJson(!showJson)}
            style={{ background: '#2bac76', color: '#fff', border: 'none', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}
          >
            {showJson ? 'Hide' : 'Export'}
          </button>
          <button
            onClick={() => setHideCharacters(!hideCharacters)}
            style={{
              background: hideCharacters ? '#e74c3c' : '#222',
              color: '#fff',
              border: 'none',
              padding: '3px 8px',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 10,
            }}
          >
            {hideCharacters ? 'Show People' : 'Hide People'}
          </button>
          <button
            onClick={undo}
            disabled={history.length <= 1}
            style={{ background: history.length > 1 ? '#555' : '#333', color: '#fff', border: 'none', padding: '3px 8px', borderRadius: 3, cursor: history.length > 1 ? 'pointer' : 'default', fontSize: 10, opacity: history.length > 1 ? 1 : 0.4 }}
          >
            Undo
          </button>
          <button
            onClick={() => {
              setPlaced([]); setHistory([[]])
              if (mode === 'waypoint') { setWaypoints([]); setSelectedWp(null) }
            }}
            style={{ background: '#e74c3c', color: '#fff', border: 'none', padding: '3px 8px', borderRadius: 3, cursor: 'pointer', fontSize: 10 }}
          >
            Clear{mode === 'waypoint' ? ' All Waypoints' : ''}
          </button>
        </div>

        {/* Canvas — outer wrapper centres the 4:3 room */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: '#000',
        }}>
          <div
            ref={containerRef}
            onClick={handleRoomClick}
            style={{
              position: 'relative',
              aspectRatio: '4800 / 3584',
              maxWidth: '100%',
              maxHeight: '100%',
              cursor: canPlace ? 'crosshair' : 'default',
            }}
          >
            <img
              ref={imgRef}
              src={bgImage}
              alt="Room background"
              style={{ width: '100%', height: '100%', display: 'block' }}
              draggable={false}
            />

          {/* Existing room data overlay (read-only from rooms.ts) */}
          {(() => {
            const room = ROOMS['main-office']
            return (
              <>
                {/* Furniture from rooms.ts */}
                {room.furniture.map(item => {
                  const asset = ASSETS[item.sprite]
                  if (!asset) return null
                  return (
                    <div
                      key={`existing-${item.id}`}
                      style={{
                        position: 'absolute',
                        left: `${item.x}%`,
                        top: `${item.y}%`,
                        transform: 'translate(-50%, -100%)',
                        zIndex: Math.round(item.y),
                        pointerEvents: 'none',
                        opacity: 0.7,
                      }}
                    >
                      <img
                        src={asset.path}
                        alt={item.id}
                        style={{ height: asset.height, width: 'auto', imageRendering: 'pixelated', filter: 'drop-shadow(0 0 0.5px #000) drop-shadow(0 0 0.5px #000)' }}
                        draggable={false}
                      />
                    </div>
                  )
                })}
                {/* Agent spots from rooms.ts — clickable characters with rotate arrows */}
                {!hideCharacters && (() => {
                  const charNames = ['Me-1', 'dev-1', 'employee-1', 'dev-2', 'employee-2', 'security-audit-1', 'employee-3', 'Frontend-dev-1', 'explore-1', 'dev-1', 'employee-1', 'dev-2', 'employee-2', 'employee-3', 'Frontend-dev-1', 'security-audit-1']
                  const spotColors: Record<string, string> = { desk: '#3498db', standing: '#2ecc71', water: '#00bcd4', coffee: '#795548', 'meeting-seat': '#9b59b6', lounge: '#e67e22', filing: '#ff9800', printer: '#607d8b', door: '#e74c3c' }
                  return room.agentSpots.map((spot, i) => {
                    const color = spotColors[spot.type] ?? '#888'
                    const charBase = charNames[i % charNames.length]
                    const dir = spotDirOverrides[spot.id] ?? spot.spriteFacing ?? 'front-right'
                    return (
                      <div
                        key={`existing-spot-${spot.id}`}
                        style={{
                          position: 'absolute',
                          left: `${spot.x}%`,
                          top: `${spot.y}%`,
                          transform: 'translate(-50%, -100%)',
                          zIndex: 200,
                          pointerEvents: 'auto',
                          cursor: 'pointer',
                        }}
                      >
                        <img
                          src={`/sprites/characters/${charBase}-${dir}.png`}
                          alt={`Spot ${i + 1}`}
                          style={{ height: i === 0 ? 85 : 78, width: 'auto', imageRendering: 'pixelated', display: 'block' }}
                          draggable={false}
                        />
                        {/* Rotate arrows */}
                        <div style={{
                          position: 'absolute',
                          top: '40%',
                          left: -18,
                          fontSize: 14,
                          cursor: 'pointer',
                          color: '#fff',
                          textShadow: '0 0 4px #000',
                          userSelect: 'none',
                        }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setSpotDirOverrides(prev => {
                              const cur = prev[spot.id] ?? spot.spriteFacing ?? 'front-right'
                              const idx = DIRECTIONS.indexOf(cur)
                              const next = DIRECTIONS[(idx - 1 + DIRECTIONS.length) % DIRECTIONS.length]
                              return { ...prev, [spot.id]: next }
                            })
                          }}
                        >◀</div>
                        <div style={{
                          position: 'absolute',
                          top: '40%',
                          right: -18,
                          fontSize: 14,
                          cursor: 'pointer',
                          color: '#fff',
                          textShadow: '0 0 4px #000',
                          userSelect: 'none',
                        }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setSpotDirOverrides(prev => {
                              const cur = prev[spot.id] ?? spot.spriteFacing ?? 'front-right'
                              const idx = DIRECTIONS.indexOf(cur)
                              const next = DIRECTIONS[(idx + 1) % DIRECTIONS.length]
                              return { ...prev, [spot.id]: next }
                            })
                          }}
                        >▶</div>
                        {/* Badge */}
                        <div style={{
                          position: 'absolute',
                          top: -16,
                          left: '50%',
                          transform: 'translateX(-50%)',
                          background: color,
                          color: '#fff',
                          fontSize: 9,
                          fontWeight: 'bold',
                          fontFamily: 'JetBrains Mono, monospace',
                          padding: '1px 5px',
                          borderRadius: 8,
                          whiteSpace: 'nowrap',
                          zIndex: 200,
                        }}>
                          {i + 1} · {dir}
                        </div>
                      </div>
                    )
                  })
                })()}
                {/* Door from rooms.ts */}
                {room.connections.map(conn => (
                  <div
                    key={`existing-door-${conn.toRoom}`}
                    style={{
                      position: 'absolute',
                      left: `${conn.position.x}%`,
                      top: `${conn.position.y}%`,
                      transform: 'translate(-50%, -50%)',
                      zIndex: 90,
                      pointerEvents: 'none',
                    }}
                  >
                    <div style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      background: '#e74c3c',
                      opacity: 0.5,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 7,
                      fontWeight: 'bold',
                      color: '#fff',
                    }}>
                      D
                    </div>
                  </div>
                ))}
              </>
            )
          })()}

          {/* Floor polygon overlay */}
          {floorPoints.length > 0 && (
            <svg
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
            >
              {/* Filled polygon */}
              {floorPoints.length >= 3 && (
                <polygon
                  points={floorPoints.map(p => `${p.x},${p.y}`).join(' ')}
                  fill="rgba(46, 204, 113, 0.15)"
                  stroke="#2ecc71"
                  strokeWidth="0.3"
                  strokeDasharray="0.8,0.4"
                />
              )}
              {/* Lines connecting points */}
              {floorPoints.map((p, i) => {
                const next = floorPoints[(i + 1) % floorPoints.length]
                if (i >= floorPoints.length - 1 && floorPoints.length < 3) return null
                return (
                  <line
                    key={`line-${i}`}
                    x1={p.x} y1={p.y}
                    x2={next.x} y2={next.y}
                    stroke="#2ecc71"
                    strokeWidth="0.3"
                    strokeDasharray="0.8,0.4"
                  />
                )
              })}
            </svg>
          )}

          {/* Waypoint editor overlay */}
          {mode === 'waypoint' && (
            <>
              {/* Connection lines */}
              <svg
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 6 }}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
              >
                {waypoints.map(wp =>
                  wp.connections.map(connId => {
                    const target = waypoints.find(w => w.id === connId)
                    if (!target || wp.id > connId) return null
                    const isSelected = selectedWp === wp.id || selectedWp === connId
                    return (
                      <line
                        key={`wl-${wp.id}-${connId}`}
                        x1={wp.x} y1={wp.y} x2={target.x} y2={target.y}
                        stroke={isSelected ? '#00ff88' : '#ff9800'}
                        strokeWidth={isSelected ? '0.5' : '0.3'}
                        opacity={isSelected ? 1 : 0.6}
                      />
                    )
                  })
                )}
                {/* Line from selected waypoint to cursor would be nice but we'll keep it simple */}
              </svg>

              {/* Clickable waypoint nodes */}
              {waypoints.map(wp => {
                const isSelected = selectedWp === wp.id
                const isConnectedToSelected = selectedWp ? waypoints.find(w => w.id === selectedWp)?.connections.includes(wp.id) : false
                return (
                  <div
                    key={`wp-${wp.id}`}
                    onMouseDown={e => {
                      e.stopPropagation()
                      if (e.shiftKey) {
                        // Shift+click = start dragging
                        setDraggingWp(wp.id)
                        const onMove = (me: MouseEvent) => {
                          if (!containerRef.current) return
                          const rect = containerRef.current.getBoundingClientRect()
                          const x = Math.round(((me.clientX - rect.left) / rect.width) * 1000) / 10
                          const y = Math.round(((me.clientY - rect.top) / rect.height) * 1000) / 10
                          setWaypoints(prev => prev.map(w => w.id === wp.id ? { ...w, x, y } : w))
                        }
                        const onUp = () => {
                          setDraggingWp(null)
                          window.removeEventListener('mousemove', onMove)
                          window.removeEventListener('mouseup', onUp)
                        }
                        window.addEventListener('mousemove', onMove)
                        window.addEventListener('mouseup', onUp)
                        return
                      }

                      // Click = select or connect
                      if (selectedWp === null) {
                        setSelectedWp(wp.id)
                      } else if (selectedWp === wp.id) {
                        setSelectedWp(null) // deselect
                      } else {
                        // Toggle connection between selectedWp and this wp
                        setWaypoints(prev => {
                          const from = prev.find(w => w.id === selectedWp)
                          const to = prev.find(w => w.id === wp.id)
                          if (!from || !to) return prev

                          const alreadyConnected = from.connections.includes(wp.id)

                          return prev.map(w => {
                            if (w.id === selectedWp) {
                              return {
                                ...w,
                                connections: alreadyConnected
                                  ? w.connections.filter(c => c !== wp.id)
                                  : [...w.connections, wp.id],
                              }
                            }
                            if (w.id === wp.id) {
                              return {
                                ...w,
                                connections: alreadyConnected
                                  ? w.connections.filter(c => c !== selectedWp!)
                                  : [...w.connections, selectedWp!],
                              }
                            }
                            return w
                          })
                        })
                        setSelectedWp(wp.id) // move selection to clicked node
                      }
                    }}
                    onContextMenu={e => {
                      e.preventDefault()
                      // Right-click = delete waypoint and all connections to it
                      setWaypoints(prev =>
                        prev
                          .filter(w => w.id !== wp.id)
                          .map(w => ({ ...w, connections: w.connections.filter(c => c !== wp.id) }))
                      )
                      if (selectedWp === wp.id) setSelectedWp(null)
                    }}
                    style={{
                      position: 'absolute',
                      left: `${wp.x}%`,
                      top: `${wp.y}%`,
                      transform: 'translate(-50%, -50%)',
                      zIndex: 200,
                      cursor: 'pointer',
                    }}
                    title={`${wp.id} (${wp.x}, ${wp.y}) — ${wp.connections.length} connections\nClick: select/connect • Shift+drag: move • Right-click: delete`}
                  >
                    <div style={{
                      width: isSelected ? 28 : 22,
                      height: isSelected ? 28 : 22,
                      borderRadius: '50%',
                      background: isSelected ? '#00ff88' : isConnectedToSelected ? '#66ffaa' : '#ff9800',
                      border: `2px solid ${isSelected ? '#fff' : 'transparent'}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 9,
                      fontWeight: 'bold',
                      color: isSelected ? '#000' : '#fff',
                      boxShadow: isSelected ? '0 0 12px #00ff88' : `0 0 6px ${isConnectedToSelected ? '#66ffaa' : '#ff9800'}`,
                      transition: 'all 0.15s',
                    }}>
                      W
                    </div>
                    <div style={{
                      position: 'absolute',
                      top: -16,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      fontSize: 8,
                      color: isSelected ? '#00ff88' : '#ff9800',
                      whiteSpace: 'nowrap',
                      textShadow: '0 1px 3px #000',
                      fontWeight: 'bold',
                    }}>
                      {wp.id.replace('W-', '')}
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {/* Placed items */}
          {placed.map(item => {
            // Furniture items
            if (item.mode === 'furniture' && item.assetKey) {
              const asset = ASSETS[item.assetKey]
              if (!asset) return null

              return (
                <div
                  key={item.id}
                  onMouseDown={e => handleDragStart(item.id, e)}
                  onContextMenu={e => { e.preventDefault(); removeItem(item.id) }}
                  style={{
                    position: 'absolute',
                    left: `${item.x}%`,
                    top: `${item.y}%`,
                    transform: 'translate(-50%, -100%)',
                    cursor: 'grab',
                    zIndex: Math.round(item.y) + 10,
                    outline: dragging === item.id ? '2px solid #2bac76' : 'none',
                  }}
                  title={`${item.assetKey} (${item.x}, ${item.y}) — right-click to remove`}
                >
                  <img
                    src={asset.path}
                    alt={item.assetKey}
                    style={{
                      width: asset.width ?? 64,
                      height: asset.height ?? 64,
                      imageRendering: 'pixelated',
                      pointerEvents: 'none',
                    }}
                    draggable={false}
                  />
                  <div style={{
                    position: 'absolute',
                    bottom: -14,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    fontSize: 8,
                    color: '#2bac76',
                    whiteSpace: 'nowrap',
                    textShadow: '0 1px 2px #000',
                  }}>
                    {item.x}, {item.y}
                  </div>
                </div>
              )
            }

            // Marker items (doors, spots, entry)
            const colors: Record<PlacementMode, string> = {
              furniture: '#2bac76',
              door: '#e74c3c',
              spot: SPOT_COLORS[item.spotType ?? 'desk'],
              entry: '#f39c12',
              floor: '#2ecc71',
              waypoint: connectingFrom === item.id ? '#ff4444' : '#00ff88',
            }
            const icons: Record<PlacementMode, string> = {
              furniture: '',
              door: 'D',
              spot: item.spotType?.[0]?.toUpperCase() ?? 'S',
              entry: 'E',
              floor: 'F',
              waypoint: 'W',
            }
            const color = colors[item.mode]
            const icon = icons[item.mode]

            return (
              <div
                key={item.id}
                onMouseDown={e => {
                  // Waypoint connection mode: click to connect
                  if (item.mode === 'waypoint' && mode === 'waypoint') {
                    e.stopPropagation()
                    if (connectingFrom === null) {
                      setConnectingFrom(item.id)
                      return
                    } else if (connectingFrom !== item.id) {
                      // Connect the two waypoints
                      updatePlaced(prev => prev.map(p => {
                        if (p.id === connectingFrom && !(p.waypointConnections ?? []).includes(item.id)) {
                          return { ...p, waypointConnections: [...(p.waypointConnections ?? []), item.id] }
                        }
                        if (p.id === item.id && !(p.waypointConnections ?? []).includes(connectingFrom!)) {
                          return { ...p, waypointConnections: [...(p.waypointConnections ?? []), connectingFrom!] }
                        }
                        return p
                      }))
                      setConnectingFrom(null)
                      return
                    } else {
                      setConnectingFrom(null)
                      return
                    }
                  }
                  handleDragStart(item.id, e)
                }}
                onContextMenu={e => { e.preventDefault(); setConnectingFrom(null); removeItem(item.id) }}
                style={{
                  position: 'absolute',
                  left: `${item.x}%`,
                  top: `${item.y}%`,
                  transform: 'translate(-50%, -50%)',
                  cursor: item.mode === 'waypoint' && mode === 'waypoint' ? 'pointer' : 'grab',
                  zIndex: 100,
                }}
                title={item.mode === 'waypoint'
                  ? `${item.label} (${item.x}, ${item.y}) — click to connect, right-click to remove`
                  : `${item.mode} (${item.x}, ${item.y})${item.label ? ` — ${item.label}` : ''} — right-click to remove`
                }
              >
                <div style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: color,
                  border: `2px solid ${color}`,
                  opacity: 0.85,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 'bold',
                  color: '#fff',
                  boxShadow: `0 0 8px ${color}`,
                }}>
                  {icon}
                </div>
                <div style={{
                  position: 'absolute',
                  top: 24,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontSize: 7,
                  color,
                  whiteSpace: 'nowrap',
                  textShadow: '0 1px 2px #000',
                }}>
                  {item.label ?? item.spotType ?? ''} ({item.x}, {item.y})
                </div>
              </div>
            )
          })}
          </div>
        </div>

        {/* JSON output */}
        {showJson && (
          <div style={{
            maxHeight: 200,
            overflow: 'auto',
            background: '#111',
            borderTop: '1px solid #2a2520',
            padding: 8,
          }}>
            <pre
              style={{ fontSize: 10, color: '#3fb950', margin: 0, cursor: 'pointer' }}
              onClick={() => navigator.clipboard.writeText(generateJson())}
              title="Click to copy"
            >
              {generateJson() || '// Nothing placed yet'}
            </pre>
          </div>
        )}
      </div>

      {/* Right panel: palette + legend */}
      <div style={{
        width: 200,
        background: '#111214',
        borderLeft: '1px solid #2c2d31',
        overflowY: 'auto',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        {/* Legend */}
        <div style={{ fontSize: 9, color: '#666', borderBottom: '1px solid #222', paddingBottom: 6 }}>
          <div style={{ textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Legend</div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#e74c3c' }} />
            <span>Door hotspot</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#3498db' }} />
            <span>Agent spot (desk)</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#2ecc71' }} />
            <span>Agent spot (standing)</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00bcd4' }} />
            <span>Water spot</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#795548' }} />
            <span>Coffee spot</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#f39c12' }} />
            <span>Entry point</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#00ff88' }} />
            <span>Waypoint (walk route)</span>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 2 }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff9800' }} />
            <span>Existing waypoint</span>
          </div>
        </div>

        {/* Sprite palette (only shown in furniture mode) */}
        <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 1 }}>
          Sprites {mode !== 'furniture' && <span style={{ color: '#444' }}>(switch to furniture mode)</span>}
        </div>

        {AVAILABLE_SPRITES.map(([key, asset]) => (
          <div
            key={key}
            onClick={() => { setSelectedAsset(selectedAsset === key ? null : key); setMode('furniture') }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 6px',
              borderRadius: 4,
              cursor: 'pointer',
              background: selectedAsset === key && mode === 'furniture' ? 'rgba(43, 172, 118, 0.15)' : 'transparent',
              border: selectedAsset === key && mode === 'furniture' ? '1px solid rgba(43, 172, 118, 0.3)' : '1px solid transparent',
              opacity: mode === 'furniture' ? 1 : 0.5,
            }}
          >
            <img
              src={asset.path}
              alt={key}
              style={{
                width: 32,
                height: 32,
                objectFit: 'contain',
                imageRendering: 'pixelated',
              }}
              draggable={false}
            />
            <span style={{ fontSize: 8, color: selectedAsset === key ? '#2bac76' : '#8b8d91' }}>
              {key}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default PlacementHelper
