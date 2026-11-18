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
import { t, useT } from '../i18n'

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
    t('ui.meters.tip.payrollHead', { amount: `$${live.toFixed(4)}`, count: paid.length, rate: `$${dollarsPerMin.toFixed(4)}` }),
    t('ui.meters.tip.payrollToday', { amount: `$${costToday.toFixed(4)}`, added: lines, removed }),
    ...sessions.slice(0, MAX_ROWS).map(s => isEstimated(s)
      ? t('ui.meters.tip.needsLine', { session: sessionLabel(s), command: STATUS_LINE_INSTALL })
      : t('ui.meters.tip.payrollRow', { session: sessionLabel(s), amount: `$${s.cost.toFixed(4)}`, model: modelLabel(s), duration: formatDuration(s.durationMs) })),
  ]
}

function electricityTip(sessions: SessionStatus[], tokensPerMin: number): string[] {
  return [
    t('ui.meters.tip.electricityHead', { tokens: formatTokensExact(tokensPerMin) }),
    ...sessions.slice(0, MAX_ROWS).map(s => isEstimated(s)
      ? t('ui.meters.tip.needsLine', { session: sessionLabel(s), command: STATUS_LINE_INSTALL })
      : t('ui.meters.tip.electricityRow', { session: sessionLabel(s), rate: formatTokensExact(s.burn.tokensPerMin), input: formatTokensExact(s.context.input), output: formatTokensExact(s.context.output) }) +
      (s.agents?.length ? t('ui.meters.tip.subagents', { count: s.agents.length, tokens: formatTokensExact(s.agents.reduce((n, a) => n + a.tokens, 0)) }) : ''),
    ),
  ]
}

function memoryTip(s: SessionStatus): string[] {
  if (isEstimated(s)) return estimateTip(s)
  const size = s.context.size
  return [
    t('ui.meters.tip.memoryHead', { session: sessionLabel(s), percent: pct(s.context.used) }) +
      (size ? t('ui.meters.tip.memorySize', { used: formatTokensExact(s.context.input), size: formatTokensExact(size) }) : ''),
    t('ui.meters.tip.model', { model: modelLabel(s) }) + (s.modelId && s.modelId !== s.model ? ` (${s.modelId})` : '') +
      (s.effort ? t('ui.meters.tip.effort', { effort: s.effort }) : '') + (s.exceeds200k ? t('ui.meters.tip.over200k') : '') +
      (s.version ? t('ui.meters.tip.claudeCode', { version: s.version }) : ''),
    t('ui.meters.tip.costLine', { amount: `$${s.cost.toFixed(4)}`, duration: formatDuration(s.durationMs), id: s.sessionId.slice(0, 8) }),
  ]
}

function rateTip(s: SessionStatus): string[] {
  const rl = s.rateLimits ?? {}
  const lines: string[] = [t('ui.meters.tip.rateHead')]
  const resets = (at?: number | null) => (at ? t('ui.meters.tip.resets', { time: formatClockTime(at) }) : '')
  if (rl.fiveHour != null) lines.push(t('ui.meters.tip.rate5h', { percent: rl.fiveHour }) + resets(rl.fiveHourResetsAt))
  if (rl.sevenDay != null) lines.push(t('ui.meters.tip.rate7d', { percent: rl.sevenDay }) + resets(rl.sevenDayResetsAt))
  if (rl.spendLimit != null) lines.push(t('ui.meters.tip.spendLimit', { percent: rl.spendLimit }))
  return lines
}

const Meters: React.FC<MetersProps> = ({ onNotice }) => {
  const { sessions, totals } = useMeters()
  const [tip, setTip] = useState<string[] | null>(null)
  const tr = useT()
  const warnedRef = useRef(new Set<string>())
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  // "Claude's desk is getting cluttered" — once per session, past the threshold
  useEffect(() => {
    for (const s of sessions) {
      const used = s.context.used
      if (used == null || used <= CLUTTER_THRESHOLD || warnedRef.current.has(s.sessionId)) continue
      warnedRef.current.add(s.sessionId)
      const vars = { session: sessionLabel(s), percent: Math.round(used) }
      onNoticeRef.current?.(isEstimated(s) ? t('ui.meters.clutterEstimated', vars) : t('ui.meters.clutter', vars))
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
    <div className="meters-panel" role="group" aria-label={tr('ui.meters.ariaLabel')} data-sessions={sessions.length}>
      <div className="meters-head">
        <span className="meters-title">{tr('ui.meters.title')}</span>
        {fiveHour != null && limited && (
          <span className={`meter-pill tone-${rateTone(fiveHour)}`} data-testid="rate-limit" {...hover(rateTip(limited))}>
            {tr('ui.meters.rateShort', { percent: Math.round(fiveHour) })}
          </span>
        )}
      </div>

      <div className="meters-row">
        {needsStatusLine ? (
          <div className="meter meter-payroll meter-needs" data-testid="meter-payroll" {...hover(needsStatusLineTip('PAYROLL', estimated))}>
            <div className="meter-label">{tr('ui.meters.payroll')}</div>
            <div className="meter-needs-text">{tr('ui.meters.needsStatusLine')}</div>
          </div>
        ) : (
          <div className="meter meter-payroll" data-testid="meter-payroll" {...hover(payrollTip(sessions, costToday, dollarsPerMin))}>
            <div className="meter-label">{tr('ui.meters.payroll')}</div>
            <div className="meter-value">{formatMoney(costLive)}</div>
            <div className="meter-sub">{tr('ui.meters.perMin', { amount: formatMoney(dollarsPerMin) })}</div>
          </div>
        )}

        {needsStatusLine ? (
          <div className="meter meter-electricity meter-needs" data-testid="meter-electricity" {...hover(needsStatusLineTip('ELECTRICITY', estimated))}>
            <div className="meter-label">{tr('ui.meters.electricity')}</div>
            <div className="meter-needs-text">{tr('ui.meters.needsStatusLine')}</div>
          </div>
        ) : (
          <div className="meter meter-electricity" data-testid="meter-electricity" {...hover(electricityTip(sessions, tokensPerMin))}>
            <div className="meter-label">{tr('ui.meters.electricity')}</div>
            <div className="meter-value">{formatTokens(tokensPerMin)}<span className="meter-unit">{tr('ui.meters.tokPerMin')}</span></div>
            <div
              className={`meter-gauge${tokensPerMin > 0 ? ' live' : ''}`}
              style={{ ['--meter-flow' as string]: `${electricityPeriod(tokensPerMin)}s` } as React.CSSProperties}
            >
              <div className="meter-gauge-fill" style={{ width: `${Math.max(level, tokensPerMin > 0 ? 6 : 0)}%` }} />
            </div>
          </div>
        )}

        <div className={`meter meter-memory tone-${memoryTone}`} data-testid="meter-memory" data-source={fullest.source} {...hover(memoryTip(fullest))}>
          <div className="meter-label">{tr('ui.meters.memory')}</div>
          <div className="meter-value">
            {isEstimated(fullest) ? formatMemory(fullest) : pct(memoryUsed)}
            {marker && <span className="meter-est" data-testid="meter-est">{marker}</span>}
          </div>
          <div className="meter-bar"><div className="meter-bar-fill" style={{ width: `${Math.min(100, memoryUsed ?? 0)}%` }} /></div>
          <div className="meter-sub">{multi ? tr('ui.meters.sessions', { count: sessions.length }) : sessionLabel(fullest)}</div>
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
