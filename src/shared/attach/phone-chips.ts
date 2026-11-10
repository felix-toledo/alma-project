import type { Refusal } from '../remote/api'
import { canSendMessage } from './display'

export type ChipState = 'preparing' | 'uploading' | 'ready' | 'failed'
/** The wire's own refusal names, plus the one cause only the phone knows: a file it could not read. */
export type PhoneChipReason = Refusal | 'network' | 'unreadable'
export interface Chip {
  key: string
  name: string
  state: ChipState
  id?: string
  reason?: PhoneChipReason
}
export type ChipEvent =
  | { type: 'added'; key: string; name: string }
  | { type: 'prepared'; key: string }
  | { type: 'uploaded'; key: string; id: string }
  | { type: 'failed'; key: string; reason: PhoneChipReason }
  | { type: 'remove'; key: string }
  | { type: 'expired'; id: string }
export type ChipEffect = { type: 'abort'; key: string } | { type: 'remove-remote'; id: string }

/**
 * The phone's chips as a state machine (spec 031 AC-8.3, AC-8.6, AC-8.7). It never touches the network: the effects tell the
 * screen what to do (abort a request, ask the PC to delete a pending upload). An event that does not fit the chip's state
 * changes nothing.
 */
export function chipsReduce(chips: readonly Chip[], event: ChipEvent): { chips: Chip[]; effects: ChipEffect[] } {
  const update = (match: (chip: Chip) => boolean, to: (chip: Chip) => Chip) => ({ chips: chips.map((c) => (match(c) ? to(c) : c)), effects: [] })
  switch (event.type) {
    case 'added':
      if (chips.some((c) => c.key === event.key)) return { chips: [...chips], effects: [] }
      return { chips: [...chips, { key: event.key, name: event.name, state: 'preparing' }], effects: [] }
    case 'prepared':
      return update((c) => c.key === event.key && c.state === 'preparing', (c) => ({ ...c, state: 'uploading' }))
    case 'uploaded':
      return update((c) => c.key === event.key && c.state === 'uploading', (c) => ({ ...c, state: 'ready', id: event.id }))
    case 'failed':
      return update((c) => c.key === event.key && (c.state === 'preparing' || c.state === 'uploading'), (c) => ({ key: c.key, name: c.name, state: 'failed', reason: event.reason }))
    case 'expired':
      return update((c) => c.state === 'ready' && c.id === event.id, (c) => ({ key: c.key, name: c.name, state: 'failed', reason: 'unavailable' }))
    case 'remove': {
      const gone = chips.find((c) => c.key === event.key)
      const rest = chips.filter((c) => c.key !== event.key)
      if (gone?.state === 'uploading') return { chips: rest, effects: [{ type: 'abort', key: gone.key }] }
      if (gone?.state === 'ready' && gone.id) return { chips: rest, effects: [{ type: 'remove-remote', id: gone.id }] }
      return { chips: rest, effects: [] }
    }
  }
}

/** The send button (AC-8.3): never while a chip is still being prepared or uploaded; otherwise the 030 rule (text or a ready file, no run). */
export function canSendNow(chips: readonly Chip[], text: string, running: boolean): boolean {
  if (chips.some((c) => c.state === 'preparing' || c.state === 'uploading')) return false
  return canSendMessage(text, chips.filter((c) => c.state === 'ready').length, running)
}
