#!/usr/bin/env node
/**
 * check-assets.mjs — keeps public/ honest.
 *
 *   node scripts/check-assets.mjs [repoRoot]      (npm run check-assets)
 *
 * Walks public/ and collects every asset the app can ask for from src/**,
 * index.html, server/**, electron/**, hooks/** and commands/**. Then prints:
 *
 *   1. referenced files that do not exist          -> exit 1
 *   2. files nothing references                    -> listed, exit 0
 *   3. the size of public/ against BUDGET_BYTES    -> exit 1 when over
 *
 * Zero dependencies; Node 20. The script does not run the app, so beside
 * literal paths it models the ways the code builds a path at runtime. Each
 * pattern below names the source it is read from; when that anchor
 * disappears the check fails rather than silently counting fewer files.
 *
 * Literal references
 *   Any root-absolute token with an asset extension in a scanned file:
 *   '/sprites/effects/typing.png', url('/office-bg.png'), "/rooms/x.png".
 *   Quotes are not required, so a path in a comment counts too (erring on
 *   the side of keeping a file). Relative paths (docs/images/x.png) and URLs
 *   with a host are not public/ references and are ignored.
 *
 * Dynamic patterns (every expansion is required unless noted)
 *   P1  Default-skin characters: theme.ts getSpritePath builds
 *       /sprites/characters/{base}-{front|rear}-{left|right}.png. The bases
 *       are the values of ROLE_TO_CHAR and the boss-sprite fallback in
 *       src/config.ts, the getCharBase fallback in Character.tsx, the
 *       charNames list in PlacementHelper.tsx, and boss.sprite in
 *       office.config.example.json (and office.config.json when present).
 *   P2  Dunder Mifflin cast: /sprites/office/characters/{slug}-{dir}.png for
 *       every slug in OFFICE_CHARACTERS (src/theme.ts).
 *   P3  Angela's cats: /sprites/office/cats/{cat}.png for every entry of
 *       OFFICE_CATS (src/theme.ts).
 *   P4  Incident art slots: the `intended` path of each slot in
 *       src/incidentAssets.ts is probed at runtime and may not exist yet;
 *       it is optional (reported, never fatal). Its `fallback` is a plain
 *       literal and required.
 *
 * A template literal that builds a /sprites or /rooms path and is not one
 * of KNOWN_DYNAMIC fails the check: model it here before relying on it.
 *
 * PLANNED lists paths the code names for art that is not drawn yet (the
 * unbuilt rooms in src/rooms.ts). They are reported, not fatal; delete an
 * entry once its file lands. KEPT lists files no code references but the
 * README tells people to use; they are not reported as unreferenced.
 *
 * CHECK_ASSETS_BUDGET=<bytes> overrides BUDGET_BYTES (used by the tests).
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep, extname } from 'node:path'

// Why: public/ was 90 MB before the asset diet (two 19 MB room PNGs drawn at
// 754 px wide, and 28 walk frames nothing loads). The budget is the trimmed
// 47.7 MB plus 10 %, so a stray full-resolution export cannot land unnoticed.
// Raise it here, on purpose, when art is added.
export const BUDGET_BYTES = 52_500_000

const SOURCE_ROOTS = ['src', 'index.html', 'server', 'electron', 'hooks', 'commands']
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.html', '.css', '.md', '.sh', '.json', '.py'])
const ASSET_EXT = 'png|jpe?g|gif|webp|svg|ico|mp3|wav|ogg|woff2?|ttf'
const DIRECTIONS = ['front-left', 'front-right', 'rear-left', 'rear-right']

/** Templates the patterns above cover, with `${...}` replaced by `*`. */
const KNOWN_DYNAMIC = new Set([
  '*/*-*.png',                          // theme.ts getSpritePath (P1, P2)
  '/sprites/characters/*-*.png',        // PlacementHelper.tsx (P1)
  '/sprites/office/cats/*.png',         // theme.ts getAngelaCat, OFFICE_CATS_PATHS (P3)
])

/** Art the code names but nobody has drawn: the unbuilt rooms in src/rooms.ts. */
const PLANNED = new Set([
  'rooms/ceo-office.png',
  'rooms/meeting-room.png',
  'rooms/kitchen-cafeteria.png',
  'rooms/server-room.png',
  'rooms/lobby-reception.png',
  'rooms/nap-wellness-room.png',
  'rooms/rooftop-terrace.png',
  'rooms/gym-fitness-room.png',
  'rooms/parking-garage.png',
])

/** Unreferenced on purpose: templates the README has people upload to draw a character. */
const KEPT = new Map([
  ['sprites/characters/Helper.png', 'sprite-sheet template (README, "Creating a custom sprite")'],
  ['sprites/characters/TEMPLATE.png', 'sprite-sheet template (scripts/setup-character.md)'],
])

// ---------------------------------------------------------------------------

const root = resolve(process.argv[2] ?? process.cwd())
const publicDir = join(root, 'public')
const budget = Number(process.env.CHECK_ASSETS_BUDGET) || BUDGET_BYTES
const problems = []

function toPosix(p) { return p.split(sep).join('/') }

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function sourceFiles() {
  const files = []
  for (const name of SOURCE_ROOTS) {
    const full = join(root, name)
    if (!existsSync(full)) continue
    if (statSync(full).isDirectory()) {
      for (const f of walk(full)) if (SOURCE_EXT.has(extname(f))) files.push(f)
    } else {
      files.push(full)
    }
  }
  return files
}

function readIfExists(rel) {
  const full = join(root, rel)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

/** Quoted strings inside `anchor = [ ... ]`; null when the anchor is absent. */
function quotedIn(text, anchorRe) {
  const m = anchorRe.exec(text)
  if (!m) return null
  return [...m[1].matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)].map(q => q[1] ?? q[2])
}

function anchorOrFail(file, name, values) {
  if (values === null) problems.push(`${file}: could not find ${name}; update the pattern in scripts/check-assets.mjs`)
  return values ?? []
}

// ---------------------------------------------------------------------------
// 1. References
// ---------------------------------------------------------------------------

/** rel path under public/ -> how it is referenced ("literal", "P1", ...) */
const required = new Map()
const optional = new Map()
function ref(map, path, how) {
  const rel = path.replace(/^\//, '')
  if (!map.has(rel)) map.set(rel, how)
}

const PATH_RE = new RegExp(`(?<![\\w.$-])(/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_.-]+)*\\.(?:${ASSET_EXT}))(?![\\w.-])`, 'g')
const TEMPLATE_RE = /`((?:\\.|[^`\\])*)`/g

for (const file of sourceFiles()) {
  const text = readFileSync(file, 'utf8')
  const shown = toPosix(relative(root, file))
  for (const m of text.matchAll(PATH_RE)) ref(required, m[1], `literal in ${shown}`)
  // Backticks mean something else in shell and Markdown; only JS/TS builds paths this way
  if (!/\.(ts|tsx|js|cjs|mjs)$/.test(file)) continue
  for (const m of text.matchAll(TEMPLATE_RE)) {
    if (!m[1].includes('${')) continue
    const shape = m[1].replace(/\$\{[^}]*\}/g, '*')
    const buildsAsset = /\/(sprites|rooms)\//.test(shape) || new RegExp(`\\.(?:${ASSET_EXT})$`).test(shape)
    if (buildsAsset && !KNOWN_DYNAMIC.has(shape)) {
      problems.push(`${shown}: dynamic asset path \`${shape}\` is not modelled; add the pattern to scripts/check-assets.mjs`)
    }
  }
}

// P1 — default-skin character bases
const bases = new Set()
const config = readIfExists('src/config.ts')
if (config !== null) {
  const block = /ROLE_TO_CHAR[^{]*\{([\s\S]*?)\n\}/.exec(config)
  if (!block) problems.push('src/config.ts: could not find ROLE_TO_CHAR; update P1 in scripts/check-assets.mjs')
  // 'role': 'base' adds a base; 'role': bossSprite is covered by the fallback and the config files
  for (const m of (block?.[1] ?? '').matchAll(/'[^']+':\s*'([^']+)'/g)) bases.add(m[1])
  const fallback = /boss\?\.sprite\s*\?\?\s*'([^']+)'/.exec(config)
  if (fallback) bases.add(fallback[1])
  else problems.push('src/config.ts: could not find the boss sprite fallback; update P1 in scripts/check-assets.mjs')
}
const character = readIfExists('src/components/Character.tsx')
if (character !== null) {
  const m = /ROLE_TO_CHAR\[role\]\s*\?\?\s*'([^']+)'/.exec(character)
  if (m) bases.add(m[1])
}
const helper = readIfExists('src/components/PlacementHelper.tsx')
if (helper !== null) for (const v of quotedIn(helper, /const charNames = \[([^\]]*)\]/) ?? []) bases.add(v)
for (const cfg of ['office.config.example.json', 'office.config.json']) {
  const text = readIfExists(cfg)
  if (text === null) continue
  try {
    const sprite = JSON.parse(text)?.boss?.sprite
    if (typeof sprite === 'string' && sprite) bases.add(sprite)
  } catch { problems.push(`${cfg}: not valid JSON`) }
}
for (const base of bases) for (const dir of DIRECTIONS) ref(required, `/sprites/characters/${base}-${dir}.png`, `P1 character "${base}"`)

// P2, P3 — the Dunder Mifflin cast and Angela's cats
const theme = readIfExists('src/theme.ts')
if (theme !== null) {
  for (const slug of anchorOrFail('src/theme.ts', 'OFFICE_CHARACTERS', quotedIn(theme, /const OFFICE_CHARACTERS = \[([^\]]*)\]/)))
    for (const dir of DIRECTIONS) ref(required, `/sprites/office/characters/${slug}-${dir}.png`, `P2 cast "${slug}"`)
  for (const cat of anchorOrFail('src/theme.ts', 'OFFICE_CATS', quotedIn(theme, /const OFFICE_CATS = \[([^\]]*)\]/)))
    ref(required, `/sprites/office/cats/${cat}.png`, `P3 cat "${cat}"`)
}

// P4 — incident slots: `intended` is optional, `fallback` was picked up as a literal
const incident = readIfExists('src/incidentAssets.ts')
if (incident !== null) {
  const intended = [...incident.matchAll(/intended:\s*'([^']+)'/g)].map(m => m[1])
  if (intended.length === 0) problems.push('src/incidentAssets.ts: no `intended:` slots found; update P4 in scripts/check-assets.mjs')
  for (const p of intended) {
    const rel = p.replace(/^\//, '')
    // The fallback literal may equal the intended path; then it is required.
    if (required.get(rel)?.startsWith('literal') && incident.includes(`fallback: '${p}'`)) continue
    required.delete(rel)
    ref(optional, p, 'P4 incident slot')
  }
}

// ---------------------------------------------------------------------------
// 2. Walk public/
// ---------------------------------------------------------------------------

if (!existsSync(publicDir)) {
  console.error(`check-assets: no public/ directory under ${root}`)
  process.exit(1)
}

const files = walk(publicDir).map(f => ({ rel: toPosix(relative(publicDir, f)), bytes: statSync(f).size }))
const present = new Set(files.map(f => f.rel))
const totalBytes = files.reduce((n, f) => n + f.bytes, 0)

const missing = [...required].filter(([rel]) => !present.has(rel) && !PLANNED.has(rel))
const planned = [...PLANNED].filter(rel => !present.has(rel) && required.has(rel))
const plannedLanded = [...PLANNED].filter(rel => present.has(rel))
const optionalMissing = [...optional].filter(([rel]) => !present.has(rel))
const unreferenced = files.filter(f =>
  !required.has(f.rel) && !optional.has(f.rel) && !KEPT.has(f.rel) && !/(^|\/)README\.md$/.test(f.rel))
const referencedCount = files.filter(f => required.has(f.rel) || optional.has(f.rel)).length

const mb = n => `${(n / 1e6).toFixed(1)} MB`
const pct = Math.round((totalBytes / budget) * 100)

console.log(`check-assets: public/ holds ${files.length} files, ${mb(totalBytes)} (budget ${mb(budget)}, ${pct} % used)`)
console.log(`  referenced: ${referencedCount}   unreferenced: ${unreferenced.length}   kept: ${[...KEPT.keys()].filter(k => present.has(k)).length}`)

if (missing.length) {
  console.log(`\nMissing — referenced but not in public/ (${missing.length}):`)
  for (const [rel, how] of missing) console.log(`  ${rel}   <- ${how}`)
}
if (planned.length) {
  console.log(`\nPlanned art, not drawn yet (allowed; see PLANNED in scripts/check-assets.mjs):`)
  for (const rel of planned) console.log(`  ${rel}`)
}
for (const rel of plannedLanded) console.log(`\nnote: ${rel} exists now; drop it from PLANNED in scripts/check-assets.mjs`)
if (optionalMissing.length) {
  console.log(`\nIncident art slots without art yet (optional; probed at runtime):`)
  for (const [rel] of optionalMissing) console.log(`  ${rel}`)
}
if (unreferenced.length) {
  console.log(`\nUnreferenced — nothing in the code asks for these (${unreferenced.length}, ${mb(unreferenced.reduce((n, f) => n + f.bytes, 0))}):`)
  for (const f of unreferenced) console.log(`  ${f.rel}   (${mb(f.bytes)})`)
}

if (missing.length) problems.push(`${missing.length} referenced asset(s) missing from public/`)
if (totalBytes > budget) {
  problems.push(`public/ is ${mb(totalBytes)}, over the ${mb(budget)} budget by ${mb(totalBytes - budget)}. ` +
    'Sprites are drawn about 80 px tall and the room at 754 px wide (1508 px for 2x displays); ' +
    'export at twice the drawn size, or raise BUDGET_BYTES in scripts/check-assets.mjs on purpose.')
} else {
  console.log(`\npublic/ is within budget (${mb(budget - totalBytes)} to spare)`)
}

if (problems.length) {
  console.log('')
  for (const p of problems) console.error(`check-assets: ${p}`)
  process.exit(1)
}
