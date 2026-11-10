// Limits and the type allow-list of chat attachments (spec 030 BR-3, BR-13, BR-14). Pure: runs in the renderer, main and coordinator.
export const ATTACH_LIMITS = {
  maxFileBytes: 2_097_152,
  maxFiles: 5,
  maxTotalBytes: 10_485_760,
  sniffBytes: 8000,
  sweepDays: 30,
  sweepEveryMs: 43_200_000,
} as const

export type AttachmentKind = 'image' | 'text' | 'pdf' | 'office'

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.csv', '.json', '.log', '.css', '.yml', '.yaml', '.toml', '.ini', '.xml', '.sql',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.php', '.rb',
]

/** The one list of accepted types (lower case, with the dot). Anything else is refused. */
export const ALLOWED_EXTENSIONS: Readonly<Record<string, AttachmentKind>> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.pdf': 'pdf',
  '.docx': 'office',
  '.xlsx': 'office',
  '.xlsm': 'office',
  '.pptx': 'office',
  ...Object.fromEntries(TEXT_EXTENSIONS.map((ext) => [ext, 'text' as const])),
}

export type RefusalReason =
  | 'type'
  | 'content'
  | 'empty'
  | 'too-big'
  | 'too-many'
  | 'total'
  | 'unreadable'
  | 'malformed-image'
  | 'storage'
  | 'company'
  | 'bad-payload'

export type ReadFailure = 'missing' | 'is-folder' | 'denied' | 'busy' | 'unreadable'
