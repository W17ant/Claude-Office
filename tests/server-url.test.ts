/**
 * src/serverUrl.ts — the page derives the server's address from where it was
 * loaded: its own origin when the office server serves it (any port, http or
 * https), the port Vite was told about (VITE_AGENT_OFFICE_PORT) on the page's
 * hostname when the Vite dev server serves it.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERVER_PORT, VITE_DEV_PORT,
  configuredServerPort, isDevServerPage, officeHttpBase, officeWsUrl,
  type BuildEnv, type PageLocation,
} from '../src/serverUrl'

/** A window.location for a URL. */
function at(url: string): PageLocation {
  const u = new URL(url)
  return { protocol: u.protocol, hostname: u.hostname, host: u.host, port: u.port, origin: u.origin }
}

/** import.meta.env of a production bundle built with the given AGENT_OFFICE_PORT. */
const built = (port = '3334'): BuildEnv => ({ dev: false, port })
/** import.meta.env under `vite` (dev) with the given AGENT_OFFICE_PORT. */
const dev = (port = '3334'): BuildEnv => ({ dev: true, port })

describe('served by the office server', () => {
  it('on the default port: the page origin and ws://<host>/ws', () => {
    const loc = at('http://127.0.0.1:3334/')
    expect(isDevServerPage(loc, built())).toBe(false)
    expect(officeHttpBase(loc, built())).toBe('http://127.0.0.1:3334')
    expect(officeWsUrl(loc, built())).toBe('ws://127.0.0.1:3334/ws')
  })

  it('on a configured port (AGENT_OFFICE_PORT=4000): the page origin, whatever the bundle was built with', () => {
    const loc = at('http://localhost:4000/?video')
    expect(officeHttpBase(loc, built('4000'))).toBe('http://localhost:4000')
    expect(officeWsUrl(loc, built('4000'))).toBe('ws://localhost:4000/ws')
    // A bundle built without the variable is served on 4000 just the same
    expect(officeHttpBase(loc, built('3334'))).toBe('http://localhost:4000')
    expect(officeWsUrl(loc, built('3334'))).toBe('ws://localhost:4000/ws')
  })

  it('over https: wss on the same host', () => {
    const loc = at('https://office.example:8443/')
    expect(officeHttpBase(loc, built())).toBe('https://office.example:8443')
    expect(officeWsUrl(loc, built())).toBe('wss://office.example:8443/ws')
    const plain = at('https://office.example/')
    expect(officeWsUrl(plain, built())).toBe('wss://office.example/ws')
  })

  it('by IPv6 loopback: the bracketed host is kept', () => {
    const loc = at('http://[::1]:3334/')
    expect(officeHttpBase(loc, built())).toBe('http://[::1]:3334')
    expect(officeWsUrl(loc, built())).toBe('ws://[::1]:3334/ws')
  })
})

describe('served by the Vite dev server', () => {
  it('on 3333: the configured server port on the page hostname', () => {
    const loc = at('http://localhost:3333/')
    expect(isDevServerPage(loc, dev('3334'))).toBe(true)
    expect(officeHttpBase(loc, dev('3334'))).toBe('http://localhost:3334')
    expect(officeWsUrl(loc, dev('3334'))).toBe('ws://localhost:3334/ws')
    expect(officeHttpBase(loc, dev('4000'))).toBe('http://localhost:4000')
    expect(officeWsUrl(loc, dev('4000'))).toBe('ws://localhost:4000/ws')
  })

  it('opened by IP (what start-office.sh prints): the hostname follows the page', () => {
    const loc = at('http://127.0.0.1:3333/?sim')
    expect(officeHttpBase(loc, dev('4000'))).toBe('http://127.0.0.1:4000')
    expect(officeWsUrl(loc, dev('4000'))).toBe('ws://127.0.0.1:4000/ws')
  })

  it('`vite --port 3400` (AGENT_OFFICE_UI_PORT): still dev, by import.meta.env.DEV', () => {
    const loc = at('http://localhost:3400/')
    expect(isDevServerPage(loc, dev('4000'))).toBe(true)
    expect(officeHttpBase(loc, dev('4000'))).toBe('http://localhost:4000')
  })

  it('a page on 3333 counts as dev even when the env does not say so', () => {
    const loc = at('http://localhost:3333/')
    expect(isDevServerPage(loc, built('4000'))).toBe(true)
    expect(officeWsUrl(loc, built('4000'))).toBe('ws://localhost:4000/ws')
    expect(VITE_DEV_PORT).toBe(3333)
  })
})

describe('configuredServerPort', () => {
  it('is the define when it is a port, 3334 otherwise', () => {
    expect(configuredServerPort({ dev: true, port: '4000' })).toBe(4000)
    expect(configuredServerPort({ dev: true, port: 4123 })).toBe(4123)
    expect(configuredServerPort({ dev: true })).toBe(DEFAULT_SERVER_PORT)
    expect(configuredServerPort({ dev: true, port: 'abc' })).toBe(DEFAULT_SERVER_PORT)
    expect(configuredServerPort({ dev: true, port: '0' })).toBe(DEFAULT_SERVER_PORT)
    expect(configuredServerPort({ dev: true, port: '70000' })).toBe(DEFAULT_SERVER_PORT)
    expect(DEFAULT_SERVER_PORT).toBe(3334)
  })
})

describe('without a window (Node, the tests)', () => {
  it('falls back to the default server on 127.0.0.1 instead of throwing', () => {
    expect(typeof window).toBe('undefined')
    expect(officeHttpBase()).toBe('http://127.0.0.1:3334')
    expect(officeWsUrl()).toBe('ws://127.0.0.1:3334/ws')
  })
})
