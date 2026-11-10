// Pieces of the vault the user hands to the chat ("Preguntarle a Alma"): selected text, whole files, or elements of
// a drawing. They travel as text appended to the message, so every provider and agent understands them.
import { describeDrawing, DRAWING_EXT, parseDrawing, type DrawingElement } from '../../../shared/excalidraw'
import { ATTACH_LIMITS } from '../../../shared/attach/rules'
import { intakeFiles, type IntakeRefusal, type IntakeResult, type IntakeSource } from '../../../shared/attach/intake'
import type { MessageAttachment } from '../../../shared/attach/compose'
import type { StoreResult } from '../../../shared/types'
import type { T } from '../i18n/useT'
import { request } from './coordinator'

export interface Attachment {
  id: string
  /** Shown on the chip. */
  label: string
  /** Vault-relative path it came from. */
  path: string
  /** What the model reads. */
  body: string
}

const MAX_BODY = 15_000
const newId = (): string => Math.random().toString(36).slice(2, 10)
const clip = (text: string): string => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}\n… (truncated)` : text)
const fileName = (path: string): string => path.split('/').pop() ?? path

export function textAttachment(path: string, text: string, lines?: [number, number]): Attachment {
  const where = lines ? (lines[0] === lines[1] ? `, line ${lines[0]}` : `, lines ${lines[0]}–${lines[1]}`) : ''
  return { id: newId(), label: `«${text.trim().slice(0, 40)}${text.trim().length > 40 ? '…' : ''}»`, path, body: `Selected text from ${path}${where}:\n"""\n${clip(text)}\n"""` }
}

export function drawingAttachment(path: string, elements: DrawingElement[], selection?: { ids: string[]; label: string }): Attachment {
  const only = selection?.ids.length ? new Set(selection.ids) : undefined
  const what = only ? `${only.size} selected element(s) of the drawing` : 'Drawing'
  return {
    id: newId(),
    label: only ? `${fileName(path)} · ${selection?.label}` : fileName(path),
    path,
    body: `${what} ${path} (id, type, «text», position; editable with excalidraw_draw):\n${describeDrawing(elements, only)}`
  }
}

/** A whole file from the tree: notes and drawings go in as content, anything else by path. */
export async function fileAttachment(path: string): Promise<Attachment> {
  if (/\.md$/i.test(path) || DRAWING_EXT.test(path)) {
    const { content } = await request<{ content: string }>({ method: 'vault.read', path })
    if (DRAWING_EXT.test(path)) return drawingAttachment(path, parseDrawing(content).elements)
    return { id: newId(), label: fileName(path), path, body: `Note ${path}:\n"""\n${clip(content)}\n"""` }
  }
  return { id: newId(), label: fileName(path), path, body: `Vault file: ${path} (not text; ask the user for whatever you need to know about it).` }
}

// ---- Files attached to a message (spec 030): the rules are in shared/attach/intake; this wires the bridges. ----

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

const readBase64 = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/** Dropped or pasted `File`s: the ones with a place on disk go by path (main reads them), a pasted screenshot by its bytes. */
export function sourcesFromFiles(files: readonly File[]): IntakeSource[] {
  return files.map((file) => {
    const path = window.desktop.attach.pathOf(file)
    return path ? { name: file.name || baseName(path), path } : { name: file.name, size: file.size, base64: () => readBase64(file) }
  })
}

/** The native dialog: several files, no type filter; cancelling gives no sources. */
export async function pickSources(): Promise<IntakeSource[]> {
  return (await window.desktop.attach.pick()).map((path) => ({ name: baseName(path), path }))
}

export function addToMessage(
  threadId: string,
  sources: readonly IntakeSource[],
  options: { canAttach: boolean; existing: readonly MessageAttachment[]; confirmSecret(name: string): Promise<boolean> }
): Promise<IntakeResult> {
  return intakeFiles(sources, {
    ...options,
    now: Date.now,
    inspect: (path) => window.desktop.attach.inspect(path),
    read: (path) => window.desktop.attach.read(path),
    store: (file) => request<StoreResult>({ method: 'attachments.store', threadId, ...file })
  })
}

const MIB = 1_048_576

/** One line for the person: the file (or folder) and why it was not attached. */
export function refusalText(t: T, refusal: IntakeRefusal): string {
  const reason = (() => {
    switch (refusal.reason) {
      case 'too-big':
        return t('attach.refuse.too-big', { mib: ATTACH_LIMITS.maxFileBytes / MIB })
      case 'too-many':
        return t('attach.refuse.too-many', { files: ATTACH_LIMITS.maxFiles })
      case 'total':
        return t('attach.refuse.total', { mib: ATTACH_LIMITS.maxTotalBytes / MIB })
      case 'type':
        return t('attach.refuse.type')
      case 'content':
        return t('attach.refuse.content')
      case 'empty':
        return t('attach.refuse.empty')
      case 'unreadable':
        return t('attach.refuse.unreadable')
      case 'malformed-image':
        return t('attach.refuse.malformed-image')
      case 'storage':
        return t('attach.refuse.storage')
      case 'company':
        return t('attach.refuse.company')
      case 'bad-payload':
        return t('attach.refuse.bad-payload')
      case 'missing':
        return t('attach.refuse.missing')
      case 'is-folder':
        return t('attach.refuse.is-folder')
      case 'denied':
        return t('attach.refuse.denied')
      case 'busy':
        return t('attach.refuse.busy')
    }
  })()
  return refusal.folder ? t('attach.folder.refused', { name: refusal.name, reason }) : t('attach.refuse.line', { name: refusal.name, reason })
}

/** Everything the last intake has to tell the person, as plain lines. */
export function intakeMessages(t: T, result: IntakeResult): string[] {
  return [
    ...result.refused.map((r) => refusalText(t, r)),
    ...result.skippedFolders.map((s) => t('attach.folder.skipped', { count: s.count, folder: s.folder }))
  ]
}
