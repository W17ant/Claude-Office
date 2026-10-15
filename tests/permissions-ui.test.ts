/**
 * src/permissions.ts — the permission cards' pure reducer and the words on
 * a card (no DOM: PermissionCard.tsx only draws this state).
 */

import { describe, expect, it } from 'vitest'
import {
  FADE_MS, describeSuggestions, fadeLabel, getUiToken, isPermissionEvent, permissionTitle, reducePermissions, setUiToken,
  type PermissionCardState,
} from '../src/permissions'
import type { PendingPermission } from '../src/types'

function pending(id: string, overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id, sessionId: 's-1', project: 'alpha', cwd: '/home/me/alpha', toolName: 'Write', summary: 'probe.txt', detail: '/home/me/alpha/probe.txt',
    suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], permissionMode: 'default',
    createdAt: 1_000, deadline: 16_000, status: 'pending', interactive: false, ...overrides,
  }
}

describe('reducePermissions', () => {
  it('permission_request adds a card once, permission_extended moves its deadline, permission_resolved marks it and dismiss removes it', () => {
    let s: PermissionCardState[] = []
    s = reducePermissions(s, { type: 'permission_request', permission: pending('a') })
    s = reducePermissions(s, { type: 'permission_request', permission: pending('a') })
    expect(s).toEqual([pending('a')])
    s = reducePermissions(s, { type: 'permission_extended', permissionId: 'a', deadline: 601_000 })
    expect(s[0].deadline).toBe(601_000)
    s = reducePermissions(s, { type: 'permission_extended', permissionId: 'zzz', deadline: 5 })
    expect(s).toHaveLength(1)
    s = reducePermissions(s, { type: 'permission_resolved', permissionId: 'a', status: 'allowed', decidedBy: 'office' }, 42_000)
    expect(s[0]).toMatchObject({ status: 'allowed', resolved: { status: 'allowed', decidedBy: 'office', at: 42_000 } })
    // A second resolution does not restart the fade
    s = reducePermissions(s, { type: 'permission_resolved', permissionId: 'a', status: 'expired', decidedBy: 'timeout' }, 50_000)
    expect(s[0].resolved).toEqual({ status: 'allowed', decidedBy: 'office', at: 42_000 })
    expect(reducePermissions(s, { type: 'permission_resolved', permissionId: 'nope', status: 'allowed', decidedBy: 'office' })).toBe(s)
    s = reducePermissions(s, { type: 'permission_dismiss', permissionId: 'a' })
    expect(s).toEqual([])
  })

  it('sent disables the card until the server answers; unsent puts it back', () => {
    let s = reducePermissions([], { type: 'permission_request', permission: pending('a') })
    s = reducePermissions(s, { type: 'permission_sent', permissionId: 'a', decision: 'deny' })
    expect(s[0].sent).toBe('deny')
    s = reducePermissions(s, { type: 'permission_unsent', permissionId: 'a' })
    expect(s[0].sent).toBeUndefined()
  })

  it('the snapshot replaces the pending set (a reconnect may have missed a resolution) but keeps fading cards and a pending card\'s sent', () => {
    let s = reducePermissions([], { type: 'permission_request', permission: pending('gone') })
    s = reducePermissions(s, { type: 'permission_request', permission: pending('kept') })
    s = reducePermissions(s, { type: 'permission_sent', permissionId: 'kept', decision: 'allow' })
    s = reducePermissions(s, { type: 'permission_request', permission: pending('fading') })
    s = reducePermissions(s, { type: 'permission_resolved', permissionId: 'fading', status: 'denied', decidedBy: 'terminal' }, 7)
    s = reducePermissions(s, { type: 'snapshot', activeAgents: [], pendingPermissions: [pending('kept', { deadline: 99 }), pending('new')] })
    expect(s.map(c => c.id)).toEqual(['fading', 'kept', 'new'])
    expect(s[1]).toMatchObject({ sent: 'allow', deadline: 99 })
    // A snapshot from a server without the feature says nothing about cards
    expect(reducePermissions(s, { type: 'snapshot', activeAgents: [] })).toBe(s)
    // Other events are not the reducer's business
    expect(reducePermissions(s, { type: 'agent_working', status: 'x' })).toBe(s)
  })

  it('isPermissionEvent names exactly the three server events; FADE_MS is 1.5 s', () => {
    expect(['permission_request', 'permission_extended', 'permission_resolved'].every(type => isPermissionEvent({ type }))).toBe(true)
    expect(isPermissionEvent({ type: 'snapshot' })).toBe(false)
    expect(isPermissionEvent({ type: 'session_needs_you' })).toBe(false)
    expect(FADE_MS).toBe(1500)
  })
})

describe('the words on a card', () => {
  it('permissionTitle', () => {
    expect(permissionTitle({ toolName: 'Bash', summary: 'npm test' })).toBe('Claude wants to run Bash')
    expect(permissionTitle({ toolName: 'Write', summary: 'probe.txt' })).toBe('Claude wants to write probe.txt')
    expect(permissionTitle({ toolName: 'Edit', summary: 'App.tsx' })).toBe('Claude wants to edit App.tsx')
    expect(permissionTitle({ toolName: 'Read', summary: 'Read' })).toBe('Claude wants to read Read')
    expect(permissionTitle({ toolName: 'mcp__github__create_pull_request', summary: 'mcp__github__create_pull_request' })).toBe('Claude wants to use mcp__github__create_pull_request')
    expect(permissionTitle({ toolName: 'WebFetch', summary: 'WebFetch' })).toBe('Claude wants to fetch WebFetch')
  })

  it('describeSuggestions says what "Allow & remember" would do, per PermissionUpdate type', () => {
    expect(describeSuggestions([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])).toBe('Allow, and switch this session to accept-edits')
    expect(describeSuggestions([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }]))
      .toBe('Allow, and always allow Bash(npm test:*) (local-settings)')
    expect(describeSuggestions([{ type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' }])).toBe('Allow, and allow access to /tmp/x (session)')
    expect(describeSuggestions([{ type: 'somethingNew', destination: 'userSettings' }])).toBe('Allow, and something-new (user-settings)')
    expect(describeSuggestions([])).toBe('Nothing to remember')
    expect(describeSuggestions(undefined)).toBe('Nothing to remember')
  })

  it('fadeLabel', () => {
    expect(fadeLabel({ status: 'allowed', decidedBy: 'office' })).toBe('allowed from the office')
    expect(fadeLabel({ status: 'denied', decidedBy: 'office' })).toBe('denied from the office')
    expect(fadeLabel({ status: 'resolved_elsewhere', decidedBy: 'terminal' })).toBe('answered in the terminal')
    expect(fadeLabel({ status: 'expired', decidedBy: 'timeout' })).toBe('timed out')
  })

  it('the UI token store', () => {
    expect(getUiToken()).toBeNull()
    setUiToken('abc')
    expect(getUiToken()).toBe('abc')
    setUiToken(undefined)
    expect(getUiToken()).toBeNull()
    setUiToken('')
    expect(getUiToken()).toBeNull()
  })
})
