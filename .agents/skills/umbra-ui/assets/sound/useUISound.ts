import { useSyncExternalStore } from 'react'
import { SOUNDS, type UISoundEvent } from './sounds.config'

// Sonido de interfaz de Umbra.
// - Si un evento tiene `src` en sounds.config.ts, reproduce ese archivo.
// - If `src` is empty, it uses a tone synthesized with Web Audio (no files or licenses).
// - Synthesized ambient music (slow pads + little bells with echo), can be turned off.
// Nothing plays until the first user interaction.

const KEY = 'umbra.prefs'
type Prefs = { muted: boolean; volume: number; music: boolean; motion: boolean }
const DEFAULTS: Prefs = {
  muted: false,
  volume: 0.7,
  music: true,
  motion: !matchMedia('(prefers-reduced-motion: reduce)').matches
}

let prefs: Prefs = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
})()
let ctx: AudioContext | undefined
const listeners = new Set<() => void>()
const lastPlayed = new Map<UISoundEvent, number>()
const files = new Map<string, HTMLAudioElement>()

function apply(): void {
  document.documentElement.dataset.motion = prefs.motion ? '' : 'reduced'
  syncMusic()
}

function setPrefs(p: Partial<Prefs>): void {
  prefs = { ...prefs, ...p }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* no storage: it lasts the session */
  }
  apply()
  listeners.forEach((l) => l())
}

// ---------- synthesized tones per event: [MIDI notes, duration s, volume] ----------
const SYNTH: Record<UISoundEvent, [number[], number, number]> = {
  hover: [[93], 0.06, 0.02],
  'focus-move': [[91], 0.05, 0.02],
  select: [[81, 88], 0.12, 0.045],
  back: [[88, 81], 0.12, 0.04],
  'toggle-on': [[84, 91], 0.1, 0.04],
  'toggle-off': [[91, 84], 0.1, 0.04],
  'open-modal': [[76, 83, 88], 0.14, 0.04],
  'close-modal': [[88, 83, 76], 0.14, 0.04],
  error: [[60, 57], 0.18, 0.05],
  success: [[81, 88, 93], 0.14, 0.045],
  notification: [[88, 93], 0.16, 0.04],
  'page-transition': [[79, 86], 0.12, 0.03]
}
const midi = (n: number): number => 440 * 2 ** ((n - 69) / 12)

function tones(notes: number[], duration: number, volume: number): void {
  if (!ctx || ctx.state !== 'running') return
  const start = ctx.currentTime
  notes.forEach((note, i) => {
    const at = start + i * duration * 0.55
    const osc = ctx!.createOscillator()
    const gain = ctx!.createGain()
    osc.type = 'sine'
    osc.frequency.value = midi(note)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(volume, at + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    osc.connect(gain).connect(ctx!.destination)
    osc.start(at)
    osc.stop(at + duration + 0.05)
  })
}

/** Can be fired from anywhere (also outside React). */
export function playUISound(event: UISoundEvent): void {
  if (!ctx || prefs.muted) return
  const def = SOUNDS[event]
  const now = performance.now()
  if (now - (lastPlayed.get(event) ?? -Infinity) < def.cooldown) return
  lastPlayed.set(event, now)
  if (def.src) {
    let base = files.get(def.src)
    if (!base) files.set(def.src, (base = new Audio(def.src)))
    const a = base.cloneNode() as HTMLAudioElement
    a.volume = Math.min(1, def.volume * prefs.volume)
    void a.play().catch(() => {})
  } else {
    const [notes, dur, vol] = SYNTH[event]
    tones(notes, dur, vol * (prefs.volume / 0.7))
  }
}

// ---------- ambient music ----------
// An original theme with the character of console menus: warm slow-attack pads, little
// glass bells (FM) in short phrases, a soft bass, a breath of air and plenty of reverb. Lydian harmony in D,
// chords with 9ths and #11 that never "resolve", so that it feels calm and suspended.
type Chord = { bass: number; pad: number[]; bells: number[] }
const CHORDS: Chord[] = [
  { bass: 38, pad: [57, 61, 64, 66], bells: [73, 76, 78, 81, 85, 88] }, // Dmaj9
  { bass: 35, pad: [57, 62, 64, 66], bells: [71, 74, 76, 78, 81, 83] }, // Bm11
  { bass: 31, pad: [54, 59, 61, 62], bells: [73, 74, 78, 79, 81, 85] }, // Gmaj7#11
  { bass: 40, pad: [55, 59, 62, 66], bells: [71, 74, 76, 78, 83, 86] } // Em9
]
const CHORD_SECONDS = 12
const MUSIC_VOLUME = 0.32
type Bus = { out: GainNode; dry: GainNode; reverb: ConvolverNode; delay: DelayNode; timer: number; chord: number }
let music: Bus | undefined

/** Generated reverb response: stereo noise with an exponential decay (~5 s), no files. */
function impulse(ac: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ac.sampleRate * seconds)
  const buf = ac.createBuffer(2, len, ac.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3.2
  }
  return buf
}

function musicBus(ac: AudioContext): Bus {
  const out = ac.createGain()
  out.gain.value = 0
  const comp = ac.createDynamicsCompressor()
  comp.threshold.value = -24
  comp.ratio.value = 3
  out.connect(comp).connect(ac.destination)

  const dry = ac.createGain()
  dry.gain.value = 0.55
  dry.connect(out)

  const reverb = ac.createConvolver()
  reverb.buffer = impulse(ac, 5)
  const wet = ac.createGain()
  wet.gain.value = 0.9
  reverb.connect(wet).connect(out)

  // A soft ping-pong echo (left/right) that feeds the reverb.
  const delay = ac.createDelay(2)
  delay.delayTime.value = 0.75
  const fb = ac.createGain()
  fb.gain.value = 0.38
  const tone = ac.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 2800
  const left = ac.createStereoPanner()
  left.pan.value = -0.7
  const right = ac.createStereoPanner()
  right.pan.value = 0.7
  const delay2 = ac.createDelay(2)
  delay2.delayTime.value = 0.75
  delay.connect(tone).connect(left).connect(reverb)
  left.connect(out)
  tone.connect(delay2).connect(right).connect(out)
  right.connect(reverb)
  delay2.connect(fb).connect(delay)

  return { out, dry, reverb, delay, timer: 0, chord: 0 }
}

function pad(bus: Bus, chord: Chord, at: number): void {
  const ac = ctx!
  const end = at + CHORD_SECONDS + 6
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 0.5
  // The filter opens and closes on each chord: it "breathes".
  filter.frequency.setValueAtTime(500, at)
  filter.frequency.linearRampToValueAtTime(1600, at + CHORD_SECONDS * 0.55)
  filter.frequency.linearRampToValueAtTime(700, end)
  filter.connect(bus.dry)
  filter.connect(bus.reverb)
  chord.pad.forEach((note, i) => {
    const gain = ac.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.022, at + 4.5)
    gain.gain.setValueAtTime(0.022, at + CHORD_SECONDS)
    gain.gain.linearRampToValueAtTime(0, end)
    const pan = ac.createStereoPanner()
    pan.pan.value = (i / (chord.pad.length - 1)) * 1.2 - 0.6
    gain.connect(pan).connect(filter)
    for (const [type, detune] of [['sawtooth', -6], ['sawtooth', 6], ['triangle', 0]] as const) {
      const osc = ac.createOscillator()
      osc.type = type
      osc.frequency.value = midi(note)
      osc.detune.value = detune
      osc.connect(gain)
      osc.start(at)
      osc.stop(end + 0.1)
    }
  })
  // Bass: a sine + its octave (so that it is also heard on small speakers).
  const bass = ac.createGain()
  bass.gain.setValueAtTime(0, at)
  bass.gain.linearRampToValueAtTime(0.07, at + 3)
  bass.gain.setValueAtTime(0.07, at + CHORD_SECONDS)
  bass.gain.linearRampToValueAtTime(0, end - 2)
  bass.connect(bus.dry)
  for (const [n, level] of [[chord.bass, 1], [chord.bass + 12, 0.35]]) {
    const g = ac.createGain()
    g.gain.value = level
    const osc = ac.createOscillator()
    osc.frequency.value = midi(n)
    osc.connect(g).connect(bass)
    osc.start(at)
    osc.stop(end)
  }
}

/** Glass bell: FM with an inharmonic ratio, brightness that fades fast. */
function bell(bus: Bus, note: number, when: number, level: number): void {
  const ac = ctx!
  const f = midi(note)
  const car = ac.createOscillator()
  const mod = ac.createOscillator()
  const index = ac.createGain()
  const amp = ac.createGain()
  const pan = ac.createStereoPanner()
  car.frequency.value = f
  mod.frequency.value = f * 3.5
  index.gain.setValueAtTime(f * 1.6, when)
  index.gain.exponentialRampToValueAtTime(f * 0.05, when + 1.2)
  amp.gain.setValueAtTime(0, when)
  amp.gain.linearRampToValueAtTime(level, when + 0.006)
  amp.gain.exponentialRampToValueAtTime(0.0001, when + 4)
  pan.pan.value = Math.random() * 1.2 - 0.6
  mod.connect(index).connect(car.frequency)
  car.connect(amp).connect(pan)
  pan.connect(bus.dry)
  pan.connect(bus.reverb)
  pan.connect(bus.delay)
  car.start(when)
  mod.start(when)
  car.stop(when + 4.1)
  mod.stop(when + 4.1)
}

/** Short phrases of 3 to 5 notes, ascending or descending, separated by silences. */
function bells(bus: Bus, chord: Chord, at: number): void {
  let t = at + 1.5 + Math.random() * 1.5
  while (t < at + CHORD_SECONDS - 1.5) {
    const len = 3 + Math.floor(Math.random() * 3)
    const up = Math.random() < 0.6
    let idx = up ? Math.floor(Math.random() * 2) : chord.bells.length - 1 - Math.floor(Math.random() * 2)
    for (let i = 0; i < len && t < at + CHORD_SECONDS; i++) {
      bell(bus, chord.bells[idx], t, 0.035 - i * 0.004)
      idx = Math.max(0, Math.min(chord.bells.length - 1, idx + (up ? 1 : -1) * (1 + Math.floor(Math.random() * 2))))
      t += 0.38 + Math.random() * 0.3
    }
    t += 2.2 + Math.random() * 2.5 // silencio entre frases
  }
}

/** A filtered breath of air, very low, that rises and falls with the chord. */
function air(bus: Bus, at: number): void {
  const ac = ctx!
  const len = ac.sampleRate * 2
  const buf = ac.createBuffer(1, len, ac.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  const src = ac.createBufferSource()
  src.buffer = buf
  src.loop = true
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(1800, at)
  bp.frequency.linearRampToValueAtTime(3600, at + CHORD_SECONDS)
  bp.Q.value = 0.8
  const g = ac.createGain()
  g.gain.setValueAtTime(0, at)
  g.gain.linearRampToValueAtTime(0.008, at + CHORD_SECONDS / 2)
  g.gain.linearRampToValueAtTime(0, at + CHORD_SECONDS + 2)
  src.connect(bp).connect(g).connect(bus.reverb)
  src.start(at)
  src.stop(at + CHORD_SECONDS + 2.1)
}

function playChord(bus: Bus): void {
  const at = ctx!.currentTime + 0.05
  const chord = CHORDS[bus.chord % CHORDS.length]
  pad(bus, chord, at)
  bells(bus, chord, at)
  if (bus.chord % 2 === 0) air(bus, at)
  bus.chord++
}

/** It plays only if the music is on, the window visible and the user has already interacted. */
function syncMusic(): void {
  if (!ctx || ctx.state !== 'running') return
  const shouldPlay = prefs.music && !prefs.muted && !document.hidden
  if (shouldPlay && !music?.timer) {
    music ??= musicBus(ctx)
    music.out.gain.cancelScheduledValues(ctx.currentTime)
    music.out.gain.setTargetAtTime(MUSIC_VOLUME * (prefs.volume / 0.7), ctx.currentTime, 1.5)
    playChord(music)
    music.timer = window.setInterval(() => playChord(music!), CHORD_SECONDS * 1000)
  } else if (shouldPlay && music?.timer) {
    // Volume change while playing: it adjusts live, with no cuts.
    music.out.gain.setTargetAtTime(MUSIC_VOLUME * (prefs.volume / 0.7), ctx.currentTime, 0.15)
  } else if (!shouldPlay && music?.timer) {
    window.clearInterval(music.timer)
    music.timer = 0
    music.out.gain.cancelScheduledValues(ctx.currentTime)
    music.out.gain.setTargetAtTime(0, ctx.currentTime, 0.6)
  }
}

// ---------- arranque ----------
const unlock = (): void => {
  ctx ??= new AudioContext()
  void ctx.resume().then(syncMusic)
}
document.addEventListener('pointerdown', unlock, { once: true, capture: true })
document.addEventListener('keydown', unlock, { once: true, capture: true })
document.addEventListener('visibilitychange', syncMusic)
apply()

const subscribe = (l: () => void): (() => void) => (listeners.add(l), () => void listeners.delete(l))
const getSnap = (): Prefs => prefs

export function useUISound() {
  const p = useSyncExternalStore(subscribe, getSnap)
  return {
    play: playUISound,
    ...p,
    setMuted: (muted: boolean) => setPrefs({ muted }),
    setVolume: (volume: number) => setPrefs({ volume }),
    setMusic: (music: boolean) => setPrefs({ music }),
    setMotion: (motion: boolean) => setPrefs({ motion })
  }
}
