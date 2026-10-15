import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react'
import './styles/office.css'
import './styles/rooms.css'
import './styles/incident.css'
import './styles/meters.css'
import SlackChat, { ChatMessage, getAvatarSrc } from './components/SlackChat'
import Character from './components/Character'
import FurnitureRenderer from './components/FurnitureRenderer'
import SessionStrip from './components/SessionStrip'
import Meters from './components/Meters'
import AgentCard from './components/AgentCard'
import PermissionCards from './components/PermissionCard'
import { isPermissionEvent, reducePermissions, setUiToken, type PermissionAction, type PermissionCardState } from './permissions'
import StatusStrip from './components/StatusStrip'
import { Agent, AGENT_CONFIGS } from './types'
import { getCurrentPhase, getPhaseLabel, type DayPhase } from './daylight'
import { useAgentSocket } from './hooks/useAgentSocket'
import { dispatchMeters } from './meters'
import * as sfx from './sounds'
import { findWaypointPath } from './agentManager'
import {
  reduceOffice, stepOffice, initialOfficeState,
  moveAgentsForEvent, returnAgentsFromEvent, pickSingleEventAgent,
  MAIN_ROOM, BOSS_ID, CLAUDE_ID, CLAUDE_ROLE,
  type OfficeState, type OfficeAction, type OfficeEffect, type OfficeEnv,
} from './officeReducer'
import { BOSS_ROLE } from './config'
import { officeHttpBase, officeWsUrl } from './serverUrl'
import { pickEvent } from './events'
import { getInteraction } from './interactions'
import {
  useTheme, getRoomImage, getAngelaCat, getTheme, themedDisplayName,
  OFFICE_SIM_TOOL_MESSAGES, OFFICE_SIM_BOSS_PROMPTS,
  assignCharacterToRole, releaseRole, nextUnusedOfficeCharacter, displayNameFromSlug,
} from './theme'
import {
  dispatchIncident, subscribeIncidentTransitions, incidentTransitionLines,
  useVariant, getIncident, pinIncidentFromUrl, failureToolFromStatus, signalIncidentInput,
} from './incident'
import IncidentLayer from './components/IncidentLayer'

// ---------------------------------------------------------------------------
// Placement helper — loaded via ?helper query param
// ---------------------------------------------------------------------------
const PlacementHelper = lazy(() => import('./components/PlacementHelper'))
const params = new URLSearchParams(window.location.search)
const isHelperMode = params.has('helper')
const isSimMode = params.has('sim') || params.has('video')
const isVideoMode = params.has('video')
// Why: allow ?theme=office on demo/sim URLs to preload Dunder Mifflin mode
import { setTheme as _setTheme } from './theme'
if (params.get('theme') === 'office') { _setTheme('office') }
// Why: ?variant=incident pins incident mode on (auto-exit off) for screenshots
if (params.get('variant') === 'incident') { pinIncidentFromUrl() }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeNow(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// Local-only chat rows (clock-ins, break lines, the boss's own post before the
// server echoes it) get negative ids so they never collide with the server's
// chat row ids, which chat_reaction / chat_seen refer to (C34).
let nextMsgId = 1
function makeMsgId() { return -(nextMsgId++) }

// Waypoints for the main office
const MAIN_WAYPOINTS = MAIN_ROOM.waypoints ?? []

/**
 * Compute a pathQueue from one position to another using the main-office
 * waypoint graph.  Returns an array of intermediate {x,y} steps — the agent
 * should walk through each in order, then continue straight to targetPosition.
 */
function computePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] {
  if (MAIN_WAYPOINTS.length === 0) {
    console.warn('[pathfinding] No waypoints loaded!')
    return []
  }
  const path = findWaypointPath(from.x, from.y, to.x, to.y, MAIN_WAYPOINTS)
  console.log(`[pathfinding] from (${from.x.toFixed(1)},${from.y.toFixed(1)}) to (${to.x.toFixed(1)},${to.y.toFixed(1)}) → ${path.length} waypoints`, path)
  return path
}

// The boss — always in the office, permanent desk (spot-1)
const BOSS_SPOT = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-1') ?? MAIN_ROOM.agentSpots.find(s => s.type === 'desk') ?? null

function createBoss(): Agent {
  const cfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
  const spot = BOSS_SPOT ?? { id: 'spot-temp', type: 'desk' as const, x: 28.9, y: 66 }
  const entry = MAIN_ROOM.entryPoint
  const target = { x: spot.x, y: spot.y }
  return {
    id: BOSS_ID,
    name: cfg.title,
    type: 'subagent',
    role: BOSS_ROLE,
    state: 'new-hire',
    position: { x: entry.x, y: entry.y },
    targetPosition: target,
    deskPosition: target,
    room: 'main-office',
    assignedRoom: 'main-office',
    assignedSpotId: spot.id,
    spriteFacing: spot.spriteFacing,
    task: 'Running the show',
    statusText: 'clocked in',
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: Date.now(),
    pathQueue: computePath(entry, target),
  }
}

// Claude — the assistant, always in the office at spot-2
const CLAUDE_SPOT = MAIN_ROOM.agentSpots.find(s => s.id === 'spot-2') ?? null

function createClaude(): Agent {
  const cfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
  const spot = CLAUDE_SPOT ?? { id: 'spot-2', type: 'desk' as const, x: 37.9, y: 68.2, spriteFacing: 'rear-right' as const }
  const entry = MAIN_ROOM.entryPoint
  const target = { x: spot.x, y: spot.y }
  return {
    id: CLAUDE_ID,
    name: cfg.title,
    type: 'subagent',
    role: CLAUDE_ROLE,
    state: 'new-hire',
    position: { x: entry.x, y: entry.y },
    targetPosition: target,
    deskPosition: target,
    room: 'main-office',
    assignedRoom: 'main-office',
    assignedSpotId: spot.id,
    spriteFacing: spot.spriteFacing,
    task: 'Office assistant',
    statusText: 'clocked in',
    color: cfg.color,
    emoji: cfg.emoji,
    hiredAt: Date.now() + 500, // arrives just after the boss
    pathQueue: computePath(entry, target),
  }
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cinematic simulation data — realistic agent activity for screen recording
// ---------------------------------------------------------------------------
const SIM_SCENARIOS = [
  {
    role: 'security-auditor',
    task: 'Auditing auth middleware for session token vulnerabilities',
    slackMessages: [
      '🔍 scanning auth middleware...',
      '⚠️ found session tokens stored in localStorage — flagging',
      '🔐 checking CORS configuration on API endpoints',
      '📋 reviewing JWT expiry and refresh flow',
      '✅ auth audit complete — 2 issues found, PRs drafted',
    ],
  },
  {
    role: 'frontend-developer',
    task: 'Building responsive dashboard with real-time charts',
    slackMessages: [
      '🎨 scaffolding dashboard layout with grid system',
      '📊 integrating chart library — testing with live data',
      '💅 adding dark mode support to all components',
      '🧪 writing component tests for chart rendering',
      '🚀 dashboard ready for review',
    ],
  },
  {
    role: 'code-reviewer',
    task: 'Reviewing PR #487 — payment processing refactor',
    slackMessages: [
      '👀 opening PR #487 — 23 files changed',
      '🔍 checking error handling in payment flow',
      '💡 suggesting async/await instead of .then chains',
      '⚡ found a potential race condition in webhook handler',
      '✅ review complete — approved with 3 suggestions',
    ],
  },
]

// Extra random slack chatter between agents
const SIM_CHATTER = [
  { sender: 'Debugger', role: 'debugger', msg: 'found a null pointer in the auth handler, patching now' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'the new dark mode toggle is looking clean' },
  { sender: 'Security', role: 'security-auditor', msg: 'heads up — that API key should be in env vars, not hardcoded' },
  { sender: 'Reviewer', role: 'code-reviewer', msg: 'lgtm on the PR, just one nit on the error handling' },
  { sender: 'DBA', role: 'database-architect', msg: 'added an index on user_id, queries are 10x faster now' },
  { sender: 'DevOps', role: 'devops-engineer', msg: 'staging deploy is green, promoting to prod' },
  { sender: 'Claude', role: 'assistant', msg: 'the printer jammed again. third time today.' },
  { sender: 'Tester', role: 'test-engineer', msg: 'coverage is at 94%, just need the edge cases' },
  { sender: 'PerfEng', role: 'performance-engineer', msg: 'shaved 200ms off the initial load, LCP is under 2s' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'responsive layout done, looks great on mobile' },
  { sender: 'Claude', role: 'assistant', msg: 'someone get the coffee machine, its making that sound again' },
  { sender: 'Architect', role: 'architect-reviewer', msg: 'the new module boundary looks solid, good separation' },
  { sender: 'AI Eng', role: 'ai-engineer', msg: 'embeddings are indexed, RAG pipeline is live' },
  { sender: 'TS Pro', role: 'typescript-pro', msg: 'fixed the generic inference, no more any casts' },
  { sender: 'Antony', role: 'boss', msg: 'anyone want a Red Bull?' },
  { sender: 'Antony', role: 'boss', msg: 'ship it, we\'ll fix it in prod' },
  { sender: 'Antony', role: 'boss', msg: 'how are we looking on the dashboard?' },
]

// Dunder Mifflin themed chatter — used when /the-office is active
const OFFICE_SIM_CHATTER = [
  { sender: 'Debugger', role: 'debugger', msg: 'found a bug in the system — Creed. again.' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'new catalog brochure looks cleaner than Dwight\'s desk' },
  { sender: 'Security', role: 'security-auditor', msg: 'heads up — Dwight is conducting another surprise fire drill' },
  { sender: 'Reviewer', role: 'code-reviewer', msg: 'the ream count checks out. approved.' },
  { sender: 'DBA', role: 'database-architect', msg: 'indexed the client list alphabetically. like the old days.' },
  { sender: 'DevOps', role: 'devops-engineer', msg: 'loading the delivery truck — Schrute beet vans.' },
  { sender: 'Claude', role: 'assistant', msg: 'Michael is in the conference room. again. please help.' },
  { sender: 'Tester', role: 'test-engineer', msg: 'tested the paper quality. still paper. 94% paper.' },
  { sender: 'PerfEng', role: 'performance-engineer', msg: 'the printer warms up 200ms faster. small wins.' },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'mobile layout works — even Creed noticed' },
  { sender: 'Claude', role: 'assistant', msg: 'someone get the printer, it\'s on fire. literal fire.' },
  { sender: 'Architect', role: 'architect-reviewer', msg: 'the Finer Things Club charter is immaculate' },
  { sender: 'AI Eng', role: 'ai-engineer', msg: 'teaching the copier to recognize Stanley\'s handwriting' },
  { sender: 'TS Pro', role: 'typescript-pro', msg: 'false. that is not a staple. it is a Dwight.' },
  { sender: 'Antony', role: 'boss', msg: "anyone want to go to Chili's? I got Baby Back Ribs on the brain." },
  { sender: 'Antony', role: 'boss', msg: 'ship it. we\'ll fix it in prod. PARKOUR!' },
  { sender: 'Antony', role: 'boss', msg: 'how many reams did we move today?' },
  { sender: 'Antony', role: 'boss', msg: "I'm not superstitious, but I am a little stitious." },
  { sender: 'Debugger', role: 'debugger', msg: 'Bears. Beets. Battlestar Galactica.' },
  { sender: 'Security', role: 'security-auditor', msg: 'Identity theft is not a joke, Jim! Millions of families suffer every year!' },
  { sender: 'Reviewer', role: 'code-reviewer', msg: "that's what she said" },
  { sender: 'Frontend', role: 'frontend-developer', msg: 'I feel God in this Chili\'s tonight' },
  { sender: 'Tester', role: 'test-engineer', msg: 'Would I rather be feared or loved? Easy. Both.' },
  { sender: 'DevOps', role: 'devops-engineer', msg: 'I declare BANKRUPTCY' },
]

const App: React.FC = () => {
  // All hooks must be at the top — before any conditional returns.
  const theme = useTheme() // Why: re-render rooms + agents when /the-office toggles
  const variant = useVariant() // Why: forced night + incident overlays while prod is down
  // The office state machine (src/officeReducer.ts) lives in a ref that every
  // mutation path (server events, the animation tick, sim scripts, random
  // events, boss clicks) updates synchronously through commit(); React state
  // is only a mirror for rendering. Nothing reads a stale copy and nothing is
  // computed inside a setState updater, so no event or side-effect can be
  // dropped or doubled (C12/C14/C31).
  const officeRef = useRef<OfficeState | null>(null)
  // Live: the boss alone until the server names a session — each terminal
  // then gets its own Claude (officeReducer ensureClaude). ?sim / ?video have
  // no sessions, so the decorative Claude keeps its desk there.
  if (officeRef.current === null) officeRef.current = initialOfficeState(isSimMode ? [createBoss(), createClaude()] : [createBoss()], Date.now())
  const [agents, setAgents] = useState<Agent[]>(() => officeRef.current!.agents)
  // Always officeRef.current.agents — for callbacks that only need the roster
  const agentsRef = useRef<Agent[]>(officeRef.current.agents)

  const commit = useCallback((next: OfficeState) => {
    officeRef.current = next
    agentsRef.current = next.agents
    setAgents(next.agents)
  }, [])

  /** Apply a pure transform to the agents array (the few ad-hoc moves outside the reducer) */
  const updateAgents = useCallback((fn: (prev: Agent[]) => Agent[]) => {
    const cur = officeRef.current!
    const next = fn(cur.agents)
    if (next !== cur.agents) commit({ ...cur, agents: next })
  }, [commit])

  // Timers owned by this mount — cleared on unmount so nothing fires afterwards
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => { timersRef.current.delete(id); fn() }, ms)
    timersRef.current.add(id)
    return id
  }, [])
  useEffect(() => {
    const timers = timersRef.current
    return () => { timers.forEach(clearTimeout); timers.clear() }
  }, [])

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatTypingUser, setChatTypingUser] = useState<string | null>(null)
  const [lastSeenId, setLastSeenId] = useState<number | null>(null)
  const [muted, setMuted] = useState(false)
  const [dayPhase, setDayPhase] = useState<DayPhase>(getCurrentPhase())
  const [dayNightMode, setDayNightMode] = useState<'auto' | 'day' | 'night'>('auto')

  // Compressed day cycle: 10 min = 24 hours
  // nightOpacity: 0 = full day, 1 = full night
  const [nightOpacity, setNightOpacity] = useState(0)

  // Track interactive furniture state (coffee on/off, filing open/closed)
  const [furnitureStates, setFurnitureStates] = useState<Record<string, string>>({})

  // Visual flicker state for power-flicker event
  const [flickering, setFlickering] = useState(false)

  // Boss interaction cooldowns
  const interactionCooldowns = useRef<Map<string, number>>(new Map())

  // Boss interaction effect (shown above boss character)
  const [bossEffect, setBossEffect] = useState<string | null>(null)

  // '✋ ' in front of the window title and the title bar while any session's
  // Claude waits on a person (reducer 'title' effect)
  const [titlePrefix, setTitlePrefix] = useState('')
  const baseTitleRef = useRef(document.title)
  useEffect(() => { document.title = `${titlePrefix}${baseTitleRef.current}` }, [titlePrefix])

  // A slow clock so a Claude that has been idle for 30 s falls asleep even
  // when nothing else moves (the animation loop only commits on change)
  const [, setSlowClock] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSlowClock(n => n + 1), 2000)
    return () => clearInterval(timer)
  }, [])

  // The inspector card (src/components/AgentCard.tsx): the character clicked
  // last; clicking the same one again closes it
  const [inspectedId, setInspectedId] = useState<string | null>(null)
  const handleCharacterClick = useCallback((id: string) => setInspectedId(prev => (prev === id ? null : id)), [])

  const handleFurnitureClick = useCallback((itemId: string) => {
    const interaction = getInteraction(itemId)
    if (!interaction) return

    // Check cooldown
    const now = Date.now()
    const lastUsed = interactionCooldowns.current.get(itemId) ?? 0
    if (now - lastUsed < interaction.cooldown) return
    interactionCooldowns.current.set(itemId, now)

    // Walk boss to the item
    const target = interaction.walkTo
    updateAgents(prev => prev.map(a => {
      if (a.id !== BOSS_ID) return a
      return {
        ...a,
        state: 'walking-to-desk' as const,
        targetPosition: target,
        pathQueue: computePath(a.position, target),
        statusText: Array.isArray(interaction.chatMessage)
          ? interaction.chatMessage[Math.floor(Math.random() * interaction.chatMessage.length)]
          : interaction.chatMessage,
      }
    }))

    // Set up arrival watcher — when boss reaches target, trigger effects
    const checkArrival = setInterval(() => {
      const boss = agentsRef.current.find(a => a.id === BOSS_ID)
      if (!boss) { clearInterval(checkArrival); return }
      const dist = Math.sqrt((boss.position.x - target.x) ** 2 + (boss.position.y - target.y) ** 2)
      if (dist < 2) {
        clearInterval(checkArrival)

        // Play sound if specified
        if (interaction.sound === 'bell') sfx.playBell()
        else if (interaction.sound === 'notification') sfx.playNotification()
        else if (interaction.sound === 'coffee') sfx.playCoffee()

        // Show effect above boss
        setBossEffect(interaction.effect)
        schedule(() => setBossEffect(null), interaction.duration)

        // Post chat message
        const msg = Array.isArray(interaction.chatMessage)
          ? interaction.chatMessage[Math.floor(Math.random() * interaction.chatMessage.length)]
          : interaction.chatMessage
        const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
        // Use setMessages directly to avoid addMsg dependency ordering
        setMessages(prev => [...prev.slice(-50), {
          id: makeMsgId(),
          sender: bossCfg.title,
          senderSprite: BOSS_ROLE,
          senderColor: bossCfg.color,
          text: msg,
          channel: 'office-general',
          timestamp: timeNow(),
        }])

        // Furniture state change
        if (interaction.furnitureState) {
          const fs = interaction.furnitureState
          setFurnitureStates(prev => ({ ...prev, [fs.id]: fs.state }))
          if (fs.revertAfter) {
            schedule(() => {
              setFurnitureStates(prev => {
                const next = { ...prev }
                delete next[fs.id]
                return next
              })
            }, fs.revertAfter)
          }
        }

        // Walk boss back to desk after effect
        schedule(() => {
          updateAgents(prev => prev.map(a => {
            if (a.id !== BOSS_ID) return a
            return {
              ...a,
              state: 'walking-to-desk' as const,
              targetPosition: { ...a.deskPosition },
              pathQueue: computePath(a.position, a.deskPosition),
              statusText: 'back to work',
            }
          }))
        }, interaction.duration + 500)
      }
    }, 200)

    // Safety: clear after 15s if boss never arrives
    setTimeout(() => clearInterval(checkArrival), 15000)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Agents currently showing typing indicator (before a Slack message)
  const [typingAgents, setTypingAgents] = useState<Set<string>>(new Set())

  // Video mode: auto-type text into the Slack input
  const [autoTypeText, setAutoTypeText] = useState<string | undefined>(undefined)

  // ---------------------------------------------------------------------------
  // Slack chat helpers
  // ---------------------------------------------------------------------------

  const addMsg = useCallback((
    sender: string,
    role: string,
    color: string,
    text: string,
    isSystem = false,
    id?: number,
    tag?: 'prompt' | 'reply',
  ) => {
    setMessages(prev => [...prev.slice(-50), {
      id: id ?? makeMsgId(),
      sender,
      senderSprite: role,
      senderColor: color,
      text,
      channel: 'office-general',
      timestamp: timeNow(),
      isSystem,
      tag,
      reactions: undefined,
      // Why: resolved now, so the transcript keeps the name and face a line was
      // posted under even if the Office cast is re-dealt later (C47)
      displayName: isSystem ? undefined : themedDisplayName(role, sender),
      avatarSrc: isSystem ? undefined : getAvatarSrc(role),
    }])
  }, [])

  // ---------------------------------------------------------------------------
  // Flush the reducer's side-effects — once per event, never inside an updater
  // ---------------------------------------------------------------------------

  const handleEventRef = useRef<(action: OfficeAction) => void>(() => {})

  const runEffects = useCallback((effects: OfficeEffect[]) => {
    for (const fx of effects) {
      switch (fx.kind) {
        case 'msg': {
          if (fx.isSystem) { addMsg(fx.sender, fx.role, fx.color, fx.text, true, fx.id); break }
          // Show typing indicator 500ms before the message appears — on the
          // character the effect names (a session's Claude), else the role's first
          const agentId = fx.agentId ?? agentsRef.current.find(a => a.role === fx.role)?.id
          if (!agentId) { addMsg(fx.sender, fx.role, fx.color, fx.text, false, fx.id, fx.tag); break }
          setTypingAgents(prev => new Set(prev).add(agentId))
          schedule(() => {
            setTypingAgents(prev => {
              const next = new Set(prev)
              next.delete(agentId)
              return next
            })
            addMsg(fx.sender, fx.role, fx.color, fx.text, false, fx.id, fx.tag)
          }, 500)
          break
        }
        case 'sfx':
          if (sfx.isMuted()) break
          switch (fx.sfx) {
            case 'doorOpen':    sfx.playDoorOpen(); break
            case 'typing':      sfx.playTyping(); break
            case 'celebration': sfx.playCelebration(); break
            case 'coffee':      sfx.playCoffee(); break
            case 'alarm':       sfx.playAlarm(); break
            case 'error':       sfx.playError(); break
            case 'powerDown':   sfx.playPowerDown(); break
            case 'notification': sfx.playNotification(); break
            case 'needsYou':    sfx.playNeedsYou(); break
          }
          break
        case 'title':
          setTitlePrefix(fx.prefix)
          break
        case 'furniture':
          setFurnitureStates(prev => ({ ...prev, [fx.id]: fx.state }))
          break
        case 'schedule':
          schedule(() => handleEventRef.current(fx.action), fx.delayMs)
          break
        case 'typing':
          if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = null }
          setChatTypingUser(fx.sender)
          if (fx.sender !== null) typingTimeoutRef.current = schedule(() => setChatTypingUser(null), 10000)
          break
        case 'reaction':
          setMessages(prev => prev.map(m => (m.id === fx.messageId ? { ...m, reactions: fx.reactions } : m)))
          break
        case 'seen':
          setLastSeenId(fx.messageId)
          break
        case 'adoptMsgId':
          // The optimistic local copy of the boss's own post takes the server's row id,
          // so reactions and read receipts on it match (C34)
          setMessages(prev => {
            let idx = -1
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].id < 0 && prev[i].text === fx.text) { idx = i; break }
            }
            return idx < 0 ? prev : prev.map((m, i) => (i === idx ? { ...m, id: fx.id } : m))
          })
          break
        case 'releaseRole':
          releaseRole(fx.role)
          break
      }
    }
  }, [addMsg, schedule])

  // Boss & Claude arrival messages (ref guard prevents StrictMode double-fire)
  const arrivedRef = useRef(false)
  useEffect(() => {
    if (arrivedRef.current) return
    arrivedRef.current = true
    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
    addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, '👑 clocked in')
    // Live: each session's Claude posts its own clock-in when it walks in (reducer)
    if (!isSimMode) return
    const claudeCfg = AGENT_CONFIGS[CLAUDE_ROLE] ?? AGENT_CONFIGS['default']
    setTimeout(() => {
      addMsg(claudeCfg.title, CLAUDE_ROLE, claudeCfg.color, '🤖 clocked in')
    }, 1500)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Incident mode: chat lines + sounds for every entry/exit, whatever triggered it
  // (failures, random events, /incident relayed by the server, the 10 min timeout)
  const incidentIntroRef = useRef(false)
  useEffect(() => {
    const unsubscribe = subscribeIncidentTransitions(t => {
      // Why: the postmortem card follows the server's own all-clear line (which the
      // chat_message handler posts on a timeout), so give the scribe a beat to write it
      const delay = t.exited ? 600 : 0
      const lines = incidentTransitionLines(t, agentsRef.current)
      setTimeout(() => { for (const line of lines) addMsg('system', 'default', '#8b8d91', line, true) }, delay)
      if (!sfx.isMuted()) {
        if (t.entered) sfx.playAlarm()
        if (t.exited) sfx.playCelebration()
      }
    })
    // Pinned by ?variant=incident or restored from localStorage: announce once on mount
    const current = getIncident()
    if (!incidentIntroRef.current && current.variant === 'incident') {
      incidentIntroRef.current = true
      for (const line of incidentTransitionLines({ state: current, entered: current.reason ?? 'restored' })) {
        addMsg('system', 'default', '#8b8d91', line, true)
      }
    }
    return unsubscribe
  }, [addMsg])

  // ---------------------------------------------------------------------------
  // Day/night cycle — compressed: 10 min = 24 hours
  // Timeline (600s total):
  //   0-60s:    dawn transition (night→day fade)
  //   60-300s:  daytime (full day)
  //   300-360s: dusk transition (day→night fade)
  //   360-600s: nighttime (full night)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const CYCLE_MS = 10 * 60 * 1000 // 10 minutes
    const startTime = Date.now()
    let lastPhase: DayPhase | null = null

    const tick = () => {
      const elapsed = (Date.now() - startTime) % CYCLE_MS
      const t = elapsed / 1000 // seconds into cycle

      let opacity: number
      let phase: DayPhase

      if (t < 60) {
        // Dawn: fade night→day (1→0)
        opacity = 1 - (t / 60)
        phase = 'dawn'
      } else if (t < 300) {
        // Daytime
        opacity = 0
        phase = t < 180 ? 'morning' : 'afternoon'
      } else if (t < 360) {
        // Dusk: fade day→night (0→1)
        opacity = (t - 300) / 60
        phase = 'dusk'
      } else {
        // Nighttime
        opacity = 1
        phase = 'night'
      }

      setNightOpacity(opacity)

      if (phase !== lastPhase) {
        lastPhase = phase
        setDayPhase(phase)
      }
    }

    tick() // initial
    const interval = setInterval(tick, 500) // update every 500ms for smooth fade
    return () => clearInterval(interval)
  }, [])

  // ---------------------------------------------------------------------------
  // WebSocket event handler
  // ---------------------------------------------------------------------------

  // Everything impure the reducer needs; ?sim / ?video have no server, so the
  // office itself plays the server's part (lifecycle chat lines, all-move events)
  const officeEnv = useCallback((): OfficeEnv => ({ now: Date.now(), live: !isSimMode, computePath, random: Math.random }), [])

  // Permission dialogs waiting on the office (src/permissions.ts): their own
  // state beside the office reducer — a card is not a character. The
  // dispatcher is stable, so handleEvent below can call it.
  const [permissionCards, setPermissionCards] = useState<PermissionCardState[]>([])
  const dispatchPermissions = useCallback((action: PermissionAction) => setPermissionCards(prev => reducePermissions(prev, action)), [])

  const handleEvent = useCallback((action: OfficeAction) => {
    // permission_request / _extended / _resolved are the cards' alone; the
    // snapshot also hands over the UI token and the pending list, then goes
    // on to the office reducer as before
    if (isPermissionEvent(action)) { dispatchPermissions(action); return }
    if (action.type === 'snapshot') { setUiToken(action.uiToken); dispatchPermissions(action) }
    // Incident mode: count failed tool calls, hear what the Bash commands
    // meant (a failed deploy opens it, a green run closes it), and apply
    // /incident + /all-clear relayed by the server. A signal then goes on to
    // the office reducer for its scene and chat line.
    if (action.type === 'agent_working' && action.failed) {
      const failedAgent = action.agentId ? agentsRef.current.find(a => a.id === action.agentId) : undefined
      dispatchIncident({
        type: 'failure', at: Date.now(), tool: failureToolFromStatus(action.status),
        agentId: failedAgent?.id, agentName: failedAgent?.name, sessionId: action.sessionId,
      })
    }
    if (action.type === 'signal') {
      const worker = action.agentId ? agentsRef.current.find(a => a.id === action.agentId) : undefined
      const input = signalIncidentInput(action, Date.now(), worker?.name)
      if (input) dispatchIncident(input)
    }
    if (action.type === 'variant_change') {
      dispatchIncident({ type: 'command', at: Date.now(), cmd: action.variant === 'incident' ? 'incident' : 'all-clear', reason: 'remote' })
      return
    }
    // Payroll / electricity / memory (the status-line feed): its own store, no agent involved
    if (action.type === 'session_status' || action.type === 'agent_status') {
      dispatchMeters(action)
      return
    }

    // One pure transition, then its effects flushed exactly once
    const { state, effects } = reduceOffice(officeRef.current!, action, officeEnv())
    if (state !== officeRef.current) commit(state)
    runEffects(effects)
  }, [commit, runEffects, officeEnv, dispatchPermissions])
  handleEventRef.current = handleEvent

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  const { sessions, trusted } = useAgentSocket({ onEvent: handleEvent, url: officeWsUrl(), disabled: isSimMode })
  // The server showed this page the office read-only: no office token, or a
  // stale one (src/officeToken.ts). The cards and the chat stop offering
  // answers the server would refuse, and the status strip says how to fix it.
  const readOnly = !isSimMode && trusted === false
  const activeSessionCount = sessions.filter(s => s.state === 'active').length

  // ---------------------------------------------------------------------------
  // Simulation loop — spawns/completes fake agents (only in ?sim mode)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isSimMode) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const intervals: ReturnType<typeof setInterval>[] = []

    // ---- Office-theme rotation sim: 10 staff, constant door churn, cycles all 22 ----
    if (getTheme() === 'office' && !isVideoMode) {
      // Why: roles are synthetic "dm-0..dm-9" so each slot gets its own cast entry
      const STAFF_COUNT = 10
      const ROTATION_MS = 9000 // Why: fast enough to see all 22 in <2 min
      const ROLES = ['debugger', 'code-reviewer', 'frontend-developer', 'fullstack-developer',
                      'test-engineer', 'security-auditor', 'devops-engineer',
                      'architect-reviewer', 'performance-engineer', 'ai-engineer'] as const
      let lastRetired: string | null = null

      const spawnSlot = (slotIdx: number, initialDelay = 0) => {
        const role = `dm-slot-${slotIdx}`
        const baseRole = ROLES[slotIdx % ROLES.length]
        const cfg = AGENT_CONFIGS[baseRole] ?? AGENT_CONFIGS['default']
        const slug = nextUnusedOfficeCharacter(new Set(lastRetired ? [lastRetired] : []))
        const displayName = displayNameFromSlug(slug)

        timers.push(setTimeout(() => {
          // Why: force this synthetic role to map to the chosen Office character
          assignCharacterToRole(role, slug)
          handleEvent({
            type: 'agent_spawned',
            agent: {
              id: `dm-${slotIdx}-${Date.now()}`,
              name: displayName,
              role, // synthetic — so castByRole maps uniquely
              task: `Dunder Mifflin — ${displayName}`,
            },
          })
        }, initialDelay))
      }

      // Spawn 10 staff staggered over first 8s
      for (let i = 0; i < STAFF_COUNT; i++) {
        spawnSlot(i, i * 800)
      }

      // Rotation: every ROTATION_MS, retire oldest agent, spawn a new one in its slot
      let nextSlotToRotate = 0
      intervals.push(setInterval(() => {
        const slotIdx = nextSlotToRotate % STAFF_COUNT
        nextSlotToRotate++
        const role = `dm-slot-${slotIdx}`

        // Find the current agent for this slot and complete it (walks to door, exits)
        const agent = agentsRef.current.find(a => a.role === role)
        if (agent) {
          lastRetired = null // will be set after release
          handleEvent({
            type: 'agent_completed',
            agentId: agent.id,
            result: `${agent.name} heading out for a pretzel`,
          })
        }

        // After the exit animation, release the cast slot and spawn replacement
        timers.push(setTimeout(() => {
          releaseRole(role)
          spawnSlot(slotIdx, 800) // small gap before new hire walks in
        }, 3500))
      }, ROTATION_MS))

      // Periodic Office chatter from random staff
      intervals.push(setInterval(() => {
        const staff = agentsRef.current.filter(a => a.role.startsWith('dm-slot-'))
        if (staff.length === 0) return
        const speaker = staff[Math.floor(Math.random() * staff.length)]
        const lines = OFFICE_SIM_TOOL_MESSAGES[ROLES[parseInt(speaker.role.split('-')[2], 10) % ROLES.length]] ?? []
        const line = lines[Math.floor(Math.random() * lines.length)] ?? 'selling paper'
        const cfg = AGENT_CONFIGS[ROLES[0]] ?? AGENT_CONFIGS['default']
        addMsg(speaker.name, speaker.role, cfg.color, line)
      }, 4500))

      return () => {
        timers.forEach(t => clearTimeout(t))
        intervals.forEach(i => clearInterval(i))
      }
    }

    // Helper: post a message with an optional typing indicator beforehand.
    // showTyping=true will set a typing state for ~1.5s before the message appears.
    const postWithTyping = (
      sender: string,
      role: string,
      msg: string,
      delay: number,
      showTyping: boolean,
    ) => {
      if (showTyping) {
        timers.push(setTimeout(() => {
          setChatTypingUser(sender)
        }, delay))
        timers.push(setTimeout(() => {
          const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
          setChatTypingUser(null)
          addMsg(sender, role, cfg.color, msg)
        }, delay + 1500))
      } else {
        timers.push(setTimeout(() => {
          const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
          addMsg(sender, role, cfg.color, msg)
        }, delay))
      }
    }

    // Helper: add a random emoji reaction to the second-to-last chat message.
    const reactToLastMsg = (delay: number) => {
      timers.push(setTimeout(() => {
        setMessages(prev => {
          const target = prev[prev.length - 2]
          if (target && !target.reactions?.length) {
            const emoji = ['👍', '🔥', '😂', '🚀', '💯'][Math.floor(Math.random() * 5)]
            return prev.map(m => m.id === target.id ? { ...m, reactions: [emoji] } : m)
          }
          return prev
        })
      }, delay))
    }

    // Phase 1: Stagger-spawn 3 agents (1s, 3s, 5s); the reducer posts their
    // "starting:" lines (there is no server to do it in sim mode)
    SIM_SCENARIOS.forEach((sim, i) => {
      const cfg = AGENT_CONFIGS[sim.role] ?? AGENT_CONFIGS['default']
      const spawnAt = 1000 + i * 2500
      timers.push(setTimeout(() => {
        handleEvent({
          type: 'agent_spawned',
          agent: {
            id: `sim-${sim.role}`,
            name: cfg.title,
            role: sim.role,
            task: sim.task,
          },
        })
      }, spawnAt))
    })

    // Phase 2: Drip-feed task progress messages
    const msgIndexes = SIM_SCENARIOS.map(() => 0)
    timers.push(setTimeout(() => {
      const progressInterval = setInterval(() => {
        // Pick a random agent to send a progress update
        const idx = Math.floor(Math.random() * SIM_SCENARIOS.length)
        const sim = SIM_SCENARIOS[idx]
        const msgIdx = msgIndexes[idx]
        if (msgIdx < sim.slackMessages.length) {
          const cfg = AGENT_CONFIGS[sim.role] ?? AGENT_CONFIGS['default']
          // Show typing indicator before every other progress message
          const useTyping = msgIdx % 2 === 0
          if (useTyping) {
            setChatTypingUser(cfg.title)
            timers.push(setTimeout(() => {
              setChatTypingUser(null)
              addMsg(cfg.title, sim.role, cfg.color, sim.slackMessages[msgIdx])
            }, 1500))
          } else {
            addMsg(cfg.title, sim.role, cfg.color, sim.slackMessages[msgIdx])
          }
          msgIndexes[idx]++

          // Add a reaction to the previous message after a short delay
          reactToLastMsg(3000)

          // Trigger ultra-think powerup on specific messages
          if (sim.slackMessages[msgIdx].includes('race condition') ||
              sim.slackMessages[msgIdx].includes('scanning') ||
              sim.slackMessages[msgIdx].includes('architecture')) {
            updateAgents(prev => prev.map(a =>
              a.role === sim.role
                ? { ...a, statusText: 'ultra-think: deep analysis...' }
                : a
            ))
            // Clear ultra-think after a few seconds
            timers.push(setTimeout(() => {
              updateAgents(prev => prev.map(a =>
                a.role === sim.role
                  ? { ...a, statusText: sim.slackMessages[msgIdx] }
                  : a
              ))
            }, 8000))
          }
        }
      }, 4000)
      intervals.push(progressInterval)
    }, 12000)) // start after agents have settled at desks

    // Phase 3: Random chatter between agents — typing indicator on every 3rd message
    timers.push(setTimeout(() => {
      let chatterIdx = 0
      const chatterInterval = setInterval(() => {
        // Why: pool chosen at fire time so /the-office toggle mid-sim swaps the chatter instantly
        const pool = getTheme() === 'office' ? OFFICE_SIM_CHATTER : SIM_CHATTER
        if (chatterIdx >= pool.length) {
          chatterIdx = 0 // loop
        }
        const chat = pool[chatterIdx]
        const showTyping = chatterIdx % 3 === 0
        postWithTyping(chat.sender, chat.role, chat.msg, 0, showTyping)

        // React to the previous message after some chatter
        if (chatterIdx % 4 === 2) {
          reactToLastMsg(4000)
        }

        chatterIdx++
      }, 7000)
      intervals.push(chatterInterval)
    }, 18000))

    // Phase 4: Spawn an Explore agent partway through (codebase search)
    timers.push(setTimeout(() => {
      const exploreCfg = AGENT_CONFIGS['Explore'] ?? AGENT_CONFIGS['default']
      handleEvent({
        type: 'agent_spawned',
        agent: {
          id: 'sim-explore',
          name: exploreCfg.title,
          role: 'Explore',
          task: 'Searching codebase for API endpoint patterns',
        },
      })
      // Explorer completes and leaves after 20s
      timers.push(setTimeout(() => {
        handleEvent({
          type: 'agent_completed',
          agentId: 'sim-explore',
          result: 'Found 12 API endpoints across 4 route files',
        })
      }, 20000))
    }, 25000))

    // Phase 5: One agent completes task, walks to door, leaves — then a new one spawns
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_completed',
        agentId: 'sim-code-reviewer',
        result: 'PR #487 approved — ready to merge',
      })
      // Replacement agent arrives
      timers.push(setTimeout(() => {
        const cfg = AGENT_CONFIGS['debugger'] ?? AGENT_CONFIGS['default']
        handleEvent({
          type: 'agent_spawned',
          agent: {
            id: 'sim-debugger',
            name: cfg.title,
            role: 'debugger',
            task: 'Investigating null pointer in payment webhook handler',
          },
        })
      }, 8000))
    }, 50000))

    return () => {
      timers.forEach(t => clearTimeout(t))
      intervals.forEach(i => clearInterval(i))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Video mode — scripted demo for TikTok recording (?video)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isVideoMode) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']

    const officeSim0 = getTheme() === 'office'

    // 0-3s: Office is just Antony, settling in
    timers.push(setTimeout(() => {
      addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color,
        officeSim0 ? "👑 World's Best Boss clocked in, let's sell some paper" : '👑 clocked in, lets get to work')
    }, 2000))

    // 4s: Antony types a question in Slack
    timers.push(setTimeout(() => {
      setAutoTypeText(officeSim0
        ? (OFFICE_SIM_BOSS_PROMPTS[0] ?? '/ultra-think audit our authentication system for security vulnerabilities')
        : '/ultra-think audit our authentication system for security vulnerabilities')
    }, 4000))

    // 8s: 3 agents spawn with ultra-think tasks (energy drinks!)
    timers.push(setTimeout(() => {
      const spawns = [
        { id: 'vid-security', role: 'security-auditor', name: 'Security', task: 'ultra-think: deep analysis of auth middleware vulnerabilities' },
        { id: 'vid-reviewer', role: 'code-reviewer', name: 'Reviewer', task: 'ultra-think: reviewing authentication token handling' },
        { id: 'vid-frontend', role: 'frontend-developer', name: 'Frontend', task: 'ultra-think: auditing client-side auth state management' },
      ]
      spawns.forEach((s, i) => {
        timers.push(setTimeout(() => {
          handleEvent({ type: 'agent_spawned', agent: s })
        }, i * 2000))
      })
    }, 8000))

    // 16s: Realistic tool output messages in Slack.
    // Why: swap to Office-themed chatter when /the-office mode is on at sim start
    const isOfficeSim = getTheme() === 'office'
    const defaultToolMessages = [
      { t: 16000, sender: 'Security', role: 'security-auditor', text: '⚡ reading src/auth/middleware.ts' },
      { t: 18000, sender: 'Reviewer', role: 'code-reviewer', text: '⚡ running: grep -r "jwt" src/' },
      { t: 20000, sender: 'Security', role: 'security-auditor', text: '⚠️ session tokens stored in localStorage — XSS risk' },
      { t: 22000, sender: 'Frontend', role: 'frontend-developer', text: '⚡ reading src/hooks/useAuth.ts' },
      { t: 24000, sender: 'Reviewer', role: 'code-reviewer', text: '🔍 checking CORS config on /api/auth endpoints' },
      { t: 26000, sender: 'Security', role: 'security-auditor', text: '🚨 JWT refresh token has no expiry set' },
      { t: 28000, sender: 'Frontend', role: 'frontend-developer', text: '⚡ editing src/auth/tokenStore.ts' },
      { t: 30000, sender: 'Reviewer', role: 'code-reviewer', text: '💡 suggesting httpOnly cookies instead of localStorage' },
    ]
    const toolMessages = isOfficeSim
      ? defaultToolMessages.map((m, i) => {
          const pool = OFFICE_SIM_TOOL_MESSAGES[m.role] ?? []
          return { ...m, text: pool[i % pool.length] ?? m.text }
        })
      : defaultToolMessages
    toolMessages.forEach(({ t, sender, role, text }) => {
      timers.push(setTimeout(() => {
        const cfg = AGENT_CONFIGS[role] ?? AGENT_CONFIGS['default']
        addMsg(sender, role, cfg.color, text)
      }, t))
    })

    // 25s: Antony types a follow-up
    timers.push(setTimeout(() => {
      setAutoTypeText(isOfficeSim ? (OFFICE_SIM_BOSS_PROMPTS[1] ?? 'how bad is the localStorage issue?') : 'how bad is the localStorage issue?')
    }, 25000))

    // 27s: Agent replies
    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['security-auditor'] ?? AGENT_CONFIGS['default']
      addMsg('Security', 'security-auditor', cfg.color,
        isOfficeSim
          ? 'critical — Dwight-level bad. any XSS gives full account takeover. moving to httpOnly cookies now'
          : 'critical — any XSS gives full account takeover. moving to httpOnly cookies now')
    }, 27500))

    // 30s: Random chatter
    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['frontend-developer'] ?? AGENT_CONFIGS['default']
      addMsg('Frontend', 'frontend-developer', cfg.color,
        isOfficeSim ? 'I can handle the cookie migration — easier than organizing the Dundies' : 'I can handle the cookie migration on the client side')
    }, 30000))

    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['code-reviewer'] ?? AGENT_CONFIGS['default']
      addMsg('Reviewer', 'code-reviewer', cfg.color,
        isOfficeSim ? 'lgtm. ship it to Stamford, boom. roasted.' : 'lgtm on the approach, lets ship it')
    }, 32000))

    // 33s: Antony checks status with a slash command
    timers.push(setTimeout(() => {
      setAutoTypeText('/status')
    }, 33000))

    // 35s: Explorer spawns to check codebase
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_spawned',
        agent: { id: 'vid-explore', name: 'Explorer', role: 'Explore', task: 'Scanning auth-related files across codebase' },
      })
    }, 35000))

    // 38s: Pizza delivery event!
    timers.push(setTimeout(() => {
      addMsg('system', 'default', '#8b8d91',
        officeSim0 ? '🥨 IT\'S PRETZEL DAY' : '🍕 Pizza has arrived! Free lunch!', true)
      addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color,
        officeSim0 ? "You don't understand. It's pretzel day." : 'Pizza in the lobby!')
      // Move all agents to door
      updateAgents(prev => prev.map(a => ({
        ...a,
        state: 'walking-to-desk' as const,
        targetPosition: { x: 67.5, y: 48.9 },
        pathQueue: computePath(a.position, { x: 67.5, y: 48.9 }),
        statusText: 'Pizza Delivery',
      })))
      // Back to desks after 5s
      timers.push(setTimeout(() => {
        updateAgents(prev => prev.map(a => ({
          ...a,
          state: 'walking-to-desk' as const,
          targetPosition: { ...a.deskPosition },
          pathQueue: computePath(a.position, a.deskPosition),
          statusText: 'back to work',
        })))
      }, 5000))
    }, 38000))

    // 45s: Agent chatter after pizza/pretzels
    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['security-auditor'] ?? AGENT_CONFIGS['default']
      addMsg('Security', 'security-auditor', cfg.color,
        officeSim0 ? 'all the toppings. Stanley has been waiting all year.' : 'pineapple on pizza is a security vulnerability')
    }, 46000))

    timers.push(setTimeout(() => {
      const cfg = AGENT_CONFIGS['frontend-developer'] ?? AGENT_CONFIGS['default']
      addMsg('Frontend', 'frontend-developer', cfg.color,
        officeSim0 ? "that's what she said" : '😂')
    }, 47500))

    // 48s: Security completes
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_completed',
        agentId: 'vid-security',
        result: officeSim0
          ? 'Audit complete — beets secured. 3 critical issues booked into the Schrute Manual.'
          : 'Auth audit complete — 3 critical issues fixed, 2 PRs merged',
      })
    }, 48000))

    // 52s: Explorer completes
    timers.push(setTimeout(() => {
      handleEvent({
        type: 'agent_completed',
        agentId: 'vid-explore',
        result: officeSim0 ? 'Found 8 auth files — all filed under B for "Beet".' : 'Found 8 auth-related files, all updated',
      })
    }, 52000))

    // 55s: Antony wraps up
    timers.push(setTimeout(() => {
      setAutoTypeText(officeSim0 ? 'great work team — boom. roasted. 🥨' : 'great work team, ship it! 🚀')
    }, 55000))

    // 58s: Remaining agents complete
    timers.push(setTimeout(() => {
      handleEvent({ type: 'agent_completed', agentId: 'vid-reviewer',
        result: officeSim0 ? 'All PRs reviewed — Jim-approved.' : 'All PRs reviewed and approved' })
    }, 58000))

    timers.push(setTimeout(() => {
      handleEvent({ type: 'agent_completed', agentId: 'vid-frontend',
        result: officeSim0 ? 'Cookies deployed — Kevin took half for his chili.' : 'Cookie migration deployed to staging' })
    }, 60000))

    return () => timers.forEach(t => clearTimeout(t))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Animation loop — moves agents toward their targets each frame
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let rafId: number
    let lastTime = performance.now()

    function tick(now: number) {
      const dt = Math.min((now - lastTime) / 16.67, 3)
      lastTime = now

      // stepOffice only moves agents along their paths (plus arrival, breaks,
      // pruning and lobby seating) on top of whatever state is current *now*,
      // so an event that landed during this frame is never overwritten (C14).
      const { state, effects, changed } = stepOffice(officeRef.current!, dt, officeEnv())
      if (changed) commit(state)
      runEffects(effects)

      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------------------------------------------------------------------------
  // Random office events — fire every 60-120 seconds
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Percentage-based target positions for each event type (matching room layout)
    const EVENT_TARGETS: Record<string, { x: number; y: number }> = {
      'fire-drill': { x: 67.5, y: 48.9 },
      'pizza':      { x: 67.5, y: 48.9 },
      'standup':    { x: 28.9, y: 66.0 },
      'birthday':   { x: 73.5, y: 56.7 },
      'printer-jam': { x: 83.8, y: 63 },
    }

    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']

    function fireEvent() {
      const event = pickEvent()

      // Post main slack announcement (system message)
      addMsg('system', 'default', '#8b8d91', event.slackAnnouncement, true)

      // Incident mode: deploy-fail / who-broke-build start a 90 s mini-incident,
      // deploy-success ends one (the transition subscriber posts the chat lines)
      dispatchIncident({ type: 'random-event', id: event.id, at: Date.now() })

      // Play associated sound
      if (event.sound && !sfx.isMuted()) {
        switch (event.sound) {
          case 'alarm':        sfx.playAlarm(); break
          case 'celebration':  sfx.playCelebration(); break
          case 'doorOpen':     sfx.playDoorOpen(); break
          case 'error':        sfx.playError(); break
          case 'powerDown':    sfx.playPowerDown(); break
          case 'notification': sfx.playNotification(); break
          case 'coffee':       sfx.playCoffee(); break
        }
      }

      // Manager message from boss
      if (event.managerMessage) {
        schedule(() => {
          addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, event.managerMessage!)
        }, 500)
      }

      // Staggered agent messages as reactions
      const messages = event.agentMessages ?? []
      const currentAgents = agentsRef.current
      // Build list of participating agents (include boss)
      const participants = currentAgents.filter(a => a.id === BOSS_ID || a.state === 'working' || a.state === 'coffee-break')

      // Pick ONE random agent message (not a wall of spam)
      if (messages.length > 0) {
        const text = messages[Math.floor(Math.random() * messages.length)]
        schedule(() => {
          const nonBoss = participants.filter(a => a.id !== BOSS_ID)
          if (nonBoss.length === 0) return
          const agent = nonBoss[Math.floor(Math.random() * nonBoss.length)]
          const cfg = AGENT_CONFIGS[agent.role] ?? AGENT_CONFIGS['default']
          addMsg(agent.name, agent.role, cfg.color, text)
        }, 1200)
      }

      // Handle event types. Only seated agents take part, and in live mode only
      // the boss and Claude: a real subagent mid-task stays at its desk (C32).
      if (event.type === 'all-move') {
        const target = EVENT_TARGETS[event.id] ?? { x: 67.5, y: 48.9 }

        const { agents: moved, movedIds } = moveAgentsForEvent(agentsRef.current, target, event.name, officeEnv())
        updateAgents(() => moved)

        // After duration, send those who went back to their desks
        schedule(() => {
          updateAgents(prev => returnAgentsFromEvent(prev, movedIds, officeEnv()))
        }, event.duration)

      } else if (event.type === 'single-agent') {
        const target = EVENT_TARGETS[event.id] ?? { x: 83.8, y: 63 }
        const chosen = pickSingleEventAgent(agentsRef.current, officeEnv())
        if (chosen) {
          // Printer jam: break the printer when agent walks over
          if (event.id === 'printer-jam') {
            setFurnitureStates(prev => ({ ...prev, 'printer-1': 'broken' }))
          }

          const { agents: moved, movedIds } = moveAgentsForEvent(
            agentsRef.current.filter(a => a.id === chosen.id), target, event.name, officeEnv())
          updateAgents(prev => prev.map(a => moved.find(m => m.id === a.id) ?? a))
          // Return after duration, fix the printer
          schedule(() => {
            if (event.id === 'printer-jam') {
              setFurnitureStates(prev => ({ ...prev, 'printer-1': 'working' }))
            }
            updateAgents(prev => returnAgentsFromEvent(prev, movedIds, officeEnv()))
          }, event.duration)
        }

      } else if (event.type === 'visual-only') {
        // Power flicker: add CSS class for flicker animation
        setFlickering(true)
        schedule(() => setFlickering(false), event.duration)
      }
      // 'slack-only' events: messages already posted above — no movement
    }

    // Schedule first event after 60-120 seconds, then repeat
    function scheduleNext() {
      const delay = 60_000 + Math.random() * 60_000
      return setTimeout(() => {
        fireEvent()
        timerRef = scheduleNext()
      }, delay)
    }

    let timerRef = scheduleNext()
    return () => clearTimeout(timerRef)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addMsg])

  // ---------------------------------------------------------------------------
  // Ambient office sounds
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Start ambient hum (only if not muted)
    if (!sfx.isMuted()) {
      // Delay slightly to let AudioContext resume after first user interaction
      const startTimer = setTimeout(() => {
        sfx.playAmbientHum()
      }, 2000)
      return () => {
        clearTimeout(startTimer)
        sfx.stopAmbient()
      }
    }
    return () => sfx.stopAmbient()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keyboard clatter every 2-4 seconds when agents are working
  useEffect(() => {
    const interval = setInterval(() => {
      if (sfx.isMuted()) return
      const working = agentsRef.current.filter(a => a.state === 'working')
      if (working.length === 0) return
      sfx.playKeyboardClatter()
    }, 2000 + Math.random() * 2000)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stop/start ambient when mute changes (the mount effect above owns the first start)
  const mutedEffectRanRef = useRef(false)
  useEffect(() => {
    if (!mutedEffectRanRef.current) { mutedEffectRanRef.current = true; return }
    if (muted) {
      sfx.stopAmbient()
    } else {
      sfx.playAmbientHum()
    }
  }, [muted])

  // ---------------------------------------------------------------------------
  // Misc handlers
  // ---------------------------------------------------------------------------

  // Effective day phase (respects manual override; incident mode forces night —
  // a red room at noon reads as a bug)
  const forcedNight = variant === 'incident'
  const effectivePhase: DayPhase = forcedNight ? 'night'
    : dayNightMode === 'auto' ? dayPhase
    : dayNightMode === 'day' ? 'morning' : 'night'
  const isNight = effectivePhase === 'night' || effectivePhase === 'dusk'

  const [volume, setVolume] = useState(sfx.getVolume())

  const handleToggleMute = useCallback(() => {
    const nowMuted = sfx.toggleMute()
    setMuted(nowMuted)
    setVolume(sfx.getVolume())
  }, [])

  const handleVolumeChange = useCallback((v: number) => {
    sfx.setVolume(v)
    setVolume(v)
    setMuted(v === 0)
  }, [])

  const handleSendMessage = useCallback((text: string) => {
    const bossCfg = AGENT_CONFIGS[BOSS_ROLE] ?? AGENT_CONFIGS['default']
    addMsg(bossCfg.title, BOSS_ROLE, bossCfg.color, text)
    setAutoTypeText(undefined)
    // Send to server so Claude can read it. ?sim / ?video scripts stay local:
    // their scripted prompts must not reach chat.db or the AI watcher (C36).
    if (isSimMode) return
    fetch(`${officeHttpBase()}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: bossCfg.title, text }),
    }).catch(() => {})
  }, [addMsg])

  // Reactions added in the UI stay local: POST /chat/react is an agent route
  // (bearer token) since the server hardening, and the browser has no token.
  // Reactions the server broadcasts land on the right row by its id (C34).
  const handleReaction = useCallback((messageId: number, reactions: string[]) => {
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, reactions } : m)))
  }, [])

  // Why: a new items array every frame would re-render all 24 furniture sprites
  const furnitureItems = useMemo(() => MAIN_ROOM.furniture.map(item => {
    const stateOverride = furnitureStates[item.id]
    if (!stateOverride) return item
    // Swap sprite based on state
    if (item.id === 'coffee' && stateOverride === 'on') {
      return { ...item, sprite: 'coffee-on' }
    }
    if (item.id === 'filing-1' && stateOverride === 'open') {
      return { ...item, sprite: 'filing-open' }
    }
    if (item.id === 'printer-1' && stateOverride === 'broken') {
      return { ...item, sprite: 'printer-broken' }
    }
    return item
  }), [furnitureStates])

  // ---------------------------------------------------------------------------
  // Render — helper mode renders PlacementHelper in place of the full app
  // ---------------------------------------------------------------------------

  if (isHelperMode) {
    return (
      <Suspense fallback={<div style={{ color: '#666', padding: 20 }}>Loading helper...</div>}>
        <PlacementHelper />
      </Suspense>
    )
  }

  return (
    <div className="app-wrapper">
      <div className="title-bar">
        <div className="title-bar-dot" style={{ background: '#ff5f57' }} />
        <div className="title-bar-dot" style={{ background: '#febc2e' }} />
        <div className="title-bar-dot" style={{ background: '#28c840' }} />
        <span className="title-bar-text">{titlePrefix}{variant === 'incident' ? '🔥 PROD IS DOWN — AGENT OFFICE' : 'CLAUDE CODE — AGENT OFFICE'}</span>
        <SessionStrip sessions={sessions} agents={agents} />
        <button
          className="title-bar-daynight"
          onClick={() => setDayNightMode(prev =>
            prev === 'auto' ? 'day' : prev === 'day' ? 'night' : 'auto'
          )}
          title={`Mode: ${dayNightMode}`}
        >
          {dayNightMode === 'auto' ? 'AUTO' : dayNightMode === 'day' ? 'DAY' : 'NIGHT'}
        </button>
        <span className="title-bar-phase">{getPhaseLabel(effectivePhase)}</span>
      </div>

      <div className="app-body">
      <div className="office-view">
        <div
          className={`room-container${flickering ? ' flickering' : ''}${variant === 'incident' ? ' incident' : ''}`}
          style={{
            aspectRatio: '4800/3584',
            width: '100%',
            maxHeight: '100%',
            position: 'relative',
          }}
        >
          {/* Room backgrounds — both rendered, night crossfades via opacity. Theme swaps source art. */}
          <div
            key={`day-${theme}`}
            className="room-background"
            style={{ backgroundImage: `url(${getRoomImage('day')})` }}
          />
          <div
            key={`night-${theme}`}
            className="room-background room-background-night"
            style={{
              backgroundImage: `url(${getRoomImage('night')})`,
              opacity: forcedNight ? 1 : dayNightMode === 'auto' ? nightOpacity : dayNightMode === 'night' ? 1 : 0,
            }}
          />

          {/* Furniture — apply interactive state overrides */}
          <FurnitureRenderer onItemClick={handleFurnitureClick} items={furnitureItems} />

          {/* Agents */}
          {agents.map(agent => {
            // Use spot zIndex override when agent is at their desk
            const spot = MAIN_ROOM.agentSpots.find(s => s.id === agent.assignedSpotId)
            const atDesk = Math.abs(agent.position.x - agent.deskPosition.x) < 1 &&
                           Math.abs(agent.position.y - agent.deskPosition.y) < 1
            const zOverride = atDesk && spot?.zIndex ? spot.zIndex : undefined

            const meta = officeRef.current?.meta[agent.id]
            const idleDurationMs =
              agent.state === 'idle' && meta?.idleSince
                ? Date.now() - meta.idleSince
                : 0

            return (
              <Character
                key={agent.id}
                agent={agent}
                idleDurationMs={idleDurationMs}
                zIndex={zOverride}
                isTyping={typingAgents.has(agent.id)}
                showProject={activeSessionCount > 1}
                onClick={handleCharacterClick}
                inspected={agent.id === inspectedId}
              />
            )
          })}

          {/* Angela's cat — follows whoever is cast as Angela in Office theme */}
          {(() => {
            const angela = getAngelaCat()
            if (!angela) return null
            const host = agents.find(a => a.role === angela.role)
            if (!host) return null
            return (
              <img
                src={angela.catSprite}
                alt="cat"
                className="angela-cat"
                style={{
                  position: 'absolute',
                  left: `${host.position.x + 2.2}%`,
                  top: `${host.position.y}%`,
                  // Why: cats are 30-40% of ~78px character = ~24-30px tall
                  height: 28,
                  width: 'auto',
                  transform: 'translate(-50%, -10%)',
                  zIndex: Math.round(host.position.y) + 1,
                  pointerEvents: 'none',
                  filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))',
                }}
                draggable={false}
              />
            )
          })()}

          {/* Boss interaction effect */}
          {bossEffect && (() => {
            const boss = agents.find(a => a.id === BOSS_ID)
            if (!boss) return null
            return (
              <div
                className="boss-interaction-effect"
                style={{
                  position: 'absolute',
                  left: `${boss.position.x}%`,
                  top: `${boss.position.y - 8}%`,
                  transform: 'translate(-50%, -100%)',
                  zIndex: 999,
                  pointerEvents: 'none',
                }}
              >
                <img
                  src={bossEffect}
                  alt="interaction"
                  style={{ height: 32, width: 'auto', imageRendering: 'pixelated' }}
                />
              </div>
            )
          })()}

          {/* Incident mode: days-since sign (every mode), tint / beacon / status TV (incident only) */}
          <IncidentLayer />

          {/* Day/night overlay */}
          <div className={`day-overlay ${effectivePhase}`} />
        </div>
      </div>

      <AgentCard agentId={inspectedId} agent={agents.find(a => a.id === inspectedId)} sessions={sessions} onClose={() => setInspectedId(null)} />
      <div className="chat-column">
      {!isSimMode && <PermissionCards cards={permissionCards} dispatch={dispatchPermissions} readOnly={readOnly} />}
      <Meters onNotice={text => addMsg('system', 'default', '#8b8d91', text, true)} />
      <SlackChat
        messages={messages}
        muted={muted}
        volume={volume}
        onToggleMute={handleToggleMute}
        onVolumeChange={handleVolumeChange}
        onSendMessage={handleSendMessage}
        autoTypeText={autoTypeText}
        dayPhase={effectivePhase}
        typingUser={chatTypingUser}
        lastSeenId={lastSeenId}
        onReaction={handleReaction}
        readOnly={readOnly}
      />
      </div>
      </div>
      <StatusStrip office={officeRef} sessions={sessions} readOnly={readOnly} />
    </div>
  )
}

export default App
