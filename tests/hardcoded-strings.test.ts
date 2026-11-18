/**
 * hardcoded-strings.test.ts - no English left written straight into the
 * page's components: every visible word comes through t() and en.json, so
 * a translation reaches it. Scans JSX text and the attributes people read
 * (title, aria-label, placeholder, alt) in the files that are in scope.
 *
 * Out of scope (stay English, see the spec): the /?helper and /?fithelper
 * authoring tools, ?sim / ?video / demo content.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** Files whose visible text must come from en.json. */
const IN_SCOPE = [
  'src/App.tsx',
  'src/components/SettingsPanel.tsx',
  'src/components/LanguagePicker.tsx',
  'src/components/StatusStrip.tsx',
  'src/components/SessionStrip.tsx',
  'src/components/Meters.tsx',
  'src/components/TodayPanel.tsx',
  'src/components/RoomSwitcher.tsx',
  'src/components/TaskBoard.tsx',
  'src/components/IncidentBadge.tsx',
  'src/components/AgentCard.tsx',
  'src/components/PermissionCard.tsx',
  'src/components/SlackChat.tsx',
  'src/components/PhoneOffice.tsx',
  'src/components/ViewerStage.tsx',
  'src/components/IncidentLayer.tsx',
  'src/components/AdventCalendar.tsx',
  'src/components/DeskScreens.tsx',
  'src/components/EffectBubble.tsx',
  'src/components/SpeechBubble.tsx',
  'src/components/DoorLinks.tsx',
  'src/components/FurnitureRenderer.tsx',
  'src/components/Character.tsx',
  'src/components/RoomLife.tsx',
  'src/components/RoomBackdrop.tsx',
]

/**
 * Literal text that is fine as it is, each with why. Matched against the
 * trimmed text found.
 */
const ALLOWED = new Set<string>([
  'JSON.parse(deskScreensKey) as Record', // a TypeScript generic the regex reads as a tag
  'Loading mask helper...', // the /?fithelper authoring tool: out of scope
  'Loading helper...', // the /?helper authoring tool: out of scope
])

// JSX text between tags with a run of three letters (not inside {…})
const JSX_TEXT = />([^<>{}]*[A-Za-z]{3}[^<>{}]*)</g
// A read attribute given a literal containing a letter
const ATTR = /\b(title|aria-label|placeholder|alt)="([^"]*[A-Za-z][^"]*)"/g

function findings(file: string): string[] {
  const out: string[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    for (const m of line.matchAll(JSX_TEXT)) {
      // Why: <code> holds commands, paths and file names, which stay English
      if (line.slice(0, m.index! + 1).endsWith('<code>')) continue
      const text = m[1].trim()
      // Why: "a => b" and generics (<T>…) look like tags to the regex; real text has no = or ;
      if (!text || /[=;]|^\w+$/.test(text) && !/\s/.test(text) && text.length < 3) continue
      if (/=>|\)\s*$|^\s*\w+\s*\(/.test(text)) continue
      if (ALLOWED.has(text)) continue
      out.push(`${file}:${i + 1}: ${text}`)
    }
    // Why: punctuation written after a <code> element ends a translated sentence
    // in English punctuation ("。" languages get a Latin "."); it belongs in the key
    if (/<\/code>[.,;:!?]/.test(line)) out.push(`${file}:${i + 1}: punctuation after </code>`)
    for (const m of line.matchAll(ATTR)) {
      if (ALLOWED.has(m[2].trim())) continue
      out.push(`${file}:${i + 1}: ${m[1]}="${m[2]}"`)
    }
  })
  return out
}

// Text App.tsx sets on agents in code (task: / statusText:). The ?sim and
// ?video script's lines stay English (spec): they are listed here.
const SIM_ONLY = new Set([
  'Office assistant',
  'Auditing auth middleware for session token vulnerabilities',
  'Building responsive dashboard with real-time charts',
  'Reviewing PR #487 — payment processing refactor',
  'ultra-think: deep analysis...',
  'Searching codebase for API endpoint patterns',
  'Investigating null pointer in payment webhook handler',
  'Pizza Delivery',
  'Scanning auth-related files across codebase',
])

describe('no hard-coded agent text in App.tsx', () => {
  it('every task / statusText literal is ?sim content', () => {
    const found: string[] = []
    readFileSync('src/App.tsx', 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:task|statusText): '([^']*[A-Za-z][^']*)'/g)) {
        if (!SIM_ONLY.has(m[1]) && !m[1].startsWith('ultra-think: ')) found.push(`src/App.tsx:${i + 1}: ${m[1]}`)
      }
    })
    expect(found).toEqual([])
  })
})

describe('no hard-coded English in the page', () => {
  it.each(IN_SCOPE)('%s', file => {
    expect(findings(file)).toEqual([])
  })
})
