/** hooks/opencode-plugin.js — the OpenCode plugin signs and posts each bus event to /hook/opencode, and never throws into OpenCode. */

import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeOffice, signRequest } from '../hooks/opencode-plugin.js'

describe('opencode plugin', () => {
  let home: string
  const saved = { ...process.env }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'oc-plugin-'))
    writeFileSync(join(home, 'auth-token'), 'tok123\n')
    process.env.AGENT_OFFICE_HOME = home
    delete process.env.AGENT_OFFICE_RUN
    delete process.env.AGENT_OFFICE_PORT
  })
  afterEach(() => {
    process.env = { ...saved }
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it('signs the way the server checks: HMAC(token, method\\npath\\nts\\nbody)', () => {
    const want = createHmac('sha256', 'tok').update('POST\n/hook/opencode\n123\n{"a":1}').digest('hex')
    expect(signRequest('tok', '/hook/opencode', '123', '{"a":1}')).toBe(want)
  })

  it('posts a bus event, signed, to loopback with the directory added', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    const hooks = await ClaudeOffice({ directory: '/tmp/demo' } as any)
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:3334/hook/opencode')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ type: 'session.idle', properties: { sessionID: 's1' }, directory: '/tmp/demo' })
    const ts = init.headers['X-Office-Timestamp']
    expect(init.headers['X-Office-Signature']).toBe(signRequest('tok123', '/hook/opencode', ts, init.body))
  })

  it('forwards tool calls with only a few small args', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    const hooks = await ClaudeOffice({ directory: '/tmp/demo' } as any)
    await hooks['tool.execute.before']({ tool: 'write', sessionID: 's1', callID: 'c1' }, { args: { filePath: '/tmp/demo/a.ts', content: 'x'.repeat(100000) } })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ type: 'tool.execute.before', properties: { tool: 'write', sessionID: 's1', args: { filePath: '/tmp/demo/a.ts' } } })
    expect(body.properties.args.content).toBeUndefined()
  })

  it('skips the chatty events the office does not use (streamed message parts)', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    const hooks = await ClaudeOffice({ directory: '/tmp/demo' } as any)
    await hooks.event({ event: { type: 'message.part.updated', properties: { part: { text: 'tok' } } } })
    await hooks.event({ event: { type: 'file.watcher.updated', properties: {} } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws when the office is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const hooks = await ClaudeOffice({ directory: '/tmp/demo' } as any)
    await expect(hooks.event({ event: { type: 'session.idle', properties: {} } })).resolves.toBeUndefined()
  })

  it('posts nothing inside an office-run session, or without a token', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetch)
    process.env.AGENT_OFFICE_RUN = '1'
    const hooks = await ClaudeOffice({ directory: '/tmp/demo' } as any)
    await hooks.event({ event: { type: 'session.idle', properties: {} } })
    delete process.env.AGENT_OFFICE_RUN
    rmSync(join(home, 'auth-token'))
    await hooks.event({ event: { type: 'session.idle', properties: {} } })
    expect(fetch).not.toHaveBeenCalled()
  })
})
