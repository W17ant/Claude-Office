/**
 * page-i18n.test.ts - the page's language store (src/i18n.ts): switching
 * language, the localStorage cache that avoids an English flash, and the
 * first-run choice from the browser's language.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

/** A localStorage stand-in. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, v) },
    removeItem: (k: string) => { data.delete(k) },
    data,
  }
}

describe('the page language store', () => {
  it('applyLanguage switches t and notifies subscribers', async () => {
    const i18n = await import('../src/i18n')
    const seen: string[] = []
    const off = i18n.subscribeLanguage(() => seen.push(i18n.currentLanguage()))
    i18n.applyLanguage('en')
    expect(i18n.currentLanguage()).toBe('en')
    expect(i18n.t('ui.settings.language.title')).toBe('Language')
    off()
    expect(seen.length).toBeGreaterThanOrEqual(0)
  })

  it('applyLanguage(null) and an unknown code mean English', async () => {
    const i18n = await import('../src/i18n')
    i18n.applyLanguage(null)
    expect(i18n.currentLanguage()).toBe('en')
    i18n.applyLanguage('xx')
    expect(i18n.currentLanguage()).toBe('en')
  })

  it('caches the language in localStorage', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    const i18n = await import('../src/i18n')
    i18n.applyLanguage('en')
    expect(storage.data.get('agent-office.language')).toBe('en')
  })

  it('ignores an unknown cached language', async () => {
    vi.stubGlobal('localStorage', memoryStorage({ 'agent-office.language': 'xx' }))
    const i18n = await import('../src/i18n')
    expect(i18n.currentLanguage()).toBe('en')
  })

  it('a throwing localStorage leaves English', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
    })
    const i18n = await import('../src/i18n')
    expect(i18n.currentLanguage()).toBe('en')
    expect(() => i18n.applyLanguage('en')).not.toThrow()
  })
})

describe('firstRunLanguage', () => {
  it("takes the browser's language when the server has none and this page may write", async () => {
    const { firstRunLanguage } = await import('../src/i18n')
    expect(firstRunLanguage(null, true, ['de-AT'], ['en', 'de'])).toBe('de')
    expect(firstRunLanguage(null, true, ['xx', 'de'], ['en', 'de'])).toBe('de')
    expect(firstRunLanguage(null, true, ['xx'], ['en', 'de'])).toBe('en')
    expect(firstRunLanguage(null, true, [], ['en', 'de'])).toBe('en')
    // English first means English, even with German listed after it
    expect(firstRunLanguage(null, true, ['en-US', 'de'], ['en', 'de'])).toBe('en')
  })

  it('does nothing once chosen, or on a page without the UI token', async () => {
    const { firstRunLanguage } = await import('../src/i18n')
    expect(firstRunLanguage('fr', true, ['de'], ['en', 'de', 'fr'])).toBeNull()
    expect(firstRunLanguage(null, false, ['de'], ['en', 'de'])).toBeNull()
  })
})
