import { isCompanyThread } from '../threads'
import type { PreviewResult } from '../types'
import { extensionOf } from './classify'
import type { MessageAttachment } from './compose'

// BR-25: what the system may open from a chip. Source code is out (script hosts and editors would run or edit it) and so
// is .xlsm (macros). A different list here is a different security decision, not a style choice.
const OPENABLE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json', '.log'])

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const PLAIN_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Raster pictures only: `image` is PNG, JPEG, WebP or GIF because SVG never passes the allow-list. */
export function hasThumbnail(a: Pick<MessageAttachment, 'kind'>): boolean {
  return a.kind === 'image'
}

/** Whether "open with the system app" is offered for a stored file name (AC-7.5); the coordinator and main both check it. */
export function canOpenWithSystemApp(name: string): boolean {
  return OPENABLE.has(extensionOf(name))
}

/** The providers that will read the attachment and have not been shown the notice yet (AC-3.1), once each, in the order given. */
export function unacknowledgedReaders<P extends string>(readers: readonly P[], acknowledged: readonly P[]): P[] {
  return [...new Set(readers)].filter((r) => !acknowledged.includes(r))
}

/** A company agent's conversation takes no attachments (BR-24); the same definition as the thread list uses. */
export function canAttachTo(thread: { agentId: string }, agents: readonly { id: string; companyId?: string }[]): boolean {
  return !isCompanyThread(thread.agentId, agents)
}

/** The send button (AC-2.7, AC-1.10): text or attachments, never during a run. */
export function canSendMessage(text: string, attachments: number, running: boolean): boolean {
  return !running && (text.trim() !== '' || attachments > 0)
}

/** The `src` of a transcript thumbnail, or nothing (AC-7.4): only raster media types and plain base64 ever reach an `<img>`. */
export function thumbnailSrc(preview: PreviewResult): string | undefined {
  if (preview.state !== 'present' || !preview.mediaType || !preview.base64) return undefined
  return RASTER_TYPES.has(preview.mediaType) && PLAIN_BASE64.test(preview.base64) ? `data:${preview.mediaType};base64,${preview.base64}` : undefined
}
