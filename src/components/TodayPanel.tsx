/**
 * TodayPanel - the status strip's "Today" popover: the day's numbers from
 * GET /recap (server/recap.js), fetched each time it opens and every 30 s
 * while it stays open. Numbers only, so it shows the same on a read-only page.
 */

import React, { useEffect, useRef, useState } from 'react'
import { fetchRecap, recapRows, type RecapStats } from '../recap'
import '../styles/settings.css'

// Why 30 s: the counts move with hook events; a popover left open should not
// go stale, and GET /recap is one indexed row
const REFRESH_MS = 30_000

interface TodayPanelProps {
  onClose: () => void
  /** The button that opened it: a click on it is the toggle, not an outside click */
  anchor: React.RefObject<HTMLElement>
}

/** "Mon 9 Nov" for a YYYY-MM-DD local date */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

const TodayPanel: React.FC<TodayPanelProps> = ({ onClose, anchor }) => {
  const [stats, setStats] = useState<RecapStats | null>(null)
  const [failed, setFailed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    const load = () => fetchRecap().then(s => {
      if (!alive) return
      if (s) { setStats(s); setFailed(false) } else setFailed(true)
    })
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  // Escape or a click elsewhere closes it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [onClose, anchor])

  return (
    <div className="today-panel office-popover" role="dialog" aria-label="Today in the office" ref={ref} data-testid="today-panel">
      <div className="op-head">
        <span className="op-title">Today{stats ? ` · ${dayLabel(stats.date)}` : ''}</span>
        <button className="op-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      {!stats && <div className="op-note">{failed ? 'The office server is not answering.' : 'Counting…'}</div>}
      {stats && (
        <dl className="today-grid">
          {recapRows(stats).map(row => (
            <React.Fragment key={row.key}>
              <dt>{row.label}</dt>
              <dd className={`tone-${row.tone}`}>{row.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <div className="op-foot">Since local midnight · type <code>/recap</code> in the chat for the manager's take</div>
    </div>
  )
}

export default TodayPanel
