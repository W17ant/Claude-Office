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
import { createTranslator, matchLocale, type Catalog, type Translator, type Vars } from '../shared/i18n.js'

const files = import.meta.glob('../locales/*.json', { eager: true, import: 'default' }) as Record<string, Catalog>

/** Every bundled catalog by code (en, de, zh-TW …). */
export const catalogs: Record<string, Catalog> = Object.fromEntries(
  Object.entries(files).map(([path, catalog]) => [path.replace(/^.*\/([^/]+)\.json$/, '$1'), catalog]),
)

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
