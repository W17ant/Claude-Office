/**
 * chatter.test.ts - what the agents say comes from the locale files
 * (chatter.* lists in locales/<code>.json), in the office's language, with
 * the English list when a language has none.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const en = JSON.parse(readFileSync('locales/en.json', 'utf8'))

afterEach(() => {
  vi.doUnmock('../src/i18n')
  vi.resetModules()
})

/** Load src/theme.ts and src/incident.ts against a list() that knows only `lists`. */
async function withLists(lists: Record<string, string[]>) {
  vi.resetModules()
  vi.doMock('../src/i18n', async importOriginal => ({
    ...(await importOriginal<typeof import('../src/i18n')>()),
    list: (key: string) => lists[key] ?? [],
  }))
  return { theme: await import('../src/theme'), incident: await import('../src/incident') }
}

describe('chatter', () => {
  it('the default theme speaks the language’s list', async () => {
    const { theme } = await withLists({ 'chatter.default.spawn': ['siap bertugas!'] })
    expect(theme.themedSpawn()).toBe('siap bertugas!')
  })

  it('Dunder Mifflin mode speaks its own list', async () => {
    const { theme } = await withLists({ 'chatter.office.done': ['dicho y hecho'] })
    theme.setTheme('office')
    expect(theme.themedDone()).toBe('dicho y hecho')
  })

  it('incident lines come from chatter.incident', async () => {
    const { incident } = await withLists({ 'chatter.incident.bossReply': ['todo despejado'] })
    expect(incident.pickIncidentLine('bossReply')).toBe('todo despejado')
  })

  it('with the real files, every line is one of en.json’s', async () => {
    vi.resetModules()
    const theme = await import('../src/theme')
    theme.setTheme('default')
    for (let i = 0; i < 20; i++) expect(en.chatter.default.spawn).toContain(theme.themedSpawn())
    expect(en.chatter.default.coffee.length).toBeGreaterThan(0)
    for (const kind of ['spawn', 'work', 'done', 'coffee', 'water', 'bossReply']) {
      expect(en.chatter.incident[kind]?.length, kind).toBeGreaterThan(0)
    }
  })

  it('a furniture interaction says a line from its list', async () => {
    vi.resetModules()
    vi.doMock('../src/i18n', async importOriginal => ({
      ...(await importOriginal<typeof import('../src/i18n')>()),
      list: (key: string) => (key === 'chatter.interactions.coffee' ? ['café!'] : ['?']),
    }))
    const { getInteraction } = await import('../src/interactions')
    const action = getInteraction('coffee', null)
    expect(action?.chatMessage).toEqual(['café!'])
  })
})
