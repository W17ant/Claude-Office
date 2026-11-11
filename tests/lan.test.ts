/**
 * lan.test.ts - Phone mode: the LAN listener, its viewer key and redactForLan; the Tailscale host allowlist.
 *
 * The LAN listener is a second, watch-only window onto the office over plain
 * HTTP on the Wi-Fi. These tests hold it to its rules: exact Host and
 * Origin, static files only (every API route 404, even with the office
 * token), a WebSocket that needs the viewer key and never accepts the
 * office token, and a stream with nothing that names the user's work — a
 * SECRET sentinel planted in every text field of every event must never
 * reach a LAN viewer. Then AGENT_OFFICE_ALLOWED_HOSTS: the loopback guard
 * accepts the configured proxy names and still refuses everything else.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listen, loadOffice, officeProtocols, postAuthed, postEvent, removeOffice, type Office } from './helpers'
import {
  isPrivateIPv4, pickLanAddress, readLanConfig, lanHostOk, lanOriginOk, viewerKeyFrom, viewerKeyMatches,
  viewerLink, parseAllowedHost, parseAllowedHosts, allowedHostMatches, allowedOriginMatches, qrModules, renderQr,
  DEFAULT_LAN_PORT, WS_VIEWER_PROTOCOL_PREFIX,
} from '../server/lan.js'

type Message = Record<string, any>
const quiet = { warn: () => {} }
const KEY = 'ab'.repeat(32)

// ---------------------------------------------------------------------------
// server/lan.js — pure helpers
// ---------------------------------------------------------------------------

describe('server/lan.js: picking the LAN address', () => {
  it('isPrivateIPv4: RFC 1918 only', () => {
    for (const ok of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.23']) expect(isPrivateIPv4(ok), ok).toBe(true)
    for (const no of ['0.0.0.0', '127.0.0.1', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.1', '169.254.1.1', '8.8.8.8', '10.0.0.256', 'localhost', '::1', '', '192.168.1']) {
      expect(isPrivateIPv4(no), no).toBe(false)
    }
  })

  it('pickLanAddress: the first non-internal private IPv4', () => {
    const ifaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
      en0: [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.23', family: 'IPv4', internal: false }],
      en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    }
    expect(pickLanAddress(ifaces as any)).toBe('192.168.1.23')
    expect(pickLanAddress({ lo0: ifaces.lo0, utun3: ifaces.utun3 } as any)).toBeNull()
  })

  it('readLanConfig: off by default; on, it picks the address and port 3335', () => {
    const interfaces = { en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }
    expect(readLanConfig({}, { interfaces, log: quiet })).toEqual({ enabled: false })
    expect(readLanConfig({ AGENT_OFFICE_LAN: '0' }, { interfaces, log: quiet })).toEqual({ enabled: false })
    expect(readLanConfig({ AGENT_OFFICE_LAN: '1' }, { interfaces, log: quiet })).toEqual({ enabled: true, host: '192.168.1.23', port: DEFAULT_LAN_PORT })
    expect(readLanConfig({ AGENT_OFFICE_LAN: 'true', AGENT_OFFICE_LAN_PORT: '4000' }, { interfaces, log: quiet })).toMatchObject({ port: 4000 })
  })

  it('readLanConfig: an override must itself be private; 0.0.0.0, loopback, public and names leave LAN mode off', () => {
    const interfaces = { en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }
    expect(readLanConfig({ AGENT_OFFICE_LAN: '1', AGENT_OFFICE_LAN_HOST: '10.1.2.3' }, { interfaces, log: quiet })).toEqual({ enabled: true, host: '10.1.2.3', port: 3335 })
    const warnings: string[] = []
    for (const bad of ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'my-mac.local', '::']) {
      expect(readLanConfig({ AGENT_OFFICE_LAN: '1', AGENT_OFFICE_LAN_HOST: bad }, { interfaces, log: { warn: (m: string) => warnings.push(m) } }).enabled, bad).toBe(false)
    }
    expect(warnings).toHaveLength(5)
    expect(readLanConfig({ AGENT_OFFICE_LAN: '1', AGENT_OFFICE_LAN_PORT: '70000' }, { interfaces, log: quiet }).enabled).toBe(false)
    expect(readLanConfig({ AGENT_OFFICE_LAN: '1' }, { interfaces: {}, log: quiet })).toMatchObject({ enabled: false, reason: expect.stringMatching(/no private/) })
  })

  it('lanHostOk / lanOriginOk: exactly the LAN IP and port', () => {
    expect(lanHostOk('192.168.1.23:3335', '192.168.1.23', 3335)).toBe(true)
    for (const bad of ['192.168.1.23', '192.168.1.23:3334', 'evil.example:3335', 'localhost:3335', '', undefined]) {
      expect(lanHostOk(bad, '192.168.1.23', 3335), String(bad)).toBe(false)
    }
    expect(lanOriginOk(undefined, '192.168.1.23', 3335)).toBe(true)
    expect(lanOriginOk('http://192.168.1.23:3335', '192.168.1.23', 3335)).toBe(true)
    for (const bad of ['null', 'https://192.168.1.23:3335', 'http://192.168.1.23', 'http://evil.example:3335', 'http://127.0.0.1:3334']) {
      expect(lanOriginOk(bad, '192.168.1.23', 3335), bad).toBe(false)
    }
  })

  it('viewerKeyFrom / viewerKeyMatches: the viewer subprotocol, compared in full', () => {
    const req = (h?: string) => ({ headers: { 'sec-websocket-protocol': h } })
    expect(viewerKeyFrom(req(`agent-office, ${WS_VIEWER_PROTOCOL_PREFIX}${KEY}`))).toBe(KEY)
    expect(viewerKeyFrom(req(`agent-office, agent-office.token.${KEY}`))).toBe('')
    expect(viewerKeyFrom(req())).toBe('')
    expect(viewerKeyMatches(KEY, KEY)).toBe(true)
    expect(viewerKeyMatches(KEY.slice(1), KEY)).toBe(false)
    expect(viewerKeyMatches('', KEY)).toBe(false)
    expect(viewerLink('192.168.1.23', 3335, KEY)).toBe(`http://192.168.1.23:3335/#viewer=${KEY}`)
  })

  it('the QR code: a version-5 matrix for a phone link, drawn with half blocks', () => {
    const link = viewerLink('192.168.100.200', 65535, KEY)
    const modules = qrModules(link)!
    // 101 bytes at error level L need version 5: 17 + 4 × 5 = 37 modules a side
    expect(modules).toHaveLength(37)
    // The three finder patterns' dark corners
    expect([modules[0][0], modules[0][36], modules[36][0]]).toEqual([true, true, true])
    const drawn = renderQr(link)!
    // (37 + 2 × 4 quiet modules) / 2 rows per line, rounded up
    expect(drawn.split('\n')).toHaveLength(23)
  })
})

describe('server/lan.js: AGENT_OFFICE_ALLOWED_HOSTS entries', () => {
  it('accepts host names (with an optional port), lower-cased', () => {
    expect(parseAllowedHost('My-Mac.tail1234.ts.net')).toEqual({ host: 'my-mac.tail1234.ts.net', port: null })
    expect(parseAllowedHost('office.example.com:8443')).toEqual({ host: 'office.example.com', port: 8443 })
  })

  it('refuses wildcards, schemes, paths, IPs, single labels, user info and bad ports', () => {
    for (const bad of ['*.ts.net', 'https://my-mac.ts.net', 'my-mac.ts.net/x', '100.64.0.1', '192.168.1.2:3334', '[::1]', 'my-mac',
      'me@my-mac.ts.net', 'my_mac.ts.net', 'my-mac.ts.net:0', 'my-mac.ts.net:99999', '-x.ts.net', 'a..b', '']) {
      expect(parseAllowedHost(bad), bad).toBeNull()
    }
  })

  it('parseAllowedHosts logs and skips the bad ones', () => {
    const warnings: string[] = []
    const list = parseAllowedHosts('my-mac.tail1234.ts.net, *.ts.net,  ,https://x.ts.net,good.ts.net:8443', { warn: (m: string) => warnings.push(m) })
    expect(list).toEqual([{ host: 'my-mac.tail1234.ts.net', port: null }, { host: 'good.ts.net', port: 8443 }])
    expect(warnings).toHaveLength(2)
    expect(parseAllowedHosts(undefined)).toEqual([])
  })

  it('a Host / Origin matches only the listed name, scheme and port', () => {
    const allowed = [{ host: 'my-mac.ts.net', port: null }, { host: 'good.ts.net', port: 8443 }]
    expect(allowedHostMatches('my-mac.ts.net', allowed)).toBe(true)
    expect(allowedHostMatches('my-mac.ts.net:443', allowed)).toBe(true)
    expect(allowedHostMatches('good.ts.net:8443', allowed)).toBe(true)
    for (const bad of ['my-mac.ts.net:3334', 'good.ts.net', 'evil-my-mac.ts.net', 'my-mac.ts.net.evil.com']) expect(allowedHostMatches(bad, allowed), bad).toBe(false)
    expect(allowedOriginMatches('https://my-mac.ts.net', allowed)).toBe(true)
    expect(allowedOriginMatches('https://good.ts.net:8443', allowed)).toBe(true)
    for (const bad of ['http://my-mac.ts.net', 'https://my-mac.ts.net:444', 'https://good.ts.net', 'https://evil.ts.net']) expect(allowedOriginMatches(bad, allowed), bad).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// redactForLan — every event type the server broadcasts
// ---------------------------------------------------------------------------

const SECRET = 'SECRET'
const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const MAIN = {
  state: 'needs-you', since: 1, waitingOn: 0, crons: 0, promptId: 'p1', lastPromptAt: 1, lastReplyAt: 2,
  lastPrompt: `${SECRET} prompt`, lastReply: `${SECRET} reply`,
  needsYou: { kind: 'permission', toolName: 'Bash', summary: `${SECRET} sum`, message: `${SECRET} msg`, since: 1 },
  error: { error: 'rate_limit', detail: `${SECRET} detail`, since: 1 },
}
const SESSION = {
  sessionId: SID, hooked: true, project: `${SECRET}proj`, cwd: `/Users/me/${SECRET}`, title: `${SECRET} title`,
  transcriptPath: `/x/${SECRET}.jsonl`, source: 'startup', state: 'active', startedAt: 1, lastActivityAt: 2, model: 'claude-opus',
  lastStatus: `running: ${SECRET}`, lastStatusAt: 2, agentIds: ['a1'], agentCount: 1, workingCount: 1, main: MAIN,
  registry: { pid: 42, name: `${SECRET}-name`, nameSource: 'user', status: 'busy', startedAt: 1 },
}
const AGENT = {
  id: 'a1', name: 'Dev', role: 'frontend-developer', task: `${SECRET} task`, agentType: 'frontend-developer', background: false,
  state: 'working', spawnedAt: 1, lastActivityAt: 2, sessionId: SID, project: `${SECRET}proj`, status: `running: ${SECRET}`,
  lastError: `${SECRET} err`, result: `${SECRET} result`, transcriptPath: `/x/${SECRET}`, unread: 2,
}
const PERMISSION = {
  id: 'perm1', sessionId: SID, project: `${SECRET}proj`, cwd: `/x/${SECRET}`, sessionTitle: `${SECRET} t`, toolName: 'Bash',
  summary: `${SECRET} sum`, detail: `${SECRET} cmd`, suggestions: [{ rule: SECRET }], permissionMode: 'default', callKey: `${SECRET}k`,
  createdAt: 1, deadline: 2, status: 'pending',
}
const SIGNAL = {
  kind: 'test_failed', target: `${SECRET}app`, detail: `${SECRET} 3 failing`, error: `${SECRET} err`, branch: `${SECRET}-b`,
  exitCode: 1, sessionId: SID, project: `${SECRET}proj`, agentId: 'a1', agentName: 'Dev', at: 1, seq: 1,
}
const BOARD = {
  sessionId: SID, project: `${SECRET}proj`, updatedAt: 1, counts: { pending: 1, in_progress: 1, completed: 0 },
  tasks: [{ id: '1', subject: `${SECRET} subject`, activeForm: `${SECRET} doing`, status: 'in_progress', blockedBy: [], owner: 'Dev' },
    { id: '2', subject: `${SECRET} next`, status: 'pending', blockedBy: ['1'] }],
}

/** One representative payload per broadcast type, each with SECRET in every text field it can carry. */
const PAYLOADS: Record<string, Message> = {
  snapshot: {
    type: 'snapshot', activeAgents: [AGENT], sessions: [{ ...SESSION, id: SID }], statuses: { sessions: [{ project: SECRET }], totals: {} },
    health: { status: 'ok', agents: 1, clients: 1, sessions: 1, lastHookAt: 1, hooksSeen: 3, uiAvailable: true, version: '1.1.2', uptimeMs: 5 },
    mcpServers: ['github'], pendingPermissions: [PERMISSION], uiToken: `${SECRET}ui`, signals: [SIGNAL], taskBoards: [BOARD], timestamp: 1,
  },
  office_interaction: { type: 'office_interaction', item: 'plant-1', by: 'phone', timestamp: 1 },
  agent_spawned: { type: 'agent_spawned', agent: AGENT, project: `${SECRET}proj`, cwd: `/x/${SECRET}`, sessionId: SID, timestamp: 1 },
  agent_working: { type: 'agent_working', agentId: 'a1', status: `running: ${SECRET}`, failed: true, sessionId: SID, project: `${SECRET}proj`, timestamp: 1 },
  agent_completed: { type: 'agent_completed', agentId: 'a1', result: `${SECRET} done`, tokens: 5, durationMs: 9, sessionId: SID, timestamp: 1 },
  mcp_call: { type: 'mcp_call', server: 'github', tool: 'create_issue', agentId: 'mcp-1', sessionId: SID, timestamp: 1 },
  mcp_done: { type: 'mcp_done', server: 'github', sessionId: SID, timestamp: 1 },
  session_started: { type: 'session_started', ...SESSION, timestamp: 1 },
  session_ended: { type: 'session_ended', ...SESSION, state: 'ended', reason: 'clear', timestamp: 1 },
  session_registry: { type: 'session_registry', ...SESSION, timestamp: 1 },
  session_cwd: { type: 'session_cwd', ...SESSION, oldCwd: `/x/${SECRET}old`, timestamp: 1 },
  session_model: { type: 'session_model', ...SESSION, fromModel: 'claude-sonnet', timestamp: 1 },
  session_prompt: { type: 'session_prompt', sessionId: SID, project: `${SECRET}proj`, promptId: 'p1', text: `${SECRET} prompt`, isWakeup: false, wakeupStatus: SECRET, messageId: 7, main: MAIN, timestamp: 1 },
  session_turn_end: {
    type: 'session_turn_end', sessionId: SID, project: `${SECRET}proj`, text: `${SECRET} reply`, messageId: 8, crons: 0, stopHookActive: false,
    backgroundTasks: [{ id: 'b1', type: 'shell', status: 'running', description: `${SECRET} bg` }], main: MAIN, timestamp: 1,
  },
  session_needs_you: {
    type: 'session_needs_you', sessionId: SID, project: `${SECRET}proj`, kind: 'permission', toolName: 'Bash', summary: `${SECRET} sum`,
    message: `${SECRET} msg`, needsYou: MAIN.needsYou, main: MAIN, timestamp: 1,
  },
  session_error: { type: 'session_error', sessionId: SID, project: `${SECRET}proj`, error: `${SECRET} free text`, detail: `${SECRET} d`, main: MAIN, timestamp: 1 },
  session_compact: { type: 'session_compact', sessionId: SID, project: `${SECRET}proj`, phase: 'start', trigger: 'auto', main: MAIN, timestamp: 1 },
  session_main: { type: 'session_main', sessionId: SID, project: `${SECRET}proj`, reason: 'permission answered', main: MAIN, timestamp: 1 },
  chat_message: { type: 'chat_message', id: 3, sender: 'Dev', role: 'frontend-developer', text: `${SECRET} line`, timestamp: 1, is_system: 0, recipient: 'Rev', msg_type: 'message', senderId: 'a1', recipientId: 'a2' },
  chat_typing: { type: 'chat_typing', sender: 'Dev' },
  chat_seen: { type: 'chat_seen', messageId: 3 },
  chat_reaction: { type: 'chat_reaction', messageId: 3, reactions: ['👍'] },
  inbox_update: { type: 'inbox_update', agentId: 'a1', unread: 1 },
  permission_request: { type: 'permission_request', permission: PERMISSION, timestamp: 1 },
  permission_resolved: { type: 'permission_resolved', permissionId: 'perm1', sessionId: SID, status: 'allowed', decidedBy: 'office', timestamp: 1 },
  permission_extended: { type: 'permission_extended', permissionId: 'perm1', sessionId: SID, deadline: 3, timestamp: 1 },
  signal: { type: 'signal', ...SIGNAL, timestamp: 1 },
  task_board: { type: 'task_board', sessionId: SID, board: BOARD, timestamp: 1 },
  health: { type: 'health', health: { status: 'ok', agents: 1, clients: 1, sessions: 1, lastHookAt: null, hooksSeen: 0, uiAvailable: true, version: '1', uptimeMs: 1 }, timestamp: 1 },
  variant_change: { type: 'variant_change', variant: 'incident', reason: 'manual', timestamp: 1 },
  session_status: { type: 'session_status', sessionId: SID, session: { project: `${SECRET}proj`, cost: 1 }, totals: {}, timestamp: 1 },
  agent_status: { type: 'agent_status', sessionId: SID, agents: [{ id: 'a1', tokens: 1, status: SECRET, description: SECRET }], timestamp: 1 },
}

/** Every `type: '...'` and session event type the server sources can emit. */
function serverEventTypes(): Set<string> {
  const types = new Set<string>()
  for (const file of ['index.js', 'status.js', 'permissions.js', 'health.js', 'tasks.js', 'sessions.js']) {
    const src = readFileSync(join(__dirname, '..', 'server', file), 'utf8')
    for (const m of src.matchAll(/type: '([a-z_]+)'/g)) types.add(m[1])
    for (const m of src.matchAll(/(?:sessionEvent|toEvent)\([^,()]+, '([a-z_]+)'\)/g)) types.add(m[1])
  }
  return types
}

// Literal `type: '...'` strings in server/ that are not WebSocket broadcasts
const NOT_BROADCAST = new Set(['auth', 'http'])

describe('redactForLan: the scene and nothing that names the work', () => {
  let office: Office
  beforeAll(async () => { office = await loadOffice() })
  afterAll(() => removeOffice(office))

  it('has a rule for every event type the server emits (none slips through unclassified)', () => {
    const rules = Object.keys(office.server.LAN_EVENT_RULES)
    for (const type of serverEventTypes()) {
      if (NOT_BROADCAST.has(type)) continue
      expect(rules, `no LAN rule for ${type}`).toContain(type)
    }
    // And the representative payloads below cover every rule
    expect(Object.keys(PAYLOADS).sort()).toEqual([...rules].sort())
  })

  it('no SECRET survives in any event type, nor any token', () => {
    for (const [type, payload] of Object.entries(PAYLOADS)) {
      const out = office.server.redactForLan(payload)
      const text = JSON.stringify(out) ?? ''
      expect(text, type).not.toContain(SECRET)
      expect(text).not.toContain(office.server.AUTH_TOKEN)
      expect(text).not.toContain(office.server.UI_TOKEN)
    }
  })

  it('keeps what the scene draws', () => {
    const r = (type: string) => office.server.redactForLan(PAYLOADS[type])
    expect(r('agent_spawned').agent).toEqual({ id: 'a1', name: 'Dev', role: 'frontend-developer', agentType: 'frontend-developer', background: false, state: 'working', spawnedAt: 1, lastActivityAt: 2, sessionId: SID, unread: 2 })
    expect(r('agent_working')).toEqual({ type: 'agent_working', agentId: 'a1', sessionId: SID, failed: true, timestamp: 1 })
    expect(r('agent_completed')).toEqual({ type: 'agent_completed', agentId: 'a1', sessionId: SID, tokens: 5, durationMs: 9, timestamp: 1 })
    expect(r('mcp_call')).toMatchObject({ server: 'github', tool: 'create_issue' })
    const started = r('session_started')
    expect(started).toMatchObject({ type: 'session_started', sessionId: SID, hooked: true, state: 'active', model: 'claude-opus', agentCount: 1, registry: { pid: 42, status: 'busy' } })
    expect(started.main).toEqual({ state: 'needs-you', since: 1, waitingOn: 0, crons: 0, promptId: 'p1', lastPromptAt: 1, lastReplyAt: 2, needsYou: { kind: 'permission', toolName: 'Bash', since: 1 }, error: { error: 'rate_limit', since: 1 } })
    for (const gone of ['project', 'cwd', 'title', 'transcriptPath', 'lastStatus']) expect(started, gone).not.toHaveProperty(gone)
    expect(r('session_needs_you')).toMatchObject({ kind: 'permission', toolName: 'Bash', needsYou: { kind: 'permission', toolName: 'Bash' } })
    expect(r('session_error').error).toBe('error')
    expect(r('session_turn_end').backgroundTasks).toEqual([{ id: 'b1', type: 'shell', status: 'running' }])
    expect(r('chat_message')).toEqual({ type: 'chat_message', id: 3, sender: 'Dev', role: 'frontend-developer', text: '', timestamp: 1, is_system: 0, recipient: 'Rev', msg_type: 'message', senderId: 'a1', recipientId: 'a2' })
    expect(r('permission_request').permission).toEqual({ id: 'perm1', sessionId: SID, toolName: 'Bash', permissionMode: 'default', createdAt: 1, deadline: 2, status: 'pending' })
    expect(r('signal')).toEqual({ type: 'signal', kind: 'test_failed', exitCode: 1, sessionId: SID, agentId: 'a1', agentName: 'Dev', at: 1, seq: 1, timestamp: 1 })
    expect(r('task_board').board).toEqual({ sessionId: SID, updatedAt: 1, counts: { pending: 1, in_progress: 1, completed: 0 }, tasks: [
      { id: '1', status: 'in_progress', blockedBy: [], owner: 'Dev', subject: '' }, { id: '2', status: 'pending', blockedBy: ['1'], subject: '' },
    ] })
    expect(r('variant_change')).toEqual(PAYLOADS.variant_change)
    expect(r('health')).toEqual(PAYLOADS.health)
    const snap = r('snapshot')
    expect(snap).not.toHaveProperty('statuses')
    expect(snap).not.toHaveProperty('uiToken')
    expect(snap.activeAgents[0]).toMatchObject({ id: 'a1', state: 'working' })
    expect(snap.sessions[0]).toMatchObject({ id: SID, state: 'active' })
    expect(snap.mcpServers).toEqual(['github'])
  })

  it('every LAN-shaped event goes through the page\'s reducers without throwing', async () => {
    const { reduceOffice, initialOfficeState } = await import('../src/officeReducer')
    const { reduceTaskBoards } = await import('../src/taskBoard')
    const env = { now: 1_000, live: true, computePath: () => [], random: () => 0.5 }
    let state = initialOfficeState([], 0)
    let boards = reduceTaskBoards({ boards: [], pinned: null, fx: null } as any, { type: 'task_board', boards: [] } as any, 0)
    for (const payload of Object.values(PAYLOADS)) {
      const action = office.server.redactForLan(payload)
      if (!action) continue
      state = reduceOffice(state, action, env).state
      if (action.type === 'task_board') boards = reduceTaskBoards(boards, action, 1)
    }
    expect(state.agents.some(a => a.id === 'a1')).toBe(true)
  })

  it('withholds the meters, transcript chat rows and unknown types', () => {
    expect(office.server.redactForLan(PAYLOADS.session_status)).toBeNull()
    expect(office.server.redactForLan(PAYLOADS.agent_status)).toBeNull()
    expect(office.server.redactForLan({ type: 'chat_message', id: 1, sender: 'Boss', text: 'x', msg_type: 'prompt' })).toBeNull()
    expect(office.server.redactForLan({ type: 'something_new', text: SECRET })).toBeNull()
    expect(office.server.redactForLan({ type: 'toString' })).toBeNull()
    expect(office.server.redactForLan(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The LAN listener, end to end (bound on 127.0.0.1 here and named as the LAN host)
// ---------------------------------------------------------------------------

const INDEX_HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>'

interface Client { ws: WebSocket; messages: Message[] }

/** Open a WebSocket and collect its messages; resolves on open, or with the close code when refused. */
function openWs(url: string, protocols: string[], headers: Record<string, string> = {}): Promise<{ client?: Client; code?: number; reason?: string }> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, protocols, { headers })
    const messages: Message[] = []
    let opened = false
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())))
    ws.on('open', () => {
      opened = true
      // A refused connection is accepted and closed at once: give the close a moment to land
      setTimeout(() => resolve(ws.readyState === WebSocket.OPEN ? { client: { ws, messages } } : {}), 100)
    })
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    ws.on('error', () => { if (!opened) resolve({ code: -1 }) })
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('the LAN listener', () => {
  let office: Office
  let uiDir: string
  let lan: { host: string; port: number; key: string; link: string }
  let base: string
  let wsUrl: string
  let loopbackUrl: string
  const sockets: WebSocket[] = []
  const viewerProtocols = (key: string) => ['agent-office', `${WS_VIEWER_PROTOCOL_PREFIX}${key}`]
  const origin = () => `http://127.0.0.1:${lan.port}`

  beforeAll(async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'agent-office-lan-ui-'))
    mkdirSync(join(uiDir, 'sprites'), { recursive: true })
    writeFileSync(join(uiDir, 'index.html'), INDEX_HTML)
    writeFileSync(join(uiDir, 'sprites', 'a.png'), 'png')
    writeFileSync(join(uiDir, '.env'), 'SECRET=1')
    office = await loadOffice({ env: { AGENT_OFFICE_UI_DIR: uiDir } })
    loopbackUrl = `ws://127.0.0.1:${await listen(office.server.httpServer)}/ws`
    lan = await office.server.startLan({ host: '127.0.0.1', port: 0 })
    base = `http://127.0.0.1:${lan.port}`
    wsUrl = `ws://127.0.0.1:${lan.port}/ws`
  })

  afterAll(async () => {
    for (const ws of sockets) ws.terminate()
    office.server.stopLan()
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
    rmSync(uiDir, { recursive: true, force: true })
  })

  it('the viewer key: 64 hex digits in a 0600 file, never the office token, and the link carries it', () => {
    expect(lan.key).toMatch(/^[0-9a-f]{64}$/)
    expect(lan.key).not.toBe(office.server.AUTH_TOKEN)
    expect(readFileSync(office.server.VIEWER_KEY_FILE, 'utf8')).toBe(lan.key)
    if (process.platform !== 'win32') expect(statSync(office.server.VIEWER_KEY_FILE).mode & 0o777).toBe(0o600)
    expect(lan.link).toBe(`http://127.0.0.1:${lan.port}/#viewer=${lan.key}`)
  })

  it('serves the built UI and its sprites', async () => {
    const page = await request(base).get('/')
    expect(page.status).toBe(200)
    expect(page.text).toBe(INDEX_HTML)
    expect((await request(base).get('/sprites/a.png')).status).toBe(200)
    expect((await request(base).head('/index.html')).status).toBe(200)
    expect((await request(base).get('/').set('Origin', origin())).status).toBe(200)
    // Dotfiles and traversal stay out
    expect((await request(base).get('/.env')).status).toBe(404)
    expect((await request(base).get('/../package.json')).status).toBe(404)
  })

  it('answers every API route 404, even with the office token', async () => {
    const bearer = `Bearer ${office.server.AUTH_TOKEN}`
    for (const path of ['/health', '/health?challenge=abc', '/config', '/roster', '/agents', '/agents/a1', '/sessions', '/tasks', '/signals', '/permissions',
      '/settings', '/status', '/registry', '/chat', '/chat/cron-state', '/a2a/agents', '/.well-known/agent-card.json', '/permission/x', '/ws']) {
      expect((await request(base).get(path).set('Authorization', bearer)).status, `GET ${path}`).toBe(404)
    }
    for (const path of ['/event', '/chat', '/chat/reply', '/settings', '/permission/x', '/a2a', '/status', '/chat/typing', '/chat/cron-state', '/']) {
      const res = await request(base).post(path).set('Authorization', bearer).set('Content-Type', 'application/json').send('{"type":"agent_spawned"}')
      expect(res.status, `POST ${path}`).toBe(404)
    }
    expect((await request(base).options('/event')).status).toBe(404)
    // ...and nothing reached the office
    expect(office.server.activeAgents.size).toBe(0)
  })

  it('refuses any other Host (421) or Origin (403)', async () => {
    for (const host of [`evil.example:${lan.port}`, '127.0.0.1', `127.0.0.1:${lan.port + 1}`, `localhost:${lan.port}`]) {
      expect((await request(base).get('/').set('Host', host)).status, host).toBe(421)
    }
    for (const bad of ['null', 'http://evil.example', `https://127.0.0.1:${lan.port}`, 'http://127.0.0.1:3334']) {
      expect((await request(base).get('/').set('Origin', bad)).status, bad).toBe(403)
    }
  })

  it('the WebSocket: no key, a wrong key or the office token is a 1008', async () => {
    expect((await openWs(wsUrl, ['agent-office'])).code).toBe(1008)
    expect((await openWs(wsUrl, viewerProtocols('0'.repeat(64)))).code).toBe(1008)
    expect((await openWs(wsUrl, viewerProtocols(lan.key.slice(0, 63)))).code).toBe(1008)
    expect((await openWs(wsUrl, officeProtocols(office.server))).code).toBe(1008)
    expect((await openWs(wsUrl, ['agent-office', `${WS_VIEWER_PROTOCOL_PREFIX}${office.server.AUTH_TOKEN}`])).code).toBe(1008)
  })

  it('the WebSocket: the right key from a wrong Host or Origin is a 1008 too', async () => {
    expect((await openWs(wsUrl, viewerProtocols(lan.key), { Host: `evil.example:${lan.port}` })).code).toBe(1008)
    expect((await openWs(wsUrl, viewerProtocols(lan.key), { Origin: 'http://evil.example' })).code).toBe(1008)
  })

  it('a viewer gets auth (never trusted), a snapshot without UI token or meters, and the stream without a SECRET', async () => {
    const opened = await openWs(wsUrl, viewerProtocols(lan.key), { Origin: origin() })
    const viewer = opened.client!
    sockets.push(viewer.ws)
    expect(viewer.ws.protocol).toBe('agent-office')
    expect(viewer.messages[0]).toEqual({ type: 'auth', trusted: false, viewer: true })
    expect(viewer.messages[1].type).toBe('snapshot')
    expect(viewer.messages[1]).not.toHaveProperty('uiToken')
    expect(viewer.messages[1]).not.toHaveProperty('statuses')

    // A trusted loopback page beside it, to prove the events did carry the text
    const trusted = (await openWs(loopbackUrl, officeProtocols(office.server))).client!
    sockets.push(trusted.ws)

    const S = { sessionId: SID, project: `${SECRET}proj`, cwd: `/Users/me/${SECRET}proj`, transcriptPath: `/x/${SECRET}/t.jsonl` }
    const { server } = office
    const events = [
      { type: 'session_started', ...S, source: 'startup', model: 'claude-opus', title: `${SECRET} title` },
      { type: 'session_prompt', ...S, promptId: 'p1', text: `${SECRET} prompt` },
      { type: 'agent_spawned', ...S, agent: { id: 'toolu_1', name: 'Dev', role: 'frontend-developer', task: `${SECRET} task` } },
      { type: 'agent_spawned', ...S, agent: { id: 'toolu_2', name: 'Rev', role: 'code-reviewer', task: `${SECRET} task 2` } },
      { type: 'agent_working', ...S, agentId: 'toolu_1', status: `running: ${SECRET}` },
      { type: 'agent_working', ...S, status: `editing ${SECRET}.ts`, signals: [{ kind: 'test_failed', target: `${SECRET}app`, detail: `${SECRET} 3`, error: `${SECRET} e`, command: `npm test ${SECRET}`, branch: `${SECRET}-b` }] },
      { type: 'session_needs_you', ...S, kind: 'permission', toolName: 'Bash', summary: `${SECRET} sum`, detail: `${SECRET} cmd`, answerable: true },
      { type: 'session_cwd', ...S, cwd: `/Users/me/${SECRET}other` },
      { type: 'session_error', ...S, error: 'rate_limit', detail: `${SECRET} detail` },
      { type: 'session_turn_end', ...S, text: `${SECRET} reply`, backgroundTasks: [{ id: 'b1', type: 'shell', status: 'running', description: `${SECRET} bg` }] },
      { type: 'mcp_call', ...S, server: 'github', tool: 'create_issue' },
      { type: 'agent_completed', ...S, agentId: 'toolu_2', result: `${SECRET} result` },
    ]
    for (const e of events) {
      expect((await postEvent(server, e)).status, e.type).toBe(200)
      // Why: session_needs_you is debounced (NEEDS_YOU_DEBOUNCE_MS, 300 ms) before it is broadcast
      if (e.type === 'session_needs_you') await sleep(400)
    }
    await request(server.app).post('/chat').send({ sender: 'Boss', text: `${SECRET} chat line` })
    await request(server.app).post('/chat').send({ sender: 'Boss', text: '/status' })
    await postAuthed(server, '/chat/reply', { sender: 'Dev', text: `${SECRET} directed`, recipient: 'Rev' })
    await postAuthed(server, '/status', { type: 'agent_status', sessionId: SID, agents: [{ id: 'toolu_1', tokens: 5, status: SECRET, description: SECRET }] })
    await sleep(300)

    const types = new Set(viewer.messages.map(m => m.type))
    for (const t of ['session_started', 'session_prompt', 'agent_spawned', 'agent_working', 'signal', 'permission_request', 'session_needs_you', 'session_cwd', 'session_error', 'session_turn_end', 'mcp_call', 'agent_completed', 'chat_message']) {
      expect(types, t).toContain(t)
    }
    expect(types).not.toContain('agent_status')
    const lanText = JSON.stringify(viewer.messages)
    expect(lanText).not.toContain(SECRET)
    expect(lanText).not.toContain(server.AUTH_TOKEN)
    expect(lanText).not.toContain(server.UI_TOKEN)
    expect(JSON.stringify(trusted.messages)).toContain(`${SECRET} prompt`)

    // A reconnecting viewer's snapshot is as clean
    const again = (await openWs(wsUrl, viewerProtocols(lan.key))).client!
    sockets.push(again.ws)
    const snap = again.messages.find(m => m.type === 'snapshot')!
    expect(snap.activeAgents.length).toBeGreaterThan(0)
    expect(JSON.stringify(again.messages)).not.toContain(SECRET)
  })

  it('the loopback listener is untouched: it still refuses the LAN host', async () => {
    expect((await request(office.server.app).get('/health').set('Host', `192.168.1.23:${lan.port}`)).status).toBe(421)
    expect((await request(office.server.app).get('/health')).status).toBe(200)
  })
})

describe('the viewer key file across restarts', () => {
  it('is reused when safe, replaced when loose or when it holds the office token', async () => {
    const first = await loadOffice()
    const a = await first.server.startLan({ host: '127.0.0.1', port: 0 })
    first.server.stopLan()
    const second = await loadOffice({ dir: first.dir })
    const b = await second.server.startLan({ host: '127.0.0.1', port: 0 })
    second.server.stopLan()
    expect(b.key).toBe(a.key)

    if (process.platform !== 'win32') {
      const { chmodSync } = await import('node:fs')
      chmodSync(second.server.VIEWER_KEY_FILE, 0o644)
      const third = await loadOffice({ dir: first.dir })
      const c = await third.server.startLan({ host: '127.0.0.1', port: 0 })
      third.server.stopLan()
      expect(c.key).not.toBe(a.key)
      expect(statSync(third.server.VIEWER_KEY_FILE).mode & 0o777).toBe(0o600)

      // Someone copied the office token into the viewer key file: never use it on the Wi-Fi
      writeFileSync(third.server.VIEWER_KEY_FILE, third.server.AUTH_TOKEN, { mode: 0o600 })
      const fourth = await loadOffice({ dir: first.dir })
      const d = await fourth.server.startLan({ host: '127.0.0.1', port: 0 })
      fourth.server.stopLan()
      expect(d.key).not.toBe(fourth.server.AUTH_TOKEN)
    }
    removeOffice(first)
  })
})

// ---------------------------------------------------------------------------
// AGENT_OFFICE_ALLOWED_HOSTS on the loopback listener
// ---------------------------------------------------------------------------

describe('AGENT_OFFICE_ALLOWED_HOSTS: the loopback guard behind tailscale serve', () => {
  let office: Office
  let port: number
  let uiDir: string
  const NAME = 'my-mac.tail1234.ts.net'
  const ORIGIN = `https://${NAME}`
  const bearer = () => `Bearer ${office.server.AUTH_TOKEN}`

  beforeAll(async () => {
    uiDir = mkdtempSync(join(tmpdir(), 'agent-office-ts-ui-'))
    mkdirSync(join(uiDir, 'sprites'), { recursive: true })
    writeFileSync(join(uiDir, 'index.html'), INDEX_HTML)
    writeFileSync(join(uiDir, 'sprites', 'a.png'), 'png')
    office = await loadOffice({ env: {
      AGENT_OFFICE_ALLOWED_HOSTS: `${NAME},*.ts.net,https://bad.ts.net,100.64.0.1,good.example.com:8443`,
      AGENT_OFFICE_UI_DIR: uiDir,
    } })
    port = await listen(office.server.httpServer)
  })

  afterAll(async () => {
    await new Promise<void>(res => office.server.wss.close(() => res()))
    await new Promise<void>(res => office.server.httpServer.close(() => res()))
    removeOffice(office)
    rmSync(uiDir, { recursive: true, force: true })
  })

  it('keeps only the valid entries', () => {
    expect(office.server.ALLOWED_HOSTS).toEqual([{ host: NAME, port: null }, { host: 'good.example.com', port: 8443 }])
    expect(office.server.isRemoteHost(NAME)).toBe(true)
    expect(office.server.isRemoteHost('127.0.0.1:3334')).toBe(false)
  })

  it('accepts the configured names as Host, and their https origins, with a token', async () => {
    const app = office.server.app
    expect((await request(app).get('/health').set('Host', NAME).set('Authorization', bearer())).status).toBe(200)
    expect((await request(app).get('/health').set('Host', 'good.example.com:8443').set('Authorization', bearer())).status).toBe(200)
    expect((await request(app).get('/health').set('Host', NAME).set('Origin', ORIGIN).set('Authorization', bearer())).status).toBe(200)
    expect((await request(app).get('/health').set('Host', 'good.example.com:8443').set('Origin', 'https://good.example.com:8443').set('Authorization', bearer())).status).toBe(200)
    // The UI token (what the page holds after its snapshot) opens them too
    expect((await request(app).get('/agents').set('Host', NAME).set('Authorization', `Bearer ${office.server.UI_TOKEN}`)).status).toBe(200)
    expect(office.server.isAllowedOrigin(ORIGIN)).toBe(true)
  })

  it('through the proxy name every route but the static UI needs a token (401)', async () => {
    const app = office.server.app
    for (const path of ['/health', '/agents', '/sessions', '/roster', '/config', '/chat', '/signals', '/tasks', '/registry', '/settings', '/permissions', '/chat/cron-state', '/status', '/.well-known/agent-card.json', '/nope']) {
      expect((await request(app).get(path).set('Host', NAME)).status, `GET ${path}`).toBe(401)
      expect((await request(app).get(path).set('Host', NAME).set('Authorization', 'Bearer wrong')).status, `GET ${path} wrong`).toBe(401)
    }
    const line = await request(app).post('/chat').set('Host', NAME).set('Origin', ORIGIN).send({ sender: 'x', text: 'hi from the tailnet' })
    expect(line.status).toBe(401)
    expect((await request(app).post('/chat/typing').set('Host', NAME).send({ sender: 'x' })).status).toBe(401)
    expect((await request(app).options('/chat').set('Host', NAME)).status).toBe(401)
    // The built UI's files load without one, so the page can start and read #token=
    expect((await request(app).get('/').set('Host', NAME)).text).toBe(INDEX_HTML)
    expect((await request(app).get('/sprites/a.png').set('Host', NAME)).status).toBe(200)
    // With the token the same routes answer
    expect((await request(app).get('/agents').set('Host', NAME).set('Authorization', bearer())).status).toBe(200)
    expect((await request(app).post('/chat').set('Host', NAME).set('Origin', ORIGIN).set('Authorization', `Bearer ${office.server.UI_TOKEN}`).send({ sender: 'x', text: 'hi' })).status).toBe(200)
  })

  it('loopback is unchanged: the open routes stay open there', async () => {
    const app = office.server.app
    for (const path of ['/health', '/agents', '/sessions', '/roster', '/config', '/tasks']) {
      expect((await request(app).get(path)).status, path).toBe(200)
    }
    expect((await request(app).post('/chat/typing').send({ sender: 'x' })).status).toBe(200)
  })

  it('a loopback Host through the proxy is still remote: serve\'s forwarding headers mark it', async () => {
    const app = office.server.app
    const markers: Array<[string, string]> = [
      ['X-Forwarded-For', '100.101.102.103'], ['X-Forwarded-Host', 'localhost'], ['X-Forwarded-Proto', 'https'],
      ['Forwarded', 'for=100.101.102.103'], ['Tailscale-User-Login', 'someone@example.com'], ['Tailscale-User-Name', 'Someone'],
    ]
    for (const host of ['localhost', '127.0.0.1:3334', '[::1]']) {
      for (const [name, value] of markers) {
        for (const path of ['/agents', '/sessions', '/health']) {
          expect((await request(app).get(path).set('Host', host).set(name, value)).status, `${host} ${name} ${path}`).toBe(401)
        }
        expect((await request(app).post('/chat').set('Host', host).set(name, value).send({ sender: 'x', text: 'hi' })).status).toBe(401)
        expect((await request(app).get('/agents').set('Host', host).set(name, value).set('Authorization', bearer())).status).toBe(200)
        expect((await request(app).get('/').set('Host', host).set(name, value)).status).toBe(200)
      }
    }
    // The peer address too: anything not on loopback is remote
    const fake = (remoteAddress: string, headers: Record<string, string> = { host: 'localhost' }) => ({ headers, socket: { remoteAddress } }) as any
    expect(office.server.isRemoteRequest(fake('127.0.0.1'))).toBe(false)
    expect(office.server.isRemoteRequest(fake('::ffff:127.0.0.1'))).toBe(false)
    expect(office.server.isRemoteRequest(fake('::1'))).toBe(false)
    expect(office.server.isRemoteRequest(fake('100.101.102.103'))).toBe(true)
    expect(office.server.isRemoteRequest(fake('192.168.1.5'))).toBe(true)
  })

  it('the WebSocket with serve\'s markers and no token is refused, whatever the Host', async () => {
    const url = `ws://127.0.0.1:${port}/ws`
    for (const extra of [{ 'X-Forwarded-For': '100.101.102.103' }, { 'Tailscale-User-Login': 'someone@example.com' }, { 'X-Forwarded-Host': 'localhost' }]) {
      expect((await openWs(url, ['agent-office'], { Host: 'localhost', ...extra })).code, JSON.stringify(extra)).toBe(1008)
      const trusted = (await openWs(url, officeProtocols(office.server), { Host: 'localhost', ...extra })).client!
      expect(trusted.messages[0]).toEqual({ type: 'auth', trusted: true })
      trusted.ws.terminate()
    }
  })

  it('refuses Tailscale Funnel requests outright, on any Host', async () => {
    const app = office.server.app
    expect((await request(app).get('/').set('Host', NAME).set('Tailscale-Funnel-Request', '?1')).status).toBe(403)
    expect((await request(app).get('/health').set('Host', NAME).set('Tailscale-Funnel-Request', '?1').set('Authorization', bearer())).status).toBe(403)
    expect((await request(app).get('/health').set('Tailscale-Funnel-Request', '?1')).status).toBe(403)
  })

  it('still refuses everything else', async () => {
    const app = office.server.app
    for (const host of ['evil.ts.net', 'bad.ts.net', '100.64.0.1', `${NAME}:3334`, 'good.example.com', `${NAME}.evil.com`]) {
      expect((await request(app).get('/health').set('Host', host).set('Authorization', bearer())).status, host).toBe(421)
    }
    for (const origin of [`http://${NAME}`, 'https://evil.ts.net', `${ORIGIN}:444`, 'https://good.example.com']) {
      expect((await request(app).get('/health').set('Host', NAME).set('Origin', origin).set('Authorization', bearer())).status, origin).toBe(403)
    }
  })

  it('the WebSocket through the proxy name needs the office token; no read-only tier there', async () => {
    const url = `ws://127.0.0.1:${port}/ws`
    const headers = { Host: NAME, Origin: ORIGIN }
    expect((await openWs(url, ['agent-office'], headers)).code).toBe(1008)
    expect((await openWs(url, ['agent-office', `agent-office.token.${'0'.repeat(64)}`], headers)).code).toBe(1008)
    expect((await openWs(url, ['agent-office', `agent-office.token.${office.server.UI_TOKEN}`], headers)).code).toBe(1008)
    expect((await openWs(url, officeProtocols(office.server), { ...headers, 'Tailscale-Funnel-Request': '?1' })).code).toBe(1008)
    const trusted = (await openWs(url, officeProtocols(office.server), headers)).client!
    expect(trusted.messages[0]).toEqual({ type: 'auth', trusted: true })
    trusted.ws.terminate()
    expect((await openWs(url, ['agent-office'], { Host: 'evil.ts.net' })).code).toBe(1008)
    expect((await openWs(url, officeProtocols(office.server), { Host: NAME, Origin: 'https://evil.ts.net' })).code).toBe(1008)
    // Loopback keeps its read-only tier
    const local = (await openWs(url, ['agent-office'])).client!
    expect(local.messages[0]).toEqual({ type: 'auth', trusted: false })
    local.ws.terminate()
  })
})
