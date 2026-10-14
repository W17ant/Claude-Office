/**
 * The server serves the built UI (dist/) from its root when it exists, so the
 * packaged desktop app and `npm run build && npm run server` are one port.
 * Also the loopback origin allowlist that lets that page (or Vite's) talk to
 * the server whichever way it was opened.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadOffice, removeOffice, type Office } from './helpers'

const INDEX_HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>'
// 1x1 PNG
const SPRITE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

describe('built UI served from the server root', () => {
  let office: Office
  let uiDir: string

  beforeAll(async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'agent-office-ui-'))
    mkdirSync(join(uiDir, 'sprites', 'effects'), { recursive: true })
    writeFileSync(join(uiDir, 'index.html'), INDEX_HTML)
    writeFileSync(join(uiDir, 'sprites', 'effects', 'typing.png'), SPRITE)
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
  })

  afterAll(() => {
    removeOffice(office)
    try { rmSync(uiDir, { recursive: true, force: true }) } catch {}
  })

  it('reports the UI directory it found', () => {
    expect(office.server.UI_DIR).toBe(uiDir)
    expect(office.server.UI_AVAILABLE).toBe(true)
  })

  it('GET / returns the built index.html', async () => {
    const res = await request(office.server.app).get('/')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.text).toBe(INDEX_HTML)
  })

  it('serves sprites from the same origin', async () => {
    const res = await request(office.server.app).get('/sprites/effects/typing.png')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.compare(res.body, SPRITE)).toBe(0)
  })

  it('keeps the API routes ahead of the static files', async () => {
    const res = await request(office.server.app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  it('404s for files that are not in dist', async () => {
    const res = await request(office.server.app).get('/sprites/nope.png')
    expect(res.status).toBe(404)
  })
})

describe('without a build', () => {
  let office: Office

  beforeAll(async () => {
    // A dist dir that does not exist
    const missing = join(mkdtempSync(join(tmpdir(), 'agent-office-noui-')), 'dist')
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: missing } })
  })
  afterAll(() => removeOffice(office))

  it('GET / is a JSON 404 that says how to build the UI', async () => {
    expect(office.server.UI_AVAILABLE).toBe(false)
    const res = await request(office.server.app).get('/')
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/npm run build/)
  })

  it('the API still works', async () => {
    const res = await request(office.server.app).get('/health')
    expect(res.status).toBe(200)
  })
})

describe('loopback origin allowlist', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  const allowed = [
    'http://localhost:3333',   // Vite dev server
    'http://127.0.0.1:3333',   // same, opened by IP (what the scripts use)
    'http://localhost:3334',   // built UI served by this server
    'http://127.0.0.1:3334',   // what the packaged Electron app loads
    'http://[::1]:3334',
  ]
  for (const origin of allowed) {
    it(`allows ${origin}`, async () => {
      const res = await request(office.server.app).get('/health').set('Origin', origin)
      expect(res.status).toBe(200)
      expect(res.headers['access-control-allow-origin']).toBe(origin)
    })
  }

  const refused = [
    'http://evil.example',
    'http://localhost:3335',       // a Vite that drifted off 3333
    'http://127.0.0.1:8080',       // some other local app
    'https://localhost:3334',
    'file://',                     // a page opened from disk
    'null',                        // sandboxed iframe / opaque origin
  ]
  for (const origin of refused) {
    it(`refuses ${origin}`, async () => {
      const res = await request(office.server.app).get('/health').set('Origin', origin)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'Forbidden origin' })
    })
  }
})
