/**
 * src/sounds.ts — the ambient hum's stop/restart race (audit C46): stopAmbient's
 * deferred cleanup must only ever stop the oscillator it was called for.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeOsc() {
  return {
    type: 'sine',
    frequency: { value: 0, exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  oscillators: ReturnType<typeof makeOsc>[] = []
  currentTime = 0
  destination = {}
  constructor() { FakeAudioContext.instances.push(this) }
  createOscillator() { const o = makeOsc(); this.oscillators.push(o); return o }
  createGain() { return { gain: { value: 0, exponentialRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn() }, connect: vi.fn() } }
}

describe('sounds.ts ambient hum (C46)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeAudioContext.instances = []
    ;(globalThis as any).AudioContext = FakeAudioContext
    vi.resetModules()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as any).AudioContext
  })

  it('a hum restarted during the 300 ms fade-out survives it, and can be stopped and started again', async () => {
    const sfx = await import('../src/sounds')
    sfx.playAmbientHum()            // mount
    sfx.stopAmbient()               // StrictMode unmount (or mute)
    sfx.playAmbientHum()            // immediate re-mount (or unmute)
    const ctx = FakeAudioContext.instances[0]
    expect(ctx.oscillators).toHaveLength(2)
    const [osc1, osc2] = ctx.oscillators

    vi.advanceTimersByTime(300)     // the first stop's deferred cleanup fires
    expect(osc1.stop).toHaveBeenCalledTimes(1)
    expect(osc2.stop).not.toHaveBeenCalled()

    sfx.playAmbientHum()            // already running: no third oscillator
    expect(ctx.oscillators).toHaveLength(2)

    sfx.stopAmbient()
    vi.advanceTimersByTime(300)
    expect(osc2.stop).toHaveBeenCalledTimes(1)
    sfx.playAmbientHum()            // not wedged: a fresh hum starts
    expect(ctx.oscillators).toHaveLength(3)
  })
})
