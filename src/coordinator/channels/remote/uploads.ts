import type { MessageAttachment } from '../../../shared/attach/compose'
import { canHoldAnother, claimUploads, PHONE_ATTACH, pendingExpired, type PendingUpload } from '../../../shared/attach/phone'
import type { AttachmentKind } from '../../../shared/attach/rules'
import type { Refusal, RemoteResponse } from '../../../shared/remote/api'
import type { ProviderId, Thread } from '../../../shared/types'
import { okResponse, refusalResponse } from './transport'

/**
 * What the remote module needs from the attachment store (spec 031): it never touches a file system itself, so every rule
 * about what may be stored stays in the coordinator's `PhoneFiles` (spec 030's functions, one authority).
 */
export interface PhoneFilesPort {
  put(input: { threadId: string; name: string; size: number; base64: string }): { ok: true; attachment: MessageAttachment } | { ok: false; reason: Refusal }
  /** Deletes the file and its record; an id that is not stored is ignored. */
  remove(id: string): void
  /** Providers that would read these files in this conversation and have not been shown the notice (BR-11). */
  readersOwed(threadId: string, ids: readonly string[]): ProviderId[]
}

/** Timers behind the pending-upload expiry: faked in tests, unref'd in production so they never keep the process alive. */
export interface UploadTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface UploadsDeps {
  now(): number
  sharedId(): string
  /** The conversation rule of `ThreadsFlow`: a company's, an unknown and a deleted one are all `undefined`. */
  reachable(id: string): Thread | undefined
  /** Any run on the thread, whoever started it. */
  isRunning(threadId: string): boolean
  files: PhoneFilesPort
  timers: UploadTimers
  /** A file that could not be deleted when its upload stopped being pending; nothing about it (no id, no name) is passed on. */
  onLeftover?(): void
}

/** The answer of a handler that went wrong after the checks (500, no cause named). */
export const failedResponse = (): RemoteResponse => ({ status: 500, headers: { 'cache-control': 'no-store' }, body: { error: 'failed' } })

export type PutTarget = { shared: true } | { shared: false; id: string }

/** What a stored put tells the audit trail: numbers and a kind, never a name (spec 031 AC-7.1). */
export interface StoredUpload {
  kind: AttachmentKind
  size: number
}

export class UploadsFlow {
  /** Memory only (BR-7): after a restart nothing is pending and the files wait for spec 030's 30-day sweep. */
  private pending: PendingUpload[] = []
  /** The expiry timer of each pending upload, by id. */
  private readonly expiry = new Map<string, unknown>()

  constructor(private readonly deps: UploadsDeps) {}

  /**
   * One file into the Chat tab's thread or a conversation by id. Order: target, busy, cap, then the store's own rules.
   * A company's, an unknown and a deleted conversation all answer `gone`.
   */
  put(deviceId: string, target: PutTarget, body: { name: string; size: number; base64: string }): { response: RemoteResponse; stored?: StoredUpload } {
    this.sweep()
    const threadId = target.shared ? this.deps.sharedId() : this.deps.reachable(target.id)?.id
    if (threadId === undefined) return { response: refusalResponse('gone') }
    if (this.deps.isRunning(threadId)) return { response: refusalResponse('busy') }
    if (!canHoldAnother(this.pending.filter((upload) => upload.deviceId === deviceId).length)) return { response: refusalResponse('too-many') }
    const result = this.deps.files.put({ threadId, ...body })
    if (!result.ok) return { response: refusalResponse(result.reason) }
    const { id, name, kind, size } = result.attachment
    const upload: PendingUpload = { id, deviceId, threadId, putAt: this.deps.now() }
    this.pending.push(upload)
    this.expiry.set(id, this.deps.timers.set(() => this.discard(upload), PHONE_ATTACH.pendingTtlMs))
    return { response: okResponse({ ok: true, attachment: { id, name, kind, size } }), stored: { kind, size } }
  }

  /**
   * The chip's X. Only this device's own pending upload is deleted; anything else (another device's, a sent attachment,
   * an unknown or malformed id) deletes nothing and answers the same, so the answer reveals nothing (AC-3.2).
   */
  remove(deviceId: string, id: string): RemoteResponse {
    const own = this.pending.find((upload) => upload.id === id && upload.deviceId === deviceId)
    if (own) {
      try {
        this.deps.files.remove(own.id)
      } catch {
        // the file is still there: it stays pending, so the expiry tries again, and the person is not told it is gone
        return failedResponse()
      }
      this.untrack(own)
    }
    return okResponse({ ok: true })
  }

  /**
   * The ids a send may bind, or one answer for every cause of a refusal (AC-4.2). No ids is a send as today. A provider that
   * has not been shown the notice yet is checked here, after the ids: the conversation's agent may have changed since the put (BR-11).
   */
  claim(deviceId: string, threadId: string, ids: readonly string[] | undefined): { ok: true; ids: string[] } | { ok: false; reason?: 'notice-needed' } {
    if (!ids || ids.length === 0) return { ok: true, ids: [] }
    this.sweep()
    const claimed = claimUploads(this.pending, { deviceId, threadId, ids }, this.deps.now())
    if (claimed.ok && this.deps.files.readersOwed(threadId, claimed.ids).length > 0) return { ok: false, reason: 'notice-needed' }
    return claimed
  }

  /**
   * The claim and the blank-text rule both sends share: a bad id refuses the whole send with one answer and leaves the other
   * uploads pending (AC-4.2); a blank text goes only with at least one bound upload (AC-4.4), whatever the boundary let through.
   * `ids` is absent for a send without files, so the run entry is called the same way either way.
   */
  claimForSend(
    deviceId: string,
    threadId: string,
    ids: readonly string[] | undefined,
    text: string
  ): { ok: true; ids: string[] | undefined } | { ok: false; reason: 'unavailable' | 'notice-needed' | 'invalid' } {
    const claim = this.claim(deviceId, threadId, ids)
    if (!claim.ok) return { ok: false, reason: claim.reason ?? 'unavailable' }
    if (claim.ids.length === 0) return text.trim().length === 0 ? { ok: false, reason: 'invalid' } : { ok: true, ids: undefined }
    return { ok: true, ids: claim.ids }
  }

  /** The send was accepted: these stop being pending and belong to the conversation (spec 030 rules from here). Nothing is deleted. */
  bound(deviceId: string, ids: readonly string[] = []): void {
    for (const upload of this.pending.filter((known) => known.deviceId === deviceId && ids.includes(known.id))) this.untrack(upload)
  }

  /** Deletes the pending uploads of a device that is gone (revoked, forgotten, idle), whatever it had not sent. */
  dropDevice(deviceId: string): void {
    for (const upload of this.pending.filter((known) => known.deviceId === deviceId)) this.discard(upload)
  }

  /** Deletes the pending uploads bound for a conversation (the shared thread that "New conversation" replaces). */
  dropThread(threadId: string): void {
    for (const upload of this.pending.filter((known) => known.threadId === threadId)) this.discard(upload)
  }

  /** Deletes every pending upload (remote access off, the kill switch, Send files or Chat turned off). */
  dropAll(): void {
    for (const upload of [...this.pending]) this.discard(upload)
  }

  /** Stops tracking an upload (its timer too) without touching its file. */
  private untrack(upload: PendingUpload): void {
    this.pending = this.pending.filter((known) => known !== upload)
    this.deps.timers.clear(this.expiry.get(upload.id))
    this.expiry.delete(upload.id)
  }

  /** Deletes an upload nobody sent (expiry or a purge). A file that cannot be deleted is left to spec 030's 30-day sweep: it is not pending any more. */
  private discard(upload: PendingUpload): void {
    if (!this.pending.includes(upload)) return
    this.untrack(upload)
    try {
      this.deps.files.remove(upload.id)
    } catch {
      this.deps.onLeftover?.()
    }
  }

  /** Expiry is also checked when pending state is read, so a missed timer never lets an expired upload be sent or counted. */
  private sweep(): void {
    const now = this.deps.now()
    for (const upload of this.pending.filter((known) => pendingExpired(known, now))) this.discard(upload)
  }
}
