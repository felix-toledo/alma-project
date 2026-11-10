import { ALLOWED_EXTENSIONS, ATTACH_LIMITS, type AttachmentKind, type RefusalReason } from './rules'

const IMAGE_FORMAT_BY_EXT: Readonly<Record<string, 'png' | 'jpeg' | 'webp' | 'gif'>> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.gif': 'gif',
}

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) => bytes.every((b, i) => head[at + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

const MAGIC: Record<'png' | 'jpeg' | 'webp' | 'gif', (head: Uint8Array) => boolean> = {
  png: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  webp: (h) => startsWith(h, ascii('RIFF')) && startsWith(h, ascii('WEBP'), 8),
  gif: (h) => startsWith(h, ascii('GIF87a')) || startsWith(h, ascii('GIF89a')),
}

export function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  // a trailing dot or space is dropped by Windows, so `a.pdf.` is not trusted as `.pdf`
  return dot < 0 ? '' : base.slice(dot).toLowerCase()
}

function bytesMatch(kind: AttachmentKind, ext: string, head: Uint8Array): boolean {
  switch (kind) {
    case 'image':
      return MAGIC[IMAGE_FORMAT_BY_EXT[ext]](head)
    case 'pdf':
      return startsWith(head, ascii('%PDF-'))
    case 'office':
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04])
    case 'text':
      return !head.subarray(0, ATTACH_LIMITS.sniffBytes).includes(0)
  }
}

/** The allow-list check by extension and leading bytes (BR-13); `head` is the start of the file, `size` its real length. */
export function classifyFile(
  name: string,
  head: Uint8Array,
  size: number,
): { ok: true; kind: AttachmentKind; ext: string } | { ok: false; reason: RefusalReason } {
  const ext = extensionOf(name)
  if (!Object.hasOwn(ALLOWED_EXTENSIONS, ext)) return { ok: false, reason: 'type' }
  if (size === 0) return { ok: false, reason: 'empty' }
  if (size > ATTACH_LIMITS.maxFileBytes) return { ok: false, reason: 'too-big' }
  const kind = ALLOWED_EXTENSIONS[ext]
  return bytesMatch(kind, ext, head) ? { ok: true, kind, ext } : { ok: false, reason: 'content' }
}
