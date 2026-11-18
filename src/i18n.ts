/**
 * i18n.ts - the page's language: the locale files bundled at build time,
 * t() / list() in the office's language, and the hook that re-renders a
 * component when the language changes.
 *
 * Where the language comes from, in order:
 *   1. localStorage (agent-office.language): the last language this browser
 *      saw, so the page does not flash English before the WebSocket answers
 *   2. the WebSocket snapshot's `language` (src/hooks/useAgentSocket.ts)
 *   3. `{ type: 'settings', language }` broadcasts when someone changes it
 *
 * On first run (the server has no language yet) the office's own page, the
 * one holding the UI token, picks the browser's language once
 * (firstRunLanguage) and saves it to the server, so every page then agrees.
 */
import { useSyncExternalStore } from 'react'
import { createTranslator, matchLocale, completeness, type Catalog, type Translator, type Vars } from '../shared/i18n.js'

// Why raw text, parsed here: a locale file with a typo (a translator's
// checkout) must leave the office in English, not stop the page from building
const files = import.meta.glob('../locales/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

/**
 * Parse the bundled locale files by code (en, de, zh-TW …). A file that is
 * not valid JSON, or has no string meta.name / meta.englishName, is skipped
 * with one console.warn, as the server does (server/i18n.js).
 * @param raw file path → file text
 */
export function parseCatalogs(raw: Record<string, string>): Record<string, Catalog> {
  const out: Record<string, Catalog> = {}
  for (const [path, text] of Object.entries(raw)) {
    const code = path.replace(/^.*\/([^/]+)\.json$/, '$1')
    try {
      const catalog = JSON.parse(text) as Catalog
      if (typeof catalog?.meta?.name !== 'string' || typeof catalog?.meta?.englishName !== 'string') throw new Error('meta.name and meta.englishName must be text')
      out[code] = catalog
    } catch (err) {
      console.warn(`[i18n] Skipping locales/${code}.json: ${(err as Error).message}`)
    }
  }
  return out
}

/** Every bundled catalog by code (en, de, zh-TW …). */
export const catalogs: Record<string, Catalog> = parseCatalogs(files)

const CACHE_KEY = 'agent-office.language'
const listeners = new Set<() => void>()

function readCache(): string | null {
  try {
    const code = globalThis.localStorage?.getItem(CACHE_KEY) ?? null
    return code && Object.prototype.hasOwnProperty.call(catalogs, code) ? code : null
  } catch {
    // Why: private windows and blocked storage throw; the page still works in English
    return null
  }
}

function writeCache(code: string): void {
  try { globalThis.localStorage?.setItem(CACHE_KEY, code) } catch { /* see readCache */ }
}

let translator: Translator = createTranslator(catalogs, readCache() ?? 'en')
setDocumentLang(translator.lang)

function setDocumentLang(code: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = code
}

/** The language the page is showing (English when none is chosen or known). */
export function currentLanguage(): string {
  return translator.lang
}

/**
 * Show the page in this language; null or an unknown code is English.
 * Cached for the next load.
 */
export function applyLanguage(code: string | null): void {
  const next = code && Object.prototype.hasOwnProperty.call(catalogs, code) ? code : 'en'
  writeCache(next)
  if (next === translator.lang) return
  translator = createTranslator(catalogs, next)
  setDocumentLang(next)
  listeners.forEach(l => l())
}

/** The string for a key in the current language (English fallback). */
export function t(key: string, vars?: Vars): string {
  return translator.t(key, vars)
}

/** A chatter list in the current language (English list as fallback). */
export function list(key: string): string[] {
  return translator.list(key)
}

/** Subscribe to language changes; returns the unsubscribe. */
export function subscribeLanguage(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** t(), re-rendering the component when the language changes. */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage)
  return t
}

/**
 * On first run: the language this page should save to the server, or null
 * when there is nothing to do (already chosen, or this page may not write).
 * English is saved too when nothing matches, so the question is settled once.
 */
export function firstRunLanguage(
  serverLanguage: string | null,
  canWrite: boolean,
  browserLanguages: readonly string[],
  available: string[] = Object.keys(catalogs),
): string | null {
  if (serverLanguage !== null || !canWrite) return null
  for (const wanted of browserLanguages) {
    const code = matchLocale(wanted, available)
    // Why: an English speaker who also lists German still wants English
    if (code !== 'en' || /^en(-|$)/i.test(wanted)) return code
  }
  return 'en'
}

/** One language the office has, as the Settings picker shows it. */
export interface LanguageInfo {
  code: string
  /** In the language itself ("Deutsch") */
  name: string
  englishName: string
  /** "wip": a draft no native speaker has checked yet */
  status: 'wip' | null
  /** 0–100, the share of English it translates */
  completeness: number
}

/**
 * The bundled languages, English first, then by English name.
 * Why bundled and not GET /settings: the page and the server ship the same
 * locale files, and the picker then works before the server answers (and
 * under ?sim, which has no server).
 */
export function languageList(): LanguageInfo[] {
  const en = catalogs.en ?? {}
  return Object.entries(catalogs)
    .map(([code, c]) => ({
      code,
      name: c.meta.name,
      englishName: c.meta.englishName,
      status: c.meta.status === 'wip' ? 'wip' as const : null,
      completeness: code === 'en' ? 100 : completeness(c, en),
    }))
    .sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.englishName.localeCompare(b.englishName)))
}

// Why a GitHub issue form: a plain link, so the office itself sends nothing,
// and the form lands with the language already filled in
const REPORT_BASE = 'https://github.com/W17ant/Claude-Office/issues/new?template=translation.yml&language='

/** The "Report a translation error" link for a language. */
export function reportUrl(code: string): string {
  return REPORT_BASE + encodeURIComponent(code)
}
