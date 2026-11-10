// Disk side of chat attachments (spec 030 T36 to T39). No electron here: the file system is a parameter, so it is tested.
import { type Dirent, realpathSync, type Stats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canOpenWithSystemApp } from '../shared/attach/display'
import { ATTACH_LIMITS, type ReadFailure } from '../shared/attach/rules'
import type { PathInfo, PathRead } from '../shared/desktop-api'

export interface AttachFs {
  lstat(path: string): Promise<Pick<Stats, 'size' | 'isFile' | 'isDirectory' | 'isSymbolicLink'>>
  readdir(path: string): Promise<Pick<Dirent, 'name' | 'isFile'>[]>
  /** At most `limit` bytes: a file that grew after the stat is never loaded whole. */
  readFile(path: string, limit: number): Promise<Uint8Array>
}

type FileHandle = Pick<Awaited<ReturnType<typeof open>>, 'stat' | 'read' | 'close'>

const MIN_CHUNK = 64 * 1024

/**
 * Opens the file once and checks the handle, not the path: only a regular file is read, so a path swapped for a folder
 * or a device after the stat is refused. Reads until the end of the file or `limit` bytes, because a network or FUSE
 * file may answer a read with fewer bytes than asked; the buffers are sized from the file, not from the limit.
 */
export async function readUpTo(path: string, limit: number, openFile: (path: string, flags: 'r') => Promise<FileHandle> = open): Promise<Uint8Array> {
  const handle = await openFile(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) {
      const code = info.isDirectory() ? 'EISDIR' : 'EINVAL'
      throw Object.assign(new Error(code), { code })
    }
    const chunks: Buffer[] = []
    let total = 0
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(Math.min(limit - total, Math.max(info.size - total + 1, MIN_CHUNK)))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      total += bytesRead
    }
    return Buffer.concat(chunks, total)
  } finally {
    await handle.close()
  }
}

const realFs: AttachFs = { lstat, readdir: (path) => readdir(path, { withFileTypes: true }), readFile: readUpTo }

/** Why a read failed, from the error code the OS gave (AC-2.4). */
function failureOf(error: unknown): ReadFailure {
  switch ((error as { code?: string } | null)?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'missing'
    case 'EACCES':
    case 'EPERM':
      return 'denied'
    case 'EBUSY':
      return 'busy'
    case 'EISDIR':
      return 'is-folder'
    default:
      return 'unreadable'
  }
}

/**
 * The bytes of one file for the composer. The size comes from `lstat` before anything is read, so a 2 GB file is
 * refused without loading it; a link is never followed (the target could be anywhere).
 */
export async function readForAttach(path: string, fs: AttachFs = realFs): Promise<PathRead> {
  try {
    const info = await fs.lstat(path)
    if (info.isDirectory()) return { ok: false, reason: 'is-folder' }
    if (!info.isFile()) return { ok: false, reason: 'unreadable' }
    if (info.size > ATTACH_LIMITS.maxFileBytes) return { ok: false, reason: 'too-big' }
    const bytes = await fs.readFile(path, ATTACH_LIMITS.maxFileBytes + 1)
    // The file may have grown between the stat and the read.
    if (bytes.length > ATTACH_LIMITS.maxFileBytes) return { ok: false, reason: 'too-big' }
    return { ok: true, name: basename(path), size: bytes.length, base64: Buffer.from(bytes).toString('base64') }
  } catch (error) {
    return { ok: false, reason: failureOf(error) }
  }
}

/**
 * What a dropped or picked path is. A folder lists its direct regular files only; subfolders, links, junctions and
 * anything that stops being a regular file by the time it is measured count as skipped (G12). Never recursive.
 */
export async function inspectPath(path: string, fs: AttachFs = realFs): Promise<PathInfo> {
  try {
    const info = await fs.lstat(path)
    if (info.isSymbolicLink()) return { kind: 'failed', reason: 'unreadable' }
    const name = basename(path) || path
    if (info.isFile()) return { kind: 'file', name, size: info.size }
    if (!info.isDirectory()) return { kind: 'failed', reason: 'unreadable' }
    const files: { path: string; name: string; size: number }[] = []
    let skipped = 0
    for (const entry of await fs.readdir(path)) {
      const full = join(path, entry.name)
      const stats = entry.isFile() ? await fs.lstat(full).catch(() => null) : null
      if (stats?.isFile()) files.push({ path: full, name: entry.name, size: stats.size })
      else skipped++
    }
    return { kind: 'folder', name, files, skipped }
  } catch (error) {
    return { kind: 'failed', reason: failureOf(error) }
  }
}

/** A path as a map key: absolute only, and Windows treats case and `/` the same way. */
function grantKey(path: unknown): string | null {
  if (typeof path !== 'string' || !isAbsolute(path)) return null
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
}

/**
 * The paths the page may ask main to read (plan 3.4, 9). A path enters only from a real picker result, a real `File`
 * dropped on the window or the listing of a granted folder; without this a compromised page could ask for any file.
 * A grant is used once and expires, and the set is bounded.
 */
export class Grants {
  private readonly expiry = new Map<string, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 300_000,
    private readonly max = 1000
  ) {}

  grant(path: string): void {
    const key = grantKey(path)
    if (!key) return
    this.expiry.delete(key)
    this.expiry.set(key, this.now() + this.ttlMs)
    for (const oldest of this.expiry.keys()) {
      if (this.expiry.size <= this.max) break
      this.expiry.delete(oldest)
    }
  }

  /** Granted and not expired, without using it up (inspect looks before the read consumes). */
  has(path: string): boolean {
    const key = grantKey(path)
    const until = key ? this.expiry.get(key) : undefined
    if (key && until !== undefined && until <= this.now()) this.expiry.delete(key)
    return until !== undefined && until > this.now()
  }

  /** Granted and not expired; uses it up. */
  consume(path: string): boolean {
    const allowed = this.has(path)
    if (allowed) this.expiry.delete(grantKey(path)!)
    return allowed
  }
}

/** The native dialog's result, granted. Cancelling returns an empty list and grants nothing. */
export async function pickPaths(show: () => Promise<string[]>, grants: Grants): Promise<string[]> {
  const paths = await show()
  for (const path of paths) grants.grant(path)
  return paths
}

/** `inspectPath` for a granted path only; the files of a granted folder become granted. */
export async function inspectGranted(path: string, grants: Grants, fs?: AttachFs): Promise<PathInfo> {
  if (!grants.has(path)) return { kind: 'failed', reason: 'denied' }
  const info = await inspectPath(path, fs)
  if (info.kind === 'folder') for (const file of info.files) grants.grant(file.path)
  return info
}

/** `readForAttach` for a granted path only; the grant is used up even when the read fails. */
export async function readGranted(path: string, grants: Grants, fs?: AttachFs): Promise<PathRead> {
  if (!grants.consume(path)) return { ok: false, reason: 'denied' }
  return readForAttach(path, fs)
}

/** Whether `path` is the store folder or anything under it (lexically; `..` is resolved first). */
export function insideAttachmentStore(path: string, root: string): boolean {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Main's own check before `shell.openPath` on an attachment (BR-25): a file one folder below the store root
 * (`<root>/<id>/<name>`) whose extension is on the shared open list. The coordinator checked the same; this does
 * not trust it.
 */
export function attachmentOpenAllowed(path: string, root: string): boolean {
  if (!insideAttachmentStore(path, root)) return false
  const parts = relative(resolve(root), resolve(path)).split(sep)
  return parts.length === 2 && canOpenWithSystemApp(parts[1])
}

/**
 * The real path to hand to `shell.openPath` for an attachment, or null. Beyond `attachmentOpenAllowed` on the path
 * as given, the real file (links resolved) must also be a listed file inside the real store, so a junction planted in
 * the store cannot point the open at something else.
 */
export function openableAttachment(path: string, root: string): string | null {
  try {
    if (!attachmentOpenAllowed(path, root)) return null
    const real = realpathSync.native(path)
    return attachmentOpenAllowed(real, realpathSync.native(root)) ? real : null
  } catch {
    return null
  }
}

/** The `shell:openPath` refusal: the path is in the store as written or once its links are resolved. */
export function touchesAttachmentStore(path: string, root: string): boolean {
  if (insideAttachmentStore(path, root)) return true
  try {
    return insideAttachmentStore(realpathSync.native(path), realpathSync.native(root))
  } catch {
    return false
  }
}
