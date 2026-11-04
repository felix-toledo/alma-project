import type { VoicePlayback } from '../../../shared/types'
import workletUrl from './capture-worklet.js?url'

export interface Capture {
  stop(): void
}

/** Streams the microphone as 80 ms chunks of mono 16 kHz Int16 PCM (Chromium resamples to the context's rate). */
export async function startCapture(deviceId: string, onChunk: (pcm: ArrayBuffer) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  const context = new AudioContext({ sampleRate: 16000 })
  await context.audioWorklet.addModule(workletUrl)
  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'alma-capture')
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onChunk(event.data)
  source.connect(node)
  return {
    stop() {
      node.port.onmessage = null
      source.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      void context.close()
    }
  }
}

/** Records `ms` of audio as one Int16 buffer (for learning the user's voice). */
export async function recordFor(ms: number, deviceId: string, onLevel?: (level: number) => void): Promise<ArrayBuffer> {
  const chunks: Int16Array[] = []
  const capture = await startCapture(deviceId, (pcm) => {
    const chunk = new Int16Array(pcm)
    chunks.push(chunk)
    if (onLevel) {
      let peak = 0
      for (const s of chunk) peak = Math.max(peak, Math.abs(s))
      onLevel(peak / 32768)
    }
  })
  await new Promise((resolve) => setTimeout(resolve, ms))
  capture.stop()
  const out = new Int16Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}

/** Plays what Alma says, in order; `onFinished` fires after the piece marked `last` ends (or on stop). */
export class Player {
  private context: AudioContext | null = null
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  private current: { stop(): void } | null = null

  constructor(private onFinished: () => void) {}

  enqueue(playback: VoicePlayback, last: boolean): void {
    this.stopped = false
    this.queue = this.queue.then(async () => {
      if (!this.stopped) await this.playOne(playback).catch((error) => console.error('[voice] playback:', error))
      if (last) this.onFinished()
    })
  }

  stop(): void {
    this.stopped = true
    this.current?.stop()
    speechSynthesis.cancel()
  }

  private playOne(playback: VoicePlayback): Promise<void> {
    if (playback.kind === 'pcm') {
      if (playback.samples.length === 0) return Promise.resolve()
      this.context ??= new AudioContext()
      const context = this.context
      const buffer = context.createBuffer(1, playback.samples.length, playback.sampleRate)
      buffer.copyToChannel(Float32Array.from(playback.samples), 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      return new Promise((resolve) => {
        source.onended = () => resolve()
        this.current = { stop: () => source.stop() }
        source.start()
      })
    }
    if (playback.kind === 'encoded') {
      const url = URL.createObjectURL(new Blob([playback.data], { type: playback.mime }))
      const audio = new Audio(url)
      return new Promise((resolve) => {
        const done = (): void => {
          URL.revokeObjectURL(url)
          resolve()
        }
        audio.onended = done
        audio.onerror = done
        this.current = { stop: () => (audio.pause(), done()) }
        void audio.play().catch(done)
      })
    }
    return speak(playback.text, playback.voice)
  }
}

/** Windows' own voices (Helena, Sabina…): free, offline and instant. */
export function speak(text: string, voiceName: string): Promise<void> {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text)
    const voices = speechSynthesis.getVoices()
    utterance.voice = voices.find((v) => v.name === voiceName) ?? voices.find((v) => v.lang.startsWith('es')) ?? null
    utterance.lang = utterance.voice?.lang ?? 'es-ES'
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    speechSynthesis.speak(utterance)
  })
}

/** Two soft notes when Alma starts listening (like ALMA's "¿Sí?", but instant). */
export function chime(): void {
  const context = new AudioContext()
  const now = context.currentTime
  ;[880, 1320].forEach((freq, i) => {
    const osc = context.createOscillator()
    const gain = context.createGain()
    osc.frequency.value = freq
    osc.type = 'sine'
    gain.gain.setValueAtTime(0, now + i * 0.11)
    gain.gain.linearRampToValueAtTime(0.12, now + i * 0.11 + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.25)
    osc.connect(gain).connect(context.destination)
    osc.start(now + i * 0.11)
    osc.stop(now + i * 0.11 + 0.3)
  })
  setTimeout(() => void context.close(), 800)
}
