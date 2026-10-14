/**
 * useAgentSocket — React hook for the Agent Office WebSocket connection.
 *
 * Connects to ws://localhost:3334/ws, receives real-time agent events from the
 * Claude Code hook pipeline, and exposes them to the React tree.
 *
 * Features:
 *  - Auto-reconnect with exponential back-off (capped at 30 s)
 *  - Returns events as they arrive via onEvent callback style AND as a state array
 *  - Exposes `connected` boolean and `mcpServers` roster
 *  - Tracks the Claude Code sessions (one per terminal) from the snapshot and
 *    session_started / session_ended events, exposed as `sessions`
 *  - Gracefully falls back to mock/offline mode when the server is unavailable
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { OfficeEvent, SessionInfo } from '../types'
import type { SessionStatus, MeterTotals } from '../meters'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSocketOptions {
  /** Called for every incoming event. Stable reference recommended (useCallback). */
  onEvent?: (event: OfficeEvent) => void
  /** WebSocket URL — defaults to ws://localhost:3334/ws */
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
}

// ---------------------------------------------------------------------------
// Server snapshot message (sent on first connect)
// ---------------------------------------------------------------------------

interface SnapshotMessage {
  type: 'snapshot'
  activeAgents: Array<{
    id: string
    name: string
    role: string
    task?: string
    state: string
    unread?: number
    sessionId?: string
    project?: string
  }>
  sessions?: Array<SessionInfo & { agentIds?: string[]; agentCount?: number }>
  /** Payroll / electricity / memory: the server's status store (server/status.js) */
  statuses?: { sessions: SessionStatus[]; totals: MeterTotals }
  mcpServers: string[]
  timestamp: number
}

type ServerMessage = OfficeEvent | SnapshotMessage

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WS_URL         = 'ws://localhost:3334/ws'
const ROSTER_URL     = 'http://localhost:3334/roster'
const MAX_EVENTS     = 50
const BACKOFF_INITIAL = 500   // ms
const BACKOFF_MAX    = 30_000 // ms
const BACKOFF_FACTOR = 2
// An ended session's pill lingers this long before it is dropped
const ENDED_SESSION_LINGER_MS = 10_000

/** The session fields of a session_started/session_ended event or snapshot entry. */
function toSessionInfo(id: string, src: Partial<SessionInfo>, prev?: SessionInfo): SessionInfo {
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
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useAgentSocket(options: AgentSocketOptions = {}): AgentSocketResult {
  const {
    onEvent,
    url     = WS_URL,
    disabled = false,
  } = options

  const [connected, setConnected]   = useState(false)
  const [mcpServers, setMcpServers] = useState<string[]>([])
  const [events, setEvents]         = useState<OfficeEvent[]>([])
  const [offline, setOffline]       = useState(false)
  const [sessions, setSessions]     = useState<SessionInfo[]>([])

  // Refs so reconnect logic can read latest values without re-creating effects
  const wsRef          = useRef<WebSocket | null>(null)
  const retryCountRef  = useRef(0)
  const retryTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef     = useRef(true)
  const onEventRef     = useRef(onEvent)

  useEffect(() => { onEventRef.current = onEvent }, [onEvent])

  // ---------------------------------------------------------------------------
  // Roster fetch (runs once on mount; refreshes after reconnect)
  // ---------------------------------------------------------------------------
  const fetchRoster = useCallback(async () => {
    try {
      const res = await fetch(ROSTER_URL, { signal: AbortSignal.timeout(2000) })
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
  const upsertSession = useCallback((id: string, src: Partial<SessionInfo>) => {
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
        upsertSession(id, { ...msg, state: 'active', reason: undefined })
        return
      case 'session_ended':
        upsertSession(id, { ...msg, state: 'ended' })
        dropSessionLater(id)
        return
      case 'agent_working':
        // Main-thread activity (no agentId) is the session's own status
        if (!msg.agentId) upsertSession(id, { project: msg.project, lastStatus: msg.status, lastStatusAt: msg.timestamp ?? Date.now() })
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

    if (msg.type === 'snapshot') {
      const snap = msg as SnapshotMessage
      if (snap.mcpServers?.length) {
        setMcpServers(snap.mcpServers)
      }
      // The server's session list replaces ours (a reconnect may have missed ends)
      const snapSessions = (snap.sessions ?? []).filter(s => s?.id)
      setSessions(snapSessions.map(s => toSessionInfo(s.id, s)))
      for (const s of snapSessions) if (s.state === 'ended') dropSessionLater(s.id)
      // The server's status store replaces ours too (a restart forgets sessions)
      if (snap.statuses) {
        pushEvent({ type: 'session_status', statuses: snap.statuses.sessions ?? [], totals: snap.statuses.totals })
      }
      // Emit synthetic spawn events for agents that were already active
      for (const agent of snap.activeAgents ?? []) {
        const event: OfficeEvent = {
          type: 'agent_spawned',
          agent: {
            id:   agent.id,
            name: agent.name,
            role: agent.role,
            task: agent.task,
            sessionId: agent.sessionId,
            project: agent.project,
          },
        }
        pushEvent(event)
        if (agent.unread) {
          pushEvent({ type: 'inbox_update', agentId: agent.id, unread: agent.unread })
        }
      }
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
      ws = new WebSocket(url)
    } catch {
      // WebSocket constructor itself threw — schedule retry
      scheduleReconnect()
      return
    }

    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      retryCountRef.current = 0
      setConnected(true)
      setOffline(false)
      fetchRoster()
    }

    ws.onmessage = (evt) => {
      if (!mountedRef.current) return
      handleMessage(evt.data)
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setConnected(false)
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

  return { connected, mcpServers, events, offline, sessions }
}
