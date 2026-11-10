import type { MessageAttachment } from '../../shared/attach/compose'
import { classifyFile } from '../../shared/attach/classify'
import { canAttachTo, unacknowledgedReaders } from '../../shared/attach/display'
import { PHONE_ATTACH } from '../../shared/attach/phone'
import { threadReaders } from '../../shared/attach/readers'
import { decodedLength, maxBase64Length } from '../../shared/attach/request'
import { ATTACH_LIMITS, type RefusalReason } from '../../shared/attach/rules'
import { isSecretLikeName } from '../../shared/attach/secrets'
import type { Refusal } from '../../shared/remote/api'
import type { ProviderId, Settings, Thread } from '../../shared/types'
import type { AttachmentStore } from './store'

/**
 * Which wire refusal a spec 030 reason becomes (spec 031 AC-2.2). Exhaustive: a new reason without an answer is a type error.
 * Both size reasons read as `too-large` (the phone's limit is the smaller one); the store's `company` is `gone`, never named on the wire.
 */
const REFUSAL_BY_REASON: Record<RefusalReason, Refusal> = {
  type: 'file-type',
  content: 'file-content',
  empty: 'file-empty',
  'too-big': 'too-large',
  total: 'too-large',
  'too-many': 'too-many',
  unreadable: 'invalid',
  'malformed-image': 'file-malformed',
  storage: 'storage',
  company: 'gone',
  'bad-payload': 'invalid',
}

export const refusalOf = (reason: RefusalReason): Refusal => REFUSAL_BY_REASON[reason]

export interface PhoneFilesDeps {
  store: Pick<AttachmentStore, 'store' | 'remove' | 'lookup'>
  threads: { get(id: string): Thread | undefined }
  settings(): Settings
  env(): Readonly<Record<string, string | undefined>>
}

export type PhonePutResult = { ok: true; attachment: MessageAttachment } | { ok: false; reason: Refusal }

/**
 * What a paired phone's upload goes through before it reaches the 030 store (spec 031). The phone's own checks are a
 * convenience: every rule is applied here on the bytes received, with spec 030's functions and no second list.
 */
export class PhoneFiles {
  constructor(private readonly deps: PhoneFilesDeps) {}

  /** Order: size, secret name, classification, provider notice, then the store (metadata strip, write). Nothing is stored on a refusal. */
  put(input: { threadId: string; name: string; size: number; base64: string }): PhonePutResult {
    const { store, threads } = this.deps
    const settings = this.deps.settings()
    const thread = threads.get(input.threadId)
    // the flow answers a company, unknown or deleted conversation as gone; the rule is kept here too (spec 030 AC-1.11)
    if (!thread || !canAttachTo(thread, settings.agents)) return { ok: false, reason: 'gone' }
    // the bytes decide, never the claimed size
    const size = decodedLength(input.base64)
    if (size === null) return { ok: false, reason: 'invalid' }
    if (size > PHONE_ATTACH.maxFileBytes) return { ok: false, reason: 'too-large' }
    if (isSecretLikeName(input.name)) return { ok: false, reason: 'secret-name' }
    // classification looks only at the start of the file: decode that much, not the whole payload (the store decodes it once more to write)
    const head = Buffer.from(input.base64.slice(0, maxBase64Length(ATTACH_LIMITS.sniffBytes)), 'base64')
    const verdict = classifyFile(input.name, head, size)
    if (!verdict.ok) return { ok: false, reason: refusalOf(verdict.reason) }
    const readers = threadReaders(settings, thread, verdict.kind === 'image', this.deps.env())
    if (unacknowledgedReaders(readers, settings.attachments.noticeAcknowledged).length > 0) return { ok: false, reason: 'notice-needed' }
    const stored = store.store({ threadId: input.threadId, name: input.name, size, base64: input.base64 })
    return stored.ok ? { ok: true, attachment: stored.attachment } : { ok: false, reason: refusalOf(stored.reason) }
  }

  /**
   * The providers that would read these files in this conversation as it is now and have not been shown the notice: a send
   * checks it again because the conversation's agent or model may have changed since the put (BR-11). The phone never acknowledges.
   */
  readersOwed(threadId: string, ids: readonly string[]): ProviderId[] {
    const thread = this.deps.threads.get(threadId)
    if (!thread) return []
    const kinds = ids.flatMap((id) => {
      const found = this.deps.store.lookup(id)
      return found.state === 'unknown' ? [] : [found.record.kind]
    })
    if (kinds.length === 0) return []
    const settings = this.deps.settings()
    const readers = threadReaders(settings, thread, kinds.includes('image'), this.deps.env())
    return unacknowledgedReaders(readers, settings.attachments.noticeAcknowledged)
  }

  /** Deletes a pending upload's file and record (the 030 store ignores an id it does not hold). */
  remove(id: string): void {
    this.deps.store.remove(id)
  }
}
