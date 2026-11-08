import { REMOTE_LIMITS, type RemoteResponse } from '../../../shared/remote/api'
import type { ThreadPage, ThreadRow, ThreadWindow } from '../../../shared/remote/wire'
import { isCompanyThread } from '../../../shared/threads'
import type { Settings, Thread, ThreadSummary } from '../../../shared/types'
import type { RunTies } from './runs'
import { threadPage } from './thread-view'
import { okResponse as ok, refusalResponse } from './transport'

/** The thread store as the phone reads it; the lookup never throws (a missing id is `undefined`). */
export interface RemoteThreads {
  list(): ThreadSummary[]
  get(id: string): Thread | undefined
  /** A run is going on this thread, whoever started it. */
  isRunning(id: string): boolean
}

export interface ThreadsDeps {
  threads: RemoteThreads
  settings(): Settings
  /** The id of the shared remote thread the Chat tab writes into. */
  sharedId(): string
  ties: RunTies
  /** The device's run waits on an approval it may not answer here (approve scope off, AC-3.9). */
  waiting(deviceId: string, threadId: string): boolean
  /** The one run entry (the PC and the Chat tab use it too): resolves after the answer is committed or the run failed. */
  ask(threadId: string, text: string): Promise<void>
  /** The abort the PC's stop uses; it also resolves the run's pending approvals as denied. */
  cancel(threadId: string): void
  /** The Chat tab's own send, for a by-id send into the shared thread (one run, the same busy rule). */
  sendShared(deviceId: string, text: string): { ok: true } | { error: 'busy' | 'failed' | 'run-active' }
}

interface Waiter {
  baseline: string
  recompute(): RemoteResponse
  finish(): void
}

/** What a held read waits to see change: the cursor, the running flag, the waiting flag, or the thread vanishing. */
function signature(response: RemoteResponse): string {
  if (response.status !== 200) return 'gone'
  const window = response.body as ThreadWindow
  return `${window.rev}|${window.running}|${window.waiting}`
}

/** The conversation list is 30 a page (spec 028 BR-31). */
const PAGE = 30
const failed = (): RemoteResponse => ({ status: 500, headers: { 'cache-control': 'no-store' }, body: { error: 'failed' } })

/**
 * Conversations the phone reads and continues (spec 028). Scope and sub-switch checks already ran in the pipeline.
 * An id the phone may not touch (missing or a company's) is always `gone`, so the answer says nothing about which.
 */
export class ThreadsFlow {
  private closed = false
  private readonly waiters = new Set<Waiter>()

  constructor(private readonly deps: ThreadsDeps) {}

  /** The channel serves again: reads may hold for the long-poll budget. */
  open(): void {
    this.closed = false
  }

  /** Releases every held read (stopping the channel must never hang a phone). */
  close(): void {
    this.closed = true
    this.release()
  }

  /** Answers every held read now: access may have changed, and the channel re-checks it before the answer leaves. */
  release(): void {
    for (const waiter of [...this.waiters]) waiter.finish()
  }

  /** Something that can change what a held read shows happened (a message, a run start or end, an approval). */
  poke(): void {
    for (const waiter of [...this.waiters]) if (signature(waiter.recompute()) !== waiter.baseline) waiter.finish()
  }

  /** The thread behind an id, or undefined for a missing one and for a company's. */
  private reachable(id: string): Thread | undefined {
    const thread = this.deps.threads.get(id)
    return thread && !isCompanyThread(thread.agentId, this.deps.settings().agents) ? thread : undefined
  }

  list(offset: number): RemoteResponse {
    const shared = this.deps.sharedId()
    const { agents } = this.deps.settings()
    const listed = this.deps.threads.list().filter((row) => !isCompanyThread(row.agentId, agents))
    const rows = listed.slice(offset, offset + PAGE).map(
      (row): ThreadRow => ({
        id: row.id,
        title: row.title,
        agentId: row.agentId,
        agentName: agents.find((agent) => agent.id === row.agentId)?.name ?? row.agentId,
        ...(row.channel !== undefined ? { channel: row.channel } : {}),
        updatedAt: row.updatedAt,
        current: row.id === shared
      })
    )
    const page: ThreadPage = { rows, more: offset + PAGE < listed.length }
    return ok(page)
  }

  /**
   * A window of the thread. With `since` equal to the current rev and `wait`, the read is held until the thread
   * changes or the 25 s long-poll budget runs out, so the conversation the phone writes into follows live.
   */
  read(deviceId: string, id: string, options: { before?: number; since?: number; wait?: boolean } = {}, signal?: AbortSignal): Promise<RemoteResponse> {
    const { wait, ...page } = options
    const current = this.view(deviceId, id, page)
    if (!wait || page.since === undefined || this.closed || signal?.aborted || current.status !== 200 || (current.body as ThreadWindow).rev !== page.since) return Promise.resolve(current)
    return new Promise((resolve) => {
      const waiter: Waiter = {
        baseline: signature(current),
        recompute: () => this.view(deviceId, id, page),
        finish: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', waiter.finish)
          this.waiters.delete(waiter)
          resolve(waiter.recompute())
        }
      }
      const timer = setTimeout(waiter.finish, REMOTE_LIMITS.longPollMs)
      this.waiters.add(waiter)
      // The phone left (page hidden, connection lost): the waiter must not outlive it.
      signal?.addEventListener('abort', waiter.finish, { once: true })
    })
  }

  private view(deviceId: string, id: string, options: { before?: number; since?: number }): RemoteResponse {
    const thread = this.reachable(id)
    if (!thread) return refusalResponse('gone')
    const running = this.deps.threads.isRunning(id)
    const waiting = this.deps.waiting(deviceId, id)
    const { rev, messages, earlier } = threadPage(thread.messages, options, (kept) => ({ rev: thread.messages.length, running, ownRun: true, waiting, earlier: true, messages: kept }))
    const window: ThreadWindow = { rev, running, ownRun: running && this.deps.ties.ownerOf(id) === deviceId, waiting, messages, earlier }
    return ok(window)
  }

  /**
   * Continues a conversation by its id. The shared thread goes through the Chat tab's own send; any other thread
   * runs through the same `ask` the PC uses, and its run is tied to this device until it settles.
   */
  send(deviceId: string, id: string, text: string): RemoteResponse {
    if (!this.reachable(id)) return refusalResponse('gone')
    const { ties, threads } = this.deps
    if (ties.activeFor(deviceId)) return refusalResponse('run-active')
    if (threads.isRunning(id)) return refusalResponse('busy')
    if (id === this.deps.sharedId()) {
      const result = this.deps.sendShared(deviceId, text)
      if ('ok' in result) return ok({ ok: true })
      return result.error === 'failed' ? failed() : refusalResponse(result.error)
    }
    ties.start(deviceId, id)
    let run: Promise<void>
    try {
      run = this.deps.ask(id, text)
    } catch {
      ties.end(deviceId, id)
      return failed()
    }
    const end = (): void => {
      ties.end(deviceId, id)
      this.poke()
    }
    run.then(end, end)
    return ok({ ok: true })
  }

  /** Stops a run this device started; anything else is left alone and answers the same (nothing to stop reveals nothing). */
  stop(deviceId: string, id: string): RemoteResponse {
    if (!this.reachable(id)) return refusalResponse('gone')
    if (this.deps.ties.ownerOf(id) === deviceId) this.deps.cancel(id)
    return ok({ ok: true })
  }
}
