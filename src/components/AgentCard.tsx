/**
 * AgentCard — the inspector: click a character and this card says what it
 * is and what it has done. It fetches GET /agents/:id when it opens and
 * every INSPECT_POLL_MS while open (and stops when closed), and falls back to
 * the office's own record for a character the server does not know (?sim,
 * the boss, a worker already forgotten). It closes on Esc, its button, or
 * the same character clicked again (App toggles the id). It floats over the
 * top-left of the room and never covers the chat; the office keeps moving
 * underneath. Labels and the response shape live in src/inspector.ts.
 */

import React, { useEffect, useRef, useState } from 'react'
import type { Agent, SessionInfo } from '../types'
import { AGENT_CONFIGS } from '../types'
import { shortModel, formatTokensShort } from '../mainState'
import {
  type Inspection, type InspectSource,
  inspectUrl, INSPECT_POLL_MS, HISTORY_SHOWN,
  mainStateLabel, workerStateLabel, toolCountRows, recentHistory, clockTime, atItFor, finishedStats,
  historyMark, transcriptEmptyText, transcriptLine, fallbackInspection, promptAndReply, shortSession, derivedNote, cardSide,
} from '../inspector'
import { getUiToken } from '../permissions'
import { officeAuthHeaders } from '../officeAuth'
import { useT } from '../i18n'
import '../styles/inspector.css'

interface AgentCardProps {
  /** The clicked character, or null when the card is closed */
  agentId: string | null
  /** The office's own record of it (undefined once it has left) */
  agent?: Agent
  /** The sessions the socket knows (their main record carries the prompt text) */
  sessions?: SessionInfo[]
  onClose: () => void
}

const AgentCard: React.FC<AgentCardProps> = ({ agentId, agent, sessions = [], onClose }) => {
  const tr = useT()
  const [data, setData] = useState<Inspection | null>(null)
  const [missing, setMissing] = useState<'unknown' | 'unreachable' | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Top-left of the room, unless that would hide the character itself (the
  // desks by the left wall): then the right side of the room, still clear of
  // the chat. Picked once per open, so a walking character never moves it.
  const [side, setSide] = useState<'left' | 'right'>('left')
  const agentRef = useRef(agent)
  agentRef.current = agent
  useEffect(() => {
    setSide(cardSide(agentRef.current?.position.x))
  }, [agentId])

  // Fetch on open, then every INSPECT_POLL_MS; nothing runs once closed
  useEffect(() => {
    if (!agentId) return
    setData(null)
    setMissing(null)
    let cancelled = false
    const load = async () => {
      try {
        // The UI token from the WebSocket snapshot (src/permissions.ts keeps it) is
        // what lets the server hand over the transcript tail and prompt text; read
        // per request, so the first poll after the snapshot already carries it
        const token = getUiToken()
        const res = await fetch(inspectUrl(agentId), {
          signal: AbortSignal.timeout(1500),
          // Without the UI token yet, a proxied page still needs one to read (src/officeAuth.ts)
          headers: token ? { Authorization: `Bearer ${token}` } : officeAuthHeaders(),
        })
        if (cancelled) return
        // A finished worker answers 404 once the server lets it go: keep its last card
        if (res.status === 404) { setMissing('unknown'); return }
        if (!res.ok) { setMissing('unreachable'); return }
        setData(await res.json() as Inspection)
        setMissing(null)
      } catch {
        if (!cancelled) setMissing('unreachable')
      } finally {
        if (!cancelled) setNow(Date.now())
      }
    }
    void load()
    const timer = setInterval(() => void load(), INSPECT_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [agentId])

  // Esc closes
  useEffect(() => {
    if (!agentId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentId])

  // The character has left the office and the server has forgotten it: nothing left to show
  useEffect(() => {
    if (agentId && !agent && missing === 'unknown') onCloseRef.current()
  }, [agentId, agent, missing])

  if (!agentId) return null

  const source: InspectSource = data ? 'server' : agent ? 'office' : 'loading'
  const insp: Inspection | null = data ?? (agent ? fallbackInspection(agent, sessions) : null)
  if (!insp) {
    return (
      <div className={`agent-card side-${side}`} role="dialog" aria-label={tr('ui.agentCard.ariaLabel')} data-testid="agent-card">
        <div className="ac-head"><span className="ac-name">…</span><button className="ac-close" onClick={onClose} aria-label={tr('ui.agentCard.close')}>×</button></div>
      </div>
    )
  }

  const isMain = insp.kind === 'main'
  const session = sessions.find(s => s.id === insp.sessionId)
  const color = agent?.color ?? AGENT_CONFIGS[insp.role]?.color ?? AGENT_CONFIGS['default'].color
  const stateText = isMain ? mainStateLabel(insp.main ?? session?.main) : workerStateLabel(insp.state)
  const elapsed = atItFor(insp, now)
  const counts = toolCountRows(insp.toolCounts)
  const calls = counts.reduce((sum, r) => sum + r.n, 0)
  const history = recentHistory(insp.history, HISTORY_SHOWN)
  const finished = finishedStats(insp.stats)
  const derived = derivedNote(insp.stats)
  const done = isMain ? false : insp.state === 'completed' || typeof insp.stats.completedAt === 'number'
  const { prompt, reply, hidden } = isMain ? promptAndReply(insp, session) : { prompt: undefined, reply: undefined, hidden: false }
  const model = shortModel(insp.model ?? insp.stats.model)
  const emptyTranscript = transcriptEmptyText(insp)
  const isBoss = insp.role === 'boss'

  return (
    <div className={`agent-card side-${side}${isMain ? ' main' : ''}${done ? ' done' : ''}`} role="dialog" aria-label={tr('ui.agentCard.ariaNamed', { name: insp.name })} data-testid="agent-card" data-agent-id={insp.id}>
      <div className="ac-head">
        <span className="ac-dot" style={{ background: color }} aria-hidden="true" />
        <span className="ac-name">{insp.name}</span>
        <span className="ac-role">{isMain ? tr('ui.agentCard.roleMain') : insp.role}</span>
        {model && <span className="ac-model" title={insp.model ?? insp.stats.model}>{model}</span>}
        <button className="ac-close" onClick={onClose} aria-label={tr('ui.agentCard.close')} title={tr('ui.agentCard.closeTitle')}>×</button>
      </div>

      <div className="ac-state-row">
        <span className={`ac-state state-${isMain ? (insp.main?.state ?? session?.main?.state ?? 'unknown') : insp.state}`}>{stateText}</span>
        {elapsed && <span className="ac-elapsed" title={done ? tr('ui.agentCard.tookTitle') : tr('ui.agentCard.forTitle')}>{done ? tr('ui.agentCard.took', { elapsed }) : tr('ui.agentCard.for', { elapsed })}</span>}
      </div>

      {isBoss ? (
        <div className="ac-section"><div className="ac-text">{tr('ui.agentCard.isBoss')}</div></div>
      ) : (
        <>
          {!isMain && (
            <div className="ac-section">
              <div className="ac-h">{tr('ui.agentCard.task')}</div>
              <div className="ac-text">{insp.task || <span className="ac-empty">{tr('ui.agentCard.noTask')}</span>}</div>
              {insp.status && <div className="ac-sub" title={insp.status}>{insp.lastError && insp.status === insp.lastError ? '✗ ' : '› '}{insp.status}</div>}
            </div>
          )}

          {isMain && insp.hooked === false && (
            <div className="ac-section"><div className="ac-empty">{tr('ui.agentCard.notHooked')}</div></div>
          )}

          {isMain && (
            <div className="ac-section">
              <div className="ac-h">{tr('ui.agentCard.lastPrompt')}</div>
              <div className="ac-text ac-quote">
                {hidden ? <span className="ac-empty">{tr('ui.agentCard.promptsHidden')}</span>
                  : prompt ? prompt : <span className="ac-empty">{tr('ui.agentCard.nothingYet')}</span>}
              </div>
              <div className="ac-h">{tr('ui.agentCard.lastReply')}</div>
              <div className="ac-text ac-quote">
                {hidden ? <span className="ac-empty">{tr('ui.agentCard.promptsHidden')}</span>
                  : reply ? reply : <span className="ac-empty">{tr('ui.agentCard.nothingYet')}</span>}
              </div>
              <div className="ac-kv">
                {insp.main?.needsYou && <span className="ac-kv-item needs-you">✋ {insp.main.needsYou.toolName ?? insp.main.needsYou.kind}{insp.main.needsYou.summary ? ` · ${insp.main.needsYou.summary}` : ''}</span>}
                <span className="ac-kv-item">{tr('ui.agentCard.crons', { count: insp.crons ?? insp.main?.crons ?? 0 })}</span>
                <span className="ac-kv-item">{tr('ui.agentCard.waitingOn', { count: insp.main?.waitingOn ?? 0 })}</span>
                {typeof insp.stats.contextTokens === 'number' && <span className="ac-kv-item" title={tr('ui.agentCard.contextTitle')}>{tr('ui.agentCard.context', { tokens: formatTokensShort(insp.stats.contextTokens) })}</span>}
                {insp.session && <span className="ac-kv-item">{tr('ui.sessions.workers', { count: insp.session.agentCount ?? 0 })}</span>}
              </div>
            </div>
          )}

          <div className="ac-section ac-where">
            <div className="ac-h">{tr('ui.agentCard.where')}</div>
            <div className="ac-text">
              {insp.project ?? <span className="ac-empty">{tr('ui.agentCard.noProject')}</span>}
              {insp.title ? ` · ${insp.title}` : ''}
              {shortSession(insp.sessionId) ? <span className="ac-muted"> · {tr('ui.agentCard.session', { id: shortSession(insp.sessionId)! })}</span> : <span className="ac-empty"> · {tr('ui.agentCard.noSession')}</span>}
            </div>
            {insp.cwd && <div className="ac-sub" title={insp.cwd}>{insp.cwd}</div>}
          </div>

          <div className="ac-section">
            <div className="ac-h">{tr('ui.agentCard.tools')}{calls ? ` · ${tr('ui.agentCard.calls', { count: calls })}` : ''}</div>
            {insp.restored && <div className="ac-sub">{tr('ui.agentCard.restored')}</div>}
            {counts.length === 0 ? (
              <div className="ac-empty">{tr('ui.agentCard.noTools')}</div>
            ) : (
              <div className="ac-chips">
                {counts.map(r => <span key={r.tool} className="ac-chip" title={r.tool}>{r.tool} <b>{r.n}</b></span>)}
              </div>
            )}
            {history.length > 0 && (
              <ul className="ac-hist" aria-label={tr('ui.agentCard.historyAria', { count: history.length })}>
                {history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className={`kind-${h.kind}`} title={h.text}>
                    <span className="ac-time">{clockTime(h.at)}</span>
                    <span className="ac-mark" aria-hidden="true">{historyMark(h.kind)}</span>
                    <span className="ac-hist-text">{h.tool && h.kind !== 'status' ? <b>{h.tool}</b> : null}{h.tool && h.kind !== 'status' ? ' ' : ''}{h.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!isMain && (
            <div className="ac-section">
              <div className="ac-h">{done ? tr('ui.agentCard.finished') : tr('ui.agentCard.lineage')}</div>
              {done && (finished.length ? <div className="ac-text">{finished.join(' · ')}</div> : <div className="ac-empty">{tr('ui.agentCard.noTotals')}</div>)}
              {!done && finished.length > 0 && <div className="ac-text">{tr('ui.agentCard.soFar', { stats: finished.join(' · ') })}</div>}
              {derived && finished.length > 0 && <div className="ac-sub" title={derived}>{derived}</div>}
              <div className="ac-kv">
                <span className="ac-kv-item">{insp.stats.parent ? tr('ui.agentCard.parent', { name: insp.stats.parent.name }) : tr('ui.agentCard.spawnedBySession')}</span>
                {insp.background && <span className="ac-kv-item">{tr('ui.agentCard.background')}</span>}
                <span className={`ac-kv-item${insp.stats.unread ? ' unread' : ''}`}>✉ {tr('ui.agentCard.unread', { count: insp.stats.unread })}</span>
              </div>
            </div>
          )}

          <div className="ac-section">
            <div className="ac-h">{tr('ui.agentCard.transcript')}</div>
            {emptyTranscript ? (
              <div className="ac-empty">{emptyTranscript}</div>
            ) : (
              <ul className="ac-transcript">
                {insp.transcript!.map((e, i) => (
                  <li key={`${e.at ?? 0}-${i}`} className={`kind-${e.kind}`}>
                    <span className="ac-time">{clockTime(e.at)}</span>
                    <span className="ac-mark" aria-hidden="true">{e.kind === 'tool' ? '›' : '“'}</span>
                    <span className="ac-tr-text">{transcriptLine(e)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <div className="ac-foot">
        {source === 'server'
          ? (missing === 'unknown' ? tr('ui.agentCard.foot.serverForgot') : missing === 'unreachable' ? tr('ui.agentCard.foot.serverUnreachable') : tr('ui.agentCard.foot.live', { seconds: INSPECT_POLL_MS / 1000 }))
          : missing === 'unreachable' ? tr('ui.agentCard.foot.officeUnreachable')
          : missing === 'unknown' ? tr('ui.agentCard.foot.notServerAgent')
          : tr('ui.agentCard.foot.loading')}
      </div>
    </div>
  )
}

export default AgentCard
