/**
 * electron/helpers.cjs — the desktop app's pure helpers, run without Electron:
 * window bounds clamped to a display's work area, zoom-to-fit for the fixed
 * office layout, the window-state file, the tray's status text and menu.
 * Plus scripts/generate-icons.mjs: the committed icons are a fresh render.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderIcons, TRAY_GLYPH, APP_GLYPH } from '../scripts/generate-icons.mjs'

const require = createRequire(import.meta.url)
const h = require('../electron/helpers.cjs')

const ROOT = join(__dirname, '..')

// A 1920×1080 display with a 40px taskbar at the bottom
const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 }
// A second display to the right, with a 24px menu bar
const SECOND = { x: 1920, y: 24, width: 1440, height: 876 }

describe('the layout constants mirror src/styles/office.css', () => {
  const css = readFileSync(join(ROOT, 'src/styles/office.css'), 'utf8')

  function block(selector: string) {
    const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))
    if (!match) throw new Error(`${selector} not found in office.css`)
    return match[1]
  }

  it('.app-wrapper is LAYOUT (border-box) with a 1px border', () => {
    const wrapper = block('.app-wrapper')
    expect(wrapper).toMatch(new RegExp(`width:\\s*${h.LAYOUT.width}px`))
    expect(wrapper).toMatch(new RegExp(`height:\\s*${h.LAYOUT.height}px`))
    expect(wrapper).toMatch(/border:\s*1px/)
    expect(wrapper).toMatch(/left:\s*50%/)
    expect(wrapper).toMatch(/transform:\s*translate\(-50%, -50%\)/)
  })

  it('.slack-panel is 300px plus a 1px left border, so the room column is 754 wide', () => {
    const panel = block('.slack-panel')
    expect(panel).toMatch(/width:\s*300px/)
    expect(panel).toMatch(/border-left:\s*1px/)
    expect(h.ROOM_VIEWPORT).toEqual({ width: 754, height: 682 })
  })
})

describe('fitZoom', () => {
  it('is 1 when the content area is exactly the layout', () => {
    expect(h.fitZoom({ width: 1056, height: 682 }, h.LAYOUT)).toBe(1)
  })

  it('scales down to the tighter side, letterboxing the other', () => {
    expect(h.fitZoom({ width: 528, height: 682 }, h.LAYOUT)).toBe(0.5)   // width-bound
    expect(h.fitZoom({ width: 1056, height: 341 }, h.LAYOUT)).toBe(0.5)  // height-bound
    expect(h.fitZoom({ width: 2112, height: 2000 }, h.LAYOUT)).toBe(2)
  })

  it('stays within ZOOM_RANGE and survives nonsense', () => {
    expect(h.fitZoom({ width: 10, height: 10 }, h.LAYOUT)).toBe(h.ZOOM_RANGE.min)
    expect(h.fitZoom({ width: 100000, height: 100000 }, h.LAYOUT)).toBe(h.ZOOM_RANGE.max)
    expect(h.fitZoom({ width: NaN, height: 10 }, h.LAYOUT)).toBe(1)
  })

  it('the compact default size fits the room column at 0.6', () => {
    const size = h.defaultSizeFor(true)
    expect(size).toEqual({ width: 452, height: 409 })
    expect(h.fitZoom(size, h.ROOM_VIEWPORT)).toBeCloseTo(0.6, 2)
    expect(h.defaultSizeFor(false)).toEqual({ width: 1056, height: 682 })
    expect(h.viewportFor(true)).toBe(h.ROOM_VIEWPORT)
    expect(h.viewportFor(false)).toBe(h.LAYOUT)
    expect(h.minSizeFor(true)).toBe(h.MIN_SIZE.compact)
    expect(h.minSizeFor(false)).toBe(h.MIN_SIZE.full)
  })
})

describe('compactCss centres the room column, not the whole layout', () => {
  it('offsets the wrapper by half the room column and drops its transform', () => {
    const css = h.compactCss()
    expect(css).toContain('.app-wrapper{')
    expect(css).toContain('left:calc(50% - 377px)!important')
    expect(css).toContain('top:calc(50% - 341px)!important')
    expect(css).toContain('transform:none!important')
  })
})

describe('clampBounds', () => {
  const min = { width: 300, height: 200 }

  it('leaves bounds that fit alone (rounded to whole pixels)', () => {
    expect(h.clampBounds({ x: 100.4, y: 50, width: 1056, height: 682 }, WORK_AREA, min))
      .toEqual({ x: 100, y: 50, width: 1056, height: 682 })
  })

  it('moves a window back on screen when it hangs off the right or bottom edge', () => {
    expect(h.clampBounds({ x: 1500, y: 900, width: 1056, height: 682 }, WORK_AREA, min))
      .toEqual({ x: 864, y: 358, width: 1056, height: 682 })
  })

  it('moves a window back when it is off the top-left, respecting the work-area origin', () => {
    expect(h.clampBounds({ x: -500, y: -300, width: 800, height: 600 }, SECOND, min))
      .toEqual({ x: 1920, y: 24, width: 800, height: 600 })
  })

  it('shrinks a window larger than the work area and pins it to the origin', () => {
    expect(h.clampBounds({ x: 10, y: 10, width: 3000, height: 2000 }, WORK_AREA, min))
      .toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('raises a window below the minimum size', () => {
    expect(h.clampBounds({ x: 10, y: 10, width: 50, height: 50 }, WORK_AREA, min))
      .toEqual({ x: 10, y: 10, width: 300, height: 200 })
  })

  it('centres a window with no position, and falls back to the minimum size without one', () => {
    expect(h.clampBounds({ width: 1056, height: 682 }, WORK_AREA, min))
      .toEqual({ x: 432, y: 179, width: 1056, height: 682 })
    expect(h.clampBounds({}, WORK_AREA, min)).toEqual({ x: 810, y: 420, width: 300, height: 200 })
    expect(h.clampBounds(null, WORK_AREA, min)).toEqual({ x: 810, y: 420, width: 300, height: 200 })
    expect(h.clampBounds({ x: 'nope', y: NaN, width: Infinity, height: -5 }, WORK_AREA, min))
      .toEqual({ x: 810, y: 420, width: 300, height: 200 })
  })

  it('a display smaller than the minimum keeps the minimum (Electron enforces it anyway)', () => {
    expect(h.clampBounds({ x: 0, y: 0, width: 500, height: 400 }, { x: 0, y: 0, width: 200, height: 100 }, min))
      .toEqual({ x: 0, y: 0, width: 300, height: 200 })
  })
})

describe('placeInWorkArea', () => {
  it('centres by default', () => {
    expect(h.placeInWorkArea({ width: 1056, height: 682 }, WORK_AREA)).toEqual({ x: 432, y: 179, width: 1056, height: 682 })
  })

  it('puts the widget in the top-right corner with a margin, on the right display too', () => {
    expect(h.placeInWorkArea({ width: 452, height: 409 }, WORK_AREA, 'top-right')).toEqual({ x: 1448, y: 20, width: 452, height: 409 })
    expect(h.placeInWorkArea({ width: 452, height: 409 }, SECOND, 'top-right')).toEqual({ x: 2888, y: 44, width: 452, height: 409 })
  })

  it('never places off screen, even when the size does not fit', () => {
    expect(h.placeInWorkArea({ width: 3000, height: 409 }, WORK_AREA, 'top-right')).toEqual({ x: 0, y: 20, width: 1920, height: 409 })
  })
})

describe('window-state.json', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-office-window-state-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('round-trips bounds, compact bounds and the flags, creating the directory', () => {
    const file = join(dir, 'nested', 'window-state.json')
    const state = {
      bounds: { x: 100, y: 50, width: 1056, height: 682 },
      compactBounds: { x: 1448, y: 20, width: 452, height: 409 },
      compact: true,
      alwaysOnTop: false,
    }
    expect(h.writeWindowState(file, state)).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(h.readWindowState(file)).toEqual(state)
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })

  it('a missing file is an empty state', () => {
    expect(h.readWindowState(join(dir, 'none.json'))).toEqual({})
  })

  it('a malformed or foreign file is an empty state, and junk fields are dropped', () => {
    const file = join(dir, 'window-state.json')
    writeFileSync(file, '{ not json')
    expect(h.readWindowState(file)).toEqual({})
    writeFileSync(file, '[1, 2, 3]')
    expect(h.readWindowState(file)).toEqual({})
    writeFileSync(file, JSON.stringify({
      bounds: { x: 1, y: 2, width: 0, height: 10 },            // zero width: not a rect
      compactBounds: { x: 1, y: 2, width: 300.6, height: 200 }, // rounded
      compact: 'yes',                                            // not a boolean
      alwaysOnTop: true,
      zoom: 0.5,                                                 // unknown
    }))
    expect(h.readWindowState(file)).toEqual({
      compactBounds: { x: 1, y: 2, width: 301, height: 200 },
      alwaysOnTop: true,
    })
  })

  it('an unwritable location is reported, not thrown', () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    expect(h.writeWindowState(join(blocker, 'window-state.json'), { compact: true })).toBe(false)
  })
})

describe('tray status', () => {
  const agents = {
    agents: [
      { id: 'a', state: 'working' },
      { id: 'b', state: 'idle' },
      { id: 'c', state: 'completed' },   // not in the office any more
      { id: 'd', state: 'working' },
    ],
  }
  const sessions = {
    sessions: [
      { id: 's1', state: 'active', main: { state: 'working' } },
      { id: 's2', state: 'active', main: { state: 'needs-you' } },
      { id: 's3', state: 'ended', main: { state: 'idle' } },     // gone
      { id: 's4', state: 'active', main: { state: 'idle' } },
    ],
  }

  it('counts working subagents and sessions, and sessions that need you', () => {
    expect(h.officeSummary({ agents, sessions })).toEqual({ agents: 3, sessions: 3, working: 3, needsYou: 1 })
  })

  it('works with either payload missing (the other request failed)', () => {
    expect(h.officeSummary({ agents, sessions: null })).toEqual({ agents: 3, sessions: 0, working: 2, needsYou: 0 })
    expect(h.officeSummary({ agents: null, sessions })).toEqual({ agents: 0, sessions: 3, working: 1, needsYou: 1 })
    expect(h.officeSummary({ agents: { agents: 'junk' }, sessions: {} })).toEqual({ agents: 0, sessions: 0, working: 0, needsYou: 0 })
  })

  it('is null when the server did not answer at all', () => {
    expect(h.officeSummary({ agents: null, sessions: null })).toBeNull()
    expect(h.officeSummary()).toBeNull()
  })

  it('statusText: one readable line per situation', () => {
    expect(h.statusText(null)).toBe('server not reachable')
    expect(h.statusText({ agents: 0, sessions: 0, working: 0, needsYou: 0 })).toBe('the office is empty')
    expect(h.statusText({ agents: 1, sessions: 0, working: 0, needsYou: 0 })).toBe('1 agent in, none working')
    expect(h.statusText({ agents: 2, sessions: 1, working: 0, needsYou: 0 })).toBe('3 agents in, none working')
    expect(h.statusText({ agents: 3, sessions: 3, working: 3, needsYou: 1 })).toBe('3 working, 1 needs you')
    expect(h.statusText({ agents: 0, sessions: 2, working: 0, needsYou: 2 })).toBe('2 agents in, none working, 2 need you')
  })

  it('trayTitle (macOS menu bar): the working count, and N! when sessions need you', () => {
    expect(h.trayTitle(null)).toBe('')
    expect(h.trayTitle({ agents: 0, sessions: 0, working: 0, needsYou: 0 })).toBe('')
    expect(h.trayTitle({ agents: 2, sessions: 1, working: 2, needsYou: 0 })).toBe('2')
    expect(h.trayTitle({ agents: 2, sessions: 1, working: 2, needsYou: 1 })).toBe('2 1!')
    expect(h.trayTitle({ agents: 0, sessions: 1, working: 0, needsYou: 1 })).toBe('1!')
  })

  it('windowTitle carries the status after the app name', () => {
    expect(h.windowTitle(null)).toBe('Agent Office')
    expect(h.windowTitle({ agents: 1, sessions: 1, working: 1, needsYou: 0 })).toBe('Agent Office — 1 working')
  })
})

describe('trayMenuTemplate', () => {
  const actions = {
    toggleWindow: vi.fn(),
    setCompact: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    openInBrowser: vi.fn(),
    quit: vi.fn(),
  }
  const labels = (template: any[]) => template.filter(i => i.type !== 'separator').map(i => i.label)
  const item = (template: any[], label: string) => template.find(i => i.label === label)

  beforeEach(() => { for (const fn of Object.values(actions)) fn.mockClear() })

  it('full window, visible: Hide, unchecked compact, always-on-top enabled', () => {
    const t = h.trayMenuTemplate({ visible: true, compact: false, alwaysOnTop: false, status: '2 working' }, actions)
    expect(labels(t)).toEqual(['Agent Office — 2 working', 'Hide office', 'Compact widget', 'Always on top', 'Open in browser', 'Quit Agent Office'])
    expect(t[0].enabled).toBe(false)
    expect(item(t, 'Compact widget')).toMatchObject({ type: 'checkbox', checked: false })
    expect(item(t, 'Always on top')).toMatchObject({ type: 'checkbox', checked: false, enabled: true })
  })

  it('hidden window shows "Show office"; no status yet shows just the name', () => {
    const t = h.trayMenuTemplate({ visible: false, compact: false, alwaysOnTop: true, status: '' }, actions)
    expect(t[0].label).toBe('Agent Office')
    expect(labels(t)).toContain('Show office')
    expect(item(t, 'Always on top').checked).toBe(true)
  })

  it('compact widget: checked, and always-on-top is checked but disabled', () => {
    const t = h.trayMenuTemplate({ visible: true, compact: true, alwaysOnTop: false, status: 'the office is empty' }, actions)
    expect(item(t, 'Compact widget').checked).toBe(true)
    expect(item(t, 'Always on top')).toMatchObject({ checked: true, enabled: false })
  })

  it('clicks call the actions with the toggled value', () => {
    const t = h.trayMenuTemplate({ visible: true, compact: false, alwaysOnTop: false, status: '' }, actions)
    item(t, 'Hide office').click()
    item(t, 'Compact widget').click()
    item(t, 'Always on top').click()
    item(t, 'Open in browser').click()
    item(t, 'Quit Agent Office').click()
    expect(actions.toggleWindow).toHaveBeenCalledTimes(1)
    expect(actions.setCompact).toHaveBeenCalledWith(true)
    expect(actions.setAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(actions.openInBrowser).toHaveBeenCalledTimes(1)
    expect(actions.quit).toHaveBeenCalledTimes(1)

    const compactOn = h.trayMenuTemplate({ visible: true, compact: true, alwaysOnTop: true, status: '' }, actions)
    item(compactOn, 'Compact widget').click()
    item(compactOn, 'Always on top').click()
    expect(actions.setCompact).toHaveBeenLastCalledWith(false)
    expect(actions.setAlwaysOnTop).toHaveBeenLastCalledWith(false)
  })
})

// ---------------------------------------------------------------------------
// scripts/generate-icons.mjs
// ---------------------------------------------------------------------------

/** Minimal PNG reader for what the generator writes: RGBA, filter 0, one IDAT. */
function decodePng(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([data[8], data[9]]).toEqual([8, 6]) // 8-bit RGBA
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels: number[][] = []
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0) // filter: none
    for (let x = 0; x < width; x++) {
      const i = y * (stride + 1) + 1 + x * 4
      pixels.push([raw[i], raw[i + 1], raw[i + 2], raw[i + 3]])
    }
  }
  return { width, height, pixels }
}

describe('scripts/generate-icons.mjs', () => {
  const icons = renderIcons() as Record<string, Buffer>

  it('the committed icons are exactly a fresh render (re-run the script after editing the art)', () => {
    for (const [rel, png] of Object.entries(icons)) {
      const file = join(ROOT, rel)
      expect(existsSync(file), `${rel} is missing — run node scripts/generate-icons.mjs`).toBe(true)
      expect(readFileSync(file).equals(png), `${rel} is stale — run node scripts/generate-icons.mjs`).toBe(true)
    }
  })

  it('renders the documented sizes', () => {
    const sizes = Object.fromEntries(Object.entries(icons).map(([rel, png]) => {
      const { width, height } = decodePng(png)
      return [rel, `${width}x${height}`]
    }))
    expect(sizes).toEqual({
      'electron/assets/trayTemplate.png': '16x16',
      'electron/assets/trayTemplate@2x.png': '32x32',
      'electron/assets/tray-16.png': '16x16',
      'electron/assets/tray-32.png': '32x32',
      'electron/assets/tray-48.png': '48x48',
      'electron/assets/icon.png': '256x256',
      'build/icon.png': '512x512',
    })
  })

  it('the macOS template icons are black with alpha only, as the menu bar requires', () => {
    for (const rel of ['electron/assets/trayTemplate.png', 'electron/assets/trayTemplate@2x.png']) {
      const { pixels } = decodePng(icons[rel])
      expect(pixels.every(([r, g, b]) => r === 0 && g === 0 && b === 0)).toBe(true)
      expect(pixels.some(([, , , a]) => a === 255)).toBe(true)
      expect(pixels.some(([, , , a]) => a === 0)).toBe(true)
    }
  })

  it('the coloured tray icon follows the glyph, scaled by whole pixels', () => {
    const { width, pixels } = decodePng(icons['electron/assets/tray-32.png'])
    for (let y = 0; y < TRAY_GLYPH.length; y++) {
      for (let x = 0; x < TRAY_GLYPH[y].length; x++) {
        const transparent = TRAY_GLYPH[y][x] === '.'
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const alpha = pixels[(y * 2 + dy) * width + (x * 2 + dx)][3]
          expect(alpha === 0, `pixel ${x},${y}`).toBe(transparent)
        }
      }
    }
  })

  it('the app icon is a rounded tile: transparent corners, opaque centre', () => {
    const { width, pixels } = decodePng(icons['build/icon.png'])
    expect(APP_GLYPH).toHaveLength(32)
    expect(pixels[0][3]).toBe(0)                                     // top-left corner
    expect(pixels[width - 1][3]).toBe(0)                             // top-right corner
    expect(pixels[(width - 1) * width][3]).toBe(0)                   // bottom-left
    expect(pixels[width * width - 1][3]).toBe(0)                     // bottom-right
    expect(pixels[(width / 2) * width + width / 2][3]).toBe(255)     // centre
    expect(pixels[8][3]).toBe(0)                                     // still inside the corner curve
    expect(pixels[width * 8 + width / 2][3]).toBe(255)               // top edge, middle: on the tile
  })
})
