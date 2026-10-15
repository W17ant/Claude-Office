/**
 * useAgentSocket — React hook for the Agent Office WebSocket connection.
 *
 * Connects to the office server's /ws (officeWsUrl: the page's own origin
 * when the server serves the page, the configured port under Vite), receives
 * real-time agent events from the Claude Code hook pipeline, and exposes
 * them to the React tree.
 *
 * Features:
 *  - Auto-reconnect with exponential back-off (capped at 30 s)
 *  - Returns events as they arrive via onEvent callback style AND as a state array
 *  - Exposes `connected` boolean and `mcpServers` roster
 *  - Tracks the Claude Code sessions (one per terminal) from the snapshot and
 *    session_started / session_ended events, exposed as `sessions`
 *  - Gracefully falls back to mock/offline mode when the server is unavailable
 *  - Reports its own open/close to onEvent as `connection` actions, and the
 *    snapshot's `health` as a `health` event, so the office reducer (not this
 *    hook) owns the connection state the status strip shows
 *  - Presents the office token (src/officeToken.ts) as a subprotocol on every
 *    (re)connect, read afresh each time, and exposes the server's verdict as
 *    `trusted`: without the token the server sends the office read-only (no
 *    conversation text, no UI token), and the page says so
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { OfficeEvent, PendingPermission, ServerHealth, SessionInfo, SessionRegistry, SnapshotAgent } from '../types'
import type { SessionStatus, MeterTotals } from '../meters'
import type { TaskBoardInfo } from '../taskBoard'
import { projectFromCwd } from '../mainState'
import { officeHttpBase, officeWsUrl } from '../serverUrl'
import { officeWsProtocols } from '../officeToken'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSocketOptions {
  /** Called for every incoming event. Stable reference recommended (useCallback). */
  onEvent?: (event: OfficeEvent) => void
  /** WebSocket URL — defaults to officeWsUrl() (src/serverUrl.ts) */
  url?: string
  /** Disable connection entirely (mock mode). Defaults to false. */
  disabled?: boolean
}

export interface AgentSocketResult {
  /** Whether the WebSocket is currently open */
  connected: boolean
  /** MCP server names discovered by the server (from ~/.claude/settings.json) */
  mcpServers: string[]
  /** Last N events received (capped at 50) */
  events: OfficeEvent[]
  /** True if the server has never been reachable since mount */
  offline: boolean
  /** Claude Code sessions the server knows about (ended ones linger briefly) */
  sessions: SessionInfo[]
  /**
   * The server's `auth` message: true when this page's token was accepted,
   * false when the office is shown read-only, null until a server says
   * (an older server never does)
   */
  trusted: boolean | null
}

// ---------------------------------------------------------------------------
// Server snapshot message (sent on first connect)
// ---------------------------------------------------------------------------

interface SnapshotMessage {
  type: 'snapshot'
  activeAgents: SnapshotAgent[]
  sessions?: Array<SessionInfo & { agentIds?: string[]; agentCount?: number }>
  /** Payroll / electricity / memory: the server's status store (server/status.js) */
  statuses?: { sessions: SessionStatus[]; totals: MeterTotals }
  /** Permission dialogs waiting on the office, and the token that answers them (server/permissions.js) */
  pendingPermissions?: PendingPermission[]
  /** Only on a trusted connection (one that presented the office token) */
  uiToken?: string
  /** Pipeline health: hooks seen, version, uptime (server/health.js) */
  health?: ServerHealth
  /** Each session's task board, no descriptions (server/tasks.js) */
  taskBoards?: TaskBoardInfo[]
  mcpServers: string[]
  timestamp: number
}

/** First message on every connection: what this connection may see (server/index.js). */
interface AuthMessage {
  type: 'auth'
  trusted: boolean
}

type ServerMessage = OfficeEvent | SnapshotMessage | AuthMessage

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS     = 50
const BACKOFF_INITIAL = 500   // ms
const BACKOFF_MAX    = 30_000 // ms
const BACKOFF_FACTOR = 2
// A connection counts as healthy (back-off resets) once it has delivered the
// server's snapshot, or has simply stayed open this long. A server that
// completes the handshake and closes straight away (origin rejected, 1008)
// therefore keeps backing off instead of being hammered every 500 ms.
const STABLE_OPEN_MS = 5_000
// An ended session's pill lingers this long before it is dropped
const ENDED_SESSION_LINGER_MS = 10_000

/**
 * The session fields of a session_started/session_ended/session_registry
 * event or snapshot entry. Those three carry the whole record, so a missing
 * `registry` there means the entry is gone: the caller passes `registry: null`
 * to clear it, while a partial update (undefined) keeps what we had.
 */
type SessionPatch = Omit<Partial<SessionInfo>, 'registry'> & { registry?: SessionRegistry | null }

function toSessionInfo(id: string, src: SessionPatch, prev?: SessionInfo): SessionInfo {
  return {
    ...prev,
    id,
    project:        src.project        ?? prev?.project,
    cwd:            src.cwd            ?? prev?.cwd,
    title:          src.title          ?? prev?.title,
    model:          src.model          ?? prev?.model,
    source:         src.source         ?? prev?.source,
    state:          src.state          ?? prev?.state ?? 'active',
    reason:         src.reason         ?? prev?.reason,
    startedAt:      src.startedAt      ?? prev?.startedAt,
    lastActivityAt: src.lastActivityAt ?? prev?.lastActivityAt,
    lastStatus:     src.lastStatus     ?? prev?.lastStatus,
    lastStatusAt:   src.lastStatusAt   ?? prev?.lastStatusAt,
    main:           src.main           ?? prev?.main,
    hooked:         src.hooked         ?? prev?.hooked,
    registry:       src.registry === null ? undefined : (src.registry ?? prev?.registry),
  }
}

/** A full-record event as a patch: a `registry` the server left out is one that has gone (the event's own `id` is a chat row id, not the session's). */
function fullRecord(msg: OfficeEvent, sessionId: string): SessionPatch {
  return { ...msg, id: sessionId, registry: msg.registry ?? null }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSocket(options: AgentSocketOptions = {}): AgentSocketResult {
  const {
    onEvent,
    url     = officeWsUrl(),
    disabled = false,
  } = options

  const [connected, setConnected]   = useState(false)
  const [mcpServers, setMcpServers] = useState<string[]>([])
  const [events, setEvents]         = useState<OfficeEvent[]>([])
  const [offline, setOffline]       = useState(false)
  const [sessions, setSessions]     = useState<SessionInfo[]>([])
  const [trusted, setTrusted]       = useState<boolean | null>(null)

  // Refs so reconnect logic can read latest values without re-creating effects
  const wsRef          = useRef<WebSocket | null>(null)
  const retryCountRef  = useRef(0)
  const retryTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef     = useRef(true)
  const onEventRef     = useRef(onEvent)

  const clearStableTimer = () => {
    if (stableTimerRef.current) {
      clearTimeout(stableTimerRef.current)
      stableTimerRef.current = null
    }
  }

  useEffect(() => { onEventRef.current = onEvent }, [onEvent])

  // ---------------------------------------------------------------------------
  // Roster fetch (runs once on mount; refreshes after reconnect)
  // ---------------------------------------------------------------------------
  const fetchRoster = useCallback(async () => {
    try {
      const res = await fetch(`${officeHttpBase()}/roster`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) return
      const data = await res.json()
      if (mountedRef.current && Array.isArray(data.mcpServers)) {
        setMcpServers(data.mcpServers)
      }
    } catch {
      // Server not reachable — roster will come via snapshot message
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Push an event into the local events array and call the onEvent callback
  // ---------------------------------------------------------------------------
  const pushEvent = useCallback((event: OfficeEvent) => {
    setEvents(prev => [...prev.slice(-(MAX_EVENTS - 1)), event])
    onEventRef.current?.(event)
  }, [])

  // ---------------------------------------------------------------------------
  // Session bookkeeping — one entry per Claude Code terminal
  // ---------------------------------------------------------------------------
  const upsertSession = useCallback((id: string, src: SessionPatch) => {
    setSessions(prev => {
      const existing = prev.find(s => s.id === id)
      const next = toSessionInfo(id, src, existing)
      return existing ? prev.map(s => (s.id === id ? next : s)) : [...prev, next]
    })
  }, [])

  const dropSessionLater = useCallback((id: string) => {
    setTimeout(() => {
      if (!mountedRef.current) return
      // Only drop it if it is still ended (a resume brings the same id back)
      setSessions(prev => prev.filter(s => s.id !== id || s.state !== 'ended'))
    }, ENDED_SESSION_LINGER_MS)
  }, [])

  const trackSession = useCallback((msg: OfficeEvent) => {
    const id = msg.sessionId
    if (!id) return
    switch (msg.type) {
      case 'session_started':
        upsertSession(id, { ...fullRecord(msg, id), state: 'active', reason: undefined })
        return
      case 'session_ended':
        upsertSession(id, { ...fullRecord(msg, id), state: 'ended' })
        dropSessionLater(id)
        return
      // The session's registry entry changed: status, name, attached to a hooked
      // session, or gone (an unhooked session's state comes from it)
      case 'session_registry':
        upsertSession(id, fullRecord(msg, id))
        return
      case 'agent_working':
        // Main-thread activity (no agentId) is the session's own status
        if (!msg.agentId) upsertSession(id, { project: msg.project, lastStatus: msg.status, lastStatusAt: msg.timestamp ?? Date.now() })
        return
      // The turn events: the pill's title / project / model follow them, and every
      // session_* broadcast refreshes the server's main-thread record
      case 'session_prompt':
        upsertSession(id, { project: msg.project, title: msg.title, main: msg.main })
        return
      case 'session_cwd':
        upsertSession(id, { cwd: msg.cwd, project: msg.project ?? projectFromCwd(msg.cwd), main: msg.main })
        return
      case 'session_model':
        upsertSession(id, { model: msg.model, main: msg.main })
        return
      case 'session_turn_end':
      case 'session_needs_you':
      case 'session_error':
      case 'session_compact':
      case 'session_main':
      case 'session_tool_done':
        if (msg.main) upsertSession(id, { main: msg.main })
        return
      default:
        return
    }
  }, [upsertSession, dropSessionLater])

  // ---------------------------------------------------------------------------
  // Process a raw message from the WebSocket
  // ---------------------------------------------------------------------------
  const handleMessage = useCallback((raw: string) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'auth') {
      setTrusted((msg as AuthMessage).trusted === true)
      return
    }

    if (msg.type === 'snapshot') {
      const snap = msg as SnapshotMessage
      // The session is healthy: the next drop starts the back-off from scratch
      retryCountRef.current = 0
      clearStableTimer()
      if (snap.mcpServers?.length) {
        setMcpServers(snap.mcpServers)
      }
      // The server's session list replaces ours (a reconnect may have missed ends)
      const snapSessions = (snap.sessions ?? []).filter(s => s?.id)
      setSessions(snapSessions.map(s => toSessionInfo(s.id, { ...s, registry: s.registry ?? null })))
      for (const s of snapSessions) if (s.state === 'ended') dropSessionLater(s.id)
      // The server's status store replaces ours too (a restart forgets sessions)
      if (snap.statuses) {
        pushEvent({ type: 'session_status', statuses: snap.statuses.sessions ?? [], totals: snap.statuses.totals })
      }
      // The server's pipeline health (hooks seen, version, uptime) for the status strip
      if (snap.health) {
        pushEvent({ type: 'health', health: snap.health, timestamp: snap.timestamp })
      }
      // The task boards replace ours as a whole (left alone by a server without them)
      if (Array.isArray(snap.taskBoards)) {
        pushEvent({ type: 'task_board', boards: snap.taskBoards, timestamp: snap.timestamp })
      }
      // The whole roster goes to the office as one event, so it can reconcile:
      // agents that completed or timed out while we were disconnected leave,
      // agents still here are refreshed in place, new ones walk in (C35). The
      // sessions ride along so the office seats a Claude per terminal, in the
      // state the server's main record says.
      pushEvent({
        type: 'snapshot',
        activeAgents: snap.activeAgents ?? [],
        sessions: snapSessions.map(s => toSessionInfo(s.id, s)),
        // The pending permission dialogs and the UI token ride along for
        // src/permissions.ts (the token is left undefined on a read-only
        // connection, and both by a server without them)
        pendingPermissions: snap.pendingPermissions,
        uiToken: snap.uiToken,
        timestamp: snap.timestamp,
      })
      return
    }

    // Regular office event
    trackSession(msg as OfficeEvent)
    pushEvent(msg as OfficeEvent)
  }, [pushEvent, trackSession, dropSessionLater])

  // ---------------------------------------------------------------------------
  // Connect / reconnect logic
  // ---------------------------------------------------------------------------
  const connect = useCallback(() => {
    if (!mountedRef.current || disabled) return

    // Clean up any existing socket
    if (wsRef.current) {
      wsRef.current.onopen    = null
      wsRef.current.onmessage = null
      wsRef.current.onclose   = null
      wsRef.current.onerror   = null
      try { wsRef.current.close() } catch { /* ignore */ }
      wsRef.current = null
    }

    let ws: WebSocket
    try {
      // The token is read at each attempt: one captured in another tab since
      // the last try (a new link after a rotation) is used at once
      ws = new WebSocket(url, officeWsProtocols())
    } catch {
      // WebSocket constructor itself threw — schedule retry
      scheduleReconnect()
      return
    }

    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      // Not a reset yet: an accept-then-close server must keep backing off (C33)
      clearStableTimer()
      stableTimerRef.current = setTimeout(() => {
        stableTimerRef.current = null
        if (mountedRef.current && wsRef.current === ws) retryCountRef.current = 0
      }, STABLE_OPEN_MS)
      setConnected(true)
      setOffline(false)
      // The office reducer keeps the connection phase (status strip); not a server event, so not in `events`
      onEventRef.current?.({ type: 'connection', socket: 'open', timestamp: Date.now() })
      fetchRoster()
    }

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return
      handleMessage(evt.data)
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      clearStableTimer()
      setConnected(false)
      onEventRef.current?.({ type: 'connection', socket: 'closed', timestamp: Date.now() })
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onerror is always followed by onclose — let onclose handle retry
      if (retryCountRef.current === 0) {
        // First failure: mark as offline
        setOffline(true)
      }
    }
  }, [url, disabled, fetchRoster, handleMessage])

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current || disabled) return

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
    }

    const delay = Math.min(
      BACKOFF_INITIAL * Math.pow(BACKOFF_FACTOR, retryCountRef.current),
      BACKOFF_MAX
    )
    retryCountRef.current += 1

    retryTimerRef.current = setTimeout(() => {
      if (mountedRef.current && !disabled) {
        connect()
      }
    }, delay)
  }, [connect, disabled])

  // ---------------------------------------------------------------------------
  // Mount / unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    mountedRef.current = true

    if (!disabled) {
      connect()
    }

    return () => {
      mountedRef.current = false

      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      clearStableTimer()

      if (wsRef.current) {
        wsRef.current.onopen    = null
        wsRef.current.onmessage = null
        wsRef.current.onclose   = null
        wsRef.current.onerror   = null
        try { wsRef.current.close() } catch { /* ignore */ }
        wsRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  return { connected, mcpServers, events, offline, sessions, trusted }
}
