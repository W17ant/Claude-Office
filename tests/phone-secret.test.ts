/**
 * phone-secret.test.ts - The page side of phone full mode: where the phone secret may live, what carries it, and the layout maths.
 *
 * src/phoneSecret.ts keeps `#phone=` only on a page served over https from a
 * private IPv4 literal (the full-mode LAN listener's) and strips it from the
 * address everywhere else. On that page the secret is the ONLY credential
 * that leaves the browser: never the office token, never the viewer key,
 * never the UI token. The server half is tests/lan-full.test.ts.
 * Node only: the location, history and storages are fakes.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OFFICE_TOKEN_KEY, WS_PROTOCOL, type HashLocation, type ReplaceHistory, type TokenStorage } from '../src/officeToken'
import {
  PHONE_OFF, PHONE_SECRET_STORAGE, WS_PHONE_PROTOCOL_PREFIX,
  capturePhoneSecret, clearPhoneSecret, getPhoneSecret, isPhoneFullLocation, isPhoneSecret, isPrivateIPv4Host,
  onPhoneFullPage, phoneWsProtocols, resetPhoneSecretMemory, type PageKind,
} from '../src/phoneSecret'
import { VIEWER_KEY_STORAGE, mayCarryOfficeToken, pageWsProtocols } from '../src/viewerKey'
import { officeAuthHeaders } from '../src/officeAuth'
import { isDevServerPage, officeHttpBase, officeWsUrl, sameOriginWsUrl } from '../src/serverUrl'
import { STAGE_H, STAGE_W } from '../src/components/ViewerStage'
import { PHONE_TABS, nextPhoneBox, phoneIsCompact, phoneIsLandscape, phoneStageScale, visibleBox } from '../src/components/PhoneOffice'
import { WS_PHONE_PROTOCOL_PREFIX as SERVER_PREFIX, isPrivateIPv4 } from '../server/lan.js'

const SECRET = 'ab'.repeat(32)
const OTHER = 'ef'.repeat(32)
const TOKEN = 'cd'.repeat(32)
const VIEWER = '12'.repeat(32)
const UI = '34'.repeat(24)

const FULL: PageKind = { protocol: 'https:', hostname: '192.168.1.23' }
const WATCH: PageKind = { protocol: 'http:', hostname: '192.168.1.23' }
const LOOPBACK: PageKind = { protocol: 'http:', hostname: '127.0.0.1' }
const PROXIED: PageKind = { protocol: 'https:', hostname: 'my-mac.tail1234.ts.net' }

class FakeStorage implements TokenStorage {
  data = new Map<string, string>()
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, value) }
  removeItem(key: string) { this.data.delete(key) }
}

/** A storage that refuses writes, as Safari's does in a private window. */
class FullStorage extends FakeStorage {
  setItem(): void { throw new Error('QuotaExceededError') }
}

function page(kind: PageKind, hash = '') {
  const location: HashLocation & PageKind = { pathname: '/', search: '', hash, ...kind }
  const calls: Array<string | null | undefined> = []
  const history: ReplaceHistory = { state: null, replaceState: (_d, _u, url) => { calls.push(url) } }
  return { location, history, calls }
}

afterEach(() => resetPhoneSecretMemory())

describe('where a phone secret may live', () => {
  it('isPrivateIPv4Host: RFC 1918 literals only, the same rule the server binds by', () => {
    const cases: Array<[string, boolean]> = [
      ['192.168.1.23', true], ['10.0.0.5', true], ['172.16.0.1', true], ['172.31.255.254', true],
      ['172.15.0.1', false], ['172.32.0.1', false], ['192.169.1.1', false], ['11.0.0.1', false],
      ['127.0.0.1', false], ['169.254.10.10', false],
      // Tailscale's CGNAT range: reachable from every tailnet device, so never "the Wi-Fi"
      ['100.64.0.1', false],
      ['8.8.8.8', false], ['localhost', false], ['my-mac.local', false], ['my-mac.tail1234.ts.net', false],
      ['192.168.1', false], ['192.168.1.256', false], ['192.168.1.23.', false], ['[::1]', false], ['', false],
    ]
    for (const [host, want] of cases) {
      expect(isPrivateIPv4Host(host), host).toBe(want)
      // Dotted quads only: the server's rule takes an address, not a hostname
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) expect(isPrivateIPv4(host), `server ${host}`).toBe(want)
    }
  })

  it('isPhoneFullLocation: https AND a private IPv4 literal, nothing else', () => {
    expect(isPhoneFullLocation(FULL)).toBe(true)
    expect(isPhoneFullLocation({ protocol: 'https:', hostname: '10.1.2.3' })).toBe(true)
    // The watch-only listener: same address, plain http
    expect(isPhoneFullLocation(WATCH)).toBe(false)
    expect(isPhoneFullLocation(LOOPBACK)).toBe(false)
    expect(isPhoneFullLocation({ protocol: 'https:', hostname: '127.0.0.1' })).toBe(false)
    expect(isPhoneFullLocation({ protocol: 'https:', hostname: 'localhost' })).toBe(false)
    // An https NAME (tailscale serve) is the office-token page, never the phone-secret page
    expect(isPhoneFullLocation(PROXIED)).toBe(false)
    expect(isPhoneFullLocation({ protocol: 'https:', hostname: '8.8.8.8' })).toBe(false)
  })

  it('there is no phone-full page without a window (Node, the tests)', () => {
    expect(typeof window).toBe('undefined')
    expect(onPhoneFullPage()).toBe(false)
  })

  it('isPhoneSecret: 64 lowercase hex digits', () => {
    expect(isPhoneSecret(SECRET)).toBe(true)
    expect(isPhoneSecret(SECRET.toUpperCase())).toBe(false)
    expect(isPhoneSecret(SECRET.slice(2))).toBe(false)
    expect(isPhoneSecret(`${SECRET}00`)).toBe(false)
    expect(isPhoneSecret(PHONE_OFF)).toBe(false)
    expect(isPhoneSecret(null)).toBe(false)
  })
})

describe('capturePhoneSecret on the full-mode page', () => {
  it('keeps a well-formed secret under its own storage key and strips it from the address', () => {
    const storage = new FakeStorage()
    const { location, history, calls } = page(FULL, `#phone=${SECRET}&x=1`)
    expect(capturePhoneSecret(location, history, [storage])).toBe(SECRET)
    expect(storage.data.get(PHONE_SECRET_STORAGE)).toBe(SECRET)
    expect(storage.data.has(OFFICE_TOKEN_KEY)).toBe(false)
    expect(storage.data.has(VIEWER_KEY_STORAGE)).toBe(false)
    expect(calls).toEqual(['/#x=1'])
  })

  it('a later load without the fragment still holds it; a new link replaces it; #phone=off forgets it', () => {
    const storage = new FakeStorage()
    const first = page(FULL, `#phone=${SECRET}`)
    capturePhoneSecret(first.location, first.history, [storage])
    const plain = page(FULL)
    expect(capturePhoneSecret(plain.location, plain.history, [storage])).toBe(SECRET)
    expect(plain.calls).toEqual([])
    // After `npm run lan -- --full --rotate` the QR code is scanned again
    const rotated = page(FULL, `#phone=${OTHER}`)
    expect(capturePhoneSecret(rotated.location, rotated.history, [storage])).toBe(OTHER)
    expect(storage.data.get(PHONE_SECRET_STORAGE)).toBe(OTHER)
    const off = page(FULL, `#phone=${PHONE_OFF}`)
    expect(capturePhoneSecret(off.location, off.history, [storage])).toBeNull()
    expect(off.calls).toEqual(['/'])
    expect(getPhoneSecret([storage])).toBeNull()
  })

  it('a malformed secret is stripped, not kept, and does not displace the one already held', () => {
    const storage = new FakeStorage()
    const first = page(FULL, `#phone=${SECRET}`)
    capturePhoneSecret(first.location, first.history, [storage])
    const bad = page(FULL, '#phone=nope')
    expect(capturePhoneSecret(bad.location, bad.history, [storage])).toBe(SECRET)
    expect(bad.calls).toEqual(['/'])
    clearPhoneSecret([storage])
    expect(getPhoneSecret([storage])).toBeNull()
  })

  it('a storage that refuses writes (a private window): held in memory for this page load, no stale copy left behind', () => {
    const storage = new FullStorage()
    storage.data.set(PHONE_SECRET_STORAGE, OTHER)
    const p = page(FULL, `#phone=${SECRET}`)
    expect(capturePhoneSecret(p.location, p.history, [storage])).toBe(SECRET)
    expect(storage.data.has(PHONE_SECRET_STORAGE)).toBe(false)
    expect(p.calls).toEqual(['/'])
  })

  it('an address that cannot be rewritten still leaves the secret kept', () => {
    const storage = new FakeStorage()
    const p = page(FULL, `#phone=${SECRET}`)
    const history: ReplaceHistory = { state: null, replaceState: () => { throw new Error('SecurityError') } }
    expect(capturePhoneSecret(p.location, history, [storage])).toBe(SECRET)
  })
})

describe('capturePhoneSecret everywhere else: out of the address, kept nowhere', () => {
  const elsewhere: Array<[string, PageKind]> = [
    ['the watch-only listener (plain http on the Wi-Fi)', WATCH],
    ['the loopback office', LOOPBACK],
    ['an https proxy name', PROXIED],
    ['https on loopback', { protocol: 'https:', hostname: '127.0.0.1' }],
    ['plain http on a public address', { protocol: 'http:', hostname: '8.8.8.8' }],
  ]
  for (const [name, kind] of elsewhere) {
    it(name, () => {
      const storage = new FakeStorage()
      const p = page(kind, `#phone=${SECRET}&x=1`)
      expect(capturePhoneSecret(p.location, p.history, [storage])).toBeNull()
      expect(p.calls).toEqual(['/#x=1'])
      expect(storage.data.size).toBe(0)
      // ...and not in memory either
      expect(getPhoneSecret([storage])).toBeNull()
    })
  }

  it('a secret already in storage there is never returned (nothing to present over plain http)', () => {
    const storage = new FakeStorage()
    storage.data.set(PHONE_SECRET_STORAGE, SECRET)
    const p = page(WATCH)
    expect(capturePhoneSecret(p.location, p.history, [storage])).toBeNull()
  })

  it('#phone=off there strips the address and clears nothing it does not own', () => {
    const storage = new FakeStorage()
    storage.data.set(OFFICE_TOKEN_KEY, TOKEN)
    const p = page(LOOPBACK, `#phone=${PHONE_OFF}`)
    expect(capturePhoneSecret(p.location, p.history, [storage])).toBeNull()
    expect(p.calls).toEqual(['/'])
    expect(storage.data.get(OFFICE_TOKEN_KEY)).toBe(TOKEN)
  })
})

describe('what the full-mode page presents', () => {
  it('the WebSocket: the phone secret as a subprotocol, under the name the server reads', () => {
    expect(SERVER_PREFIX).toBe(WS_PHONE_PROTOCOL_PREFIX)
    expect(phoneWsProtocols(SECRET)).toEqual([WS_PROTOCOL, `${WS_PHONE_PROTOCOL_PREFIX}${SECRET}`])
    expect(phoneWsProtocols(null)).toEqual([WS_PROTOCOL])
    expect(phoneWsProtocols('nope')).toEqual([WS_PROTOCOL])
  })

  it('pageWsProtocols on a phone page: never the office token or the viewer key, with or without a secret', () => {
    const withSecret = pageWsProtocols({ viewerKey: VIEWER, safe: true, token: TOKEN, phone: { secret: SECRET } })
    expect(withSecret).toEqual([WS_PROTOCOL, `${WS_PHONE_PROTOCOL_PREFIX}${SECRET}`])
    const without = pageWsProtocols({ viewerKey: VIEWER, safe: true, token: TOKEN, phone: { secret: null } })
    expect(without).toEqual([WS_PROTOCOL])
    for (const list of [withSecret, without]) {
      expect(list.join(' ')).not.toContain(TOKEN)
      expect(list.join(' ')).not.toContain(VIEWER)
    }
  })

  it('officeAuthHeaders: the phone secret on reads and writes alike, never a token', () => {
    const held = { loc: FULL, uiToken: UI, officeToken: TOKEN, phoneSecret: SECRET }
    expect(officeAuthHeaders(held)).toEqual({ Authorization: `Bearer ${SECRET}` })
    expect(officeAuthHeaders({ ...held, method: 'POST' })).toEqual({ Authorization: `Bearer ${SECRET}` })
    // No secret: nothing at all, rather than a token the listener would count as a wrong secret
    expect(officeAuthHeaders({ ...held, phoneSecret: null })).toEqual({})
    expect(officeAuthHeaders({ ...held, phoneSecret: null, method: 'POST' })).toEqual({})
  })

  it('officeAuthHeaders off the full-mode page never sends the phone secret', () => {
    for (const loc of [WATCH, LOOPBACK]) {
      expect(officeAuthHeaders({ loc, uiToken: UI, officeToken: TOKEN, phoneSecret: SECRET })).toEqual({})
    }
    expect(officeAuthHeaders({ loc: PROXIED, uiToken: UI, officeToken: TOKEN, phoneSecret: SECRET })).toEqual({ Authorization: `Bearer ${UI}` })
  })

  it('the plain-HTTP rule for the office token is as it was', () => {
    expect(mayCarryOfficeToken(WATCH)).toBe(false)
    expect(mayCarryOfficeToken({ protocol: 'http:', hostname: '10.0.0.5' })).toBe(false)
  })
})

describe('the full-mode page talks only to the listener that served it', () => {
  const at = (url: string) => {
    const u = new URL(url)
    return { protocol: u.protocol, hostname: u.hostname, host: u.host, port: u.port, origin: u.origin }
  }
  it('wss and https on its own origin', () => {
    const loc = at('https://192.168.1.23:3335/')
    expect(sameOriginWsUrl(loc)).toBe('wss://192.168.1.23:3335/ws')
    expect(officeHttpBase(loc, { dev: false })).toBe('https://192.168.1.23:3335')
    expect(officeWsUrl(loc, { dev: false })).toBe('wss://192.168.1.23:3335/ws')
  })
  it('even on port 3333 or in a dev bundle: the secret never goes to http://127.0.0.1', () => {
    const loc = at('https://192.168.1.23:3333/')
    for (const env of [{ dev: false }, { dev: true, port: '3334' }]) {
      expect(isDevServerPage(loc, env)).toBe(false)
      expect(officeHttpBase(loc, env)).toBe('https://192.168.1.23:3333')
      expect(officeWsUrl(loc, env)).toBe('wss://192.168.1.23:3333/ws')
    }
    // The watch-only page on 3333 keeps the rule it always had
    expect(isDevServerPage(at('http://192.168.1.23:3333/'), { dev: false })).toBe(true)
  })
})

describe('the page wires the secret in, and only where it belongs', () => {
  const code = (file: string) => readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')

  it('main.tsx captures before App is evaluated', () => {
    const main = readFileSync('src/main.tsx', 'utf8')
    expect(main.indexOf("from './pageAuth'")).toBeGreaterThan(-1)
    expect(main.indexOf("from './pageAuth'")).toBeLessThan(main.indexOf("from './App'"))
  })

  it('the socket offers the phone secret alone on a phone-full page, and App dials the page origin', () => {
    const socket = code('src/hooks/useAgentSocket.ts')
    expect(socket).toMatch(/onPhoneFullPage\(\)/)
    expect(socket).toMatch(/phone: \{ secret: getPhoneSecret\(\) \}/)
    const app = code('src/App.tsx')
    expect(app).toMatch(/isViewerMode \|\| isPhoneFull \? sameOriginWsUrl\(\) : officeWsUrl\(\)/)
    // No socket at all without a secret: every attempt would be a refused handshake
    expect(app).toMatch(/disabled: isSimMode \|\| \(isPhoneFull && !phoneHasSecret\)/)
  })

  it('nothing but phoneSecret.ts touches the storage key, and the layout holds no credential', () => {
    const files = ['src', 'src/components', 'src/hooks'].flatMap(d => readdirSync(d).filter(f => /\.tsx?$/.test(f)).map(f => join(d, f)))
    for (const file of files) {
      if (file === join('src', 'phoneSecret.ts')) continue
      expect(code(file), file).not.toMatch(/agent-office\.phone['"`]|PHONE_SECRET_STORAGE/)
    }
    const layout = code('src/components/PhoneOffice.tsx')
    expect(layout).not.toMatch(/getPhoneSecret|getOfficeToken|getUiToken|localStorage|\bfetch\(/)
  })
})

describe('PhoneOffice: the room and the panel on a phone screen', () => {
  it('portrait 390 x 844: the room fits the width and leaves at least half the height for cards, chat and tabs', () => {
    const scale = phoneStageScale(390, 760)
    // To a rounding error: 390 / 756 * 756 is 390.00000000000006 in floating point
    expect(STAGE_W * scale).toBeCloseTo(390, 6)
    expect(STAGE_H * scale).toBeLessThanOrEqual(760 / 2)
  })

  it('a short portrait box caps the room at half its height', () => {
    const scale = phoneStageScale(390, 500)
    expect(STAGE_H * scale).toBeCloseTo(250, 5)
    expect(STAGE_W * scale).toBeLessThan(390)
  })

  it('landscape 844 x 390: the room beside the panel, inside the height, the panel keeping 45% of the width', () => {
    const scale = phoneStageScale(844, 340)
    expect(STAGE_H * scale).toBeLessThanOrEqual(340)
    expect(STAGE_W * scale).toBeLessThanOrEqual(844 * 0.55 + 1e-9)
  })

  it('a box not measured yet does not collapse the room', () => {
    expect(phoneStageScale(0, 0)).toBe(1)
    expect(phoneStageScale(Number.NaN, 300)).toBe(1)
  })

  it('the keyboard does not turn the phone: orientation comes from the tallest box at this width', () => {
    let box = nextPhoneBox(null, 390, 760)
    expect(phoneIsLandscape(box)).toBe(false)
    // Keyboard up: the visible box is wider than tall, the phone is still upright
    box = nextPhoneBox(box, 390, 380)
    expect(box).toEqual({ w: 390, h: 380, tallest: 760 })
    expect(phoneIsLandscape(box)).toBe(false)
    expect(phoneIsCompact(phoneIsLandscape(box), box.h)).toBe(true)
    // The room would be drawn at the portrait scale, not squeezed beside the panel
    expect(phoneStageScale(box.w, box.h, false)).toBeCloseTo(190 / STAGE_H, 6)
    // Keyboard down again, then a real rotation (the width changes)
    box = nextPhoneBox(box, 390, 760)
    expect(phoneIsCompact(phoneIsLandscape(box), box.h)).toBe(false)
    box = nextPhoneBox(box, 844, 340)
    expect(box).toEqual({ w: 844, h: 340, tallest: 340 })
    expect(phoneIsLandscape(box)).toBe(true)
    // Landscape is short by nature and lays the room beside the panel instead of hiding it
    expect(phoneIsCompact(phoneIsLandscape(box), box.h)).toBe(false)
    // An unchanged measurement is the same object: no render
    expect(nextPhoneBox(box, 844, 340)).toBe(box)
    // A sub-pixel width change is not a rotation
    expect(nextPhoneBox({ w: 390, h: 380, tallest: 760 }, 390.5, 380).tallest).toBe(760)
    expect(phoneIsCompact(false, 0)).toBe(false)
  })

  it('visibleBox follows the keyboard, and leaves a pinch-zoomed page alone', () => {
    expect(visibleBox({ height: 480, offsetTop: 0, scale: 1 })).toEqual({ top: 0, height: 480 })
    expect(visibleBox({ height: 480, offsetTop: 12, scale: 1 })).toEqual({ top: 12, height: 480 })
    expect(visibleBox({ height: 400, offsetTop: 100, scale: 2 })).toBeNull()
    expect(visibleBox({ height: 0, offsetTop: 0, scale: 1 })).toBeNull()
    expect(visibleBox(null)).toBeNull()
    expect(visibleBox(undefined)).toBeNull()
  })

  it('chat, meters, today and settings each have a tab', () => {
    expect([...PHONE_TABS]).toEqual(['chat', 'meters', 'today', 'settings'])
  })
})

describe('phone.css cannot reach the desktop window or the watch-only stage', () => {
  const css = readFileSync('src/styles/phone.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('every selector is under .phone-wrapper or names a phone-only class', () => {
    // Rule heads only: strip declaration blocks, then the at-rule wrappers
    const heads = css.replace(/\{[^{}]*\}/g, '{}').replace(/@media[^{]*\{/g, '').replace(/[{}]/g, '\n')
    const selectors = heads.split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    expect(selectors.length).toBeGreaterThan(60)
    for (const selector of selectors) {
      expect(/\.phone-|\.perm-remember-note/.test(selector), selector).toBe(true)
    }
  })

  it('honours the safe-area insets and reduced motion, as the watch-only stage does', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) expect(css).toContain(`env(safe-area-inset-${side}, 0px)`)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toContain('100dvh')
  })

  it('the chat field is 16 px (iOS zooms the page into anything smaller) and the answer buttons are 44 px', () => {
    expect(css).toMatch(/\.phone-wrapper \.slack-input-field \{[^}]*font-size: 16px/)
    expect(css).toMatch(/\.phone-wrapper \.perm-btn \{[^}]*min-height: 44px/)
  })

  it('viewer.css and the desktop stylesheets do not mention the phone layout', () => {
    for (const file of ['viewer.css', 'office.css', 'permission.css', 'settings.css', 'meters.css', 'inspector.css']) {
      expect(readFileSync(`src/styles/${file}`, 'utf8'), file).not.toContain('phone-')
    }
  })
})
