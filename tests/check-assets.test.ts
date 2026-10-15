/**
 * scripts/check-assets.mjs — every asset the code can ask for exists in
 * public/, orphans are listed, and public/ stays under its size budget.
 *
 * The fixture tests build a tiny repo in a temp dir (a public/ tree and the
 * few src/ files the script reads its patterns from) and run the real script
 * against it; the last test runs it against this checkout.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/check-assets.mjs', import.meta.url))
const REPO = fileURLToPath(new URL('..', import.meta.url))

// A 1x1 PNG; the script only looks at names and sizes
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const DIRS = ['front-left', 'front-right', 'rear-left', 'rear-right']

const tempDirs: string[] = []
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }) })

/** Write `files` (path -> content) under a fresh temp repo and return its root. */
function fixture(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'check-assets-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

function run(root: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, root], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, out: r.stdout + r.stderr }
}

function characterFiles(base: string, dirs = DIRS): Record<string, Buffer> {
  return Object.fromEntries(dirs.map(d => [`public/sprites/characters/${base}-${d}.png`, PNG]))
}

// The files the script reads its dynamic patterns from, in the shape of the real ones
const CONFIG_TS = `
const bossSprite = userConfig.boss?.sprite ?? 'Me-1'
export const ROLE_TO_CHAR: Record<string, string> = {
  'boss':      bossSprite,
  'debugger':  'dev-1',
  'Explore':   'explore-1',
}
`
const CONSISTENT = {
  'src/App.tsx': `const typing = '/sprites/effects/typing.png'\nconst room = \`url(\${getRoomImage('day')})\`\n`,
  'src/styles/office.css': `.x { background-image: url('/rooms/office-day.png'); }\n`,
  'src/config.ts': CONFIG_TS,
  'office.config.example.json': JSON.stringify({ boss: { sprite: 'Me-1' } }),
  'public/sprites/effects/typing.png': PNG,
  'public/rooms/office-day.png': PNG,
  'public/sprites/old.png': PNG,
  'public/sprites/characters/Helper.png': PNG,
  ...characterFiles('Me-1'),
  ...characterFiles('dev-1'),
  ...characterFiles('explore-1'),
}

describe('check-assets', () => {
  it('fails on a referenced file that is missing, including one frame of a character', () => {
    const files: Record<string, string | Buffer> = {
      ...CONSISTENT,
      'src/extra.ts': `export const gone = "/sprites/effects/missing.png"\n`,
    }
    // explore-1 loses its rear-right frame: ROLE_TO_CHAR expands to all four
    delete files['public/sprites/characters/explore-1-rear-right.png']
    const { status, out } = run(fixture(files))
    expect(status).toBe(1)
    expect(out).toMatch(/Missing — referenced but not in public\/ \(2\)/)
    expect(out).toContain('sprites/effects/missing.png   <- literal in src/extra.ts')
    expect(out).toContain('sprites/characters/explore-1-rear-right.png   <- P1 character "explore-1"')
    expect(out).toContain('check-assets: 2 referenced asset(s) missing')
  })

  it('passes a consistent tree, lists the orphan and expands the character bases', () => {
    const { status, out } = run(fixture(CONSISTENT))
    expect(status).toBe(0)
    expect(out).not.toContain('Missing')
    expect(out).toMatch(/Unreferenced — nothing in the code asks for these \(1,/)
    expect(out).toContain('  sprites/old.png')
    // dev-1 and Me-1 come from ROLE_TO_CHAR and the boss fallback, explore-1 from the config; keys are not bases
    expect(out).not.toContain('dev-1-')
    expect(out).not.toContain('Me-1-')
    expect(out).not.toContain('Explore-')
    expect(out).not.toContain('boss-')
    // Helper.png is a documented template, so it is "kept", not unreferenced
    expect(out).toContain('kept: 1')
    expect(out).not.toContain('Helper.png')
    expect(out).toContain('within budget')
  })

  it('fails when public/ is over the budget', () => {
    const { status, out } = run(fixture(CONSISTENT), { CHECK_ASSETS_BUDGET: '100' })
    expect(status).toBe(1)
    expect(out).toMatch(/over the 0\.0 MB budget/)
    expect(out).toContain('raise BUDGET_BYTES')
  })

  it('fails on a dynamic sprite path it does not model', () => {
    const { status, out } = run(fixture({
      ...CONSISTENT,
      'src/new.ts': 'export const p = (n: string) => `/sprites/new/${n}-${n}.png`\n',
    }))
    expect(status).toBe(1)
    expect(out).toContain('src/new.ts: dynamic asset path `/sprites/new/*-*.png` is not modelled')
  })

  it('treats an incident slot\'s intended art as optional and its fallback as required', () => {
    const slots = `
export const INCIDENT_ASSETS = {
  beacon: { intended: '/sprites/incident/beacon-0.png', fallback: '/sprites/effects/fire.png', note: '' },
  sign:   { intended: '/sprites/culture/sign.png',      fallback: '/sprites/culture/sign.png',  note: '' },
}
`
    const ok = run(fixture({
      ...CONSISTENT,
      'src/incidentAssets.ts': slots,
      'public/sprites/effects/fire.png': PNG,
      'public/sprites/culture/sign.png': PNG,
    }))
    expect(ok.status).toBe(0)
    expect(ok.out).toContain('Incident art slots without art yet (optional')
    expect(ok.out).toContain('  sprites/incident/beacon-0.png')

    // The fallback is a plain reference: without it the check fails
    const broken = run(fixture({ ...CONSISTENT, 'src/incidentAssets.ts': slots, 'public/sprites/culture/sign.png': PNG }))
    expect(broken.status).toBe(1)
    expect(broken.out).toContain('sprites/effects/fire.png   <- literal in src/incidentAssets.ts')
  })

  it('fails loudly when a pattern anchor disappears from the source', () => {
    const { status, out } = run(fixture({ ...CONSISTENT, 'src/theme.ts': 'export const nothing = 1\n' }))
    expect(status).toBe(1)
    expect(out).toContain('src/theme.ts: could not find OFFICE_CHARACTERS')
  })

  it('this checkout: nothing missing, no unmodelled pattern, within budget', () => {
    const { status, out } = run(REPO)
    expect(out).not.toContain('Missing —')
    expect(out).not.toContain('not modelled')
    expect(out).toContain('within budget')
    expect(status).toBe(0)
  })
})
