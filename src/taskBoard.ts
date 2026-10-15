/**
 * taskBoard.ts — the kanban whiteboard's state and words: each session's task
 * list as server/tasks.js sends it (a `task_board` broadcast per change,
 * `taskBoards` on the snapshot), which board the wall shows, what changed
 * (so a post-it can flash or slide), how a column fits on the wall, and the
 * line the boss says at the board.
 *
 * A tiny external store in the meters.ts style — module state, listeners,
 * useSyncExternalStore — so App.tsx only forwards `task_board` events, the
 * TaskBoard component subscribes on its own, and the board's hotspot
 * (src/interactions.ts) reads the shown board when it is clicked.
 * reduceTaskBoards and the helpers are pure and unit-tested in plain Node.
 */

import { useSyncExternalStore } from 'react'
import type { OfficeEvent, SessionInfo } from './types'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One post-it: a task as server/tasks.js broadcasts it (never its description). */
export interface BoardTask {
  id: string
  subject: string
  activeForm?: string
  status: TaskStatus
  /** The ids it waits on, as Claude Code wrote them (a completed blocker no longer blocks) */
  blockedBy: string[]
  owner?: string
}

/** One session's board (server/tasks.js) */
export interface TaskBoardInfo {
  sessionId: string
  project?: string
  tasks: BoardTask[]
  /** Totals per status — larger than `tasks` holds only for a board past the server's cap */
  counts?: Partial<Record<TaskStatus, number>>
  /** When the session's task files last changed (ms) */
  updatedAt: number
}

/** What happened to a post-it in the latest change: it went in progress, it got done, it is new. */
export type TaskFx = 'started' | 'done' | 'added'

export interface TaskBoardsState {
  /** Boards with at least one task, the most recently changed first */
  boards: TaskBoardInfo[]
  /** The session a click on the board chose; the next change on any board lets the newest win again */
  pinned: string | null
  /** The latest change's effects, per task id of that session's board */
  fx: { sessionId: string; at: number; tasks: Record<string, TaskFx> } | null
}

/** How long a post-it's flash / slide counts as fresh (a re-mount after this does not replay it). */
export const FX_MS = 1800
/** Post-its per column before the last slot becomes "+N" */
export const COLUMN_MAX = 6

/**
 * Where the board's writing surface sits in the room art, in % of the room
 * (the room container keeps the art's aspect, 1508×1126). Measured from the
 * whiteboard's white area in public/rooms/office-day.png — the Dunder Mifflin
 * room (office-day-dm.png) puts its board at the same place to within a tenth
 * of a percent: the left edge at x 74.85 %, its top at y 26.1 % and its height
 * 9.9 % of the room, the right edge at x 85.45 %; the wall recedes, so the top
 * edge drops 0.427 px per px to the right (skewY 23.1°). The 'kanban-board'
 * hotspot (80 %, 42 %) sits just under its bottom edge.
 */
export const BOARD_RECT = Object.freeze({ left: 74.85, top: 26.1, width: 10.6, height: 9.9, skewDeg: 23.1 })

/** The columns the art draws, left to right, and how much of the board each takes (its dividers, measured). */
export const COLUMNS: ReadonlyArray<{ status: TaskStatus; title: string; width: number }> = Object.freeze([
  { status: 'pending', title: 'To do', width: 29 },
  { status: 'in_progress', title: 'In progress', width: 40 },
  { status: 'completed', title: 'Done', width: 31 },
])

const STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed'])
const EMPTY: TaskBoardsState = { boards: [], pinned: null, fx: null }

// ---------------------------------------------------------------------------
// Reducer (pure)
// ---------------------------------------------------------------------------

/** A board from the wire, checked: null unless it names a session and has at least one well-formed task. */
export function cleanBoard(raw: unknown): TaskBoardInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Partial<TaskBoardInfo>
  if (typeof b.sessionId !== 'string' || !b.sessionId || !Array.isArray(b.tasks)) return null
  const tasks = b.tasks.filter((t): t is BoardTask =>
    !!t && typeof t === 'object' && typeof t.id === 'string' && STATUSES.has(t.status)).map(t => ({
    ...t,
    subject: typeof t.subject === 'string' ? t.subject : '',
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.filter(id => typeof id === 'string') : [],
  }))
  if (tasks.length === 0) return null
  return { ...b, sessionId: b.sessionId, tasks, updatedAt: typeof b.updatedAt === 'number' ? b.updatedAt : 0 } as TaskBoardInfo
}

function byRecency(a: TaskBoardInfo, b: TaskBoardInfo) {
  return b.updatedAt - a.updatedAt
}

/** What changed between a board and its next version, per task id. */
export function diffBoards(prev: TaskBoardInfo | undefined, next: TaskBoardInfo): Record<string, TaskFx> {
  const out: Record<string, TaskFx> = {}
  const before = new Map((prev?.tasks ?? []).map(t => [t.id, t]))
  for (const t of next.tasks) {
    const old = before.get(t.id)
    if (!old) out[t.id] = 'added'
    else if (old.status !== t.status && t.status === 'in_progress') out[t.id] = 'started'
    else if (old.status !== t.status && t.status === 'completed') out[t.id] = 'done'
  }
  return out
}

export function reduceTaskBoards(prev: TaskBoardsState, event: OfficeEvent, now = Date.now()): TaskBoardsState {
  if (event.type !== 'task_board') return prev
  // Snapshot form: the server's boards replace ours (a reconnect may have missed changes); nothing animates
  if (Array.isArray(event.boards)) {
    const boards = event.boards.map(cleanBoard).filter((b): b is TaskBoardInfo => b !== null).sort(byRecency)
    const pinned = prev.pinned && boards.some(b => b.sessionId === prev.pinned) ? prev.pinned : null
    return { boards, pinned, fx: null }
  }
  const sessionId = event.sessionId
  if (!sessionId) return prev
  const next = cleanBoard(event.board)
  const old = prev.boards.find(b => b.sessionId === sessionId)
  if (!next && !old) return prev
  const others = prev.boards.filter(b => b.sessionId !== sessionId)
  const boards = next ? [...others, next].sort(byRecency) : others
  // The board that changed last is the one on the wall again
  const fx = next ? { sessionId, at: now, tasks: diffBoards(old, next) } : prev.fx?.sessionId === sessionId ? null : prev.fx
  return { boards, pinned: null, fx }
}

/** The board on the wall: the one a click chose, else the one that changed last; null when no session has tasks. */
export function shownBoard(state: TaskBoardsState): TaskBoardInfo | null {
  if (state.pinned) {
    const pinned = state.boards.find(b => b.sessionId === state.pinned)
    if (pinned) return pinned
  }
  return state.boards[0] ?? null
}

/** A click on the board with several sessions' boards up: the next one. */
export function cycleBoards(state: TaskBoardsState): TaskBoardsState {
  if (state.boards.length < 2) return state
  const current = shownBoard(state)
  const i = current ? state.boards.indexOf(current) : -1
  return { ...state, pinned: state.boards[(i + 1) % state.boards.length].sessionId, fx: null }
}

// ---------------------------------------------------------------------------
// What the wall shows (pure)
// ---------------------------------------------------------------------------

/** Waiting on a task that is on the board and not done yet (Claude Code leaves finished blockers listed). */
export function isBlocked(task: BoardTask, board: TaskBoardInfo): boolean {
  if (task.status === 'completed' || task.blockedBy.length === 0) return false
  return task.blockedBy.some(id => {
    const blocker = board.tasks.find(t => t.id === id)
    return !!blocker && blocker.status !== 'completed'
  })
}

/** How many tasks per status: the server's totals when it sent them, else counted. */
export function boardCounts(board: TaskBoardInfo): Record<TaskStatus, number> {
  const counted = { pending: 0, in_progress: 0, completed: 0 }
  for (const t of board.tasks) counted[t.status]++
  return {
    pending: Math.max(counted.pending, board.counts?.pending ?? 0),
    in_progress: Math.max(counted.in_progress, board.counts?.in_progress ?? 0),
    completed: Math.max(counted.completed, board.counts?.completed ?? 0),
  }
}

export interface ColumnView {
  status: TaskStatus
  /** The post-its drawn, in id order */
  shown: BoardTask[]
  /** How many more there are than the column shows ("+N"), 0 when all fit */
  more: number
}

function compareIds(a: string, b: string) {
  const na = /^\d+$/.test(a)
  const nb = /^\d+$/.test(b)
  if (na && nb) return Number(a) - Number(b)
  if (na !== nb) return na ? -1 : 1
  return a.localeCompare(b)
}

/**
 * One column as the wall can draw it: every post-it when they fit in `max`,
 * else max - 1 of them and a "+N". The ones that just changed (`keep`) are
 * always among them; then the next up for To do and In progress (lowest ids)
 * and the latest for Done (highest ids).
 */
export function columnView(board: TaskBoardInfo, status: TaskStatus, { max = COLUMN_MAX, keep = [] as string[] } = {}): ColumnView {
  const list = board.tasks.filter(t => t.status === status).sort((a, b) => compareIds(a.id, b.id))
  const total = boardCounts(board)[status]
  if (total <= max) return { status, shown: list, more: 0 }
  const slots = Math.max(0, max - 1)
  const first = list.filter(t => keep.includes(t.id))
  const rest = list.filter(t => !keep.includes(t.id))
  const ordered = status === 'completed' ? [...first, ...rest.reverse()] : [...first, ...rest]
  const shown = ordered.slice(0, slots).sort((a, b) => compareIds(a.id, b.id))
  return { status, shown, more: total - shown.length }
}

/** One line, at most `max` characters, an ellipsis when cut. */
export function clip(text: string | undefined, max = 60): string {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** What hovering a post-it says: the activeForm while in progress, what blocks a waiting one, who owns it. */
export function taskCaption(task: BoardTask, board: TaskBoardInfo): string {
  const subject = clip(task.subject, 90) || 'untitled task'
  let text: string
  if (task.status === 'in_progress') text = `In progress: ${clip(task.activeForm, 90) || subject}`
  else if (task.status === 'completed') text = `Done: ${subject}`
  else {
    const blockers = task.blockedBy.filter(id => board.tasks.some(t => t.id === id && t.status !== 'completed'))
    text = `To do: ${subject}${blockers.length ? ` (blocked by ${blockers.map(id => `#${id}`).join(', ')})` : ''}`
  }
  return `#${task.id} ${text}${task.owner ? ` · ${clip(task.owner, 30)}` : ''}`
}

/** The tiny label on the board: the session's title or project, and "2/3" while several boards are up. */
export function boardLabel(board: TaskBoardInfo, sessions: SessionInfo[] = [], index = 0, total = 1): string {
  const session = sessions.find(s => s.id === board.sessionId)
  const name = clip(session?.title || session?.project || board.project || session?.registry?.name || board.sessionId.slice(0, 8), 24)
  return total > 1 ? `${name} ${index + 1}/${total}` : name
}

/**
 * What the boss says at the board, from the board itself: "3 to do, 1 in
 * progress: Fix the parser", "2 to do, next up: Write the docs", "all 5 tasks
 * done". Every line is true; the interaction picks one.
 */
export function boardChatLines(board: TaskBoardInfo): string[] {
  const n = boardCounts(board)
  const total = n.pending + n.in_progress + n.completed
  const blocked = board.tasks.filter(t => t.status === 'pending' && isBlocked(t, board)).length
  const todo = n.pending ? `${n.pending} to do${blocked ? ` (${blocked} blocked)` : ''}` : ''
  const doing = board.tasks.filter(t => t.status === 'in_progress').sort((a, b) => compareIds(a.id, b.id))
  const lines: string[] = []
  if (doing.length) {
    lines.push(`${todo ? `${todo}, ` : ''}${n.in_progress} in progress: ${clip(doing[0].subject) || `#${doing[0].id}`}`)
    if (doing[0].activeForm) lines.push(`${clip(doing[0].activeForm)} — ${n.completed} of ${total} done`)
  } else if (n.pending) {
    const next = board.tasks.filter(t => t.status === 'pending' && !isBlocked(t, board)).sort((a, b) => compareIds(a.id, b.id))[0]
    lines.push(next ? `${todo}, next up: ${clip(next.subject) || `#${next.id}`}` : `${todo}, all waiting on something`)
    if (n.completed) lines.push(`${n.completed} of ${total} done, ${n.pending} to go`)
  } else {
    lines.push(n.completed === 1 ? 'the one task on the board is done' : `all ${n.completed} tasks done`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let state: TaskBoardsState = EMPTY
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function set(next: TaskBoardsState) {
  if (next === state) return
  state = next
  emit()
}

export function getTaskBoards(): TaskBoardsState {
  return state
}

/** The board on the wall right now (the kanban hotspot's chat line reads it), or null. */
export function getShownBoard(): TaskBoardInfo | null {
  return shownBoard(state)
}

export function resetTaskBoards() {
  set(EMPTY)
}

export function subscribeTaskBoards(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useTaskBoards(): TaskBoardsState {
  return useSyncExternalStore(subscribeTaskBoards, getTaskBoards, getTaskBoards)
}

/** Forward a task_board event from the socket (one board, or the snapshot's `boards`). */
export function dispatchTaskBoards(event: OfficeEvent) {
  set(reduceTaskBoards(state, event))
}

/** A click on the board: show the next session's board (when there are several). */
export function cycleTaskBoards() {
  set(cycleBoards(state))
}
