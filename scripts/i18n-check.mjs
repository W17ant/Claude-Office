/**
 * i18n-check.mjs - the checks every locale file must pass.
 *
 * Used by tests/locales.test.ts (so CI runs them on every PR), by
 * scripts/i18n-coverage.mjs, and by translators directly:
 *
 *   node scripts/i18n-check.mjs          check every file in locales/
 *   node scripts/i18n-check.mjs de       check locales/de.json only
 *
 * Prints each problem, or "<code>: ok", and exits 1 if anything is wrong.
 * A missing key is not a problem (English shows instead); a wrong one is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flatten } from '../shared/i18n.js'

// Why: BCP 47 as the office uses it: language, optional script, optional region
const CODE_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/
const PLACEHOLDER_RE = /\{(\w+)\}/g
const MARKUP_RE = /<\/?[a-zA-Z][^>]*>/
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/

/** Writing systems a stray character could come from. Latin is always allowed. */
const SCRIPTS = {
  Han: /\p{Script=Han}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Hangul: /\p{Script=Hangul}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Greek: /\p{Script=Greek}/u,
  Arabic: /\p{Script=Arabic}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Thai: /\p{Script=Thai}/u,
  Devanagari: /\p{Script=Devanagari}/u,
}

/**
 * The scripts each language may use besides Latin, by language part of the
 * code. Any language not listed is Latin only.
 * Why: card genie found a stray Chinese character inside a French file, in
 * a diff of 192 new strings that nobody could spot by eye. A new language in
 * a non-Latin script must be added here in the same PR as its file.
 */
export const ALLOWED_SCRIPTS = {
  ja: ['Han', 'Hiragana', 'Katakana'],
  ko: ['Hangul', 'Han'],
  zh: ['Han'],
  ru: ['Cyrillic'],
  uk: ['Cyrillic'],
  el: ['Greek'],
}

function placeholders(text) {
  return new Set([...text.matchAll(PLACEHOLDER_RE)].map(m => m[1]))
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every(x => b.has(x))
}

function show(set) {
  return [...set].map(p => `{${p}}`).join(' ') || 'none'
}

/**
 * Every problem with one locale catalog, as readable lines.
 * @param {string} code  the file's name without .json
 * @param {unknown} catalog  the parsed file
 * @param {object} en  the parsed English file
 * @returns {string[]}
 */
export function checkLocale(code, catalog, en) {
  const problems = []
  if (!CODE_RE.test(code)) problems.push(`${code}: the file name must be a language code such as de, pt-BR or zh-TW`)
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [...problems, `${code}: not a JSON object`]
  const meta = catalog.meta
  if (!meta || typeof meta !== 'object') problems.push(`${code}: meta is missing`)
  else {
    if (typeof meta.name !== 'string' || !meta.name.trim()) problems.push(`${code}: meta.name must be the language's own name`)
    if (typeof meta.englishName !== 'string' || !meta.englishName.trim()) problems.push(`${code}: meta.englishName must be the language's English name`)
    if (meta.translators !== undefined && !(Array.isArray(meta.translators) && meta.translators.every(x => typeof x === 'string'))) {
      problems.push(`${code}: meta.translators must be a list of names`)
    }
    if (meta.status !== undefined && meta.status !== 'wip') problems.push(`${code}: meta.status must be "wip" or left out`)
  }

  const source = flatten(en)
  const allowed = new Set(ALLOWED_SCRIPTS[code.split('-')[0]] ?? [])
  for (const [key, value] of Object.entries(flatten(catalog))) {
    if (key.startsWith('meta.')) continue
    let english = source[key]
    let plural = false
    if (english === undefined && PLURAL_SUFFIX_RE.test(key)) {
      // A plural form English does not need (Russian _few): checked against English's _other
      english = source[key.replace(PLURAL_SUFFIX_RE, '_other')]
      plural = true
    } else if (english !== undefined && PLURAL_SUFFIX_RE.test(key)) plural = true
    if (english === undefined) { problems.push(`${code}: ${key} is not a key in en.json (a typo, or removed from English)`); continue }
    if (Array.isArray(english) !== Array.isArray(value)) {
      problems.push(`${code}: ${key} must be ${Array.isArray(english) ? 'a list' : 'a single string'}, like English`)
      continue
    }
    const texts = Array.isArray(value) ? value : [value]
    if (texts.some(x => typeof x !== 'string')) { problems.push(`${code}: ${key} must hold only text`); continue }

    for (const text of texts) {
      const mine = placeholders(text)
      if (Array.isArray(english)) {
        const union = new Set(english.flatMap(line => [...placeholders(line)]))
        const extra = [...mine].filter(p => !union.has(p))
        if (extra.length) problems.push(`${code}: ${key} uses ${show(new Set(extra))}, which English's list never does`)
      } else if (plural) {
        // Why count is always allowed: the code passes it to every plural form, and
        // a language whose "one" covers 21, 31 … (Russian) must be able to print it
        const theirs = placeholders(english)
        theirs.add('count')
        const extra = [...mine].filter(p => !theirs.has(p))
        if (extra.length) problems.push(`${code}: ${key} uses ${show(new Set(extra))}, which English does not`)
      } else if (text !== '' && !sameSet(mine, placeholders(english))) {
        problems.push(`${code}: ${key} has placeholders ${show(mine)}; English has ${show(placeholders(english))}`)
      }
      if (MARKUP_RE.test(text)) problems.push(`${code}: ${key} contains markup; strings are plain text`)
      for (const [script, re] of Object.entries(SCRIPTS)) {
        if (!allowed.has(script) && re.test(text)) problems.push(`${code}: ${key} contains ${script} characters, which ${code} does not use`)
      }
    }
  }
  return problems
}

/**
 * Every locales/*.json, parsed. A file that does not parse comes back with
 * an error instead of a catalog.
 * @param {string} dir
 * @returns {{ code: string, catalog?: object, error?: string }[]}
 */
export function loadLocaleFiles(dir) {
  return readdirSync(dir)
    .filter(f => extname(f) === '.json')
    .sort()
    .map(f => {
      const code = basename(f, '.json')
      try { return { code, catalog: JSON.parse(readFileSync(join(dir, f), 'utf8')) } }
      catch (err) { return { code, error: `${code}: not valid JSON (${err.message})` } }
    })
}

// --- Keys the code uses -------------------------------------------------------

const SCAN = [
  { dir: 'src', exts: ['.ts', '.tsx'] },
  { dir: 'server', exts: ['.js'] },
  { dir: 'shared', exts: ['.js'] },
]
// Why: only files that import the translator can call it; anything else named t() is not ours
const IMPORTS_I18N = /from\s+['"](?:\.{1,2}\/)+(?:[\w-]+\/)*i18n(?:\.js|\.ts)?['"]/
// Why: t( or list( as a bare call, not a method (x.t) and not part of a word (start()
const CALL_RE = /(?<![\w.$])(t|list)\(\s*/g

function walk(dir, exts, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, exts, out)
    else if (exts.includes(extname(name))) out.push(path)
  }
  return out
}

/**
 * Every literal key passed to t() / list() in the source, and every call
 * whose key is not a literal (those cannot be checked against en.json).
 * @param {string} rootDir  the repo root
 * @returns {{ keys: Set<string>, dynamic: string[] }}
 */
export function findCodeKeys(rootDir) {
  const keys = new Set()
  const dynamic = []
  for (const { dir, exts } of SCAN) {
    for (const file of walk(join(rootDir, dir), exts)) {
      // The translator modules themselves define t(key) and list(key)
      if (/^i18n\.(js|ts)$/.test(basename(file))) continue
      const source = readFileSync(file, 'utf8')
      if (!IMPORTS_I18N.test(source)) continue
      const lines = source.split('\n')
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
        for (const m of line.matchAll(CALL_RE)) {
          if (/function\s+$/.test(line.slice(0, m.index))) continue
          const rest = line.slice(m.index + m[0].length)
          const lit = /^(['"`])([^'"`$\\]+)\1/.exec(rest)
          if (lit) keys.add(lit[2])
          else dynamic.push(`${relative(rootDir, file)}:${i + 1}`)
        }
      })
    }
  }
  return { keys, dynamic }
}

// --- CLI ---------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('../locales/', import.meta.url))
  const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))
  const only = process.argv[2]
  let failed = false
  for (const f of loadLocaleFiles(dir)) {
    if (only && f.code !== only) continue
    const problems = f.error ? [f.error] : checkLocale(f.code, f.catalog, en)
    if (problems.length) { failed = true; for (const p of problems) console.log(p) }
    else console.log(`${f.code}: ok`)
  }
  process.exit(failed ? 1 : 0)
}
