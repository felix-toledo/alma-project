import type { NoteEntry, NoteFound } from '../../shared/remote/wire'
import { isRecord, postJson, type Failed } from './request'
import type { FetchLike } from './session'

// Nothing here is kept: every call asks the PC again, so a changed or deleted note is never shown from memory (AC-2.6, BR-26).
type Deps = { fetch: FetchLike; token: string }
const network: Failed = { ok: false, reason: 'network' }

const isEntry = (value: unknown): value is NoteEntry =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  (value.kind === 'file' || value.kind === 'folder') &&
  typeof value.size === 'number' &&
  typeof value.mtime === 'number'

const isFound = (value: unknown): value is NoteFound => isRecord(value) && typeof value.path === 'string' && typeof value.name === 'string'

export type FolderOutcome = { ok: true; vault: 'none' } | { ok: true; folder: string; entries: NoteEntry[] } | Failed

/** One folder; no active vault is its own answer (AC-2.2). */
export async function listFolder(deps: Deps & { folder: string }): Promise<FolderOutcome> {
  const reply = await postJson({ ...deps, path: '/api/notes/list', body: { folder: deps.folder } })
  if (!reply.ok) return reply
  if (reply.body.vault === 'none') return { ok: true, vault: 'none' }
  if (typeof reply.body.folder !== 'string' || !Array.isArray(reply.body.entries)) return network
  return { ok: true, folder: reply.body.folder, entries: reply.body.entries.filter(isEntry) }
}

export type FindOutcome = { ok: true; vault: 'none' } | { ok: true; found: NoteFound[] } | Failed

/** Names across the whole reachable vault (AC-2.10). */
export async function findNotes(deps: Deps & { query: string }): Promise<FindOutcome> {
  const reply = await postJson({ ...deps, path: '/api/notes/find', body: { query: deps.query } })
  if (!reply.ok) return reply
  if (reply.body.vault === 'none') return { ok: true, vault: 'none' }
  return Array.isArray(reply.body.found) ? { ok: true, found: reply.body.found.filter(isFound) } : network
}

export type ReadOutcome = { ok: true; path: string; content: string; mtime: number } | Failed

/** The text exactly as the PC sends it (AC-2.3). */
export async function readNote(deps: Deps & { path: string }): Promise<ReadOutcome> {
  const reply = await postJson({ ...deps, path: '/api/notes/read', body: { path: deps.path } })
  if (!reply.ok) return reply
  const { path, content, mtime } = reply.body
  return typeof path === 'string' && typeof content === 'string' && typeof mtime === 'number' ? { ok: true, path, content, mtime } : network
}

export type ImageOutcome = { ok: true; photo: string; mediaType: string } | Failed

/** An image a note embeds: `target` as written, `from` the note it was written in ('' when opened directly). Over 2 MB is `too-large` (AC-2.11). */
export async function fetchImage(deps: Deps & { target: string; from: string }): Promise<ImageOutcome> {
  const reply = await postJson({ ...deps, path: '/api/notes/image', body: { target: deps.target, from: deps.from } })
  if (!reply.ok) return reply
  const { photo, mediaType } = reply.body
  return typeof photo === 'string' && typeof mediaType === 'string' ? { ok: true, photo, mediaType } : network
}
