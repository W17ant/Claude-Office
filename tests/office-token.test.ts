/**
 * src/officeToken.ts — how the page takes the office token from the link
 * (`#token=` in the fragment), keeps it, strips it from the address bar and
 * offers it to the WebSocket; and how the permission card looks on a page
 * the server showed read-only. Node only: the location, history and storages
 * are fakes.
 */

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OFFICE_TOKEN_KEY, WS_PROTOCOL, WS_TOKEN_PROTOCOL_PREFIX,
  captureOfficeToken, clearOfficeToken, getOfficeToken, officeWsProtocols, resetOfficeTokenMemory, setOfficeToken, splitTokenFromHash,
  type HashLocation, type ReplaceHistory, type TokenStorage,
} from '../src/officeToken'
import PermissionCards from '../src/components/PermissionCard'
import type { PermissionCardState } from '../src/permissions'

const TOKEN = 'ab'.repeat(32)
const NEWER = 'cd'.repeat(32)

class FakeStorage implements TokenStorage {
  data = new Map<string, string>()
  constructor(private readonly broken: 'none' | 'write' | 'all' = 'none') {}
  getItem(key: string) {
    if (this.broken === 'all') throw new Error('SecurityError')
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    if (this.broken !== 'none') throw new Error('QuotaExceededError')
    this.data.set(key, value)
  }
  removeItem(key: string) {
    if (this.broken === 'all') throw new Error('SecurityError')
    this.data.delete(key)
  }
}

function page(href: { pathname?: string; search?: string; hash?: string } = {}) {
  const location: HashLocation = { pathname: '/', search: '', hash: '', ...href }
  const calls: Array<{ data: unknown; url: string | null | undefined }> = []
  const history: ReplaceHistory = { state: { kept: true }, replaceState: (data, _unused, url) => { calls.push({ data, url }) } }
  return { location, history, calls }
}

afterEach(() => resetOfficeTokenMemory())

describe('splitTokenFromHash', () => {
  it('takes token= out of the fragment and keeps the other parameters verbatim', () => {
    expect(splitTokenFromHash(`#token=${TOKEN}`)).toEqual({ found: true, token: TOKEN, rest: '' })
    expect(splitTokenFromHash(`#view=compact&token=${TOKEN}&x`)).toEqual({ found: true, token: TOKEN, rest: 'view=compact&x' })
    expect(splitTokenFromHash(`token=${TOKEN}`)).toEqual({ found: true, token: TOKEN, rest: '' })
  })

  it('a malformed token is found (so it is stripped) but not taken', () => {
    expect(splitTokenFromHash('#token=abc')).toEqual({ found: true, token: null, rest: '' })
    expect(splitTokenFromHash(`#token=${TOKEN.toUpperCase()}`)).toEqual({ found: true, token: null, rest: '' })
    expect(splitTokenFromHash(`#token=${TOKEN}0`)).toEqual({ found: true, token: null, rest: '' })
  })

  it('no token: nothing found, the fragment untouched', () => {
    expect(splitTokenFromHash('')).toEqual({ found: false, token: null, rest: '' })
    expect(splitTokenFromHash('#section-2')).toEqual({ found: false, token: null, rest: 'section-2' })
    expect(splitTokenFromHash('#mytoken=1')).toEqual({ found: false, token: null, rest: 'mytoken=1' })
  })
})

describe('captureOfficeToken (hash -> storage -> replaceState)', () => {
  it('keeps the token in localStorage and replaces the address with the same path and query, without the fragment', () => {
    const local = new FakeStorage()
    const session = new FakeStorage()
    const { location, history, calls } = page({ pathname: '/', search: '?variant=incident', hash: `#token=${TOKEN}` })
    expect(captureOfficeToken(location, history, [local, session])).toBe(TOKEN)
    expect(local.data.get(OFFICE_TOKEN_KEY)).toBe(TOKEN)
    expect(session.data.size).toBe(0)
    expect(calls).toEqual([{ data: { kept: true }, url: '/?variant=incident' }])
  })

  it('keeps the other fragment parameters in the new address', () => {
    const { location, history, calls } = page({ hash: `#a=1&token=${TOKEN}` })
    captureOfficeToken(location, history, [new FakeStorage()])
    expect(calls[0].url).toBe('/#a=1')
  })

  it('a newer link replaces the token kept before (a rotation)', () => {
    const local = new FakeStorage()
    local.data.set(OFFICE_TOKEN_KEY, TOKEN)
    const { location, history } = page({ hash: `#token=${NEWER}` })
    expect(captureOfficeToken(location, history, [local])).toBe(NEWER)
    expect(local.data.get(OFFICE_TOKEN_KEY)).toBe(NEWER)
  })

  it('a malformed token is stripped from the address but not kept; the old one stays', () => {
    const local = new FakeStorage()
    local.data.set(OFFICE_TOKEN_KEY, TOKEN)
    const { location, history, calls } = page({ hash: '#token=<script>' })
    expect(captureOfficeToken(location, history, [local])).toBe(TOKEN)
    expect(local.data.get(OFFICE_TOKEN_KEY)).toBe(TOKEN)
    expect(calls).toEqual([{ data: { kept: true }, url: '/' }])
  })

  it('no token in the address: the address is left alone and the kept token is returned', () => {
    const local = new FakeStorage()
    local.data.set(OFFICE_TOKEN_KEY, TOKEN)
    const { location, history, calls } = page({ hash: '#section' })
    expect(captureOfficeToken(location, history, [local])).toBe(TOKEN)
    expect(calls).toEqual([])
    expect(captureOfficeToken(page().location, page().history, [new FakeStorage()])).toBeNull()
  })

  it('localStorage refuses: sessionStorage keeps it; both refuse: memory, for this page', () => {
    const local = new FakeStorage('write')
    const session = new FakeStorage()
    const first = page({ hash: `#token=${TOKEN}` })
    expect(captureOfficeToken(first.location, first.history, [local, session])).toBe(TOKEN)
    expect(session.data.get(OFFICE_TOKEN_KEY)).toBe(TOKEN)

    resetOfficeTokenMemory()
    const broken = [new FakeStorage('all'), new FakeStorage('all')]
    const second = page({ hash: `#token=${NEWER}` })
    expect(captureOfficeToken(second.location, second.history, broken)).toBe(NEWER)
    expect(getOfficeToken(broken)).toBe(NEWER)
    expect(second.calls).toHaveLength(1)
  })

  it('a storage that refuses the new token drops its old copy, so it cannot shadow the new one', () => {
    const local = new FakeStorage()
    local.data.set(OFFICE_TOKEN_KEY, TOKEN)
    const refusing: TokenStorage = { getItem: k => local.getItem(k), setItem: () => { throw new Error('full') }, removeItem: k => local.removeItem(k) }
    const session = new FakeStorage()
    setOfficeToken(NEWER, [refusing, session])
    expect(getOfficeToken([refusing, session])).toBe(NEWER)
  })

  it('a replaceState that throws still leaves the token kept', () => {
    const local = new FakeStorage()
    const history: ReplaceHistory = { state: null, replaceState: () => { throw new Error('SecurityError') } }
    expect(captureOfficeToken({ pathname: '/', search: '', hash: `#token=${TOKEN}` }, history, [local])).toBe(TOKEN)
  })
})

describe('getOfficeToken / clearOfficeToken', () => {
  it('ignores a malformed stored value and reads storage afresh each time (another tab may have a newer token)', () => {
    const local = new FakeStorage()
    local.data.set(OFFICE_TOKEN_KEY, 'garbage')
    expect(getOfficeToken([local])).toBeNull()
    local.data.set(OFFICE_TOKEN_KEY, TOKEN)
    expect(getOfficeToken([local])).toBe(TOKEN)
    local.data.set(OFFICE_TOKEN_KEY, NEWER)
    expect(getOfficeToken([local])).toBe(NEWER)
  })

  it('clear forgets it everywhere', () => {
    const local = new FakeStorage()
    const session = new FakeStorage()
    setOfficeToken(TOKEN, [local, session])
    session.data.set(OFFICE_TOKEN_KEY, TOKEN)
    clearOfficeToken([local, session])
    expect(getOfficeToken([local, session])).toBeNull()
  })
})

describe('officeWsProtocols (what useAgentSocket offers on every (re)connect)', () => {
  it('the office protocol, plus the token when the page has a well-formed one', () => {
    expect(officeWsProtocols(TOKEN)).toEqual([WS_PROTOCOL, `${WS_TOKEN_PROTOCOL_PREFIX}${TOKEN}`])
    expect(officeWsProtocols(TOKEN)).toEqual(['agent-office', `agent-office.token.${TOKEN}`])
    expect(officeWsProtocols(null)).toEqual(['agent-office'])
    expect(officeWsProtocols(undefined)).toEqual(['agent-office'])
    // Never a value the WebSocket constructor would throw on
    expect(officeWsProtocols('has space, comma')).toEqual(['agent-office'])
  })

  it('the token goes in a subprotocol, never in the URL', async () => {
    const { officeWsUrl } = await import('../src/serverUrl')
    expect(officeWsUrl()).not.toContain('token')
  })

  it('useAgentSocket builds its socket with it and reads the server\'s `auth` verdict', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/hooks/useAgentSocket.ts', import.meta.url), 'utf8')
    expect(source).toContain('new WebSocket(url, officeWsProtocols())')
    expect(source).toMatch(/msg\.type === 'auth'/)
  })
})

describe('the permission card on a read-only page', () => {
  const card: PermissionCardState = {
    id: 'p1', sessionId: 's-1', project: 'alpha', toolName: 'Bash', summary: 'git push',
    suggestions: [], permissionMode: 'default', createdAt: 1_000, deadline: Date.now() + 60_000, status: 'pending', interactive: false,
  } as PermissionCardState
  const render = (readOnly: boolean) =>
    renderToStaticMarkup(React.createElement(PermissionCards, { cards: [card], dispatch: () => {}, readOnly }))

  it('shows which tool waits, offers no answer buttons, and points at the terminal', () => {
    const html = render(true)
    expect(html).toContain('Claude wants to run Bash')
    expect(html).toContain('data-testid="permission-read-only"')
    expect(html).not.toContain('perm-btn')
  })

  it('a trusted page keeps its Allow / Deny buttons', () => {
    const html = render(false)
    expect(html).toContain('perm-btn allow')
    expect(html).toContain('perm-btn deny')
    expect(html).not.toContain('permission-read-only')
  })
})
