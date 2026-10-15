/**
 * config.ts — shared configuration constants
 *
 * The boss (you) comes from office.config.json in the project root: name,
 * sprite, colour and emoji. Two copies of that file reach the page:
 *
 *   build time  Vite bundles it through import.meta.glob below, so the
 *               defaults the page starts with are whatever the file said
 *               when `vite build` ran — or 'Boss' / 'Me-1' when it did not
 *               exist. This is all ?sim / ?video ever see, and what the page
 *               shows when the server is unreachable.
 *   run time    The server reads the same file on every GET /config
 *               (server/config.js). loadRuntimeConfig() fetches it before
 *               the first render (src/main.tsx) and applies it, so renaming
 *               the boss no longer needs a rebuild — only a reload.
 *
 * The exports are live bindings (`export let`) and the derived records are
 * mutated in place, so every module that imported them sees the runtime
 * values: BOSS_CONFIG is the very object AGENT_CONFIGS['boss'] holds
 * (src/types.ts) and ROLE_TO_CHAR['boss'] is rewritten here. Modules must
 * not copy these values at import time; the one that does, BOSS_ID in
 * src/officeReducer.ts (an internal id, never shown), keeps the build-time
 * name.
 */

import { officeHttpBase } from './serverUrl'

// Shape of the optional office.config.json
type UserConfig = { boss?: { name?: string; sprite?: string; color?: string; emoji?: string } }

/** The boss fields GET /config returns (server/config.js bossFromConfig). */
export interface BossConfig { name: string; sprite: string; color: string; emoji: string }

// Load user config (office.config.json) — bundled by Vite.
// import.meta.glob is resolved at build time and yields {} when the file is
// missing, so no top-level await is needed (the build target rejects it).
const userConfigModules = import.meta.glob<UserConfig>('../office.config.json', { eager: true, import: 'default' })
const userConfig: UserConfig = Object.values(userConfigModules)[0] ?? {}

const bossName   = userConfig.boss?.name   ?? 'Boss'
const bossSprite = userConfig.boss?.sprite ?? 'Me-1'
const bossColor  = userConfig.boss?.color  ?? '#ff4444'
const bossEmoji  = userConfig.boss?.emoji  ?? '👑'

// The boss — always in the office. `let`: loadRuntimeConfig rebinds them.
export let BOSS_CHAR = bossSprite
export const BOSS_ROLE = 'boss'
export let BOSS_NAME = bossName
export let BOSS_COLOR = bossColor
export let BOSS_EMOJI = bossEmoji

/**
 * The boss's AGENT_CONFIGS entry, shared by reference with src/types.ts so
 * that a runtime update here is an update there.
 */
export const BOSS_CONFIG: { color: string; emoji: string; title: string } = { color: bossColor, emoji: bossEmoji, title: bossName }

/** The values the bundle was built with (what applyBossConfig falls back to). */
export const BUILD_TIME_BOSS: Readonly<BossConfig> = Object.freeze({ name: bossName, sprite: bossSprite, color: bossColor, emoji: bossEmoji })

// Map agent roles to character sprite base names (in /sprites/characters/)
export const ROLE_TO_CHAR: Record<string, string> = {
  'boss':                  bossSprite,
  'assistant':             'Claude-1',
  'debugger':              'dev-1',
  'code-reviewer':         'employee-1',
  'frontend-developer':    'Frontend-dev-1',
  'fullstack-developer':   'dev-2',
  'test-engineer':         'employee-2',
  'security-auditor':      'security-audit-1',
  'devops-engineer':       'employee-3',
  'architect-reviewer':    'employee-1',
  'performance-engineer':  'employee-2',
  'database-architect':    'employee-3',
  'typescript-pro':        'employee-1',
  'ai-engineer':           'dev-2',
  'prompt-engineer':       'dev-2',
  'general-purpose':       'employee-3',
  'Explore':               'explore-1',
  // MCPs
  'github':                'employee-3',
  'supabase':              'Frontend-dev-1',
  'playwright':            'employee-2',
  'chrome':                'employee-1',
  'memory':                'dev-2',
  'seo':                   'Frontend-dev-1',
  'gmail':                 'dev-1',
  'ios-simulator':         'security-audit-1',
}

/** A non-empty string, else undefined (the server already trims and caps). */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Make `boss` the boss: rebind the exports and update the shared records in
 * place. Missing or non-string fields keep their current value.
 */
export function applyBossConfig(boss: Partial<BossConfig> | null | undefined): BossConfig {
  if (boss && typeof boss === 'object') {
    BOSS_NAME  = text(boss.name)   ?? BOSS_NAME
    BOSS_CHAR  = text(boss.sprite) ?? BOSS_CHAR
    BOSS_COLOR = text(boss.color)  ?? BOSS_COLOR
    BOSS_EMOJI = text(boss.emoji)  ?? BOSS_EMOJI
  }
  BOSS_CONFIG.title = BOSS_NAME
  BOSS_CONFIG.color = BOSS_COLOR
  BOSS_CONFIG.emoji = BOSS_EMOJI
  ROLE_TO_CHAR[BOSS_ROLE] = BOSS_CHAR
  return { name: BOSS_NAME, sprite: BOSS_CHAR, color: BOSS_COLOR, emoji: BOSS_EMOJI }
}

/** The GET /config body (server/index.js). */
export interface RuntimeConfig {
  port: number
  host: string
  boss: BossConfig
  /** The office.config.json the server read, or null when it has none (then `boss` is all defaults) */
  configFile: string | null
  version: string
}

export interface LoadRuntimeConfigOptions {
  fetchImpl?: typeof fetch
  /** The server's http origin; defaults to where the page was loaded from (src/serverUrl.ts) */
  base?: string
  /** How long to wait for the server before rendering with the build-time boss */
  timeoutMs?: number
}

/**
 * Fetch GET /config and apply its boss. Resolves to the config when the
 * server answered, null when it did not (down, slow, wrong shape) — the
 * page then keeps the build-time values and renders anyway. A server with
 * no office.config.json (`configFile` null) answers with the defaults; those
 * are not applied either, so a bundle built with a config keeps showing it
 * (the packaged app ships the bundle without the file).
 */
export async function loadRuntimeConfig({
  fetchImpl = globalThis.fetch,
  base = officeHttpBase(),
  timeoutMs = 1500,
}: LoadRuntimeConfigOptions = {}): Promise<RuntimeConfig | null> {
  if (typeof fetchImpl !== 'function') return null
  try {
    const res = await fetchImpl(`${base}/config`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<RuntimeConfig> | null
    if (!body || typeof body !== 'object' || !body.boss || typeof body.boss !== 'object') return null
    if (body.configFile) applyBossConfig(body.boss)
    return {
      port: typeof body.port === 'number' ? body.port : 0,
      host: typeof body.host === 'string' ? body.host : '',
      boss: { ...BUILD_TIME_BOSS, ...body.boss },
      configFile: typeof body.configFile === 'string' ? body.configFile : null,
      version: typeof body.version === 'string' ? body.version : '',
    }
  } catch {
    return null
  }
}
