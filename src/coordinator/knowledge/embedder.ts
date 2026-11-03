import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { EmbedderState } from '../../shared/types'
import type { WorkerReply } from './embed-worker'

export const EMBEDDING_MODEL = 'Xenova/bge-m3'

export interface Embedder {
  readonly modelId: string
  state(): { state: EmbedderState; progress?: number; error?: string }
  embed(texts: string[]): Promise<Float32Array[]>
}

/** bge-m3 (int8, CPU) in a worker thread. The model downloads (~570 MB) the first time something is embedded. */
export class WorkerEmbedder implements Embedder {
  readonly modelId = `${EMBEDDING_MODEL}:q8`
  private worker: Worker | null = null
  private nextId = 0
  private waiters = new Map<number, { resolve(v: Float32Array[]): void; reject(e: Error): void }>()
  private current: ReturnType<Embedder['state']> = { state: 'idle' }

  constructor(
    private cacheDir: string,
    private onState: (state: ReturnType<Embedder['state']>) => void
  ) {}

  state(): ReturnType<Embedder['state']> {
    return this.current
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return Promise.resolve([])
    const worker = this.ensureWorker()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject })
      worker.postMessage({ id, texts })
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    // Bundled next to coordinator.js (see electron.vite.config.ts).
    const worker = new Worker(join(__dirname, 'embedWorker.js'), {
      workerData: { cacheDir: this.cacheDir, model: EMBEDDING_MODEL }
    })
    worker.on('message', (reply: WorkerReply) => {
      if (reply.type === 'state') {
        this.current = { state: reply.state, progress: reply.progress, error: reply.error }
        this.onState(this.current)
        return
      }
      const waiter = this.waiters.get(reply.id)
      this.waiters.delete(reply.id)
      if (reply.type === 'result') waiter?.resolve(reply.vectors)
      else waiter?.reject(new Error(reply.error))
    })
    worker.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', (code) => this.fail(new Error(`El proceso de embeddings terminó (código ${code}).`)))
    this.worker = worker
    return worker
  }

  private fail(error: Error): void {
    this.worker = null
    for (const waiter of this.waiters.values()) waiter.reject(error)
    this.waiters.clear()
    this.current = { state: 'error', error: error.message }
    this.onState(this.current)
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    worker?.removeAllListeners()
    await worker?.terminate()
  }
}
