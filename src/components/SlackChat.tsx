import React, { useEffect, useRef, useState, useCallback } from 'react'
import { ROLE_TO_CHAR } from '../config'
import { getSpritePath, useTheme, toggleTheme, getTheme, themedDisplayName } from '../theme'
import IncidentBadge from './IncidentBadge'
import { postSetting } from '../permissions'

export function getAvatarSrc(role: string, agentId?: string): string {
  const charBase = ROLE_TO_CHAR[role] ?? 'employee-3'
  // Why: avatars in chat use agent.id when available so Office casting stays consistent
  return getSpritePath(agentId ?? `role-${role}`, role, charBase, 'front-right')
}

// Proactive message detection: agent announcements about starting/completing work
const PROACTIVE_PATTERN = /\b(starting|started|done|finished|completed|ready|working on|picking up|taking over)\b/i

export interface ChatMessage {
  /** The server's chat row id for rows it broadcast; negative for local-only lines */
  id: number
  sender: string
  senderSprite: string
  senderColor: string
  text: string
  channel: string
  timestamp: string
  isSystem?: boolean
  reactions?: string[]
  /** Name and avatar as they were when the line was posted (the Office cast may change later) */
  displayName?: string
  avatarSrc?: string
  /** A prompt the boss typed in a terminal, or the session's Claude's reply (session_prompt / session_turn_end) */
  tag?: 'prompt' | 'reply'
}

const EMOJI_PICKER = ['👍', '👎', '😊', '🎉', '😡', '🔥', '💯']

// The server's prompt-logging level (GET /settings). Changing it needs the
// office bearer token, which the browser does not have, so the chat header
// only shows the level and how to change it. Absent until the route exists.
const SETTINGS_URL = 'http://127.0.0.1:3334/settings'
const LOG_PROMPTS_WHAT: Record<string, string> = {
  off:     'state only — no prompt or reply text is stored, broadcast or shown',
  summary: 'the first 200 characters of each prompt and reply',
  full:    'prompts and replies up to 2000 characters',
}
function logPromptsHint(level: string): string {
  return [
    `Prompt logging: ${level} — ${LOG_PROMPTS_WHAT[level] ?? 'unknown level'}.`,
    'A server setting (~/.agent-office/settings.json); change it with the office token:',
    `curl -X POST ${SETTINGS_URL} -H "Authorization: Bearer $(cat ~/.agent-office/auth-token)" -H 'Content-Type: application/json' -d '{"logPrompts":"${level === 'off' ? 'summary' : 'off'}"}'`,
  ].join('\n')
}

interface SlackChatProps {
  messages: ChatMessage[]
  muted: boolean
  volume: number
  onToggleMute: () => void
  onVolumeChange: (v: number) => void
  onSendMessage?: (text: string) => void
  onReaction?: (messageId: number, reactions: string[]) => void
  /** For video mode: auto-type text into the input box */
  autoTypeText?: string
  dayPhase: string
  /** Role/name currently typing — shows animated dots below the message list */
  typingUser?: string | null
  /** ID of the last message seen by the assistant — renders a tiny seen avatar */
  lastSeenId?: number | null
}

const SlackChat: React.FC<SlackChatProps> = ({ messages, muted, volume, onToggleMute, onVolumeChange, onSendMessage, onReaction, autoTypeText, dayPhase, typingUser, lastSeenId }) => {
  const theme = useTheme()
  void theme // Why: subscribe so avatars re-render when /the-office toggles
  const bodyRef = useRef<HTMLDivElement>(null)
  const [inputText, setInputText] = useState('')
  const [showSlashHint, setShowSlashHint] = useState(false)
  const [emojiPickerMsgId, setEmojiPickerMsgId] = useState<number | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const onSendRef = useRef(onSendMessage)
  onSendRef.current = onSendMessage

  // Close emoji picker on click outside
  useEffect(() => {
    if (emojiPickerMsgId === null) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setEmojiPickerMsgId(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [emojiPickerMsgId])

  const handleReaction = useCallback((msg: ChatMessage, emoji: string) => {
    const existing = msg.reactions || []
    const updated = existing.includes(emoji)
      ? existing.filter(r => r !== emoji)
      : [...existing, emoji]
    onReaction?.(msg.id, updated)
    setEmojiPickerMsgId(null)
  }, [onReaction])

  // Prompt-logging level — read-only in the UI (see logPromptsHint); silent when the route is missing.
  // The same GET /settings also says whether permission dialogs may be answered here.
  const [logPrompts, setLogPrompts] = useState<string | null>(null)
  const [answerHere, setAnswerHere] = useState<boolean | null>(null)
  useEffect(() => {
    fetch(SETTINGS_URL, { signal: AbortSignal.timeout(2000) })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d && typeof d.logPrompts === 'string') setLogPrompts(d.logPrompts)
        if (d && typeof d.answerPermissions === 'boolean') setAnswerHere(d.answerPermissions)
      })
      .catch(() => {})
  }, [])

  // Answer permissions from the office (answerPermissions) — the one setting
  // the page may change: POST /settings with the UI token from the snapshot
  // (src/permissions.ts). Optimistic; put back if the server said no.
  const toggleAnswerHere = useCallback(() => {
    if (answerHere === null) return
    const next = !answerHere
    setAnswerHere(next)
    postSetting({ answerPermissions: next }).then(ok => { if (!ok) setAnswerHere(answerHere) })
  }, [answerHere])

  // Cron/chat-monitor pause toggle
  const [cronPaused, setCronPaused] = useState(false)

  // Load initial state from server
  useEffect(() => {
    fetch('http://127.0.0.1:3334/chat/cron-state')
      .then(r => r.json())
      .then(d => setCronPaused(!!d.paused))
      .catch(() => {})
  }, [])

  const toggleCron = useCallback(() => {
    const newState = !cronPaused
    setCronPaused(newState)
    // Update the state file via a simple POST
    fetch('http://127.0.0.1:3334/chat/cron-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: newState }),
    }).catch(() => {})
  }, [cronPaused])

  // Auto-type effect for video mode
  useEffect(() => {
    if (!autoTypeText) {
      setInputText('')
      return
    }
    setInputText('')
    let i = 0
    const interval = setInterval(() => {
      i++
      if (i <= autoTypeText.length) {
        setInputText(autoTypeText.slice(0, i))
      } else {
        clearInterval(interval)
        // Auto-send after typing finishes
        setTimeout(() => {
          onSendRef.current?.(autoTypeText)
          setInputText('')
        }, 400)
      }
    }, 50 + Math.random() * 30) // slightly random typing speed
    return () => clearInterval(interval)
  }, [autoTypeText])

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, typingUser])

  const displayed = messages.slice(-12)
  const onlineCount = new Set(messages.slice(-20).filter(m => !m.isSystem).map(m => m.sender)).size

  return (
    <div className="slack-panel">
      <div className="slack-header">
        <div className="slack-channel-icon">#</div>
        <span className="slack-channel-name">office-general</span>
        <div className="slack-header-right">
          <div className="slack-online-dot" />
          <span className="slack-online-count">{onlineCount}</span>
          {logPrompts && (
            <span className={`slack-logprompts ${logPrompts}`} title={logPromptsHint(logPrompts)} data-testid="log-prompts">
              prompts: {logPrompts}
            </span>
          )}
          {answerHere !== null && (
            <span
              className={`slack-answer-toggle ${answerHere ? 'on' : 'off'}`}
              onClick={toggleAnswerHere}
              title={answerHere
                ? 'Permission dialogs can be answered from the office (a card appears while Claude waits) — click to turn off'
                : 'Permission dialogs are answered in the terminal only — click to let the office answer them'}
              data-testid="answer-permissions"
            >
              Answer here: {answerHere ? 'on' : 'off'}
            </span>
          )}
          <div
            className={`slack-cron-toggle ${cronPaused ? 'paused' : 'active'}`}
            onClick={toggleCron}
            title={cronPaused ? 'Chat monitor paused — click to resume' : 'Chat monitor active — click to pause'}
          >
            <div className="slack-cron-track">
              <div className="slack-cron-thumb" />
            </div>
            <span className="slack-cron-label">{cronPaused ? 'AI Off' : 'AI On'}</span>
          </div>
          <button className="slack-mute-btn" onClick={onToggleMute}>
            {muted ? '🔇' : volume < 0.4 ? '🔈' : '🔊'}
          </button>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(volume * 100)}
            onChange={e => onVolumeChange(Number(e.target.value) / 100)}
            className="slack-volume-slider"
            title={`Volume: ${Math.round(volume * 100)}%`}
          />
        </div>
      </div>

      <IncidentBadge />

      <div className="slack-body" ref={bodyRef}>
        {displayed.map((msg) => {
          const isProactive = !msg.isSystem && PROACTIVE_PATTERN.test(msg.text)
          return (
            <React.Fragment key={msg.id}>
              <div
                className={`slack-msg${msg.isSystem ? ' slack-msg-system' : ''}${isProactive ? ' slack-msg-proactive' : ''}${msg.tag ? ` slack-msg-${msg.tag}` : ''}`}
                onDoubleClick={() => !msg.isSystem && setEmojiPickerMsgId(prev => prev === msg.id ? null : msg.id)}
              >
                {!msg.isSystem && (
                  <div className="slack-avatar" style={{ border: `2px solid ${msg.senderColor}`, boxShadow: `0 0 6px ${msg.senderColor}40` }}>
                    <img
                      src={msg.avatarSrc ?? getAvatarSrc(msg.senderSprite)}
                      alt={msg.sender}
                      className="slack-avatar-img"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none'
                      }}
                    />
                    <div
                      className="slack-avatar-fallback"
                      style={{ background: msg.senderColor }}
                    />
                  </div>
                )}
                <div className="slack-msg-content">
                  {!msg.isSystem && (
                    <div className="slack-msg-header">
                      <span className="slack-sender" style={{ color: msg.senderColor }}>
                        {msg.displayName ?? themedDisplayName(msg.senderSprite, msg.sender)}
                      </span>
                      {msg.tag && <span className={`slack-tag ${msg.tag}`}>{msg.tag}</span>}
                      <span className="slack-time">{msg.timestamp}</span>
                    </div>
                  )}
                  <div className={`slack-msg-text${msg.isSystem ? ' slack-system-text' : ''}`}>
                    {msg.text}
                  </div>
                  {msg.reactions && msg.reactions.length > 0 && (
                    <div className="slack-reactions">
                      {msg.reactions.map((r, i) => (
                        <span
                          key={i}
                          className="slack-reaction"
                          onClick={() => handleReaction(msg, r)}
                          title="Click to remove"
                        >{r}</span>
                      ))}
                    </div>
                  )}
                  {emojiPickerMsgId === msg.id && (
                    <div className="slack-emoji-picker" ref={pickerRef}>
                      {EMOJI_PICKER.map(emoji => (
                        <button
                          key={emoji}
                          className={`slack-emoji-btn${msg.reactions?.includes(emoji) ? ' active' : ''}`}
                          onClick={() => handleReaction(msg, emoji)}
                        >{emoji}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {lastSeenId != null && msg.id === lastSeenId && (
                <div className="slack-seen-row">
                  <span className="slack-seen-label">Seen</span>
                  <img src={getAvatarSrc('assistant')} className="slack-seen-avatar" alt="seen" />
                </div>
              )}
            </React.Fragment>
          )
        })}
        {typingUser && (
          <div className="slack-msg slack-typing-row">
            <div className="slack-avatar" style={{ border: '2px solid #cc785c', boxShadow: '0 0 6px #cc785c40' }}>
              <img src={getAvatarSrc('assistant')} alt="typing" className="slack-avatar-img" />
            </div>
            <div className="slack-msg-content">
              <div className="slack-typing-label">{typingUser} is typing</div>
              <div className="slack-typing-dots"><span/><span/><span/></div>
            </div>
          </div>
        )}
      </div>

      <div className="slack-input-wrap">
        {showSlashHint && (
          <div className="slack-slash-hint">
            <span className="slack-slash-cmd">/status</span>
            <span className="slack-slash-cmd">/agents</span>
            <span className="slack-slash-cmd">/help</span>
            <span className="slack-slash-cmd">/the-office</span>
            <span className="slack-slash-cmd">/incident</span>
            <span className="slack-slash-cmd">/all-clear</span>
          </div>
        )}
        <div className="slack-input-bar">
          <input
            type="text"
            className="slack-input-field"
            placeholder="Message #office-general"
            value={inputText}
            onChange={e => {
              const val = e.target.value
              setInputText(val)
              setShowSlashHint(val === '/')
            }}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                setShowSlashHint(false)
                return
              }
              if (e.key === 'Enter' && inputText.trim()) {
                const trimmed = inputText.trim()
                // Client-side slash commands — not sent to backend
                if (trimmed === '/the-office' || trimmed === '/theoffice') {
                  toggleTheme()
                  const nowOn = getTheme() === 'office'
                  onSendMessage?.(nowOn ? '🧻 Dunder Mifflin mode: ON. Identity theft is not a joke.' : '🔁 Office theme: OFF')
                } else {
                  onSendMessage?.(trimmed)
                }
                setInputText('')
                setShowSlashHint(false)
              }
            }}
            onBlur={() => setTimeout(() => setShowSlashHint(false), 150)}
          />
        </div>
      </div>
    </div>
  )
}

// Why: App re-renders every animation frame while anyone walks; the panel only
// needs to when a message, the typing indicator or a control changes
export default React.memo(SlackChat)
