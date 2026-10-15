/**
 * src/taskBoard.ts — the kanban whiteboard's store and words — and the board
 * on the wall (src/components/TaskBoard.tsx, rendered to static markup, no
 * DOM): which session's board shows, what flashes or slides, how a column
 * fits, the boss's line at the board (src/interactions.ts), and that with no
 * tasks anywhere nothing is drawn over the decorative board.
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import TaskBoard from '../src/components/TaskBoard'
import { getInteraction } from '../src/interactions'
import { ROOMS } from '../src/rooms'
import {
  BOARD_RECT, COLUMNS, COLUMN_MAX, FX_MS, boardChatLines, boardCounts, boardLabel, cleanBoard, columnView, cycleBoards,
  diffBoards, dispatchTaskBoards, getShownBoard, isBlocked, reduceTaskBoards, resetTaskBoards, shownBoard, taskCaption,
  type BoardTask, type TaskBoardInfo, type TaskBoardsState,
} from '../src/taskBoard'
import type { SessionInfo } from '../src/types'

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

function task(id: string, status: BoardTask['status'] = 'pending', over: Partial<BoardTask> = {}): BoardTask {
  return { id, subject: `Task ${id}`, activeForm: `Doing task ${id}`, status, blockedBy: [], ...over }
}

function board(sessionId: string, tasks: BoardTask[], updatedAt = 1_000, over: Partial<TaskBoardInfo> = {}): TaskBoardInfo {
  return { sessionId, project: sessionId === A ? 'alpha' : 'beta', tasks, updatedAt, ...over }
}

const EMPTY: TaskBoardsState = { boards: [], pinned: null, fx: null }
const one = (b: TaskBoardInfo | null, sessionId = b?.sessionId ?? A) => ({ type: 'task_board' as const, sessionId, board: b })

describe('reduceTaskBoards', () => {
  it('a board per session, the most recently changed first; board: null or no tasks takes it down', () => {
    let s = reduceTaskBoards(EMPTY, one(board(A, [task('1')], 1_000)), 5)
    s = reduceTaskBoards(s, one(board(B, [task('1')], 2_000)), 6)
    expect(s.boards.map(b => b.sessionId)).toEqual([B, A])
    expect(shownBoard(s)?.sessionId).toBe(B)
    s = reduceTaskBoards(s, one(board(A, [task('1', 'in_progress')], 3_000)), 7)
    expect(shownBoard(s)?.sessionId).toBe(A)
    s = reduceTaskBoards(s, one(null, A), 8)
    expect(s.boards.map(b => b.sessionId)).toEqual([B])
    s = reduceTaskBoards(s, one(board(B, [], 4_000)), 9)
    expect(s.boards).toEqual([])
    expect(shownBoard(s)).toBeNull()
    // Nothing to take down, other event types: the same state back
    expect(reduceTaskBoards(s, one(null, A))).toBe(s)
    expect(reduceTaskBoards(s, { type: 'session_status' })).toBe(s)
    expect(reduceTaskBoards(s, { type: 'task_board' })).toBe(s)
  })

  it('the snapshot replaces every board, animates nothing and keeps a pin that still has its board', () => {
    let s = reduceTaskBoards(EMPTY, one(board(A, [task('1')], 1_000)), 5)
    s = reduceTaskBoards(s, one(board(B, [task('1')], 2_000)), 6)
    s = cycleBoards(s)
    expect(shownBoard(s)?.sessionId).toBe(A)
    s = reduceTaskBoards(s, { type: 'task_board', boards: [board(A, [task('1'), task('2')], 1_500), board(B, [task('1')], 2_000), { junk: true } as any] })
    expect(s.boards.map(b => b.sessionId)).toEqual([B, A])
    expect(s.pinned).toBe(A)
    expect(s.fx).toBeNull()
    expect(shownBoard(s)?.tasks).toHaveLength(2)
    s = reduceTaskBoards(s, { type: 'task_board', boards: [board(B, [task('1')], 2_000)] })
    expect(s.pinned).toBeNull()
  })

  it('a click cycles through the boards; the next change anywhere lets the newest win again', () => {
    let s = reduceTaskBoards(EMPTY, one(board(A, [task('1')], 1_000)))
    expect(cycleBoards(s)).toBe(s)                                    // one board: nothing to cycle
    s = reduceTaskBoards(s, one(board(B, [task('1')], 2_000)))
    s = cycleBoards(s)
    expect(shownBoard(s)?.sessionId).toBe(A)
    s = cycleBoards(s)
    expect(shownBoard(s)?.sessionId).toBe(B)
    s = cycleBoards(s)
    s = reduceTaskBoards(s, one(board(B, [task('1', 'completed')], 3_000)))
    expect(s.pinned).toBeNull()
    expect(shownBoard(s)?.sessionId).toBe(B)
  })

  it('what changed: in progress flashes, completed slides, new pops; the first board pops all of it', () => {
    const before = board(A, [task('1'), task('2', 'in_progress'), task('3')])
    const after = board(A, [task('1', 'in_progress'), task('2', 'completed'), task('3', 'pending', { subject: 'renamed' }), task('4')])
    expect(diffBoards(before, after)).toEqual({ 1: 'started', 2: 'done', 4: 'added' })
    expect(diffBoards(undefined, before)).toEqual({ 1: 'added', 2: 'added', 3: 'added' })
    let s = reduceTaskBoards(EMPTY, one(before), 100)
    s = reduceTaskBoards(s, one(after), 200)
    expect(s.fx).toEqual({ sessionId: A, at: 200, tasks: { 1: 'started', 2: 'done', 4: 'added' } })
    // Another session's board going leaves this change's effects alone; its own going clears them
    expect(reduceTaskBoards(s, one(null, B)).fx).toBe(s.fx)
    expect(reduceTaskBoards(s, one(null, A)).fx).toBeNull()
  })

  it('cleanBoard keeps only well-formed tasks and needs a session id and at least one task', () => {
    expect(cleanBoard(null)).toBeNull()
    expect(cleanBoard({ sessionId: A })).toBeNull()
    expect(cleanBoard({ sessionId: A, tasks: [{ id: 1, status: 'pending' }, { id: '2', status: 'deleted' }] })).toBeNull()
    expect(cleanBoard({ sessionId: A, tasks: [{ id: '1', status: 'pending', blockedBy: ['2', 3] }] }))
      .toEqual({ sessionId: A, updatedAt: 0, tasks: [{ id: '1', subject: '', status: 'pending', blockedBy: ['2'] }] })
  })
})

describe('the board on the wall', () => {
  it('blocked means waiting on a task that is on the board and still open (Claude Code leaves finished blockers listed)', () => {
    const b = board(A, [task('1', 'completed'), task('2', 'in_progress'), task('3', 'pending', { blockedBy: ['1'] }), task('4', 'pending', { blockedBy: ['1', '2'] }), task('5', 'pending', { blockedBy: ['99'] })])
    expect(b.tasks.map(t => isBlocked(t, b))).toEqual([false, false, false, true, false])
    expect(isBlocked(task('6', 'completed', { blockedBy: ['2'] }), b)).toBe(false)
  })

  it('a column shows every post-it up to COLUMN_MAX, else COLUMN_MAX - 1 and "+N": next up for To do, the latest for Done, a fresh change always', () => {
    const tasks = [...Array.from({ length: 9 }, (_, i) => task(String(i + 1), 'completed')), ...Array.from({ length: 4 }, (_, i) => task(String(i + 10)))]
    const b = board(A, tasks)
    expect(COLUMN_MAX).toBe(6)
    expect(columnView(b, 'pending')).toEqual({ status: 'pending', shown: tasks.slice(9), more: 0 })
    const done = columnView(b, 'completed')
    expect(done.shown.map(t => t.id)).toEqual(['5', '6', '7', '8', '9'])
    expect(done.more).toBe(4)
    expect(columnView(b, 'completed', { keep: ['2'] }).shown.map(t => t.id)).toEqual(['2', '6', '7', '8', '9'])
    const many = board(A, Array.from({ length: 8 }, (_, i) => task(String(i + 1))))
    expect(columnView(many, 'pending').shown.map(t => t.id)).toEqual(['1', '2', '3', '4', '5'])
    // A board the server capped: its totals count, not just what came over the wire
    const capped = board(A, [task('300', 'completed')], 1, { counts: { completed: 250 } })
    expect(boardCounts(capped)).toEqual({ pending: 0, in_progress: 0, completed: 250 })
    expect(columnView(capped, 'completed')).toMatchObject({ more: 249 })
  })

  it('a post-it\'s caption: the activeForm while in progress, what blocks a waiting one, its owner', () => {
    const b = board(A, [task('1', 'in_progress', { activeForm: 'Fixing the parser', owner: 'researcher' }), task('2', 'pending', { blockedBy: ['1'] }), task('3', 'completed', { activeForm: undefined })])
    expect(taskCaption(b.tasks[0], b)).toBe('#1 In progress: Fixing the parser · researcher')
    expect(taskCaption(b.tasks[1], b)).toBe('#2 To do: Task 2 (blocked by #1)')
    expect(taskCaption(b.tasks[2], b)).toBe('#3 Done: Task 3')
    expect(taskCaption(task('4', 'in_progress', { activeForm: undefined, subject: '' }), b)).toBe('#4 In progress: untitled task')
  })

  it('the label names the session (title, project, registry name, id) and counts boards when there are several', () => {
    const b = board(A, [task('1')])
    const sessions = [{ id: A, project: 'claude-office', title: 'Task board PR' } as SessionInfo]
    expect(boardLabel(b, sessions)).toBe('Task board PR')
    expect(boardLabel(b, [{ id: A, project: 'claude-office' } as SessionInfo], 0, 2)).toBe('claude-office 1/2')
    expect(boardLabel(b, [])).toBe('alpha')
    expect(boardLabel({ ...b, project: undefined }, [])).toBe('aaaaaaaa')
  })

  it('sits on the whiteboard of the room art, right above the kanban hotspot, with columns that fill it', () => {
    const hotspot = ROOMS['main-office'].furniture.find(f => f.id === 'kanban-board')!
    expect(hotspot.x).toBeGreaterThan(BOARD_RECT.left)
    expect(hotspot.x).toBeLessThan(BOARD_RECT.left + BOARD_RECT.width)
    expect(hotspot.y).toBeGreaterThan(BOARD_RECT.top + BOARD_RECT.height)
    expect(COLUMNS.reduce((sum, c) => sum + c.width, 0)).toBe(100)
    expect(COLUMNS.map(c => c.status)).toEqual(['pending', 'in_progress', 'completed'])
  })
})

describe('what the boss says at the board', () => {
  afterEach(() => resetTaskBoards())

  it('reads the board: what is in progress, what is next, how much is done, what is blocked', () => {
    expect(boardChatLines(board(A, [task('1'), task('2'), task('3', 'pending', { blockedBy: ['4'] }), task('4', 'in_progress', { subject: 'Fix the parser', activeForm: 'Fixing the parser' }), task('5', 'completed')])))
      .toEqual(['3 to do (1 blocked), 1 in progress: Fix the parser', 'Fixing the parser — 1 of 5 done'])
    expect(boardChatLines(board(A, [task('1', 'in_progress', { activeForm: undefined, subject: 'Ship it' })]))).toEqual(['1 in progress: Ship it'])
    expect(boardChatLines(board(A, [task('1', 'completed'), task('2', 'pending', { blockedBy: ['3'] }), task('3', 'pending', { subject: 'Write the docs' })])))
      .toEqual(['2 to do (1 blocked), next up: Write the docs', '1 of 3 done, 2 to go'])
    expect(boardChatLines(board(A, [task('1', 'pending', { blockedBy: ['2'] }), task('2', 'pending', { blockedBy: ['1'] })])))
      .toEqual(['2 to do (2 blocked), all waiting on something'])
    expect(boardChatLines(board(A, [task('1', 'completed'), task('2', 'completed')]))).toEqual(['all 2 tasks done'])
    expect(boardChatLines(board(A, [task('1', 'completed')]))).toEqual(['the one task on the board is done'])
  })

  it('the kanban hotspot (and the whiteboard) say it when a board is up, and keep their flavour lines when none is', () => {
    const flavour = getInteraction('kanban-board', null)!
    expect(flavour.chatMessage).toContain('moving tickets to done')
    expect(getInteraction('kanban-board')!.chatMessage).toEqual(flavour.chatMessage)    // the store is empty
    dispatchTaskBoards(one(board(A, [task('1', 'in_progress', { subject: 'Fix the parser' }), task('2'), task('3'), task('4')])))
    expect(getShownBoard()?.sessionId).toBe(A)
    const real = getInteraction('kanban-board')!
    expect(real.chatMessage[0]).toBe('3 to do, 1 in progress: Fix the parser')
    expect(real.chatMessage).not.toContain('moving tickets to done')
    expect(real).toMatchObject({ walkTo: flavour.walkTo, cooldown: flavour.cooldown, effect: flavour.effect })
    expect(getInteraction('whiteboard')!.chatMessage).toEqual(real.chatMessage)
    expect(getInteraction('coffee')!.chatMessage).toContain('coffee time!')
  })
})

describe('TaskBoard (static markup)', () => {
  afterEach(() => resetTaskBoards())
  const render = (sessions: SessionInfo[] = []) => renderToStaticMarkup(createElement(TaskBoard, { sessions, night: 0 }))

  it('draws nothing while no session has tasks: the decorative board stays as it is', () => {
    expect(render()).toBe('')
    dispatchTaskBoards(one(board(A, [])))
    expect(render()).toBe('')
  })

  it('draws the shown board: three columns of post-its by status, a red pin on a blocked one, "+N", the session label', () => {
    const done = Array.from({ length: 8 }, (_, i) => task(String(i + 1), 'completed'))
    dispatchTaskBoards(one(board(A, [...done, task('9', 'in_progress'), task('10', 'pending', { blockedBy: ['9'] }), task('11')], 1_000)))
    const html = render([{ id: A, project: 'claude-office' } as SessionInfo])
    expect(html).toContain('class="task-board theme-default"')
    expect(html).toContain(`skewY(${BOARD_RECT.skewDeg}deg)`)
    expect(html.match(/class="task-note pending/g)).toHaveLength(2)
    expect(html.match(/class="task-note in_progress/g)).toHaveLength(1)
    expect(html.match(/class="task-note completed/g)).toHaveLength(5)
    expect(html).toContain('class="task-note pending blocked')
    expect(html).toContain('+3</span>')
    expect(html).toContain('>claude-office</div>')
    expect(html).toContain('aria-label="Task board, claude-office: 2 to do, 1 in progress, 8 done"')
    // The latest change animates while fresh (the first board pops on)
    expect(html).toContain('fx-added')
    // Never a description: the board does not have one
    expect(html).not.toContain('description')
  })

  it('a second session\'s board: the label counts them and the board says a click shows the next', () => {
    dispatchTaskBoards(one(board(A, [task('1')], 1_000)))
    dispatchTaskBoards(one(board(B, [task('1', 'in_progress')], 2_000)))
    const html = render()
    expect(html).toContain('>beta 1/2</div>')
    expect(html).toContain('title="Task board: click for the next session"')
    expect(FX_MS).toBeGreaterThan(1000)
  })
})
