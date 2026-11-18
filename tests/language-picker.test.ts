/**
 * language-picker.test.ts - the Settings language picker
 * (src/components/LanguagePicker.tsx), the report link (reportUrl) and the
 * bundled language list it shows (languageList).
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import LanguagePicker, { languageOptionLabel } from '../src/components/LanguagePicker'
import { languageList, reportUrl } from '../src/i18n'

const LANGS = [
  { code: 'en', name: 'English', englishName: 'English', status: null, completeness: 100 },
  { code: 'de', name: 'Deutsch', englishName: 'German', status: 'wip' as const, completeness: 87 },
  { code: 'fr', name: 'Français', englishName: 'French', status: null, completeness: 100 },
]

const render = (props: Partial<React.ComponentProps<typeof LanguagePicker>> = {}) =>
  renderToStaticMarkup(React.createElement(LanguagePicker, { languages: LANGS, value: 'de', canChange: true, onChange: () => {}, ...props }))

describe('reportUrl', () => {
  it('opens the translation form with the language filled in', () => {
    expect(reportUrl('zh-TW')).toBe('https://github.com/W17ant/Claude-Office/issues/new?template=translation.yml&language=zh-TW')
  })
})

describe('languageOptionLabel', () => {
  it('names the language in itself, with how complete and whether it is a draft', () => {
    expect(languageOptionLabel(LANGS[0])).toBe('English')
    expect(languageOptionLabel(LANGS[1])).toBe('Deutsch · 87% translated · work in progress')
    expect(languageOptionLabel(LANGS[2])).toBe('Français')
  })
})

describe('LanguagePicker', () => {
  it('lists every language and selects the current one', () => {
    const html = render()
    expect(html).toContain('data-testid="language-picker"')
    expect(html).toMatch(/<option value="de" selected="">Deutsch · 87% translated · work in progress<\/option>/)
    expect(html).toContain('<option value="fr">Français</option>')
  })

  it('links to the report form for the current language, in a new tab', () => {
    const html = render()
    expect(html).toContain(`href="${reportUrl('de').replace(/&/g, '&amp;')}"`)
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('Report a translation error')
  })

  it('is disabled with the reason on a page that may not change it', () => {
    const html = render({ canChange: false })
    expect(html).toMatch(/<select[^>]*disabled=""/)
    expect(html).toContain("Only the office&#x27;s own page can change the language")
  })
})

describe('languageList', () => {
  it('is the bundled locale files, English first and complete', () => {
    const list = languageList()
    expect(list[0]).toEqual({ code: 'en', name: 'English', englishName: 'English', status: null, completeness: 100 })
  })
})
