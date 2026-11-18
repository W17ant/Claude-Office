/**
 * i18n-coverage.mjs - how complete each language is, and what to translate next.
 *
 *   node scripts/i18n-coverage.mjs              one row per language
 *   node scripts/i18n-coverage.mjs --keys de    German's gap as "key<TAB>English",
 *                                               missing first, then stale
 *
 * Two kinds of gap, both of which show English (or old wording) in the office:
 *   missing  the key is not in the language's file yet
 *   stale    the key is there, but the English text changed after the
 *            language's file was last committed, so the translation is of
 *            wording the office no longer uses (found with git: en.json as it
 *            was at that commit, against en.json now)
 * Without git (a download, not a checkout) stale shows as "?". Exits 0
 * either way: an incomplete language is allowed, scripts/i18n-check.mjs is
 * what fails a PR.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { flatten, completeness, isTranslated } from '../shared/i18n.js'
import { loadLocaleFiles } from './i18n-check.mjs'

const NOT_COUNTED = ['meta.', 'ui.demo.']

/**
 * en.json as it was when a language's file was last committed, from git.
 * @param {string} dir  the locales directory
 * @returns {(code: string) => string | null}
 */
function gitEnAtLastCommit(dir) {
  return code => {
    try {
      const rev = execFileSync('git', ['log', '-1', '--format=%H', '--', join(dir, `${code}.json`)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (!rev) return null
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const rel = join(dir, 'en.json').replace(top + '/', '')
      return execFileSync('git', ['show', `${rev}:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 })
    } catch {
      return null
    }
  }
}

function countable(key) {
  return !NOT_COUNTED.some(p => key.startsWith(p))
}

function present(v) {
  return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v !== ''
}

/**
 * One row per language: completeness and its gaps.
 * @param {string} dir  the locales directory
 * @param {(code: string) => string | null} [enThen]  en.json's text when that
 *   language was last committed (default: from git); null when unknown
 * @returns {{ code: string, name: string, wip: boolean, completeness: number,
 *   missing: number, stale: number | null, missingKeys: string[], staleKeys: string[] }[]}
 */
export function coverageRows(dir, enThen = gitEnAtLastCommit(dir)) {
  const en = JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))
  const enFlat = flatten(en)
  const keys = Object.keys(enFlat).filter(countable)
  return loadLocaleFiles(dir).filter(f => f.catalog).map(({ code, catalog }) => {
    const mine = flatten(catalog)
    const missingKeys = code === 'en' ? [] : keys.filter(k => !isTranslated(mine, k))
    let staleKeys = []
    let stale = 0
    if (code !== 'en') {
      const text = enThen(code)
      if (text === null) stale = null
      else {
        let then = {}
        try { then = flatten(JSON.parse(text)) } catch { stale = null }
        if (stale !== null) {
          staleKeys = keys.filter(k => present(mine[k]) && then[k] !== undefined && JSON.stringify(then[k]) !== JSON.stringify(enFlat[k]))
          stale = staleKeys.length
        }
      }
    }
    return {
      code,
      name: catalog.meta?.name ?? code,
      wip: catalog.meta?.status === 'wip',
      completeness: code === 'en' ? 100 : completeness(catalog, en),
      missing: missingKeys.length,
      stale,
      missingKeys,
      staleKeys,
    }
  })
}

// --- CLI ---------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = fileURLToPath(new URL('../locales/', import.meta.url))
  const rows = coverageRows(dir)
  const at = process.argv.indexOf('--keys')
  if (at !== -1) {
    const code = process.argv[at + 1]
    const row = rows.find(r => r.code === code)
    if (!row) { console.error(`No locales/${code}.json`); process.exit(1) }
    const en = flatten(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8')))
    const show = k => `${k}\t${Array.isArray(en[k]) ? JSON.stringify(en[k]) : en[k]}`
    for (const k of row.missingKeys) console.log(show(k))
    for (const k of row.staleKeys) console.log(show(k))
  } else {
    console.log('code\tcomplete\tmissing\tstale\tname')
    for (const r of rows) {
      console.log(`${r.code}\t${r.completeness}%\t${r.missing}\t${r.stale ?? '?'}\t${r.name}${r.wip ? ' (work in progress)' : ''}`)
    }
  }
}
