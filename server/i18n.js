/**
 * i18n.js - the server's side of translations: the locale files read from
 * locales/ at start, and t() / list() in the office's language.
 *
 * The language itself is a setting (settings.language in server/index.js);
 * index.js calls setLanguage() when it loads or changes. A message is
 * translated when it is written and stored as text, so changing the
 * language never rewrites the chat history.
 *
 * A locale file that does not parse, or has no meta.name, is skipped with
 * one warning: a hand-edited file in a checkout must never stop the office.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranslator, completeness } from '../shared/i18n.js'

const DEFAULT_DIR = fileURLToPath(new URL('../locales/', import.meta.url))

let dir = DEFAULT_DIR
/** @type {Record<string, object> | null} loaded on first use */
let catalogs = null
/** @type {string | null} null: never chosen, which reads as English */
let language = null
let translator = null

/**
 * Parse every locales/*.json. Unparsable or nameless files are skipped.
 * @param {string} [from]
 * @returns {Record<string, object>}
 */
export function loadLocales(from = DEFAULT_DIR) {
  const out = {}
  let files = []
  try { files = readdirSync(from).filter(f => extname(f) === '.json').sort() }
  catch (err) { console.warn(`[i18n] Could not read ${from}: ${err.message}`) }
  for (const file of files) {
    try {
      const catalog = JSON.parse(readFileSync(join(from, file), 'utf8'))
      if (!catalog?.meta?.name || !catalog?.meta?.englishName) throw new Error('meta.name and meta.englishName are required')
      out[basename(file, '.json')] = catalog
    } catch (err) {
      console.warn(`[i18n] Skipping ${file}: ${err.message}`)
    }
  }
  return out
}

function all() {
  if (!catalogs) catalogs = loadLocales(dir)
  return catalogs
}

function current() {
  if (!translator) translator = createTranslator(all(), language ?? 'en')
  return translator
}

/**
 * Read locale files from another directory (tests only); no argument goes
 * back to locales/. Resets the language.
 * @param {string} [other]
 */
export function useLocaleDir(other) {
  dir = other ?? DEFAULT_DIR
  catalogs = null
  language = null
  translator = null
}

/** Whether a locale file exists for this code. @param {string} code */
export function hasLanguage(code) {
  return typeof code === 'string' && Object.hasOwn(all(), code)
}

/**
 * Set the office's language; null (or an unknown code) is "not chosen".
 * @param {string | null} code
 */
export function setLanguage(code) {
  language = hasLanguage(code) ? code : null
  translator = null
}

/** @returns {string | null} */
export function getLanguage() {
  return language
}

/** The current language's code, English when none is chosen. */
export function lang() {
  return current().lang
}

/** @param {string} key @param {Record<string, string | number>} [vars] */
export function t(key, vars) {
  return current().t(key, vars)
}

/** @param {string} key */
export function list(key) {
  return current().list(key)
}

/**
 * The languages the office has, for the Settings picker: English first,
 * then by English name.
 * @returns {{ code: string, name: string, englishName: string, status: 'wip' | null, completeness: number }[]}
 */
export function languages() {
  const cats = all()
  const en = cats.en ?? {}
  return Object.entries(cats)
    .map(([code, c]) => ({
      code,
      name: c.meta.name,
      englishName: c.meta.englishName,
      status: c.meta.status === 'wip' ? 'wip' : null,
      completeness: code === 'en' ? 100 : completeness(c, en),
    }))
    .sort((a, b) => (a.code === 'en' ? -1 : b.code === 'en' ? 1 : a.englishName.localeCompare(b.englishName)))
}
