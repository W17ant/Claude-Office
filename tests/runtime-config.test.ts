/**
 * src/config.ts at run time — loadRuntimeConfig fetches GET /config and
 * applies the boss to the live bindings (BOSS_NAME, BOSS_CHAR, ...) and, in
 * place, to the records other modules built from them: AGENT_CONFIGS['boss']
 * (src/types.ts) and ROLE_TO_CHAR['boss']. The build-time values stay when
 * the server is down, answers badly, or has no office.config.json.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as config from '../src/config'
import { BOSS_NAME, BOSS_CHAR, BOSS_COLOR, BOSS_EMOJI, BUILD_TIME_BOSS, loadRuntimeConfig } from '../src/config'
import { AGENT_CONFIGS } from '../src/types'

/** A fetch that answers GET /config with `body` (or fails as asked). */
function fakeFetch(body: unknown, { status = 200, reject = false }: { status?: number; reject?: boolean } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (reject) throw new TypeError('fetch failed')
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const served = (boss: Partial<config.BossConfig>, extra: Record<string, unknown> = {}) => ({
  port: 4123, host: '127.0.0.1', boss, configFile: '/repo/office.config.json', version: '1.0.0', ...extra,
})

afterEach(() => { config.applyBossConfig(BUILD_TIME_BOSS) })

describe('the build-time boss', () => {
  it('is what the bindings start as, and AGENT_CONFIGS.boss is the shared object', () => {
    expect(BUILD_TIME_BOSS).toEqual({ name: BOSS_NAME, sprite: BOSS_CHAR, color: BOSS_COLOR, emoji: BOSS_EMOJI })
    expect(AGENT_CONFIGS['boss']).toBe(config.BOSS_CONFIG)
    expect(AGENT_CONFIGS['boss']).toEqual({ title: BOSS_NAME, color: BOSS_COLOR, emoji: BOSS_EMOJI })
    expect(config.ROLE_TO_CHAR['boss']).toBe(BOSS_CHAR)
  })
})

describe('loadRuntimeConfig', () => {
  it('fetches GET /config from the server base and applies the boss everywhere', async () => {
    const { fetchImpl, calls } = fakeFetch(served({ name: 'Antony', sprite: 'Ant-1', color: '#00ff00', emoji: 'crown' }))
    const result = await loadRuntimeConfig({ fetchImpl, base: 'http://127.0.0.1:4123' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://127.0.0.1:4123/config')
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      port: 4123, host: '127.0.0.1', configFile: '/repo/office.config.json', version: '1.0.0',
      boss: { name: 'Antony', sprite: 'Ant-1', color: '#00ff00', emoji: 'crown' },
    })

    // The live bindings: a module that imported BOSS_NAME sees the new value
    expect(config.BOSS_NAME).toBe('Antony')
    expect(config.BOSS_CHAR).toBe('Ant-1')
    expect(config.BOSS_COLOR).toBe('#00ff00')
    expect(config.BOSS_EMOJI).toBe('crown')
    // The derived records, in place: the same objects every caller holds
    expect(AGENT_CONFIGS['boss']).toEqual({ title: 'Antony', color: '#00ff00', emoji: 'crown' })
    expect(AGENT_CONFIGS['boss']).toBe(config.BOSS_CONFIG)
    expect(config.ROLE_TO_CHAR['boss']).toBe('Ant-1')
  })

  it('applies only the fields that are non-empty strings, keeping the rest', async () => {
    const { fetchImpl } = fakeFetch(served({ name: 'Ant', sprite: '', color: 42 as never }))
    await loadRuntimeConfig({ fetchImpl, base: 'http://127.0.0.1:3334' })
    expect(config.BOSS_NAME).toBe('Ant')
    expect(config.BOSS_CHAR).toBe(BUILD_TIME_BOSS.sprite)
    expect(config.BOSS_COLOR).toBe(BUILD_TIME_BOSS.color)
    expect(AGENT_CONFIGS['boss'].title).toBe('Ant')
  })

  it('leaves the bundled boss alone when the server has no office.config.json', async () => {
    const { fetchImpl } = fakeFetch(served({ name: 'Boss', sprite: 'Me-1', color: '#ff4444', emoji: '👑' }, { configFile: null }))
    const result = await loadRuntimeConfig({ fetchImpl, base: 'http://127.0.0.1:3334' })
    expect(result?.configFile).toBeNull()
    expect(config.BOSS_NAME).toBe(BUILD_TIME_BOSS.name)
    expect(AGENT_CONFIGS['boss'].title).toBe(BUILD_TIME_BOSS.name)
  })

  it('is null, and changes nothing, when the server is down, answers non-2xx or with the wrong shape', async () => {
    expect(await loadRuntimeConfig({ fetchImpl: fakeFetch(null, { reject: true }).fetchImpl, base: 'http://127.0.0.1:1' })).toBeNull()
    expect(await loadRuntimeConfig({ fetchImpl: fakeFetch({ error: 'nope' }, { status: 404 }).fetchImpl, base: 'http://127.0.0.1:3334' })).toBeNull()
    expect(await loadRuntimeConfig({ fetchImpl: fakeFetch('not json').fetchImpl, base: 'http://127.0.0.1:3334' })).toBeNull()
    expect(await loadRuntimeConfig({ fetchImpl: fakeFetch({ port: 3334 }).fetchImpl, base: 'http://127.0.0.1:3334' })).toBeNull()
    expect(await loadRuntimeConfig({ fetchImpl: undefined as never, base: 'http://127.0.0.1:3334' })).toBeNull()
    expect(config.BOSS_NAME).toBe(BUILD_TIME_BOSS.name)
    expect(AGENT_CONFIGS['boss'].title).toBe(BUILD_TIME_BOSS.name)
    expect(config.ROLE_TO_CHAR['boss']).toBe(BUILD_TIME_BOSS.sprite)
  })

  it('gives up after timeoutMs rather than holding the first render', async () => {
    let aborted = false
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      await new Promise<void>((_, reject) => init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason) }))
      return new Response()
    }) as unknown as typeof fetch
    const started = Date.now()
    expect(await loadRuntimeConfig({ fetchImpl, base: 'http://127.0.0.1:3334', timeoutMs: 50 })).toBeNull()
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('applyBossConfig', () => {
  it('restores the build-time boss when given it back', () => {
    config.applyBossConfig({ name: 'Someone', sprite: 'S-1', color: '#000', emoji: 'x' })
    expect(AGENT_CONFIGS['boss'].title).toBe('Someone')
    expect(config.applyBossConfig(BUILD_TIME_BOSS)).toEqual(BUILD_TIME_BOSS)
    expect(AGENT_CONFIGS['boss'].title).toBe(BUILD_TIME_BOSS.name)
    expect(config.ROLE_TO_CHAR['boss']).toBe(BUILD_TIME_BOSS.sprite)
  })
})
