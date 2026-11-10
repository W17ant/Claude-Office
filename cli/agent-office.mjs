#!/usr/bin/env node
/**
 * agent-office.mjs - the `npx @w17ant/agent-office` command: run the office without a checkout.
 *
 *   agent-office [start]          serve the built UI + server from this package
 *                                 and open the office link (the default)
 *     --detach, -d                run the server in the background (log in
 *                                 $AGENT_OFFICE_HOME/server.log) and return
 *     --no-open                   print the link, open no browser
 *   agent-office open [--print]   open (or print) the office link again
 *   agent-office stop [--force]   stop the server `start` (or start-office.sh) began
 *   agent-office install-hooks    register the hooks + status line in ~/.claude/settings.json
 *   agent-office uninstall-hooks  take them back out
 *     (both take --no-status-line | --status-line-only, as hooks/install-hooks.sh does)
 *   agent-office doctor [--json] [--no-color]
 *   agent-office --version | --help
 *   --port <n> on any command sets AGENT_OFFICE_PORT for it
 *
 * Where the hooks live (resolveHooksDir): npx unpacks the package into a
 * cache (~/.npm/_npx/<hash>/node_modules/...) that npm may delete at any time,
 * and a later npx run of a newer version lands in a different directory. A
 * hook command pointing there would turn into a "file not found" error on
 * every Claude Code tool call the day the cache is cleaned. So outside a git
 * checkout, install-hooks copies hooks/ to $AGENT_OFFICE_HOME/hooks
 * (~/.agent-office/hooks, the office's own state dir, which already holds the
 * token and chat.db) and runs the installer from that copy: settings.json
 * then names a path that outlives the cache, and re-running install-hooks
 * from a newer version refreshes the copy in place. From a checkout the
 * hooks stay where they are, exactly like `npm run install-hooks`.
 *
 * Everything here is macOS / Linux (bash, python3 and curl run the hooks);
 * the server needs Node 20+ (better-sqlite3 12; 22+ gets a prebuilt binary,
 * 20 compiles it from source since better-sqlite3 12.10).
 *
 * Why cli/ and not bin/: the repository root is also the Claude Code plugin
 * root, and a plugin's bin/ is put on the Bash tool's PATH in every session
 * the plugin is enabled in (tests/plugin.test.ts keeps bin/ out). npm does
 * not care where package.json's "bin" points.
 *
 * `parseArgs`, `resolveHooksDir`, `copyHooks` and `main` are exported for
 * tests/cli.test.ts; the module only runs when executed as the bin.
 */

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openOffice } from '../scripts/open-office.mjs'
import { COMMANDS as CHECKOUT_COMMANDS, formatReport, MIN_NODE_MAJOR, runDoctor } from '../scripts/doctor.mjs'
import { readPort } from '../server/config.js'

/** The package root: the directory holding package.json, server/, dist/ and hooks/. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The files install-hooks copies out of the package. agent-tracker.sh runs
 * agent-tracker.py from its own directory; the installer reads nothing else
 * from hooks/, and hooks.json is kept so doctor can list the expected events.
 */
export const HOOK_FILES = ['agent-tracker.sh', 'agent-tracker.py', 'status-line.sh', 'install-hooks.sh', 'hooks.json']

/** Flags each command accepts (besides the global --port, --help and --version). */
export const COMMAND_FLAGS = {
  start: ['--detach', '-d', '--no-open'],
  open: ['--print'],
  stop: ['--force', '-f'],
  'install-hooks': ['--no-status-line', '--status-line-only'],
  'uninstall-hooks': ['--no-status-line', '--status-line-only'],
  doctor: ['--json', '--no-color'],
}

// Why 15 s: the first start on a cold machine opens (and may create) chat.db
// and loads better-sqlite3's native binding; 15 s is far past that and still
// short enough that a server stuck on something else is reported promptly.
const HEALTH_WAIT_MS = 15_000
// Why 200 ms: a local /health answers in a few ms; polling 5x a second keeps
// the wait short without spinning
const HEALTH_POLL_MS = 200
// Why 1 s: a loopback probe either answers at once or nothing is listening
const PROBE_TIMEOUT_MS = 1_000
// Why 5 s: the server's SIGTERM handler exits at once; this is only the
// backstop before SIGKILL when it is wedged
const STOP_GRACE_MS = 5_000

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Parse the command line (process.argv.slice(2)).
 * @param {string[]} argv
 * @returns {{ command: string, flags: Set<string>, port?: number, error?: string }}
 *   command is a COMMAND_FLAGS key, 'help' or 'version'; error is set (and
 *   should be printed with the usage, exit 2) when the line is not valid.
 */
export function parseArgs(argv) {
  const flags = new Set()
  const positional = []
  let port
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      const n = /^\d{1,5}$/.test(raw ?? '') ? Number(raw) : NaN
      if (!(n >= 1 && n <= 65535)) return { command: 'help', flags, error: `--port needs a port number (1-65535), got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}` }
      port = n
    } else if (arg.startsWith('-')) {
      flags.add(arg)
    } else {
      positional.push(arg)
    }
  }
  // --help and --version win over everything else, as in most CLIs
  if (flags.has('--help') || flags.has('-h') || positional[0] === 'help') return { command: 'help', flags, port }
  if (flags.has('--version') || flags.has('-v') || flags.has('-V')) return { command: 'version', flags, port }

  const command = positional[0] ?? 'start'
  if (!Object.hasOwn(COMMAND_FLAGS, command)) return { command: 'help', flags, port, error: `Unknown command: ${command}` }
  if (positional.length > 1) return { command, flags, port, error: `Unexpected argument: ${positional[1]}` }
  const unknown = [...flags].find(f => !COMMAND_FLAGS[command].includes(f))
  if (unknown) return { command, flags, port, error: `Unknown option for ${command}: ${unknown}` }
  if (flags.has('--no-status-line') && flags.has('--status-line-only')) {
    return { command, flags, port, error: '--no-status-line and --status-line-only together leave nothing to do' }
  }
  return { command, flags, port }
}

/** The usage text; `bin` is how the user runs this command (npx <name>). */
export function usage(bin) {
  return `Usage: ${bin} [command] [options]

Commands:
  start               serve the office (server + built UI) and open it (default)
      --detach, -d      run in the background; stop it with: ${bin} stop
      --no-open         print the office link, open no browser
  open [--print]      open the office link again (another browser), or print it
  stop [--force]      stop the office server; --force also kills whatever
                      listens on the office ports
  install-hooks       connect Claude Code: hooks + status line in settings.json
  uninstall-hooks     take them back out
      --no-status-line | --status-line-only   (either command)
  doctor [--json]     check node, hooks, status line, tools, server and token

Options:
  --port <n>          the office port (default 3334, or AGENT_OFFICE_PORT)
  -h, --help          this text
  -v, --version       the version

Environment: AGENT_OFFICE_PORT, AGENT_OFFICE_HOME (default ~/.agent-office),
CLAUDE_CONFIG_DIR (default ~/.claude). Needs Node ${MIN_NODE_MAJOR}+, bash, python3 and curl.`
}

// ---------------------------------------------------------------------------
// Where the hooks live
// ---------------------------------------------------------------------------

/**
 * Is `root` a git checkout of the project (as opposed to an installed
 * package)? A checkout has .git (a directory, or a file in a worktree) and
 * does not sit under node_modules: an npm-installed copy never carries .git.
 */
export function isCheckout(root, exists = existsSync) {
  return exists(join(root, '.git')) && !root.split(sep).includes('node_modules')
}

/**
 * Which hooks/ directory settings.json should point at.
 * @param {{ root: string, officeHome: string, exists?: (p: string) => boolean }} opts
 * @returns {{ dir: string, copy: boolean }} copy is true when the package's
 *   hooks must first be copied to `dir` ($AGENT_OFFICE_HOME/hooks), because
 *   the package itself lives somewhere that can disappear (the npx cache, a
 *   global install that is later removed or upgraded).
 */
export function resolveHooksDir({ root, officeHome, exists = existsSync }) {
  if (isCheckout(root, exists)) return { dir: join(root, 'hooks'), copy: false }
  return { dir: join(officeHome, 'hooks'), copy: true }
}

/**
 * Copy HOOK_FILES from `srcDir` to `destDir`, each through a temp file and a
 * rename. Why: Claude Code may run agent-tracker.sh at any moment; a rename
 * swaps the file whole, so a hook never reads a half-written script.
 * @returns {string[]} the paths written
 */
export function copyHooks(srcDir, destDir) {
  // 0700 like the rest of $AGENT_OFFICE_HOME (the server tightens it too)
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const written = []
  for (const name of HOOK_FILES) {
    const dest = join(destDir, name)
    const tmp = join(destDir, `.${name}.${process.pid}.tmp`)
    writeFileSync(tmp, readFileSync(join(srcDir, name)))
    chmodSync(tmp, name.endsWith('.sh') ? 0o755 : 0o644)
    renameSync(tmp, dest)
    written.push(dest)
  }
  return written
}

/** The fix commands doctor names, spelled for this package run through npx. */
export function npxCommands(bin) {
  return {
    ...CHECKOUT_COMMANDS,
    install: `${bin} install-hooks`,
    hooksOnly: `${bin} install-hooks --no-status-line`,
    statusLine: `${bin} install-hooks --status-line-only`,
    uninstall: `${bin} uninstall-hooks`,
    uninstallHooks: `${bin} uninstall-hooks --no-status-line`,
    start: bin,
    startAlt: `${bin} start --detach`,
    dev: null,
    open: `${bin} open`,
    distMissing: 'this install has no dist/ — reinstall the package',
    restoreHooks: `${bin} install-hooks copies it back`,
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function readPackage(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Does anything answer /health on `port`? (Who it is, openOffice checks.) */
async function answers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Remove the pid file if it still names `pid` (a newer start may have replaced it). */
function dropPidFile(file, pid) {
  try {
    if (readFileSync(file, 'utf8').trim() === String(pid)) unlinkSync(file)
  } catch {
    // already gone
  }
}

async function start(ctx, { detach, open }) {
  const { root, env, out, err, bin } = ctx
  const port = readPort(env, { warn: m => err.write(`${m}\n`) })
  const uiDir = env.AGENT_OFFICE_UI_DIR || join(root, 'dist')
  if (!existsSync(join(uiDir, 'index.html'))) {
    err.write(`The office UI is not built: ${join(uiDir, 'index.html')} is missing.\n`)
    err.write(isCheckout(root) ? 'Run npm run build first (or bash scripts/start-office.sh for the Vite dev server).\n' : 'This install of the package is incomplete; reinstall it.\n')
    return 1
  }

  // Already running (this office, or another one on the port): openOffice
  // proves it holds our token before it prints or opens anything
  if (await answers(port)) {
    out.write(`An office is already answering on port ${port}.\n`)
    return openOffice({ env, print: !open, out, err })
  }

  mkdirSync(ctx.officeHome, { recursive: true, mode: 0o700 })
  const serverEnv = { ...env }
  // Why: office.config.json (the boss character) normally sits next to
  // package.json; in an npx cache that is no place to edit, so a published
  // install reads it from $AGENT_OFFICE_HOME instead
  if (!isCheckout(root) && !serverEnv.AGENT_OFFICE_CONFIG_DIR) serverEnv.AGENT_OFFICE_CONFIG_DIR = ctx.officeHome

  const logFile = join(ctx.officeHome, 'server.log')
  let logFd = null
  if (detach) {
    // The server prints the tokened office link, so the log is as private
    // as the token file: 0600 in the 0700 state dir
    logFd = openSync(logFile, 'a', 0o600)
    chmodSync(logFile, 0o600)
  }
  // detached: its own process group, as start-office.sh gives the server, so
  // stop-office.sh can signal the group and a terminal Ctrl+C reaches only
  // this CLI, which then stops the server itself
  const child = spawn(process.execPath, [join(root, 'server', 'index.js')], {
    env: serverEnv,
    stdio: ['ignore', detach ? logFd : 'inherit', detach ? logFd : 'inherit'],
    detached: true,
  })
  if (logFd !== null) closeSync(logFd)
  const pidFile = join(ctx.officeHome, 'server.pid')
  writeFileSync(pidFile, `${child.pid}\n`)

  let exited = null
  const exitedPromise = new Promise(res => child.once('exit', (code, signal) => { exited = { code, signal }; res(exited) }))
  child.once('error', e => { err.write(`Could not start the server: ${e.message}\n`); exited = { code: 1 } })

  const deadline = Date.now() + HEALTH_WAIT_MS
  let up = false
  while (!exited && Date.now() < deadline) {
    if (await answers(port)) { up = true; break }
    await sleep(HEALTH_POLL_MS)
  }
  if (!up) {
    if (!exited) { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ } }
    dropPidFile(pidFile, child.pid)
    err.write(exited
      ? `The office server exited during start (code ${exited.code ?? exited.signal})${detach ? ` — see ${logFile}` : ''}.\n`
      : `The office server did not answer on port ${port} within ${HEALTH_WAIT_MS / 1000}s; stopped it.\n`)
    return 1
  }

  await openOffice({ env, print: !open, out, err })

  if (detach) {
    child.unref()
    out.write(`The office runs in the background (pid ${child.pid}, log ${logFile}).\nStop it with: ${bin} stop\n`)
    return 0
  }

  out.write('Press Ctrl+C to stop the office.\n')
  const stopChild = () => {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ } }, STOP_GRACE_MS).unref()
  }
  let interrupted = false
  const onSignal = () => { interrupted = true; out.write('\nStopping the office...\n'); stopChild() }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const result = await exitedPromise
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  dropPidFile(pidFile, child.pid)
  if (interrupted) return 130
  // Stopped from elsewhere (agent-office stop) is a normal end
  return result.signal ? 0 : (result.code ?? 0)
}

/** Run a bundled bash script with output passed through to out / err. */
function runBash(ctx, script, args, extraEnv = {}) {
  const res = spawnSync('bash', [script, ...args], { env: { ...ctx.env, ...extraEnv }, encoding: 'utf8' })
  if (res.stdout) ctx.out.write(res.stdout)
  if (res.stderr) ctx.err.write(res.stderr)
  if (res.error) {
    ctx.err.write(`Could not run bash: ${res.error.message}\n`)
    return 1
  }
  return res.status ?? 1
}

function installHooks(ctx, args) {
  const { dir, copy } = resolveHooksDir({ root: ctx.root, officeHome: ctx.officeHome })
  if (copy) {
    copyHooks(join(ctx.root, 'hooks'), dir)
    ctx.out.write(`Copied the hook scripts to ${dir} (a path that outlives the npx cache).\n`)
  }
  return runBash(ctx, join(dir, 'install-hooks.sh'), args, copy ? { AGENT_OFFICE_START_HINT: ctx.bin } : {})
}

function uninstallHooks(ctx, args) {
  const { dir, copy } = resolveHooksDir({ root: ctx.root, officeHome: ctx.officeHome })
  // The copy's installer when there is one: the same version that installed
  const installer = existsSync(join(dir, 'install-hooks.sh')) ? join(dir, 'install-hooks.sh') : join(ctx.root, 'hooks', 'install-hooks.sh')
  const code = runBash(ctx, installer, ['--uninstall', ...args])
  // A full uninstall leaves nothing that runs the copy; a partial one
  // (--no-status-line / --status-line-only) still does, so keep it then
  if (code === 0 && copy && args.length === 0 && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    ctx.out.write(`Removed the hook scripts in ${dir}.\n`)
  }
  return code
}

async function doctor(ctx, flags) {
  const { dir, copy } = resolveHooksDir({ root: ctx.root, officeHome: ctx.officeHome })
  const report = await runDoctor({ env: ctx.env, root: ctx.root, hooksDir: dir, commands: copy ? npxCommands(ctx.bin) : CHECKOUT_COMMANDS })
  if (flags.has('--json')) {
    ctx.out.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const color = !!ctx.out.isTTY && !ctx.env.NO_COLOR && !flags.has('--no-color')
    ctx.out.write(`${formatReport(report, { color }).join('\n')}\n`)
  }
  return report.ok ? 0 : 1
}

/**
 * Run one command line. Returns the exit code.
 * @param {string[]} argv the arguments after the program name
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, out?: NodeJS.WritableStream, err?: NodeJS.WritableStream }} [opts]
 *   root overrides the package root (tests run a copy of the package from a temp dir)
 */
export async function main(argv, { root = PACKAGE_ROOT, env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const pkg = readPackage(root)
  const bin = `npx ${pkg.name ?? 'agent-office'}`
  const parsed = parseArgs(argv)
  if (parsed.error) {
    err.write(`${parsed.error}\n\n${usage(bin)}\n`)
    return 2
  }
  if (parsed.command === 'help') { out.write(`${usage(bin)}\n`); return 0 }
  if (parsed.command === 'version') { out.write(`${pkg.version ?? 'unknown'}\n`); return 0 }

  const major = Number(process.versions.node.split('.')[0])
  if (major < MIN_NODE_MAJOR) {
    err.write(`Agent Office needs Node ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node}): the server's SQLite binding has no build for older versions.\n`)
    return 1
  }

  const runEnv = parsed.port ? { ...env, AGENT_OFFICE_PORT: String(parsed.port) } : env
  const officeHome = runEnv.AGENT_OFFICE_HOME || join(runEnv.HOME || homedir(), '.agent-office')
  const ctx = { root, env: runEnv, out, err, bin, officeHome }
  const flags = parsed.flags

  switch (parsed.command) {
    case 'start':
      return start(ctx, { detach: flags.has('--detach') || flags.has('-d'), open: !flags.has('--no-open') })
    case 'open':
      return openOffice({ env: runEnv, print: flags.has('--print'), out, err })
    case 'stop':
      return runBash(ctx, join(root, 'scripts', 'stop-office.sh'), flags.has('--force') || flags.has('-f') ? ['--force'] : [])
    case 'install-hooks':
      return installHooks(ctx, [...flags])
    case 'uninstall-hooks':
      return uninstallHooks(ctx, [...flags])
    case 'doctor':
      return doctor(ctx, flags)
  }
  return 2
}

function isMainModule() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => {
    process.stderr.write(`${e?.stack ?? e}\n`)
    process.exit(1)
  })
}
