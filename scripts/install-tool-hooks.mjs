#!/usr/bin/env node
/**
 * install-tool-hooks.mjs - connect another AI tool (Codex, Gemini CLI,
 * Antigravity, Kimi, OpenCode) to the office by editing that tool's own config.
 *
 *   node scripts/install-tool-hooks.mjs --tool <id>               connect
 *   node scripts/install-tool-hooks.mjs --uninstall --tool <id>   disconnect
 * (also `agent-office install-hooks --tool <id>` and
 * `npm run install-hooks -- --tool <id>`).
 *
 * Every tool but OpenCode gets hook entries that run
 *   python3 -I "<hooks dir>/office-relay.py" <tool> [<event>]
 * which forwards the raw payload to the office (hooks/office-relay.py).
 * OpenCode has no command hooks: it gets hooks/opencode-plugin.js copied into
 * its plugins folder.
 *
 * Safety rules (tests/install-tool-hooks.test.ts):
 *   - only our own entries are ever added or removed: hook commands that name
 *     office-relay.py, Antigravity's "claude-office" hook name, the Kimi block
 *     between the claude-office markers, the plugin file with our header;
 *   - before the first change to an existing file its original bytes are kept
 *     in <file>.claude-office.bak, and an uninstall that leaves the file as it
 *     was restores those exact bytes (a file we created is removed);
 *   - a symlinked config file is refused, never written through;
 *   - installing twice changes nothing.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const TOOL_IDS = Object.freeze(['codex', 'gemini', 'antigravity', 'kimi', 'opencode'])
const LABELS = { codex: 'Codex', gemini: 'Gemini CLI', antigravity: 'Antigravity', kimi: 'Kimi', opencode: 'OpenCode' }
const ISSUE = 'https://github.com/W17ant/Claude-Office/issues/115'
const RELAY = 'office-relay.py'
const AGY_NAME = 'claude-office'
const KIMI_START = '# >>> claude-office'
const KIMI_END = '# <<< claude-office'
const PLUGIN_MARK = "Claude Office's OpenCode plugin"
const BACKUP_SUFFIX = '.claude-office.bak'
const REPO_HOOKS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'hooks')

// Why these events: the ones each tool's translator (server/tools/<tool>.js) reads
const EVENTS = {
  codex: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'],
  gemini: ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification', 'PreCompress'],
  // Why flat vs grouped: agy's tool events take { matcher, hooks }, the others a plain handler list
  antigravity: { SessionStart: 'flat', PreInvocation: 'flat', PreToolUse: 'grouped', PostToolUse: 'grouped', Stop: 'flat' },
  kimi: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'Interrupt', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop'],
}
// Why 2 s (Gemini: 2000 ms): the relay gives up after 1.5 s; the tool's own cap is a backstop
const TIMEOUT_S = 2

// ── Where each tool keeps its config ────────────────────────────────────────

/** Does the tool look installed for this home? (its config folder exists) */
function toolPresent(tool, home) {
  switch (tool) {
    case 'codex': return existsSync(join(home, '.codex'))
    case 'gemini': return existsSync(join(home, '.gemini'))
    case 'antigravity': return existsSync(join(home, '.gemini', 'antigravity-cli')) || existsSync(join(home, '.gemini', 'config'))
    case 'kimi': return existsSync(join(home, '.kimi-code')) || existsSync(join(home, '.kimi'))
    case 'opencode': return existsSync(join(home, '.config', 'opencode'))
    default: return false
  }
}

/**
 * The config file install edits for a tool.
 * @param {string} tool  a TOOL_IDS id
 * @param {string} home  the home directory
 * @returns {string} absolute path
 */
export function targetFile(tool, home) {
  switch (tool) {
    case 'codex': return join(home, '.codex', 'hooks.json')
    case 'gemini': return join(home, '.gemini', 'settings.json')
    case 'antigravity': return join(home, '.gemini', 'config', 'hooks.json')
    // Why the fallback: older Kimi builds read ~/.kimi; use it only when it is the one that exists
    case 'kimi': return !existsSync(join(home, '.kimi-code')) && existsSync(join(home, '.kimi')) ? join(home, '.kimi', 'config.toml') : join(home, '.kimi-code', 'config.toml')
    case 'opencode': return join(home, '.config', 'opencode', 'plugins', 'claude-office.js')
    default: throw new Error(`Unknown tool: ${tool}`)
  }
}

// ── File helpers ────────────────────────────────────────────────────────────

function assertNotSymlink(file) {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symlink; refusing to write through it. Add the hooks by hand, or replace the link with a file.`)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/** Write via a temp file and rename (a half-written config would break the tool). */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.claude-office.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** Keep the original bytes once, before our first change to an existing file. */
function backupOnce(file, original) {
  if (original !== null && !existsSync(file + BACKUP_SUFFIX)) writeFileSync(file + BACKUP_SUFFIX, original)
}

function relayCommand(hooksDir, tool, event) {
  const relay = join(hooksDir, RELAY)
  // Why: the path goes into a shell command line inside JSON / TOML strings
  if (/["$`\\\n]/.test(relay)) throw new Error(`The hooks folder path ${hooksDir} has a character a hook command cannot carry (" $ \` \\ or a newline)`)
  return `python3 -I "${relay}" ${tool}${event ? ` ${event}` : ''}`
}

const isOurs = h => typeof h?.command === 'string' && h.command.includes(RELAY)

// ── JSON configs (Codex, Gemini, Antigravity) ───────────────────────────────

/** The config without any entry of ours. */
function stripJson(tool, cfg) {
  const out = structuredClone(cfg)
  if (tool === 'antigravity') {
    delete out[AGY_NAME]
    return out
  }
  if (!out.hooks || typeof out.hooks !== 'object') return out
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter(g => !(Array.isArray(g?.hooks) && g.hooks.some(isOurs)))
    if (kept.length === groups.length) continue
    if (kept.length) out.hooks[event] = kept
    else delete out.hooks[event]
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks
  return out
}

function addJson(tool, cfg, hooksDir) {
  const out = structuredClone(cfg)
  if (tool === 'antigravity') {
    const entry = {}
    for (const [event, shape] of Object.entries(EVENTS.antigravity)) {
      const handler = { type: 'command', command: relayCommand(hooksDir, tool, event), timeout: TIMEOUT_S }
      entry[event] = shape === 'grouped' ? [{ matcher: '', hooks: [handler] }] : [handler]
    }
    out[AGY_NAME] = entry
    return out
  }
  out.hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? out.hooks : {}
  for (const event of EVENTS[tool]) {
    const handler = tool === 'gemini'
      ? { name: 'claude-office', type: 'command', command: relayCommand(hooksDir, tool), timeout: TIMEOUT_S * 1000 }
      // Why async: the relay never decides anything, so Codex need not wait for it
      : { type: 'command', command: relayCommand(hooksDir, tool), timeout: TIMEOUT_S, async: true }
    out.hooks[event] = [...(Array.isArray(out.hooks[event]) ? out.hooks[event] : []), { hooks: [handler] }]
  }
  return out
}

function parseJson(text, file) {
  if (text === null || !text.trim()) return {}
  const cfg = JSON.parse(text)
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file} is not a JSON object; not touching it`)
  return cfg
}

function installJson(tool, file, hooksDir) {
  const original = readText(file)
  const cfg = parseJson(original, file)
  const next = JSON.stringify(addJson(tool, stripJson(tool, cfg), hooksDir), null, 2) + '\n'
  if (next === original) return []
  backupOnce(file, original)
  writeAtomic(file, next)
  return [file]
}

function uninstallJson(tool, file) {
  const current = readText(file)
  if (current === null) return []
  const cfg = parseJson(current, file)
  const stripped = stripJson(tool, cfg)
  if (isDeepStrictEqual(stripped, cfg)) return []
  const backup = readText(file + BACKUP_SUFFIX)
  if (backup !== null && isDeepStrictEqual(stripped, parseJson(backup, file))) {
    // Unchanged apart from us: put the original bytes back
    writeAtomic(file, backup)
  } else if (backup === null && Object.keys(stripped).length === 0) {
    unlinkSync(file)  // we created it
  } else {
    writeAtomic(file, JSON.stringify(stripped, null, 2) + '\n')
  }
  return [file]
}

// ── Kimi (TOML, edited as text between markers) ─────────────────────────────

function kimiBlock(hooksDir) {
  const command = JSON.stringify(relayCommand(hooksDir, 'kimi'))
  const tables = EVENTS.kimi.map(event => `[[hooks]]\nevent = "${event}"\ncommand = ${command}\ntimeout = ${TIMEOUT_S}\n`)
  return `${KIMI_START}\n${tables.join('\n')}${KIMI_END}\n`
}

/** Text without our block (and the newline we put before it). */
function stripKimi(text) {
  const start = text.indexOf(KIMI_START)
  if (start < 0) return text
  const endAt = text.indexOf(KIMI_END, start)
  if (endAt < 0) return text
  let end = endAt + KIMI_END.length
  if (text[end] === '\n') end++
  const from = start > 0 && text[start - 1] === '\n' ? start - 1 : start
  return text.slice(0, from) + text.slice(end)
}

function installKimi(file, hooksDir, notes) {
  const original = readText(file)
  const base = stripKimi(original ?? '')
  if (/^\s*hooks\s*=/m.test(base)) {
    // Why refuse: [[hooks]] tables next to an inline `hooks = [...]` make the file invalid and Kimi would not start
    notes.push(`${file} lists its hooks inline (hooks = [...]); adding [[hooks]] tables next to that would break the file. Add these by hand, in the same style:\n${kimiBlock(hooksDir)}`)
    return []
  }
  const next = (base === '' ? '' : `${base}\n`) + kimiBlock(hooksDir)
  if (next === original) return []
  backupOnce(file, original)
  writeAtomic(file, next)
  return [file]
}

function uninstallKimi(file) {
  const current = readText(file)
  if (current === null || !current.includes(KIMI_START)) return []
  const next = stripKimi(current)
  if (next === '' && !existsSync(file + BACKUP_SUFFIX)) unlinkSync(file)
  else writeAtomic(file, next)
  return [file]
}

// ── OpenCode (a plugin file) ────────────────────────────────────────────────

function installOpencode(file, hooksDir, notes) {
  const source = [join(hooksDir, 'opencode-plugin.js'), join(REPO_HOOKS, 'opencode-plugin.js')].find(existsSync)
  if (!source) throw new Error(`opencode-plugin.js not found in ${hooksDir}`)
  const plugin = readFileSync(source, 'utf8')
  const current = readText(file)
  if (current !== null && !current.includes(PLUGIN_MARK)) {
    notes.push(`${file} exists and is not ours; left alone.`)
    return []
  }
  if (current === plugin) return []
  writeAtomic(file, plugin)
  return [file]
}

function uninstallOpencode(file) {
  const current = readText(file)
  if (current === null || !current.includes(PLUGIN_MARK)) return []
  unlinkSync(file)
  return [file]
}

// ── Public API ──────────────────────────────────────────────────────────────

function checkTool(tool) {
  if (!TOOL_IDS.includes(tool)) throw new Error(`Unknown tool: ${tool}. Use one of: ${TOOL_IDS.join(', ')}`)
}

/**
 * Connect a tool to the office.
 * @param {string} tool  a TOOL_IDS id
 * @param {{ home?: string, hooksDir: string }} opts  hooksDir holds office-relay.py / opencode-plugin.js
 * @returns {{ changed: string[], notes: string[] }} files written, and what to tell the person
 */
export function install(tool, { home = homedir(), hooksDir }) {
  checkTool(tool)
  const file = targetFile(tool, home)
  assertNotSymlink(file)
  const notes = []
  let changed
  if (tool === 'kimi') changed = installKimi(file, hooksDir, notes)
  else if (tool === 'opencode') changed = installOpencode(file, hooksDir, notes)
  else changed = installJson(tool, file, hooksDir)
  if (tool === 'codex') {
    notes.push('Codex runs a new hook only after you approve it: start codex and type /hooks once.')
  } else {
    notes.push(`${LABELS[tool]} support is experimental — tell us if it works: ${ISSUE}`)
  }
  notes.push(`Restart any open ${LABELS[tool]} session to pick it up.`)
  return { changed, notes }
}

/**
 * Disconnect a tool: remove only what install added.
 * @param {string} tool  a TOOL_IDS id
 * @param {{ home?: string }} [opts]
 * @returns {{ changed: string[], notes: string[] }}
 */
export function uninstall(tool, { home = homedir() } = {}) {
  checkTool(tool)
  const file = targetFile(tool, home)
  assertNotSymlink(file)
  let changed
  if (tool === 'kimi') changed = uninstallKimi(file)
  else if (tool === 'opencode') changed = uninstallOpencode(file)
  else changed = uninstallJson(tool, file)
  return { changed, notes: changed.length ? [] : [`${LABELS[tool]} was not connected; nothing to remove.`] }
}

/**
 * Is a tool connected?
 * @param {string} tool  a TOOL_IDS id
 * @param {{ home?: string }} [opts]
 * @returns {'connected' | 'not-connected' | 'not-installed'}
 */
export function status(tool, { home = homedir() } = {}) {
  checkTool(tool)
  if (!toolPresent(tool, home)) return 'not-installed'
  const text = readText(targetFile(tool, home))
  if (text === null) return 'not-connected'
  if (tool === 'kimi') return text.includes(KIMI_START) ? 'connected' : 'not-connected'
  if (tool === 'opencode') return text.includes(PLUGIN_MARK) ? 'connected' : 'not-connected'
  try {
    const cfg = parseJson(text, '')
    return isDeepStrictEqual(stripJson(tool, cfg), cfg) ? 'not-connected' : 'connected'
  } catch {
    return 'not-connected'
  }
}

/** A tool's display name. */
export function toolLabel(tool) {
  return LABELS[tool] ?? tool
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Run from the command line: [--uninstall] --tool <id> [--hooks-dir <dir>].
 * @returns {number} exit code
 */
export function main(argv, { out = process.stdout, err = process.stderr, home = homedir(), hooksDir = REPO_HOOKS } = {}) {
  let tool
  let remove = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--uninstall') remove = true
    else if (a === '--tool') tool = argv[++i]
    else if (a.startsWith('--tool=')) tool = a.slice('--tool='.length)
    else if (a === '--hooks-dir') hooksDir = argv[++i]
  }
  if (!tool || !TOOL_IDS.includes(tool)) {
    err.write(`--tool needs one of: ${TOOL_IDS.join(', ')}\n`)
    return 2
  }
  try {
    if (!remove && !toolPresent(tool, home)) {
      out.write(`${toolLabel(tool)} does not look installed here (no config folder found); connecting anyway.\n`)
    }
    const { changed, notes } = remove ? uninstall(tool, { home }) : install(tool, { home, hooksDir })
    for (const f of changed) out.write(`${remove ? 'Removed the office from' : 'Connected the office in'} ${f}\n`)
    if (!changed.length && !remove) out.write(`${toolLabel(tool)} was already connected.\n`)
    for (const n of notes) out.write(`${n}\n`)
    return 0
  } catch (e) {
    err.write(`${e.message}\n`)
    return 1
  }
}

let isMain = false
try { isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] } catch {}
if (isMain) process.exit(main(process.argv.slice(2)))
