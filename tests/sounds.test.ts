/**
 * src/sounds.ts — which events still make a sound, the cue cooldowns, the
 * ambient bed's level, and the bed's lifecycle against a fake AudioContext:
 * it waits for a user gesture, follows mute / Ambience / a hidden tab, and a
 * bed restarted during a fade-out survives the old one's cleanup (audit C46).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ambienceGain, cueAllowed, incidentHasCue, loopedBrownNoise, nextTextureDelayMs,
  AMBIENCE_LEVEL, CUE_COOLDOWN_MS, NIGHT_FACTOR,
} from '../src/sounds'
import type { IncidentReason } from '../src/incident'

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

describe('cue cooldowns', () => {
  it('a cue never played may play; the same cue inside its cooldown may not; after it, it may', () => {
    expect(cueAllowed('needsYou', 1_000, {})).toBe(true)
    const last = { needsYou: 1_000 }
    expect(cueAllowed('needsYou', 1_000 + CUE_COOLDOWN_MS.needsYou - 1, last)).toBe(false)
    expect(cueAllowed('needsYou', 1_000 + CUE_COOLDOWN_MS.needsYou, last)).toBe(true)
  })

  it('cooldowns are per cue: a cheer does not hold back a needs-you chime', () => {
    expect(cueAllowed('needsYou', 2_000, { celebration: 1_999 })).toBe(true)
  })

  it('the bell the owner rings has no cooldown of its own', () => {
    expect(cueAllowed('bell', 5, { bell: 5 })).toBe(true)
  })
})

describe('which incidents sound the alarm cue', () => {
  it('real ones and the ones the owner asked for', () => {
    for (const r of ['failures', 'deploy-fail', 'manual', 'remote'] as IncidentReason[]) expect(incidentHasCue(r)).toBe(true)
  })

  it('not a random event\'s mini-incident, a reload into one, a ?variant URL, or no entry at all', () => {
    for (const r of ['event', 'restored', 'url'] as IncidentReason[]) expect(incidentHasCue(r)).toBe(false)
    expect(incidentHasCue(undefined)).toBe(false)
  })
})

describe('ambient bed level', () => {
  it('is silent when muted or with Ambience off', () => {
    expect(ambienceGain(0, true, false)).toBe(0)
    expect(ambienceGain(0.8, false, false)).toBe(0)
    expect(ambienceGain(Number.NaN, true, false)).toBe(0)
  })

  it('follows the volume, and is quieter at night', () => {
    expect(ambienceGain(0.5, true, false)).toBeCloseTo(0.5 * AMBIENCE_LEVEL)
    expect(ambienceGain(0.5, true, true)).toBeCloseTo(0.5 * AMBIENCE_LEVEL * NIGHT_FACTOR)
    expect(NIGHT_FACTOR).toBeLessThan(1)
    expect(ambienceGain(2, true, false)).toBeCloseTo(AMBIENCE_LEVEL)
  })

  it('distant noises come every 25–70 s by day, half as often at night', () => {
    expect(nextTextureDelayMs(false, () => 0)).toBe(25_000)
    expect(nextTextureDelayMs(false, () => 1)).toBe(70_000)
    expect(nextTextureDelayMs(true, () => 0)).toBe(50_000)
  })
})

describe('looped brown noise', () => {
  /** A seeded 0..1 source so the test is deterministic. */
  function seeded(seed = 7) {
    let x = seed
    return () => { x = (x * 1_103_515_245 + 12_345) % 2_147_483_648; return x / 2_147_483_648 }
  }

  it('has the length asked for and stays within about ±1', () => {
    const n = loopedBrownNoise(48_000, 4_800, seeded())
    expect(n).toHaveLength(48_000)
    expect(Math.max(...n.map(Math.abs))).toBeLessThan(1.5)
  })

  it('runs from its last sample into its first without a jump (no click at the loop)', () => {
    const n = loopedBrownNoise(48_000, 4_800, seeded())
    // Typical step between neighbours, to compare the seam against
    let sum = 0
    for (let i = 1; i < n.length; i++) sum += Math.abs(n[i] - n[i - 1])
    const typical = sum / (n.length - 1)
    expect(Math.abs(n[0] - n[n.length - 1])).toBeLessThan(typical * 5)
  })
})

// ---------------------------------------------------------------------------
// The engine, against a fake AudioContext
// ---------------------------------------------------------------------------

function param() {
  return {
    value: 0,
    setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn(),
  }
}

function node() {
  return { connect: vi.fn(), disconnect: vi.fn() }
}

function source(kind: 'osc' | 'buffer') {
  return {
    ...node(), kind, type: 'sine', frequency: param(), playbackRate: param(),
    buffer: null as unknown, loop: false, start: vi.fn(), stop: vi.fn(),
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  static initialState: 'running' | 'suspended' = 'running'
  sources: ReturnType<typeof source>[] = []
  gains: { gain: ReturnType<typeof param> }[] = []
  currentTime = 0
  sampleRate = 8_000  // Why small: the 6 s noise buffer is made in the test too
  state: string = FakeAudioContext.initialState
  destination = {}
  constructor() { FakeAudioContext.instances.push(this) }
  resume = vi.fn(async () => { this.state = 'running' })
  createOscillator() { const s = source('osc'); this.sources.push(s); return s }
  createBufferSource() { const s = source('buffer'); this.sources.push(s); return s }
  createGain() { const g = { ...node(), gain: param() }; this.gains.push(g); return g }
  createBiquadFilter() { return { ...node(), type: 'lowpass', frequency: param(), Q: param() } }
  createBuffer(_ch: number, length: number, sampleRate: number) {
    const data = new Float32Array(length)
    return { sampleRate, length, getChannelData: () => data }
  }
}

type Sfx = typeof import('../src/sounds')

describe('the engine', () => {
  let sfx: Sfx
  const ctx = () => FakeAudioContext.instances[0]
  /** Sources that are looping or running for the bed (started, not yet stopped). */
  const running = () => ctx()?.sources.filter(s => s.start.mock.calls.length > 0 && s.stop.mock.calls.length === 0) ?? []

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    FakeAudioContext.instances = []
    FakeAudioContext.initialState = 'running'
    ;(globalThis as any).AudioContext = FakeAudioContext
    vi.resetModules()
    sfx = await import('../src/sounds')
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as any).AudioContext
  })

  it('the bed waits for a user gesture, then starts and fades in', () => {
    sfx.playAmbientHum()
    expect(FakeAudioContext.instances).toHaveLength(0)  // no context before a gesture
    sfx.unlockAudio()
    expect(running().length).toBeGreaterThan(0)
    // The output starts at 0 and glides up to its level
    const out = ctx().gains[0].gain
    expect(out.setValueAtTime).toHaveBeenCalledWith(0, 0)
    expect(out.setTargetAtTime).toHaveBeenCalledWith(ambienceGain(0.5, true, false), 0, expect.any(Number))
  })

  it('mute stops every bed node after the fade; unmute starts a fresh bed', () => {
    sfx.playAmbientHum(); sfx.unlockAudio()
    const first = running()
    sfx.toggleMute()
    vi.advanceTimersByTime(1_500)
    for (const s of first) expect(s.stop).toHaveBeenCalled()
    expect(running()).toHaveLength(0)
    sfx.toggleMute()
    expect(running().length).toBe(first.length)
  })

  it('Ambience off, or a hidden tab, stops the bed; the cues are unaffected', () => {
    sfx.playAmbientHum(); sfx.unlockAudio()
    sfx.setAmbience(false)
    vi.advanceTimersByTime(1_500)
    expect(running()).toHaveLength(0)
    sfx.setAmbience(true)
    expect(running().length).toBeGreaterThan(0)
    sfx.setPageHidden(true)
    vi.advanceTimersByTime(1_500)
    expect(running()).toHaveLength(0)

    const before = ctx().sources.length
    sfx.playNeedsYou()
    expect(ctx().sources.length).toBeGreaterThan(before)
  })

  it('a bed restarted during the fade-out survives it, and can be stopped and started again (C46)', () => {
    sfx.unlockAudio()
    sfx.playAmbientHum()            // mount
    const first = running()
    sfx.stopAmbient()               // StrictMode unmount (or mute)
    sfx.playAmbientHum()            // immediate re-mount (or unmute)
    const second = running().filter(s => !first.includes(s))
    expect(second.length).toBe(first.length)

    vi.advanceTimersByTime(1_500)   // the first stop's deferred cleanup fires
    for (const s of first) expect(s.stop).toHaveBeenCalledTimes(1)
    for (const s of second) expect(s.stop).not.toHaveBeenCalled()

    const count = ctx().sources.length
    sfx.playAmbientHum()            // already running: nothing new
    expect(ctx().sources.length).toBe(count)

    sfx.stopAmbient()
    vi.advanceTimersByTime(1_500)
    for (const s of second) expect(s.stop).toHaveBeenCalledTimes(1)
    sfx.playAmbientHum()            // not wedged: a fresh bed starts
    expect(running().length).toBe(first.length)
  })

  it('a cue plays once per cooldown, and not at all when muted', () => {
    sfx.unlockAudio()
    const count = () => ctx().sources.length
    const start = count()
    sfx.playNeedsYou()
    const one = count() - start
    expect(one).toBeGreaterThan(0)
    sfx.playNeedsYou()              // the permission card a beat after the reducer
    expect(count() - start).toBe(one)
    vi.advanceTimersByTime(CUE_COOLDOWN_MS.needsYou)
    sfx.playNeedsYou()
    expect(count() - start).toBe(2 * one)

    sfx.toggleMute()
    const muted = count()
    sfx.playCelebration(); sfx.playError(); sfx.playAlarm(); sfx.playBell()
    expect(count()).toBe(muted)
  })

  it('cues are soft sines, never square or saw bleeps', () => {
    sfx.unlockAudio()
    sfx.playNeedsYou(); sfx.playCelebration(); sfx.playError(); sfx.playAlarm(); sfx.playBell()
    const types = new Set(ctx().sources.filter(s => s.kind === 'osc').map(s => s.type))
    expect([...types]).toEqual(['sine'])
  })

  it('before any gesture a suspended context plays nothing (no stale chime on the first click)', () => {
    FakeAudioContext.initialState = 'suspended'
    sfx.playNeedsYou()
    expect(ctx().sources).toHaveLength(0)
    sfx.unlockAudio()
    expect(ctx().resume).toHaveBeenCalled()
  })

  it('attachAmbience unlocks on the first click or key and follows the tab\'s visibility', () => {
    const listeners: Record<string, ((e?: unknown) => void)[]> = {}
    const doc = {
      hidden: false,
      addEventListener: (t: string, f: () => void) => { (listeners[t] ??= []).push(f) },
      removeEventListener: (t: string, f: () => void) => { listeners[t] = (listeners[t] ?? []).filter(g => g !== f) },
    }
    const detach = sfx.attachAmbience(doc as unknown as Document)
    sfx.playAmbientHum()
    expect(FakeAudioContext.instances).toHaveLength(0)
    listeners.pointerdown[0]()
    expect(running().length).toBeGreaterThan(0)
    expect(listeners.pointerdown).toHaveLength(0)  // one gesture is enough

    doc.hidden = true
    listeners.visibilitychange[0]()
    vi.advanceTimersByTime(1_500)
    expect(running()).toHaveLength(0)
    detach()
    expect(listeners.visibilitychange).toHaveLength(0)
  })
})
