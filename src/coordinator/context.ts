// Trims what is resent to the model on every request: old tool output and pictures cost tokens each turn.
import { KEEP_CHARS, shorten } from '../shared/trim'
import type { Block, ChatMessage } from '../shared/types'

const RECENT_MESSAGES = 10 // inside the turn being worked, the latest messages stay whole…
const KEEP_CHARS_IN_TURN = 1500 // …and older tool results keep this much of each end (long autonomous runs resend them every iteration)

const isRealUserMessage = (m: ChatMessage): boolean => m.role === 'user' && m.content.some((b) => b.type === 'text' || b.type === 'image')

function compactBlock(block: Block, keep: number): Block {
  if (block.type === 'tool_result') {
    const content = shorten(block.content, keep)
    return content === block.content ? block : { ...block, content }
  }
  if (block.type === 'image') return { type: 'text', text: '[earlier image omitted]' }
  return block
}

/**
 * The copy of the conversation to send: before the latest user message, tool results are cut to their ends and pictures
 * dropped (the agent already acted on them and wrote its answer); in the turn being worked only results far behind the
 * latest messages are trimmed, so the agent keeps what it just read.
 * Assistant messages are never edited (Anthropic's replayed blocks must come back unchanged). Returns the same array
 * when nothing changes; the stored thread is never touched.
 */
export function compactHistory(messages: ChatMessage[]): ChatMessage[] {
  let current = messages.length - 1
  while (current > 0 && !isRealUserMessage(messages[current])) current--
  let changed = false
  const out = messages.map((message, index) => {
    if (message.role !== 'user') return message
    // Earlier turns: results to their ends, pictures out. This turn: only what is far behind the latest messages.
    const inTurn = index >= current
    if (inTurn && index >= messages.length - RECENT_MESSAGES) return message
    const content = message.content.map((block) => (inTurn && block.type === 'image' ? block : compactBlock(block, inTurn ? KEEP_CHARS_IN_TURN : KEEP_CHARS)))
    if (content.every((block, i) => block === message.content[i])) return message
    changed = true
    return { ...message, content }
  })
  return changed ? out : messages
}
