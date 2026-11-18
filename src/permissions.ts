/**
 * permissions.ts — answer a Claude Code permission dialog from the office.
 *
 * The server (server/permissions.js) broadcasts a `permission_request` when
 * a session's PermissionRequest hook is waiting on the office, a
 * `permission_extended` when its deadline moves (the session turned out to
 * be interactive), and a `permission_resolved` when it is over — answered
 * here, answered in the terminal, or timed out. The WS snapshot carries the
 * ones still pending plus the UI token that may answer them.
 *
 * This module is the cards' state (a pure reducer, kept out of the office
 * reducer: cards are not characters), the UI token store, and the two POSTs
 * the page makes with it. src/components/PermissionCard.tsx draws the cards.
 *
 * On a phone-full page (the HTTPS LAN listener, src/phoneSecret.ts) the
 * token the page acts with is the phone secret instead: the listener checks
 * it and swaps it for the UI token itself, so the UI token never travels to
 * the phone.
 */

import type { OfficeEvent, PendingPermission, PermissionSuggestion } from './types'
import { officeHttpBase } from './serverUrl'
import { getPhoneSecret, onPhoneFullPage } from './phoneSecret'
import { t } from './i18n'

export type PermissionDecision = 'allow' | 'allow-remember' | 'deny'

/** A pending permission as the page shows it: the server's record plus what happened here. */
export interface PermissionCardState extends PendingPermission {
  /** The button clicked here, until the server says it is over (optimistic disable) */
  sent?: PermissionDecision
  /** Set by permission_resolved: the card fades for FADE_MS, then is dismissed */
  resolved?: { status: string; decidedBy: string; at: number }
}

export type PermissionAction =
  | OfficeEvent
  | { type: 'permission_sent'; permissionId: string; decision: PermissionDecision }
  | { type: 'permission_unsent'; permissionId: string }
  | { type: 'permission_dismiss'; permissionId: string }

/** The server events this reducer owns outright (App hands them here and nowhere else). */
export const PERMISSION_EVENT_TYPES = new Set(['permission_request', 'permission_extended', 'permission_resolved'])

export function isPermissionEvent(action: { type: string }): action is OfficeEvent & { type: 'permission_request' | 'permission_extended' | 'permission_resolved' } {
  return PERMISSION_EVENT_TYPES.has(action.type)
}

/** How long a resolved card lingers with its outcome before it goes. */
export const FADE_MS = 1500

/**
 * One transition of the card list. The snapshot replaces the pending set
 * (a reconnect may have missed a resolution) but keeps cards already fading
 * and the `sent` of a card still pending.
 */
export function reducePermissions(state: PermissionCardState[], action: PermissionAction, now: number = Date.now()): PermissionCardState[] {
  switch (action.type) {
    case 'permission_request': {
      const p = action.permission
      if (!p?.id) return state
      const i = state.findIndex(c => c.id === p.id)
      if (i < 0) return [...state, { ...p }]
      const next = state.slice()
      next[i] = { ...next[i], ...p }
      return next
    }
    case 'permission_extended': {
      const { permissionId, deadline } = action
      if (!permissionId || typeof deadline !== 'number') return state
      return state.map(c => (c.id === permissionId ? { ...c, deadline } : c))
    }
    case 'permission_resolved': {
      const { permissionId } = action
      if (!permissionId || !state.some(c => c.id === permissionId)) return state
      return state.map(c => (c.id === permissionId && !c.resolved
        ? { ...c, status: (action.status as PendingPermission['status']) ?? c.status, resolved: { status: action.status ?? 'resolved', decidedBy: action.decidedBy ?? 'terminal', at: now } }
        : c))
    }
    case 'snapshot': {
      const pending = action.pendingPermissions
      if (!Array.isArray(pending)) return state
      const fading = state.filter(c => c.resolved)
      const kept = pending.filter(p => p?.id).map(p => {
        const prev = state.find(c => c.id === p.id)
        return prev ? { ...prev, ...p } : { ...p }
      })
      return [...fading, ...kept]
    }
    case 'permission_sent':
      return state.map(c => (c.id === action.permissionId ? { ...c, sent: action.decision } : c))
    case 'permission_unsent':
      return state.map(c => (c.id === action.permissionId && c.sent ? { ...c, sent: undefined } : c))
    case 'permission_dismiss':
      return state.filter(c => c.id !== action.permissionId)
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// The UI token and the two POSTs made with it
//
// The token arrives on the WS snapshot — only on a connection that presented
// the office token (src/officeToken.ts), so a read-only page never has one —
// and is kept here, not in React state: the chat header's toggle and the
// cards both need it at click time, and nothing re-renders because of it.
//
// A phone-full page is the exception: its snapshot carries no UI token (the
// server leaves it out), and the token it acts with is the phone secret. That
// one is read from storage at every use rather than seated here once, so a
// new link opened in another tab takes effect at once and a snapshot can
// never wipe it.
// ---------------------------------------------------------------------------

let snapshotUiToken: string | null = null

/**
 * Keep the UI token a snapshot carried (null when it carried none).
 * @param token the snapshot's uiToken
 */
export function setUiToken(token: string | null | undefined): void {
  snapshotUiToken = typeof token === 'string' && token ? token : null
}

/**
 * The token this page acts with: the phone secret on a phone-full page (and
 * nothing else there, even if a snapshot had brought one), the snapshot's UI
 * token everywhere else.
 * @returns the bearer value, or null when the page may not act
 */
export function getUiToken(): string | null {
  if (onPhoneFullPage()) return getPhoneSecret()
  return snapshotUiToken
}

/** POST a JSON body with the UI token; false without a token, on a network error or a non-2xx. */
async function postWithUiToken(path: string, body: unknown): Promise<boolean> {
  const uiToken = getUiToken()
  if (!uiToken) return false
  try {
    const res = await fetch(`${officeHttpBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uiToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Answer a pending permission: the server resolves it and the hook prints the matching output. */
export function answerPermission(permissionId: string, decision: PermissionDecision): Promise<boolean> {
  return postWithUiToken(`/permission/${encodeURIComponent(permissionId)}`, { decision })
}

/** Change an office setting (answerPermissions, notifyPermissions, logPrompts). */
export function postSetting(body: Record<string, unknown>): Promise<boolean> {
  return postWithUiToken('/settings', body)
}

// ---------------------------------------------------------------------------
// Words on the card
// ---------------------------------------------------------------------------

/** "Claude wants to run Bash", "... write probe.txt", "... use mcp__github__create_pull_request". */
export function permissionTitle(p: Pick<PendingPermission, 'toolName' | 'summary'>): string {
  const what = p.summary && p.summary !== p.toolName ? p.summary : p.toolName
  // Why one whole sentence per verb, not a verb dropped into a frame: word
  // order differs by language (the verb goes last in German and Japanese)
  switch (p.toolName) {
    // Why the bare tool name for Bash: its summary is the command, which the card's detail already shows
    case 'Bash':         return t('ui.permission.title.run', { what: p.toolName })
    case 'Write':        return t('ui.permission.title.write', { what })
    case 'Edit': case 'MultiEdit': case 'NotebookEdit':
                         return t('ui.permission.title.edit', { what })
    case 'Read':         return t('ui.permission.title.read', { what })
    case 'WebFetch':     return t('ui.permission.title.fetch', { what })
    case 'WebSearch': case 'Grep':
                         return t('ui.permission.title.search', { what })
    case 'Glob':         return t('ui.permission.title.findFiles', { what })
    default:             return t('ui.permission.title.use', { tool: p.toolName })
  }
}

/** acceptEdits -> accept-edits, bypassPermissions -> bypass-permissions. */
function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * What "Allow & remember" would do, from the dialog's own suggestions
 * (Claude Code PermissionUpdate objects: setMode, addRules, addDirectories...).
 */
export function describeSuggestions(suggestions: PermissionSuggestion[] | undefined): string {
  if (!suggestions?.length) return t('ui.permission.remember.nothing')
  const parts = suggestions.map(s => {
    // Why the destination, mode and rule names stay as they are: they are Claude Code's own identifiers
    const where = typeof s.destination === 'string' ? ` (${kebab(s.destination)})` : ''
    switch (s.type) {
      case 'setMode':
        return t('ui.permission.remember.setMode', { mode: typeof s.mode === 'string' ? kebab(s.mode) : t('ui.permission.remember.anotherMode') })
      case 'addRules': case 'replaceRules': {
        const list = Array.isArray(s.rules) ? s.rules : []
        const names = list.map(r => {
          const rule = (r ?? {}) as Record<string, unknown>
          const tool = typeof rule.toolName === 'string' ? rule.toolName : t('ui.permission.remember.tool')
          return typeof rule.ruleContent === 'string' && rule.ruleContent ? `${tool}(${rule.ruleContent})` : tool
        })
        const rules = names.join(', ') || t('ui.permission.remember.this')
        const behavior = typeof s.behavior === 'string' ? s.behavior : 'allow'
        switch (behavior) {
          case 'allow': return t('ui.permission.remember.alwaysAllow', { rules, where })
          case 'deny':  return t('ui.permission.remember.alwaysDeny', { rules, where })
          case 'ask':   return t('ui.permission.remember.alwaysAsk', { rules, where })
          default:      return t('ui.permission.remember.always', { behavior, rules, where })
        }
      }
      case 'addDirectories': {
        const dirs = Array.isArray(s.directories) ? s.directories.map(String) : []
        return t('ui.permission.remember.directories', { dirs: dirs.join(', ') || t('ui.permission.remember.thisDirectory'), where })
      }
      default:
        return `${typeof s.type === 'string' ? kebab(s.type) : t('ui.permission.remember.other')}${where}`
    }
  })
  return t('ui.permission.remember.all', { parts: parts.join('; ') })
}

/** The line a resolved card shows while it fades. */
export function fadeLabel(resolved: { status: string; decidedBy: string }): string {
  if (resolved.decidedBy === 'timeout') return t('ui.permission.fade.timedOut')
  if (resolved.decidedBy === 'office') return resolved.status === 'denied' ? t('ui.permission.fade.deniedOffice') : t('ui.permission.fade.allowedOffice')
  return t('ui.permission.fade.terminal')
}
