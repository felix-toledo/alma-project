// Voice assistant: wake word → (speaker check) → record until a pause → transcribe → agent → speak. Like ALMA's
// Python service, but in-process: the microphone streams from the window, the models run in a worker thread.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { META_BASE_URL } from '../../shared/defaults'
import type { LiveEvent, PendingApproval, Settings, Thread, VoicePlayback, VoiceSettings, VoiceStatus } from '../../shared/types'
import { BargeIn, concat, cosine, Endpointer, FILLERS, followUpMs, int16ToFloat, isEcho, isGoodbye, parseYesNo, SentenceStream, speakable, toWav } from './speech'
import type { VoiceWorkerReply, VoiceWorkerRequest } from './voice-worker'

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]

const RING_CHUNKS = 25 // 2 s of 80 ms chunks: the wake phrase, for the speaker check
const PREROLL_CHUNKS = 8 // what the user said just before the barge-in fired (it needs 400 ms of voice)
const PLAYBACK_TIMEOUT_MS = 120_000

export interface VoiceDeps {
  settings(): Settings
  dataDir: string
  /** The voice conversation (a new one after an hour of silence). */
  conversation(): Thread
  ask(threadId: string, text: string): Promise<void>
  /** Cancels the thread's run (the user talked over the answer). */
  stop(threadId: string): void
  lastAnswer(threadId: string): string
  /** Did the model close the spoken conversation (end_voice_conversation) in its last answer? */
  conversationEnded(threadId: string): boolean
  onEvent(listener: (event: LiveEvent) => void): () => void
  respondApproval(approvalId: string, decision: 'allow' | 'deny'): void
  emit(event: LiveEvent): void
}

export class VoiceAssistant {
  private worker: Worker | null = null
  private nextId = 0
  private waiters = new Map<number, { resolve(reply: VoiceWorkerReply): void; reject(error: Error): void; onChunk?(samples: Float32Array): void }>()
  private status: VoiceStatus = { state: 'off' }
  private ring: Float32Array[] = []
  private recording: { endpointer: Endpointer; chunks: Float32Array[]; finish(result: Float32Array | null): void } | null = null
  /** Resolvers for spoken turns, in the order the window will finish them. */
  private playbacks: (() => void)[] = []
  private turns = new Set<{ cancelled: boolean }>()
  private fillerCache = new Map<string, VoicePlayback[]>()
  private profile: Float32Array | null = null
  private configKey = ''
  private busy = false
  private bargeIn = new BargeIn()
  /** The thread being answered, so a barge-in can cancel its run. */
  private answering: string | null = null
  /** The user talked over Alma: the next turn starts with what they already said. */
  private interrupted = false
  private sinceInterrupt = 0
  /** The user pressed stop: end the conversation instead of waiting for a follow-up. */
  private hushed = false
  /** Ends the pause before sending early (cancelled). */
  private endPause: (() => void) | null = null
  /** The conversation of the answer in progress (or the last one). */
  private threadId = ''

  constructor(private deps: VoiceDeps) {
    this.profile = this.loadProfile()
  }

  private get config(): VoiceSettings {
    return this.deps.settings().voice
  }

  currentStatus(): VoiceStatus {
    return this.status
  }

  private setStatus(status: VoiceStatus): void {
    this.status = status
    this.deps.emit({ type: 'voice.status', status })
    // Wake-word detection only while idle: never while Alma itself is talking or the user is mid-request.
    this.post({ type: 'listen', on: status.state === 'listening' && this.config.wakeWord !== 'off' })
  }

  /** Applies settings: starts or stops listening and reconfigures the models. */
  sync(): void {
    const { enabled, wakeWord, sttModel, tts, kokoroVoice, elevenVoiceId, elevenModel } = this.config
    // The voice is part of the key: choosing another one prepares its fillers.
    const key = JSON.stringify({ enabled, wakeWord, sttModel, tts, kokoroVoice, elevenVoiceId, elevenModel })
    if (key === this.configKey) return
    this.configKey = key
    if (enabled || this.worker) this.post({ type: 'config', wakeWord, sttModel, warmKokoro: enabled && tts === 'kokoro' })
    if (enabled) this.prepareFillers()
    if (!enabled) {
      this.cancelRecording()
      if (this.status.state !== 'off') this.setStatus({ state: 'off' })
    } else if (this.status.state === 'off' || this.status.state === 'error') {
      this.setStatus({ state: 'listening' })
    }
  }

  // ---------------------------------------------------------------------------
  // Worker plumbing

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(join(__dirname, 'voiceWorker.js'), { workerData: { modelsDir: join(this.deps.dataDir, 'models') } })
    worker.on('message', (reply: VoiceWorkerReply) => this.onWorker(reply))
    worker.on('error', (error) => this.workerFailed(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', (code) => code !== 0 && this.workerFailed(new Error(`El proceso de voz terminó (código ${code}).`)))
    this.worker = worker
    const { wakeWord, sttModel, enabled, tts } = this.config
    worker.postMessage({ type: 'config', wakeWord, sttModel, warmKokoro: enabled && tts === 'kokoro' } satisfies VoiceWorkerRequest)
    return worker
  }

  private post(message: VoiceWorkerRequest, transfer: ArrayBuffer[] = []): void {
    if (!this.worker && message.type !== 'config' && message.type !== 'transcribe' && message.type !== 'embed' && message.type !== 'tts') return
    this.ensureWorker().postMessage(message, transfer)
  }

  private call(message: VoiceWorkerRequest & { id: number }, onChunk?: (samples: Float32Array) => void): Promise<VoiceWorkerReply> {
    return new Promise((resolve, reject) => {
      this.waiters.set(message.id, { resolve, reject, onChunk })
      this.post(message)
    })
  }

  private onWorker(reply: VoiceWorkerReply): void {
    if (reply.type === 'wake') return void this.onWake(reply.score)
    if (reply.type === 'progress') return this.deps.emit({ type: 'voice.status', status: { ...this.status, detail: reply.detail } })
    const waiter = this.waiters.get(reply.id)
    if (!waiter) return
    if (reply.type === 'tts-chunk') return waiter.onChunk?.(reply.samples)
    this.waiters.delete(reply.id)
    if (reply.type === 'error') waiter.reject(new Error(reply.error))
    else waiter.resolve(reply)
  }

  private workerFailed(error: Error): void {
    this.worker = null
    for (const waiter of this.waiters.values()) waiter.reject(error)
    this.waiters.clear()
    if (this.config.enabled) this.setStatus({ state: 'error', detail: error.message })
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    worker?.removeAllListeners()
    await worker?.terminate()
  }

  // ---------------------------------------------------------------------------
  // Audio in

  /** 80 ms of mono 16 kHz Int16 PCM from the window's microphone. */
  audio(pcm: ArrayBuffer): void {
    if (!this.config.enabled) return
    const chunk = int16ToFloat(new Int16Array(pcm))
    this.ring.push(chunk)
    if (this.ring.length > RING_CHUNKS) this.ring.shift()
    if (this.recording) {
      this.recording.chunks.push(chunk)
      const verdict = this.recording.endpointer.push(chunk)
      if (verdict !== 'continue') this.finishRecording(verdict === 'done')
    } else if (this.interrupted) {
      this.sinceInterrupt++
    } else if (this.status.state === 'speaking' && this.config.tts !== 'windows') {
      if (this.bargeIn.push(chunk)) this.interrupt()
    } else if (this.status.state === 'listening' && this.config.wakeWord !== 'off') {
      this.post({ type: 'audio', pcm }, [pcm])
    }
  }

  /** `preroll`: audio that already belongs to this turn (what the user said while interrupting). */
  private record(options: ConstructorParameters<typeof Endpointer>[0] = {}, preroll: Float32Array[] = []): Promise<Float32Array | null> {
    this.cancelRecording()
    return new Promise((resolve) => {
      const endpointer = new Endpointer(options)
      for (const chunk of preroll) endpointer.push(chunk)
      this.recording = { endpointer, chunks: [...preroll], finish: resolve }
    })
  }

  /** The user started talking over Alma: she goes quiet, drops the rest of the answer and listens. */
  private interrupt(): void {
    this.bargeIn.reset()
    this.interrupted = true
    this.sinceInterrupt = 0
    this.stopSpeaking()
    if (this.answering) this.deps.stop(this.answering)
  }

  private finishRecording(heard: boolean): void {
    const recording = this.recording
    this.recording = null
    recording?.finish(heard ? concat(recording.chunks) : null)
  }

  private cancelRecording(): void {
    this.finishRecording(false)
  }

  private async onWake(score: number): Promise<void> {
    if (score < this.config.wakeThreshold || this.status.state !== 'listening' || this.busy) return
    const phrase = concat(this.ring)
    if (this.config.verifySpeaker && this.profile) {
      this.busy = true
      try {
        const similarity = await this.similarity(phrase)
        if (similarity < this.config.speakerThreshold) {
          this.deps.emit({ type: 'voice.status', status: { ...this.status, detail: `Voz no reconocida (${similarity.toFixed(2)})` } })
          return
        }
      } catch (error) {
        console.error('[voice] speaker check failed:', error)
      } finally {
        this.busy = false
      }
    }
    void this.converse()
  }

  /** Hotkey or the mic button: talk without the wake word (you're at the computer, so no voice check). Stops speech. */
  trigger(): void {
    if (!this.config.enabled) return
    if (this.status.state === 'speaking') {
      this.hushed = true
      return this.stopSpeaking()
    }
    if (this.status.state === 'recording') return this.finishRecording(true)
    if (this.status.state === 'listening' && !this.busy) void this.converse()
  }

  /**
   * Cancel button / Escape: throws away the recording, the transcript waiting to be sent or the run in progress,
   * silences Alma and ends the conversation. Nothing is deleted: only what hasn't reached the model is dropped.
   */
  cancel(): void {
    if (!this.config.enabled) return
    this.hushed = true
    this.cancelRecording()
    this.endPause?.()
    this.stopSpeaking()
    if (this.answering) this.deps.stop(this.answering)
  }

  /** A pause during which the transcript can still be cancelled. */
  private pause(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        this.endPause = null
        resolve()
      }
      const timer = setTimeout(finish, ms)
      this.endPause = finish
    })
  }

  // ---------------------------------------------------------------------------
  // One request

  /**
   * A conversation: after each answer the microphone stays open for a follow-up (longer if Alma asked something), so
   * the wake word is only needed to start. It ends on silence, a goodbye, another voice, or the stop button.
   */
  private async converse(): Promise<void> {
    this.busy = true
    this.hushed = false
    const offApprovals = this.deps.onEvent((event) => {
      if (event.type === 'approval.request' && event.approval.threadId === this.config.threadId) void this.approveByVoice(event.approval)
    })
    try {
      let followUp = 0
      let said = ''
      while (this.config.enabled && !this.hushed) {
        const interrupted = this.interrupted
        const preroll = interrupted ? this.ring.slice(-Math.min(RING_CHUNKS, this.sinceInterrupt + PREROLL_CHUNKS)) : []
        this.interrupted = false
        const continuing = followUp > 0 || interrupted
        this.setStatus({ state: 'recording', followUp: continuing })
        const audio = await this.record(followUp && !interrupted ? { startTimeoutMs: followUp } : {}, preroll)
        if (!audio) return
        // No speaker check here: on short phrases WavLM scored the user's own voice 0.44–0.92 (it cut them off).
        this.setStatus({ state: 'transcribing' })
        const text = await this.transcribe(audio)
        if (!text || this.hushed || (continuing && isGoodbye(text))) return
        // The "interruption" was Alma hearing herself: drop it rather than answer her own words.
        if (interrupted && isEcho(text, said)) return
        // Last chance to cancel before the model sees it (a false activation, a wrong transcript).
        this.setStatus({ state: 'thinking', transcript: text })
        await this.pause(this.config.sendDelayMs)
        if (this.hushed) return
        said = await this.answer(text)
        // The model said the conversation is over: don't hold the microphone open waiting for a reply.
        if (this.deps.conversationEnded(this.threadId)) return
        followUp = followUpMs(said)
      }
    } catch (error) {
      console.error('[voice] request failed:', error)
      this.deps.emit({ type: 'voice.status', status: { ...this.status, detail: (error as Error).message } })
    } finally {
      offApprovals()
      this.busy = false
      this.interrupted = false
      if (this.config.enabled) this.setStatus({ state: 'listening' })
    }
  }

  /** Asks the agent and speaks the answer as it streams in; resolves with the answer once it has been said. */
  private async answer(text: string): Promise<string> {
    this.setStatus({ state: 'thinking', transcript: text })
    const thread = this.deps.conversation()
    this.threadId = thread.id

    // Talk while the model writes: a filler right away, then each finished sentence as it streams in.
    const speech = this.utterance()
    speech.add(pick(FILLERS.thinking), true)
    const stream = new SentenceStream()
    let answer = ''
    let searchingSaid = false
    const offStream = this.deps.onEvent((event) => {
      if (!('scope' in event) || event.scope.threadId !== thread.id || event.scope.subagentId) return
      if (event.type === 'stream.text') {
        answer += event.text
        // The overlay follows sentence by sentence (not token by token).
        for (const sentence of stream.push(event.text)) {
          speech.add(sentence)
          if (this.status.state === 'thinking') this.setStatus({ state: 'speaking', transcript: text, answer })
          else this.deps.emit({ type: 'voice.status', status: { ...this.status, answer } })
        }
      } else if (event.type === 'stream.tool') {
        for (const sentence of stream.flush()) speech.add(sentence)
        // The model went to look something up without saying so: fill the silence once.
        if (!answer.trim() && !searchingSaid) speech.add(pick(FILLERS.searching), true)
        searchingSaid = true
      }
    })
    this.bargeIn.reset()
    this.answering = thread.id
    try {
      await this.deps.ask(thread.id, text)
    } catch (error) {
      speech.add(`No pude hacerlo: ${(error as Error).message}`)
    } finally {
      offStream()
      this.answering = null
    }
    for (const sentence of stream.flush()) speech.add(sentence)
    // Providers that don't stream: say the final answer instead.
    if (!answer.trim()) speech.add(this.deps.lastAnswer(thread.id))
    const said = answer.trim() || this.deps.lastAnswer(thread.id)
    if (!this.interrupted && !this.hushed) this.setStatus({ state: 'speaking', transcript: text, answer: said })
    await speech.finish()
    return said
  }

  /** "¿Sí o no?": approvals for the voice conversation are answered out loud (they also show in the app). */
  private async approveByVoice(approval: PendingApproval): Promise<void> {
    const question = `Necesito tu permiso para ${approval.toolName.replace(/_/g, ' ')}${approval.flagged ? ', y podría ser riesgoso' : ''}. ¿Sí o no?`
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.say(attempt === 0 ? question : 'No te entendí. ¿Sí o no?')
      this.setStatus({ ...this.status, state: 'recording' })
      const audio = await this.record()
      const answer = audio ? parseYesNo(await this.transcribe(audio)) : null
      this.setStatus({ ...this.status, state: 'thinking' })
      if (answer) return this.deps.respondApproval(approval.approvalId, answer === 'yes' ? 'allow' : 'deny')
    }
    // Two unclear answers: leave it pending in the app rather than guessing.
  }

  // ---------------------------------------------------------------------------
  // Speech to text

  async transcribe(audio: Float32Array): Promise<string> {
    if (this.config.stt === 'meta') return this.transcribeWithMeta(toWav(audio))
    if (this.config.stt === 'openai') return this.transcribeWithOpenAI(new Blob([toWav(audio)], { type: 'audio/wav' }), 'audio.wav')
    const reply = await this.call({ type: 'transcribe', id: ++this.nextId, samples: audio })
    return reply.type === 'result' ? (reply.text ?? '') : ''
  }

  /** For Telegram voice notes: OpenAI takes the file as is; locally (and for Meta, which only takes WAV) the Opus audio is decoded first. */
  async transcribeFile(data: ArrayBuffer, mime: string): Promise<string> {
    if (this.config.stt === 'openai') return this.transcribeWithOpenAI(new Blob([data], { type: mime }), 'audio.ogg')
    const { OggOpusDecoder } = await import('ogg-opus-decoder')
    const decoder = new OggOpusDecoder()
    await decoder.ready
    try {
      const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(data))
      return this.transcribe(resample(channelData[0], sampleRate, 16000))
    } finally {
      decoder.free()
    }
  }

  /** Muse Voice Transcribe takes mono 16-bit WAV at 16 or 24 kHz (what toWav makes), up to 10 minutes. */
  private async transcribeWithMeta(wav: Uint8Array<ArrayBuffer>): Promise<string> {
    const key = this.deps.settings().providers.meta.apiKey || process.env.META_API_KEY
    if (!key) throw new Error('Para transcribir con Meta cargá una API key de Meta en Configuración → Proveedores.')
    const form = new FormData()
    form.append('request', new Blob([JSON.stringify({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', mode: 'PUSH_TO_TALK', languageBias: ['Spanish'] })], { type: 'application/json' }))
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
    const response = await fetch(`${META_BASE_URL}/asr/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, body: form })
    if (!response.ok) throw new Error(`Meta no pudo transcribir (${response.status}): ${(await response.text()).slice(0, 200)}`)
    return ((await response.json()) as { transcript: string }).transcript.trim()
  }

  private async transcribeWithOpenAI(file: Blob, name: string): Promise<string> {
    const key = this.deps.settings().providers.openai.apiKey || process.env.OPENAI_API_KEY
    if (!key) throw new Error('Para transcribir con OpenAI cargá una API key de OpenAI en Configuración → Proveedores.')
    const form = new FormData()
    form.append('file', file, name)
    form.append('model', 'gpt-4o-mini-transcribe')
    form.append('language', 'es')
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form })
    if (!response.ok) throw new Error(`OpenAI no pudo transcribir (${response.status}): ${(await response.text()).slice(0, 200)}`)
    return ((await response.json()) as { text: string }).text.trim()
  }

  // ---------------------------------------------------------------------------
  // Text to speech

  /** Speaks one piece of text and resolves when the window finished playing it. */
  async say(text: string): Promise<void> {
    const speech = this.utterance()
    speech.add(text)
    await speech.finish()
  }

  /**
   * One spoken turn. Pieces are synthesized in order while earlier ones already play (the window queues them), so
   * the first sentence sounds while the next is still being generated. Cancelling drops whatever hasn't played.
   */
  private utterance(): { add(text: string, isFiller?: boolean): void; finish(): Promise<void> } {
    let chain = Promise.resolve()
    const turn = { cancelled: false }
    this.turns.add(turn)
    return {
      add: (text, isFiller = false) => {
        const speech = speakable(text)
        if (!speech || turn.cancelled) return
        chain = chain.then(() => (turn.cancelled ? undefined : this.synthesize(speech, turn, isFiller)))
      },
      finish: () => {
        chain = chain.then(async () => {
          if (!turn.cancelled) {
            const played = new Promise<void>((resolve) => {
              this.playbacks.push(resolve)
              setTimeout(resolve, PLAYBACK_TIMEOUT_MS)
            })
            this.play({ kind: 'pcm', samples: new Float32Array(0), sampleRate: 24000 }, true)
            await played
          }
          this.turns.delete(turn)
        })
        return chain
      }
    }
  }

  /**
   * Synthesizes with the configured engine and sends it to the window. Fillers always use the same voice as the
   * answers: they're cached per engine and voice (ElevenLabs ones on disk, so they cost credits only once).
   */
  private async synthesize(text: string, turn: { cancelled: boolean }, isFiller: boolean): Promise<void> {
    const { tts, kokoroVoice, windowsVoice, elevenVoiceId, elevenModel } = this.config
    const key = `${tts}:${tts === 'kokoro' ? kokoroVoice : tts === 'elevenlabs' ? `${elevenVoiceId}:${elevenModel}` : windowsVoice}:${text}`
    const cached = this.fillerCache.get(key)
    if (cached) {
      for (const playback of cached) if (!turn.cancelled) this.play(playback, false)
      return
    }
    const pieces: VoicePlayback[] = []
    const emit = (playback: VoicePlayback): void => {
      pieces.push(playback)
      if (!turn.cancelled) this.play(playback, false)
    }
    try {
      if (tts === 'elevenlabs') emit({ kind: 'encoded', data: await this.elevenLabs(text, isFiller), mime: 'audio/mpeg' })
      else if (tts === 'kokoro') await this.call({ type: 'tts', id: ++this.nextId, text, voice: kokoroVoice }, (samples) => emit({ kind: 'pcm', samples, sampleRate: 24000 }))
      else emit({ kind: 'system', text, voice: windowsVoice })
      if (isFiller && tts !== 'windows') this.fillerCache.set(key, pieces)
    } catch (error) {
      console.error('[voice] tts failed:', error)
      // A filler in another voice sounds like someone else talking: skip it. An answer falls back to the system
      // voice rather than leaving Alma mute, and says why on screen.
      if (isFiller || turn.cancelled) return
      this.deps.emit({ type: 'voice.status', status: { ...this.status, detail: `La voz elegida falló (${(error as Error).message}); usé la de Windows.` } })
      this.play({ kind: 'system', text, voice: windowsVoice }, false)
    }
  }

  /** Generates the fillers in the chosen voice ahead of time, so the first "Mmm…" is as instant as the rest. */
  private prepareFillers(): void {
    const { tts, elevenVoiceId } = this.config
    if (tts === 'windows' || (tts === 'elevenlabs' && !elevenVoiceId)) return
    const turn = { cancelled: true } // into the cache, without playing
    // One at a time: ElevenLabs rate-limits parallel requests, and Kokoro runs them in order anyway.
    void [...FILLERS.thinking, ...FILLERS.searching].reduce<Promise<void>>((chain, filler) => chain.then(() => this.synthesize(speakable(filler), turn, true)), Promise.resolve())
  }

  private play(playback: VoicePlayback, last: boolean): void {
    this.deps.emit({ type: 'voice.play', playback, last })
  }

  /** The window finished playing a turn (they finish in order), or the user cut it off. */
  played(): void {
    this.playbacks.shift()?.()
  }

  private stopSpeaking(): void {
    for (const turn of this.turns) turn.cancelled = true
    this.deps.emit({ type: 'voice.stop' })
    for (const resolve of this.playbacks.splice(0)) resolve()
  }

  /** `keep`: store the audio on disk (fillers), so the same phrase in the same voice is never paid for twice. */
  private async elevenLabs(text: string, keep = false): Promise<ArrayBuffer> {
    const key = this.deps.settings().providers.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY
    const { elevenVoiceId, elevenModel } = this.config
    if (!key || !elevenVoiceId) throw new Error('Falta la API key o la voz de ElevenLabs.')
    const file = join(this.deps.dataDir, 'voice-cache', `${createHash('sha1').update(`${elevenVoiceId}|${elevenModel}|${text}`).digest('hex')}.mp3`)
    if (keep && existsSync(file)) {
      const bytes = await readFile(file)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoiceId)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: elevenModel })
    })
    if (!response.ok) throw new Error(`ElevenLabs respondió ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const audio = await response.arrayBuffer()
    if (keep) {
      await mkdir(join(this.deps.dataDir, 'voice-cache'), { recursive: true })
      await writeFile(file, Buffer.from(audio)).catch(() => {})
    }
    return audio
  }

  async elevenVoices(): Promise<{ id: string; name: string; preview: string; labels: string }[]> {
    const key = this.deps.settings().providers.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY
    if (!key) throw new Error('Cargá primero tu API key de ElevenLabs.')
    const response = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } })
    if (!response.ok) throw new Error(`ElevenLabs respondió ${response.status}${response.status === 401 ? ': la key no es válida' : ''}.`)
    const { voices } = (await response.json()) as { voices: { voice_id: string; name: string; preview_url: string; labels?: Record<string, string> }[] }
    return voices.map((v) => ({ id: v.voice_id, name: v.name, preview: v.preview_url, labels: Object.values(v.labels ?? {}).join(' · ') }))
  }

  // ---------------------------------------------------------------------------
  // The user's voice (speaker verification)

  private profileFile(): string {
    return join(this.deps.dataDir, 'voice-profile.json')
  }

  private loadProfile(): Float32Array | null {
    try {
      if (!existsSync(this.profileFile())) return null
      return Float32Array.from((JSON.parse(readFileSync(this.profileFile(), 'utf8')) as { vector: number[] }).vector)
    } catch {
      return null
    }
  }

  private async embed(audio: Float32Array): Promise<Float32Array> {
    const reply = await this.call({ type: 'embed', id: ++this.nextId, samples: audio })
    if (reply.type !== 'result' || !reply.vector) throw new Error('No se pudo analizar la voz.')
    return reply.vector
  }

  private async similarity(audio: Float32Array): Promise<number> {
    if (!this.profile) return 1
    return cosine(await this.embed(audio), this.profile)
  }

  /** Averages several readings into one voice print; more samples make the check steadier. */
  async enroll(samples: ArrayBuffer[]): Promise<{ consistency: number }> {
    if (samples.length === 0) throw new Error('No hay grabaciones.')
    const vectors: Float32Array[] = []
    for (const sample of samples) vectors.push(await this.embed(int16ToFloat(new Int16Array(sample))))
    const mean = new Float32Array(vectors[0].length)
    for (const v of vectors) {
      const norm = Math.hypot(...v) || 1
      v.forEach((x, i) => (mean[i] += x / norm / vectors.length))
    }
    const consistency = Math.min(...vectors.map((v) => cosine(v, mean)))
    this.profile = mean
    await writeFile(this.profileFile(), JSON.stringify({ vector: Array.from(mean), enrolledAt: Date.now(), samples: samples.length }), 'utf8')
    return { consistency }
  }

  profileInfo(): { enrolled: boolean; enrolledAt?: number } {
    if (!this.profile) return { enrolled: false }
    try {
      return { enrolled: true, enrolledAt: (JSON.parse(readFileSync(this.profileFile(), 'utf8')) as { enrolledAt: number }).enrolledAt }
    } catch {
      return { enrolled: true }
    }
  }

  async forgetProfile(): Promise<void> {
    this.profile = null
    await writeFile(this.profileFile(), '{}', 'utf8').catch(() => {})
  }

  async testSpeaker(sample: ArrayBuffer): Promise<number> {
    if (!this.profile) throw new Error('Todavía no entrenaste tu voz.')
    return this.similarity(int16ToFloat(new Int16Array(sample)))
  }
}

/** Linear-interpolation resampling (Telegram voice notes are 48 kHz; Whisper wants 16 kHz). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const out = new Float32Array(Math.floor((input.length * to) / from))
  const ratio = from / to
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const j = Math.floor(pos)
    out[i] = input[j] + ((input[j + 1] ?? input[j]) - input[j]) * (pos - j)
  }
  return out
}
