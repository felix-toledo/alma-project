import { attachmentsText } from '../../shared/attach/compose'
import type { Block, ChatMessage } from '../../shared/types'
import type { AttachmentReader } from './store'

/**
 * The copy of the conversation the provider reads: a message that carries attachments gets the heading and one reference
 * line each appended to its text (spec 030 AC-4.1). A picture's line carries its path for `look_at_image`; no file
 * content and no image block is ever added (AC-4.2, AC-4.3). Nothing is changed in place: the stored thread keeps the
 * structured list, and the same array comes back when no message has one.
 */
export function expandAttachments(messages: ChatMessage[], reader?: AttachmentReader): ChatMessage[] {
  if (!messages.some((m) => m.attachments?.length)) return messages
  return messages.map((message) => {
    if (!message.attachments?.length) return message
    const lines = attachmentsText(
      message.attachments.map((a) => {
        const found = a.kind === 'image' ? reader?.lookup(a.id) : undefined
        return found?.state === 'present' ? { ...a, path: found.path } : a
      })
    )
    // the text block is kept even when the person typed nothing (it makes this a real user message for compactHistory)
    const at = message.content.findIndex((b) => b.type === 'text')
    const content: Block[] =
      at < 0
        ? [...message.content, { type: 'text', text: lines }]
        : message.content.map((block, i) => (i === at && block.type === 'text' ? { ...block, text: block.text + lines } : block))
    return { ...message, content }
  })
}
