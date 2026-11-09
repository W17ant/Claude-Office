import React, { useRef, useState, useEffect } from 'react'
import { Agent, AgentState } from '../types'
import SpeechBubble from './SpeechBubble'
import ResilientImg from './ResilientImg'
import EffectBubble from './EffectBubble'
import { getEffect } from '../agentManager'
import { ROLE_TO_CHAR, BOSS_ROLE } from '../config'
import { getSpritePath, useTheme } from '../theme'
import { useVariant } from '../incident'
import { isMainAgent, isHardNeedsYou, needsYouBadge, needsYouShort } from '../mainState'

export { ROLE_TO_CHAR }

interface CharacterProps {
  agent: Agent
  /** Milliseconds the agent has been in the 'idle' state (for sleeping bubble) */
  idleDurationMs?: number
  /** Override z-index (for agents sitting behind desks) */
  zIndex?: number
  /** Show typing indicator (about to post a Slack message) */
  isTyping?: boolean
  /** Show the agent's project (its Claude Code session) — when several sessions share the office */
  showProject?: boolean
  /** Click to inspect (the sprite becomes the click target; see .character-wrapper.clickable in office.css) */
  onClick?: (agentId: string) => void
  /** This character's card is open: a ring at its feet */
  inspected?: boolean
}

// Movement direction → sprite variant
// front-left  = moving up-right
// front-right = moving up-left
// rear-left   = moving down-right
// rear-right  = not used for walking (idle/sitting only)
type SpriteDirection = 'front-left' | 'front-right' | 'rear-left' | 'rear-right'

function getDirectionFromDelta(dx: number, dy: number): SpriteDirection {
  // In isometric view:
  //   up-right   → front-left
  //   up-left    → front-right
  //   down-right → rear-left
  //   down-left  → front-left (facing camera, moving left)
  if (dy < 0 && dx >= 0)  return 'front-left'   // up-right
  if (dy < 0 && dx < 0)   return 'front-right'  // up-left
  if (dy >= 0 && dx >= 0)  return 'rear-left'    // down-right
  return 'front-left'                             // down-left
}

function getCharBase(role: string): string {
  return ROLE_TO_CHAR[role] ?? 'employee-3'
}

function getAnimState(state: AgentState): string {
  switch (state) {
    case 'working':             return 'working'
    case 'walking-to-manager':
    case 'walking-to-desk':     return 'walking'
    case 'talking-to-manager':  return 'talking'
    case 'coffee-break':        return 'coffee'
    case 'new-hire':            return 'new-hire'
    default:                    return 'idle'
  }
}

// Speech bubble only shown briefly when statusText changes (like posting to Slack)
const BUBBLE_MS = 3200
const SPEAKING_Z = 99

function shouldShowBubble(state: AgentState): boolean {
  return state === 'talking-to-manager'
}

// A signal's scene (src/officeReducer.ts) wears an existing effect sprite
const SCENE_SPRITES: Record<NonNullable<Agent['scene']>['kind'], string> = {
  shipping: '/sprites/effects/rocket.png',
  shipped:  '/sprites/effects/party.png',
  red:      '/sprites/effects/build-failed.png',
  pushed:   '/sprites/effects/github-pr-merge.png',
}

// Opposite direction for random "looking around"
const OPPOSITE: Record<SpriteDirection, SpriteDirection> = {
  'front-left': 'rear-right',
  'front-right': 'rear-left',
  'rear-left': 'front-right',
  'rear-right': 'front-left',
}

const Character: React.FC<CharacterProps> = ({ agent, idleDurationMs = 0, zIndex, isTyping, showProject, onClick, inspected }) => {
  const prevPosRef = useRef({ x: agent.position.x, y: agent.position.y })
  const directionRef = useRef<SpriteDirection>(agent.spriteFacing ?? 'front-right')
  const [turnedAround, setTurnedAround] = useState(false)

  // While a speech bubble shows, the speaker is lifted above every other
  // character (they are stacked by y, up to ~95) and under the incident tint
  // (100), so tags and bubbles of whoever stands in front cannot cover it
  const bubbleText = shouldShowBubble(agent.state) && agent.statusText ? agent.statusText : null
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    if (!bubbleText) { setSpeaking(false); return }
    setSpeaking(true)
    const timer = setTimeout(() => setSpeaking(false), BUBBLE_MS)
    return () => clearTimeout(timer)
  }, [bubbleText])

  const isMoving = agent.state === 'new-hire' || agent.state === 'walking-to-desk' || agent.state === 'walking-to-manager' ||
    agent.state === 'coffee-break' || agent.state === 'completed' || agent.state === 'changing-room'

  // Calculate movement direction when walking
  const dx = agent.position.x - prevPosRef.current.x
  const dy = agent.position.y - prevPosRef.current.y

  if (isMoving && (Math.abs(dx) > 0.005 || Math.abs(dy) > 0.005)) {
    directionRef.current = getDirectionFromDelta(dx, dy)
  } else if (!isMoving && agent.spriteFacing) {
    // At a spot — use the spot's facing direction (or opposite if turned around)
    directionRef.current = turnedAround ? OPPOSITE[agent.spriteFacing] : agent.spriteFacing
  }
  prevPosRef.current = { x: agent.position.x, y: agent.position.y }

  // Randomly turn around while working at desk for random durations
  useEffect(() => {
    if (agent.state !== 'working') {
      setTurnedAround(false)
      return
    }

    // cancelledRef prevents stale callbacks from firing after cleanup
    const cancelledRef = { current: false }
    let timeout: ReturnType<typeof setTimeout>

    const scheduleTurn = () => {
      if (cancelledRef.current) return
      // Wait 3–15 seconds before turning
      const waitTime = 3000 + Math.random() * 12000
      timeout = setTimeout(() => {
        if (cancelledRef.current) return
        setTurnedAround(prev => !prev)
        // Stay turned for 1–6 seconds then maybe turn back
        const stayTime = 1000 + Math.random() * 5000
        timeout = setTimeout(() => {
          if (cancelledRef.current) return
          setTurnedAround(prev => !prev)
          scheduleTurn()
        }, stayTime)
      }, waitTime)
    }

    scheduleTurn()
    return () => {
      cancelledRef.current = true
      clearTimeout(timeout)
    }
  }, [agent.state])

  const animState = getAnimState(agent.state)
  const charBase = getCharBase(agent.role)
  const theme = useTheme() // Why: re-render on theme toggle so sprite path updates
  const spriteSrc = getSpritePath(agent.id, agent.role, charBase, directionRef.current)
  void theme
  const variant = useVariant() // Why: re-render when incident mode flips so the failure bubble shows/hides
  void variant

  // A session's Claude wears its main-thread state: a hand up while it waits on
  // you, a warning on an API error, a broom during a memory wipe, a glass of
  // water while its background workers are still out, the typing bubble while
  // a turn runs, and sleeping.png once it has been idle for 30 s (getEffect).
  const main = isMainAgent(agent)
  const mainState = main ? agent.mainState : undefined
  const needsYou = mainState === 'needs-you' ? agent.needsYou : undefined
  const hardNeedsYou = isHardNeedsYou(needsYou)
  // A deploy shipping, a red run, a push to main: shown unless a hand is up or the API failed
  const scene = agent.state !== 'completed' ? agent.scene : undefined
  let effectSrc: string | null = null
  let badge: { text: string; cls: string } | null = null
  if (isTyping) effectSrc = '/sprites/effects/typing.png'
  else if (needsYou) badge = { text: needsYouBadge(needsYou.kind), cls: hardNeedsYou ? 'needs-you' : 'soft' }
  else if (mainState === 'error') badge = { text: '⚠', cls: 'error' }
  else if (scene) effectSrc = SCENE_SPRITES[scene.kind]
  else if (mainState === 'compacting') effectSrc = null
  else if (mainState === 'waiting') effectSrc = '/sprites/effects/glass-water.png'
  else if (mainState === 'working' && agent.state === 'working') effectSrc = '/sprites/effects/typing.png'
  else effectSrc = getEffect(agent.state, idleDurationMs, agent.statusText, agent.id, agent.task, agent.role, agent.lastFailed)

  const projectTag = showProject && agent.project ? agent.project : null
  // The state label under the sprite replaces the project tag (which it then carries)
  const stateLabel = needsYou
    ? `${needsYouShort(needsYou.kind)}${projectTag ? ` · ${projectTag}` : ''}`
    : mainState === 'error' ? `⚠ API error${projectTag ? ` · ${projectTag}` : ''}` : null
  const tooltip = [agent.name, projectTag, main && agent.statusText ? `— ${agent.statusText}` : null].filter(Boolean).join(' ')

  return (
    <div
      className={`character-wrapper state-${animState}${mainState ? ` main-${mainState}` : ''}${scene ? ` scene-${scene.kind}` : ''}${onClick ? ' clickable' : ''}${inspected ? ' inspected' : ''}`}
      style={{
        left: `${agent.position.x}%`,
        top: `${agent.position.y}%`,
        transform: 'translate(-50%, -100%)',
        zIndex: speaking ? SPEAKING_Z : zIndex ?? Math.round(agent.position.y),
      }}
      title={projectTag || main ? tooltip : undefined}
      data-main-state={mainState}
    >
      {effectSrc && <EffectBubble src={effectSrc} alt={agent.state} />}
      {badge && <div className={`effect-bubble effect-emoji ${badge.cls}`} role="img" aria-label={agent.statusText}>{badge.text}</div>}
      {mainState === 'compacting' && (
        <div className="char-wipe" aria-label="memory wipe"><span className="char-wipe-broom">🧹</span></div>
      )}

      {stateLabel ? (
        <div className={mainState === 'error' ? 'char-error' : `char-needs-you ${hardNeedsYou ? 'hard' : 'soft'}`}>{stateLabel}</div>
      ) : scene?.kind === 'shipping' ? (
        // The label names what ships (the target, else the project), so it stands in for the project tag
        <div className="char-scene">{scene.label ?? '🚀 shipping'}</div>
      ) : projectTag && (
        <div className="char-project">{projectTag}</div>
      )}

      {agent.state === 'waiting' && (
        <div className="char-waiting">waiting for a desk</div>
      )}

      {!!agent.unread && (
        <div className="char-unread" title={`${agent.unread} unread message${agent.unread === 1 ? '' : 's'}`}>
          ✉ {agent.unread > 9 ? '9+' : agent.unread}
        </div>
      )}

      {bubbleText && (
        // The boss handing a prompt over at Claude's desk (purple bubble); any other visitor keeps the plain one
        <SpeechBubble key={bubbleText} text={bubbleText} isManager={agent.role === BOSS_ROLE} duration={BUBBLE_MS} />
      )}

      <div
        className="char-body-group"
        // The sprite alone takes the click (the wrapper stays pointer-events: none)
        onClick={onClick ? () => onClick(agent.id) : undefined}
        role={onClick ? 'button' : undefined}
        aria-label={onClick ? `Inspect ${agent.name}` : undefined}
        aria-pressed={onClick ? !!inspected : undefined}
        data-agent-id={agent.id}
      >
        <div className="char-shadow" />
        <ResilientImg
          src={spriteSrc}
          alt={agent.name}
          className="char-sprite"
          style={{
            height: agent.id.startsWith('boss-') ? 85 : 78,
            width: 'auto',
            filter: `drop-shadow(0 0 1px ${agent.color}) drop-shadow(0 0 0.5px #000)`,
            animationDelay: `${(agent.id.charCodeAt(0) * 0.37) % 3}s`,
          }}
          draggable={false}
        />
      </div>
    </div>
  )
}

// Why: the animation tick re-renders App up to 60 times a second while anyone
// walks; an agent whose object did not change keeps its previous render
export default React.memo(Character)
