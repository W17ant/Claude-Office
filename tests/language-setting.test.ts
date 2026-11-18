/**
 * language-setting.test.ts - the office-wide language (server/i18n.js and
 * the `language` setting in server/index.js): GET / POST /settings, the
 * snapshot and the `settings` broadcast, and locale files that are broken
 * or gone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import WebSocket from 'ws'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listen, loadOffice, officeProtocols, removeOffice, type Office } from './helpers'
import { loadLocales, setLanguage, t, useLocaleDir } from '../server/i18n.js'

type Message = Record<string, any>

/** A WebSocket client that buffers messages so none is missed. */
function connect(url: string, protocols: string[] = []): Promise<{ ws: WebSocket, next: (pred: (m: Message) => boolean) => Promise<Message> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols)
    const queue: Message[] = []
    const waiters: Array<{ pred: (m: Message) => boolean, resolve: (m: Message) => void }> = []
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      const i = waiters.findIndex(w => w.pred(m))
      if (i >= 0) waiters.splice(i, 1)[0].resolve(m)
      else queue.push(m)
    })
    const next = (pred: (m: Message) => boolean) => {
      const i = queue.findIndex(pred)
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0])
      return new Promise<Message>(res => waiters.push({ pred, resolve: res }))
    }
    ws.once('open', () => resolve({ ws, next }))
    ws.once('error', reject)
  })
}

describe('the language setting', () => {
  let office: Office
  let url: string
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    office = await loadOffice()
    url = `ws://127.0.0.1:${await listen(office.server.httpServer)}/ws`
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('GET /settings reports language null and the language list', async () => {
    const res = await request(office.server.app).get('/settings')
    expect(res.status).toBe(200)
    expect(res.body.language).toBeNull()
    expect(res.body.languages[0]).toEqual(expect.objectContaining({ code: 'en', name: 'English', englishName: 'English', completeness: 100, status: null }))
  })

  it('POST /settings without the UI token refuses a language change', async () => {
    const res = await request(office.server.app).post('/settings').send({ language: 'en' })
    expect([401, 403]).toContain(res.status)
    expect((await request(office.server.app).get('/settings')).body.language).toBeNull()
  })

  it('POST /settings refuses an unknown language', async () => {
    const res = await request(office.server.app).post('/settings')
      .set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ language: 'xx' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/language/)
  })

  it('POST /settings sets the language and broadcasts it, to read-only pages too', async () => {
    const trusted = await connect(url, officeProtocols(office.server))
    const readOnly = await connect(url)
    sockets.push(trusted.ws, readOnly.ws)
    const first = await trusted.next(m => m.type === 'snapshot')
    expect(first.language).toBeNull()
    expect((await readOnly.next(m => m.type === 'snapshot')).language).toBeNull()

    const res = await request(office.server.app).post('/settings')
      .set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ language: 'en' })
    expect(res.status).toBe(200)
    expect(await trusted.next(m => m.type === 'settings')).toEqual({ type: 'settings', language: 'en' })
    expect(await readOnly.next(m => m.type === 'settings')).toEqual({ type: 'settings', language: 'en' })

    const again = await connect(url)
    sockets.push(again.ws)
    expect((await again.next(m => m.type === 'snapshot')).language).toBe('en')

    // null puts it back to "not chosen"
    await request(office.server.app).post('/settings')
      .set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ language: null })
    expect((await request(office.server.app).get('/settings')).body.language).toBeNull()
  })
})

describe('a saved language that no longer exists', () => {
  it('loads as null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-test-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ language: 'xx' }))
    const office = await loadOffice({ dir })
    try {
      expect((await request(office.server.app).get('/settings')).body.language).toBeNull()
    } finally {
      removeOffice(office)
    }
  })
})

describe('server/i18n.js', () => {
  it('skips a locale file that does not parse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-locales-'))
    writeFileSync(join(dir, 'en.json'), JSON.stringify({ meta: { name: 'English', englishName: 'English' } }))
    writeFileSync(join(dir, 'de.json'), '{nope')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(Object.keys(loadLocales(dir))).toEqual(['en'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toMatch(/\[i18n\].*de\.json/)
    } finally {
      warn.mockRestore()
    }
  })

  it('t follows the setting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-locales-'))
    writeFileSync(join(dir, 'en.json'), JSON.stringify({ meta: { name: 'English', englishName: 'English' }, server: { x: 'Hello' } }))
    writeFileSync(join(dir, 'de.json'), JSON.stringify({ meta: { name: 'Deutsch', englishName: 'German' }, server: { x: 'Hallo' } }))
    useLocaleDir(dir)
    try {
      setLanguage('de')
      expect(t('server.x')).toBe('Hallo')
      setLanguage(null)
      expect(t('server.x')).toBe('Hello')
    } finally {
      useLocaleDir()
    }
  })
})
