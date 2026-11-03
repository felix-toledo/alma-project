// Runs bge-m3 in a worker thread so tokenizing and inference never block the coordinator's event loop.
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { cpus } from 'node:os'
import { parentPort, workerData } from 'node:worker_threads'
import type { EmbedderState } from '../../shared/types'

export type WorkerRequest = { id: number; texts: string[] }
export type WorkerReply =
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id: number; error: string }
  | { type: 'state'; state: EmbedderState; progress?: number; error?: string }

const { cacheDir, model } = workerData as { cacheDir: string; model: string }
const port = parentPort!
env.cacheDir = cacheDir
env.allowLocalModels = false

let extractor: Promise<FeatureExtractionPipeline> | null = null

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= (async () => {
    let lastProgress = -1
    port.postMessage({ type: 'state', state: 'loading' } satisfies WorkerReply)
    const pipe = await pipeline('feature-extraction', model, {
      dtype: 'q8',
      device: 'cpu',
      // One thread per physical core measured fastest (12 logical threads ran ~60% slower on a Ryzen 5 5600G).
      session_options: { intraOpNumThreads: Math.max(1, Math.floor(cpus().length / 2)), interOpNumThreads: 1 },
      progress_callback: (info: { status: string; file?: string; progress?: number }) => {
        if (info.status !== 'progress' || !info.file?.endsWith('.onnx') || info.progress === undefined) return
        const progress = Math.floor(info.progress)
        if (progress === lastProgress) return
        lastProgress = progress
        port.postMessage({ type: 'state', state: 'downloading', progress } satisfies WorkerReply)
      }
    })
    port.postMessage({ type: 'state', state: 'ready' } satisfies WorkerReply)
    return pipe
  })().catch((error: Error) => {
    extractor = null
    port.postMessage({ type: 'state', state: 'error', error: error.message } satisfies WorkerReply)
    throw error
  })
  return extractor
}

port.on('message', async ({ id, texts }: WorkerRequest) => {
  try {
    const pipe = await load()
    // bge-m3 dense retrieval uses the normalized [CLS] vector.
    const output = await pipe(texts, { pooling: 'cls', normalize: true })
    const data = output.data as Float32Array
    const dims = output.dims[1]
    const vectors = texts.map((_, i) => data.slice(i * dims, (i + 1) * dims))
    port.postMessage({ type: 'result', id, vectors } satisfies WorkerReply, vectors.map((v) => v.buffer as ArrayBuffer))
  } catch (error) {
    port.postMessage({ type: 'error', id, error: (error as Error).message } satisfies WorkerReply)
  }
})
