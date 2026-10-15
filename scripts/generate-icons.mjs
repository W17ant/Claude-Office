#!/usr/bin/env node
/**
 * Generate the desktop app's icons as PNGs, with no dependencies:
 *
 *   electron/assets/trayTemplate.png      16×16  macOS menu-bar icon (template:
 *   electron/assets/trayTemplate@2x.png   32×32  black + alpha only, "Template"
 *                                                suffix, so macOS tints it)
 *   electron/assets/tray-16.png           16×16  Windows / Linux tray icon
 *   electron/assets/tray-32.png           32×32  (2×)
 *   electron/assets/tray-48.png           48×48  (3×)
 *   electron/assets/icon.png            256×256  window icon (Linux)
 *   build/icon.png                      512×512  app icon electron-builder turns
 *                                                into .icns / .ico / the Linux set
 *
 * The art is two hand-drawn pixel maps — a desk with a monitor for the tray,
 * and a small office (monitor, desk, plant, mug) on a rounded tile for the app
 * icon — scaled by whole numbers so every pixel stays crisp. The output is
 * deterministic (tests/electron-helpers.test.ts checks the committed files
 * match a fresh render), so re-run this after editing the maps:
 *
 *   node scripts/generate-icons.mjs            # writes into the repository
 *   node scripts/generate-icons.mjs --out DIR  # writes DIR/electron/assets, DIR/build
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

// ---------------------------------------------------------------------------
// Pixel maps: one character per pixel, '.' is transparent
// ---------------------------------------------------------------------------

/** 16×16: a monitor showing a few lines of code, on a desk. */
export const TRAY_GLYPH = [
  '................',
  '.##############.',
  '.#oooooooooooo#.',
  '.#oyyyyyoooooo#.',
  '.#ooooyyyyyooo#.',
  '.#oyyyooooyyoo#.',
  '.#oooooooooooo#.',
  '.##############.',
  '.......ss.......',
  '.......ss.......',
  '.....ssssss.....',
  'wwwwwwwwwwwwwwww',
  'wwwwwwwwwwwwwwww',
  '.ww..........ww.',
  '.ww..........ww.',
  '................',
]

/** Tray colours (Windows / Linux). */
const TRAY_COLOURS = {
  '#': [43, 47, 58, 255],     // monitor bezel
  'o': [47, 123, 255, 255],   // screen
  'y': [255, 211, 78, 255],   // code lines
  's': [58, 63, 75, 255],     // stand
  'w': [162, 106, 58, 255],   // desk
}

/**
 * macOS template image: black only, shape carried by alpha (the menu bar
 * tints it for light/dark mode). The screen is a lighter fill so the monitor
 * reads as a monitor and not a block.
 */
const TRAY_TEMPLATE = {
  '#': [0, 0, 0, 255],
  'o': [0, 0, 0, 110],
  'y': [0, 0, 0, 220],
  's': [0, 0, 0, 255],
  'w': [0, 0, 0, 255],
}

/** 32×32: the office — monitor, desk, plant and mug on a wall-and-floor tile. */
export const APP_GLYPH = [
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'BBBBBBBBBeeeeeeeeeeeeeeBBBBBBBBB',
  'BBBBBBBBB##############BBBBBBBBB',
  'BBBBBBBBB#oooooooooooo#BBBBBBBBB',
  'BBBBBBBBB#oyyyyyoooooo#BBBBBBBBB',
  'BBBBBBBBB#oooggggggooo#BBBBBBBBB',
  'BBBBBBBBB#oyyyooooyyyo#BBBBBpBBB',
  'BBBBBBBBB#oooooggggooo#BBBpPpPBB',
  'BBBBBBBBB#oyyyyyyooooo#BBpPpPpPB',
  'BBBBBBBBB#oooggggooooo#BBpPpPpPB',
  'BBBBBBBBB#oooooooooooo#BBBPpPpBB',
  'BBBmmmmBB##############BBBttttBB',
  'BBBmmmmmBBBBBBBssBBBBBBBBBttttBB',
  'BBBmmmmBBBBBBsssssssBBBBBBttttBB',
  'BBDDDDDDDDDDDDDDDDDDDDDDDDDDDDBB',
  'BBDDDDDDDDDDDDDDDDDDDDDDDDDDDDBB',
  'BBddddddddddddddddddddddddddddBB',
  'BBddddddddddddddddddddddddddddBB',
  'FFddFFFFFFFFFFFFFFFFFFFFFFFFddFF',
  'FFddFFFFFFFFFFFFFFFFFFFFFFFFddFF',
  'ffddffffffffffffffffffffffffddff',
  'FFddFFFFFFFFFFFFFFFFFFFFFFFFddFF',
  'FFddFFFFFFFFFFFFFFFFFFFFFFFFddFF',
  'ffffffffffffffffffffffffffffffff',
  'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
  'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
  'ffffffffffffffffffffffffffffffff',
  'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
]

const APP_COLOURS = {
  'B': [31, 35, 53, 255],     // wall
  'F': [74, 53, 36, 255],     // floor
  'f': [61, 43, 29, 255],     // floor boards
  'D': [162, 106, 58, 255],   // desk top
  'd': [122, 77, 39, 255],    // desk front and legs
  '#': [26, 28, 36, 255],     // monitor bezel
  'e': [58, 63, 77, 255],     // bezel highlight
  'o': [37, 99, 235, 255],    // screen
  'y': [255, 211, 78, 255],   // code lines
  'g': [74, 222, 128, 255],   // code lines
  's': [58, 63, 77, 255],     // stand
  'p': [63, 163, 77, 255],    // plant
  'P': [43, 122, 58, 255],    // plant, shaded
  't': [180, 85, 58, 255],    // pot
  'm': [224, 68, 58, 255],    // mug
}

/** Corner radius of the app tile, in map pixels (7/32 ≈ macOS's 22 %). */
const APP_TILE_RADIUS = 7

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Rasterise a map at `scale` pixels per map pixel into RGBA.
 * @param {string[]} map
 * @param {Record<string, number[]>} palette
 * @param {number} scale
 * @param {(x: number, y: number) => boolean} [mask] map-pixel predicate; false = transparent
 */
export function render(map, palette, scale, mask) {
  const h = map.length
  const w = map[0].length
  for (const row of map) {
    if (row.length !== w) throw new Error(`map row "${row}" is ${row.length} wide, expected ${w}`)
  }
  const out = Buffer.alloc(w * scale * h * scale * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = map[y][x]
      if (ch === '.' || (mask && !mask(x, y))) continue
      const rgba = palette[ch]
      if (!rgba) throw new Error(`no colour for "${ch}" at ${x},${y}`)
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((y * scale + dy) * w * scale + (x * scale + dx)) * 4
          out[i] = rgba[0]; out[i + 1] = rgba[1]; out[i + 2] = rgba[2]; out[i + 3] = rgba[3]
        }
      }
    }
  }
  return { width: w * scale, height: h * scale, rgba: out }
}

/** Rounded-square mask for a `size`-wide map with corner radius `r`. */
export function roundedMask(size, r) {
  return (x, y) => {
    const inCornerX = x < r || x >= size - r
    const inCornerY = y < r || y >= size - r
    if (!inCornerX || !inCornerY) return true
    const cx = x < r ? r - 0.5 : size - r - 0.5
    const cy = y < r ? r - 0.5 : size - r - 0.5
    const dx = x - cx
    const dy = y - cy
    return dx * dx + dy * dy <= r * r
  }
}

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, 8-bit, no interlace)
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** Encode RGBA pixels as a PNG file. */
export function encodePng({ width, height, rgba }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// The icon set
// ---------------------------------------------------------------------------

/** Every icon as { "electron/assets/tray-16.png": <png buffer>, ... }. */
export function renderIcons() {
  const tile = roundedMask(APP_GLYPH.length, APP_TILE_RADIUS)
  return {
    'electron/assets/trayTemplate.png': encodePng(render(TRAY_GLYPH, TRAY_TEMPLATE, 1)),
    'electron/assets/trayTemplate@2x.png': encodePng(render(TRAY_GLYPH, TRAY_TEMPLATE, 2)),
    'electron/assets/tray-16.png': encodePng(render(TRAY_GLYPH, TRAY_COLOURS, 1)),
    'electron/assets/tray-32.png': encodePng(render(TRAY_GLYPH, TRAY_COLOURS, 2)),
    'electron/assets/tray-48.png': encodePng(render(TRAY_GLYPH, TRAY_COLOURS, 3)),
    'electron/assets/icon.png': encodePng(render(APP_GLYPH, APP_COLOURS, 8, tile)),
    'build/icon.png': encodePng(render(APP_GLYPH, APP_COLOURS, 16, tile)),
  }
}

/** Write the icon set under `root`; returns the paths written. */
export function writeIcons(root) {
  const written = []
  for (const [rel, png] of Object.entries(renderIcons())) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, png)
    written.push(file)
  }
  return written
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const outFlag = args.indexOf('--out')
  const root = outFlag >= 0 ? resolve(args[outFlag + 1] ?? '.') : resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (const file of writeIcons(root)) console.log(`wrote ${file}`)
}
