// The phone's side of a file put (spec 031). Bytes live in memory only until uploaded: nothing is stored, queued or retried here.
import { chipsReduce, type Chip } from '../../shared/attach/phone-chips'
import type { PhoneAttachmentView } from '../../shared/attach/phone'
import { ALLOWED_EXTENSIONS, type AttachmentKind } from '../../shared/attach/rules'
import { isRecord, postJson, type Failed } from './request'
import type { FetchLike } from './session'

export interface PutAttachment {
  id: string
  name: string
  kind: AttachmentKind
  size: number
}
export type PutOutcome = { ok: true; attachment: PutAttachment } | Failed

const KINDS: ReadonlySet<string> = new Set(Object.values(ALLOWED_EXTENSIONS))
const network: Failed = { ok: false, reason: 'network' }
const CHUNK = 0x8000

/** Standard alphabet with padding, built in chunks so a 700 000-byte file never spreads into one huge argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  return btoa(binary)
}

/**
 * Puts one file into the Chat tab's thread, or into a conversation when `target.id` is given (AC-8.3). The PC decides
 * everything; a refusal comes back by its error name, a dropped connection or an abort as `network`, and nothing is retried.
 */
export async function putFile(deps: {
  fetch: FetchLike
  token: string
  target: { id?: string }
  file: { name: string; size: number; base64: string }
  signal?: AbortSignal
}): Promise<PutOutcome> {
  const { target, file, ...rest } = deps
  const reply = await postJson({
    ...rest,
    path: target.id === undefined ? '/api/chat/attach' : '/api/threads/attach',
    body: target.id === undefined ? file : { id: target.id, ...file }
  })
  if (!reply.ok) return reply
  const { attachment } = reply.body
  if (!isRecord(attachment) || typeof attachment.id !== 'string' || typeof attachment.name !== 'string' || typeof attachment.size !== 'number') return network
  if (typeof attachment.kind !== 'string' || !KINDS.has(attachment.kind)) return network
  return { ok: true, attachment: { id: attachment.id, name: attachment.name, kind: attachment.kind as AttachmentKind, size: attachment.size } }
}

/**
 * The attachment list of one message as the phone renders it (031 AC-5.1): name, kind and size of each well-formed entry and
 * nothing else, so an id or a path the PC should never send cannot reach the render model. Not a list, or no valid entry, is none.
 */
export function readAttachmentViews(value: unknown): PhoneAttachmentView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const views = value.flatMap((entry): PhoneAttachmentView[] =>
    isRecord(entry) && typeof entry.name === 'string' && typeof entry.kind === 'string' && KINDS.has(entry.kind) && typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0
      ? [{ name: entry.name, kind: entry.kind as AttachmentKind, size: entry.size }]
      : []
  )
  return views.length > 0 ? views : undefined
}

/** Asks the PC to delete one of this phone's pending uploads; the answer is the same whatever the id was (AC-3.2). */
export async function removeUpload(deps: { fetch: FetchLike; token: string; id: string }): Promise<{ ok: true } | Failed> {
  const reply = await postJson({ fetch: deps.fetch, token: deps.token, path: '/api/attachments/remove', body: { id: deps.id } })
  return reply.ok ? { ok: true } : reply
}

/**
 * What the chips become once a send is answered (031 AC-4.3, AC-8.7). Accepted: they were sent, so none remain. Refused as
 * `unavailable`: the PC no longer holds those files, so every ready chip is expired, one event per id. Any other failure keeps
 * the chips as they are (the files stay pending on the PC and the person sends again).
 */
export function chipsAfterSend(chips: readonly Chip[], outcome: { ok: true } | { ok: false; reason: string }): Chip[] {
  if (outcome.ok) return []
  if (outcome.reason !== 'unavailable') return [...chips]
  return chips.filter((chip) => chip.state === 'ready' && chip.id).reduce((held, chip) => chipsReduce(held, { type: 'expired', id: chip.id as string }).chips, [...chips])
}
