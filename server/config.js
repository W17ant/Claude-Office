/**
 * config.js — the server's runtime configuration: the port and host it binds
 * (from the environment) and office.config.json (the boss character).
 *
 *   AGENT_OFFICE_PORT     the port, default 3334. The hook, the status line,
 *                         the office scripts, the Vite dev server and the
 *                         desktop app all read the same variable, so one
 *                         export in a shell moves the whole office.
 *   AGENT_OFFICE_UI_PORT  the Vite dev server's port, default 3333 — only the
 *                         origin allowlist needs it (start-office.sh passes it
 *                         to `vite --port`).
 *   AGENT_OFFICE_HOST     the bind address, loopback only (see readHost).
 *
 * office.config.json lives next to package.json. Until now Vite baked it
 * into the bundle, so renaming the boss meant a rebuild; the server now reads
 * it at request time (GET /config) and the page applies it on load, keeping
 * the bundled value as the fallback for ?sim and a server that is down.
 *
 * Everything here is pure (env and paths come in as arguments) so
 * tests/config.test.ts covers it without starting a server.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export const DEFAULT_PORT = 3334
export const DEFAULT_UI_PORT = 3333
export const DEFAULT_HOST = '127.0.0.1'
export const CONFIG_FILE_NAME = 'office.config.json'

/** The bind addresses the office accepts: every spelling of loopback. */
export const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** The boss without an office.config.json (the same defaults as src/config.ts). */
export const DEFAULT_BOSS = Object.freeze({
  name: 'Boss',
  sprite: 'Me-1',
  color: '#ff4444',
  emoji: '👑',
})

/** A TCP port from an env string, or null when it is not one. */
function parsePort(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

/**
 * The port to bind: AGENT_OFFICE_PORT, or 3334 when it is unset. A value
 * that is not a port (letters, 0, 70000) falls back to 3334 with a warning
 * rather than failing: the hook and the scripts parse the same variable
 * with the same fallback, so everything still meets on one port.
 */
export function readPort(env = process.env, log = console) {
  return readPortVar(env, 'AGENT_OFFICE_PORT', DEFAULT_PORT, log)
}

/** The Vite dev server's port, AGENT_OFFICE_UI_PORT, default 3333. */
export function readUiPort(env = process.env, log = console) {
  return readPortVar(env, 'AGENT_OFFICE_UI_PORT', DEFAULT_UI_PORT, log)
}

function readPortVar(env, name, fallback, log) {
  const raw = env?.[name]
  if (raw === undefined || raw === '') return fallback
  const port = parsePort(raw)
  if (port === null) {
    log?.warn?.(`[config] ${name}=${JSON.stringify(raw)} is not a port (1-65535); using ${fallback}`)
    return fallback
  }
  return port
}

/**
 * The address to bind: AGENT_OFFICE_HOST when it is a loopback form
 * (127.0.0.1, localhost, ::1), else 127.0.0.1.
 *
 * Anything else is refused on purpose, not merely unsupported. The threat
 * model in server/index.js keeps every GET, POST /chat and the WebSocket
 * open on loopback: the office page has no token, and on this machine the
 * worst a local process can do with them is read what the office already
 * shows. On a LAN address those same routes would hand the boss's prompts,
 * Claude's replies and every agent's task to anyone on the network. The UI
 * token (#31) covers only POST /permission/:id and POST /settings; it would
 * have to cover every route before a non-loopback bind is safe, so until
 * then the request is logged with the reason and the server binds loopback.
 */
export function readHost(env = process.env, log = console) {
  const raw = env?.AGENT_OFFICE_HOST
  if (raw === undefined || typeof raw !== 'string' || raw.trim() === '') return DEFAULT_HOST
  const host = raw.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (LOOPBACK_BIND_HOSTS.has(host)) return host
  log?.error?.(
    `[config] AGENT_OFFICE_HOST=${JSON.stringify(raw)} refused: the office binds loopback only ` +
    `(127.0.0.1, localhost or ::1). Every GET, POST /chat and the WebSocket are open on loopback by design ` +
    `(the office page has no token), so a non-loopback bind would expose your prompts, Claude's replies and ` +
    `the agents' tasks to the network; the UI token work would have to cover every route first. Binding ${DEFAULT_HOST}.`,
  )
  return DEFAULT_HOST
}

/**
 * office.config.json from `rootDir` (the directory holding package.json):
 * { config, file } where `file` is the path that was read, or null when the
 * file is missing, unreadable, not JSON or not an object (then `config` is
 * {}). Nothing in it is trusted beyond that; bossFromConfig picks the fields
 * it knows.
 */
export function loadOfficeConfig(rootDir, log = console) {
  const file = join(rootDir, CONFIG_FILE_NAME)
  if (!existsSync(file)) return { config: {}, file: null }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { config: parsed, file }
    log?.warn?.(`[config] ${file} is not a JSON object; using the default boss`)
  } catch (err) {
    log?.warn?.(`[config] ${file} could not be read (${err.message}); using the default boss`)
  }
  return { config: {}, file: null }
}

/** The parsed office.config.json in `rootDir`, {} when there is none. */
export function readOfficeConfig(rootDir, log = console) {
  return loadOfficeConfig(rootDir, log).config
}

/** A non-empty string field, trimmed and capped; undefined for anything else. */
function textField(value, max = 120) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text ? text.slice(0, max) : undefined
}

/**
 * The boss as the page should show it: the file's `boss` fields (strings
 * only; empty or non-string values are ignored) over DEFAULT_BOSS.
 * @param {object} [config] the parsed office.config.json
 */
export function bossFromConfig(config = {}) {
  const boss = config && typeof config.boss === 'object' && config.boss !== null ? config.boss : {}
  return {
    name:   textField(boss.name)   ?? DEFAULT_BOSS.name,
    sprite: textField(boss.sprite) ?? DEFAULT_BOSS.sprite,
    color:  textField(boss.color, 32)  ?? DEFAULT_BOSS.color,
    emoji:  textField(boss.emoji, 16)  ?? DEFAULT_BOSS.emoji,
  }
}
