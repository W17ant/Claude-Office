/**
 * StatusStrip — pipeline health along the bottom of the office: connection
 * (online / reconnecting / offline), when a Claude Code hook last reached the
 * server — or that none has, with the installer command — how many sessions
 * the server knows, and its version. The answer to "nothing appears".
 *
 * The state lives in the office reducer (OfficeState.health: `connection`
 * actions from useAgentSocket, `health` events from server/health.js). The
 * strip samples it once a second — the cadence its "12 s ago" label needs
 * anyway — so App.tsx mounts it with one line and nothing else re-renders on
 * its account. Under ?sim / ?video there is no server: only a SIM badge.
 *
 * VITE_HOOK_WARN_MS (build-time, ms) lowers the 60 s "no hook events yet"
 * threshold, for screenshots and demos.
 */

import React, { useEffect, useState } from 'react'
import { hookVerdict, initialHealth, HOOK_WARN_MS, type HealthState, type HookVerdict, type OfficeState, type ConnectionPhase } from '../officeReducer'
import '../styles/strip.css'

const params = new URLSearchParams(window.location.search)
const MODE: 'live' | 'sim' | 'video' = params.has('video') ? 'video' : params.has('sim') ? 'sim' : 'live'
const WARN_MS = Number(import.meta.env.VITE_HOOK_WARN_MS) || HOOK_WARN_MS

const SERVER_URL  = 'http://127.0.0.1:3334'
const START_CMD   = 'npm run server'
const START_ALT   = 'bash scripts/start-office.sh'
const INSTALL_CMD = 'npm run install-hooks'
const DOCTOR_CMD  = 'npm run doctor'

const CONNECTION_LABEL: Record<ConnectionPhase, string> = {
  connecting:   'connecting…',
  online:       'online',
  reconnecting: 'reconnecting…',
  offline:      'offline',
}

interface StatusStripProps {
  /** The office state as App.tsx holds it (officeRef); sampled, not subscribed */
  office: { readonly current: OfficeState | null }
}

/** "just now", "12 s ago", "3 min ago", "2 h ago" */
export function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 2) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

/** "45 s", "3 min", "2 h 05 min" */
export function formatSpan(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${String(m % 60).padStart(2, '0')} min`
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The hooks pill: text and tone */
function hooksPill(v: HookVerdict): { text: string; tone: 'ok' | 'warn' | 'dim' } {
  switch (v.kind) {
    case 'unknown': return { text: 'hooks: —', tone: 'dim' }
    case 'seen':    return { text: `hooks: last seen ${formatAgo(v.agoMs)}`, tone: v.agoMs < 10 * 60_000 ? 'ok' : 'dim' }
    case 'waiting': return { text: 'hooks: none yet', tone: 'dim' }
    case 'missing': return { text: `no hook events yet — run ${INSTALL_CMD}`, tone: 'warn' }
  }
}

/** The tooltip: what is going on and what to type */
function describe(h: HealthState, v: HookVerdict, now: number): string {
  const s = h.server
  const lines: Array<string | null> = []
  switch (h.connection) {
    case 'online':       lines.push(`Office server ${SERVER_URL}: online since ${clock(h.connectionSince)}`); break
    case 'connecting':   lines.push(`Office server ${SERVER_URL}: connecting…`); break
    case 'reconnecting': lines.push(`Office server ${SERVER_URL}: connection lost ${formatAgo(now - h.connectionSince)}, retrying`); break
    case 'offline':      lines.push(`Office server ${SERVER_URL}: not reachable`); break
  }
  if (h.connection === 'offline' || h.connection === 'reconnecting') {
    lines.push(`Start it from the checkout: ${START_CMD}  (or ${START_ALT})`)
  }
  switch (v.kind) {
    case 'seen':    lines.push(`Hooks: ${v.count} event${v.count === 1 ? '' : 's'} since the server started, last ${formatAgo(v.agoMs)}`); break
    case 'waiting': lines.push('Hooks: nothing yet — they fire when Claude Code runs a tool'); break
    case 'missing': lines.push(`Hooks: nothing in ${formatSpan(v.forMs)}. If Claude Code is running tool calls and nothing appears, the hooks are not installed: ${INSTALL_CMD}`); break
    case 'unknown': break
  }
  if (s) {
    lines.push(`Sessions: ${s.sessions} · agents: ${s.agents} · clients: ${s.clients}`)
    lines.push(`Server v${s.version}, up ${formatSpan(s.uptimeMs + Math.max(0, now - (h.reportedAt ?? now)))} · UI: ${s.uiAvailable ? 'built (dist/)' : 'dev server (dist/ not built)'}`)
  }
  lines.push(`Diagnose: ${DOCTOR_CMD}`)
  return lines.filter(Boolean).join('\n')
}

const StatusStrip: React.FC<StatusStripProps> = ({ office }) => {
  // Sample the reducer's health once a second (also ticks the "ago" labels)
  const [view, setView] = useState(() => ({ health: office.current?.health ?? null, now: Date.now() }))
  useEffect(() => {
    if (MODE !== 'live') return
    const sample = () => setView({ health: office.current?.health ?? null, now: Date.now() })
    const timer = setInterval(sample, 1000)
    return () => clearInterval(timer)
  }, [office])

  if (MODE !== 'live') {
    return (
      <div className="status-badge sim" title={`?${MODE}: simulated agents, no server, no hooks`} data-mode={MODE}>
        SIM
      </div>
    )
  }

  const h = view.health ?? initialHealth(view.now)
  const v = hookVerdict(h, view.now, WARN_MS)
  const pill = hooksPill(v)
  const s = h.server
  const down = h.connection === 'offline' || h.connection === 'reconnecting'

  return (
    <div
      className="status-strip"
      role="status"
      aria-label="Pipeline health"
      title={describe(h, v, view.now)}
      data-connection={h.connection}
      data-hooks={v.kind}
    >
      <span className="strip-item strip-conn">
        <span className="strip-dot" />
        {CONNECTION_LABEL[h.connection]}
      </span>
      <span className="strip-sep" />
      <span className={`strip-item strip-hooks ${pill.tone}`}>{pill.text}</span>
      {s && (
        <>
          <span className="strip-sep" />
          <span className="strip-item strip-sessions">{s.sessions} session{s.sessions === 1 ? '' : 's'}</span>
        </>
      )}
      <span className="strip-spacer" />
      {down && <span className="strip-item strip-hint">start it: <code>{START_CMD}</code></span>}
      {!down && v.kind === 'missing' && <span className="strip-item strip-hint"><code>{DOCTOR_CMD}</code></span>}
      {s && <span className="strip-item strip-version">v{s.version}</span>}
    </div>
  )
}

export default StatusStrip
