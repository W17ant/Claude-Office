/**
 * i18n.js - the translator the page and the server share.
 *
 * Pure functions over locale catalogs (locales/<code>.json, already parsed):
 * no file or network access, so the Vite page (which bundles the catalogs)
 * and the Node server (which reads them from disk) both use it unchanged.
 *
 *   t(key, vars)   the string in the current language, else English, else
 *                  the key itself (a test keeps en.json covering every key
 *                  the code uses, so that last case never ships)
 *   list(key)      a chatter list; falls back to English as a whole list
 *
 * Placeholders are {name}; plurals are <key>_one / _other (plus whatever
 * forms Intl.PluralRules gives the language: _zero, _two, _few, _many),
 * chosen by vars.count.
 */

/**
 * Flatten a catalog to dotted keys. Arrays are leaves, never indexed:
 * a chatter list is one key.
 * @param {object} node
 * @param {string} [prefix]
 * @param {Record<string, string | string[]>} [out]
 * @returns {Record<string, string | string[]>}
 */
export function flatten(node, prefix = '', out = {}) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string' || Array.isArray(value)) out[path] = value
    else if (value && typeof value === 'object') flatten(value, path, out)
  }
  return out
}

/** Read a dotted key from a nested catalog. */
function lookup(catalog, key) {
  let node = catalog
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined
    node = node[part]
  }
  return node
}

function nonEmptyString(v) {
  return typeof v === 'string' && v !== '' ? v : undefined
}

// Why: Chinese is split by script, never by region alone. A Hong Kong reader
// reads Traditional characters, a Singapore reader Simplified, and handing
// either the other script is worse than English.
const CHINESE_TRADITIONAL = new Set(['tw', 'hk', 'mo', 'hant'])

/**
 * The best available locale for a requested BCP 47 tag.
 * Exact (case-insensitive) first; Chinese by script; any Portuguese gets
 * pt-BR; otherwise the language part; otherwise English.
 * @param {string | null | undefined} requested
 * @param {string[]} available
 * @returns {string}
 */
export function matchLocale(requested, available) {
  if (typeof requested !== 'string' || requested.trim() === '') return 'en'
  const byLower = new Map(available.map(code => [code.toLowerCase(), code]))
  const req = requested.trim().replace(/_/g, '-').toLowerCase()
  if (byLower.has(req)) return byLower.get(req)
  const parts = req.split('-')
  const lang = parts[0]
  if (lang === 'zh') {
    const traditional = parts.slice(1).some(p => CHINESE_TRADITIONAL.has(p))
    return byLower.get(traditional ? 'zh-tw' : 'zh-cn') ?? 'en'
  }
  if (lang === 'pt') return byLower.get('pt-br') ?? byLower.get('pt') ?? 'en'
  return byLower.get(lang) ?? 'en'
}

/** Replace {name} with vars.name; unknown placeholders stay as written. */
function fill(text, vars) {
  if (!vars) return text
  // Why: a replacer function, never a replacement string, so a value holding
  // "$&" or "$1" goes in literally
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)
}

const pluralRulesCache = new Map()
function pluralForm(lang, count) {
  let rules = pluralRulesCache.get(lang)
  if (!rules) {
    try { rules = new Intl.PluralRules(lang) } catch { rules = new Intl.PluralRules('en') }
    pluralRulesCache.set(lang, rules)
  }
  return rules.select(count)
}

/**
 * A translator for one language over a set of catalogs (keyed by code,
 * English under "en"). An unknown language is English.
 * @param {Record<string, object>} catalogs
 * @param {string} lang
 */
export function createTranslator(catalogs, lang) {
  const code = catalogs[lang] ? lang : 'en'
  const own = catalogs[code] ?? {}
  const en = catalogs.en ?? {}

  /**
   * @param {string} key
   * @param {Record<string, string | number>} [vars]
   * @returns {string}
   */
  function t(key, vars) {
    if (vars && typeof vars.count === 'number') {
      // Order: this language's form, its _other, English's form, English's _other
      const candidates = [
        [own, `${key}_${pluralForm(code, vars.count)}`],
        [own, `${key}_other`],
        [en, `${key}_${pluralForm('en', vars.count)}`],
        [en, `${key}_other`],
      ]
      for (const [catalog, k] of candidates) {
        const hit = nonEmptyString(lookup(catalog, k))
        if (hit !== undefined) return fill(hit, vars)
      }
    }
    const text = nonEmptyString(lookup(own, key)) ?? nonEmptyString(lookup(en, key))
    return text === undefined ? key : fill(text, vars)
  }

  /**
   * @param {string} key
   * @returns {string[]}
   */
  function list(key) {
    const mine = lookup(own, key)
    if (Array.isArray(mine) && mine.length > 0) return mine
    const base = lookup(en, key)
    return Array.isArray(base) ? base : []
  }

  return { lang: code, t, list }
}

// Why: demo, sim and promo content stays English (spec), so it never counts
// against a translation
const NOT_COUNTED = ['meta.', 'ui.demo.']

/**
 * How much of English a catalog translates, 0–100 (whole number).
 * @param {object} catalog
 * @param {object} en
 * @returns {number}
 */
export function completeness(catalog, en) {
  const keys = Object.keys(flatten(en)).filter(k => !NOT_COUNTED.some(p => k.startsWith(p)))
  if (keys.length === 0) return 100
  const mine = flatten(catalog)
  const done = keys.filter(k => {
    const v = mine[k]
    return Array.isArray(v) ? v.length > 0 : nonEmptyString(v) !== undefined
  }).length
  return Math.floor((done / keys.length) * 100)
}

function safeLocale(lang) {
  try { return Intl.getCanonicalLocales(lang)[0] ?? 'en' } catch { return 'en' }
}

/**
 * US dollars (what the tools bill in), formatted for the language.
 * @param {number} usd
 * @param {string} lang
 */
export function formatMoney(usd, lang) {
  return new Intl.NumberFormat(safeLocale(lang), { style: 'currency', currency: 'USD' }).format(usd)
}

/** @param {number} n @param {string} lang */
export function formatNumber(n, lang) {
  return new Intl.NumberFormat(safeLocale(lang)).format(n)
}

/** Hour and minute, in the language's clock style. @param {number} ms @param {string} lang */
export function formatTime(ms, lang) {
  return new Intl.DateTimeFormat(safeLocale(lang), { hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
}

/** Day and short month. @param {number} ms @param {string} lang */
export function formatDate(ms, lang) {
  return new Intl.DateTimeFormat(safeLocale(lang), { day: 'numeric', month: 'short' }).format(new Date(ms))
}
