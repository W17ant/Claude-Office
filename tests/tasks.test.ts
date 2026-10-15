/**
 * server/tasks.js — the task board: each session's task list, read from
 * ~/.claude/tasks/<session_id>/<n>.json (here always a temp dir). readTaskDir
 * on fixtures shaped like the real files (a live session's directory: id,
 * subject, description, activeForm, status, blocks, blockedBy, plus owner /
 * metadata once set, and a zero-byte .lock), the watcher mounted on its own
 * (board appears, a burst of writes is one broadcast, unlink removes, the
 * session ending stops the watch, task_created rescans at once) and inside
 * the office (POST /event, GET /tasks with and without the token, the WS
 * snapshot and broadcasts, which never carry a description).
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { listen, loadOffice, officeProtocols, postEvent, removeOffice, type Office } from './helpers'
import {
  DEFAULT_DEBOUNCE_MS, DEFAULT_POLL_MS, MAX_TASKS, compareTaskIds, countTasks, isSafeSessionId, mountTasks,
  parseTask, publicTask, readTaskDir,
} from '../server/tasks.js'

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

async function waitFor<T>(what: string, probe: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = probe()
    if (v) return v
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---------------------------------------------------------------------------
// Fixtures: the shape of the files Claude Code writes (a live session's
// directory, pretty-printed with two spaces), with made-up content
// ---------------------------------------------------------------------------

const SID = 'c25c5511-f321-521a-825b-f189ac4d57e8'

type TaskFile = {
  id: string
  subject: string
  description: string
  activeForm: string
  status: string
  blocks: string[]
  blockedBy: string[]
  owner?: string
  metadata?: Record<string, unknown>
}

function taskFile(id: string, over: Partial<TaskFile> = {}): TaskFile {
  return {
    id,
    subject: `Task ${id}`,
    description: `The long description of task ${id}, written from the conversation.`,
    activeForm: `Doing task ${id}`,
    status: 'pending',
    blocks: [],
    blockedBy: [],
    ...over,
  }
}

/** <dir>/<id>.json as Claude Code writes it, plus the zero-byte .lock beside it. */
function writeTask(dir: string, id: string, over: Partial<TaskFile> = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.lock'), '')
  const file = taskFile(id, over)
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(file, null, 2))
  return file
}

const temps: string[] = []
function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
afterAll(() => { for (const dir of temps) try { rmSync(dir, { recursive: true, force: true }) } catch {} })

// ---------------------------------------------------------------------------
// readTaskDir and friends
// ---------------------------------------------------------------------------

describe('readTaskDir', () => {
  it('reads the real file shape, sorted by numeric id, skipping the .lock, temp files, malformed and non-task files', () => {
    const dir = join(tempDir('claude-tasks-'), SID)
    writeTask(dir, '10', { status: 'completed', blocks: ['11'] })
    writeTask(dir, '2', { status: 'in_progress', blockedBy: ['1'] })
    writeTask(dir, '1', { status: 'completed', owner: 'researcher', metadata: { priority: 'high' } })
    writeTask(dir, '11', { blockedBy: ['10', '2'] })
    writeFileSync(join(dir, '3.json'), '{ "id": "3", "subject": "half writ')                 // malformed
    writeFileSync(join(dir, '4.json'), '[1, 2]')                                             // not an object
    writeFileSync(join(dir, '5.json'), JSON.stringify({ subject: 'no id', status: 'pending' }))
    writeFileSync(join(dir, '6.json'), JSON.stringify({ id: '6', subject: 'no status' }))
    writeFileSync(join(dir, '7.json'), JSON.stringify(taskFile('7', { status: 'deleted' })))  // deleted, not yet unlinked
    writeFileSync(join(dir, '8.json.tmp.1a2b'), JSON.stringify(taskFile('8')))               // an atomic write in flight
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    mkdirSync(join(dir, '9.json'))                                                           // a directory, not a file

    const tasks = readTaskDir(dir)
    expect(tasks.map(t => t.id)).toEqual(['1', '2', '10', '11'])
    expect(tasks[0]).toEqual({
      id: '1',
      subject: 'Task 1',
      status: 'completed',
      blockedBy: [],
      activeForm: 'Doing task 1',
      owner: 'researcher',
      description: 'The long description of task 1, written from the conversation.',
    })
    // blocks and metadata are not kept; blockedBy is, as written
    expect(tasks[3].blockedBy).toEqual(['10', '2'])
    expect(tasks[0]).not.toHaveProperty('metadata')
    expect(tasks[0]).not.toHaveProperty('blocks')
  })

  it('a missing directory (the session never made a task) is an empty list', () => {
    expect(readTaskDir(join(tempDir('claude-tasks-'), 'nope'))).toEqual([])
  })

  it('a task whose status is set to "deleted" unlinks its file: gone on the next read', () => {
    const dir = join(tempDir('claude-tasks-'), SID)
    writeTask(dir, '1')
    writeTask(dir, '2')
    const cache = new Map()
    expect(readTaskDir(dir, { cache }).map(t => t.id)).toEqual(['1', '2'])
    unlinkSync(join(dir, '1.json'))
    expect(readTaskDir(dir, { cache }).map(t => t.id)).toEqual(['2'])
    expect(Array.from(cache.keys())).toEqual(['2.json'])
  })

  it('the cache: an unchanged file is not re-read, a file caught half-written keeps its last good read and is read again next time', () => {
    const dir = join(tempDir('claude-tasks-'), SID)
    writeTask(dir, '1', { subject: 'First' })
    const cache = new Map()
    expect(readTaskDir(dir, { cache })[0].subject).toBe('First')
    // Same size and times: served from the cache
    const entry = cache.get('1.json')
    entry.task = { ...entry.task, subject: 'from the cache' }
    expect(readTaskDir(dir, { cache })[0].subject).toBe('from the cache')
    // A write in progress: the file is there but empty
    writeFileSync(join(dir, '1.json'), '')
    expect(readTaskDir(dir, { cache })[0].subject).toBe('from the cache')
    // ...and once written, the new content
    writeTask(dir, '1', { subject: 'First, renamed', status: 'in_progress' })
    expect(readTaskDir(dir, { cache })[0]).toMatchObject({ subject: 'First, renamed', status: 'in_progress' })
  })

  it('parseTask clamps strings, takes integer ids, drops non-string blockers and anything that is not a task', () => {
    const t = parseTask(JSON.stringify({
      id: 12, subject: 's'.repeat(500), activeForm: 'a'.repeat(500), status: 'pending', owner: 'o'.repeat(200),
      description: 'd'.repeat(10_000), blockedBy: ['1', 2, null, { id: 3 }, 'x'.repeat(100)],
    }))!
    expect(t.id).toBe('12')
    expect(t.subject).toHaveLength(200)
    expect(t.activeForm).toHaveLength(200)
    expect(t.owner).toHaveLength(80)
    expect(t.description).toHaveLength(4000)
    expect(t.blockedBy).toEqual(['1', '2', 'x'.repeat(40)])
    expect(parseTask('not json')).toBeNull()
    expect(parseTask('null')).toBeNull()
    expect(parseTask(JSON.stringify({ id: '1', status: 'blocked' }))).toBeNull()
    expect(parseTask(JSON.stringify({ id: '', status: 'pending' }))).toBeNull()
    // No subject is still a task (an empty post-it), no activeForm / owner means none
    expect(parseTask(JSON.stringify({ id: '1', status: 'pending' }))).toEqual({ id: '1', subject: '', status: 'pending', blockedBy: [] })
  })

  it('publicTask leaves the description out; countTasks, compareTaskIds, isSafeSessionId', () => {
    const t = parseTask(JSON.stringify(taskFile('1', { owner: 'me' })))!
    expect(publicTask(t)).toEqual({ id: '1', subject: 'Task 1', status: 'pending', blockedBy: [], activeForm: 'Doing task 1', owner: 'me' })
    expect(countTasks([t, { ...t, status: 'completed' }, { ...t, status: 'in_progress' }, { ...t, status: 'completed' }]))
      .toEqual({ pending: 1, in_progress: 1, completed: 2 })
    expect(['10', 'b', '2', 'a', '1'].sort(compareTaskIds)).toEqual(['1', '2', '10', 'a', 'b'])
    expect(isSafeSessionId(SID)).toBe(true)
    expect(isSafeSessionId('session-2a36f846')).toBe(true)
    for (const bad of ['', '..', '../etc', 'a/b', '.hidden', 'x'.repeat(81), 42, null]) expect(isSafeSessionId(bad), String(bad)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The watcher on its own: a plain express app, a sessions map and a
// broadcast that records what it was given
// ---------------------------------------------------------------------------

describe('mountTasks', () => {
  let root: string
  let sessions: Map<string, any>
  let sent: any[]
  let tasks: ReturnType<typeof mountTasks>
  let app: express.Express

  const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  const boardsFor = (id: string) => sent.filter(m => m.type === 'task_board' && m.sessionId === id)

  function mount(opts: Record<string, unknown> = {}) {
    root = tempDir('claude-tasks-root-')
    sessions = new Map()
    sent = []
    app = express()
    tasks = mountTasks(app, { sessions, broadcast: (m: any) => sent.push(m), tasksDir: root, debounceMs: 100, log: () => {}, ...opts })
  }
  afterEach(() => tasks?.stop())

  it('refuses to mount without its collaborators, and does nothing until start()', () => {
    expect(() => mountTasks(express(), {} as any)).toThrow(/sessions map/)
    expect(() => mountTasks(express(), { sessions: new Map() } as any)).toThrow(/broadcast/)
    expect(() => mountTasks(express(), { sessions: new Map(), broadcast: () => {} } as any)).toThrow(/tasksDir/)
    mount()
    sessions.set(A, { id: A, state: 'active', project: 'alpha' })
    writeTask(join(root, A), '1')
    expect(tasks.track(A)).toBe(false)
    tasks.noteEvent({ type: 'task_created', sessionId: A })
    expect(sent).toEqual([])
    expect(tasks.stats()).toEqual({ dir: root, running: false, watching: 0, lastScanAt: null })
    expect(DEFAULT_POLL_MS).toBe(2000)
    expect(DEFAULT_DEBOUNCE_MS).toBe(250)
  })

  it('a known session\'s board appears on start(): one task_board with the public tasks, counts and the files\' newest mtime', () => {
    mount()
    sessions.set(A, { id: A, state: 'active', project: 'alpha' })
    sessions.set(B, { id: B, state: 'active', project: 'beta' })          // no task list: no board, no broadcast
    sessions.set('gone', { id: 'gone', state: 'ended' })
    writeTask(join(root, A), '1', { status: 'completed' })
    writeTask(join(root, A), '2', { status: 'in_progress', blockedBy: ['1'] })
    writeTask(join(root, A), '3', { owner: 'researcher' })
    const before = Date.now()
    tasks.start({ pollMs: 60_000 })

    expect(tasks.watching.sort()).toEqual([A, B].sort())
    expect(sent).toHaveLength(1)
    const [msg] = sent
    expect(msg).toMatchObject({ type: 'task_board', sessionId: A })
    expect(msg.board).toEqual({
      sessionId: A,
      project: 'alpha',
      tasks: [
        { id: '1', subject: 'Task 1', status: 'completed', blockedBy: [], activeForm: 'Doing task 1' },
        { id: '2', subject: 'Task 2', status: 'in_progress', blockedBy: ['1'], activeForm: 'Doing task 2' },
        { id: '3', subject: 'Task 3', status: 'pending', blockedBy: [], activeForm: 'Doing task 3', owner: 'researcher' },
      ],
      counts: { pending: 1, in_progress: 1, completed: 1 },
      updatedAt: expect.any(Number),
    })
    expect(msg.board.updatedAt).toBeGreaterThan(before - 5_000)
    expect(JSON.stringify(sent)).not.toContain('long description')
    expect(tasks.boards()).toEqual([msg.board])
    // A second look with nothing changed says nothing
    expect(tasks.scan(A)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('a status change is broadcast once, after the writes settle (debounce), by the watch alone', async () => {
    mount()
    sessions.set(A, { id: A, state: 'active' })
    writeTask(join(root, A), '1')
    writeTask(join(root, A), '2')
    tasks.start({ pollMs: 60_000 })
    expect(boardsFor(A)).toHaveLength(1)

    // TaskUpdate: the file rewritten in a few syscalls, plus another task touched
    writeFileSync(join(root, A, '1.json'), '')
    writeTask(join(root, A), '1', { status: 'in_progress' })
    writeTask(join(root, A), '2', { blockedBy: ['1'] })
    await waitFor('the debounced board', () => boardsFor(A).length === 2)
    await sleep(300)
    expect(boardsFor(A)).toHaveLength(2)
    const board = boardsFor(A)[1].board
    expect(board.tasks.map((t: any) => [t.id, t.status, t.blockedBy])).toEqual([['1', 'in_progress', []], ['2', 'pending', ['1']]])
    expect(board.counts).toEqual({ pending: 1, in_progress: 1, completed: 0 })
  })

  it('a deleted task (its file unlinked) leaves the board; the last one going takes the board down (board: null)', async () => {
    mount()
    sessions.set(A, { id: A, state: 'active' })
    writeTask(join(root, A), '1')
    writeTask(join(root, A), '2')
    tasks.start({ pollMs: 60_000 })
    unlinkSync(join(root, A, '1.json'))
    await waitFor('the board without task 1', () => boardsFor(A).length === 2)
    expect(boardsFor(A)[1].board.tasks.map((t: any) => t.id)).toEqual(['2'])
    unlinkSync(join(root, A, '2.json'))
    await waitFor('the board taken down', () => boardsFor(A).length === 3)
    expect(boardsFor(A)[2].board).toBeNull()
    expect(tasks.boards()).toEqual([])
  })

  it('the session ending stops the watch: its board goes (board: null) and later writes are not read', async () => {
    mount()
    sessions.set(A, { id: A, state: 'active' })
    writeTask(join(root, A), '1')
    tasks.start({ pollMs: 60_000 })
    sessions.get(A).state = 'ended'
    tasks.noteEvent({ type: 'session_ended', sessionId: A })
    expect(boardsFor(A).map(m => m.board === null)).toEqual([false, true])
    expect(tasks.watching).toEqual([])
    writeTask(join(root, A), '2')
    await sleep(250)
    expect(boardsFor(A)).toHaveLength(2)
    // The poll's reconcile does the same for an end it did not hear about (the stale sweep, the registry)
    sessions.set(B, { id: B, state: 'active' })
    writeTask(join(root, B), '1')
    tasks.reconcile()
    expect(tasks.watching).toEqual([B])
    sessions.delete(B)
    tasks.reconcile()
    expect(tasks.watching).toEqual([])
    expect(boardsFor(B).map(m => m.board === null)).toEqual([false, true])
  })

  it('task_created rescans at once (no watch event needed) and starts the watch for a session it had not seen', () => {
    mount({ debounceMs: 10_000 })
    tasks.start({ pollMs: 60_000 })
    sessions.set(A, { id: A, state: 'active' })                        // created by the hook event itself
    writeTask(join(root, A), '1')
    tasks.noteEvent({ type: 'task_created', sessionId: A, taskId: '1' })
    expect(tasks.watching).toEqual([A])
    expect(boardsFor(A)).toHaveLength(1)
    writeTask(join(root, A), '1', { status: 'completed' })
    tasks.noteEvent({ type: 'task_completed', sessionId: A, taskId: '1' })
    expect(boardsFor(A)).toHaveLength(2)
    expect(boardsFor(A)[1].board.tasks[0].status).toBe('completed')
  })

  it('a task event also takes a second look after the debounce: the hook runs before Claude Code has written the file', async () => {
    mount()
    sessions.set(A, { id: A, state: 'active' })
    // No directory yet, so no fs.watch on it, and the poll is a minute away:
    // only the scheduled second look can see the write that follows the hook
    tasks.start({ pollMs: 60_000 })
    tasks.noteEvent({ type: 'task_created', sessionId: A, taskId: '1' })
    expect(boardsFor(A)).toHaveLength(0)
    writeTask(join(root, A), '1')
    await waitFor('the second look', () => boardsFor(A).length === 1)
    expect(boardsFor(A)[0].board.tasks.map((t: any) => t.id)).toEqual(['1'])
  })

  it('an unsafe session id is never turned into a path; other events only start the watch once', () => {
    mount()
    tasks.start({ pollMs: 60_000 })
    for (const id of ['../escape', '.', 'a/b']) {
      sessions.set(id, { id, state: 'active' })
      tasks.noteEvent({ type: 'task_created', sessionId: id })
    }
    expect(tasks.watching).toEqual([])
    sessions.set(A, { id: A, state: 'active' })
    tasks.noteEvent({ type: 'agent_working', sessionId: A })
    tasks.noteEvent({ type: 'agent_working', sessionId: A })
    expect(tasks.watching).toEqual([A])
    tasks.noteEvent({ type: 'agent_working' })
    tasks.noteEvent(undefined as any)
  })

  it('the poll picks up a directory that appears later and a change the watch missed', async () => {
    mount()
    sessions.set(A, { id: A, state: 'active' })
    tasks.start({ pollMs: 40 })
    expect(sent).toEqual([])
    writeTask(join(root, A), '1')
    await waitFor('the board from the poll', () => boardsFor(A).length === 1)
    sessions.set(B, { id: B, state: 'active' })
    writeTask(join(root, B), '5')
    await waitFor('the reconcile', () => boardsFor(B).length === 1)
    tasks.stop()
    expect(tasks.running).toBe(false)
    expect(tasks.watching).toEqual([])
  })

  it('a board past MAX_TASKS keeps the open tasks and the newest done ones; counts stay whole', () => {
    mount()
    sessions.set(A, { id: A, state: 'active' })
    for (let i = 1; i <= MAX_TASKS + 30; i++) writeTask(join(root, A), String(i), { status: i <= MAX_TASKS ? 'completed' : 'pending' })
    tasks.start({ pollMs: 60_000 })
    const board = boardsFor(A)[0].board
    expect(board.tasks).toHaveLength(MAX_TASKS)
    expect(board.counts).toEqual({ pending: 30, in_progress: 0, completed: MAX_TASKS })
    expect(board.tasks.filter((t: any) => t.status === 'pending')).toHaveLength(30)
    expect(board.tasks[0].id).toBe('31')                               // the oldest 30 done ones dropped
  })

  it('GET /tasks: every board, or one session\'s; descriptions only for a caller with the token', async () => {
    mount({ hasToken: (req: any) => req.headers.authorization === 'Bearer good' })
    sessions.set(A, { id: A, state: 'active', project: 'alpha' })
    sessions.set(B, { id: B, state: 'active', project: 'beta' })
    writeTask(join(root, A), '1', { description: 'secret plan A' })
    writeTask(join(root, B), '1', { description: 'secret plan B' })
    tasks.start({ pollMs: 60_000 })

    const open = await request(app).get('/tasks')
    expect(open.status).toBe(200)
    expect(open.body).toMatchObject({ dir: root, running: true, watching: 2 })
    expect(open.body.boards.map((b: any) => b.sessionId).sort()).toEqual([A, B].sort())
    expect(JSON.stringify(open.body)).not.toContain('secret plan')

    const wrong = await request(app).get('/tasks').set('Authorization', 'Bearer nope')
    expect(JSON.stringify(wrong.body)).not.toContain('secret plan')

    const one = await request(app).get(`/tasks?sessionId=${A}`).set('Authorization', 'Bearer good')
    expect(one.body.boards).toHaveLength(1)
    expect(one.body.boards[0].tasks[0]).toMatchObject({ id: '1', subject: 'Task 1', description: 'secret plan A' })

    expect((await request(app).get('/tasks?sessionId=unknown')).body.boards).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// In the office: POST /event, the WS snapshot and broadcasts, GET /tasks
// ---------------------------------------------------------------------------

describe('the task board in the office', () => {
  let office: Office
  let tasksDir: string
  let ws: WebSocket          // the office page with the token: trusted
  let readOnly: WebSocket    // no token: what redactForReadOnly leaves of each broadcast
  let port: number
  const messages: any[] = []
  const readOnlyMessages: any[] = []
  const S = 'dddddddd-4444-4444-8444-dddddddddddd'

  const tb = () => office.server.tasks
  const boardMsgs = () => messages.filter(m => m.type === 'task_board' && m.sessionId === S)

  async function connect(into: any[], protocols?: string[]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols)
    socket.on('message', raw => into.push(JSON.parse(raw.toString())))
    await new Promise<void>((res, rej) => { socket.once('open', () => res()); socket.once('error', rej) })
    await waitFor('the snapshot', () => into.find(m => m.type === 'snapshot'))
    return socket
  }

  beforeAll(async () => {
    tasksDir = tempDir('claude-tasks-office-')
    office = await loadOffice({ env: { AGENT_OFFICE_TASKS_DIR: tasksDir } })
    port = await listen(office.server.httpServer)
    ws = await connect(messages, officeProtocols(office.server))
    readOnly = await connect(readOnlyMessages)
    expect(messages[0]).toEqual({ type: 'auth', trusted: true })
    expect(readOnlyMessages[0]).toEqual({ type: 'auth', trusted: false })
  })

  afterAll(async () => {
    tb().stop()
    ws.terminate()
    readOnly.terminate()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
  })

  it('reads the directory the env named, never ~/.claude/tasks, and is idle until start()', async () => {
    expect(office.server.TASKS_DIR).toBe(tasksDir)
    expect(tb().running).toBe(false)
    expect(messages.find(m => m.type === 'snapshot').taskBoards).toEqual([])
    const res = await request(office.server.app).get('/tasks')
    expect(res.body).toEqual({ dir: tasksDir, running: false, watching: 0, lastScanAt: null, boards: [] })
  })

  it('task_created is a known event: it creates the session, the rescan runs inside the request, Claude\'s history gets a line', async () => {
    // Before the server knew the type, the hook's POST was a 400
    expect((await postEvent(office.server, { type: 'task_moved', sessionId: S })).status).toBe(400)
    tb().start({ pollMs: 60_000 })
    writeTask(join(tasksDir, S), '1', { subject: 'Fix the parser', description: 'Trailing commas break it' })
    const res = await postEvent(office.server, { type: 'task_created', sessionId: S, cwd: '/home/me/gamma', taskId: '1', subject: `Fix the parser ${'x'.repeat(300)}` })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // The hook event created the session and the rescan ran inside the request: the board is already out
    expect(office.server.sessions.get(S)).toMatchObject({ id: S, project: 'gamma', state: 'active' })
    await waitFor('the board broadcast', () => boardMsgs().length === 1)
    expect(boardMsgs()[0].board).toMatchObject({ sessionId: S, project: 'gamma', tasks: [{ id: '1', subject: 'Fix the parser', status: 'pending' }] })
    const card = await request(office.server.app).get(`/agents/main-${S}`)
    const line = card.body.history.find((h: any) => h.text.startsWith('task created: Fix the parser'))
    expect(line).toMatchObject({ kind: 'status' })
    expect(line.text.length).toBeLessThanOrEqual(160)
  })

  it('pending -> in_progress (no hook for it) reaches the page from the watch, once', async () => {
    writeTask(join(tasksDir, S), '1', { subject: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser', description: 'Trailing commas break it' })
    await waitFor('the in-progress board', () => boardMsgs().length === 2)
    await sleep(400)
    expect(boardMsgs()).toHaveLength(2)
    expect(boardMsgs()[1].board.tasks[0]).toEqual({ id: '1', subject: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser', blockedBy: [] })
  })

  it('a new WS client gets the boards in its snapshot, trusted or not, without descriptions', async () => {
    for (const protocols of [officeProtocols(office.server), undefined]) {
      const got: any[] = []
      const late = await connect(got, protocols)
      late.terminate()
      const snap = got.find(m => m.type === 'snapshot')
      expect(snap.taskBoards).toHaveLength(1)
      expect(snap.taskBoards[0]).toMatchObject({ sessionId: S, counts: { pending: 0, in_progress: 1, completed: 0 } })
      expect(JSON.stringify(snap)).not.toContain('Trailing commas')
    }
    expect(JSON.stringify(messages)).not.toContain('Trailing commas')
  })

  it('task_board carries no conversation text, so a read-only connection gets every one exactly as the trusted page does', () => {
    const readOnlyBoards = readOnlyMessages.filter(m => m.type === 'task_board' && m.sessionId === S)
    expect(readOnlyBoards.length).toBeGreaterThan(0)
    expect(readOnlyBoards).toEqual(boardMsgs())
    expect(office.server.redactForReadOnly(boardMsgs()[0])).toBe(boardMsgs()[0])
    expect(JSON.stringify(readOnlyMessages)).not.toContain('Trailing commas')
  })

  it('GET /tasks: subjects open, the description only with the office token', async () => {
    const open = await request(office.server.app).get(`/tasks?sessionId=${S}`)
    expect(open.body.boards[0].tasks[0]).not.toHaveProperty('description')
    const bad = await request(office.server.app).get(`/tasks?sessionId=${S}`).set('Authorization', 'Bearer not-the-token')
    expect(bad.body.boards[0].tasks[0]).not.toHaveProperty('description')
    const tokened = await request(office.server.app).get(`/tasks?sessionId=${S}`).set('Authorization', `Bearer ${office.server.AUTH_TOKEN}`)
    expect(tokened.body.boards[0].tasks[0]).toMatchObject({ subject: 'Fix the parser', description: 'Trailing commas break it' })
  })

  it('TaskCompleted: the post-it moves to done (the rescan, or the second look once the file is written)', async () => {
    const before = boardMsgs().length
    writeTask(join(tasksDir, S), '1', { subject: 'Fix the parser', status: 'completed', description: 'Trailing commas break it' })
    expect((await postEvent(office.server, { type: 'task_completed', sessionId: S, taskId: '1', subject: 'Fix the parser' })).status).toBe(200)
    await waitFor('the done board', () => boardMsgs().length > before && boardMsgs().at(-1).board?.tasks[0].status === 'completed')
    await sleep(400)
    expect(boardMsgs().length).toBe(before + 1)
    expect(boardMsgs().at(-1).board.counts).toEqual({ pending: 0, in_progress: 0, completed: 1 })
  })

  it('SessionEnd takes the board down for every client and stops the watch', async () => {
    const res = await postEvent(office.server, { type: 'session_ended', sessionId: S, reason: 'prompt_input_exit' })
    expect(res.status).toBe(200)
    await waitFor('the board taken down', () => boardMsgs().at(-1)?.board === null)
    expect(tb().watching).toEqual([])
    expect((await request(office.server.app).get('/tasks')).body.boards).toEqual([])
  })
})
