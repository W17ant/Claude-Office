/**
 * sounds.ts - the office's audio, all made in code with Web Audio (no audio
 * files): a quiet ambient office bed and a handful of soft event cues.
 *
 * ── The ambient bed ─────────────────────────────────────────────────────
 * Loops while the page is open and sound is on: room tone (low-passed brown
 * noise), air from the vents (a band of the same noise breathing slowly), a
 * very soft mains hum, and now and then something distant — typing two desks
 * over, a drawer closing, paper shuffled. It
 *   - starts only after a user gesture (browsers keep an AudioContext made
 *     before one suspended; `attachAmbience` waits for the first click/key),
 *   - follows the volume and mute, and the Ambience on/off setting,
 *   - fades in over a few seconds and out in under one,
 *   - stops (every node, not just silent) when muted or the tab is hidden,
 *   - is quieter at night, with fewer distant noises.
 * CPU: one 6 s noise buffer made once, two looping buffer sources, three
 * oscillators and a few filters — no ScriptProcessor, no per-sample JS.
 *
 * ── Event cues ──────────────────────────────────────────────────────────
 * Only what deserves a sound, as soft sine tones with a gentle attack (no
 * square or saw "bleeps"):
 *   needsYou     a session is waiting on a person (permission, question)
 *   alarm        an incident opened (real failures, not a random event)
 *   error        a session hit an API error
 *   celebration  a deploy shipped, or an agent finished its task
 *   bell         the boss rings the desk bell (a deliberate click)
 * Each cue has a cooldown (`CUE_COOLDOWN_MS`) so a burst of the same event —
 * five subagents finishing at once, the permission card and the reducer both
 * announcing one wait — is one sound, not five.
 *
 * Typing, keyboard clatter, door, coffee, notification and power-down sounds
 * are gone: they fired constantly and were the "bleeping".
 */

import type { IncidentReason } from './incident'

// ===========================================================================
// Pure policy (unit-tested in Node: tests/sounds.test.ts)
// ===========================================================================

/** The event cues that still make a sound. */
export type Cue = 'needsYou' | 'alarm' | 'error' | 'celebration' | 'bell'

/**
 * Minimum gap between two plays of the same cue, in ms.
 * Why these: needs-you 8 s covers the permission card and the reducer
 * announcing the same wait a beat apart, and several sessions raising hands
 * together; a celebration burst (parallel subagents finishing) is one cheer
 * per 20 s; errors and incidents repeat rarely and must not nag. The bell is
 * a click the owner makes (interactions.ts already has a 20 s cooldown).
 */
export const CUE_COOLDOWN_MS: Readonly<Record<Cue, number>> = {
  needsYou: 8_000,
  alarm: 60_000,
  error: 15_000,
  celebration: 20_000,
  bell: 0,
}

/**
 * Whether a cue may play now, given when each cue last played.
 * @param cue the cue asked for
 * @param now ms (Date.now())
 * @param lastAt when each cue last played (ms); a missing entry never played
 * @returns true when the cue's cooldown has passed
 */
export function cueAllowed(cue: Cue, now: number, lastAt: Partial<Record<Cue, number>>): boolean {
  const last = lastAt[cue]
  return last === undefined || now - last >= CUE_COOLDOWN_MS[cue]
}

/**
 * Whether entering an incident for this reason sounds the alarm cue.
 * Why: only a real one, or one the owner asked for. A random office event's
 * mini-incident is fiction; a reload during one (`restored`) or a
 * `?variant=incident` screenshot URL is not news.
 * @param reason why incident mode opened
 */
export function incidentHasCue(reason: IncidentReason | undefined): boolean {
  return reason === 'failures' || reason === 'deploy-fail' || reason === 'manual' || reason === 'remote'
}

/**
 * Level of the bed relative to the main volume (×volume at the output).
 * Why 1 with the per-layer gains in startBed: rendered offline in Chromium
 * (OfflineAudioContext) the bed is -48 dBFS RMS at 50 % volume by day and
 * -53.5 at night — room tone -50, vent air -54, hum -63 — about 20 dB under
 * the cues' peaks (-28 to -35 dBFS): present on headphones, gone under music.
 */
export const AMBIENCE_LEVEL = 1
/** Why 0.55: about -5 dB at night — the room is emptier, not silent. */
export const NIGHT_FACTOR = 0.55

/**
 * The bed's output gain for these settings.
 * @param volume main volume 0..1 (0 = muted)
 * @param ambienceOn the Ambience setting
 * @param night whether the office is in its dusk / night look
 * @returns 0 when the bed should not play
 */
export function ambienceGain(volume: number, ambienceOn: boolean, night: boolean): number {
  if (!ambienceOn || !(volume > 0)) return 0
  return AMBIENCE_LEVEL * Math.min(1, volume) * (night ? NIGHT_FACTOR : 1)
}

/**
 * How long until the next distant office noise, in ms.
 * Why 25–70 s by day: often enough that the room feels inhabited, rare enough
 * that no one notices a pattern; twice as long at night (fewer people in).
 * @param night quieter office
 * @param random 0..1 source (Math.random in the page, fixed in tests)
 */
export function nextTextureDelayMs(night: boolean, random: () => number = Math.random): number {
  const base = 25_000 + random() * 45_000
  return night ? base * 2 : base
}

/**
 * Brown noise that loops without a click: `length` samples whose end runs
 * smoothly into its start (the tail is cross-faded into the head).
 * @param length samples in the loop
 * @param fade samples cross-faded at the seam (< length)
 * @param random white-noise source in 0..1
 * @returns samples in about -1..1
 */
export function loopedBrownNoise(length: number, fade: number, random: () => number = Math.random): Float32Array {
  const raw = new Float32Array(length + fade)
  let last = 0
  for (let i = 0; i < raw.length; i++) {
    // Why 0.02 / 1.02 / 3.5: the usual leaky-integrator brown noise — white
    // noise integrated with a slight leak so it never drifts off, then scaled
    // back up to about ±1
    last = (last + 0.02 * (random() * 2 - 1)) / 1.02
    raw[i] = last * 3.5
  }
  const out = raw.slice(0, length)
  // Why: the loop plays out[length-1] then out[0]; raw[length..] is what would
  // have followed out[length-1], so fading the head from it makes the seam
  // continuous
  for (let i = 0; i < fade; i++) {
    const t = i / fade
    out[i] = raw[i] * t + raw[length + i] * (1 - t)
  }
  return out
}

// ===========================================================================
// Audio context and state
// ===========================================================================

let ctx: AudioContext | null = null
let masterVolume = 0.5  // 0–1
let preMuteVolume = 0.5  // restored when unmuting

/** A user gesture has happened: the browser lets audio start. */
let unlocked = false
/** The page (App's mount effect) wants the bed: playAmbientHum / stopAmbient. */
let ambientWanted = false
let ambienceOn = true
let night = false
let pageHidden = false

const lastCueAt: Partial<Record<Cue, number>> = {}

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

/**
 * The context for a cue, or null when it cannot sound now.
 * Why skip rather than schedule on a suspended context: its clock stands
 * still, so the cue would play late, on the first click, out of context.
 */
function cueCtx(): AudioContext | null {
  if (masterVolume === 0) return null
  try {
    const c = getCtx()
    if (!unlocked && c.state === 'suspended') return null
    return c
  } catch {
    return null  // no Web Audio here
  }
}

// ===========================================================================
// Event cues
// ===========================================================================

/**
 * One soft, mallet-like note: a sine with a quick (not instant) attack and an
 * exponential decay, plus a quieter partial an octave up that dies faster —
 * marimba / vibraphone rather than a beep.
 */
function softNote(c: AudioContext, freq: number, at: number, duration: number, peak: number, overtone = 0.25) {
  const out = c.createGain()
  out.gain.setValueAtTime(0, at)
  // Why 12 ms: fast enough to read as a strike, slow enough not to click
  out.gain.linearRampToValueAtTime(peak * masterVolume, at + 0.012)
  out.gain.exponentialRampToValueAtTime(0.0001, at + duration)
  out.connect(c.destination)

  const fundamental = c.createOscillator()
  fundamental.type = 'sine'
  fundamental.frequency.value = freq
  fundamental.connect(out)
  fundamental.start(at)
  fundamental.stop(at + duration + 0.05)

  if (overtone > 0) {
    const partial = c.createOscillator()
    const pg = c.createGain()
    partial.type = 'sine'
    partial.frequency.value = freq * 2
    pg.gain.setValueAtTime(overtone, at)
    // Why a third of the note: the overtone gives the strike, then only the warm fundamental rings
    pg.gain.exponentialRampToValueAtTime(0.0001, at + duration / 3)
    partial.connect(pg)
    pg.connect(out)
    partial.start(at)
    partial.stop(at + duration / 3 + 0.05)
  }
}

/**
 * Play a cue's notes if it is allowed now. Each note: [Hz, offset s, duration s, peak].
 * Why peaks of 0.02–0.07 (×volume): -28 to -35 dBFS at 50 %, no louder than
 * the old chime; the softness is the sine, the attack and the lower notes.
 */
function playCue(cue: Cue, notes: [number, number, number, number][], overtone?: number) {
  const c = cueCtx()
  if (!c) return
  const now = Date.now()
  if (!cueAllowed(cue, now, lastCueAt)) return
  lastCueAt[cue] = now
  try {
    const t = c.currentTime + 0.02
    for (const [freq, offset, duration, peak] of notes) softNote(c, freq, t + offset, duration, peak, overtone)
  } catch { /* a closed or broken context: stay silent */ }
}

/** Someone needs you: two gentle rising notes, E5 → A5 (a fourth, "hey?"). */
export function playNeedsYou() {
  playCue('needsYou', [
    [659.25, 0, 0.7, 0.05],   // E5
    [880, 0.16, 0.9, 0.05],   // A5
  ])
}

/**
 * Incident opened: three low descending notes, E4 → C4 → A3 (A minor), once.
 * Why not a siren: the room already turns red with a beacon; the sound only
 * has to say "look", and it plays once per 60 s at most.
 */
export function playAlarm() {
  playCue('alarm', [
    [329.63, 0, 0.6, 0.07],     // E4
    [261.63, 0.22, 0.6, 0.07],  // C4
    [220, 0.44, 1.1, 0.07],     // A3
  ], 0.15)
}

/** API error: a soft low "uh-oh", A3 → F3. */
export function playError() {
  playCue('error', [
    [220, 0, 0.45, 0.06],     // A3
    [174.61, 0.2, 0.7, 0.06], // F3
  ], 0.15)
}

/** Deploy shipped / task done: a quick soft C-major arpeggio, C5 E5 G5 C6. */
export function playCelebration() {
  playCue('celebration', [
    [523.25, 0, 0.5, 0.04],      // C5
    [659.25, 0.09, 0.5, 0.04],   // E5
    [783.99, 0.18, 0.5, 0.04],   // G5
    [1046.5, 0.27, 0.9, 0.035],  // C6
  ])
}

/**
 * The desk bell the boss rings when you click it: two soft strikes, C6 then
 * A5, with a strong first overtone so it reads as metal, decaying over ~1 s.
 */
export function playBell() {
  playCue('bell', [
    [1046.5, 0, 1.2, 0.03],   // C6
    [880, 0.28, 1.0, 0.02],   // A5
  ], 0.45)
}

// ===========================================================================
// The ambient bed
// ===========================================================================

/** Why 6 s: long enough that the loop is never heard as a loop, ~1 MB of floats at 48 kHz. */
const NOISE_SECONDS = 6
/** Why 0.5 s: a seam cross-fade long enough to hide the join in low-frequency noise. */
const NOISE_FADE_SECONDS = 0.5
/** Why 1.5 s: setTargetAtTime reaches ~95 % after 3 time constants — a ~4.5 s fade in. */
const FADE_IN_TC = 1.5
/** Why 0.25 s: muting or leaving the tab should go quiet within a second. */
const FADE_OUT_TC = 0.25
/** Why 0.3 s: volume drags and day/night changes glide instead of stepping. */
const ADJUST_TC = 0.3
/** Why 1500 ms: six fade-out time constants — inaudible by then, so the nodes can stop. */
const STOP_AFTER_MS = 1_500

let noiseBuffer: AudioBuffer | null = null

function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === c.sampleRate) return noiseBuffer
  const rate = c.sampleRate || 48_000
  const data = loopedBrownNoise(Math.round(rate * NOISE_SECONDS), Math.round(rate * NOISE_FADE_SECONDS))
  const buf = c.createBuffer(1, data.length, rate)
  buf.getChannelData(0).set(data)
  noiseBuffer = buf
  return buf
}

interface Bed {
  out: GainNode
  sources: AudioScheduledSourceNode[]
  textureTimer: ReturnType<typeof setTimeout> | null
}

let bed: Bed | null = null

function loopNoise(c: AudioContext, rate: number, offset: number): AudioBufferSourceNode {
  const src = c.createBufferSource()
  src.buffer = getNoise(c)
  src.loop = true
  src.playbackRate.value = rate
  src.start(c.currentTime, offset)
  return src
}

function filter(c: AudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = c.createBiquadFilter()
  f.type = type
  f.frequency.value = freq
  f.Q.value = q
  return f
}

function gainNode(c: AudioContext, value: number): GainNode {
  const g = c.createGain()
  g.gain.value = value
  return g
}

/** Build and start the bed's nodes, silent; syncAmbience fades it in. */
function startBed(c: AudioContext): Bed {
  const out = gainNode(c, 0)
  out.connect(c.destination)
  const sources: AudioScheduledSourceNode[] = []

  // Room tone: brown noise under 300 Hz — the low rumble of a building.
  // Why 0.033: -50 dBFS RMS at 50 % volume, the loudest layer of the bed.
  // (Raw brown noise is -14 dBFS; a first try at 0.5 measured -26.5 dBFS,
  // louder than the cues.)
  const room = loopNoise(c, 1, 0)
  const roomLp = filter(c, 'lowpass', 300, 0.5)
  const roomGain = gainNode(c, 0.033)
  room.connect(roomLp); roomLp.connect(roomGain); roomGain.connect(out)
  sources.push(room)

  // Air from the vents: the same noise played 1.37× faster (so it never lines
  // up with the room layer) through a wide band around 700 Hz, breathing over
  // ~14 s. Why 0.036 ± 0.012: -54 dBFS at 50 % — a few dB under the rumble
  // in level, but in the band ears and laptop speakers hear best.
  const air = loopNoise(c, 1.37, 2.1)
  const airBp = filter(c, 'bandpass', 700, 0.6)
  const airGain = gainNode(c, 0.036)
  air.connect(airBp); airBp.connect(airGain); airGain.connect(out)
  const breath = c.createOscillator()
  breath.frequency.value = 0.07  // Why 0.07 Hz: one slow swell every ~14 s, like HVAC cycling
  const breathDepth = gainNode(c, 0.012)
  breath.connect(breathDepth); breathDepth.connect(airGain.gain)
  breath.start()
  sources.push(air, breath)

  // Mains hum: 50 Hz and its 100 Hz harmonic, barely there (laptop speakers
  // will not reproduce 50 Hz at all; headphones get a hint of the building).
  // Why 0.002 / 0.0015: -63 / -66 dBFS at 50 % volume — felt more than heard.
  for (const [freq, level] of [[50, 0.002], [100, 0.0015]] as const) {
    const hum = c.createOscillator()
    hum.type = 'sine'
    hum.frequency.value = freq
    const hg = gainNode(c, level)
    hum.connect(hg); hg.connect(out)
    hum.start()
    sources.push(hum)
  }

  const b: Bed = { out, sources, textureTimer: null }
  scheduleTexture(b)
  return b
}

/** Queue the next distant office noise on this bed (stops with it). */
function scheduleTexture(b: Bed) {
  b.textureTimer = setTimeout(() => {
    if (bed !== b || !ctx) return
    try { playTexture(ctx, b.out) } catch { /* ignore */ }
    scheduleTexture(b)
  }, nextTextureDelayMs(night))
}

/** One distant, muffled office noise into the bed's output (so it fades with it). */
function playTexture(c: AudioContext, out: GainNode) {
  const t = c.currentTime + 0.05
  const pick = Math.random()
  if (pick < 0.5) {
    // Typing two desks over: 6–14 soft clicks through a wall (low-passed noise)
    const src = loopNoise(c, 1, Math.random() * 4)
    const lp = filter(c, 'lowpass', 1400, 0.7)  // Why 1.4 kHz: muffled, so it reads as distant, not as a keyboard here
    const env = gainNode(c, 0)
    src.connect(lp); lp.connect(env); env.connect(out)
    const clicks = 6 + Math.floor(Math.random() * 9)
    let at = t
    for (let i = 0; i < clicks; i++) {
      env.gain.setValueAtTime(0, at)
      env.gain.linearRampToValueAtTime(0.025, at + 0.004)  // Why 0.025: -52 dBFS clicks at 50 %, level with the room tone
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.035)
      at += 0.09 + Math.random() * 0.12  // Why 90–210 ms: a relaxed typist, not a burst
    }
    src.stop(at + 0.1)
  } else if (pick < 0.8) {
    // A drawer or door closing down the corridor: a low thump
    const osc = c.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(90, t)
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.25)  // Why 90 → 45 Hz: a soft wooden thud, not a drum
    const env = gainNode(c, 0)
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(0.0125, t + 0.01)  // Why 0.0125: a -44 dBFS peak at 50 %, the loudest thing in the bed and still far under a cue
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    osc.connect(env); env.connect(out)
    osc.start(t)
    osc.stop(t + 0.4)
  } else {
    // Paper shuffled somewhere: a short swell of mid-band noise
    const src = loopNoise(c, 1.8, Math.random() * 4)
    const bp = filter(c, 'bandpass', 2200, 1.2)
    const env = gainNode(c, 0)
    env.gain.setValueAtTime(0, t)
    env.gain.linearRampToValueAtTime(0.068, t + 0.25)  // Why 0.068: brown noise is thin at 2 kHz; this lands at -56 dBFS at 50 %
    env.gain.linearRampToValueAtTime(0, t + 0.7)
    src.connect(bp); bp.connect(env); env.connect(out)
    src.stop(t + 0.75)
  }
}

/** Fade a bed out and stop its nodes once it is silent. */
function stopBed(b: Bed) {
  if (b.textureTimer) clearTimeout(b.textureTimer)
  b.textureTimer = null
  try {
    const c = getCtx()
    b.out.gain.cancelScheduledValues?.(c.currentTime)
    b.out.gain.setTargetAtTime(0, c.currentTime, FADE_OUT_TC)
  } catch { /* ignore */ }
  // Why the bed is passed in: a bed restarted during this fade (StrictMode's
  // mount/unmount/mount, a quick unmute) has its own nodes and is not stopped
  // by this timer (audit C46)
  setTimeout(() => {
    for (const s of b.sources) { try { s.stop() } catch { /* already stopped */ } }
    try { b.out.disconnect() } catch { /* ignore */ }
  }, STOP_AFTER_MS)
}

/**
 * Bring the bed in line with the settings: start it, stop it or move its
 * level. Every setter below calls this.
 */
function syncAmbience() {
  const level = ambienceGain(masterVolume, ambienceOn, night)
  const want = ambientWanted && unlocked && !pageHidden && level > 0
  if (!want) {
    if (bed) { const b = bed; bed = null; stopBed(b) }
    return
  }
  try {
    const c = getCtx()
    if (!bed) {
      bed = startBed(c)
      bed.out.gain.setValueAtTime(0, c.currentTime)
      bed.out.gain.setTargetAtTime(level, c.currentTime, FADE_IN_TC)
    } else {
      bed.out.gain.setTargetAtTime(level, c.currentTime, ADJUST_TC)
    }
  } catch {
    bed = null  // no Web Audio here
  }
}

/**
 * The page wants the ambient bed (App's mount effect). It plays once a user
 * gesture has unlocked audio and while sound and Ambience are on and the tab
 * is visible. Kept under its old name: callers start "the hum".
 */
export function playAmbientHum() {
  ambientWanted = true
  syncAmbience()
}

/** The page no longer wants the bed (unmount): fade it out and stop it. */
export function stopAmbient() {
  ambientWanted = false
  syncAmbience()
}

/**
 * The first user gesture: resume (or create) the audio context and let the
 * bed start. Safe to call more than once.
 */
export function unlockAudio() {
  unlocked = true
  try {
    const c = getCtx()
    if (c.state === 'suspended') void c.resume?.()
  } catch { /* no Web Audio here */ }
  syncAmbience()
}

/** Ambience on/off (Settings › Ambience); event cues are unaffected. */
export function setAmbience(on: boolean) {
  ambienceOn = on
  syncAmbience()
}
export function isAmbienceOn() { return ambienceOn }

/** Day/night: the bed is quieter, with fewer distant noises, at dusk and night. */
export function setAmbienceNight(isNight: boolean) {
  if (night === isNight) return
  night = isNight
  syncAmbience()
}

/** Tab hidden or shown: the bed stops while nobody is looking. */
export function setPageHidden(hidden: boolean) {
  pageHidden = hidden
  syncAmbience()
}

/**
 * Wire the bed to the page: unlock on the first click / tap / key (the
 * browser's autoplay rule) and pause it while the tab is hidden.
 * @param doc the page's document
 * @returns a function that removes the listeners
 */
export function attachAmbience(doc: Document = document): () => void {
  // Why these events: a pointer or key press is a gesture in every browser;
  // iOS Safari only resumes audio from touchend / click
  const GESTURES = ['pointerdown', 'keydown', 'touchend', 'click'] as const
  const onGesture = () => {
    unlockAudio()
    for (const g of GESTURES) doc.removeEventListener(g, onGesture, true)
  }
  const onVisibility = () => setPageHidden(doc.hidden)
  if (!unlocked) for (const g of GESTURES) doc.addEventListener(g, onGesture, true)
  doc.addEventListener('visibilitychange', onVisibility)
  setPageHidden(doc.hidden)
  return () => {
    for (const g of GESTURES) doc.removeEventListener(g, onGesture, true)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}

// ===========================================================================
// Volume control (0–1)
// ===========================================================================

/** Set the main volume (0 = muted); the bed follows. */
export function setVolume(v: number) {
  masterVolume = Math.max(0, Math.min(1, v))
  if (masterVolume > 0) preMuteVolume = masterVolume
  syncAmbience()
}
export function getVolume() { return masterVolume }
export function isMuted() { return masterVolume === 0 }
/**
 * Mute, or unmute back to the last level.
 * @returns whether it is now muted
 */
export function toggleMute() {
  if (masterVolume > 0) {
    preMuteVolume = masterVolume
    masterVolume = 0
  } else {
    masterVolume = preMuteVolume > 0 ? preMuteVolume : 0.5
  }
  syncAmbience()
  return masterVolume === 0
}
