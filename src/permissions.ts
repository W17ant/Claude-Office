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
 */

import type { OfficeEvent, PendingPermission, PermissionSuggestion } from './types'
import { officeHttpBase } from './serverUrl'

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
// The token arrives on the WS snapshot (origin-gated on the server, so only
// the office page ever sees it) and is kept here, not in React state: the
// chat header's toggle and the cards both need it at click time, and nothing
// re-renders because of it.
// ---------------------------------------------------------------------------

let uiToken: string | null = null

export function setUiToken(token: string | null | undefined): void {
  uiToken = typeof token === 'string' && token ? token : null
}

export function getUiToken(): string | null {
  return uiToken
}

/** POST a JSON body with the UI token; false without a token, on a network error or a non-2xx. */
async function postWithUiToken(path: string, body: unknown): Promise<boolean> {
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

/** Change an office setting (answerPermissions, logPrompts). */
export function postSetting(body: Record<string, unknown>): Promise<boolean> {
  return postWithUiToken('/settings', body)
}

// ---------------------------------------------------------------------------
// Words on the card
// ---------------------------------------------------------------------------

const VERB_BY_TOOL: Record<string, string> = {
  Bash: 'run', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read',
  WebFetch: 'fetch', WebSearch: 'search', Glob: 'find files', Grep: 'search',
}

/** "Claude wants to run Bash", "... write probe.txt", "... use mcp__github__create_pull_request". */
export function permissionTitle(p: Pick<PendingPermission, 'toolName' | 'summary'>): string {
  const verb = VERB_BY_TOOL[p.toolName]
  if (!verb) return `Claude wants to use ${p.toolName}`
  if (p.toolName === 'Bash') return 'Claude wants to run Bash'
  const what = p.summary && p.summary !== p.toolName ? p.summary : p.toolName
  return `Claude wants to ${verb} ${what}`
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
  if (!suggestions?.length) return 'Nothing to remember'
  const parts = suggestions.map(s => {
    const where = typeof s.destination === 'string' ? ` (${kebab(s.destination)})` : ''
    switch (s.type) {
      case 'setMode':
        return `switch this session to ${typeof s.mode === 'string' ? kebab(s.mode) : 'another mode'}`
      case 'addRules': case 'replaceRules': {
        const rules = Array.isArray(s.rules) ? s.rules : []
        const names = rules.map(r => {
          const rule = (r ?? {}) as Record<string, unknown>
          const tool = typeof rule.toolName === 'string' ? rule.toolName : 'tool'
          return typeof rule.ruleContent === 'string' && rule.ruleContent ? `${tool}(${rule.ruleContent})` : tool
        })
        const behavior = typeof s.behavior === 'string' ? s.behavior : 'allow'
        return `always ${behavior} ${names.join(', ') || 'this'}${where}`
      }
      case 'addDirectories': {
        const dirs = Array.isArray(s.directories) ? s.directories.map(String) : []
        return `allow access to ${dirs.join(', ') || 'this directory'}${where}`
      }
      default:
        return `${typeof s.type === 'string' ? kebab(s.type) : 'remember this'}${where}`
    }
  })
  return `Allow, and ${parts.join('; ')}`
}

/** The line a resolved card shows while it fades. */
export function fadeLabel(resolved: { status: string; decidedBy: string }): string {
  if (resolved.decidedBy === 'timeout') return 'timed out'
  if (resolved.decidedBy === 'office') return resolved.status === 'denied' ? 'denied from the office' : 'allowed from the office'
  return 'answered in the terminal'
}
