/**
 * recap.ts - the "Today" numbers: GET /recap (server/recap.js) and the rows
 * the status strip's Today popover draws from them.
 */

import { officeHttpBase } from './serverUrl'
import { officeAuthHeaders } from './officeAuth'

/** One day's counts, as GET /recap answers (see server/recap.js for each definition). */
export interface RecapStats {
  date: string
  today?: boolean
  sessions: number
  agentsSpawned: number
  agentsCompleted: number
  tasksCompleted: number
  deploys: number
  buildsFailed: number
  testsFailed: number
  pushes: number
  incidents: number
  costUsd: number
}

/** A row of the Today popover: label, value as shown, and a tone for the value. */
export interface RecapRow {
  key: keyof RecapStats
  label: string
  value: string
  tone: 'plain' | 'good' | 'bad' | 'dim'
}

/**
 * Fetch one day's recap.
 * @param date YYYY-MM-DD (local to the server); today when omitted
 * @returns the counts, or null when the server is unreachable or answers an error
 */
export async function fetchRecap(date?: string): Promise<RecapStats | null> {
  try {
    const query = date ? `?date=${encodeURIComponent(date)}` : ''
    // Why 3 s: the popover shows "loading" meanwhile; longer means the server is not there
    // Why the auth headers: through a proxy (Tailscale, phone mode) the server wants the token in a header
    const res = await fetch(`${officeHttpBase()}/recap${query}`, { signal: AbortSignal.timeout(3000), headers: officeAuthHeaders() })
    if (!res.ok) return null
    const body = await res.json()
    return body && typeof body.date === 'string' ? (body as RecapStats) : null
  } catch {
    return null
  }
}

/** "$0.00", "$4.27", "$0.004" (a sub-cent day keeps one significant digit so it is not $0.00). */
export function formatUsd(n: number): string {
  if (!(n > 0)) return '$0.00'
  if (n < 0.01) return `$${n.toPrecision(1)}`
  return `$${n.toFixed(2)}`
}

/**
 * The popover's rows, in reading order: who worked, what got done, what went
 * out, what went wrong, what it cost. A zero reads dim; failures and
 * incidents read red only when there are some.
 */
export function recapRows(s: RecapStats): RecapRow[] {
  const n = (key: keyof RecapStats, label: string, tone: RecapRow['tone'] = 'plain'): RecapRow => {
    const v = Number(s[key]) || 0
    return { key, label, value: String(v), tone: v === 0 ? 'dim' : tone }
  }
  return [
    n('sessions', 'Sessions'),
    n('agentsSpawned', 'Agents hired'),
    n('agentsCompleted', 'Clocked out'),
    n('tasksCompleted', 'Tasks closed', 'good'),
    n('deploys', 'Deploys', 'good'),
    n('pushes', 'Pushes'),
    n('buildsFailed', 'Failed builds', 'bad'),
    n('testsFailed', 'Failed test runs', 'bad'),
    n('incidents', 'Incidents', 'bad'),
    { key: 'costUsd', label: 'Payroll', value: formatUsd(s.costUsd), tone: s.costUsd > 0 ? 'plain' : 'dim' },
  ]
}
