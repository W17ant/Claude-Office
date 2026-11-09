/**
 * viewer-key.test.ts - The page side of phone mode: the viewer key, the token rules, the WS URL and the stage scale.
 *
 * src/viewerKey.ts takes `#viewer=` out of the address and keeps it apart
 * from the office token; a viewer page offers only the viewer key, and a
 * plain-HTTP page off loopback never keeps or offers the office token.
 * Node only: the location, history and storages are fakes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { OFFICE_TOKEN_KEY, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX, stripOfficeToken, type HashLocation, type ReplaceHistory, type TokenStorage } from '../src/officeToken'
import {
  VIEWER_KEY_STORAGE, WS_VIEWER_PROTOCOL_PREFIX, captureViewerKey, clearViewerKey, getViewerKey, mayCarryOfficeToken,
  pageWsProtocols, resetViewerKeyMemory, viewerWsProtocols,
} from '../src/viewerKey'
import { sameOriginWsUrl, officeWsUrl } from '../src/serverUrl'
import { officeAuthHeaders } from '../src/officeAuth'
import { STAGE_H, STAGE_W, stageScale } from '../src/components/ViewerStage'
import { WS_VIEWER_PROTOCOL_PREFIX as SERVER_PREFIX } from '../server/lan.js'

const KEY = 'ab'.repeat(32)
const TOKEN = 'cd'.repeat(32)

class FakeStorage implements TokenStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

function page(hash = '') {
  const location: HashLocation = { pathname: '/', search: '', hash }
  const calls: Array<string | null | undefined> = []
  const history: ReplaceHistory = { state: null, replaceState: (_d, _u, url) => { calls.push(url) } }
  return { location, history, calls }
}

afterEach(() => resetViewerKeyMemory())

describe('captureViewerKey', () => {
  it('keeps a well-formed key under its own storage key and strips it from the address', () => {
    const storage = new FakeStorage()
    const { location, history, calls } = page(`#viewer=${KEY}&x=1`)
    expect(captureViewerKey(location, history, [storage])).toBe(KEY)
    expect(storage.data.get(VIEWER_KEY_STORAGE)).toBe(KEY)
    expect(storage.data.has(OFFICE_TOKEN_KEY)).toBe(false)
    expect(calls).toEqual(['/#x=1'])
  })

  it('a later load without the fragment is still a viewer page; #viewer=off forgets it', () => {
    const storage = new FakeStorage()
    captureViewerKey(page(`#viewer=${KEY}`).location, page().history, [storage])
    expect(captureViewerKey(page().location, page().history, [storage])).toBe(KEY)
    const off = page('#viewer=off')
    expect(captureViewerKey(off.location, off.history, [storage])).toBeNull()
    expect(off.calls).toEqual(['/'])
    expect(getViewerKey([storage])).toBeNull()
  })

  it('a malformed key is stripped and not kept', () => {
    const storage = new FakeStorage()
    const p = page('#viewer=nope')
    expect(captureViewerKey(p.location, p.history, [storage])).toBeNull()
    expect(p.calls).toEqual(['/'])
    clearViewerKey([storage])
  })
})

describe('the office token on a viewer or plain-HTTP page', () => {
  it('stripOfficeToken removes #token= and keeps nothing', () => {
    const p = page(`#token=${TOKEN}&viewer=x`)
    expect(stripOfficeToken(p.location, p.history)).toBe(true)
    expect(p.calls).toEqual(['/#viewer=x'])
    expect(stripOfficeToken(page('#a=b').location, page().history)).toBe(false)
  })

  it('mayCarryOfficeToken: loopback or https only', () => {
    expect(mayCarryOfficeToken({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true)
    expect(mayCarryOfficeToken({ protocol: 'http:', hostname: 'localhost' })).toBe(true)
    expect(mayCarryOfficeToken({ protocol: 'https:', hostname: 'my-mac.tail1234.ts.net' })).toBe(true)
    expect(mayCarryOfficeToken({ protocol: 'http:', hostname: '192.168.1.23' })).toBe(false)
    expect(mayCarryOfficeToken({ protocol: 'http:', hostname: 'my-mac.tail1234.ts.net' })).toBe(false)
  })

  it('pageWsProtocols: the viewer key alone on a viewer page, no token where it may not travel', () => {
    expect(SERVER_PREFIX).toBe(WS_VIEWER_PROTOCOL_PREFIX)
    expect(viewerWsProtocols(KEY)).toEqual([WS_PROTOCOL, `${WS_VIEWER_PROTOCOL_PREFIX}${KEY}`])
    expect(pageWsProtocols({ viewerKey: KEY, safe: true, token: TOKEN })).toEqual([WS_PROTOCOL, `${WS_VIEWER_PROTOCOL_PREFIX}${KEY}`])
    expect(pageWsProtocols({ viewerKey: null, safe: false, token: TOKEN })).toEqual([WS_PROTOCOL])
    expect(pageWsProtocols({ viewerKey: null, safe: true, token: TOKEN })).toEqual([WS_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${TOKEN}`])
  })
})

describe('the viewer page talks back to where it came from', () => {
  const lanPage = { protocol: 'http:', hostname: '192.168.1.23', host: '192.168.1.23:3335', port: '3335', origin: 'http://192.168.1.23:3335' }
  it('sameOriginWsUrl uses the page host and port, even on 3333', () => {
    expect(sameOriginWsUrl(lanPage)).toBe('ws://192.168.1.23:3335/ws')
    expect(sameOriginWsUrl({ ...lanPage, host: '192.168.1.23:3333', port: '3333' })).toBe('ws://192.168.1.23:3333/ws')
    // ...where the office page would have dialled the loopback server instead
    expect(officeWsUrl({ ...lanPage, host: '192.168.1.23:3333', port: '3333' }, { dev: false })).toBe('ws://127.0.0.1:3334/ws')
  })
})

describe('officeAuthHeaders: a page served through an HTTPS proxy name sends a token', () => {
  const proxied = { protocol: 'https:', hostname: 'my-mac.tail1234.ts.net' }
  const UI = 'ef'.repeat(24)
  it('nothing on loopback or on the LAN page, whatever the page holds', () => {
    expect(officeAuthHeaders({ loc: { protocol: 'http:', hostname: '127.0.0.1' }, uiToken: UI, officeToken: TOKEN })).toEqual({})
    expect(officeAuthHeaders({ loc: { protocol: 'http:', hostname: '192.168.1.23' }, uiToken: UI, officeToken: TOKEN })).toEqual({})
  })
  it('the UI token once known; before it, the office token on reads only', () => {
    expect(officeAuthHeaders({ loc: proxied, uiToken: UI, officeToken: TOKEN })).toEqual({ Authorization: `Bearer ${UI}` })
    expect(officeAuthHeaders({ loc: proxied, method: 'POST', uiToken: UI, officeToken: TOKEN })).toEqual({ Authorization: `Bearer ${UI}` })
    expect(officeAuthHeaders({ loc: proxied, uiToken: null, officeToken: TOKEN })).toEqual({ Authorization: `Bearer ${TOKEN}` })
    expect(officeAuthHeaders({ loc: proxied, method: 'POST', uiToken: null, officeToken: TOKEN })).toEqual({})
    expect(officeAuthHeaders({ loc: proxied, uiToken: null, officeToken: null })).toEqual({})
  })
  it('every fetch in src/ goes through it (or the UI token)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const files = ['src', 'src/components', 'src/hooks'].flatMap(d => readdirSync(d).filter(f => /\.tsx?$/.test(f)).map(f => join(d, f)))
    for (const file of files) {
      // Code only: comments mention fetch( in examples
      const src = readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
      if (!/\b(fetch|fetchImpl)\(/.test(src)) continue
      // Each file that fetches the office names its auth: officeAuthHeaders or the UI token
      expect(/officeAuthHeaders|Bearer \$\{uiToken\}/.test(src), file).toBe(true)
    }
  })
})

describe('ViewerStage: the room scaled to the phone', () => {
  it('fits 844 × 390 landscape by height and 390 × 844 portrait by width, never wider than the screen', () => {
    const land = stageScale(844, 390)
    expect(STAGE_H * land).toBeCloseTo(390, 5)
    expect(STAGE_W * land).toBeLessThanOrEqual(844)
    const port = stageScale(390, 844)
    expect(STAGE_W * port).toBeCloseTo(390, 5)
    expect(STAGE_H * port).toBeLessThanOrEqual(844)
    expect(stageScale(0, 0)).toBe(1)
  })
})
