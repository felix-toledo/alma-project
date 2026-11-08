import { baseName, IMAGE_EXT, join, parentOf } from '../../shared/vault/paths'
import type { PwaKey } from '../i18n/es'
import { prepareNote } from './markdown'
import type { FindOutcome, FolderOutcome, ReadOutcome } from './notes'
import { outcomeKey, type Failure } from './outcome'
import type { ScreenEvent } from './screen-state'

// What the Notes screens draw, decided here so the screens only render (AC-6.3).

export interface NoteRow {
  key: string
  kind: 'folder' | 'note' | 'image' | 'file'
  label: string
  path: string
  /** The folder a search result lives in. */
  sub?: string
}
export type RowsView = { kind: 'none' } | { kind: 'rows'; rows: NoteRow[] }

const MARKDOWN = /\.md$/i

const labelOf = (name: string): string => name.replace(MARKDOWN, '')

function rowOf(path: string, kind: 'folder' | 'file'): NoteRow {
  const name = baseName(path)
  if (kind === 'folder') return { key: path, kind: 'folder', label: name, path }
  return { key: path, kind: MARKDOWN.test(name) ? 'note' : IMAGE_EXT.test(name) ? 'image' : 'file', label: labelOf(name), path }
}

/** A folder as rows, in the order the PC sent (folders first, sorted there); no vault is a state of its own (AC-2.2). */
export function folderEvent(outcome: FolderOutcome): ScreenEvent<RowsView> {
  if (!outcome.ok) return { type: 'failed', reason: outcome.reason, operation: 'notes.list' }
  if ('vault' in outcome) return { type: 'content', data: { kind: 'none' } }
  if (outcome.entries.length === 0) return { type: 'empty' }
  return { type: 'content', data: { kind: 'rows', rows: outcome.entries.map((entry) => rowOf(join(outcome.folder, entry.name), entry.kind)) } }
}

/** The name filter's results: each note with the folder it is in (AC-2.10). */
export function findEvent(outcome: FindOutcome): ScreenEvent<RowsView> {
  if (!outcome.ok) return { type: 'failed', reason: outcome.reason, operation: 'notes.find' }
  if ('vault' in outcome) return { type: 'content', data: { kind: 'none' } }
  if (outcome.found.length === 0) return { type: 'empty' }
  const rows = outcome.found.map(({ path }) => {
    const where = parentOf(path)
    return where ? { ...rowOf(path, 'file'), sub: where } : rowOf(path, 'file')
  })
  return { type: 'content', data: { kind: 'rows', rows } }
}

export function readEvent(outcome: ReadOutcome): ScreenEvent<{ path: string; text: string }> {
  if (!outcome.ok) return { type: 'failed', reason: outcome.reason, operation: 'notes.read' }
  return { type: 'content', data: { path: outcome.path, text: prepareNote(outcome.content) } }
}

/** A note image that is not shown says why: unresolved and blocked read the same (the phone cannot tell them apart, AC-2.4). */
export function imageFailureKey(reason: Failure): PwaKey {
  return reason === 'unavailable' || reason === 'gone' || reason === 'unsupported' || reason === 'invalid' ? 'remote.pwa.image.blocked' : outcomeKey(reason, 'notes.image')
}

/** The only URL an image is ever given: the PC's bytes inline. A media type that is not an image, or text that is not base64, gives none. */
export function imageDataUrl(photo: string, mediaType: string): string | null {
  return /^image\/[a-z0-9.+-]+$/i.test(mediaType) && /^[A-Za-z0-9+/]+={0,2}$/.test(photo) ? `data:${mediaType};base64,${photo}` : null
}

/** The heading of a note or folder and where it sits; a note drops its `.md`, any other file keeps its name. */
export function noteTitle(path: string, kind?: 'folder'): { title: string; where: string } {
  return { title: kind === 'folder' ? baseName(path) : labelOf(baseName(path)), where: parentOf(path) }
}
