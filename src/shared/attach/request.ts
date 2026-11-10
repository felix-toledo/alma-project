import { z } from 'zod'
import { ATTACH_LIMITS } from './rules'

const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/
/** Padded base64 length of a payload of this many bytes: the one place the 4-per-3 arithmetic lives. */
export const maxBase64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4

/** Base64 length of the biggest accepted file: checked before the string is looked at. */
const MAX_BASE64_LENGTH = maxBase64Length(ATTACH_LIMITS.maxFileBytes)

/** Bytes a base64 string decodes to, without decoding it; null when it is not strict, padded base64. */
export function decodedLength(base64: string): number | null {
  if (base64.length % 4 !== 0 || !BASE64_CHARS.test(base64)) return null
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

/** What the renderer asks the coordinator to store (AC-2.6): the real byte count wins over the claimed size. */
export const StoreRequestSchema = z
  .object({
    threadId: z.string().min(1),
    name: z.string().min(1).max(512),
    size: z.number().int().min(1).max(ATTACH_LIMITS.maxFileBytes),
    base64: z.string().min(1).max(MAX_BASE64_LENGTH),
  })
  .strict()
  .refine((r) => decodedLength(r.base64) === r.size)
