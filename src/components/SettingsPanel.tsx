/**
 * SettingsPanel - one place for the office's settings, opened from the gear
 * in the title bar.
 *
 *   This browser   theme (src/theme.ts), day/night, season, sound — kept in
 *                  localStorage (src/settings.ts; the theme in its own key)
 *   Office server  answer permissions, prompt logging (POST /settings with
 *                  the UI token) and the AI chat monitor (POST
 *                  /chat/cron-state) — src/serverSettings.ts, shared with
 *                  the chat header's pills, which stay as they were
 *
 * The server controls are disabled, with the reason, on a read-only page
 * (no office token, so no UI token: the server would refuse), under ?sim /
 * ?video (no server) and while the server has not answered GET /settings.
 *
 * The season is judged once per page load (src/season.ts), so changing it
 * offers a reload rather than swapping every sprite under the user. The boss
 * sprite is a server-side file (office.config.json) and is only pointed at.
 */

import React, { useEffect, useRef } from 'react'
import { useTheme, setTheme, type ThemeName } from '../theme'
import { currentSeason } from '../season'
import {
  readSeasonPreference, saveSeasonPreference, seasonFromUrl,
  type DayNightMode, type SeasonPreference,
} from '../settings'
import {
  useServerSettings, setAnswerPermissions, setLogPrompts, setAiPaused,
  LOG_PROMPTS_LEVELS, type LogPromptsLevel,
} from '../serverSettings'
import '../styles/settings.css'

interface SettingsPanelProps {
  onClose: () => void
  /** The gear button: focus goes back to it on close, and a click on it is the toggle */
  anchor: React.RefObject<HTMLElement>
  dayNightMode: DayNightMode
  onDayNightMode: (mode: DayNightMode) => void
  volume: number
  muted: boolean
  onVolumeChange: (v: number) => void
  onToggleMute: () => void
  /** No office token: the server settings are shown but cannot be changed */
  readOnly: boolean
  /** ?sim / ?video: there is no server to change */
  simMode: boolean
}

interface Choice<T extends string> { value: T; label: string }

/** A row of mutually exclusive buttons (a radio group that looks like the title bar's pills). */
function Segmented<T extends string>({ label, value, choices, onChange, disabled = false, testId }: {
  label: string; value: T | null; choices: Choice<T>[]; onChange: (v: T) => void; disabled?: boolean; testId?: string
}) {
  return (
    <div className="sp-segmented" role="radiogroup" aria-label={label} data-testid={testId}>
      {choices.map(c => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          className={value === c.value ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(c.value)}
        >{c.label}</button>
      ))}
    </div>
  )
}

/** An on/off switch. */
function Switch({ label, on, onChange, disabled = false, testId }: {
  label: string; on: boolean | null; onChange: (v: boolean) => void; disabled?: boolean; testId?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on === true}
      aria-label={label}
      className={`sp-switch${on ? ' on' : ''}`}
      disabled={disabled || on === null}
      onClick={() => on !== null && onChange(!on)}
      data-testid={testId}
    >
      <span className="sp-switch-track"><span className="sp-switch-thumb" /></span>
      <span className="sp-switch-text">{on === null ? '—' : on ? 'On' : 'Off'}</span>
    </button>
  )
}

const THEMES: Choice<ThemeName>[] = [{ value: 'default', label: 'Default' }, { value: 'office', label: 'Dunder Mifflin' }]
const DAY_NIGHT: Choice<DayNightMode>[] = [{ value: 'auto', label: 'Auto' }, { value: 'day', label: 'Day' }, { value: 'night', label: 'Night' }]
const SEASONS: Choice<SeasonPreference>[] = [{ value: 'auto', label: 'Auto' }, { value: 'christmas', label: 'Christmas' }, { value: 'off', label: 'Off' }]
const LOG_LABEL: Record<LogPromptsLevel, string> = { off: 'Off', summary: 'Summary', full: 'Full' }
const LOG_HINT: Record<string, string> = {
  off: 'No prompt or reply text is stored or shown — states only.',
  summary: 'The first 200 characters of each prompt and reply.',
  full: 'Prompts and replies up to 2000 characters.',
}

// The season this page loaded with, and the URL's say: both fixed for the page's life
const URL_SEASON = typeof location === 'undefined' ? null : seasonFromUrl(location.search)
const LOADED_SEASON_PREF = readSeasonPreference()

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  onClose, anchor, dayNightMode, onDayNightMode, volume, muted, onVolumeChange, onToggleMute, readOnly, simMode,
}) => {
  const theme = useTheme()
  const server = useServerSettings()
  const [seasonPref, setSeasonPref] = React.useState<SeasonPreference>(LOADED_SEASON_PREF)
  const ref = useRef<HTMLDivElement>(null)

  // Focus the dialog on open; Escape or a click elsewhere closes it and hands focus back to the gear
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus()
    const gear = anchor.current
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      gear?.focus()
    }
  }, [onClose, anchor])

  const changeSeason = (pref: SeasonPreference) => {
    setSeasonPref(pref)
    saveSeasonPreference(pref)
  }

  // Why the reason first: a disabled control with no word on why reads as broken
  const serverBlocked = simMode
    ? 'No office server under ?sim / ?video — these settings belong to a live office.'
    : readOnly
      ? 'Read-only page: it has no office token, so the server would refuse a change. Open the link from npm run open to change these.'
      : server.logPrompts === null && server.answerPermissions === null
        ? 'The office server has not answered yet.'
        : null
  const serverDisabled = serverBlocked !== null

  return (
    <div className="settings-panel office-popover" role="dialog" aria-modal="false" aria-labelledby="sp-title" ref={ref} data-testid="settings-panel">
      <div className="op-head">
        <span className="op-title" id="sp-title">Settings</span>
        <button className="op-close" onClick={onClose} aria-label="Close settings">×</button>
      </div>

      <section className="sp-section" aria-label="This browser">
        <div className="sp-section-title">This browser</div>

        <div className="sp-row">
          <span className="sp-label">Theme</span>
          <Segmented label="Theme" value={theme} choices={THEMES} onChange={setTheme} testId="sp-theme" />
        </div>

        <div className="sp-row">
          <span className="sp-label">Day / night</span>
          <Segmented label="Day or night" value={dayNightMode} choices={DAY_NIGHT} onChange={onDayNightMode} testId="sp-daynight" />
        </div>

        <div className="sp-row">
          <span className="sp-label">Season</span>
          <Segmented label="Season" value={seasonPref} choices={SEASONS} onChange={changeSeason} testId="sp-season" />
        </div>
        {URL_SEASON && (
          <div className="sp-note">The address has <code>?season={URL_SEASON === 'off' ? 'none' : URL_SEASON}</code>, which wins over this.</div>
        )}
        {!URL_SEASON && seasonPref !== LOADED_SEASON_PREF && (
          <div className="sp-note">
            Applies on reload. <button type="button" className="sp-link" onClick={() => location.reload()}>Reload now</button>
          </div>
        )}
        {!URL_SEASON && seasonPref === 'auto' && seasonPref === LOADED_SEASON_PREF && (
          <div className="sp-note">Auto: Christmas from 1 December to 6 January{currentSeason() ? ' — on now' : ''}.</div>
        )}

        <div className="sp-row">
          <span className="sp-label">Sound</span>
          <div className="sp-sound">
            <button type="button" className="sp-mute" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted} data-testid="sp-mute">
              {muted ? '🔇' : volume < 0.4 ? '🔈' : '🔊'}
            </button>
            <input
              type="range" min="0" max="100"
              value={Math.round(volume * 100)}
              onChange={e => onVolumeChange(Number(e.target.value) / 100)}
              aria-label="Volume"
              className="sp-volume"
              data-testid="sp-volume"
            />
            <span className="sp-value">{muted ? 'muted' : `${Math.round(volume * 100)}%`}</span>
          </div>
        </div>
      </section>

      <section className="sp-section" aria-label="Office server">
        <div className="sp-section-title">Office server</div>
        {serverBlocked && <div className="sp-note sp-blocked" data-testid="sp-server-blocked">{serverBlocked}</div>}

        <div className="sp-row">
          <span className="sp-label" title="Permission dialogs can be answered from a card in the office while Claude waits">Answer permissions here</span>
          <Switch label="Answer permissions here" on={server.answerPermissions} onChange={v => void setAnswerPermissions(v)} disabled={serverDisabled} testId="sp-answer" />
        </div>

        <div className="sp-row">
          <span className="sp-label">Prompt logging</span>
          <Segmented
            label="Prompt logging"
            value={server.logPrompts as LogPromptsLevel | null}
            choices={LOG_PROMPTS_LEVELS.map(v => ({ value: v, label: LOG_LABEL[v] }))}
            onChange={v => void setLogPrompts(v)}
            disabled={serverDisabled || server.logPrompts === null}
            testId="sp-logprompts"
          />
        </div>
        {server.logPrompts && <div className="sp-note">{LOG_HINT[server.logPrompts] ?? ''} Rows already in chat.db stay until <code>/clear</code>.</div>}

        <div className="sp-row">
          <span className="sp-label" title="The chat watcher that lets Claude answer #office-general">AI chat monitor</span>
          <Switch label="AI chat monitor" on={server.aiPaused === null ? null : !server.aiPaused} onChange={v => void setAiPaused(!v)} disabled={serverDisabled} testId="sp-ai" />
        </div>

        <div className="sp-note sp-foot">Boss sprite: <code>boss.sprite</code> in <code>office.config.json</code> (read when the server starts).</div>
      </section>
    </div>
  )
}

export default SettingsPanel
