// What the paired phone may attach (spec 031). Its own constants: the remote limits (spec 026 BR-31) do not change.
// Pure and browser-safe: it runs on the phone and in the PC's coordinator, and imports no `node:*` or `Buffer`.
import { extensionOf } from './classify'
import type { MessageAttachment } from './compose'
import { pictureName } from './names'
import { ALLOWED_EXTENSIONS, type AttachmentKind } from './rules'

/** BR-3, BR-4, BR-7: 700 000 bytes is the biggest file whose base64 (933 336 characters) fits the 1 MB request with margin. */
export const PHONE_ATTACH = {
  maxFileBytes: 700_000,
  maxFiles: 5,
  maxPending: 5,
  pendingTtlMs: 900_000,
} as const

export type PhonePlan = { action: 'send' } | { action: 'shrink' } | { action: 'refuse'; reason: 'too-big' | 'type' | 'too-many' }

/**
 * What the phone does with a picked file before sending it (spec 031 AC-8.1). The PC re-checks all of it. Type comes first,
 * then the chip count, then size: a refused type is never worth shrinking.
 */
export function planPhoneFile(file: { name: string; size: number }, chipsHeld: number): PhonePlan {
  const ext = extensionOf(file.name)
  if (!Object.hasOwn(ALLOWED_EXTENSIONS, ext)) return { action: 'refuse', reason: 'type' }
  if (chipsHeld >= PHONE_ATTACH.maxFiles) return { action: 'refuse', reason: 'too-many' }
  if (file.size <= PHONE_ATTACH.maxFileBytes) return { action: 'send' }
  // a GIF cannot be re-encoded as JPEG without losing its animation, so it is refused like any other file
  return ALLOWED_EXTENSIONS[ext] === 'image' && ext !== '.gif' ? { action: 'shrink' } : { action: 'refuse', reason: 'too-big' }
}

/** Plan data (BR-4 leaves the steps to the plan): longest side in pixels and JPEG quality, biggest picture first. */
export const SHRINK_STEPS: readonly { maxSide: number; quality: number }[] = [
  { maxSide: 2048, quality: 0.85 },
  { maxSide: 1600, quality: 0.7 },
  { maxSide: 1280, quality: 0.7 },
  { maxSide: 1024, quality: 0.7 },
  { maxSide: 800, quality: 0.7 },
]

/**
 * The first re-encoding within the limit, trying the biggest step first; null when none fits or the encoder fails
 * (a picture that cannot fit is refused, never sent larger). The encoder is the phone's canvas, injected.
 */
export async function shrinkToFit<T extends { size: number }>(
  encode: (step: { maxSide: number; quality: number }) => Promise<T>,
  limit: number = PHONE_ATTACH.maxFileBytes,
): Promise<T | null> {
  try {
    for (const step of SHRINK_STEPS) {
      const result = await encode(step)
      if (result.size <= limit) return result
    }
  } catch {
    return null
  }
  return null
}

/** A picture re-encoded on the phone is a JPEG whatever it was, named like a pasted one (030 AC-1.5). */
export const reencodedPictureName = (now: number): string => pictureName(now, 'jpg')

/** A file stored by a put and not yet sent (BR-7): memory only, one device, one conversation. */
export interface PendingUpload {
  id: string
  deviceId: string
  threadId: string
  putAt: number
}

/** The longest id a pending upload can have: the boundary schemas of the send and remove bodies use the same bound. */
export const PENDING_ID_MAX = 64

export function pendingExpired(upload: PendingUpload, now: number): boolean {
  return now - upload.putAt >= PHONE_ATTACH.pendingTtlMs
}

export function canHoldAnother(pendingOfDevice: number): boolean {
  return pendingOfDevice < PHONE_ATTACH.maxPending
}

/**
 * The ids a send may bind (AC-4.2): this device's, for this conversation, unexpired, distinct, 1 to 5. Every cause of a
 * refusal gives the same answer, so a probe learns nothing about other devices or conversations.
 */
export function claimUploads(
  held: readonly PendingUpload[],
  ask: { deviceId: string; threadId: string; ids: readonly unknown[] },
  now: number,
): { ok: true; ids: string[] } | { ok: false } {
  const { ids } = ask
  if (ids.length === 0 || ids.length > PHONE_ATTACH.maxPending || new Set(ids).size !== ids.length) return { ok: false }
  const claimed: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > PENDING_ID_MAX) return { ok: false }
    const upload = held.find((u) => u.id === id)
    if (!upload || upload.deviceId !== ask.deviceId || upload.threadId !== ask.threadId || pendingExpired(upload, now)) return { ok: false }
    claimed.push(id)
  }
  return { ok: true, ids: claimed }
}

/** BR-10: what the phone sees of an attachment. Never the id (a capability for the model), the stored name, a path or the bytes. */
export interface PhoneAttachmentView {
  name: string
  kind: AttachmentKind
  size: number
}

/** BR-13: the one projection of a message's attachments for the phone; it picks the three fields, so a new field never leaks. */
export function phoneAttachmentViews(attachments: readonly MessageAttachment[] | undefined): PhoneAttachmentView[] {
  return (attachments ?? []).map(({ name, kind, size }) => ({ name, kind, size }))
}
