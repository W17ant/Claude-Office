/**
 * serverSettings.ts - the office server's settings as the page shows them,
 * shared by the chat header's pills (SlackChat) and the Settings panel so
 * a change in one shows in the other.
 *
 *   logPrompts         GET /settings · POST /settings (UI token)
 *   answerPermissions  GET /settings · POST /settings (UI token)
 *   aiPaused           GET /chat/cron-state · POST /chat/cron-state (open
 *                      route: the chat monitor's pause file, "AI On / Off")
 *
 * The UI token comes from the WebSocket snapshot of a page that holds the
 * office token (src/permissions.ts), so a read-only page cannot change the
 * first two — the server would refuse — and the panel disables them. Every
 * change is optimistic and put back if the server says no.
 */

import { useSyncExternalStore } from 'react'
import { postSetting } from './permissions'
import { officeHttpBase } from './serverUrl'

export type LogPromptsLevel = 'off' | 'summary' | 'full'
export const LOG_PROMPTS_LEVELS: readonly LogPromptsLevel[] = ['off', 'summary', 'full']

export interface ServerSettings {
  /** null until GET /settings answered (or when the server has no such route) */
  logPrompts: string | null
  answerPermissions: boolean | null
  /** null until GET /chat/cron-state answered */
  aiPaused: boolean | null
}

let state: ServerSettings = { logPrompts: null, answerPermissions: null, aiPaused: null }
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(patch: Partial<ServerSettings>) {
  state = { ...state, ...patch }
  listeners.forEach(l => l())
}

/**
 * Fetch the settings once per page (later calls share the first fetch).
 * Silent when the server is down or older than a route: the value stays null
 * and its control stays hidden or disabled.
 */
export function loadServerSettings(): Promise<void> {
  if (loading) return loading
  const base = officeHttpBase()
  // Why 2 s: the header must not hang on a server that is starting up
  const settings = fetch(`${base}/settings`, { signal: AbortSignal.timeout(2000) })
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (d && typeof d.logPrompts === 'string') set({ logPrompts: d.logPrompts })
      if (d && typeof d.answerPermissions === 'boolean') set({ answerPermissions: d.answerPermissions })
    })
    .catch(() => {})
  const cron = fetch(`${base}/chat/cron-state`, { signal: AbortSignal.timeout(2000) })
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d) set({ aiPaused: !!d.paused }) })
    .catch(() => {})
  loading = Promise.all([settings, cron]).then(() => {})
  return loading
}

/** Let permission dialogs be answered from the office (POST /settings, UI token). */
export async function setAnswerPermissions(on: boolean): Promise<boolean> {
  const before = state.answerPermissions
  set({ answerPermissions: on })
  const ok = await postSetting({ answerPermissions: on })
  if (!ok) set({ answerPermissions: before })
  return ok
}

/** How much of each prompt and reply the server keeps (POST /settings, UI token). */
export async function setLogPrompts(level: LogPromptsLevel): Promise<boolean> {
  const before = state.logPrompts
  set({ logPrompts: level })
  const ok = await postSetting({ logPrompts: level })
  if (!ok) set({ logPrompts: before })
  return ok
}

/** Pause or resume the AI chat monitor (POST /chat/cron-state — open, as the header toggle always was). */
export async function setAiPaused(paused: boolean): Promise<boolean> {
  const before = state.aiPaused
  set({ aiPaused: paused })
  try {
    const res = await fetch(`${officeHttpBase()}/chat/cron-state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
    })
    if (!res.ok) throw new Error(String(res.status))
    return true
  } catch {
    set({ aiPaused: before })
    return false
  }
}

/** The settings, re-rendering on every change. Starts the one-time load. */
export function useServerSettings(): ServerSettings {
  void loadServerSettings()
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb) },
    () => state,
    () => state,
  )
}
