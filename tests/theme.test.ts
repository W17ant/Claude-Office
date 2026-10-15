/**
 * src/theme.ts — the Office cast survives a reload and a theme toggle (audit
 * C47): only the theme name used to be persisted, and setTheme wiped the cast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeStorage {
  private map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, String(v)) }
  removeItem(k: string) { this.map.delete(k) }
  clear() { this.map.clear() }
}

describe('theme.ts cast persistence (C47)', () => {
  beforeEach(() => {
    ;(globalThis as any).localStorage = new FakeStorage()
    vi.resetModules()
  })
  afterEach(() => {
    delete (globalThis as any).localStorage
  })

  it('keeps every role\'s character across /the-office off -> on and across a reload', async () => {
    const t1 = await import('../src/theme')
    t1.setTheme('office')
    const debugger1 = t1.getCharacterBaseForRole('debugger', 'dev-1')
    const reviewer1 = t1.getCharacterBaseForRole('code-reviewer', 'employee-1')
    const name1 = t1.themedDisplayName('debugger', 'Debugger')
    expect(debugger1).not.toBe('dev-1')

    // Toggle off and on: same cast
    t1.toggleTheme()
    expect(t1.getTheme()).toBe('default')
    t1.toggleTheme()
    expect(t1.getCharacterBaseForRole('debugger', 'dev-1')).toBe(debugger1)
    expect(t1.getCharacterBaseForRole('code-reviewer', 'employee-1')).toBe(reviewer1)
    expect(t1.themedDisplayName('debugger', 'Debugger')).toBe(name1)

    // Reload (fresh module, same localStorage): same cast
    vi.resetModules()
    const t2 = await import('../src/theme')
    expect(t2.getTheme()).toBe('office')
    expect(t2.getCharacterBaseForRole('debugger', 'dev-1')).toBe(debugger1)
    expect(t2.getCharacterBaseForRole('code-reviewer', 'employee-1')).toBe(reviewer1)
  })

  it('releasing a role frees its character for the next agent, and the release is persisted too', async () => {
    const t1 = await import('../src/theme')
    t1.setTheme('office')
    t1.assignCharacterToRole('dm-slot-3', 'dwight-schrute')
    expect(t1.getActiveCastSlugs().has('dwight-schrute')).toBe(true)
    t1.releaseRole('dm-slot-3')
    expect(t1.getActiveCastSlugs().has('dwight-schrute')).toBe(false)

    vi.resetModules()
    const t2 = await import('../src/theme')
    expect(t2.getActiveCastSlugs().has('dwight-schrute')).toBe(false)
  })

  it('ignores a corrupt or foreign saved cast', async () => {
    ;(globalThis as any).localStorage.setItem('agent-office-theme', 'office')
    ;(globalThis as any).localStorage.setItem('agent-office-cast', '{"castByRole":{"boss":"not-a-character","assistant":"jim-halpert"},"angelaRole":"boss","angelaCat":"cat-bandit"}')
    const t = await import('../src/theme')
    expect(t.getCharacterBaseForRole('assistant', 'Claude-1')).toBe('jim-halpert')
    expect(t.getCharacterBaseForRole('boss', 'Me-1')).toBe('michael-scott') // fixed casting, the bad slug was dropped
    expect(t.getAngelaCat()).toBeNull()
  })
})
