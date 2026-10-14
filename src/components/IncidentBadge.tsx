/**
 * IncidentBadge — "🔥 INCIDENT 00:04:12" with a live timer, shown in the
 * chat header while incident mode is on. Keeps its own 1 s interval so the
 * rest of the app does not re-render every second.
 */

import React, { useEffect, useReducer } from 'react'
import { useIncident, formatClock } from '../incident'

const IncidentBadge: React.FC = () => {
  const incident = useIncident()
  const active = incident.variant === 'incident'
  const [, tick] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    if (!active) return
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [active])

  if (!active) return null
  const elapsed = Date.now() - (incident.startedAt ?? Date.now())
  const what = incident.mini ? 'MINI-INCIDENT' : 'INCIDENT'
  return (
    <div
      className="slack-incident-banner"
      title={incident.pinned ? 'Pinned by ?variant=incident — /all-clear to end' : 'Type /all-clear when prod is back'}
    >
      <span className="slack-incident-dot" />
      🔥 {what} {formatClock(elapsed)}
    </div>
  )
}

export default IncidentBadge
