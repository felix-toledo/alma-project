import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { resolveInWorkspace } from '../paths'
import { ToolError, type ToolContext } from '../types'

export type OfficeKind = 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf'

const KINDS: Record<string, OfficeKind> = { '.docx': 'docx', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.csv': 'csv', '.pptx': 'pptx', '.pdf': 'pdf' }
const LEGACY: Record<string, string> = { '.doc': 'docx', '.xls': 'xlsx', '.ppt': 'pptx', '.odt': 'docx', '.ods': 'xlsx', '.odp': 'pptx' }
const MAX_BYTES = 50 * 1024 * 1024

export function kindOf(path: string): OfficeKind {
  const ext = extname(path).toLowerCase()
  if (KINDS[ext]) return KINDS[ext]
  if (LEGACY[ext]) throw new ToolError('tool.office.legacy', { path, ext, to: LEGACY[ext] })
  throw new ToolError('tool.office.notOffice', { path })
}

/** "vault:Carpeta/archivo.docx" lives in the active vault; anything else, in the conversation's workspace. */
export function resolveOfficePath(path: string, ctx: ToolContext): string {
  const vault = /^vault:\/*(.*)$/i.exec(path)
  if (vault) {
    if (!ctx.knowledge) throw new ToolError('tool.office.noVault')
    if (!vault[1]) throw new ToolError('tool.office.vaultPath')
    // Same checks as the vault's own files: no escaping the root, no symlinks out, no hidden folders.
    return ctx.knowledge.resolve(vault[1])
  }
  if (!ctx.workspace) throw new ToolError('tool.office.noWorkspace', { path })
  return resolveInWorkspace(ctx.workspace, path)
}

export async function readInput(absolute: string, label: string): Promise<Buffer> {
  const info = await stat(absolute).catch(() => null)
  if (!info) throw new ToolError('tool.office.notFound', { label })
  if (!info.isFile()) throw new ToolError('tool.office.notFile', { label })
  // ponytail: caps the file, not what its zip inflates to; check entry sizes if bombs ever show up.
  if (info.size > MAX_BYTES) throw new ToolError('tool.office.tooBig', { label, mb: Math.round(info.size / 1048576) })
  return readFile(absolute)
}

export const exists = (absolute: string): Promise<boolean> =>
  stat(absolute).then(
    () => true,
    () => false
  )

/** Writes the file; an existing one is first copied to `<name>.bak`. Returns the backup path, if any. */
export async function safeWrite(absolute: string, data: Buffer | string, label: string): Promise<string | null> {
  await mkdir(dirname(absolute), { recursive: true })
  const backup = (await exists(absolute)) ? `${absolute}.bak` : null
  try {
    if (backup) await copyFile(absolute, backup)
    await writeFile(absolute, data)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new ToolError('tool.office.writeBusy', { label })
    throw new ToolError('tool.office.writeFailed', { label, error: (error as Error).message })
  }
  return backup
}

/** "3", "2-5" or "4-" (1-based, inclusive). */
export function parseSpan(range: string | undefined): [number, number] | null {
  if (!range) return null
  const match = /^\s*[a-z]?(\d+)\s*(?:-\s*[a-z]?(\d*))?\s*$/i.exec(range)
  if (!match) throw new ToolError('tool.office.badRange', { range })
  const from = Number(match[1])
  const to = match[2] === undefined ? from : match[2] === '' ? Infinity : Number(match[2])
  return [from, to]
}

export const inSpan = (span: [number, number] | null, n: number): boolean => !span || (n >= span[0] && n <= span[1])

export const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`
