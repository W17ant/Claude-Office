/**
 * cli/agent-office.mjs - the npx command: argument handling, the hooks-path
 * decision (checkout in place vs a stable copy in $AGENT_OFFICE_HOME/hooks),
 * install / uninstall from a package copy that is then deleted the way npm
 * cleans its npx cache, doctor against that copy, and start --detach / stop.
 * Every run gets a temp HOME, AGENT_OFFICE_HOME and CLAUDE_CONFIG_DIR, so the
 * developer's real ~/.claude/settings.json is never read or written.
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { copyHooks, HOOK_FILES, isCheckout, main, npxCommands, parseArgs, resolveHooksDir } from '../cli/agent-office.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(ROOT, 'cli', 'agent-office.mjs')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tempDir(prefix = 'agent-office-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A writable stream stand-in that keeps what was written. */
function sink() {
  const s = { text: '', isTTY: false, write(chunk: string) { s.text += chunk; return true } }
  return s
}

/** Temp HOME / AGENT_OFFICE_HOME / CLAUDE_CONFIG_DIR; nothing of the caller's office or Claude config. */
function isolatedEnv(extra: Record<string, string> = {}) {
  const home = tempDir('agent-office-cli-home-')
  const { CLAUDE_CONFIG_DIR: _c, AGENT_OFFICE_HOME: _h, AGENT_OFFICE_PORT: _p, AGENT_OFFICE_UI_DIR: _u, AGENT_OFFICE_CONFIG_DIR: _cfg, ...env } = process.env
  return {
    home,
    env: { ...env, HOME: home, AGENT_OFFICE_HOME: join(home, '.agent-office'), CLAUDE_CONFIG_DIR: join(home, '.claude'), NO_COLOR: '1', ...extra } as NodeJS.ProcessEnv,
  }
}

/**
 * The package laid out the way npx unpacks it: <cache>/node_modules/@w17ant/agent-office
 * with the files the tarball carries that these commands touch.
 */
function npxCopy() {
  const cache = tempDir('agent-office-npx-')
  const root = join(cache, 'node_modules', '@w17ant', 'agent-office')
  mkdirSync(root, { recursive: true })
  for (const p of ['package.json', 'hooks', 'scripts/stop-office.sh']) cpSync(join(ROOT, p), join(root, p), { recursive: true })
  return { cache, root }
}

describe('parseArgs', () => {
  it('runs start when no command is given, with any start flag', () => {
    expect(parseArgs([])).toMatchObject({ command: 'start' })
    expect(parseArgs(['--no-open']).command).toBe('start')
    expect(parseArgs(['--no-open']).flags.has('--no-open')).toBe(true)
    expect(parseArgs(['start', '-d']).flags.has('-d')).toBe(true)
  })

  it('accepts each command with its own flags, before or after the command', () => {
    expect(parseArgs(['install-hooks', '--status-line-only'])).toMatchObject({ command: 'install-hooks' })
    expect(parseArgs(['--no-status-line', 'uninstall-hooks'])).toMatchObject({ command: 'uninstall-hooks' })
    expect(parseArgs(['doctor', '--json'])).toMatchObject({ command: 'doctor' })
    expect(parseArgs(['stop', '--force'])).toMatchObject({ command: 'stop' })
    expect(parseArgs(['open', '--print'])).toMatchObject({ command: 'open' })
    for (const r of [parseArgs(['install-hooks', '--status-line-only']), parseArgs(['doctor', '--json'])]) expect(r.error).toBeUndefined()
  })

  it('refuses an unknown command, a stray argument, a flag of another command and contradicting flags', () => {
    expect(parseArgs(['serve']).error).toBe('Unknown command: serve')
    expect(parseArgs(['start', 'now']).error).toBe('Unexpected argument: now')
    expect(parseArgs(['start', '--json']).error).toBe('Unknown option for start: --json')
    expect(parseArgs(['doctor', '--detach']).error).toBe('Unknown option for doctor: --detach')
    expect(parseArgs(['install-hooks', '--no-status-line', '--status-line-only']).error).toContain('leave nothing to do')
  })

  it('--help and --version win over everything else', () => {
    expect(parseArgs(['doctor', '--help']).command).toBe('help')
    expect(parseArgs(['help']).command).toBe('help')
    expect(parseArgs(['-h', 'serve']).command).toBe('help')
    expect(parseArgs(['--version']).command).toBe('version')
    expect(parseArgs(['start', '-v']).command).toBe('version')
  })

  it('--port takes a port number in either spelling and refuses anything else', () => {
    expect(parseArgs(['--port', '3401'])).toMatchObject({ command: 'start', port: 3401 })
    expect(parseArgs(['doctor', '--port=3402'])).toMatchObject({ command: 'doctor', port: 3402 })
    expect(parseArgs(['--port']).error).toContain('got nothing')
    expect(parseArgs(['--port', '0']).error).toContain('1-65535')
    expect(parseArgs(['--port', '70000']).error).toContain('1-65535')
    expect(parseArgs(['--port=abc']).error).toContain('"abc"')
  })
})

describe('main: help, version, usage errors', () => {
  it('prints the version from package.json and the usage under the npx name', async () => {
    const out = sink()
    expect(await main(['--version'], { out, err: sink() })).toBe(0)
    expect(out.text.trim()).toBe(pkg.version)
    const help = sink()
    expect(await main(['--help'], { out: help, err: sink() })).toBe(0)
    expect(help.text).toContain(`Usage: npx ${pkg.name} [command]`)
    for (const c of ['start', 'open', 'stop', 'install-hooks', 'uninstall-hooks', 'doctor']) expect(help.text).toContain(c)
  })

  it('exits 2 with the error and the usage on a bad command line', async () => {
    const err = sink()
    expect(await main(['bogus'], { out: sink(), err })).toBe(2)
    expect(err.text).toContain('Unknown command: bogus')
    expect(err.text).toContain('Usage:')
  })

  it('runs as the bin (the shebang file npm links into node_modules/.bin)', () => {
    const res = spawnSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.trim()).toBe(pkg.version)
    expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(pkg.bin).toEqual({ 'agent-office': 'cli/agent-office.mjs' })
  })
})

describe('where the hooks live', () => {
  it('a git checkout keeps its own hooks/ (as npm run install-hooks does)', () => {
    expect(isCheckout(ROOT)).toBe(true)
    expect(resolveHooksDir({ root: ROOT, officeHome: '/h/.agent-office' })).toEqual({ dir: join(ROOT, 'hooks'), copy: false })
  })

  it('an installed package (npx cache, global or local node_modules) copies them to $AGENT_OFFICE_HOME/hooks', () => {
    const exists = () => true // even with a .git somewhere inside, node_modules is never a checkout
    for (const root of ['/Users/a/.npm/_npx/0c1d/node_modules/@w17ant/agent-office', '/usr/local/lib/node_modules/@w17ant/agent-office']) {
      expect(resolveHooksDir({ root, officeHome: '/h/.agent-office', exists })).toEqual({ dir: '/h/.agent-office/hooks', copy: true })
    }
    expect(resolveHooksDir({ root: '/opt/agent-office', officeHome: '/h/.agent-office', exists: () => false })).toEqual({ dir: '/h/.agent-office/hooks', copy: true })
  })

  it('copyHooks writes every hook file whole, scripts executable, and leaves no temp files', () => {
    const dest = join(tempDir(), 'office', 'hooks')
    copyHooks(join(ROOT, 'hooks'), dest)
    expect(readdirSync(dest).sort()).toEqual([...HOOK_FILES].sort())
    for (const f of HOOK_FILES) {
      expect(readFileSync(join(dest, f)).equals(readFileSync(join(ROOT, 'hooks', f)))).toBe(true)
      expect(statSync(join(dest, f)).mode & 0o777).toBe(f.endsWith('.sh') ? 0o755 : 0o644)
    }
    // A re-run (a newer version) replaces the files in place
    writeFileSync(join(dest, 'agent-tracker.sh'), 'stale')
    copyHooks(join(ROOT, 'hooks'), dest)
    expect(readFileSync(join(dest, 'agent-tracker.sh')).equals(readFileSync(join(ROOT, 'hooks', 'agent-tracker.sh')))).toBe(true)
  })
})

describe('install-hooks / doctor / uninstall-hooks from an npx copy', () => {
  it('points settings.json at the stable copy, which keeps working after the npx cache is deleted', async () => {
    const { home, env } = isolatedEnv()
    const { cache, root } = npxCopy()
    const out = sink()
    const err = sink()
    expect(await main(['install-hooks'], { root, env, out, err })).toBe(0)
    const stable = join(home, '.agent-office', 'hooks')
    expect(out.text).toContain(`Copied the hook scripts to ${stable}`)
    // The installer was told how this install starts the office
    expect(out.text).toContain(`npx ${pkg.name}`)
    expect(out.text).not.toContain('npm run server')

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
    const commands = Object.values(settings.hooks).flatMap((groups: any) => groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)))
    expect(commands.length).toBeGreaterThan(0)
    for (const c of commands) expect(c).toBe(`bash "${join(stable, 'agent-tracker.sh')}"`)
    expect(settings.statusLine.command).toBe(`bash "${join(stable, 'status-line.sh')}"`)

    // npm cleans its cache: the hooks are still where settings.json says
    rmSync(cache, { recursive: true, force: true })
    for (const f of HOOK_FILES) expect(existsSync(join(stable, f))).toBe(true)

    // doctor (from a fresh copy, a later npx run) accepts the stable copy and names npx commands
    const later = npxCopy().root
    const report = sink()
    await main(['doctor', '--no-color', '--port', '1'], { root: later, env, out: report, err: sink() })
    expect(report.text).toMatch(new RegExp(`PASS  hooks: \\d+/\\d+ events run ${stable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    expect(report.text).toContain('PASS  hook files')
    expect(report.text).toContain(npxCommands(`npx ${pkg.name}`).install)
    expect(report.text).not.toContain('npm run install-hooks')

    // uninstall takes the entries out and removes the copy
    const un = sink()
    expect(await main(['uninstall-hooks'], { root: later, env, out: un, err: sink() })).toBe(0)
    const after = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(JSON.stringify(after)).not.toContain('agent-tracker.sh')
    expect(after).not.toHaveProperty('statusLine')
    expect(existsSync(stable)).toBe(false)
  })

  it('a partial uninstall keeps the copy the remaining entries run', async () => {
    const { home, env } = isolatedEnv()
    const { root } = npxCopy()
    await main(['install-hooks'], { root, env, out: sink(), err: sink() })
    expect(await main(['uninstall-hooks', '--no-status-line'], { root, env, out: sink(), err: sink() })).toBe(0)
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))
    expect(settings.statusLine.command).toContain(join(home, '.agent-office', 'hooks', 'status-line.sh'))
    expect(existsSync(join(home, '.agent-office', 'hooks', 'status-line.sh'))).toBe(true)
  })
})

/** A port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

describe('start --detach / stop', () => {
  it('serves the built UI and /health on the chosen port, then stops by pid file', async () => {
    const ui = tempDir('agent-office-cli-ui-')
    writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Agent Office</title>')
    const { home, env } = isolatedEnv({ AGENT_OFFICE_UI_DIR: ui })
    const port = await freePort()
    // As its own process, the way a user runs it: the CLI exits and the server
    // is left to init. (Started from this test's process, the stopped server
    // would linger as an unreaped zombie while stop-office.sh waits on it.)
    const res = spawnSync(process.execPath, [BIN, 'start', '--detach', '--no-open', '--port', String(port)], { env, encoding: 'utf8', timeout: 25_000 })
    const out = { text: res.stdout }
    try {
      expect(res.stderr).toBe('')
      expect(res.status).toBe(0)
      expect(out.text).toMatch(new RegExp(`Agent Office: http://127\\.0\\.0\\.1:${port}/#token=[0-9a-f]{64}`))
      expect(out.text).toContain(`npx ${pkg.name} stop`)
      expect((await fetch(`http://127.0.0.1:${port}/`).then(r => r.text()))).toContain('<title>Agent Office</title>')
      expect((await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())).status).toBe('ok')
      const log = join(home, '.agent-office', 'server.log')
      expect(statSync(log).mode & 0o777).toBe(0o600)
      // A second start finds it running and only prints the link again
      const again = sink()
      expect(await main(['start', '--no-open', '--port', String(port)], { env, out: again, err: sink() })).toBe(0)
      expect(again.text).toContain(`already answering on port ${port}`)
    } finally {
      const stop = sink()
      expect(await main(['stop', '--port', String(port)], { env, out: stop, err: sink() })).toBe(0)
      expect(stop.text).toContain('Server stopped')
    }
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  }, 30_000)

  it('refuses to start without a built UI', async () => {
    const { env } = isolatedEnv({ AGENT_OFFICE_UI_DIR: tempDir() })
    const err = sink()
    expect(await main(['start', '--no-open', '--port', String(await freePort())], { env, out: sink(), err })).toBe(1)
    expect(err.text).toContain('The office UI is not built')
  })
})
