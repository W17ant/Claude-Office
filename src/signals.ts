/**
 * signals.ts — reading the `signal` events the server relays (what a
 * session's Bash commands meant: a deploy, a build, a test run, a push).
 *
 * Pure helpers shared by the two reducers that act on them: the office
 * (src/officeReducer.ts: scenes on the character and chat lines) and
 * incident mode (src/incident.ts: a failed deploy opens it, a green run
 * closes it). Nothing here touches React or the DOM.
 */

import type { SignalEvent, SignalKind } from './types'

export type SignalFamily = 'deploy' | 'build' | 'test' | 'push'
export type SignalOutcome = 'start' | 'ok' | 'fail'

const SIGNALS: Record<SignalKind, [SignalFamily, SignalOutcome]> = {
  deploy_start: ['deploy', 'start'], deploy_success: ['deploy', 'ok'], deploy_fail: ['deploy', 'fail'],
  build_start: ['build', 'start'], build_ok: ['build', 'ok'], build_failed: ['build', 'fail'],
  test_start: ['test', 'start'], test_ok: ['test', 'ok'], test_failed: ['test', 'fail'],
  push: ['push', 'start'], push_done: ['push', 'ok'], push_failed: ['push', 'fail'],
}

/** A known signal kind (a newer server may send kinds this page does not know) */
export function isSignalKind(kind: unknown): kind is SignalKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(SIGNALS, kind)
}

export function signalFamily(kind: SignalKind): SignalFamily {
  return SIGNALS[kind][0]
}

export function signalOutcome(kind: SignalKind): SignalOutcome {
  return SIGNALS[kind][1]
}

/** What the signal was about, for a chat line: the target, else the project */
export function signalWhere(s: Pick<SignalEvent, 'target' | 'project'>): string | undefined {
  return s.target || s.project || undefined
}

/** How long each scene stays on a character when nothing ends it sooner */
export const SCENE_MS = {
  shipping: 10 * 60_000,
  shipped: 8_000,
  red: 6_000,
  pushed: 6_000,
} as const

/**
 * The failure as a sentence the incident summary and the chat can name:
 * "tests failed in api: 3 failing", "build failed in web: 2 errors",
 * "deploy of api failed: Error: 503". Undefined for anything but a failure.
 */
export function signalFailureLabel(s: Pick<SignalEvent, 'kind' | 'target' | 'project' | 'detail' | 'error'>): string | undefined {
  if (!isSignalKind(s.kind) || signalOutcome(s.kind) !== 'fail') return undefined
  const where = signalWhere(s)
  const why = s.detail || s.error
  const tail = why ? `: ${why}` : ''
  switch (signalFamily(s.kind)) {
    case 'deploy': return `deploy${where ? ` of ${where}` : ''} failed${tail}`
    case 'build':  return `build failed${where ? ` in ${where}` : ''}${tail}`
    case 'test':   return `tests failed${where ? ` in ${where}` : ''}${tail}`
    case 'push':   return `push${s.target ? ` of ${s.target}` : ''} failed${tail}`
  }
}
