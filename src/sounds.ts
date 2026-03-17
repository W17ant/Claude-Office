// Retro 8-bit sound effects using Web Audio API
let ctx: AudioContext | null = null
let masterVolume = 0.5  // 0–1

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

function beep(freq: number, duration: number, type: OscillatorType = 'square', vol = 0.08) {
  if (masterVolume === 0) return
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.value = vol * masterVolume
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start()
  osc.stop(c.currentTime + duration)
}

export function playTyping() {
  if (masterVolume === 0) return
  for (let i = 0; i < 3; i++) {
    setTimeout(() => beep(800 + Math.random() * 400, 0.03, 'square', 0.03), i * 60)
  }
}

export function playNotification() {
  beep(880, 0.1, 'sine', 0.06)
  setTimeout(() => beep(1100, 0.15, 'sine', 0.06), 120)
}

export function playCoffee() {
  if (masterVolume === 0) return
  for (let i = 0; i < 5; i++) {
    setTimeout(() => beep(150 + Math.random() * 100, 0.08, 'sawtooth', 0.02), i * 100)
  }
}

export function playAlarm() {
  if (masterVolume === 0) return
  let i = 0
  const interval = setInterval(() => {
    beep(i % 2 === 0 ? 600 : 900, 0.2, 'square', 0.06)
    i++
    if (i > 8) clearInterval(interval)
  }, 250)
}

export function playCelebration() {
  const notes = [523, 659, 784, 1047]
  notes.forEach((f, i) => {
    setTimeout(() => beep(f, 0.15, 'sine', 0.05), i * 100)
  })
}

export function playBell() {
  if (masterVolume === 0) return
  // Bright metallic ding-ding
  beep(1400, 0.2, 'sine', 0.08)
  setTimeout(() => beep(1800, 0.15, 'sine', 0.06), 150)
  setTimeout(() => beep(1400, 0.1, 'sine', 0.04), 350)
}

export function playDoorOpen() {
  beep(200, 0.15, 'triangle', 0.04)
  setTimeout(() => beep(300, 0.1, 'triangle', 0.04), 100)
}

export function playError() {
  beep(200, 0.2, 'sawtooth', 0.05)
  setTimeout(() => beep(150, 0.3, 'sawtooth', 0.05), 200)
}

export function playPowerDown() {
  if (masterVolume === 0) return
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = 400
  osc.frequency.exponentialRampToValueAtTime(50, c.currentTime + 0.5)
  gain.gain.value = 0.06 * masterVolume
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.5)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start()
  osc.stop(c.currentTime + 0.6)
}

// ---------------------------------------------------------------------------
// Ambient sounds
// ---------------------------------------------------------------------------

let ambientOscNode: OscillatorNode | null = null
let ambientGainNode: GainNode | null = null
let ambientRunning = false

/** Start a very quiet low-frequency hum that loops continuously. */
export function playAmbientHum() {
  if (masterVolume === 0 || ambientRunning) return
  try {
    const c = getCtx()
    const osc = c.createOscillator()
    const gain = c.createGain()

    osc.type = 'sine'
    osc.frequency.value = 50 + Math.random() * 10  // 50-60 hz drone

    gain.gain.value = 0.015 * masterVolume

    osc.connect(gain)
    gain.connect(c.destination)
    osc.start()

    ambientOscNode = osc
    ambientGainNode = gain
    ambientRunning = true
  } catch (_) {
    // AudioContext may not be available in some environments
  }
}

/** Stop the ambient hum. */
export function stopAmbient() {
  if (!ambientRunning) return
  try {
    ambientGainNode?.gain.setTargetAtTime(0, getCtx().currentTime, 0.1)
    setTimeout(() => {
      try { ambientOscNode?.stop() } catch (_) { /* already stopped */ }
      ambientOscNode = null
      ambientGainNode = null
    }, 300)
  } catch (_) { /* ignore */ }
  ambientRunning = false
}

/** Update ambient gain when master volume changes (called internally). */
function syncAmbientVolume() {
  if (ambientGainNode) {
    try {
      ambientGainNode.gain.setTargetAtTime(
        masterVolume === 0 ? 0 : 0.015 * masterVolume,
        getCtx().currentTime,
        0.05,
      )
    } catch (_) { /* ignore */ }
  }
}

/** Random soft keyboard clatter — subtle typing noise for working agents. */
export function playKeyboardClatter() {
  if (masterVolume === 0) return
  const count = 2 + Math.floor(Math.random() * 4)  // 2-5 clicks
  for (let i = 0; i < count; i++) {
    const delay = i * (30 + Math.random() * 50)
    setTimeout(() => {
      beep(600 + Math.random() * 600, 0.02, 'square', 0.008 + Math.random() * 0.006)
    }, delay)
  }
}

// ---------------------------------------------------------------------------
// Volume control (0–1)
// ---------------------------------------------------------------------------
let preMuteVolume = 0.5  // restored when unmuting

export function setVolume(v: number) {
  masterVolume = Math.max(0, Math.min(1, v))
  if (masterVolume > 0) preMuteVolume = masterVolume
  syncAmbientVolume()
}
export function getVolume() { return masterVolume }
export function isMuted() { return masterVolume === 0 }
export function toggleMute() {
  if (masterVolume > 0) {
    preMuteVolume = masterVolume
    masterVolume = 0
  } else {
    masterVolume = preMuteVolume > 0 ? preMuteVolume : 0.5
  }
  syncAmbientVolume()
  return masterVolume === 0
}
