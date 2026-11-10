import { phoneAttachmentViews, type PhoneAttachmentView } from '../../../shared/attach/phone'
import { REMOTE_LIMITS } from '../../../shared/remote/api'
import type { ChatMessage } from '../../../shared/types'

export interface ThreadViewMessage {
  index: number
  role: 'user' | 'assistant'
  text: string
  at: number
  /** Name, kind and size of what was attached, and nothing else of it (spec 031 BR-10); absent when there is none. */
  attachments?: PhoneAttachmentView[]
}

export interface ThreadViewPage {
  /** The cursor the phone polls with: the thread's message count, or just past the last message sent when a delta was cut. */
  rev: number
  messages: ThreadViewMessage[]
  /** Messages with text exist before the first one returned. */
  earlier: boolean
}

/** Only the text blocks: tool calls, results and thinking never leave the PC through a read (BR-4). Attachments leave as names (spec 031 BR-10). */
function textOf(message: ChatMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** A message with neither text nor attachments is left out; one with attachments only is listed (spec 031 AC-5.3). */
const isListed = (message: ChatMessage): boolean => textOf(message).length > 0 || (message.attachments?.length ?? 0) > 0

function byteCut(text: string, budget: number): string {
  if (budget <= 0) return ''
  return Buffer.from(text, 'utf8').subarray(0, budget).toString('utf8')
}

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * The 1 MB response cap. A first load or an earlier page keeps the newest messages (the rest is "earlier"); a
 * live delta keeps the oldest, so the phone's cursor can stop right after the last one sent and fetch the rest.
 * `envelope` builds the body the messages travel in, so what else it carries counts too. A lone oversized message
 * is cut to fit. Sizes add up per message (one stringify each), not by re-serializing the whole body.
 */
function fit(messages: ThreadViewMessage[], envelope: (kept: ThreadViewMessage[]) => unknown, keep: 'newest' | 'oldest'): ThreadViewMessage[] {
  const limit = REMOTE_LIMITS.requestBytes
  const kept: ThreadViewMessage[] = []
  // The first element adds no comma: an empty array costs nothing beyond its brackets, already in the base.
  let used = bytes(envelope([])) - 1
  for (const message of keep === 'newest' ? messages.slice().reverse() : messages) {
    const next = used + bytes(message) + 1
    if (next > limit && kept.length > 0) break
    kept.push(message)
    used = next
  }
  if (keep === 'newest') kept.reverse()
  const first = kept[0]
  if (kept.length !== 1 || !first || bytes(envelope(kept)) <= limit) return kept
  const overhead = bytes(envelope([{ ...first, text: '' }]))
  return [{ ...first, text: byteCut(first.text, limit - overhead) }]
}

/**
 * One window of a thread: `since` is what was committed after an index (the live follow), `before` the 30
 * messages ahead of an index (load earlier), neither the last 30. Indexes are positions in the stored thread,
 * so a page of tool-only messages can come back empty while `earlier` is still true.
 */
export function threadPage(
  raw: readonly ChatMessage[],
  page: { since?: number; before?: number },
  envelope: (kept: ThreadViewMessage[]) => unknown
): ThreadViewPage {
  const rev = raw.length
  const end = page.since !== undefined ? rev : Math.min(page.before ?? rev, rev)
  const start = page.since ?? Math.max(0, end - REMOTE_LIMITS.firstLoadMessages)
  const messages = raw
    .slice(start, end)
    .map((message, offset): ThreadViewMessage | null => {
      if (!isListed(message)) return null
      const attachments = phoneAttachmentViews(message.attachments)
      return { index: start + offset, role: message.role, text: textOf(message), at: message.ts, ...(attachments.length > 0 ? { attachments } : {}) }
    })
    .filter((message): message is ThreadViewMessage => message !== null)
  const kept = fit(messages, envelope, page.since !== undefined ? 'oldest' : 'newest')
  const firstIndex = kept[0]?.index ?? end
  // A delta cut by the cap hands back a cursor just after what it sent, so the phone asks again for the rest.
  const last = kept.at(-1)
  const cursor = page.since !== undefined && last && kept.length < messages.length ? last.index + 1 : rev
  return { rev: cursor, messages: kept, earlier: page.since === undefined && raw.slice(0, firstIndex).some(isListed) }
}
