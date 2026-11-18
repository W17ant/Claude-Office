/**
 * SettingsPanel - one place for the office's settings, opened from the gear
 * in the title bar.
 *
 *   This browser   theme (src/theme.ts), day/night, season, sound, ambience — kept in
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
 * offers a reload rather than swapping every sprite under the user. It is a
 * drop-down, not a row of buttons like its neighbours: Auto, four holidays,
 * four seasons and Off are ten choices, and the panel is 300 px wide. The
 * boss sprite is a server-side file (office.config.json) and is only pointed at.
 */

import React, { useEffect, useRef } from 'react'
import { useTheme, setTheme, type ThemeName } from '../theme'
import { currentSeason, currentQuarter, seasonHasArt, useSeasonArt, type Season } from '../season'
import { HOLIDAYS, QUARTERS } from '../seasonNames'
import {
  readSeasonPreference, saveSeasonPreference, seasonFromUrl,
  type DayNightMode, type SeasonPreference,
} from '../settings'
import {
  useServerSettings, setAnswerPermissions, setLogPrompts, setAiPaused, setNotifyPermissions, setLanguage,
  LOG_PROMPTS_LEVELS, type LogPromptsLevel,
} from '../serverSettings'
import LanguagePicker from './LanguagePicker'
import { applyLanguage, currentLanguage, languageList, reportUrl, t, useT } from '../i18n'
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
  /** The ambient office bed on/off (src/sounds.ts); it follows volume and mute */
  ambience: boolean
  onAmbienceChange: (on: boolean) => void
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

/**
 * A drop-down, for a setting with more choices than a row of buttons has room
 * for. A native <select>: the keyboard, the screen reader and the pop-up list
 * all come with it, and a list that opens over the panel cannot be clipped by
 * the panel's own scrolling the way a hand-made one would.
 */
function Select<T extends string>({ label, value, groups, onChange, testId }: {
  label: string; value: T; groups: { label?: string; choices: Choice<T>[] }[]; onChange: (v: T) => void; testId?: string
}) {
  const options = (choices: Choice<T>[]) => choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)
  return (
    <select className="sp-select" aria-label={label} value={value} onChange={e => onChange(e.target.value as T)} data-testid={testId}>
      {groups.map((g, i) => g.label
        ? <optgroup key={g.label} label={g.label}>{options(g.choices)}</optgroup>
        : <React.Fragment key={i}>{options(g.choices)}</React.Fragment>)}
    </select>
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
      <span className="sp-switch-text">{on === null ? '—' : on ? t('ui.settings.on') : t('ui.settings.off')}</span>
    </button>
  )
}

// Why functions, not constants: the labels follow the office's language, so
// they are built at render time
// "Dunder Mifflin" is the theme's name, not a phrase: it stays as it is
const themes = (): Choice<ThemeName>[] => [{ value: 'default', label: t('ui.settings.browser.themeDefault') }, { value: 'office', label: 'Dunder Mifflin' }]
const dayNight = (): Choice<DayNightMode>[] => [
  { value: 'auto', label: t('ui.settings.browser.auto') }, { value: 'day', label: t('ui.settings.browser.day') }, { value: 'night', label: t('ui.settings.browser.night') },
]
function seasonLabel(s: Season): string {
  switch (s) {
    case 'christmas': return t('ui.seasons.christmas')
    case 'halloween': return t('ui.seasons.halloween')
    case 'easter': return t('ui.seasons.easter')
    case 'valentine': return t('ui.seasons.valentine')
    case 'spring': return t('ui.seasons.spring')
    case 'summer': return t('ui.seasons.summer')
    case 'autumn': return t('ui.seasons.autumn')
    case 'winter': return t('ui.seasons.winter')
  }
}
const seasonChoices = (names: readonly Season[]): Choice<SeasonPreference>[] => names.map(s => ({ value: s, label: seasonLabel(s) }))
// Why grouped: a holiday and a season behave differently when picked by hand
// (a holiday keeps the date's season under it, a season shows no holiday)
const seasonGroups = (): { label?: string; choices: Choice<SeasonPreference>[] }[] => [
  { choices: [{ value: 'auto', label: t('ui.settings.browser.seasonAuto') }] },
  { label: t('ui.settings.browser.holidays'), choices: seasonChoices(HOLIDAYS) },
  { label: t('ui.settings.browser.seasons'), choices: seasonChoices(QUARTERS) },
  { choices: [{ value: 'off', label: t('ui.settings.browser.seasonOff') }] },
]
function logLabel(level: LogPromptsLevel): string {
  switch (level) {
    case 'off': return t('ui.settings.server.logOff')
    case 'summary': return t('ui.settings.server.logSummary')
    case 'full': return t('ui.settings.server.logFull')
  }
}
function logHint(level: string): string {
  switch (level) {
    case 'off': return t('ui.settings.server.hintOff')
    case 'summary': return t('ui.settings.server.hintSummary')
    case 'full': return t('ui.settings.server.hintFull')
    default: return ''
  }
}

// The season this page loaded with, and the URL's say: both fixed for the page's life
const URL_SEASON = typeof location === 'undefined' ? null : seasonFromUrl(location.search)
const LOADED_SEASON_PREF = readSeasonPreference()

/**
 * What this page loaded with, top layer first: "Christmas over Winter".
 * A layer nobody has drawn yet says so, because picking it changes nothing on
 * screen and that would otherwise read as the setting being broken.
 * @returns the sentence fragment, and whether any layer in it has no art
 */
function lookNow(): { text: string; undrawn: boolean } {
  const layers = [currentSeason(), currentQuarter()].filter((s): s is Season => s !== null)
  const undrawn = layers.filter(s => seasonHasArt(s) === false)
  return {
    text: layers.map(s => (undrawn.includes(s) ? t('ui.settings.browser.noArtYet', { season: seasonLabel(s) }) : seasonLabel(s)))
      .reduce((top, below) => t('ui.settings.browser.over', { top, below })),
    undrawn: undrawn.length > 0,
  }
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({
  onClose, anchor, dayNightMode, onDayNightMode, volume, muted, onVolumeChange, onToggleMute, ambience, onAmbienceChange, readOnly, simMode,
}) => {
  const theme = useTheme()
  const server = useServerSettings()
  const tr = useT()
  useSeasonArt() // Why: re-render when a season turns out to have art or not (the "no art yet" note)
  const [seasonPref, setSeasonPref] = React.useState<SeasonPreference>(LOADED_SEASON_PREF)
  const ref = useRef<HTMLDivElement>(null)

  // Focus the dialog on open; Escape or a click elsewhere closes it and hands focus back to the gear
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input, select')?.focus()
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
    ? tr('ui.settings.server.sim')
    : readOnly
      ? tr('ui.settings.server.readOnly')
      : server.logPrompts === null && server.answerPermissions === null
        ? tr('ui.settings.server.waiting')
        : null
  const serverDisabled = serverBlocked !== null

  // What is in force on this page (the address wins over the stored choice)
  // and what it looks like, for the note under the season row
  const seasonInForce = URL_SEASON ?? LOADED_SEASON_PREF
  const seasonPending = !URL_SEASON && seasonPref !== LOADED_SEASON_PREF
  const look = seasonInForce === 'off' ? null : lookNow()

  return (
    <div className="settings-panel office-popover" role="dialog" aria-modal="false" aria-labelledby="sp-title" ref={ref} data-testid="settings-panel">
      <div className="op-head">
        <span className="op-title" id="sp-title">{tr('ui.settings.title')}</span>
        <button className="op-close" onClick={onClose} aria-label={tr('ui.settings.close')}>×</button>
      </div>

      <section className="sp-section" aria-label={tr('ui.settings.language.title')}>
        <div className="sp-section-title">{tr('ui.settings.language.title')}</div>
        {/* Why sim changes it locally: ?sim and ?video have no server, and a
            translator wants to see their language there */}
        <LanguagePicker
          languages={languageList()}
          value={currentLanguage()}
          canChange={simMode || !readOnly}
          onChange={code => (simMode ? applyLanguage(code) : void setLanguage(code))}
        />
      </section>

      <section className="sp-section" aria-label={tr('ui.settings.browser.title')}>
        <div className="sp-section-title">{tr('ui.settings.browser.title')}</div>

        <div className="sp-row">
          <span className="sp-label">{tr('ui.settings.browser.theme')}</span>
          <Segmented label={tr('ui.settings.browser.theme')} value={theme} choices={themes()} onChange={setTheme} testId="sp-theme" />
        </div>

        <div className="sp-row">
          <span className="sp-label">{tr('ui.settings.browser.dayNight')}</span>
          <Segmented label={tr('ui.settings.browser.dayNightAria')} value={dayNightMode} choices={dayNight()} onChange={onDayNightMode} testId="sp-daynight" />
        </div>

        <div className="sp-row">
          <span className="sp-label">{tr('ui.settings.browser.season')}</span>
          <Select label={tr('ui.settings.browser.season')} value={seasonPref} groups={seasonGroups()} onChange={changeSeason} testId="sp-season" />
        </div>
        {URL_SEASON && (
          <div className="sp-note">{tr('ui.settings.browser.urlSeasonBefore')} <code>?season={URL_SEASON === 'off' ? 'none' : URL_SEASON}</code>{tr('ui.settings.browser.urlSeasonAfter')}</div>
        )}
        {seasonPending && (
          <div className="sp-note">
            {tr('ui.settings.browser.appliesOnReload')} <button type="button" className="sp-link" onClick={() => location.reload()}>{tr('ui.settings.browser.reloadNow')}</button>
          </div>
        )}
        {!seasonPending && look && seasonInForce === 'auto' && (
          <div className="sp-note" data-testid="sp-season-now">
            {tr('ui.settings.browser.autoExplained', { look: look.text })}
          </div>
        )}
        {!seasonPending && look && seasonInForce !== 'auto' && look.undrawn && (
          <div className="sp-note" data-testid="sp-season-now">{tr('ui.settings.browser.nowUndrawn', { look: look.text })}</div>
        )}

        <div className="sp-row">
          <span className="sp-label">{tr('ui.settings.browser.sound')}</span>
          <div className="sp-sound">
            <button type="button" className="sp-mute" onClick={onToggleMute} aria-label={muted ? tr('ui.settings.browser.unmute') : tr('ui.settings.browser.mute')} aria-pressed={muted} data-testid="sp-mute">
              {muted ? '🔇' : volume < 0.4 ? '🔈' : '🔊'}
            </button>
            <input
              type="range" min="0" max="100"
              value={Math.round(volume * 100)}
              onChange={e => onVolumeChange(Number(e.target.value) / 100)}
              aria-label={tr('ui.settings.browser.volume')}
              className="sp-volume"
              data-testid="sp-volume"
            />
            <span className="sp-value">{muted ? tr('ui.settings.browser.muted') : `${Math.round(volume * 100)}%`}</span>
          </div>
        </div>

        <div className="sp-row">
          <span className="sp-label" title={tr('ui.settings.browser.ambienceTitle')}>{tr('ui.settings.browser.ambience')}</span>
          <Switch label={tr('ui.settings.browser.ambience')} on={ambience} onChange={onAmbienceChange} testId="sp-ambience" />
        </div>
      </section>

      <section className="sp-section" aria-label={tr('ui.settings.server.title')}>
        <div className="sp-section-title">{tr('ui.settings.server.title')}</div>
        {serverBlocked && <div className="sp-note sp-blocked" data-testid="sp-server-blocked">{serverBlocked}</div>}

        <div className="sp-row">
          <span className="sp-label" title={tr('ui.settings.server.answerTitle')}>{tr('ui.settings.server.answer')}</span>
          <Switch label={tr('ui.settings.server.answer')} on={server.answerPermissions} onChange={v => void setAnswerPermissions(v)} disabled={serverDisabled} testId="sp-answer" />
        </div>

        <div className="sp-row">
          <span className="sp-label" title={tr('ui.settings.server.notifyTitle')}>{tr('ui.settings.server.notify')}</span>
          <Switch label={tr('ui.settings.server.notify')} on={server.notifyPermissions} onChange={v => void setNotifyPermissions(v)} disabled={serverDisabled} testId="sp-notify" />
        </div>

        <div className="sp-row">
          <span className="sp-label">{tr('ui.settings.server.logging')}</span>
          <Segmented
            label={tr('ui.settings.server.logging')}
            value={server.logPrompts as LogPromptsLevel | null}
            choices={LOG_PROMPTS_LEVELS.map(v => ({ value: v, label: logLabel(v) }))}
            onChange={v => void setLogPrompts(v)}
            disabled={serverDisabled || server.logPrompts === null}
            testId="sp-logprompts"
          />
        </div>
        {server.logPrompts && <div className="sp-note">{logHint(server.logPrompts)} {tr('ui.settings.server.rowsStay')} <code>/clear</code>.</div>}

        <div className="sp-row">
          <span className="sp-label" title={tr('ui.settings.server.aiTitle')}>{tr('ui.settings.server.ai')}</span>
          <Switch label={tr('ui.settings.server.ai')} on={server.aiPaused === null ? null : !server.aiPaused} onChange={v => void setAiPaused(!v)} disabled={serverDisabled} testId="sp-ai" />
        </div>

        <div className="sp-note sp-foot">{tr('ui.settings.server.bossSprite')} <code>boss.sprite</code> {tr('ui.settings.server.bossSpriteIn')} <code>office.config.json</code> {tr('ui.settings.server.bossSpriteWhen')}</div>
      </section>

      <div className="sp-note sp-foot">
        <a className="sp-link" href={reportUrl(currentLanguage())} target="_blank" rel="noopener noreferrer">{tr('ui.settings.language.report')}</a>
      </div>
    </div>
  )
}

export default SettingsPanel
