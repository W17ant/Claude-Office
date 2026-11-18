/**
 * LanguagePicker - the Settings row that puts the whole office in one
 * language, with a "Report a translation error" link under it.
 *
 * Each language is listed by its own name; a draft says so ("work in
 * progress") and a partial one says how much is translated, so nobody
 * mistakes an agent's draft for a checked translation.
 */
import React from 'react'
import { useT, reportUrl, t, type LanguageInfo } from '../i18n'

/** "Deutsch · 87% translated · work in progress" */
export function languageOptionLabel(info: LanguageInfo): string {
  const parts = [info.name]
  if (info.completeness < 100) parts.push(t('ui.settings.language.complete', { percent: info.completeness }))
  if (info.status === 'wip') parts.push(t('ui.settings.language.wip'))
  return parts.join(' · ')
}

interface LanguagePickerProps {
  languages: LanguageInfo[]
  /** The language the office is in */
  value: string
  /** False on a read-only page: the server would refuse the change */
  canChange: boolean
  onChange: (code: string) => void
}

const LanguagePicker: React.FC<LanguagePickerProps> = ({ languages, value, canChange, onChange }) => {
  const tr = useT()
  return (
    <>
      <div className="sp-row">
        <span className="sp-label">{tr('ui.settings.language.title')}</span>
        <select
          className="sp-select sp-language"
          aria-label={tr('ui.settings.language.title')}
          value={value}
          disabled={!canChange}
          onChange={e => onChange(e.target.value)}
          data-testid="language-picker"
        >
          {languages.map(l => <option key={l.code} value={l.code}>{languageOptionLabel(l)}</option>)}
        </select>
      </div>
      {!canChange && <div className="sp-note sp-blocked">{tr('ui.settings.language.readOnly')}</div>}
      <div className="sp-note">
        <a className="sp-link" href={reportUrl(value)} target="_blank" rel="noopener noreferrer" data-testid="language-report">
          {tr('ui.settings.language.report')}
        </a>
      </div>
    </>
  )
}

export default LanguagePicker
