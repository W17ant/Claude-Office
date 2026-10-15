/**
 * scripts/doctor.mjs — `npm run doctor`: the PASS / WARN / FAIL lines for
 * node, the hooks (settings.json or the plugin), the status line, the tools
 * on PATH, the server, the auth token and the build; exit 1 on any FAIL.
 * Runs against temp HOME / CLAUDE_CONFIG_DIR / AGENT_OFFICE_HOME fixtures,
 * through runDoctor() and by spawning the script.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, postEvent, removeOffice, type Office } from './helpers'
import { runDoctor, checkNode, scriptPathIn, shellWords, inspectPlugin, COMMANDS, PASS, WARN, FAIL } from '../scripts/doctor.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCTOR = join(ROOT, 'scripts', 'doctor.mjs')
const INSTALLER = join(ROOT, 'hooks', 'install-hooks.sh')
const TRACKER = join(ROOT, 'hooks', 'agent-tracker.sh')

type Line = { level: string; title: string; notes: string[] }
type Report = { results: Line[]; ok: boolean; context: Record<string, unknown> }

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** The installer's environment: a temp HOME, never the caller's CLAUDE_CONFIG_DIR (the installer honours it) */
function installerEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { CLAUDE_CONFIG_DIR: _ignored, ...env } = process.env
  return { ...env, HOME: home, AGENT_OFFICE_HOME: join(home, '.agent-office'), ...extra }
}

/** A HOME with the real installer run into it (hooks + status line) */
function installedHome(args: string[] = []) {
  const home = tmp('doctor-home-')
  execFileSync('bash', [INSTALLER, ...args], { encoding: 'utf8', env: installerEnv(home) })
  return home
}

function writeSettings(dir: string, settings: unknown) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
}

/** A free port nothing listens on, for the "server down" path */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise(resolve => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

const line = (r: Report, prefix: string) => r.results.find(l => l.title.startsWith(prefix))
const lines = (r: Report, prefix: string) => r.results.filter(l => l.title.startsWith(prefix))
const levelOf = (r: Report, prefix: string) => line(r, prefix)?.level

/** Options every run shares: this box's PATH, a port nothing answers on */
async function base(home: string, over: Record<string, unknown> = {}) {
  return { home, officeHome: join(home, '.agent-office'), port: await freePort(), env: {} as Record<string, string>, ...over }
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

describe('doctor helpers', () => {
  it('splits a hook command like a shell and finds the script it names (the installer\'s rule)', () => {
    expect(shellWords('bash "/a b/hooks/agent-tracker.sh"')).toEqual(['bash', '/a b/hooks/agent-tracker.sh'])
    expect(shellWords("bash '/x/agent-tracker.sh' --flag")).toEqual(['bash', '/x/agent-tracker.sh', '--flag'])
    expect(shellWords('bash /x/agent\\ y/agent-tracker.sh')).toEqual(['bash', '/x/agent y/agent-tracker.sh'])
    expect(scriptPathIn('bash "/old/hooks/agent-tracker.sh"', 'agent-tracker.sh')).toBe('/old/hooks/agent-tracker.sh')
    expect(scriptPathIn('bash "${CLAUDE_PLUGIN_ROOT}/hooks/agent-tracker.sh"', 'agent-tracker.sh')).toBe('${CLAUDE_PLUGIN_ROOT}/hooks/agent-tracker.sh')
    expect(scriptPathIn('say done', 'agent-tracker.sh')).toBeNull()
    expect(scriptPathIn(undefined, 'agent-tracker.sh')).toBeNull()
    expect(scriptPathIn('bash /x/hooks/status-line.sh --subagents', 'status-line.sh')).toBe('/x/hooks/status-line.sh')
    // Containing the name is not enough: these are someone else's (the installer leaves them alone too)
    expect(scriptPathIn('bash ~/.claude/my-status-line.sh', 'status-line.sh')).toBeNull()
    expect(scriptPathIn('~/.claude/status-line.sh', 'status-line.sh')).toBeNull()
    expect(scriptPathIn('bash ~/bin/my-agent-tracker.sh --log /tmp/x', 'agent-tracker.sh')).toBeNull()
    expect(scriptPathIn('python3 ~/tools/claude-agent-tracker.sh.py', 'agent-tracker.sh')).toBeNull()
  })

  it('node: 20+ passes, older fails with the floor in the message', () => {
    expect(checkNode('22.22.0').level).toBe(PASS)
    expect(checkNode('20.0.0').level).toBe(PASS)
    const old = checkNode('18.20.4')
    expect(old.level).toBe(FAIL)
    expect(old.title).toContain('Node 20+')
  })

  it('finds an installed plugin in enabledPlugins + installed_plugins.json, the cache, or the marketplace clone', () => {
    const config = tmp('doctor-config-')
    const cacheCopy = join(config, 'plugins', 'cache', 'agent-office', 'agent-office', '1.0.0')
    mkdirSync(join(cacheCopy, 'hooks'), { recursive: true })
    writeFileSync(join(cacheCopy, 'hooks', 'agent-tracker.sh'), '#!/bin/bash\n')
    const settings = { enabledPlugins: { 'agent-office@agent-office': true } }
    const found = inspectPlugin(settings, config)
    expect(found.found).toBe(true)
    expect(found.enabledKey).toBe('agent-office@agent-office')
    expect(found.copies).toEqual([expect.objectContaining({ dir: cacheCopy, source: 'plugins/cache/agent-office/agent-office/1.0.0' })])

    // installed_plugins.json names an installPath (v2: a list per key)
    const installDir = join(config, 'elsewhere')
    mkdirSync(join(installDir, 'hooks'), { recursive: true })
    writeFileSync(join(installDir, 'hooks', 'agent-tracker.sh'), '#!/bin/bash\n')
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'agent-office@agent-office': [{ scope: 'user', installPath: installDir, version: '1.0.0' }] } }))
    expect(inspectPlugin(settings, config).copies.map(c => c.source)).toEqual(['installed_plugins.json', 'plugins/cache/agent-office/agent-office/1.0.0'])

    // Enabled but nothing on disk; disabled but on disk
    expect(inspectPlugin(settings, tmp('doctor-empty-')).found).toBe(false)
    const disabled = inspectPlugin({ enabledPlugins: { 'agent-office@agent-office': false } }, config)
    expect(disabled.found).toBe(false)
    expect(disabled.disabledKey).toBe('agent-office@agent-office')
    expect(disabled.copies.length).toBeGreaterThan(0)
    expect(inspectPlugin({}, config).enabledKey).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Whole runs against fixtures
// ---------------------------------------------------------------------------

describe('runDoctor', () => {
  it('passes the hooks and status line on a HOME the installer set up; the server down is a WARN, not a FAIL', async () => {
    const home = installedHome()
    const r = (await runDoctor(await base(home))) as Report

    expect(line(r, 'node')?.level).toBe(PASS)
    const hooks = line(r, 'hooks:')!
    expect(hooks.level).toBe(PASS)
    expect(hooks.title).toMatch(/^hooks: 19\/19 events run /)
    expect(hooks.title).toContain(TRACKER)
    expect(lines(r, 'hooks:')).toHaveLength(1)                 // no "not this checkout" / duplicate lines
    expect(lines(r, 'plugin')).toHaveLength(0)
    const status = line(r, 'status line:')!
    expect(status.level).toBe(PASS)
    expect(status.title).toContain('statusLine + subagentStatusLine run')
    for (const tool of ['python3:', 'bash:', 'curl:']) expect(levelOf(r, tool)).toBe(PASS)
    const server = line(r, 'server:')!
    expect(server.level).toBe(WARN)
    expect(server.title).toContain('nothing answers on http://127.0.0.1:')
    expect(server.notes.join(' ')).toContain(COMMANDS.start)
    expect(line(r, 'token:')?.level).toBe(WARN)                 // not written until the server starts
    expect(line(r, 'token:')?.title).toContain(join(home, '.agent-office', 'auth-token'))
    expect(['PASS', 'WARN']).toContain(levelOf(r, 'dist/:'))   // depends on whether this checkout is built
    expect(r.ok).toBe(true)
    expect(r.context).toMatchObject({ settingsPath: join(home, '.claude', 'settings.json'), tracker: TRACKER })
  })

  it('fails when the hooks point at a checkout that is gone, naming the dead path and the installer', async () => {
    const home = tmp('doctor-home-')
    const group = (path: string) => [{ matcher: '', hooks: [{ type: 'command', command: `bash "${path}/hooks/agent-tracker.sh"` }] }]
    const events = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd',
      'UserPromptSubmit', 'Stop', 'PermissionRequest', 'Notification', 'StopFailure', 'PreCompact', 'PostCompact', 'PostToolBatch', 'CwdChanged', 'PostModelSwitch']
    writeSettings(join(home, '.claude'), { hooks: Object.fromEntries(events.map(e => [e, group('/old/moved/path')])) })
    const r = (await runDoctor(await base(home))) as Report
    const hooks = line(r, 'hooks:')!
    expect(hooks.level).toBe(FAIL)
    expect(hooks.title).toContain('/old/moved/path/hooks/agent-tracker.sh')
    expect(hooks.notes.join(' ')).toContain(COMMANDS.install)
    expect(r.ok).toBe(false)
  })

  it('warns about a partial install (missing events), another checkout, and a duplicate entry', async () => {
    const home = tmp('doctor-home-')
    const other = tmp('doctor-other-checkout-')
    mkdirSync(join(other, 'hooks'))
    writeFileSync(join(other, 'hooks', 'agent-tracker.sh'), '#!/bin/bash\n')
    const entry = (path: string) => ({ type: 'command', command: `bash "${path}/hooks/agent-tracker.sh"` })
    writeSettings(join(home, '.claude'), {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [entry(other)] }],
        PostToolUse: [{ matcher: '', hooks: [entry(other), entry(other)] }],
        Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      },
    })
    const r = (await runDoctor(await base(home))) as Report
    const [summary, foreign, dup] = lines(r, 'hooks:')
    expect(summary.level).toBe(WARN)
    expect(summary.title).toMatch(/^hooks: 2\/19 events run /)
    expect(summary.title).toContain('missing: PostToolUseFailure, SubagentStart')
    expect(foreign.level).toBe(WARN)
    expect(foreign.title).toContain(`${other}/hooks/agent-tracker.sh is not this checkout's hooks/agent-tracker.sh`)
    expect(dup.level).toBe(WARN)
    expect(dup.title).toContain('registered twice for PostToolUse')
    expect(line(r, 'status line:')?.level).toBe(WARN)
    expect(r.ok).toBe(true)
  })

  it('fails with the install command when nothing is registered and no plugin is enabled', async () => {
    const home = tmp('doctor-home-')
    const r = (await runDoctor(await base(home))) as Report
    const hooks = line(r, 'hooks:')!
    expect(hooks.level).toBe(FAIL)
    expect(hooks.title).toContain('does not exist')
    expect(hooks.notes.join('\n')).toContain(COMMANDS.install)
    expect(hooks.notes.join('\n')).toContain(COMMANDS.plugin)
    expect(r.ok).toBe(false)

    // settings.json present but without our entries
    writeSettings(join(home, '.claude'), { permissions: { allow: [] } })
    const r2 = (await runDoctor(await base(home))) as Report
    expect(line(r2, 'hooks:')?.title).toContain('nothing in')
    expect(line(r2, 'hooks:')?.level).toBe(FAIL)
  })

  it('accepts the plugin as the hook source, and tells plugin-only installs the meters need the installer', async () => {
    const home = tmp('doctor-home-')
    const config = join(home, '.claude')
    const copy = join(config, 'plugins', 'cache', 'agent-office', 'agent-office', '1.0.0')
    mkdirSync(join(copy, 'hooks'), { recursive: true })
    writeFileSync(join(copy, 'hooks', 'agent-tracker.sh'), '#!/bin/bash\n')
    writeSettings(config, { enabledPlugins: { 'agent-office@agent-office': true } })

    const r = (await runDoctor(await base(home))) as Report
    expect(lines(r, 'hooks:')).toHaveLength(0)
    const plugin = line(r, 'plugin agent-office@agent-office')!
    expect(plugin.level).toBe(PASS)
    expect(plugin.title).toContain(join(copy, 'hooks', 'agent-tracker.sh'))
    const status = line(r, 'status line:')!
    expect(status.level).toBe(WARN)
    expect(status.title).toContain('a plugin cannot set statusLine')
    // The status line alone: the full installer would register the plugin's hooks a second time
    expect(status.notes.join(' ')).toContain(`${COMMANDS.statusLine} from a clone adds it and nothing else`)
    expect(COMMANDS.statusLine).toBe('npm run install-status-line')
    expect(r.ok).toBe(true)
  })

  it('a plugin install that followed that advice has the meters and no doubled hooks', async () => {
    const home = tmp('doctor-home-')
    const config = join(home, '.claude')
    const copy = join(config, 'plugins', 'cache', 'agent-office', 'agent-office', '1.0.0')
    mkdirSync(join(copy, 'hooks'), { recursive: true })
    writeFileSync(join(copy, 'hooks', 'agent-tracker.sh'), '#!/bin/bash\n')
    writeSettings(config, { enabledPlugins: { 'agent-office@agent-office': true } })
    execFileSync('bash', [INSTALLER, '--status-line-only'], { encoding: 'utf8', env: installerEnv(home) })

    const r = (await runDoctor(await base(home))) as Report
    expect(lines(r, 'hooks:')).toHaveLength(0)
    expect(line(r, 'plugin agent-office@agent-office')?.level).toBe(PASS)
    expect(r.results.some(l => l.title.includes('arrives twice'))).toBe(false)
    expect(line(r, 'status line:')?.level).toBe(PASS)
  })

  it('warns when both the installer\'s hooks and the plugin are active (every agent arrives twice)', async () => {
    const home = installedHome()
    const config = join(home, '.claude')
    const copy = join(config, 'plugins', 'cache', 'agent-office', 'agent-office', '1.0.0')
    mkdirSync(join(copy, 'hooks'), { recursive: true })
    writeFileSync(join(copy, 'hooks', 'agent-tracker.sh'), '#!/bin/bash\n')
    const settings = JSON.parse(execFileSync('cat', [join(config, 'settings.json')], { encoding: 'utf8' }))
    writeSettings(config, { ...settings, enabledPlugins: { 'agent-office@agent-office': true } })

    const r = (await runDoctor(await base(home))) as Report
    expect(line(r, 'hooks:')?.level).toBe(PASS)
    const both = line(r, 'plugin agent-office@agent-office')!
    expect(both.level).toBe(WARN)
    expect(both.title).toContain('every agent arrives twice')
    // The remedy keeps the meters: the hooks go, the status line (which the plugin cannot set) stays
    expect(both.notes.join(' ')).toContain(`${COMMANDS.uninstallHooks} takes the installer's hooks out and keeps the status line`)
    expect(COMMANDS.uninstallHooks).toBe('npm run uninstall-hooks -- --no-status-line')
    expect(both.notes.join(' ')).toContain(COMMANDS.unplugin)
  })

  it('reads $CLAUDE_CONFIG_DIR/settings.json when set, and says so when the hooks sit in ~/.claude instead', async () => {
    const home = installedHome()                               // hooks in ~/.claude/settings.json
    const config = tmp('doctor-config-')                       // but Claude Code reads here
    writeSettings(config, {})
    const r = (await runDoctor(await base(home, { env: { CLAUDE_CONFIG_DIR: config } }))) as Report
    expect(r.context.settingsPath).toBe(join(config, 'settings.json'))
    const hooks = line(r, 'hooks:')!
    expect(hooks.level).toBe(FAIL)
    expect(hooks.notes.join('\n')).toContain(`they are in ${join(home, '.claude', 'settings.json')}`)
    expect(hooks.notes.join('\n')).toContain(`${COMMANDS.install} with CLAUDE_CONFIG_DIR set writes them there`)

    // Hooks in the config dir itself: fine
    const config2 = tmp('doctor-config-')
    writeSettings(config2, JSON.parse(execFileSync('cat', [join(home, '.claude', 'settings.json')], { encoding: 'utf8' })))
    const r2 = (await runDoctor(await base(home, { env: { CLAUDE_CONFIG_DIR: config2 } }))) as Report
    expect(line(r2, 'hooks:')?.level).toBe(PASS)

    // Following the remedy works: the installer run with CLAUDE_CONFIG_DIR set writes the file the doctor reads
    const config3 = tmp('doctor-config-')
    execFileSync('bash', [INSTALLER], { encoding: 'utf8', env: installerEnv(home, { CLAUDE_CONFIG_DIR: config3 }) })
    const r3 = (await runDoctor(await base(home, { env: { CLAUDE_CONFIG_DIR: config3 } }))) as Report
    expect(line(r3, 'hooks:')?.level).toBe(PASS)
    expect(line(r3, 'status line:')?.level).toBe(PASS)
  })

  it('flags a settings.json that is not JSON', async () => {
    const home = tmp('doctor-home-')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json')
    const r = (await runDoctor(await base(home))) as Report
    expect(line(r, 'settings:')?.level).toBe(FAIL)
    expect(line(r, 'settings:')?.title).toContain('not valid JSON')
    expect(r.ok).toBe(false)
  })

  it('token: 0600 passes, looser modes fail with the chmod, absent is a WARN while the server is down', async () => {
    const home = installedHome()
    const officeHome = join(home, '.agent-office')
    const token = join(officeHome, 'auth-token')
    writeFileSync(token, 'secret\n')
    chmodSync(token, 0o644)
    const loose = (await runDoctor(await base(home))) as Report
    expect(line(loose, 'token:')?.level).toBe(FAIL)
    expect(line(loose, 'token:')?.title).toContain('mode 0644')
    expect(line(loose, 'token:')?.notes.join(' ')).toContain(`chmod 600 "${token}"`)
    expect(loose.ok).toBe(false)

    chmodSync(token, 0o600)
    const tight = (await runDoctor(await base(home))) as Report
    expect(line(tight, 'token:')).toEqual({ level: PASS, title: `token: ${token} (0600)`, notes: [] })

    // AGENT_OFFICE_HOME from the environment is honoured
    const elsewhere = tmp('doctor-office-home-')
    const r = (await runDoctor(await base(home, { officeHome: undefined, env: { AGENT_OFFICE_HOME: elsewhere } }))) as Report
    expect(line(r, 'token:')?.title).toContain(join(elsewhere, 'auth-token'))
    expect(line(r, 'token:')?.level).toBe(WARN)
  })

  it('tools: a PATH without python3 fails that line and names why', async () => {
    const home = installedHome()
    const bin = tmp('doctor-bin-')
    for (const name of ['bash', 'curl']) {
      const real = execFileSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
      symlinkSync(real, join(bin, name))
    }
    const r = (await runDoctor(await base(home, { path: bin }))) as Report
    expect(line(r, 'bash:')?.level).toBe(PASS)
    expect(line(r, 'curl:')?.level).toBe(PASS)
    expect(line(r, 'python3:')?.level).toBe(FAIL)
    expect(line(r, 'python3:')?.title).toContain('not on PATH')
    expect(r.ok).toBe(false)
  })

  it('dist/: built when dist/index.html exists under the root it is told about', async () => {
    const home = installedHome()
    const root = tmp('doctor-root-')
    mkdirSync(join(root, 'hooks'))
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
    const unbuilt = (await runDoctor(await base(home, { root }))) as Report
    expect(line(unbuilt, 'dist/:')?.level).toBe(WARN)
    expect(line(unbuilt, 'dist/:')?.title).toContain('npm run build')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html>')
    const built = (await runDoctor(await base(home, { root }))) as Report
    expect(line(built, 'dist/:')?.level).toBe(PASS)
  })
})

describe('runDoctor against a running server', () => {
  let office: Office
  let port: number

  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
  })

  afterAll(async () => {
    office.server.app.locals.health.stop()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('reports the server, that no hook has reached it yet, and a missing token as a FAIL while it is up', async () => {
    const home = installedHome()
    const r = (await runDoctor(await base(home, { port }))) as Report
    const server = line(r, 'server:')!
    expect(server.level).toBe(PASS)
    expect(server.title).toMatch(new RegExp(`^server: v\\d+\\.\\d+\\.\\d+, up \\d+ s on :${port} — 0 session\\(s\\), 0 agent\\(s\\), 0 office window\\(s\\) connected`))
    expect(server.notes.join(' ')).toContain('no office window is connected')
    const hooks = line(r, 'hooks reaching the server:')!
    expect(hooks.level).toBe(WARN)
    expect(hooks.title).toContain('none since it started')
    // The server runs with its own AGENT_OFFICE_HOME (the test's temp dir), so this HOME has no token
    expect(line(r, 'token:')?.level).toBe(FAIL)
    expect(line(r, 'token:')?.title).toContain('although the server is up')
    expect(r.ok).toBe(false)
  })

  it('reports hooks reaching the server once an event has been accepted, and the token when it points at the right home', async () => {
    const home = installedHome()
    // start() writes the token once the port is bound; the test harness binds the port itself
    writeFileSync(office.server.TOKEN_FILE, `${office.server.AUTH_TOKEN}\n`, { mode: 0o600 })
    await postEvent(office.server, { type: 'session_started', sessionId: 's-doctor', project: 'office', cwd: '/tmp/office' })
    await postEvent(office.server, { type: 'agent_spawned', sessionId: 's-doctor', agent: { id: 'd-1', name: 'Debugger', role: 'debugger', task: 'look' } })
    const r = (await runDoctor(await base(home, { port, officeHome: office.dir }))) as Report
    expect(line(r, 'server:')?.title).toContain(`on :${port} — 1 session(s), 1 agent(s)`)
    const hooks = line(r, 'hooks reaching the server:')!
    expect(hooks.level).toBe(PASS)
    expect(hooks.title).toMatch(/^hooks reaching the server: 2 since it started, last \d+ s ago$/)
    expect(line(r, 'token:')).toEqual({ level: PASS, title: `token: ${office.server.TOKEN_FILE} (0600)`, notes: [] })
    // AGENT_OFFICE_UI_DIR is unset, so the server reports whatever this checkout's dist/ holds
    if (office.server.UI_AVAILABLE) expect(line(r, 'server: UI not built')).toBeUndefined()
    else expect(line(r, 'server: UI not built')?.level).toBe(WARN)
    expect(r.ok).toBe(true)
  })

  it('AGENT_OFFICE_PORT from the environment picks the server to probe', async () => {
    const home = installedHome()
    const r = (await runDoctor(await base(home, { port: undefined, officeHome: office.dir, env: { AGENT_OFFICE_PORT: String(port) } }))) as Report
    expect(line(r, 'server:')?.level).toBe(PASS)
    expect(r.context.port).toBe(port)
  })
})

// ---------------------------------------------------------------------------
// The script itself: output and exit code
// ---------------------------------------------------------------------------

describe('npm run doctor (the script)', () => {
  function run(home: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
    return spawnSync(process.execPath, [DOCTOR, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, AGENT_OFFICE_HOME: join(home, '.agent-office'), NO_COLOR: '1', ...extraEnv },
    })
  }

  it('prints a PASS/WARN/FAIL line per check, the commands, and exits 0 when nothing failed', async () => {
    const home = installedHome()
    const res = run(home, { AGENT_OFFICE_PORT: String(await freePort()) })
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/^Agent Office doctor/)
    expect(res.stdout).toMatch(/^  PASS  node v\d+/m)
    expect(res.stdout).toMatch(/^  PASS  hooks: 19\/19 events run /m)
    expect(res.stdout).toMatch(/^  WARN  server: nothing answers on http:\/\/127\.0\.0\.1:\d+\/health/m)
    expect(res.stdout).toContain(`  ${COMMANDS.install}`)
    expect(res.stdout).toContain(COMMANDS.uninstall)
    expect(res.stdout).toContain(COMMANDS.plugin)
    expect(res.stdout).toContain(COMMANDS.unplugin)
    expect(res.stdout).toContain(COMMANDS.start)
    expect(res.stdout).not.toContain('\x1b[')
  })

  it('exits 1 on a FAIL and says which lines to fix', async () => {
    const home = tmp('doctor-home-')
    const res = run(home, { AGENT_OFFICE_PORT: String(await freePort()) })
    expect(res.status).toBe(1)
    expect(res.stdout).toMatch(/^  FAIL  hooks: not installed/m)
    expect(res.stdout).toContain('fix the FAIL lines above')
  })

  it('--json prints the report as JSON (what the tests above see)', async () => {
    const home = installedHome()
    const res = run(home, { AGENT_OFFICE_PORT: String(await freePort()) }, ['--json'])
    expect(res.status).toBe(0)
    const report = JSON.parse(res.stdout) as Report
    expect(report.ok).toBe(true)
    expect(report.results.map(r => r.level)).toContain(PASS)
    expect(report.context).toMatchObject({ home, settingsPath: join(home, '.claude', 'settings.json') })
  })

  it('--help exits 0 without checking anything', () => {
    const res = run(tmp('doctor-home-'), {}, ['--help'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('Usage: npm run doctor')
  })
})
