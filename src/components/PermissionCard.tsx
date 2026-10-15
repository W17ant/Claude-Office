/**
 * PermissionCard — one card per Claude Code permission dialog waiting on the
 * office (see src/permissions.ts for the state and server/permissions.js for
 * the contract). A fixed stack beside the chat column, independent of where
 * any character stands.
 *
 * Allow / Allow & remember (only when the dialog offered suggestions) / Deny
 * POST the decision with the UI token; the buttons disable at once and the
 * card goes when the server's permission_resolved arrives, after a short
 * fade that says what happened. The thin bar is the time left before the
 * server gives the dialog back to the terminal. With exactly one card up,
 * `y` allows and `n` denies (not while typing in the chat). A bell rings once
 * per new card, never for an extension.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import '../styles/permission.css'
import {
  answerPermission, describeSuggestions, fadeLabel, permissionTitle, FADE_MS,
  type PermissionAction, type PermissionCardState, type PermissionDecision,
} from '../permissions'
import { playBell } from '../sounds'

interface PermissionCardsProps {
  cards: PermissionCardState[]
  dispatch: (action: PermissionAction) => void
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.tagName) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

const PermissionCards: React.FC<PermissionCardsProps> = ({ cards, dispatch }) => {
  // One bell per card id, however many times the list re-renders or a deadline moves
  const rungRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const card of cards) {
      if (card.resolved || rungRef.current.has(card.id)) continue
      rungRef.current.add(card.id)
      playBell()
    }
  }, [cards])

  // The time-left bar ticks while anything is up
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (cards.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [cards.length])

  // A resolved card fades for FADE_MS, then leaves the list
  useEffect(() => {
    const timers = cards
      .filter(c => c.resolved)
      .map(c => setTimeout(() => dispatch({ type: 'permission_dismiss', permissionId: c.id }), Math.max(0, c.resolved!.at + FADE_MS - Date.now())))
    return () => timers.forEach(clearTimeout)
  }, [cards, dispatch])

  const decide = useCallback(async (card: PermissionCardState, decision: PermissionDecision) => {
    dispatch({ type: 'permission_sent', permissionId: card.id, decision })
    const ok = await answerPermission(card.id, decision)
    // A 409 means the server already resolved it (its permission_resolved is on
    // the way or here); anything else re-enables the buttons
    if (!ok) dispatch({ type: 'permission_unsent', permissionId: card.id })
  }, [dispatch])

  // y / n answer the only open card; ambiguous with two, so nothing then
  useEffect(() => {
    const open = cards.filter(c => !c.resolved && !c.sent)
    if (open.length !== 1) return
    const card = open[0]
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return
      if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); void decide(card, 'allow') }
      else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); void decide(card, 'deny') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cards, decide])

  if (cards.length === 0) return null

  return (
    <div className="perm-stack" role="region" aria-label="Permission requests">
      {cards.map(card => {
        const total = Math.max(1, card.deadline - card.createdAt)
        const left = Math.max(0, Math.min(1, (card.deadline - now) / total))
        const secondsLeft = Math.max(0, Math.ceil((card.deadline - now) / 1000))
        const where = [card.project ?? card.sessionId.slice(0, 8), card.sessionTitle].filter(Boolean).join(' · ')
        const busy = !!card.sent || !!card.resolved
        return (
          <div
            key={card.id}
            className={`perm-card${card.resolved ? ' resolved' : ''}${card.sent ? ' sent' : ''}`}
            data-testid="permission-card"
          >
            <div className="perm-head">
              <span className="perm-title">{permissionTitle(card)}</span>
              <span className="perm-where" title={card.cwd}>{where}</span>
            </div>
            <pre className="perm-detail">{card.detail || card.summary || card.toolName}</pre>
            <div className="perm-timebar" title={card.resolved ? '' : `${secondsLeft}s before the terminal takes over`}>
              <div className={`perm-timebar-fill${left < 0.25 ? ' low' : ''}`} style={{ width: `${left * 100}%` }} />
            </div>
            {card.resolved ? (
              <div className="perm-outcome">{fadeLabel(card.resolved)}</div>
            ) : (
              <div className="perm-actions">
                <button className="perm-btn allow" disabled={busy} onClick={() => decide(card, 'allow')} title="Allow this call (y)">
                  Allow
                </button>
                {card.suggestions.length > 0 && (
                  <button className="perm-btn remember" disabled={busy} onClick={() => decide(card, 'allow-remember')} title={describeSuggestions(card.suggestions)}>
                    Allow &amp; remember
                  </button>
                )}
                <button className="perm-btn deny" disabled={busy} onClick={() => decide(card, 'deny')} title="Deny this call (n)">
                  Deny
                </button>
                {card.sent && <span className="perm-sending">sending {card.sent === 'allow-remember' ? 'allow' : card.sent}…</span>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default React.memo(PermissionCards)
