/**
 * ViewerStage - phone mode's layout: the office scene alone, scaled to fill the screen.
 *
 * A viewer page (src/viewerKey.ts) drops the title bar, the chat, the meters,
 * the permission cards and the status strip — everything that needs trust or
 * would call an API route — and keeps the room. The room is laid out at a
 * fixed size (the one it has in the desktop window, so the characters' pixel
 * sizes keep the proportions their spots were placed at) and scaled as a
 * whole with a transform to the largest size that fits the screen inside its
 * safe-area insets ("contain"), centred. A phone on a monitor mount is most
 * often upright, so portrait is the main case: the room spans the width and
 * sits in the middle; landscape fits by height. The available box is
 * measured (ResizeObserver on the full-screen wrapper, whose padding is the
 * safe-area insets), not read from window.innerHeight, which iOS Safari's
 * toolbars make unreliable. The stage takes no pointer input.
 */

import React, { useEffect, useRef, useState } from 'react'
import '../styles/viewer.css'

/** The room's width in the desktop window: 1056 px window − 300 px chat column. */
export const STAGE_W = 756
/** The room art's aspect ratio, 4800 × 3584 (App.tsx's room-container). */
export const STAGE_H = Math.round((STAGE_W * 3584) / 4800)

/**
 * The scale that fits the stage inside a `w` × `h` box (never 0).
 * @param w available width in CSS px
 * @param h available height in CSS px
 * @returns the transform scale
 */
export function stageScale(w: number, h: number): number {
  const s = Math.min(w / STAGE_W, h / STAGE_H)
  // Why: a 0 or NaN box (a hidden tab, before layout, a test) would collapse the room for good
  return Number.isFinite(s) && s > 0 ? s : 1
}

/** The wrapper's content box (inside the safe-area padding). */
function contentScale(el: HTMLElement | null): number {
  if (!el) return stageScale(window.innerWidth, window.innerHeight)
  const cs = getComputedStyle(el)
  const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
  const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
  return stageScale(w, h)
}

interface ViewerStageProps {
  /** The office WebSocket is open (useAgentSocket's `connected`) */
  connected: boolean
  /** A line to show over the room instead of "connecting…" (no viewer key, say) */
  notice?: string
  children: React.ReactNode
}

export default function ViewerStage({ connected, notice, children }: ViewerStageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(() => stageScale(window.innerWidth, window.innerHeight))

  useEffect(() => {
    const update = () => setScale(contentScale(wrapperRef.current))
    update()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    if (wrapperRef.current) observer?.observe(wrapperRef.current)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  const status = notice ?? (connected ? null : 'connecting to the office…')
  return (
    <div className="viewer-wrapper" ref={wrapperRef}>
      <div className="viewer-stage" style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
        <div className="viewer-scaler" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
      {status && <div className="viewer-status" role="status">{status}</div>}
    </div>
  )
}
