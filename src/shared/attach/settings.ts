import type { ProviderId, Settings } from '../types'

// A Record, so adding a provider to `ProviderId` fails typecheck here until it is listed.
const KNOWN: Record<ProviderId, true> = { anthropic: true, xai: true, deepseek: true, vercel: true, meta: true }

/** Settings from disk or older versions: unknown shapes become the default, unknown provider ids are dropped (AC-3.1). */
export function sanitizeAttachmentSettings(value: unknown): Settings['attachments'] {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).noticeAcknowledged : undefined
  if (!Array.isArray(raw)) return { noticeAcknowledged: [] }
  const ids = raw.filter((id): id is ProviderId => typeof id === 'string' && Object.hasOwn(KNOWN, id))
  return { noticeAcknowledged: [...new Set(ids)] }
}
