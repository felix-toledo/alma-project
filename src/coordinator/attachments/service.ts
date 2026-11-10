import { readFileSync } from 'node:fs'
import { extensionOf } from '../../shared/attach/classify'
import { firstMessageTitle, type MessageAttachment } from '../../shared/attach/compose'
import { canAttachTo, canOpenWithSystemApp, hasThumbnail } from '../../shared/attach/display'
import { planAdditions } from '../../shared/attach/plan'
import { ATTACH_LIMITS } from '../../shared/attach/rules'
import type { AuditEvent } from '../../shared/audit'
import { threadReaders } from '../../shared/attach/readers'
import { translate } from '../../shared/i18n/messages'
import type { ChatMessage, CoordinatorRequest, Language, PreviewResult, Settings, StoreResult, Thread } from '../../shared/types'
import type { Host } from '../tools/types'
import type { AttachmentReader, AttachmentStore } from './store'

/**
 * Whether a run started with these options counts as the person opening the conversation (spec 030 AC-6.7): a routine,
 * a house rule and a company run are all unattended and do not; a message the person sends from any channel does.
 */
export function countsAsOpened(options: { unattended?: boolean }): boolean {
  return !options.unattended
}

/**
 * Runs the sweep now and every 12 hours, like retention (spec 030 AC-6.2). The timer is unref'd so it never keeps the
 * process alive, and a failing sweep is logged without any detail and does not stop the next one.
 */
export function scheduleSweep(
  run: () => void,
  setIntervalFn: (fn: () => void, ms: number) => { unref(): unknown } = setInterval,
): ReturnType<typeof setInterval> {
  const safe = () => {
    try {
      run()
    } catch {
      console.error('[attachments] the sweep failed')
    }
  }
  safe()
  const timer = setIntervalFn(safe, ATTACH_LIMITS.sweepEveryMs)
  timer.unref()
  return timer as ReturnType<typeof setInterval>
}

/**
 * The store's log as audit entries `attachment.store|refuse|remove|sweep|delete-failed` (spec 030 AC-5.7). The store only
 * ever passes ids, kinds, sizes, reasons and counts, so nothing a file is called or says can reach the trail.
 */
export const attachmentLog =
  (emit: (event: AuditEvent) => void) =>
  (event: string, data: Record<string, string | number>): void =>
    emit({
      action: `attachment.${event}`,
      actor: event === 'sweep' || event === 'delete-failed' ? 'system' : 'user',
      outcome: event === 'refuse' ? 'denied' : event === 'delete-failed' ? 'error' : 'ok',
      detail: data,
    })

type AttachmentRequest = Extract<CoordinatorRequest, { method: 'attachments.store' | 'attachments.remove' | 'attachments.preview' | 'attachments.open' | 'attachments.readers' | 'threads.open' }>

export interface AttachmentServiceDeps {
  store: Pick<AttachmentStore, 'store' | 'remove' | 'lookup'>
  threads: { get(id: string): Thread; markOpened(id: string, at: number): void }
  settings(): Settings
  host: Host
  now?: () => number
  readFile?: (path: string) => Uint8Array
}

const PICTURE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/** The six requests the page makes about attachments (spec 030); `index.ts` only delegates here, so tests fake the store, the threads and the host. */
export class AttachmentService {
  private readonly now: () => number
  private readonly readFile: (path: string) => Uint8Array

  constructor(private readonly deps: AttachmentServiceDeps) {
    this.now = deps.now ?? Date.now
    this.readFile = deps.readFile ?? readFileSync
  }

  async handle(request: AttachmentRequest): Promise<unknown> {
    const { store, threads } = this.deps
    switch (request.method) {
      case 'attachments.store': {
        const settings = this.deps.settings()
        const thread = threads.get(request.threadId)
        // the page hides the button in a company thread, but the rule is kept here too (AC-1.11)
        if (!canAttachTo(thread, settings.agents)) return { ok: false, reason: 'company' } satisfies StoreResult
        return store.store({ threadId: request.threadId, name: request.name, size: request.size, base64: request.base64 })
      }
      case 'attachments.remove':
        store.remove(request.id)
        return null
      case 'attachments.preview':
        return this.preview(request.id)
      case 'attachments.open':
        return this.open(request.id)
      case 'attachments.readers': {
        // the vision provider reads pictures only (AC-3.1); the same provider is one reader
        return threadReaders(this.deps.settings(), threads.get(request.threadId), request.images, process.env)
      }
      case 'threads.open':
        threads.markOpened(request.threadId, this.now())
        return null
    }
  }

  /** Bytes for a thumbnail, for raster pictures only; any other file is present without bytes (AC-7.4). */
  private preview(id: string): PreviewResult {
    const found = this.deps.store.lookup(id)
    if (found.state === 'unknown') return { state: 'unknown' }
    if (found.state === 'removed') return { state: 'removed' }
    if (!hasThumbnail(found.record)) return { state: 'present' }
    try {
      return { state: 'present', mediaType: PICTURE_TYPES[extensionOf(found.record.storedName)], base64: Buffer.from(this.readFile(found.path)).toString('base64') }
    } catch {
      // gone between the lookup and the read
      return { state: 'removed' }
    }
  }

  /** The renderer never has the path: the host is asked with the stored one, and main checks it again (AC-7.5). */
  private async open(id: string): Promise<{ ok: boolean; message: string }> {
    const language = this.deps.settings().language
    const found = this.deps.store.lookup(id)
    if (found.state === 'unknown') throw new Error(translate(language, 'error.attachment.unknown'))
    if (found.state === 'removed') throw new Error(translate(language, 'error.attachment.removed'))
    if (!canOpenWithSystemApp(found.record.storedName)) throw new Error(translate(language, 'error.attachment.noOpen'))
    return this.deps.host.request({ action: 'attachment.open', path: found.path })
  }
}

export interface UserMessageInput {
  text: string
  /** The ids the person attached (`chat.send`); anything that is not a stored file of this conversation is refused. */
  ids: unknown
  threadId: string
  reader: AttachmentReader
  language: Language
  untitled: string
  now: number
}

/**
 * The user message of a send and the title a new thread gets from it (spec 030 AC-1.3, AC-2.7). Every id must be a file
 * of this conversation that is still on disk: a refusal throws before anything is changed, so the files stay stored and
 * the person can fix the chips. An id of another conversation reads as unknown (the capability is the id, not the thread).
 */
export function composeUserMessage({ text, ids, threadId, reader, language, untitled, now }: UserMessageInput): { message: ChatMessage; title: string } {
  const attachments: MessageAttachment[] = []
  const wanted = new Set<unknown>(ids === undefined ? [] : Array.isArray(ids) ? ids : [ids])
  // the count first: a request with hundreds of ids costs no disk lookups
  if (wanted.size > ATTACH_LIMITS.maxFiles) throw new Error(translate(language, 'error.attachment.tooMany', { files: ATTACH_LIMITS.maxFiles }))
  for (const id of wanted) {
    const found = typeof id === 'string' ? reader.lookup(id) : { state: 'unknown' as const }
    if (found.state === 'removed' && found.record.threadId === threadId) throw new Error(translate(language, 'error.attachment.removed'))
    if (found.state !== 'present' || found.record.threadId !== threadId) throw new Error(translate(language, 'error.attachment.unknown'))
    attachments.push({ id: found.record.id, name: found.record.originalName, kind: found.record.kind, size: found.record.size })
  }
  // the page checked the per-message limits too, but a send is a trust boundary (BR-14): nothing is bound over them
  const { refused } = planAdditions([], attachments)
  if (refused.length) throw new Error(translate(language, refused[0].reason === 'total' ? 'error.attachment.total' : 'error.attachment.tooMany', { files: ATTACH_LIMITS.maxFiles, mib: ATTACH_LIMITS.maxTotalBytes / 1_048_576 }))
  const message: ChatMessage = { role: 'user', content: [{ type: 'text', text }], ts: now, ...(attachments.length ? { attachments } : {}) }
  return { message, title: firstMessageTitle(text, attachments, untitled) }
}
