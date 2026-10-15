/**
 * Tagged releases. .github/workflows/release.yml builds the desktop installers
 * on a `v*` tag and uploads them to a draft GitHub release, from the `build`
 * section of package.json. These checks keep the workflow, that section and
 * electron/after-pack.cjs in step with each other, and run
 * scripts/sync-plugin-version.mjs — the `version` script that moves
 * .claude-plugin/plugin.json to package.json's version when `npm version`
 * cuts a release (tests/plugin.test.ts fails when the two differ).
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const SYNC = join(ROOT, 'scripts', 'sync-plugin-version.mjs')

const pkg = JSON.parse(read('package.json'))
const build = pkg.build
const workflow = read('.github/workflows/release.yml')

describe('the electron-builder configuration a release is built from', () => {
  it('names every installer Agent-Office-<version>-<os>-<arch>.<ext>', () => {
    expect(build.artifactName).toBe('Agent-Office-${version}-${os}-${arch}.${ext}')
  })

  it('publishes to a GitHub draft, in the repository package.json names', () => {
    expect(build.publish).toEqual({ provider: 'github', releaseType: 'draft' })
    expect(pkg.repository.url).toMatch(/^https:\/\/github\.com\/W17ant\/Claude-Office(\.git)?$/)
  })

  it('builds macOS as one dmg per architecture, never universal — after-pack.cjs refuses that', () => {
    expect(build.mac.target).toEqual([{ target: 'dmg', arch: ['arm64', 'x64'] }])
    expect(read('electron/after-pack.cjs')).toMatch(/archName === 'universal'/)
  })

  it('builds an NSIS installer that asks where to install on Windows, and an AppImage on Linux', () => {
    expect(build.win.target).toEqual(['nsis'])
    expect(build.nsis).toMatchObject({ oneClick: false, allowToChangeInstallationDirectory: true })
    expect(build.linux.target).toEqual(['AppImage'])
  })
})

describe('.github/workflows/release.yml', () => {
  it('runs on v* tags and by hand, with a token that may create the release, one run per ref at a time', () => {
    expect(workflow).toMatch(/^on:\n  push:\n    tags: \['v\*'\]\n  workflow_dispatch:/m)
    expect(workflow).toMatch(/^permissions:\n  contents: write/m)
    expect(workflow).toMatch(/^concurrency:\n  group: release-\$\{\{ github\.ref \}\}/m)
  })

  it('builds on all three runners, unsigned, and uploads to the draft', () => {
    for (const os of ['macos-latest', 'windows-latest', 'ubuntu-latest']) {
      expect(workflow).toContain(`os: ${os}`)
    }
    expect(workflow).toContain('npx electron-builder ${{ matrix.args }} --publish always')
    expect(workflow).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: false')
  })

  it('ships the default boss: the example office.config.json is never copied in', () => {
    expect(workflow).not.toMatch(/cp office\.config\.example\.json/)
  })
})

describe('scripts/sync-plugin-version.mjs (the `version` script)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A checkout-shaped scratch dir: package.json at `version`, the real plugin manifest. */
  function scratch(version: string) {
    const dir = mkdtempSync(join(tmpdir(), 'sync-plugin-version-'))
    dirs.push(dir)
    mkdirSync(join(dir, '.claude-plugin'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'agent-office', version }) + '\n')
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), read('.claude-plugin/plugin.json'))
    return dir
  }

  it('is what `npm version` runs, and stages the manifest for the version commit', () => {
    expect(pkg.scripts.version).toBe('node scripts/sync-plugin-version.mjs && git add .claude-plugin/plugin.json')
  })

  it('rewrites the version line of plugin.json and nothing else', () => {
    const dir = scratch('9.9.9')
    execFileSync(process.execPath, [SYNC, dir])
    const after = readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')
    expect(JSON.parse(after).version).toBe('9.9.9')
    expect(after.replace('"version": "9.9.9"', `"version": "${pkg.version}"`)).toBe(read('.claude-plugin/plugin.json'))
  })

  it('leaves a manifest that is already current as it is, and fails on one without a version line', () => {
    const dir = scratch(pkg.version)
    const file = join(dir, '.claude-plugin', 'plugin.json')
    const before = readFileSync(file, 'utf8')
    execFileSync(process.execPath, [SYNC, dir])
    expect(readFileSync(file, 'utf8')).toBe(before)

    writeFileSync(file, '{ "name": "agent-office" }\n')
    expect(() => execFileSync(process.execPath, [SYNC, dir], { stdio: 'pipe' })).toThrow()
  })
})
