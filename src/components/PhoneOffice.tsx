/**
 * PhoneOffice - the full office laid out for a phone: the room on top, permission cards under it, chat / meters / today / settings behind tabs.
 *
 * Only the full-mode LAN listener's page uses it (`npm run lan -- --full`,
 * https on the private Wi-Fi address: src/phoneSecret.ts says which page that
 * is and src/pageAuth.ts what it may send). The desktop window (App.tsx's
 * .app-wrapper, 1056 x 682) and the watch-only stage (ViewerStage) are other
 * layouts and are not touched from here: every rule in phone.css is scoped
 * under .phone-wrapper.
 *
 * Top to bottom, portrait (the 390 x 844 case):
 *
 *   header   connection state, title, one pill per session
 *   room     laid out at ViewerStage's fixed 756 x 564 and scaled as a whole
 *            to the screen's width (never more than half the height). It
 *            takes taps: a character opens the inspector.
 *   cards    pending permission dialogs, in the flow right under the room so
 *            they are on screen without scrolling or zooming, with buttons a
 *            thumb can hit; many cards scroll inside their own box
 *   pane     the tab's content: Chat, Meters, Today or Settings
 *   tabs     at the bottom, in thumb reach
 *
 * Landscape puts the room on the left and everything else on the right.
 *
 * Chat and Meters stay mounted while another tab shows: the chat keeps its
 * draft, and Meters also posts the "desk is getting cluttered" notice. Today
 * and Settings fetch from the server when they open, so they mount only then.
 *
 * Sizes are measured, not read from window.innerHeight (iOS Safari's bars
 * make it unreliable): a ResizeObserver on the box the room and the panel
 * share. The wrapper itself follows window.visualViewport, because neither
 * iOS nor Android shrinks the layout viewport when the keyboard opens: with
 * it up, the wrapper is as tall as what is left, and the room is put away so
 * the chat keeps more than one line (COMPACT_BELOW). That same keyboard makes
 * a portrait box wider than it is tall (390 x 380), so which way the phone is
 * held is decided from the tallest box seen at the current width
 * (nextPhoneBox), never from the box of the moment.
 *
 * Two states draw no office:
 *   no phone secret   the link was opened without its #phone= part. Nothing
 *                     that calls the server is mounted (each call would be a
 *                     401); a notice says where the link is.
 *   not connected     the office is stopped, or the secret was replaced by
 *                     `--rotate`. The page cannot tell which: the WebSocket
 *                     API hides the refusal's status, and asking again to
 *                     find out would count as wrong secrets toward the
 *                     listener's lockout (server/lan.js createLockout). So
 *                     one line names both, and the inspector — which polls
 *                     every 2 s — stays closed until the socket is back.
 */

import React, { useEffect, useRef, useState } from 'react'
import { STAGE_H, STAGE_W } from './ViewerStage'
import TodayPanel from './TodayPanel'
import '../styles/phone.css'

/** The tabs under the room, in display order. */
export const PHONE_TABS = ['chat', 'meters', 'today', 'settings'] as const
export type PhoneTab = typeof PHONE_TABS[number]

const TAB_LABEL: Record<PhoneTab, string> = { chat: 'Chat', meters: 'Meters', today: 'Today', settings: 'Settings' }

// Why half: at 390 px wide the room is 291 px tall. iOS Safari with both bars
// showing leaves about 620 px under the header, so half of it still lets the
// room span the full width, and the other half is cards, pane and tabs.
const PORTRAIT_ROOM_SHARE = 0.5
// Why 55 %: landscape is short, so the room fits by height; this only stops
// it from squeezing the panel on a very wide, very short screen
const LANDSCAPE_ROOM_SHARE = 0.55
// Why 420 px: under the header a phone has 550 px or more with the keyboard
// down and 250 to 400 px with it up. Below this the room is hidden.
const COMPACT_BELOW = 420

/** The space under the header: its size now, and the tallest it has been at this width. */
export interface PhoneBox { w: number; h: number; tallest: number }

/**
 * The measured box after a new measurement.
 * Why `tallest`: the keyboard shortens the box without the phone having
 * turned. Only a rotation (or a resized window) changes the width, so the
 * tallest height seen at one width is the screen's real shape.
 * @param prev the box before (null on the first measurement)
 * @param w measured width in CSS px
 * @param h measured height in CSS px
 * @returns `prev` itself when nothing changed (so React skips the render), else a new box
 */
export function nextPhoneBox(prev: PhoneBox | null, w: number, h: number): PhoneBox {
  // Why 1 px of slack: a scrollbar appearing or a fractional zoom must not count as a rotation
  const sameWidth = prev !== null && Math.abs(prev.w - w) <= 1
  const tallest = sameWidth ? Math.max(prev.tallest, h) : h
  if (prev && prev.w === w && prev.h === h && prev.tallest === tallest) return prev
  return { w, h, tallest }
}

/**
 * Whether the room goes beside the panel instead of above it.
 * @param box the measured box
 * @returns true when the screen is wider than it is tall, keyboard or not
 */
export function phoneIsLandscape(box: PhoneBox): boolean {
  return box.w > box.tallest
}

/**
 * The scale of the 756 x 564 room inside a `w` x `h` box (the space under the header).
 * Portrait: the full width, unless that would take more than half the height.
 * Landscape: the full height, unless that would take more than 55 % of the width.
 * @param w available width in CSS px
 * @param h available height in CSS px
 * @param landscape the room sits beside the panel (default: the box is wider than tall)
 * @returns the transform scale (never 0)
 */
export function phoneStageScale(w: number, h: number, landscape: boolean = w > h): number {
  const s = landscape
    ? Math.min((w * LANDSCAPE_ROOM_SHARE) / STAGE_W, h / STAGE_H)
    : Math.min(w / STAGE_W, (h * PORTRAIT_ROOM_SHARE) / STAGE_H)
  // Why: a 0 or NaN box (a hidden tab, before layout, a test) would collapse the room for good
  return Number.isFinite(s) && s > 0 ? s : 1
}

/**
 * Whether the room is put away: a portrait box too short for it and the chat
 * together, which on a phone means the keyboard is up.
 * @param landscape phoneIsLandscape (landscape is short by nature and never compact)
 * @param h available height in CSS px
 * @returns true when only the panel should show
 */
export function phoneIsCompact(landscape: boolean, h: number): boolean {
  return !landscape && h > 0 && h < COMPACT_BELOW
}

/** What the wrapper's inline style follows: the part of the page the keyboard leaves visible. */
interface VisibleBox { top: number; height: number }

/**
 * The visual viewport as a box for the wrapper, or null to leave the CSS
 * height (100dvh) alone.
 * @param vv window.visualViewport (tests pass a fake; null where unsupported)
 * @returns the box, or null while the page is pinch-zoomed
 */
export function visibleBox(vv: { height: number; offsetTop: number; scale: number } | null | undefined): VisibleBox | null {
  if (!vv || !(vv.height > 0)) return null
  // Why: zoomed in, the visual viewport is the magnified part of the page,
  // not the page minus the keyboard. Following it would shrink the layout
  // under the reader's fingers.
  if (Math.abs(vv.scale - 1) > 0.01) return null
  return { top: Math.max(0, vv.offsetTop), height: vv.height }
}

interface PhoneOfficeProps {
  /** The office WebSocket is open (useAgentSocket's `connected`) */
  connected: boolean
  /** The page holds a phone secret (src/pageAuth.ts pagePhoneSecret) */
  hasSecret: boolean
  /** The header's title */
  title: string
  /** The room (App.tsx's `scene`) */
  scene: React.ReactNode
  /** The session pills (SessionStrip) */
  sessions: React.ReactNode
  /** The permission cards (PermissionCards); renders nothing while none is pending */
  permissions: React.ReactNode
  /** How many dialogs are waiting: the count on the header */
  pending: number
  /** The chat (SlackChat) */
  chat: React.ReactNode
  /** The meters (Meters); renders nothing until a session reports */
  meters: React.ReactNode
  /** The settings panel (SettingsPanel); mounted only while its tab shows */
  settings: React.ReactNode
  /** The inspector card (AgentCard); renders nothing while no character is picked */
  inspector: React.ReactNode
}

// Why a constant: TodayPanel re-subscribes its listeners when onClose changes; a tab has nothing to close
const noop = () => {}
// Why an anchor that is never attached: the popovers use it to spare the
// button that opened them from "a click elsewhere closes it" and to hand
// focus back on close. A tab neither closes nor should pull focus back to
// its button when another tab is tapped.
const NO_ANCHOR: React.RefObject<HTMLElement> = { current: null }

export default function PhoneOffice({
  connected, hasSecret, title, scene, sessions, permissions, pending, chat, meters, settings, inspector,
}: PhoneOfficeProps) {
  const mainRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<PhoneTab>('chat')
  const [box, setBox] = useState<PhoneBox>(() => nextPhoneBox(null, window.innerWidth, window.innerHeight))
  const [visible, setVisible] = useState<VisibleBox | null>(() => visibleBox(window.visualViewport))

  // The wrapper follows the visual viewport (the keyboard), the room the box under the header
  useEffect(() => {
    const measure = () => {
      const el = mainRef.current
      if (el) setBox(prev => nextPhoneBox(prev, el.clientWidth, el.clientHeight))
    }
    const follow = () => {
      // Why keep the last box while zoomed (visibleBox is null then): see visibleBox
      const next = visibleBox(window.visualViewport)
      if (next) setVisible(prev => (prev && prev.top === next.top && prev.height === next.height ? prev : next))
      measure()
    }
    follow()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    if (mainRef.current) observer?.observe(mainRef.current)
    window.addEventListener('resize', follow)
    window.addEventListener('orientationchange', follow)
    window.visualViewport?.addEventListener('resize', follow)
    // Why scroll too: iOS pans the visual viewport to the focused input instead of resizing the page
    window.visualViewport?.addEventListener('scroll', follow)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', follow)
      window.removeEventListener('orientationchange', follow)
      window.visualViewport?.removeEventListener('resize', follow)
      window.visualViewport?.removeEventListener('scroll', follow)
    }
  }, [])

  // Why: the chat scrolls to its newest line as messages arrive, but a hidden
  // pane has no height to scroll, so it is put there when the tab comes back
  useEffect(() => {
    if (tab !== 'chat') return
    const body = paneRef.current?.querySelector<HTMLElement>('.slack-body')
    if (body) body.scrollTop = body.scrollHeight
  }, [tab])

  const landscape = phoneIsLandscape(box)
  const compact = phoneIsCompact(landscape, box.h)
  const scale = phoneStageScale(box.w, box.h, landscape)
  const wrapperStyle = visible ? { top: visible.top, height: visible.height } : undefined

  const connection = !hasSecret ? 'no key' : connected ? 'online' : 'connecting…'
  const header = (
    <header className="phone-header">
      <span className={`phone-conn${hasSecret && connected ? ' online' : ''}`} role="status" data-testid="phone-connection">
        <span className="phone-conn-dot" aria-hidden="true" />
        {connection}
      </span>
      <span className="phone-title">{title}</span>
      {pending > 0 && <span className="phone-pending" data-testid="phone-pending">{pending} waiting</span>}
      <div className="phone-sessions">{sessions}</div>
    </header>
  )

  const room = (
    <div className="phone-room">
      <div className="phone-stage" style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
        <div className="phone-scaler" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}>
          {scene}
        </div>
      </div>
    </div>
  )

  if (!hasSecret) {
    return (
      <div className={`phone-wrapper${landscape ? ' landscape' : ''}`} style={wrapperStyle} data-testid="phone-office">
        {header}
        <div className="phone-main" ref={mainRef}>
          {room}
          <div className="phone-panel">
            <div className="phone-notice" role="alert" data-testid="phone-no-secret">
              <strong>This link is missing its key.</strong>
              <p>
                Open the link that <code>npm run lan -- --full</code> printed on the computer, or scan its QR code.
                It ends in <code>#phone=</code> and 64 characters; this browser remembers it after the first visit.
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`phone-wrapper${landscape ? ' landscape' : ''}${compact ? ' compact' : ''}`} style={wrapperStyle} data-testid="phone-office">
      {header}
      <div className="phone-main" ref={mainRef}>
        {room}
        <div className="phone-panel">
          {!connected && (
            <div className="phone-offline" role="status" data-testid="phone-offline">
              Not connected. The office may be stopped, or this link was replaced:{' '}
              <code>npm run lan -- --full</code> prints the current one.
            </div>
          )}
          <div className="phone-cards" data-testid="phone-cards">{permissions}</div>
          <div className="phone-lower">
            <div className="phone-pane" ref={paneRef}>
              <div className="phone-tabpanel phone-tab-chat" role="tabpanel" id="phone-panel-chat" aria-labelledby="phone-tab-chat" hidden={tab !== 'chat'}>
                {chat}
              </div>
              <div className="phone-tabpanel phone-tab-meters" role="tabpanel" id="phone-panel-meters" aria-labelledby="phone-tab-meters" hidden={tab !== 'meters'}>
                {/* Why two elements: Meters renders nothing until a session reports, and :empty on its slot shows the line after it */}
                <div className="phone-meters-slot">{meters}</div>
                <p className="phone-empty">No session has reported yet. Payroll, electricity and memory appear here once Claude Code is working.</p>
              </div>
              {tab === 'today' && (
                <div className="phone-tabpanel phone-tab-today" role="tabpanel" id="phone-panel-today" aria-labelledby="phone-tab-today">
                  <TodayPanel onClose={noop} anchor={NO_ANCHOR} />
                </div>
              )}
              {tab === 'settings' && (
                <div className="phone-tabpanel phone-tab-settings" role="tabpanel" id="phone-panel-settings" aria-labelledby="phone-tab-settings">
                  {settings}
                </div>
              )}
            </div>
            <nav className="phone-tabs" role="tablist" aria-label="Office panels">
              {PHONE_TABS.map(name => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  id={`phone-tab-${name}`}
                  aria-selected={tab === name}
                  aria-controls={`phone-panel-${name}`}
                  className={`phone-tab${tab === name ? ' on' : ''}`}
                  onClick={() => setTab(name)}
                  data-testid={`phone-tab-${name}`}
                >
                  {TAB_LABEL[name]}
                </button>
              ))}
            </nav>
            {/* Why only while connected: its 2 s poll with a replaced secret would lock this phone out (see the header) */}
            {connected && inspector}
          </div>
        </div>
      </div>
    </div>
  )
}
