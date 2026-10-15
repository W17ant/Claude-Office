/**
 * The office link outside the page: the helpers the desktop app and
 * `npm run open` share (electron/helpers.cjs), `npm run open` itself
 * (scripts/open-office.mjs) against a real office on an ephemeral port with
 * a fake opener, and `npm run rotate-token` (scripts/rotate-token.mjs).
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, removeOffice, type Office } from './helpers'
import { openOffice, openerFor, REDIRECT_FILE_NAME } from '../scripts/open-office.mjs'
import { rotateToken } from '../scripts/rotate-token.mjs'

const require = createRequire(import.meta.url)
const h = require('../electron/helpers.cjs')

const TOKEN = '0123456789abcdef'.repeat(4)
const dirs: string[] = []
function tempDir(prefix = 'agent-office-open-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** A writable stream stand-in that keeps what was written. */
function sink() {
  const s = { text: '', write(chunk: string) { s.text += chunk; return true } }
  return s
}

function fakeOpener(bin: string, name: string, exitCode: number, log: string) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${log}"\nexit ${exitCode}\n`)
  chmodSync(join(bin, name), 0o755)
}

describe('electron/helpers.cjs: the office link', () => {
  it('runtimeDirFromEnv follows AGENT_OFFICE_HOME like the server', () => {
    expect(h.runtimeDirFromEnv({ AGENT_OFFICE_HOME: '/tmp/x' }, '/home/me')).toBe('/tmp/x')
    expect(h.runtimeDirFromEnv({}, '/home/me')).toBe('/home/me/.agent-office')
    expect(h.runtimeDirFromEnv({ AGENT_OFFICE_HOME: '' }, '/home/me')).toBe('/home/me/.agent-office')
  })

  it('readOfficeToken: a well-formed token (trailing newline allowed), else null', () => {
    const dir = tempDir()
    const file = join(dir, 'auth-token')
    expect(h.readOfficeToken(file)).toBeNull()
    writeFileSync(file, `${TOKEN}\n`)
    expect(h.readOfficeToken(file)).toBe(TOKEN)
    writeFileSync(file, 'nope')
    expect(h.readOfficeToken(file)).toBeNull()
  })

  it('officeLink puts the token in the fragment; no (or a malformed) token is the bare page', () => {
    expect(h.officeLink('http://127.0.0.1:3334', TOKEN)).toBe(`http://127.0.0.1:3334/#token=${TOKEN}`)
    expect(h.officeLink('http://localhost:3333/', TOKEN)).toBe(`http://localhost:3333/#token=${TOKEN}`)
    expect(h.officeLink('http://127.0.0.1:3334', null)).toBe('http://127.0.0.1:3334/')
    expect(h.officeLink('http://127.0.0.1:3334', 'x"><script>')).toBe('http://127.0.0.1:3334/')
  })

  it('redactLink masks the token for a log line', () => {
    expect(h.redactLink(`http://127.0.0.1:3334/#token=${TOKEN}`)).toBe('http://127.0.0.1:3334/#token=…')
    expect(h.redactLink('http://127.0.0.1:3334/')).toBe('http://127.0.0.1:3334/')
  })

  it('redirectPage goes straight on to the link (meta refresh and script), with the link as a fallback', () => {
    const link = h.officeLink('http://127.0.0.1:3334', TOKEN)
    const html = h.redirectPage(link)
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${link}">`)
    expect(html).toContain(`location.replace(${JSON.stringify(link)})`)
    expect(html).toContain(`<a href="${link}">`)
    expect(html).toContain('<meta name="referrer" content="no-referrer">')
    // Escaped, whatever it is handed
    expect(h.redirectPage('http://x/"><script>alert(1)</script>')).not.toContain('<script>alert(1)')
  })

  it('writeRedirectPage writes it 0600 and replaces a planted symlink instead of writing through it', () => {
    const dir = tempDir()
    const other = join(tempDir(), 'victim')
    writeFileSync(other, 'untouched')
    const file = join(dir, REDIRECT_FILE_NAME)
    symlinkSync(other, file)
    h.writeRedirectPage(file, h.officeLink('http://127.0.0.1:3334', TOKEN))
    expect(lstatSync(file).isSymbolicLink()).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain(TOKEN)
    expect(readFileSync(other, 'utf8')).toBe('untouched')
  })
})

describe('npm run open (scripts/open-office.mjs)', () => {
  let office: Office
  let port: number
  let home: string
  let uiDir: string

  beforeAll(async () => {
    uiDir = tempDir('agent-office-ui-')
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>office</title>')
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
    port = await listen(office.server.httpServer)
    // The runtime dir the script reads: the running office's token, as start() writes it
    home = tempDir('agent-office-home-')
    writeFileSync(join(home, 'auth-token'), office.server.AUTH_TOKEN, { mode: 0o600 })
  })
  afterAll(async () => {
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  const envFor = (extra: Record<string, string> = {}) => ({ ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(port), ...extra })

  it('openerFor: open on macOS, explorer on Windows, xdg-open elsewhere', () => {
    expect(openerFor('darwin', 'file:///x')).toEqual(['open', ['file:///x']])
    expect(openerFor('win32', 'file:///x')).toEqual(['explorer.exe', ['file:///x']])
    expect(openerFor('linux', 'file:///x')).toEqual(['xdg-open', ['file:///x']])
  })

  it('--print prints the server\'s link with the token and opens nothing', async () => {
    const out = sink()
    const err = sink()
    expect(await openOffice({ env: envFor(), print: true, out, err })).toBe(0)
    expect(out.text).toBe(`Agent Office: http://127.0.0.1:${port}/#token=${office.server.AUTH_TOKEN}\n`)
    expect(existsSync(join(home, REDIRECT_FILE_NAME))).toBe(false)
  })

  it('--dev points at the Vite dev server instead', async () => {
    const out = sink()
    expect(await openOffice({ env: envFor({ AGENT_OFFICE_UI_PORT: '3998' }), dev: true, print: true, out, err: sink() })).toBe(0)
    expect(out.text).toBe(`Agent Office: http://localhost:3998/#token=${office.server.AUTH_TOKEN}\n`)
  })

  it('opens a 0600 redirect page in the runtime dir, so the token is never on the opener\'s command line', async () => {
    const bin = tempDir('agent-office-bin-')
    const log = join(bin, 'opened.log')
    fakeOpener(bin, 'xdg-open', 0, log)
    const out = sink()
    const code = await openOffice({ env: envFor({ PATH: `${bin}:${process.env.PATH}` }), platform: 'linux', out, err: sink() })
    expect(code).toBe(0)
    const args = readFileSync(log, 'utf8').trim().split('\n')
    const page = join(home, REDIRECT_FILE_NAME)
    expect(args).toEqual([`file://${page}`])
    expect(args.join(' ')).not.toContain(office.server.AUTH_TOKEN)
    expect(statSync(page).mode & 0o777).toBe(0o600)
    expect(readFileSync(page, 'utf8')).toContain(`http://127.0.0.1:${port}/#token=${office.server.AUTH_TOKEN}`)
    expect(out.text).toContain('Opened it in your browser')
    expect(fileURLToPath(`file://${page}`)).toBe(page)
  })

  it('an opener that fails: the link is printed to paste, and that is still a success', async () => {
    const bin = tempDir('agent-office-bin-')
    fakeOpener(bin, 'xdg-open', 3, join(bin, 'opened.log'))
    const out = sink()
    const err = sink()
    expect(await openOffice({ env: envFor({ PATH: `${bin}:${process.env.PATH}` }), platform: 'linux', out, err })).toBe(0)
    expect(out.text).toContain(`#token=${office.server.AUTH_TOKEN}`)
    expect(err.text).toContain('Could not open a browser automatically')
  })

  it('no token file: says to start the office first, exit 1', async () => {
    const err = sink()
    expect(await openOffice({ env: envFor({ AGENT_OFFICE_HOME: tempDir() }), out: sink(), err })).toBe(1)
    expect(err.text).toContain('No office token in')
  })

  it('no server: prints the link (the token outlives a restart) but says to start it, exit 1', async () => {
    const out = sink()
    const err = sink()
    expect(await openOffice({ env: envFor({ AGENT_OFFICE_PORT: '1' }), out, err })).toBe(1)
    expect(out.text).toContain(`#token=${office.server.AUTH_TOKEN}`)
    expect(err.text).toContain('not answering on port 1')
  })
})

describe('npm run rotate-token (scripts/rotate-token.mjs)', () => {
  let office: Office
  let port: number
  beforeAll(async () => {
    office = await loadOffice()
    port = await listen(office.server.httpServer)
  })
  afterAll(async () => {
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('refuses while the office runs (it would keep the old token), deletes with --force', async () => {
    const home = tempDir()
    const file = join(home, 'auth-token')
    writeFileSync(file, TOKEN, { mode: 0o600 })
    const env = { ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: String(port) }
    const err = sink()
    expect(await rotateToken({ env, out: sink(), err })).toBe(1)
    expect(existsSync(file)).toBe(true)
    expect(err.text).toContain('Stop it first')
    const forced = sink()
    expect(await rotateToken({ env, force: true, out: sink(), err: forced })).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(forced.text).toContain('restart it now')
  })

  it('with the office stopped: deletes the file, and the next start mints a new token', async () => {
    const home = tempDir()
    const file = join(home, 'auth-token')
    writeFileSync(file, TOKEN, { mode: 0o600 })
    const out = sink()
    expect(await rotateToken({ env: { ...process.env, AGENT_OFFICE_HOME: home, AGENT_OFFICE_PORT: '1' }, out, err: sink() })).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(out.text).toContain('the next start writes a new office token')
    const next = await loadOffice({ dir: home })
    expect(next.server.AUTH_TOKEN).not.toBe(TOKEN)
    expect(next.server.REUSED_TOKEN).toBeNull()
  })
})
