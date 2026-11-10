import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { classifyFile } from '../../shared/attach/classify'
import { stripMetadata } from '../../shared/attach/exif'
import { storedFileName } from '../../shared/attach/names'
import { decodedLength, maxBase64Length, StoreRequestSchema } from '../../shared/attach/request'
import { ATTACH_LIMITS, type AttachmentKind, type RefusalReason } from '../../shared/attach/rules'
import { planSweep } from '../../shared/attach/sweep'
import type { StoreResult } from '../../shared/types'

/** One stored attachment: kept beside its folder as `<id>.json` so the sweep and `lookup` never list file contents. */
export interface AttachmentRecord {
  id: string
  threadId: string
  originalName: string
  storedName: string
  size: number
  kind: AttachmentKind
  createdAt: number
  /** Set once the file is gone (swept); the record stays so a chip can say "removed" instead of "unknown". */
  removedAt?: number
}

/** What a tool may learn about an id: it never lists, and `unknown` covers a bad id and one never stored alike. */
export type AttachmentLookup =
  | { state: 'present'; record: AttachmentRecord; path: string }
  | { state: 'removed'; record: AttachmentRecord }
  | { state: 'unknown' }

/** All a tool or a history expansion gets of the store: one id at a time, never a listing (AC-4.5). */
export interface AttachmentReader {
  lookup(id: string): AttachmentLookup
}

const realIo = {
  existsSync: nodeFs.existsSync,
  readdirSync: (path: string): string[] => nodeFs.readdirSync(path),
  readFileSync: nodeFs.readFileSync,
  mkdirSync: nodeFs.mkdirSync,
  writeFileSync: nodeFs.writeFileSync,
  renameSync: nodeFs.renameSync,
  rmSync: nodeFs.rmSync,
}
/** The file system calls the store makes; tests replace some of them to fail on purpose. */
export type AttachmentIo = typeof realIo

export interface AttachmentStoreDeps {
  now?: () => number
  /** Takes ids, kinds, sizes, reasons and counts only: never a name or contents (AC-5.7). */
  log?: (event: string, data: Record<string, string | number>) => void
  io?: Partial<AttachmentIo>
  /** A file was stored for this conversation at this time. */
  opened?: (threadId: string, at: number) => void
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The exact shape `randomUUID` makes, lower case: nothing else is ever turned into a path. */
export const isAttachmentId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value)

/** The id of the stored attachment a path points into (`<inbox>/attachments/<id>/...`), or nothing for any other path. */
export function attachmentIdInPath(path: string, inboxDir: string): string | undefined {
  const rel = relative(join(inboxDir, 'attachments'), resolve(inboxDir, path))
  const id = rel.split(sep)[0]
  return rel.startsWith('..') || isAbsolute(rel) || !isAttachmentId(id) ? undefined : id
}

// a record is read back from disk: its stored name must still be one safe segment (what `storedFileName` makes)
const RecordSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  threadId: z.string().min(1),
  originalName: z.string(),
  storedName: z.string().regex(/^\w[\w.-]{0,59}$/),
  size: z.number().int().min(0),
  kind: z.enum(['image', 'text', 'pdf', 'office']),
  createdAt: z.number(),
  removedAt: z.number().optional(),
})

// the picture format the extension names; classify already checked the bytes are that format
const FORMAT_BY_EXT = { '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp', '.gif': 'gif' } as const

const MAX_BASE64_LENGTH = maxBase64Length(ATTACH_LIMITS.maxFileBytes)

/** Whether a payload that failed validation was refused because its real bytes are over the limit (AC-2.2). */
function overLimit(base64: unknown): boolean {
  if (typeof base64 !== 'string') return false
  return base64.length > MAX_BASE64_LENGTH || (decodedLength(base64) ?? 0) > ATTACH_LIMITS.maxFileBytes
}

/** `<inbox>/attachments/<id>/<stored name>` plus `<id>.json`. The coordinator re-checks every upload on its bytes (BR-10). */
export class AttachmentStore {
  private readonly root: string
  private readonly now: () => number
  private readonly log: NonNullable<AttachmentStoreDeps['log']>
  private readonly io: AttachmentIo
  private readonly opened: AttachmentStoreDeps['opened']

  constructor(inboxDir: string, deps: AttachmentStoreDeps = {}) {
    this.opened = deps.opened
    this.root = join(inboxDir, 'attachments')
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    this.io = { ...realIo, ...deps.io }
  }

  store(request: unknown): StoreResult {
    const parsed = StoreRequestSchema.safeParse(request)
    if (!parsed.success) {
      const body = typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {}
      if (overLimit(body.base64)) return this.refuse('too-big')
      return this.refuse(body.size === 0 && body.base64 === '' ? 'empty' : 'bad-payload')
    }
    const { threadId, name, base64 } = parsed.data
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
    const verdict = classifyFile(name, bytes, bytes.length)
    if (!verdict.ok) return this.refuse(verdict.reason)

    let data: Uint8Array = bytes
    if (verdict.kind === 'image') {
      try {
        data = stripMetadata(FORMAT_BY_EXT[verdict.ext as keyof typeof FORMAT_BY_EXT], bytes)
      } catch {
        // not even a failing strip may let the picture through with its metadata (AC-3.4)
        return this.refuse('malformed-image')
      }
    }

    const record: AttachmentRecord = {
      id: randomUUID(),
      threadId,
      originalName: name,
      storedName: storedFileName(name),
      size: data.length,
      kind: verdict.kind,
      createdAt: this.now(),
    }
    try {
      this.io.mkdirSync(join(this.root, record.id), { recursive: true })
      this.io.writeFileSync(join(this.root, record.id, record.storedName), data, { mode: 0o600 })
      this.writeRecord(record)
    } catch {
      try {
        this.erase(record.id)
      } catch {
        // best effort: what a failed store leaves behind never gets a record, so nothing lists it
      }
      return this.refuse('storage')
    }
    this.log('store', { id: record.id, kind: record.kind, size: record.size })
    // attaching is the person using the conversation: its 30 days start now (spec 030 AC-6.7)
    this.opened?.(threadId, record.createdAt)
    return { ok: true, attachment: { id: record.id, name, kind: record.kind, size: record.size } }
  }

  /** Ids only: anything that is not exactly an id is `unknown` without touching the disk (AC-4.5). */
  lookup(id: string): AttachmentLookup {
    const record = this.readRecord(id)
    if (!record) return { state: 'unknown' }
    const path = join(this.root, record.id, record.storedName)
    return record.removedAt === undefined && this.io.existsSync(path) ? { state: 'present', record, path } : { state: 'removed', record }
  }

  /** The chip's X. A file that cannot be deleted throws: the person is not told it is gone when it is not. */
  remove(id: string): boolean {
    if (!isAttachmentId(id)) return false
    const known = this.io.existsSync(this.recordFile(id)) || this.io.existsSync(join(this.root, id))
    this.erase(id)
    if (known) this.log('remove', { id })
    return known
  }

  /** Every readable record; one that does not parse is skipped, not fatal (a corrupt record loses one attachment). */
  records(): AttachmentRecord[] {
    let names: string[]
    try {
      names = this.io.readdirSync(this.root)
    } catch {
      return []
    }
    return names.flatMap((name) => {
      const record = name.endsWith('.json') ? this.readRecord(name.slice(0, -'.json'.length)) : undefined
      return record ? [record] : []
    })
  }

  /** Deleting a conversation deletes its files at once (AC-5.4). One that cannot be deleted keeps its record and is retried. */
  deleteForThread(threadId: string): void {
    let failed = 0
    for (const record of this.records()) {
      if (record.threadId !== threadId) continue
      try {
        this.erase(record.id)
        this.log('remove', { id: record.id })
      } catch {
        failed += 1
      }
    }
    if (failed) this.log('delete-failed', { count: failed })
  }

  /**
   * Deletes the files of conversations last opened 30 days ago or more (AC-6.1), skipping running ones (AC-6.2). Only
   * files the index knows are touched (AC-6.6). The record stays with `removedAt` so chips can say "removed"; a file
   * that cannot be deleted keeps a clean record and is retried at the next sweep (AC-6.5). The files of a conversation
   * that no longer exists (`threadExists` false) are due whatever their age: they are the leftovers of a failed erase (G7).
   */
  sweep(
    lastOpened: (threadId: string) => number | undefined,
    running: ReadonlySet<string>,
    threadExists: (threadId: string) => boolean = () => true,
  ): { removed: number; failed: number } {
    const records = this.records()
    const openedAt = Object.fromEntries(records.map((r) => [r.threadId, lastOpened(r.threadId)]))
    const gone = new Set(records.map((r) => r.threadId).filter((threadId) => !threadExists(threadId)))
    const byId = new Map(records.map((r) => [r.id, r]))
    let removed = 0
    let failed = 0
    for (const id of planSweep(records, openedAt, running, this.now(), gone)) {
      try {
        this.io.rmSync(join(this.root, id), { recursive: true, force: true })
        this.writeRecord({ ...(byId.get(id) as AttachmentRecord), removedAt: this.now() })
        removed += 1
      } catch {
        failed += 1
      }
    }
    this.log('sweep', { removed, failed })
    return { removed, failed }
  }

  private readRecord(id: string): AttachmentRecord | undefined {
    if (!isAttachmentId(id)) return undefined
    try {
      const parsed = RecordSchema.safeParse(JSON.parse(this.io.readFileSync(this.recordFile(id), 'utf8')))
      return parsed.success && parsed.data.id === id ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  private refuse(reason: RefusalReason): StoreResult {
    this.log('refuse', { reason })
    return { ok: false, reason }
  }

  // temp file and rename, like ThreadStore.flush: a record is either whole or absent
  private writeRecord(record: AttachmentRecord): void {
    const file = this.recordFile(record.id)
    this.io.writeFileSync(`${file}.tmp`, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
    this.io.renameSync(`${file}.tmp`, file)
  }

  // folder first, then the record, and stop at the first failure: a record is never removed while its file may remain,
  // and a crash in between leaves a record that says "removed", never an orphan file
  private erase(id: string): void {
    for (const target of [join(this.root, id), this.recordFile(id), `${this.recordFile(id)}.tmp`]) {
      this.io.rmSync(target, { recursive: true, force: true })
    }
  }

  private recordFile(id: string): string {
    return join(this.root, `${id}.json`)
  }
}
