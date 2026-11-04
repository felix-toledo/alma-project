// Voice models in a worker thread: wake word (openWakeWord), speech-to-text (Whisper), speaker embeddings (WavLM)
// and Spanish text-to-speech (Kokoro + espeak-ng). All ONNX on onnxruntime-node, the same engine as bge-m3.
import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  env,
  pipeline,
  StyleTextToSpeech2Model,
  Tensor,
  type AutomaticSpeechRecognitionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor
} from '@huggingface/transformers'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import * as ort from 'onnxruntime-node'
import { splitSentences } from './speech'

export type VoiceWorkerRequest =
  | { type: 'config'; wakeWord: string; sttModel: string; warmKokoro: boolean }
  | { type: 'listen'; on: boolean }
  | { type: 'audio'; pcm: ArrayBuffer }
  | { type: 'transcribe'; id: number; samples: Float32Array }
  | { type: 'embed'; id: number; samples: Float32Array }
  | { type: 'tts'; id: number; text: string; voice: string }

export type VoiceWorkerReply =
  | { type: 'wake'; score: number }
  | { type: 'progress'; detail: string }
  | { type: 'result'; id: number; text?: string; vector?: Float32Array }
  | { type: 'tts-chunk'; id: number; samples: Float32Array }
  | { type: 'done'; id: number }
  | { type: 'error'; id: number; error: string }

const port = parentPort!
const { modelsDir } = workerData as { modelsDir: string }
env.cacheDir = modelsDir
env.allowLocalModels = false

const OWW_RELEASE = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1'
const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const BUNDLED_WAKEWORDS = join(__dirname, '../../resources/wakewords')

const send = (reply: VoiceWorkerReply, transfer: ArrayBuffer[] = []): void => port.postMessage(reply, transfer)
const progress = (detail: string): void => send({ type: 'progress', detail })

/** Downloads a file once into the models folder (atomic, so an interrupted download isn't reused). */
async function cached(url: string, ...path: string[]): Promise<string> {
  const target = join(modelsDir, ...path)
  if (existsSync(target)) return target
  mkdirSync(join(target, '..'), { recursive: true })
  progress(`Descargando ${path[path.length - 1]}…`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`No se pudo descargar ${url} (${response.status})`)
  await writeFile(`${target}.part`, Buffer.from(await response.arrayBuffer()))
  await rename(`${target}.part`, target)
  return target
}

const hfProgress = (label: string) => (info: { status: string; file?: string; progress?: number }) => {
  if (info.status === 'progress' && info.file?.endsWith('.onnx') && info.progress !== undefined) progress(`Descargando ${label}… ${Math.floor(info.progress)}%`)
}

// ---------------------------------------------------------------------------
// Wake word: openWakeWord's streaming pipeline (melspectrogram → embedding → keyword) on 80 ms chunks.

const CHUNK = 1280

class WakeWord {
  private samples = new Float32Array(0)
  private mel: number[][] = []
  private embeddings: number[][] = []

  private constructor(
    private melModel: ort.InferenceSession,
    private embModel: ort.InferenceSession,
    private wordModel: ort.InferenceSession
  ) {}

  static async load(word: string): Promise<WakeWord> {
    const options = { executionProviders: ['cpu'], intraOpNumThreads: 1 }
    const [mel, emb, kw] = await Promise.all([
      cached(`${OWW_RELEASE}/melspectrogram.onnx`, 'openwakeword', 'melspectrogram.onnx'),
      cached(`${OWW_RELEASE}/embedding_model.onnx`, 'openwakeword', 'embedding_model.onnx'),
      // The keyword model is our own («Hola Alma», trained in Colab) and ships in the repo.
      join(BUNDLED_WAKEWORDS, `${word}_v0.1.onnx`)
    ])
    return new WakeWord(
      await ort.InferenceSession.create(mel, options),
      await ort.InferenceSession.create(emb, options),
      await ort.InferenceSession.create(kw, options)
    )
  }

  reset(): void {
    this.samples = new Float32Array(0)
    this.mel = []
    this.embeddings = []
  }

  /** Feeds one 80 ms chunk of Int16 samples (as floats); returns the keyword score once enough context exists. */
  async push(chunk: Float32Array): Promise<number> {
    const joined = new Float32Array(this.samples.length + chunk.length)
    joined.set(this.samples)
    joined.set(chunk, this.samples.length)
    this.samples = joined.slice(-(CHUNK + 480))
    const input = this.samples
    const melOut = (await this.melModel.run({ [this.melModel.inputNames[0]]: new ort.Tensor('float32', input, [1, input.length]) }))[this.melModel.outputNames[0]]
    const frames = melOut.dims[2]
    const data = melOut.data as Float32Array
    for (let f = Math.max(0, frames - 8); f < frames; f++) this.mel.push(Array.from(data.subarray(f * 32, f * 32 + 32), (x) => x / 10 + 2))
    if (this.mel.length > 120) this.mel.splice(0, this.mel.length - 120)
    if (this.mel.length < 76) return 0
    const window = Float32Array.from(this.mel.slice(-76).flat())
    const embOut = await this.embModel.run({ [this.embModel.inputNames[0]]: new ort.Tensor('float32', window, [1, 76, 32, 1]) })
    this.embeddings.push(Array.from(embOut[this.embModel.outputNames[0]].data as Float32Array))
    if (this.embeddings.length > 16) this.embeddings.shift()
    if (this.embeddings.length < 16) return 0
    const out = await this.wordModel.run({ [this.wordModel.inputNames[0]]: new ort.Tensor('float32', Float32Array.from(this.embeddings.flat()), [1, 16, 96]) })
    return (out[this.wordModel.outputNames[0]].data as Float32Array)[0]
  }
}

let wake: { word: string; detector: Promise<WakeWord> } | null = null
let listening = false
let busy = false
let pending: Float32Array | null = null

async function feedWake(chunk: Float32Array): Promise<void> {
  if (!wake) return
  // Never queue up: if the previous chunk is still running, keep only the newest.
  if (busy) {
    pending = chunk
    return
  }
  busy = true
  try {
    const detector = await wake.detector
    let next: Float32Array | null = chunk
    while (next && listening) {
      const score = await detector.push(next)
      if (score > 0.2) send({ type: 'wake', score })
      next = pending
      pending = null
    }
  } catch (error) {
    progress(`Palabra de activación no disponible: ${(error as Error).message}`)
  } finally {
    busy = false
  }
}

// ---------------------------------------------------------------------------
// Speech to text, speaker embeddings and Kokoro, each loaded on first use.

let asr: { model: string; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null

function speechToText(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr?.model !== model) {
    const repo = `onnx-community/${model}`
    asr = {
      model,
      pipe: pipeline('automatic-speech-recognition', repo, {
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        device: 'cpu',
        progress_callback: hfProgress('Whisper')
      }) as Promise<AutomaticSpeechRecognitionPipeline>
    }
  }
  return asr.pipe
}

let speaker: Promise<{ processor: Processor; model: PreTrainedModel }> | null = null

function speakerModel(): Promise<{ processor: Processor; model: PreTrainedModel }> {
  speaker ??= Promise.all([
    AutoProcessor.from_pretrained('Xenova/wavlm-base-plus-sv'),
    AutoModel.from_pretrained('Xenova/wavlm-base-plus-sv', { dtype: 'q8', device: 'cpu', progress_callback: hfProgress('el modelo de tu voz') })
  ]).then(([processor, model]) => ({ processor, model }))
  return speaker
}

let kokoro: Promise<{ model: PreTrainedModel; tokenizer: PreTrainedTokenizer }> | null = null
const voices = new Map<string, Float32Array>()

function kokoroModel(): Promise<{ model: PreTrainedModel; tokenizer: PreTrainedTokenizer }> {
  kokoro ??= Promise.all([
    StyleTextToSpeech2Model.from_pretrained(KOKORO_REPO, { dtype: 'q8', device: 'cpu', progress_callback: hfProgress('Kokoro') }),
    AutoTokenizer.from_pretrained(KOKORO_REPO)
  ]).then(([model, tokenizer]) => ({ model, tokenizer }))
  return kokoro
}

async function voiceStyle(voice: string): Promise<Float32Array> {
  if (!voices.has(voice)) {
    const file = await cached(`https://huggingface.co/${KOKORO_REPO}/resolve/main/voices/${voice}.bin`, 'kokoro', `${voice}.bin`)
    const bytes = await readFile(file)
    voices.set(voice, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
  }
  return voices.get(voice)!
}

/** Spanish IPA from espeak-ng (WASM). It reads its input as Latin-1, which covers every Spanish letter. */
async function phonemizeSpanish(sentences: string[]): Promise<string[]> {
  const { default: ESpeakNg } = await import('espeak-ng')
  const text = sentences.map((s) => s.replace(/[^\x20-\xff]/g, ' ')).join('\n')
  const espeak = await ESpeakNg({
    arguments: ['--phonout', 'out', '--sep=""', '-q', '-b=1', '--ipa=3', '-v', 'es-419', '-f', 'in.txt'],
    preRun: [(m) => m.FS.writeFile('in.txt', Uint8Array.from(Buffer.from(text, 'latin1')))]
  })
  return espeak.FS.readFile('out', { encoding: 'utf8' }).split(/\n/)
}

async function synthesize(id: number, text: string, voice: string): Promise<void> {
  const [{ model, tokenizer }, style] = await Promise.all([kokoroModel(), voiceStyle(voice)])
  // espeak spells "Mmm" out ("eme eme"): a leading hum goes in as IPA, the rest through espeak.
  const hum = /^\s*m{2,}[\s.…,!]*/i.exec(text)
  const rest = hum ? text.slice(hum[0].length) : text
  const phonemes = [...(hum ? ['mːː'] : []), ...(rest.trim() ? await phonemizeSpanish(splitSentences(rest)) : [])]
  for (const line of phonemes) {
    if (!line.trim()) continue
    const { input_ids } = tokenizer(line, { truncation: true })
    const offset = 256 * Math.min(Math.max(input_ids.dims.at(-1)! - 2, 0), 509)
    const { waveform } = (await model({
      input_ids,
      style: new Tensor('float32', style.slice(offset, offset + 256), [1, 256]),
      speed: new Tensor('float32', [1], [1])
    })) as { waveform: Tensor }
    const samples = Float32Array.from(waveform.data as Float32Array)
    send({ type: 'tts-chunk', id, samples }, [samples.buffer])
  }
}

port.on('message', async (message: VoiceWorkerRequest) => {
  switch (message.type) {
    case 'config':
      if (message.wakeWord !== wake?.word) {
        wake = message.wakeWord === 'off' ? null : { word: message.wakeWord, detector: WakeWord.load(message.wakeWord) }
        wake?.detector.catch((error: Error) => progress(`Palabra de activación no disponible: ${error.message}`))
      }
      // Warm up the speech model so the first request doesn't wait for a download.
      void speechToText(message.sttModel).catch(() => {})
      if (message.warmKokoro) void kokoroModel().catch(() => {})
      return
    case 'listen':
      listening = message.on
      if (listening) (await wake?.detector.catch(() => null))?.reset()
      return
    case 'audio':
      if (listening) void feedWake(Float32Array.from(new Int16Array(message.pcm), (x) => x))
      return
    case 'transcribe':
    case 'embed':
    case 'tts':
      try {
        if (message.type === 'transcribe') {
          const pipe = await speechToText(asr?.model ?? 'whisper-base')
          const result = (await pipe(message.samples, { language: 'spanish', task: 'transcribe' })) as { text: string }
          send({ type: 'result', id: message.id, text: result.text.trim() })
        } else if (message.type === 'embed') {
          const { processor, model } = await speakerModel()
          const { embeddings } = (await model(await processor(message.samples))) as { embeddings: Tensor }
          const vector = Float32Array.from(embeddings.data as Float32Array)
          send({ type: 'result', id: message.id, vector }, [vector.buffer])
        } else {
          await synthesize(message.id, message.text, message.voice)
          send({ type: 'done', id: message.id })
        }
      } catch (error) {
        send({ type: 'error', id: message.id, error: (error as Error).message })
      }
      return
  }
})
