/**
 * TaskBoard — the session's real task list (Claude Code's TaskCreate /
 * TaskUpdate tools, read by server/tasks.js) as post-its on the kanban
 * whiteboard that is baked into the room art.
 *
 * Rendered as siblings inside .room-container, positioned in % of the room
 * like IncidentLayer: a whiteboard-coloured panel laid over the board's
 * writing surface and skewed along the wall (skewY, BOARD_RECT in
 * src/taskBoard.ts) covers the art's decorative post-its and carries three
 * columns — To do (yellow), In progress (blue), Done (green); a post-it whose
 * blocker is still open wears a red pin, at most COLUMN_MAX fit a column
 * before the last slot says "+N". Hovering a post-it shows what it is (the
 * activeForm while in progress) in a caption above the board. The board shows
 * the session whose tasks changed last, with its name in the corner; with
 * several sessions' boards up, a click shows the next one. A click also does
 * what the board's hotspot always did (the boss walks over and reads it out).
 *
 * With no session's tasks it draws nothing at all: the decorative board stays
 * exactly as it was, so an office without task lists never looks broken.
 */

import React, { useState } from 'react'
import { useTheme } from '../theme'
import type { SessionInfo } from '../types'
import {
  BOARD_RECT, COLUMNS, FX_MS, boardCounts, boardLabel, columnView, cycleTaskBoards, isBlocked, shownBoard, taskCaption,
  useTaskBoards, type BoardTask, type TaskBoardInfo, type TaskFx,
} from '../taskBoard'
import '../styles/taskboard.css'

interface TaskBoardProps {
  /** The sessions the title bar shows: the label names the board's session */
  sessions: SessionInfo[]
  /** 0 day … 1 night, as the room's night art is faded in: the board dims with it */
  night: number
  /** A click on the board does what the 'kanban-board' hotspot under it does */
  onActivate?: () => void
}

const FX_CLASS: Record<TaskFx, string> = { started: ' fx-started', done: ' fx-done', added: ' fx-added' }

const Note: React.FC<{
  task: BoardTask
  board: TaskBoardInfo
  fx?: TaskFx
  onHover: (id: string | null) => void
}> = ({ task, board, fx, onHover }) => {
  const blocked = isBlocked(task, board)
  return (
    <span
      className={`task-note ${task.status}${blocked ? ' blocked' : ''}${fx ? FX_CLASS[fx] : ''}`}
      aria-label={taskCaption(task, board)}
      onMouseEnter={() => onHover(task.id)}
      onMouseLeave={() => onHover(null)}
    />
  )
}

const TaskBoard: React.FC<TaskBoardProps> = ({ sessions, night, onActivate }) => {
  const state = useTaskBoards()
  const theme = useTheme()
  const [hovered, setHovered] = useState<string | null>(null)

  const board = shownBoard(state)
  if (!board) return null

  const several = state.boards.length > 1
  const label = boardLabel(board, sessions, state.boards.indexOf(board), state.boards.length)
  // Only the latest change animates, and only while it is fresh: cycling back
  // to a board later does not replay it
  const fresh = state.fx && state.fx.sessionId === board.sessionId && Date.now() - state.fx.at < FX_MS
  const fx: Record<string, TaskFx> = fresh ? state.fx!.tasks : {}
  const keep = Object.keys(fx)
  const counts = boardCounts(board)
  const hoveredTask = hovered ? board.tasks.find(t => t.id === hovered) : undefined

  const activate = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    if (several) cycleTaskBoards()
    onActivate?.()
  }

  return (
    <>
      <div
        className={`task-board theme-${theme}`}
        style={{
          left: `${BOARD_RECT.left}%`,
          top: `${BOARD_RECT.top}%`,
          width: `${BOARD_RECT.width}%`,
          height: `${BOARD_RECT.height}%`,
          transform: `skewY(${BOARD_RECT.skewDeg}deg)`,
        }}
        role="button"
        tabIndex={0}
        aria-label={`Task board, ${label}: ${counts.pending} to do, ${counts.in_progress} in progress, ${counts.completed} done${several ? '. Click for the next session' : ''}`}
        title={several ? 'Task board: click for the next session' : 'Task board'}
        onClick={activate}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') activate(e) }}
      >
        <div className="task-board-surface" />
        <div className="task-board-columns">
          {COLUMNS.map(col => {
            const view = columnView(board, col.status, { keep })
            return (
              <div key={col.status} className={`task-col ${col.status}`} style={{ width: `${col.width}%` }}>
                <div className="task-col-title">{col.title}</div>
                <div className="task-col-notes">
                  {view.shown.map(task => (
                    <Note key={task.id} task={task} board={board} fx={fx[task.id]} onHover={id => setHovered(id)} />
                  ))}
                  {view.more > 0 && <span className="task-more" aria-label={`${view.more} more`}>+{view.more}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="task-board-label">{label}</div>
        {/* The room's night art darkens the board; this follows it (multiply, per theme) */}
        <div className="task-board-night" style={{ opacity: Math.max(0, Math.min(1, night)) }} aria-hidden="true" />
      </div>

      {hoveredTask && (
        <div
          className={`task-board-caption ${hoveredTask.status}`}
          style={{ left: `${BOARD_RECT.left}%`, top: `${BOARD_RECT.top - 0.8}%` }}
          role="tooltip"
        >
          {taskCaption(hoveredTask, board)}
        </div>
      )}
    </>
  )
}

export default TaskBoard
