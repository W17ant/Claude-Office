/**
 * StatusStrip — pipeline health along the bottom of the office: connection
 * (online / reconnecting / offline), when a Claude Code hook last reached the
 * server — or that none has, with the installer command — how many sessions
 * there are, how many of them are not hooked and how many need you, and the
 * server's version. The answer to "nothing appears".
 *
 * The health lives in the office reducer (OfficeState.health: `connection`
 * actions from useAgentSocket, `health` events from server/health.js). The
 * strip samples it once a second — the cadence its "12 s ago" label needs
 * anyway — so nothing else re-renders on its account. The session counts
 * come from the sessions list App.tsx already holds (useAgentSocket), the
 * records the title-bar pills draw, not from the throttled health report.
 * Under ?sim / ?video there is no server: only a SIM badge.
 *
 * When the server showed the page the office read-only (no office token, or
 * a stale one: src/officeToken.ts) an amber item says so and how to get the
 * link that fixes it.
 *
 * The "today" button at the right end opens the day's numbers (TodayPanel,
 * GET /recap): counts only, so it is there on a read-only page too.
 *
 * VITE_HOOK_WARN_MS (build-time, ms) lowers the 60 s "no hook events yet"
 * threshold, for screenshots and demos.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { hookVerdict, initialHealth, HOOK_WARN_MS, type HealthState, type HookVerdict, type OfficeState, type ConnectionPhase } from '../officeReducer'
import { needsYouLabel, stripCounts, type StripCounts } from '../mainState'
import type { SessionInfo } from '../types'
import { pillLabel } from './SessionStrip'
import { officeHttpBase } from '../serverUrl'
import TodayPanel from './TodayPanel'
import { currentLanguage, t, useT } from '../i18n'
import '../styles/strip.css'

const params = new URLSearchParams(window.location.search)
const MODE: 'live' | 'sim' | 'video' = params.has('video') ? 'video' : params.has('sim') ? 'sim' : 'live'
const WARN_MS = Number(import.meta.env.VITE_HOOK_WARN_MS) || HOOK_WARN_MS

const SERVER_URL  = officeHttpBase()
const START_CMD   = 'npm run server'
const START_ALT   = 'bash scripts/start-office.sh'
const INSTALL_CMD = 'npm run install-hooks'
const DOCTOR_CMD  = 'npm run doctor'
const OPEN_CMD    = 'npm run open'
const readOnlyHint = () => t('ui.strip.readOnlyHint', { command: OPEN_CMD })

function connectionLabel(phase: ConnectionPhase): string {
  switch (phase) {
    case 'connecting':   return t('ui.strip.connection.connecting')
    case 'online':       return t('ui.strip.connection.online')
    case 'reconnecting': return t('ui.strip.connection.reconnecting')
    case 'offline':      return t('ui.strip.connection.offline')
  }
}

interface StatusStripProps {
  /** The office state as App.tsx holds it (officeRef); sampled, not subscribed */
  office: { readonly current: OfficeState | null }
  /** The sessions App.tsx holds (useAgentSocket): counted, not-hooked and needs-you */
  sessions?: SessionInfo[]
  /** The server sent the office read-only (useAgentSocket's `trusted` is false) */
  readOnly?: boolean
}

/** "just now", "12 s ago", "3 min ago", "2 h ago" */
export function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 2) return t('ui.time.justNow')
  if (s < 60) return t('ui.time.secondsAgo', { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('ui.time.minutesAgo', { count: m })
  const h = Math.floor(m / 60)
  if (h < 48) return t('ui.time.hoursAgo', { count: h })
  return t('ui.time.daysAgo', { count: Math.floor(h / 24) })
}

/** "45 s", "3 min", "2 h 05 min" */
export function formatSpan(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return t('ui.time.seconds', { count: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('ui.time.minutes', { count: m })
  const h = Math.floor(m / 60)
  return t('ui.time.hoursMinutes', { hours: h, minutes: String(m % 60).padStart(2, '0') })
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString(currentLanguage(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** The hooks pill: text and tone */
function hooksPill(v: HookVerdict): { text: string; tone: 'ok' | 'warn' | 'dim' } {
  switch (v.kind) {
    case 'unknown': return { text: t('ui.strip.hooks.unknown'), tone: 'dim' }
    case 'seen':    return { text: t('ui.strip.hooks.seen', { ago: formatAgo(v.agoMs) }), tone: v.agoMs < 10 * 60_000 ? 'ok' : 'dim' }
    case 'waiting': return { text: t('ui.strip.hooks.waiting'), tone: 'dim' }
    case 'missing': return { text: t('ui.strip.hooks.missing', { command: INSTALL_CMD }), tone: 'warn' }
  }
}

/** The tooltip: what is going on and what to type */
function describe(h: HealthState, v: HookVerdict, now: number, c: StripCounts): string {
  const s = h.server
  const lines: Array<string | null> = []
  switch (h.connection) {
    case 'online':       lines.push(t('ui.strip.tip.online', { url: SERVER_URL, time: clock(h.connectionSince) })); break
    case 'connecting':   lines.push(t('ui.strip.tip.connecting', { url: SERVER_URL })); break
    case 'reconnecting': lines.push(t('ui.strip.tip.reconnecting', { url: SERVER_URL, ago: formatAgo(now - h.connectionSince) })); break
    case 'offline':      lines.push(t('ui.strip.tip.offline', { url: SERVER_URL })); break
  }
  if (h.connection === 'offline' || h.connection === 'reconnecting') {
    lines.push(t('ui.strip.tip.start', { command: START_CMD, alt: START_ALT }))
  }
  switch (v.kind) {
    case 'seen':    lines.push(t('ui.strip.tip.hooksSeen', { count: v.count, ago: formatAgo(v.agoMs) })); break
    case 'waiting': lines.push(t('ui.strip.tip.hooksWaiting')); break
    case 'missing': lines.push(t('ui.strip.tip.hooksMissing', { span: formatSpan(v.forMs), command: INSTALL_CMD })); break
    case 'unknown': break
  }
  if (s) {
    lines.push(t('ui.strip.tip.counts', { sessions: s.sessions, agents: s.agents, clients: s.clients }))
    if (c.notHooked.length > 0) {
      lines.push(t('ui.strip.tip.notHooked', { count: c.notHooked.length, names: c.notHooked.map(pillLabel).join(', '), command: INSTALL_CMD }))
    }
    if (c.needYou.length > 0) {
      lines.push(t('ui.strip.tip.waitingOnYou'))
      for (const session of c.needYou) {
        if (session.main?.needsYou) lines.push(`  ${pillLabel(session)} — ${needsYouLabel(session.main.needsYou)}`)
      }
    }
    lines.push(t('ui.strip.tip.server', { version: s.version, span: formatSpan(s.uptimeMs + Math.max(0, now - (h.reportedAt ?? now))), ui: s.uiAvailable ? t('ui.strip.tip.uiBuilt') : t('ui.strip.tip.uiDev') }))
  }
  lines.push(t('ui.strip.tip.diagnose', { command: DOCTOR_CMD }))
  return lines.filter(Boolean).join('\n')
}

const StatusStrip: React.FC<StatusStripProps> = ({ office, sessions = [], readOnly = false }) => {
  const tr = useT()
  // Sample the reducer's health once a second (also ticks the "ago" labels)
  const [view, setView] = useState(() => ({ health: office.current?.health ?? null, now: Date.now() }))
  const [todayOpen, setTodayOpen] = useState(false)
  const todayRef = useRef<HTMLButtonElement>(null)
  const closeToday = useCallback(() => setTodayOpen(false), [])
  useEffect(() => {
    if (MODE !== 'live') return
    const sample = () => setView({ health: office.current?.health ?? null, now: Date.now() })
    const timer = setInterval(sample, 1000)
    return () => clearInterval(timer)
  }, [office])

  if (MODE !== 'live') {
    return (
      <div className="status-badge sim" title={t('ui.strip.simTitle', { mode: MODE })} data-mode={MODE}>
        SIM
      </div>
    )
  }

  const h = view.health ?? initialHealth(view.now)
  const v = hookVerdict(h, view.now, WARN_MS)
  const pill = hooksPill(v)
  const s = h.server
  const down = h.connection === 'offline' || h.connection === 'reconnecting'
  const c = stripCounts(sessions)

  return (
    <>
    <div
      className="status-strip"
      role="status"
      aria-label={tr('ui.strip.ariaLabel')}
      title={describe(h, v, view.now, c)}
      data-connection={h.connection}
      data-hooks={v.kind}
    >
      <span className="strip-item strip-conn">
        <span className="strip-dot" />
        {connectionLabel(h.connection)}
      </span>
      {readOnly && (
        <>
          <span className="strip-sep" />
          <span className="strip-item strip-readonly" title={readOnlyHint()} data-testid="strip-read-only">
            {tr('ui.strip.readOnly')} <code>{OPEN_CMD}</code>
          </span>
        </>
      )}
      <span className="strip-sep" />
      <span className={`strip-item strip-hooks ${pill.tone}`}>{pill.text}</span>
      {s && (
        <>
          <span className="strip-sep" />
          <span className="strip-item strip-sessions">
            {c.sessionsText}
            {c.notHookedText && <><span className="strip-mid">·</span><span className="strip-unhooked">{c.notHookedText}</span></>}
            {c.needYouText && <><span className="strip-mid">·</span><span className="strip-needs-you">{c.needYouText}</span></>}
          </span>
        </>
      )}
      <span className="strip-spacer" />
      {down && <span className="strip-item strip-hint">{tr('ui.strip.startIt')} <code>{START_CMD}</code></span>}
      {!down && v.kind === 'missing' && <span className="strip-item strip-hint"><code>{DOCTOR_CMD}</code></span>}
      <button
        ref={todayRef}
        type="button"
        className={`strip-item strip-today${todayOpen ? ' open' : ''}`}
        onClick={() => setTodayOpen(o => !o)}
        aria-expanded={todayOpen}
        title={tr('ui.strip.todayTitle')}
        data-testid="strip-today"
      >
        {tr('ui.strip.today')}
      </button>
      {s && <span className="strip-item strip-version">v{s.version}</span>}
    </div>
    {todayOpen && <TodayPanel onClose={closeToday} anchor={todayRef} />}
    </>
  )
}

export default StatusStrip
