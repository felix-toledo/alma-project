// Console-style ambience: theme, moving backdrop, UI sounds and ambient music.
// Everything is synthesized with Web Audio, so there are no audio files or licenses to manage.

export interface AmbiencePrefs {
  theme: 'dark' | 'light'
  /** Moving backdrop. Off = it stays still. */
  motion: boolean
  sounds: boolean
  music: boolean
}

const KEY = 'ambience'

function stored(): Partial<AmbiencePrefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AmbiencePrefs>
  } catch {
    return {}
  }
}

let prefs: AmbiencePrefs = {
  theme: 'dark',
  motion: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  sounds: true,
  music: true,
  ...stored()
}
const listeners = new Set<() => void>()

export const getPrefs = (): AmbiencePrefs => prefs

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setPrefs(patch: Partial<AmbiencePrefs>): void {
  prefs = { ...prefs, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Preferences just won't survive a restart.
  }
  apply()
  listeners.forEach((listener) => listener())
}

function apply(): void {
  document.documentElement.dataset.theme = prefs.theme
  document.documentElement.dataset.motion = prefs.motion ? 'on' : 'off'
  syncMusic()
}

// ---------------------------------------------------------------------------
// Audio

let ctx: AudioContext | undefined

const midi = (note: number): number => 440 * 2 ** ((note - 69) / 12)

/** Short enveloped tones, one after another: the console "tick" and "confirm". */
function tones(notes: number[], duration: number, volume: number): void {
  if (!prefs.sounds || ctx?.state !== 'running') return
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

export const playHover = (): void => tones([93], 0.06, 0.02)
export const playSelect = (): void => tones([81, 88], 0.12, 0.045)

// Slow, warm chords (Am9 · Fmaj9 · Cmaj9 · G6/9) with a few high "bells" through a long echo.
const CHORDS = [
  [45, 57, 60, 64, 67, 71],
  [41, 53, 57, 60, 64, 67],
  [48, 55, 59, 62, 64, 71],
  [43, 55, 59, 62, 64, 69]
]
const CHORD_SECONDS = 11
const MUSIC_VOLUME = 0.05

let music: { out: GainNode; filter: BiquadFilterNode; echo: DelayNode; timer: number; chord: number } | undefined

function musicBus(ac: AudioContext): NonNullable<typeof music> {
  const out = ac.createGain()
  out.gain.value = 0
  out.connect(ac.destination)
  // Long feedback echo for space.
  const echo = ac.createDelay(2)
  echo.delayTime.value = 0.62
  const feedback = ac.createGain()
  feedback.gain.value = 0.42
  echo.connect(feedback).connect(echo)
  echo.connect(out)
  // A lowpass that breathes very slowly.
  const filter = ac.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 900
  filter.Q.value = 0.7
  const lfo = ac.createOscillator()
  const depth = ac.createGain()
  lfo.frequency.value = 0.04
  depth.gain.value = 350
  lfo.connect(depth).connect(filter.frequency)
  lfo.start()
  filter.connect(out)
  filter.connect(echo)
  return { out, filter, echo, timer: 0, chord: 0 }
}

function playChord(bus: NonNullable<typeof music>): void {
  const ac = ctx!
  const at = ac.currentTime
  const end = at + CHORD_SECONDS + 5
  for (const [i, note] of CHORDS[bus.chord % CHORDS.length].entries()) {
    const gain = ac.createGain()
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(i === 0 ? 0.32 : 0.14, at + 4)
    gain.gain.setValueAtTime(i === 0 ? 0.32 : 0.14, at + CHORD_SECONDS)
    gain.gain.linearRampToValueAtTime(0, end)
    gain.connect(bus.filter)
    // Two slightly detuned voices per note make the pad shimmer.
    for (const detune of i === 0 ? [0] : [-7, 7]) {
      const osc = ac.createOscillator()
      osc.type = i === 0 ? 'sine' : 'sawtooth'
      osc.frequency.value = midi(note)
      osc.detune.value = detune
      osc.connect(gain)
      osc.start(at)
      osc.stop(end + 0.1)
    }
  }
  // Two soft bells from the chord, an octave or two up, at random moments.
  for (let n = 0; n < 2; n++) {
    const notes = CHORDS[bus.chord % CHORDS.length]
    const note = notes[1 + Math.floor(Math.random() * (notes.length - 1))] + 24
    const when = at + 1 + Math.random() * (CHORD_SECONDS - 2)
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'triangle'
    osc.frequency.value = midi(note)
    gain.gain.setValueAtTime(0, when)
    gain.gain.linearRampToValueAtTime(0.05, when + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 3)
    osc.connect(gain)
    gain.connect(bus.out)
    gain.connect(bus.echo)
    osc.start(when)
    osc.stop(when + 3.1)
  }
  bus.chord++
}

/** Plays music only while it's on, the window is visible and the user has interacted (autoplay rules). */
function syncMusic(): void {
  if (!ctx || ctx.state !== 'running') return
  const shouldPlay = prefs.music && !document.hidden
  if (shouldPlay && !music?.timer) {
    music ??= musicBus(ctx)
    music.out.gain.cancelScheduledValues(ctx.currentTime)
    music.out.gain.setTargetAtTime(MUSIC_VOLUME, ctx.currentTime, 1.5)
    playChord(music)
    music.timer = window.setInterval(() => playChord(music!), CHORD_SECONDS * 1000)
  } else if (!shouldPlay && music?.timer) {
    window.clearInterval(music.timer)
    music.timer = 0
    // Chords already playing fade out with the bus and end on their own.
    music.out.gain.cancelScheduledValues(ctx.currentTime)
    music.out.gain.setTargetAtTime(0, ctx.currentTime, 0.6)
  }
}

const INTERACTIVE = 'button, [role="button"], a[href], select, summary, input[type="checkbox"], input[type="radio"]'

/** Call once at startup: applies the theme and wires sounds to every interactive element. */
export function startAmbience(): void {
  apply()
  const unlock = (): void => {
    ctx ??= new AudioContext()
    void ctx.resume().then(syncMusic)
  }
  document.addEventListener('pointerdown', unlock, { once: true, capture: true })
  document.addEventListener('keydown', unlock, { once: true, capture: true })
  document.addEventListener('visibilitychange', syncMusic)

  let hovered: Element | null = null
  document.addEventListener('pointerover', (event) => {
    const target = (event.target as Element).closest(INTERACTIVE)
    if (target && target !== hovered && !(target as HTMLButtonElement).disabled) playHover()
    hovered = target
  })
  document.addEventListener(
    'click',
    (event) => {
      const target = (event.target as Element).closest(INTERACTIVE)
      if (target && !(target as HTMLButtonElement).disabled) playSelect()
    },
    true
  )
}
