/**
 * permission-notify.test.ts - the OS notification when a permission wait starts:
 * the text (project and tool only), the 300 ms delay, the per-session throttle,
 * the notifyPermissions setting, and what actually reaches notify.sh's argv.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOffice, postEvent, removeOffice, type Office } from './helpers'
import {
  PERMISSION_NOTIFY_DELAY_MS, PERMISSION_NOTIFY_THROTTLE_MS, PERMISSION_NOTIFY_TITLE,
  createPermissionNotifier, permissionNotificationText,
} from '../server/permission-notify.js'

// A command line and path that must never reach a lock-screen banner
const SECRET_COMMAND = 'curl -H "Authorization: Bearer sk-live-SECRET" https://example.com/deploy'
const SECRET_PATH = '/home/me/alpha/.env.production'

const ALPHA = {
  sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
  project: 'alpha',
  cwd: '/home/me/alpha',
  transcriptPath: '/root/.claude/projects/-home-me-alpha/aaaaaaaa-1111-4111-8111-111111111111.jsonl',
}

function permissionRequest(overrides: Record<string, unknown> = {}) {
  return {
    type: 'session_needs_you', kind: 'permission', ...ALPHA, promptId: 'p-1',
    toolName: 'Bash', summary: SECRET_COMMAND, detail: SECRET_COMMAND,
    answerable: true, permissionMode: 'default', suggestions: [], nonce: 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4',
    ...overrides,
  }
}

describe('permissionNotificationText', () => {
  it('names the project and the tool in words, never the input', () => {
    const text = permissionNotificationText({ project: 'alpha', toolName: 'Bash', summary: SECRET_COMMAND, detail: SECRET_COMMAND } as any)
    expect(text).toEqual({ title: PERMISSION_NOTIFY_TITLE, message: 'alpha · Bash wants to run a command' })
    expect(permissionNotificationText({ project: 'alpha', toolName: 'Write', summary: SECRET_PATH } as any).message).toBe('alpha · Write wants to write a file')
    expect(permissionNotificationText({ project: 'alpha', toolName: 'Edit' }).message).toBe('alpha · Edit wants to edit a file')
    expect(permissionNotificationText({ project: 'alpha', toolName: 'mcp__github__create_pull_request' }).message)
      .toBe('alpha · mcp__github__create_pull_request wants permission')
  })

  it('falls back to the last segment of cwd, then "A session"; strips control characters and odd tool names', () => {
    expect(permissionNotificationText({ cwd: '/home/me/beta/', toolName: 'Read' }).message).toBe('beta · Read wants to read a file')
    expect(permissionNotificationText({ cwd: 'C:\\work\\gamma', toolName: 'Read' }).message).toBe('gamma · Read wants to read a file')
    expect(permissionNotificationText({}).message).toBe('A session · A tool wants permission')
    expect(permissionNotificationText({ project: 'evil\nproject', toolName: 'Bash; rm -rf /' }).message).toBe('evil project · Bashrm-rf wants permission')
    expect(permissionNotificationText({ project: 'p'.repeat(200), toolName: 'Bash' }).message.length).toBeLessThan(100)
  })
})

describe('createPermissionNotifier', () => {
  afterEach(() => { vi.useRealTimers() })

  function setup(opts: { enabled?: boolean, pending?: Set<string> } = {}) {
    vi.useFakeTimers()
    const sent: Array<[string, string]> = []
    let enabled = opts.enabled ?? true
    const pending = opts.pending ?? new Set(['p1', 'p2', 'p3', 'q1'])
    const notifier = createPermissionNotifier({
      notify: (title, message) => { sent.push([title, message]) },
      isEnabled: () => enabled,
      isPending: id => pending.has(id),
      now: () => Date.now(),
    })
    return { notifier, sent, pending, setEnabled: (v: boolean) => { enabled = v } }
  }

  it('waits out the delay, and says nothing when the wait is already over (a headless auto-deny)', () => {
    const { notifier, sent, pending } = setup()
    notifier.schedule({ id: 'p1', sessionId: 's1', project: 'alpha', toolName: 'Bash' })
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS - 1)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(sent).toEqual([[PERMISSION_NOTIFY_TITLE, 'alpha · Bash wants to run a command']])

    pending.delete('q1')
    notifier.schedule({ id: 'q1', sessionId: 's2', project: 'beta', toolName: 'Bash' })
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS)
    expect(sent).toHaveLength(1)
  })

  it('sends at most one per session per throttle window; other sessions are not held back', () => {
    const { notifier, sent } = setup()
    notifier.schedule({ id: 'p1', sessionId: 's1', project: 'alpha', toolName: 'Bash' })
    notifier.schedule({ id: 'p2', sessionId: 's1', project: 'alpha', toolName: 'Write' })
    notifier.schedule({ id: 'q1', sessionId: 's2', project: 'beta', toolName: 'Edit' })
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS)
    expect(sent.map(([, m]) => m)).toEqual(['alpha · Bash wants to run a command', 'beta · Edit wants to edit a file'])

    // Still inside the window: nothing
    vi.advanceTimersByTime(PERMISSION_NOTIFY_THROTTLE_MS - PERMISSION_NOTIFY_DELAY_MS - 1)
    notifier.schedule({ id: 'p3', sessionId: 's1', project: 'alpha', toolName: 'Bash' })
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS - 1)
    expect(sent).toHaveLength(2)
    // Past it: the next wait notifies again
    vi.advanceTimersByTime(PERMISSION_NOTIFY_THROTTLE_MS)
    notifier.schedule({ id: 'p3', sessionId: 's1', project: 'alpha', toolName: 'Bash' })
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS)
    expect(sent).toHaveLength(3)
  })

  it('reads the setting when the delay is over, and a throttled-out or disabled wait does not use up the window', () => {
    const { notifier, sent, setEnabled } = setup({ enabled: false })
    notifier.schedule({ id: 'p1', sessionId: 's1', project: 'alpha', toolName: 'Bash' })
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS)
    expect(sent).toEqual([])
    // Turned on while a wait is still in its delay: it notifies
    notifier.schedule({ id: 'p2', sessionId: 's1', project: 'alpha', toolName: 'Bash' })
    setEnabled(true)
    vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS)
    expect(sent).toHaveLength(1)
  })

  it('a notifier that throws is logged, not raised; cancelAll drops what is scheduled', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier = createPermissionNotifier({ notify: () => { throw new Error('boom') } })
    notifier.schedule({ id: 'p1', sessionId: 's1' })
    expect(() => vi.advanceTimersByTime(PERMISSION_NOTIFY_DELAY_MS)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    notifier.schedule({ id: 'p2', sessionId: 's2' })
    expect(notifier.scheduled).toBe(1)
    notifier.cancelAll()
    expect(notifier.scheduled).toBe(0)
  })
})

describe('the server: what reaches notify.sh', () => {
  let office: Office
  afterEach(() => removeOffice(office))

  /** An office whose notify script appends its argv, one call per line, to a log. */
  async function officeWithFakeNotify() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-office-notify-'))
    const log = join(dir, 'notify.log')
    const script = join(dir, 'notify.sh')
    writeFileSync(script, `printf '%s\\t%s\\n' "$1" "$2" >> '${log}'\n`)
    office = await loadOffice({ env: { AGENT_OFFICE_NOTIFY_SCRIPT: script } })
    office.server.processEvent({ type: 'session_started', ...ALPHA, source: 'startup', title: 'login fix' })
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [])
    return { calls }
  }

  /** Wait for the delay plus the child process to run. */
  const settle = (ms = PERMISSION_NOTIFY_DELAY_MS + 700) => new Promise(r => setTimeout(r, ms))

  it('one call with the project and tool, never the command line; a burst in the same session sends no more', async () => {
    const { calls } = await officeWithFakeNotify()
    const first = await postEvent(office.server, permissionRequest())
    expect(first.body.permissionId).toBeTruthy()
    await settle()
    expect(calls()).toEqual([`${PERMISSION_NOTIFY_TITLE}\talpha · Bash wants to run a command`])
    const everything = calls().join('\n')
    expect(everything).not.toContain('SECRET')
    expect(everything).not.toContain('curl')

    // A new request in the same session (releases the first): throttled
    await postEvent(office.server, permissionRequest({ promptId: 'p-2', toolName: 'Write', summary: SECRET_PATH, detail: SECRET_PATH }))
    await settle()
    expect(calls()).toHaveLength(1)
    office.server.permissions.resolveSession(ALPHA.sessionId, '')
  })

  it('nothing when the wait ends inside the delay (a headless -p auto-deny) or the setting is off', async () => {
    const { calls } = await officeWithFakeNotify()
    await postEvent(office.server, permissionRequest())
    await postEvent(office.server, { type: 'session_tool_done', ...ALPHA, promptId: 'p-1', batch: true, count: 1 })
    await settle()
    expect(calls()).toEqual([])

    const off = await request(office.server.app).post('/settings').set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ notifyPermissions: false })
    expect(off.status).toBe(200)
    await postEvent(office.server, permissionRequest({ promptId: 'p-2' }))
    await settle()
    expect(calls()).toEqual([])
    office.server.permissions.resolveSession(ALPHA.sessionId, '')
  })
})

describe('the notifyPermissions setting', () => {
  let office: Office
  afterEach(() => removeOffice(office))

  it('defaults to on, takes the UI token, validates, persists and survives a restart', async () => {
    office = await loadOffice()
    expect((await request(office.server.app).get('/settings')).body).toMatchObject({ notifyPermissions: true })
    const ui = (token: string, body: unknown) => request(office.server.app).post('/settings').set('Authorization', `Bearer ${token}`).send(body as object)
    expect((await request(office.server.app).post('/settings').send({ notifyPermissions: false })).status).toBe(401)
    expect((await ui(office.server.UI_TOKEN, { notifyPermissions: 'off' })).status).toBe(400)
    expect(office.server.settings.notifyPermissions).toBe(true)

    const off = await ui(office.server.UI_TOKEN, { notifyPermissions: false })
    expect(off.body).toMatchObject({ ok: true, notifyPermissions: false, answerPermissions: true })
    expect(JSON.parse(readFileSync(join(office.dir, 'settings.json'), 'utf8'))).toMatchObject({ notifyPermissions: false })

    const again = await loadOffice({ dir: office.dir })
    expect(again.server.settings.notifyPermissions).toBe(false)
  })

  it('junk in settings.json leaves the default on', async () => {
    const dir = (await loadOffice()).dir
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ notifyPermissions: 'nope' }))
    office = await loadOffice({ dir })
    expect(office.server.settings.notifyPermissions).toBe(true)
  })
})
