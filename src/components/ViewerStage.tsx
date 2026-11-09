/**
 * ViewerStage - phone mode's layout: the office scene alone, scaled to fill the screen.
 *
 * A viewer page (src/viewerKey.ts) drops the title bar, the chat, the meters,
 * the permission cards and the status strip — everything that needs trust or
 * would call an API route — and keeps the room. The room is laid out at a
 * fixed size (the one it has in the desktop window, so the characters' pixel
 * sizes keep the proportions their spots were placed at) and scaled as a
 * whole with a transform to the largest size the viewport fits, letterboxed.
 * Landscape is the expected orientation on a monitor mount; in portrait the
 * room fits the width and a hint suggests turning the phone. The stage takes
 * no pointer input: a watch-only screen has nothing to click.
 */

import React, { useEffect, useState } from 'react'
import '../styles/viewer.css'

/** The room's width in the desktop window: 1056 px window − 300 px chat column. */
export const STAGE_W = 756
/** The room art's aspect ratio, 4800 × 3584 (App.tsx's room-container). */
export const STAGE_H = Math.round((STAGE_W * 3584) / 4800)

/**
 * The scale that fits the stage inside a `vw` × `vh` viewport (never 0).
 * @param vw viewport width in CSS px
 * @param vh viewport height in CSS px
 * @returns the transform scale
 */
export function stageScale(vw: number, vh: number): number {
  const s = Math.min(vw / STAGE_W, vh / STAGE_H)
  // Why: a 0 or NaN viewport (a hidden tab, a test) would collapse the room for good
  return Number.isFinite(s) && s > 0 ? s : 1
}

function viewportScale(): number {
  const vv = window.visualViewport
  const w = vv?.width ?? document.documentElement.clientWidth ?? window.innerWidth
  const h = vv?.height ?? window.innerHeight
  return stageScale(w, h)
}

interface ViewerStageProps {
  /** The office WebSocket is open (useAgentSocket's `connected`) */
  connected: boolean
  children: React.ReactNode
}

export default function ViewerStage({ connected, children }: ViewerStageProps) {
  const [scale, setScale] = useState(viewportScale)

  useEffect(() => {
    const update = () => setScale(viewportScale())
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  return (
    <div className="viewer-wrapper">
      <div className="viewer-stage" style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
        <div className="viewer-scaler" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
      {!connected && <div className="viewer-status" role="status">connecting to the office…</div>}
      <div className="viewer-rotate-hint" aria-hidden="true">turn the phone sideways for a bigger office</div>
    </div>
  )
}
