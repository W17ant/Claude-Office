/**
 * src/mainState.ts — the pure helpers behind the session pill, Claude's
 * badges and the completion line.
 */

import { describe, expect, it } from 'vitest'
import {
  mainId, isMainAgent, isHardNeedsYou, needsYouLabel, needsYouBadge, needsYouShort,
  agentStateFor, isFreeMain, mainTone, mainPillText, shortModel,
  formatTokensShort, formatElapsed, completionStats, summarise, projectFromCwd, countRunningTasks,
} from '../src/mainState'

describe('mainState helpers', () => {
  it('names a session\'s Claude', () => {
    expect(mainId('abc')).toBe('main-abc')
    expect(isMainAgent({ id: 'main-abc' })).toBe(true)
    expect(isMainAgent({ id: 'assistant-claude' })).toBe(false)
  })

  it('tells hard needs-you kinds (a person must act) from soft ones', () => {
    expect(isHardNeedsYou({ kind: 'permission' })).toBe(true)
    expect(isHardNeedsYou({ kind: 'agent-input' })).toBe(true)
    expect(isHardNeedsYou({ kind: 'idle' })).toBe(false)
    expect(isHardNeedsYou({ kind: 'quota' })).toBe(false)
    expect(isHardNeedsYou(undefined)).toBe(false)
    // An unhooked session the registry marks "waiting" has a dialog on its screen
    expect(isHardNeedsYou({ kind: 'registry' })).toBe(true)
    expect(mainTone('needs-you', { kind: 'registry' })).toBe('needs-you')
    expect(needsYouBadge('registry')).toBe('✋')
    expect(needsYouShort('registry')).toBe('waiting in the terminal')
    expect(needsYouLabel({ kind: 'registry', summary: 'waiting in the terminal' })).toBe('✋ waiting in the terminal')
    expect(needsYouLabel({ kind: 'registry' })).toBe('✋ waiting in the terminal')
    expect(mainPillText('needs-you', { kind: 'registry' })).toBe('✋ waiting in the terminal')
  })

  it('labels say only what the event said', () => {
    expect(needsYouLabel({ kind: 'permission', toolName: 'Bash', summary: 'npm test' })).toBe('✋ needs you: Bash · npm test')
    expect(needsYouLabel({ kind: 'permission', toolName: 'Write' })).toBe('✋ needs you: Write')
    expect(needsYouLabel({ kind: 'permission' })).toBe('✋ needs you — permission')
    expect(needsYouLabel({ kind: 'agent-input', summary: 'which env?' })).toBe('✋ needs input: which env?')
    expect(needsYouLabel({ kind: 'agent-input', message: 'input wanted' })).toBe('✋ needs input: input wanted')
    expect(needsYouLabel({ kind: 'idle' })).toBe('💤 idle prompt')
    expect(needsYouLabel({ kind: 'quota', message: 'anything' })).toBe('⏳ waiting for tokens')
    expect(needsYouBadge('permission')).toBe('✋')
    expect(needsYouBadge('quota')).toBe('⏳')
    expect(needsYouShort('agent-input')).toBe('needs input')
  })

  it('maps main states to a sprite state, a free/busy flag, a pill tone and a pill text', () => {
    expect(agentStateFor('working')).toBe('working')
    expect(agentStateFor('compacting')).toBe('working')
    for (const s of ['idle', 'waiting', 'needs-you', 'error', undefined] as const) expect(agentStateFor(s)).toBe('idle')
    expect(isFreeMain({ mainState: undefined })).toBe(true)
    expect(isFreeMain({ mainState: 'waiting' })).toBe(true)
    expect(isFreeMain({ mainState: 'working' })).toBe(false)
    expect(isFreeMain({ mainState: 'needs-you' })).toBe(false)
    expect(mainTone('working')).toBe('busy')
    expect(mainTone('needs-you', { kind: 'permission' })).toBe('needs-you')
    expect(mainTone('needs-you', { kind: 'idle' })).toBe('soft')
    expect(mainTone('error')).toBe('error')
    expect(mainTone(undefined)).toBe('idle')
    expect(mainPillText('needs-you', { kind: 'permission' })).toBe('✋ needs you')
    expect(mainPillText('needs-you', { kind: 'quota' })).toBe('⏳ waiting for tokens')
    expect(mainPillText('waiting', undefined, 2)).toBe('⏳ 2')
    expect(mainPillText('working')).toBeNull()
    expect(mainPillText('idle')).toBeNull()
  })

  it('shortens model ids for the badge', () => {
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5')
    expect(shortModel('claude-opus-4-1')).toBe('opus-4-1')
    expect(shortModel('Sonnet 4.5')).toBe('Sonnet 4.5')
    expect(shortModel('')).toBeNull()
    expect(shortModel(undefined)).toBeNull()
  })

  it('formats the completion numbers', () => {
    expect(formatTokensShort(42_000)).toBe('42k')
    expect(formatTokensShort(4_200)).toBe('4.2k')
    expect(formatTokensShort(950)).toBe('950')
    expect(formatTokensShort(1_200_000)).toBe('1.2M')
    expect(formatElapsed(192_000)).toBe('3m12s')
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(3_900_000)).toBe('1h05m')
    expect(completionStats(42_000, 192_000)).toEqual(['42k tok', '3m12s'])
    expect(completionStats(undefined, 192_000)).toEqual(['3m12s'])
    expect(completionStats(undefined, undefined)).toEqual([])
  })

  it('summarises prompts, derives projects from cwds and counts unfinished background tasks', () => {
    expect(summarise('  fix the\n flaky test  ')).toBe('fix the flaky test')
    expect(summarise('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`)
    expect(summarise('   ')).toBeUndefined()
    expect(summarise(undefined)).toBeUndefined()
    expect(projectFromCwd('/home/me/office/')).toBe('office')
    expect(projectFromCwd('C:\\src\\api')).toBe('api')
    expect(projectFromCwd(undefined)).toBeUndefined()
    expect(countRunningTasks([{ status: 'running' }, { status: 'pending' }, { status: 'completed' }, { status: 'failed' }, {}])).toBe(3)
    expect(countRunningTasks(undefined)).toBe(0)
  })
})
