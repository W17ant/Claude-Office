/** POST /hook/:tool — another AI tool's raw hook payload, translated server-side into office sessions tagged with `client`. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadOffice, postAuthed, postEvent, removeOffice, type Office } from './helpers'

const FIXTURES = fileURLToPath(new URL('./fixtures/tools/', import.meta.url))
const fixture = (tool: string, name: string) => JSON.parse(readFileSync(join(FIXTURES, tool, `${name}.json`), 'utf8'))
// A copy of a fixture under its own session id, so tests don't share sessions
const withSession = (payload: any, sid: string) => ({ ...payload, session_id: sid })

describe('POST /hook/:tool', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('turns a Codex SessionStart into a session tagged codex', async () => {
    const res = await postAuthed(office.server, '/hook/codex', withSession(fixture('codex', 'session-start'), 'start-1'))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, count: 1 })
    const list = await request(office.server.app).get('/sessions')
    const s = list.body.sessions.find((x: any) => x.id === 'codex:start-1')
    expect(s).toMatchObject({ client: 'codex', project: 'demo-app', state: 'active' })
  })

  it('refuses an unsigned request', async () => {
    const res = await request(office.server.app).post('/hook/codex').send(fixture('codex', 'session-start'))
    expect(res.status).toBe(401)
  })

  it('answers 404 for a tool it does not know', async () => {
    const res = await postAuthed(office.server, '/hook/nope', fixture('codex', 'session-start'))
    expect(res.status).toBe(404)
  })

  it('answers 204 for a payload it does not understand', async () => {
    const res = await postAuthed(office.server, '/hook/codex', {})
    expect(res.status).toBe(204)
  })

  it('makes an implicit session, still tagged, when the first event is a tool call', async () => {
    await postAuthed(office.server, '/hook/codex', withSession(fixture('codex', 'pre-tool-bash'), 'implicit-1'))
    const s = office.server.sessions.get('codex:implicit-1')
    expect(s).toBeTruthy()
    expect(s.client).toBe('codex')
  })

  it('takes a post-tool payload far over /event\'s 64 KB (full command output)', async () => {
    const big = withSession(fixture('codex', 'post-tool-bash'), 'big-1')
    big.tool_response = { output: 'x'.repeat(200 * 1024), exit_code: 0 }
    const res = await postAuthed(office.server, '/hook/codex', big)
    expect(res.status).toBe(200)
  })

  it('keeps a Codex session and a Claude Code session with the same native id apart', async () => {
    await postAuthed(office.server, '/hook/codex', withSession(fixture('codex', 'session-start'), 'same-id'))
    await postEvent(office.server, { type: 'session_started', sessionId: 'same-id', project: 'p', cwd: '/tmp/p', source: 'startup' })
    expect(office.server.sessions.get('codex:same-id')?.client).toBe('codex')
    expect(office.server.sessions.get('same-id')).toBeTruthy()
  })

  it('leaves a Claude Code session without a client', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 'claude-1', project: 'p', cwd: '/tmp/p', source: 'startup' })
    const list = await request(office.server.app).get('/sessions')
    const s = list.body.sessions.find((x: any) => x.id === 'claude-1')
    expect(s).toBeTruthy()
    expect('client' in s).toBe(false)
  })

  it('ignores a client on /event that is not a known tool', async () => {
    await postEvent(office.server, { type: 'session_started', sessionId: 'claude-2', project: 'p', cwd: '/tmp/p', source: 'startup', client: '<script>' })
    expect(office.server.sessions.get('claude-2')?.client).toBeUndefined()
  })
})
