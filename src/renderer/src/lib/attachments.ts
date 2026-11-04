// Pieces of the vault the user hands to the chat ("Preguntarle a Alma"): selected text, whole files, or elements of
// a drawing. They travel as text appended to the message, so every provider and agent understands them.
import { describeDrawing, DRAWING_EXT, parseDrawing, type DrawingElement } from '../../../shared/excalidraw'
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

/** A picture pasted or dropped into the chat, saved in the inbox: the agent gets its path (look_at_image). */
export function imageAttachment(path: string, name: string): Attachment {
  return { id: path, label: name, path, body: `Attached image (look at it with look_at_image): ${path}` }
}
