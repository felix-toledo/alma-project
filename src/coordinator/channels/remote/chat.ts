import { REMOTE_LIMITS, type Refusal } from '../../../shared/remote/api'
import type { ApprovalView, Thread } from '../../../shared/types'
import type { RunTies } from './runs'
import { threadPage, type ThreadViewMessage } from './thread-view'
import type { UploadsFlow } from './uploads'

/**
 * What the chat flow needs from the coordinator (wired for real in T35):
 * the single shared remote thread, the configured agent run, and its cancel.
 * `ask` commits the user message synchronously first (spec 004 AC-8.9) and its
 * promise settles only after the answer is committed or the run has failed.
 */
export interface ChatDeps {
  conversation(fresh?: boolean): Thread
  ask(threadId: string, text: string, attachments?: string[]): Promise<void>
  cancel(threadId: string): void
  /** The approvals this device may see (shared thread plus its own by-id run), fresh on every build. */
  approvals(deviceId: string): ApprovalView[]
  /** The device's run waits on an approval it may not answer (approve scope off, AC-3.9). */
  waiting(deviceId: string): boolean
  /** Which device started which run: the Chat tab and a by-id send share the one-run-per-device rule (AC-3.19). */
  ties: RunTies
  /** The device's pending uploads a send may bind (spec 031): claimed before the run, released once the message is committed. */
  uploads: Pick<UploadsFlow, 'claimForSend' | 'bound'>
}

/** How a send into the shared thread ends: a refusal name the wire knows, or `failed` for a run that could not start. */
export type ChatSendResult = { ok: true } | { error: Extract<Refusal, 'busy' | 'run-active' | 'unavailable' | 'notice-needed' | 'invalid'> | 'failed' }

export interface RemoteChatState {
  /** The shared thread this state belongs to: a replaced thread restarts the phone's merge. */
  threadId: string
  rev: number
  running: boolean
  messages: ThreadViewMessage[]
  approvals: ApprovalView[]
  waiting: boolean
}

interface Waiter {
  deviceId: string
  since: number
  baselineRunning: boolean
  baselineApprovals: string
  resolve(state: RemoteChatState): void
  timer: ReturnType<typeof setTimeout>
}

function approvalsKey(state: RemoteChatState): string {
  return `${state.waiting}|${state.approvals.map((approval) => `${approval.id}:${approval.reason ?? ''}`).join(',')}`
}

/**
 * Chat over the single shared remote thread (T20): send runs the configured agent,
 * new swaps the thread, stop cancels the run, and state long-polls the PD-12 shape.
 * Only committed messages are ever shown: answers appear when the run commits them,
 * so a dropped connection can only ever see commits (AC-8.4).
 */
export class ChatFlow {
  private running = false
  private closed = false
  private readonly waiters: Waiter[] = []

  constructor(private readonly deps: ChatDeps) {}

  /** The channel serves again: polls may hold for the long-poll budget. */
  open(): void {
    this.closed = false
  }

  send(deviceId: string, text: string, ids?: string[]): ChatSendResult {
    if (this.running) return { error: 'busy' }
    const thread = this.deps.conversation()
    if ('error' in this.deps.ties.start(deviceId, thread.id, true)) return { error: 'run-active' }
    const claim = this.deps.uploads.claimForSend(deviceId, thread.id, ids, text)
    if (!claim.ok) {
      this.deps.ties.end(deviceId, thread.id)
      return { error: claim.reason }
    }
    this.running = true
    let run: Promise<void>
    try {
      run = this.deps.ask(thread.id, text, claim.ids)
    } catch {
      this.running = false
      this.deps.ties.end(deviceId, thread.id)
      this.notify()
      return { error: 'failed' }
    }
    // The user message is committed by now (ask commits synchronously first): the uploads belong to it, not to the device.
    this.deps.uploads.bound(deviceId, claim.ids)
    this.notify()
    const settle = (): void => {
      this.deps.ties.end(deviceId, thread.id)
      this.settle()
    }
    run.then(settle, settle)
    return { ok: true }
  }

  /** A fresh remote thread; the old one is kept, it just stops being served (AC-5.16). */
  newThread(): void {
    this.deps.conversation(true)
    this.notify()
  }

  /** Cancels the current run; also when idle, to deny approvals left pending (AC-5.16). */
  stopThread(): void {
    this.deps.cancel(this.deps.conversation().id)
  }

  /**
   * The PD-12 shape. Without `since` it answers at once with up to the last 30;
   * with `since` equal to the current rev it holds the poll until something changes
   * (a message or the running flag) or the 25s long-poll budget runs out (AC-1.7).
   */
  state(since: number | undefined, deviceId: string, signal?: AbortSignal): Promise<RemoteChatState> {
    const cursor = since !== undefined && Number.isInteger(since) && since >= 0 ? since : undefined
    const current = this.build(cursor, deviceId)
    if (this.closed || signal?.aborted || cursor === undefined || current.rev !== cursor) return Promise.resolve(current)
    return new Promise<RemoteChatState>((resolve) => {
      const waiter: Waiter = {
        deviceId,
        since: cursor,
        baselineRunning: current.running,
        baselineApprovals: approvalsKey(current),
        resolve: (state) => {
          clearTimeout(waiter.timer)
          signal?.removeEventListener('abort', onAbort)
          this.drop(waiter)
          resolve(state)
        },
        timer: setTimeout(() => waiter.resolve(this.build(cursor, deviceId)), REMOTE_LIMITS.longPollMs)
      }
      const onAbort = (): void => waiter.resolve(this.build(cursor, deviceId))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  /** Releases every held poll (stop must never hang a phone: AC-1.7). */
  close(): void {
    this.closed = true
    this.release()
  }

  /** Answers every held poll now: access may have changed, and the channel re-checks it before the answer leaves. */
  release(): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.resolve(this.build(waiter.since, waiter.deviceId))
    }
  }

  private settle(): void {
    this.running = false
    this.notify()
  }

  /** Something outside chat changed (an approval arrived or resolved): wake whoever cares. */
  poke(): void {
    this.notify()
  }

  private notify(): void {
    for (const waiter of this.waiters.slice()) {
      const current = this.build(waiter.since, waiter.deviceId)
      if (current.rev !== waiter.since || current.running !== waiter.baselineRunning || approvalsKey(current) !== waiter.baselineApprovals) {
        waiter.resolve(current)
      }
    }
  }

  private drop(waiter: Waiter): void {
    const at = this.waiters.indexOf(waiter)
    if (at >= 0) this.waiters.splice(at, 1)
  }

  private build(since: number | undefined, deviceId: string): RemoteChatState {
    const thread = this.deps.conversation()
    const raw = thread.messages
    const approvals = this.deps.approvals(deviceId)
    const waiting = this.deps.waiting(deviceId)
    const running = this.running
    const { rev, messages } = threadPage(raw, since === undefined ? {} : { since }, (kept) => ({ threadId: thread.id, rev: raw.length, running, messages: kept, approvals, waiting }))
    return { threadId: thread.id, rev, running, messages, approvals, waiting }
  }
}
