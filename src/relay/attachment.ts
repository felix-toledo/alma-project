import { isRoutingId } from './route'

export interface Attachment {
  id: string
  /** Hash of the key the PC proved, or null while the socket has not registered. */
  keyHash: string | null
}

/** What a socket kept through a sleep. Anything that is not exactly that is nothing. */
export function parseAttachment(value: unknown): Attachment | null {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2) return null
  const { id, keyHash } = value as { id?: unknown; keyHash?: unknown }
  if (typeof id !== 'string' || !isRoutingId(id)) return null
  if (keyHash !== null && typeof keyHash !== 'string') return null
  return { id, keyHash }
}
