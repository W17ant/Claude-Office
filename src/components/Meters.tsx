/**
 * Meters — the office wall panel: PAYROLL (what the sessions cost, with the
 * $/min burn), ELECTRICITY (tokens/min as an animated gauge), MEMORY (context
 * window fill — amber above 70 %, red above 90 %) and a RATE LIMIT pill
 * (5-hour window utilisation) when Claude Code reports one.
 *
 * Fed by the status-line feed (src/meters.ts). Renders nothing until the
 * first status arrives, so an office with neither a status line nor a
 * transcript to read looks exactly as before. Several sessions stack
 * per-session rows (max 4) under the meters; hovering anything shows the
 * exact numbers and the model in a strip under the panel. Past
 * CLUTTER_THRESHOLD a session posts "Claude's desk is getting cluttered" to
 * the chat once, through onNotice.
 *
 * A session without the status line (plugin install, `claude -p`) has MEMORY
 * estimated from its transcript: drawn with a small "est." marker and a
 * tooltip saying so. PAYROLL and ELECTRICITY have nothing to show for it; when
 * no session reports them the tiles say "needs the status line" (the install
 * command is in their tooltip), and an estimated row shows no cost.
 */

import React, { useEffect, useRef, useState } from 'react'
import {
  useMeters, contextTone, rateTone, formatMoney, formatTokens, formatTokensExact,
  formatDuration, formatClockTime, electricityLevel, electricityPeriod,
  sessionLabel, modelLabel, CLUTTER_THRESHOLD, type SessionStatus,
  isEstimated, estimateMarker, formatMemory, estimateTip, needsStatusLineTip, STATUS_LINE_INSTALL,
} from '../meters'

const MAX_ROWS = 4

interface MetersProps {
  /** Posts a system line to the office chat */
  onNotice?: (text: string) => void
}

function pct(n: number | null | undefined): string {
  return n == null ? '–' : `${Math.round(n)}%`
}

function payrollTip(sessions: SessionStatus[], costToday: number, dollarsPerMin: number): string[] {
  // An estimated session has no cost to add (it needs the status line)
  const paid = sessions.filter(s => !isEstimated(s))
  const live = paid.reduce((sum, s) => sum + s.cost, 0)
  const lines = paid.reduce((sum, s) => sum + s.linesAdded, 0)
  const removed = paid.reduce((sum, s) => sum + s.linesRemoved, 0)
  return [
    `PAYROLL — $${live.toFixed(4)} across ${paid.length} session${paid.length === 1 ? '' : 's'} · $${dollarsPerMin.toFixed(4)}/min over the last 5 min`,
    `today $${costToday.toFixed(4)} · +${lines} / -${removed} lines · estimated at list price`,
    ...sessions.slice(0, MAX_ROWS).map(s => isEstimated(s)
      ? `${sessionLabel(s)}: needs the status line (${STATUS_LINE_INSTALL})`
      : `${sessionLabel(s)}: $${s.cost.toFixed(4)} · ${modelLabel(s)} · ${formatDuration(s.durationMs)}`),
  ]
}

function electricityTip(sessions: SessionStatus[], tokensPerMin: number): string[] {
  return [
    `ELECTRICITY — ${formatTokensExact(tokensPerMin)} tokens/min processed over the last 5 min (context re-reads included)`,
    ...sessions.slice(0, MAX_ROWS).map(s => isEstimated(s)
      ? `${sessionLabel(s)}: needs the status line (${STATUS_LINE_INSTALL})`
      : `${sessionLabel(s)}: ${formatTokensExact(s.burn.tokensPerMin)} tok/min · last call ${formatTokensExact(s.context.input)} in / ${formatTokensExact(s.context.output)} out` +
      (s.agents?.length ? ` · ${s.agents.length} subagent${s.agents.length === 1 ? '' : 's'} ${formatTokensExact(s.agents.reduce((n, a) => n + a.tokens, 0))} tok` : ''),
    ),
  ]
}

function memoryTip(s: SessionStatus): string[] {
  if (isEstimated(s)) return estimateTip(s)
  const size = s.context.size
  return [
    `MEMORY — ${sessionLabel(s)}: ${pct(s.context.used)} of the context window` +
      (size ? ` (${formatTokensExact(s.context.input)} / ${formatTokensExact(size)} tokens)` : ''),
    `model ${modelLabel(s)}${s.modelId && s.modelId !== s.model ? ` (${s.modelId})` : ''}` +
      (s.effort ? ` · effort ${s.effort}` : '') + (s.exceeds200k ? ' · over 200k' : '') +
      (s.version ? ` · Claude Code ${s.version}` : ''),
    `$${s.cost.toFixed(4)} · ${formatDuration(s.durationMs)} · session ${s.sessionId.slice(0, 8)}`,
  ]
}

function rateTip(s: SessionStatus): string[] {
  const rl = s.rateLimits ?? {}
  const lines: string[] = ['RATE LIMITS (claude.ai subscription)']
  if (rl.fiveHour != null) lines.push(`5-hour window ${rl.fiveHour}% used${rl.fiveHourResetsAt ? ` · resets ${formatClockTime(rl.fiveHourResetsAt)}` : ''}`)
  if (rl.sevenDay != null) lines.push(`7-day window ${rl.sevenDay}% used${rl.sevenDayResetsAt ? ` · resets ${formatClockTime(rl.sevenDayResetsAt)}` : ''}`)
  if (rl.spendLimit != null) lines.push(`spend limit ${rl.spendLimit}% used`)
  return lines
}

const Meters: React.FC<MetersProps> = ({ onNotice }) => {
  const { sessions, totals } = useMeters()
  const [tip, setTip] = useState<string[] | null>(null)
  const warnedRef = useRef(new Set<string>())
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  // "Claude's desk is getting cluttered" — once per session, past the threshold
  useEffect(() => {
    for (const s of sessions) {
      const used = s.context.used
      if (used == null || used <= CLUTTER_THRESHOLD || warnedRef.current.has(s.sessionId)) continue
      warnedRef.current.add(s.sessionId)
      onNoticeRef.current?.(`🗂️ Claude's desk is getting cluttered — ${sessionLabel(s)} is at ${Math.round(used)}% context${isEstimated(s) ? ' (estimated)' : ''}`)
    }
  }, [sessions])

  if (sessions.length === 0) return null

  // Estimated sessions have MEMORY only: cost and burn come from status-line sessions
  const reported = sessions.filter(s => !isEstimated(s))
  const estimated = sessions.filter(isEstimated)
  const needsStatusLine = reported.length === 0
  const costLive = reported.reduce((sum, s) => sum + s.cost, 0)
  const costToday = totals?.costToday ?? costLive
  const dollarsPerMin = totals?.dollarsPerMin ?? sessions.reduce((sum, s) => sum + s.burn.dollarsPerMin, 0)
  const tokensPerMin = totals?.tokensPerMin ?? sessions.reduce((sum, s) => sum + s.burn.tokensPerMin, 0)

  // MEMORY shows the fullest session; RATE LIMIT the freshest report of one
  const fullest = sessions.reduce((best, s) => ((s.context.used ?? -1) > (best.context.used ?? -1) ? s : best), sessions[0])
  const memoryUsed = fullest.context.used
  const memoryTone = contextTone(memoryUsed)
  const marker = estimateMarker(fullest)
  const limited = sessions.find(s => s.rateLimits?.fiveHour != null)
  const fiveHour = limited?.rateLimits?.fiveHour ?? null
  const level = electricityLevel(tokensPerMin)
  const multi = sessions.length > 1

  const hover = (lines: string[]) => ({ onMouseEnter: () => setTip(lines), onMouseLeave: () => setTip(null) })

  return (
    <div className="meters-panel" role="group" aria-label="Payroll, electricity and memory" data-sessions={sessions.length}>
      <div className="meters-head">
        <span className="meters-title">⚡ OFFICE METERS</span>
        {fiveHour != null && limited && (
          <span className={`meter-pill tone-${rateTone(fiveHour)}`} data-testid="rate-limit" {...hover(rateTip(limited))}>
            5h {Math.round(fiveHour)}%
          </span>
        )}
      </div>

      <div className="meters-row">
        {needsStatusLine ? (
          <div className="meter meter-payroll meter-needs" data-testid="meter-payroll" {...hover(needsStatusLineTip('PAYROLL', estimated))}>
            <div className="meter-label">Payroll</div>
            <div className="meter-needs-text">needs the status line</div>
          </div>
        ) : (
          <div className="meter meter-payroll" data-testid="meter-payroll" {...hover(payrollTip(sessions, costToday, dollarsPerMin))}>
            <div className="meter-label">Payroll</div>
            <div className="meter-value">{formatMoney(costLive)}</div>
            <div className="meter-sub">{formatMoney(dollarsPerMin)}/min</div>
          </div>
        )}

        {needsStatusLine ? (
          <div className="meter meter-electricity meter-needs" data-testid="meter-electricity" {...hover(needsStatusLineTip('ELECTRICITY', estimated))}>
            <div className="meter-label">Electricity</div>
            <div className="meter-needs-text">needs the status line</div>
          </div>
        ) : (
          <div className="meter meter-electricity" data-testid="meter-electricity" {...hover(electricityTip(sessions, tokensPerMin))}>
            <div className="meter-label">Electricity</div>
            <div className="meter-value">{formatTokens(tokensPerMin)}<span className="meter-unit">tok/min</span></div>
            <div
              className={`meter-gauge${tokensPerMin > 0 ? ' live' : ''}`}
              style={{ ['--meter-flow' as string]: `${electricityPeriod(tokensPerMin)}s` } as React.CSSProperties}
            >
              <div className="meter-gauge-fill" style={{ width: `${Math.max(level, tokensPerMin > 0 ? 6 : 0)}%` }} />
            </div>
          </div>
        )}

        <div className={`meter meter-memory tone-${memoryTone}`} data-testid="meter-memory" data-source={fullest.source} {...hover(memoryTip(fullest))}>
          <div className="meter-label">Memory</div>
          <div className="meter-value">
            {isEstimated(fullest) ? formatMemory(fullest) : pct(memoryUsed)}
            {marker && <span className="meter-est" data-testid="meter-est">{marker}</span>}
          </div>
          <div className="meter-bar"><div className="meter-bar-fill" style={{ width: `${Math.min(100, memoryUsed ?? 0)}%` }} /></div>
          <div className="meter-sub">{multi ? `${sessions.length} sessions` : sessionLabel(fullest)}</div>
        </div>
      </div>

      {multi && (
        <div className="meters-sessions">
          {sessions.slice(0, MAX_ROWS).map(s => {
            const tone = contextTone(s.context.used)
            const est = estimateMarker(s)
            return (
              <div key={s.sessionId} className={`meters-session tone-${tone}`} data-session-id={s.sessionId} data-source={s.source} {...hover(memoryTip(s))}>
                <span className="ms-project">{sessionLabel(s)}</span>
                <span className="ms-model">{modelLabel(s)}</span>
                <span className="ms-bar"><span className="ms-bar-fill" style={{ width: `${Math.min(100, s.context.used ?? 0)}%` }} /></span>
                <span className="ms-pct">{est ? formatMemory(s) : pct(s.context.used)}{est && <span className="ms-est">{est}</span>}</span>
                {est
                  ? <span className="ms-cost ms-cost-none">–</span>
                  : <span className="ms-cost">{formatMoney(s.cost)}</span>}
              </div>
            )
          })}
        </div>
      )}

      {tip && (
        <div className="meters-tip" data-testid="meters-tip">
          {tip.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      )}
    </div>
  )
}

export default Meters
