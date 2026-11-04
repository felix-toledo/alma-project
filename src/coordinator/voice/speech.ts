// Pure helpers for the voice assistant: what to say out loud, yes/no answers and end-of-speech detection.
import type { ChatMessage } from '../../shared/types'

/** The tool a model calls in a voice conversation when nothing is left to say or wait for. */
export const END_VOICE_TOOL = 'end_voice_conversation'

/** Did the model close the conversation in its latest answer? Only calls after the latest user message count. */
export function conversationEnded(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user' && message.content.some((b) => b.type === 'text')) return false
    if (message.role === 'assistant' && message.content.some((b) => b.type === 'tool_use' && b.name === END_VOICE_TOOL)) return true
  }
  return false
}

/** Markdown answer → plain text worth hearing: no code, URLs, tables or formatting marks. */
export function speakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (te dejé el código en la pantalla) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'un enlace')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Sentences, so speech starts before the whole answer is synthesized. Very short ones are joined (a lone "Hola."
 * sounds clipped) and very long ones are cut at word boundaries (Kokoro takes ~500 tokens at most).
 */
export function splitSentences(text: string, max = 280): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const sentence of sentences) {
    const last = out[out.length - 1]
    if (last && last.length + sentence.length + 1 <= 60) out[out.length - 1] = `${last} ${sentence}`
    else out.push(sentence)
  }
  return out.flatMap((s) => (s.length <= max ? [s] : s.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g'))!.map((p) => p.trim())))
}

/**
 * Collects the model's streamed text and hands out whatever is complete enough to say, so speech starts while the
 * model is still writing. Never cuts inside a code block (it's replaced by a short notice once it closes).
 */
export class SentenceStream {
  private buffer = ''

  push(text: string): string[] {
    this.buffer += text
    const fences = this.buffer.split('```').length - 1
    const region = fences % 2 === 1 ? this.buffer.slice(0, this.buffer.lastIndexOf('```')) : this.buffer
    let cut = -1
    for (const match of region.matchAll(/[.!?…:]+["»)]?(?=\s)|\n/g)) cut = match.index + match[0].length
    if (cut <= 0) return []
    const ready = speakable(this.buffer.slice(0, cut))
    this.buffer = this.buffer.slice(cut)
    // One sentence per piece: the first one synthesizes (and sounds) sooner than a whole paragraph.
    return ready ? splitSentences(ready) : []
  }

  /** Whatever is left when the model stops (or before it runs a tool). */
  flush(): string[] {
    const rest = speakable(this.buffer)
    this.buffer = ''
    return rest ? [rest] : []
  }
}

/** Fillers said right away so silence never feels like a hang (cached as audio after the first time). */
export const FILLERS = {
  thinking: ['Mmm…', 'A ver…', 'Mmm, dejame pensar.', 'Esperá que pienso.', 'Ya te contesto.'],
  searching: ['Dame un segundo, que busco.', 'Ya va, lo estoy buscando.', 'Un momento, que me fijo.']
}

/** "Sí, dale" → yes; "no, cancelá" → no; anything else → null (ask again). */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\s]/gu, ' ')
  const no = /\b(no|nop|nunca|cancela\w*|rechaza\w*|para|frena|negativo|mejor no)\b/.test(t)
  const yes = /\b(si|dale|ok|okay|claro|bueno|perfecto|adelante|hacelo|permiti\w*|acepto|afirmativo|de una)\b/.test(t)
  if (no && !yes) return 'no'
  if (yes && !no) return 'yes'
  return null
}

const CHUNK_MS = 80

/**
 * Energy-based end-of-utterance detection on 80 ms chunks: waits for speech, then stops after a pause.
 * The noise floor adapts while waiting, so a fan or street noise doesn't count as speech.
 */
// ponytail: RMS energy, not a neural VAD; swap in silero_vad.onnx if noisy rooms cut people off.
const ENDPOINTER = { startTimeoutMs: 4000, shortSilenceMs: 750, longSilenceMs: 1100, shortSpeechMs: 2000, maxMs: 15000, minSpeechRms: 0.012 }

export class Endpointer {
  private options: typeof ENDPOINTER
  private floor = 0
  private chunks = 0
  private heard = false
  private heardAt = 0
  private silentMs = 0

  /**
   * A short start ("¿Me escuchás?…") usually continues after a pause, so it gets a longer wait; once the user has
   * been talking a while, a shorter pause ends the turn.
   */
  constructor(options: Partial<typeof ENDPOINTER> = {}) {
    this.options = { ...ENDPOINTER, ...options }
  }

  /** Feeds one chunk; 'continue' until the user stops talking ('done') or never started ('timeout'). */
  push(chunk: Float32Array): 'continue' | 'done' | 'timeout' {
    let sum = 0
    for (const x of chunk) sum += x * x
    const rms = Math.sqrt(sum / chunk.length)
    this.chunks++
    const elapsed = this.chunks * CHUNK_MS
    // The floor starts from the quietest early chunk and is capped: if the user starts talking right away, their
    // own voice must not be mistaken for background noise (that made the turn time out).
    if (this.chunks <= 3) this.floor = this.chunks === 1 ? rms : Math.min(this.floor, rms)
    const speaking = rms > Math.max(this.options.minSpeechRms, Math.min(this.floor * 2.5, 0.05))
    if (speaking) {
      if (!this.heard) this.heardAt = elapsed
      this.heard = true
      this.silentMs = 0
    } else {
      if (!this.heard) this.floor = this.floor * 0.9 + rms * 0.1
      this.silentMs += CHUNK_MS
    }
    if (elapsed >= this.options.maxMs) return this.heard ? 'done' : 'timeout'
    if (!this.heard) return elapsed >= this.options.startTimeoutMs ? 'timeout' : 'continue'
    const talkedMs = elapsed - this.silentMs - this.heardAt
    const needed = talkedMs < this.options.shortSpeechMs ? this.options.longSilenceMs : this.options.shortSilenceMs
    return this.silentMs >= needed ? 'done' : 'continue'
  }
}

/**
 * The user talking over Alma: loud enough for long enough. The window's echo cancellation removes Alma's own voice
 * from the microphone (WebAudio and <audio> playback only; Windows voices bypass it, so barge-in is off for them).
 */
// ponytail: RMS over the learned echo level; a neural VAD would ignore coughs and door slams.
export class BargeIn {
  private run = 0
  /** What's left of Alma's own voice after echo cancellation, learned while she talks. */
  private echo = 0
  private seen = 0

  constructor(private options = { minRms: 0.035, overEcho: 3, chunks: 5 }) {}

  /** True once `chunks` consecutive 80 ms chunks (400 ms) are clearly louder than Alma's echo. */
  push(chunk: Float32Array): boolean {
    let sum = 0
    for (const x of chunk) sum += x * x
    const rms = Math.sqrt(sum / chunk.length)
    // The first half second only learns: Alma has just started and the echo level is still unknown.
    if (++this.seen <= 6) {
      this.echo = Math.max(this.echo, rms)
      return false
    }
    const loud = rms > Math.max(this.options.minRms, this.echo * this.options.overEcho)
    // Only quieter chunks teach the echo level, so the user's own voice never raises the bar.
    if (!loud) this.echo = this.echo * 0.95 + rms * 0.05
    this.run = loud ? this.run + 1 : 0
    return this.run >= this.options.chunks
  }

  reset(): void {
    this.run = 0
    this.echo = 0
    this.seen = 0
  }
}

/** The "interruption" is mostly words Alma was saying: she heard herself through the speakers. */
export function isEcho(heard: string, said: string): boolean {
  const words = (text: string): string[] => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/\p{L}{3,}/gu) ?? []
  const spoken = new Set(words(said))
  const own = words(heard)
  return own.length >= 2 && own.filter((w) => spoken.has(w)).length / own.length >= 0.7
}

/** How long the microphone stays open after Alma answers: longer when she asked something (she's waiting for you). */
export function followUpMs(answer: string): number {
  return /[?¿]\s*["»)]?\s*$/.test(answer.trim()) ? 10_000 : 6_000
}

/** "Gracias", "listo, nada más", "chau": the user is closing the conversation, not asking something new. */
export function isGoodbye(text: string): boolean {
  const t = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return GOODBYE.test(t)
}

const CLOSING = 'gracias|muchas gracias|listo|nada|nada mas|chau|chao|adios|eso es todo|eso era todo|ya esta|esta bien|ok|okey|perfecto|genial|buenisimo|joya|de nada|hasta luego|nos vemos'
const GOODBYE = new RegExp(`^(no )?(${CLOSING})( (${CLOSING}|alma))*$`)

export function int16ToFloat(pcm: Int16Array): Float32Array {
  return Float32Array.from(pcm, (x) => x / 32768)
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}

/** WAV bytes (mono 16-bit) for the OpenAI transcription API. */
export function toWav(samples: Float32Array, sampleRate = 16000): Uint8Array<ArrayBuffer> {
  const pcm = Int16Array.from(samples, (x) => Math.max(-1, Math.min(1, x)) * 32767)
  const out = new Uint8Array(new ArrayBuffer(44 + pcm.byteLength))
  const view = new DataView(out.buffer)
  const text = (offset: number, value: string): void => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  out.set(new Uint8Array(pcm.buffer), 44)
  return out
}
