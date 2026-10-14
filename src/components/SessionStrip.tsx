/**
 * SessionStrip — one pill per Claude Code session (terminal) in the title bar.
 *
 * Each pill shows the session's project (basename of its cwd), how many of
 * the agents in the office work for it, and a dot: green/pulsing while the
 * session is busy (one of its agents is working, or its main thread made a
 * tool call in the last BUSY_WINDOW_MS), dim when idle, red once it ended.
 * A main-thread status with no worker to show it on is shown on the pill.
 * Two terminals = two pills. Nothing renders while no session is known.
 */

import React, { useEffect, useState } from 'react'
import { Agent, SessionInfo } from '../types'

// Main-thread activity counts as "busy" for this long after the last tool call
const BUSY_WINDOW_MS = 10_000

interface SessionStripProps {
  sessions: SessionInfo[]
  agents: Agent[]
}

function describe(session: SessionInfo, agentCount: number, workingCount: number): string {
  const lines = [
    `${session.title ?? session.project ?? session.id}`,
    session.cwd ? `cwd: ${session.cwd}` : null,
    session.model ? `model: ${session.model}` : null,
    session.source ? `started: ${session.source}` : null,
    `agents: ${agentCount} (${workingCount} working)`,
    session.lastStatus ? `claude: ${session.lastStatus}` : null,
    session.state === 'ended' ? `ended${session.reason ? ` (${session.reason})` : ''}` : null,
    `session ${session.id}`,
  ]
  return lines.filter(Boolean).join('\n')
}

const SessionStrip: React.FC<SessionStripProps> = ({ sessions, agents }) => {
  // Re-render once a second so the busy dot goes idle after BUSY_WINDOW_MS
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (sessions.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sessions.length])

  if (sessions.length === 0) return null

  const ordered = [...sessions].sort((a, b) =>
    (a.state === 'ended' ? 1 : 0) - (b.state === 'ended' ? 1 : 0) || (a.startedAt ?? 0) - (b.startedAt ?? 0))

  return (
    <div className="session-strip" aria-label="Claude Code sessions">
      {ordered.map(session => {
        const mine = agents.filter(a => a.sessionId === session.id && a.state !== 'completed')
        const working = mine.filter(a => a.state === 'working')
        const mainThreadBusy = !!session.lastStatusAt && now - session.lastStatusAt < BUSY_WINDOW_MS
        const ended = session.state === 'ended'
        const busy = !ended && (working.length > 0 || mainThreadBusy)
        const tone = ended ? 'ended' : busy ? 'busy' : 'idle'
        // Main-thread status shown here only while no worker of this session can show it
        const showStatus = !ended && mainThreadBusy && working.length === 0 && !!session.lastStatus

        return (
          <div
            key={session.id}
            className={`session-pill ${tone}`}
            title={describe(session, mine.length, working.length)}
            data-session-id={session.id}
          >
            <span className={`session-dot ${tone}`} />
            <span className="session-pill-project">{session.title ?? session.project ?? session.id.slice(0, 8)}</span>
            <span className="session-pill-count" title={`${mine.length} agent${mine.length === 1 ? '' : 's'}`}>{mine.length}</span>
            {showStatus && <span className="session-pill-status">{session.lastStatus}</span>}
          </div>
        )
      })}
    </div>
  )
}

export default SessionStrip
