/**
 * i18n.test.ts - the shared translator (shared/i18n.js): lookup with English
 * fallback, placeholders, plurals, chatter lists, locale matching,
 * completeness and Intl formatting. Inline catalogs, never the real files.
 */
import { describe, it, expect } from 'vitest'
import {
  createTranslator, matchLocale, completeness, flatten, formatMoney,
} from '../shared/i18n.js'

const en = {
  meta: { name: 'English', englishName: 'English' },
  ui: { a: 'A en', b: 'B en', c: 'C en', hi: 'Hi {name}', n_one: '{count} file', n_other: '{count} files', demo: { x: 'demo' } },
  chatter: { x: ['one', 'two'], y: ['y en'] },
}
const de = {
  meta: { name: 'Deutsch', englishName: 'German' },
  ui: { a: 'A de', c: '' },
  chatter: { x: [], y: ['a'] },
}
const ru = {
  meta: { name: 'Русский', englishName: 'Russian' },
  ui: { n_one: 'ru one {count}', n_many: 'ru many {count}', n_other: 'ru other {count}' },
}
const catalogs = { en, de, ru }

describe('t', () => {
  it("returns the language's string, else English, else the key", () => {
    const { t } = createTranslator(catalogs, 'de')
    expect(t('ui.a')).toBe('A de')
    expect(t('ui.b')).toBe('B en')
    expect(t('ui.nope')).toBe('ui.nope')
  })

  it('treats an empty string as missing', () => {
    expect(createTranslator(catalogs, 'de').t('ui.c')).toBe('C en')
  })

  it('fills placeholders literally', () => {
    const { t } = createTranslator(catalogs, 'en')
    expect(t('ui.hi', { name: '$& {x} $1' })).toBe('Hi $& {x} $1')
    expect(t('ui.hi')).toBe('Hi {name}')
  })

  it('picks plural forms with Intl.PluralRules', () => {
    const r = createTranslator(catalogs, 'ru')
    expect(r.t('ui.n', { count: 1 })).toBe('ru one 1')
    expect(r.t('ui.n', { count: 5 })).toBe('ru many 5')
    // Why: 2 is "few" in Russian, which this catalog lacks: its own _other wins over English
    expect(r.t('ui.n', { count: 2 })).toBe('ru other 2')
    const d = createTranslator(catalogs, 'de')
    expect(d.t('ui.n', { count: 1 })).toBe('1 file')
    expect(d.t('ui.n', { count: 3 })).toBe('3 files')
  })
})

describe('list', () => {
  it('falls back as a whole list', () => {
    const { list } = createTranslator(catalogs, 'de')
    expect(list('chatter.x')).toEqual(['one', 'two'])
    expect(list('chatter.y')).toEqual(['a'])
    expect(list('chatter.nope')).toEqual([])
  })
})

describe('matchLocale', () => {
  const av = ['en', 'de', 'es', 'pt-BR', 'zh-CN', 'zh-TW']
  it.each([
    ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant-TW', 'zh-TW'], ['zh', 'zh-CN'], ['zh-SG', 'zh-CN'],
    ['zh-Hans', 'zh-CN'], ['pt-PT', 'pt-BR'], ['pt', 'pt-BR'], ['es-MX', 'es'], ['DE-de', 'de'], ['de', 'de'],
    ['zh-tw', 'zh-TW'], ['', 'en'], ['xx', 'en'],
  ])('%s → %s', (req, want) => {
    expect(matchLocale(req, av)).toBe(want)
  })
  it('never lets Simplified and Traditional Chinese stand in for each other', () => {
    expect(matchLocale('zh-CN', ['en', 'zh-TW'])).toBe('en')
    expect(matchLocale('zh-TW', ['en', 'zh-CN'])).toBe('en')
    expect(matchLocale('zh-HK', ['en', 'zh-CN'])).toBe('en')
  })
  it('handles nothing', () => {
    expect(matchLocale(undefined, av)).toBe('en')
    expect(matchLocale(null, av)).toBe('en')
  })
})

describe('completeness', () => {
  it('counts the share of English keys translated, demo keys aside', () => {
    expect(completeness(en, en)).toBe(100)
    // en has 9 countable keys (ui.a b c hi n_one n_other, chatter.x y); de has ui.a and chatter.y
    const countable = Object.keys(flatten(en)).filter(k => !k.startsWith('meta.') && !k.startsWith('ui.demo.')).length
    expect(countable).toBe(8)
    expect(completeness(de, en)).toBe(25)
  })
})

describe('formatting', () => {
  it('formats money as US dollars in the language', () => {
    expect(formatMoney(3, 'en')).toBe('$3.00')
    const d = formatMoney(1234.5, 'de')
    expect(d).toContain('1.234,50')
    expect(d).toContain('$')
  })
})

describe('createTranslator', () => {
  it('falls back to English for an unknown language', () => {
    expect(createTranslator(catalogs, 'xx').lang).toBe('en')
  })
})

describe('flatten', () => {
  it('keeps arrays as leaves', () => {
    expect(flatten({ a: { b: ['x', 'y'], c: 'z' } })).toEqual({ 'a.b': ['x', 'y'], 'a.c': 'z' })
  })
})

describe('packaging', () => {
  // Why: server/i18n.js imports ../shared/i18n.js and reads ../locales/ — a
  // package without them crashes the server at start
  const pkg = JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'))
  it('the npm package ships shared/ and locales/', () => {
    expect(pkg.files).toEqual(expect.arrayContaining(['shared/', 'locales/']))
  })
  it('the desktop app ships shared/ and locales/', () => {
    expect(pkg.build.files).toEqual(expect.arrayContaining(['shared/**', 'locales/**']))
  })
})

describe('completeness and plural forms', () => {
  it('a language without a "one" form is complete with only _other', () => {
    const enP = { meta: { name: 'English', englishName: 'English' }, ui: { n_one: '{count} file', n_other: '{count} files', x: 'X' } }
    const ja = { meta: { name: '日本語', englishName: 'Japanese' }, ui: { n_other: '{count} 件', x: 'エックス' } }
    expect(completeness(ja, enP)).toBe(100)
    // a missing _other still counts against it
    expect(completeness({ meta: ja.meta, ui: { x: 'エックス' } }, enP)).toBeLessThan(100)
  })
})
