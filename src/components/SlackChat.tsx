import React, { useEffect, useRef, useState, useCallback } from 'react'
import { ROLE_TO_CHAR } from '../config'

function getAvatarSrc(role: string): string {
  const charBase = ROLE_TO_CHAR[role] ?? 'employee-3'
  return `/sprites/characters/${charBase}-front-right.png`
}

// Proactive message detection: agent announcements about starting/completing work
const PROACTIVE_PATTERN = /\b(starting|started|done|finished|completed|ready|working on|picking up|taking over)\b/i

export interface ChatMessage {
  id: number
  sender: string
  senderSprite: string
  senderColor: string
  text: string
  channel: string
  timestamp: string
  isSystem?: boolean
  reactions?: string[]
}

interface SlackChatProps {
  messages: ChatMessage[]
  muted: boolean
  volume: number
  onToggleMute: () => void
  onVolumeChange: (v: number) => void
  onSendMessage?: (text: string) => void
  /** For video mode: auto-type text into the input box */
  autoTypeText?: string
  dayPhase: string
  /** Role/name currently typing — shows animated dots below the message list */
  typingUser?: string | null
  /** ID of the last message seen by the assistant — renders a tiny seen avatar */
  lastSeenId?: number | null
}

const SlackChat: React.FC<SlackChatProps> = ({ messages, muted, volume, onToggleMute, onVolumeChange, onSendMessage, autoTypeText, dayPhase, typingUser, lastSeenId }) => {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [inputText, setInputText] = useState('')
  const [showSlashHint, setShowSlashHint] = useState(false)
  const onSendRef = useRef(onSendMessage)
  onSendRef.current = onSendMessage

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

      <div className="slack-body" ref={bodyRef}>
        {displayed.map((msg) => {
          const isProactive = !msg.isSystem && PROACTIVE_PATTERN.test(msg.text)
          return (
            <React.Fragment key={msg.id}>
              <div className={`slack-msg${msg.isSystem ? ' slack-msg-system' : ''}${isProactive ? ' slack-msg-proactive' : ''}`}>
                {!msg.isSystem && (
                  <div className="slack-avatar" style={{ border: `2px solid ${msg.senderColor}`, boxShadow: `0 0 6px ${msg.senderColor}40` }}>
                    <img
                      src={getAvatarSrc(msg.senderSprite)}
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
                        {msg.sender}
                      </span>
                      <span className="slack-time">{msg.timestamp}</span>
                    </div>
                  )}
                  <div className={`slack-msg-text${msg.isSystem ? ' slack-system-text' : ''}`}>
                    {msg.text}
                  </div>
                  {msg.reactions && msg.reactions.length > 0 && (
                    <div className="slack-reactions">
                      {msg.reactions.map((r, i) => (
                        <span key={i} className="slack-reaction">{r}</span>
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
                onSendMessage?.(inputText.trim())
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

export default SlackChat
