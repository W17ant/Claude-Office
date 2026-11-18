/**
 * locales.test.ts - every file in locales/ passes the checks a translator's
 * PR must pass (scripts/i18n-check.mjs), en.json covers every key the code
 * uses, and the code only ever passes literal keys.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkLocale, loadLocaleFiles, findCodeKeys } from '../scripts/i18n-check.mjs'
import { flatten, completeness } from '../shared/i18n.js'

const en = JSON.parse(readFileSync('locales/en.json', 'utf8'))
const files = loadLocaleFiles('locales')

describe('locale files', () => {
  it.each(files.map(f => [f.code, f]))('%s parses and passes checkLocale', (_code, f) => {
    expect(f.error).toBeUndefined()
    expect(checkLocale(f.code, f.catalog, en)).toEqual([])
  })

  it('completeness is printed, not enforced', () => {
    for (const f of files) if (f.catalog) console.log(`${f.code}: ${completeness(f.catalog, en)}%`)
  })
})

describe('checkLocale catches each kind of problem', () => {
  const base = { meta: { name: 'X', englishName: 'X' } }
  const src = {
    meta: { name: 'English', englishName: 'English' },
    ui: { hi: 'Hi {name}', plain: 'Plain', n_one: '{count} file', n_other: '{count} files' },
    chatter: { spawn: ['hello {name}', 'yo'] },
  }
  const problems = (code: string, extra: object) => checkLocale(code, { ...base, ...extra }, src)
  const one = (code: string, extra: object, pattern: RegExp) => {
    const p = problems(code, extra)
    expect(p.some(s => pattern.test(s)), p.join('\n')).toBe(true)
  }

  it('an unknown key', () => one('de', { ui: { nope: 'x' } }, /ui\.nope/))
  it('a string where English has a list', () => one('de', { chatter: { spawn: 'x' } }, /chatter\.spawn/))
  it('a missing placeholder', () => one('de', { ui: { hi: 'Hallo' } }, /ui\.hi.*\{name\}/))
  it('an extra placeholder', () => one('de', { ui: { plain: 'Klar {x}' } }, /ui\.plain.*\{x\}/))
  it('markup', () => one('de', { ui: { plain: '<b>Klar</b>' } }, /ui\.plain.*markup/))
  it('Han in French', () => one('fr', { ui: { plain: 'puis直' } }, /ui\.plain.*Han/))
  it('Cyrillic in Spanish', () => one('es', { ui: { plain: 'ДА' } }, /ui\.plain.*Cyrillic/))
  it('a bad status', () => one('de', { meta: { name: 'X', englishName: 'X', status: 'done' } }, /meta\.status/))
  it('a missing englishName', () => one('de', { meta: { name: 'X' } }, /meta\.englishName/))
  it('a bad file name', () => one('german', {}, /code/))
  it('a plural form English lacks is fine', () => {
    expect(problems('ru', { ui: { n_few: '{count} файла', n_many: '{count} файлов' } })).toEqual([])
  })
  it('Han is allowed in Japanese', () => {
    expect(problems('ja', { ui: { plain: '日本語のテキスト' } })).toEqual([])
  })
  it('a chatter line may use any of the list placeholders', () => {
    expect(problems('de', { chatter: { spawn: ['hallo {name}', 'na', 'moin'] } })).toEqual([])
  })
})

describe('the code and en.json', () => {
  const { keys, dynamic } = findCodeKeys('.')
  const known = new Set(Object.keys(flatten(en)))
  const has = (k: string) => known.has(k) || known.has(`${k}_other`)

  it('en.json covers every key the code uses', () => {
    expect([...keys].filter(k => !has(k))).toEqual([])
  })

  it('the code passes only literal keys', () => {
    expect(dynamic).toEqual([])
  })
})

describe('i18n-coverage', () => {
  it('counts completeness, missing and stale keys per language', async () => {
    const { coverageRows } = await import('../scripts/i18n-coverage.mjs')
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-coverage-'))
    const enNow = { meta: { name: 'English', englishName: 'English' }, ui: { a: 'A', b: 'B', c: 'C' } }
    writeFileSync(join(dir, 'en.json'), JSON.stringify(enNow))
    writeFileSync(join(dir, 'de.json'), JSON.stringify({ meta: { name: 'Deutsch', englishName: 'German', status: 'wip' }, ui: { a: 'A de' } }))
    // English said something else for ui.a when de.json was last committed
    const enThen = { ...enNow, ui: { ...enNow.ui, a: 'old A' } }
    const rows = coverageRows(dir, () => JSON.stringify(enThen))
    const de = rows.find((r: any) => r.code === 'de')
    expect(de).toMatchObject({ name: 'Deutsch', wip: true, completeness: 33, missing: 2, stale: 1 })
    expect(rows.find((r: any) => r.code === 'en')).toMatchObject({ completeness: 100, missing: 0 })
    expect(coverageRows(dir, () => null).find((r: any) => r.code === 'de').stale).toBeNull()
  })
})
