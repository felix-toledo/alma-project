// Drawings are plain Excalidraw files (.excalidraw, the same JSON excalidraw.com saves), so they open anywhere.
// Agents can't lay out text (that needs a browser canvas), so they queue "ops" in the file under `alma.ops`; the
// window turns them into real elements the next time the drawing is shown, and saves the result.

export const DRAWING_EXT = /\.excalidraw$/i

/** A shape the way an agent describes it: Excalidraw's "element skeleton" (labels, arrows bound by id). */
export interface DrawingSkeleton {
  type: 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line'
  id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  /** The label of a shape or arrow, or the content of a text element. */
  text?: string
  strokeColor?: string
  backgroundColor?: string
  /** Arrows: the ids of the shapes they connect. */
  start?: string
  end?: string
}

export interface DrawingOp {
  /** A Mermaid flowchart/sequence/class diagram, laid out automatically. */
  mermaid?: string
  elements?: DrawingSkeleton[]
  /** Elements to remove (ids from excalidraw_read). */
  delete?: string[]
  /** Start over instead of adding to what's there. */
  replace?: boolean
}

export interface DrawingFile {
  type: 'excalidraw'
  version: number
  source: string
  elements: DrawingElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
  alma?: { ops: DrawingOp[] }
}

/** The parts of an Excalidraw element this app reads (the real type has many more fields). */
export interface DrawingElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  text?: string
  /** The text as typed; `text` has the line breaks Excalidraw added to wrap it. */
  originalText?: string
  containerId?: string | null
  boundElements?: { id: string; type: string }[] | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  strokeColor?: string
  backgroundColor?: string
}

export function emptyDrawing(): DrawingFile {
  return { type: 'excalidraw', version: 2, source: 'alma', elements: [], appState: { viewBackgroundColor: 'transparent' }, files: {} }
}

/** An empty or broken file reads as an empty drawing rather than an error. */
export function parseDrawing(content: string): DrawingFile {
  try {
    const data = JSON.parse(content) as Partial<DrawingFile>
    if (data && data.type === 'excalidraw') return { ...emptyDrawing(), ...data, elements: data.elements ?? [] }
  } catch {
    // fall through
  }
  return emptyDrawing()
}

/** Queues an agent's change; the window applies it (see the header comment). */
export function queueOp(content: string, op: DrawingOp): string {
  const drawing = parseDrawing(content)
  drawing.alma = { ops: [...(drawing.alma?.ops ?? []), op] }
  return JSON.stringify(drawing, null, 2)
}

/**
 * One line per visible element, with the text inside shapes and what each arrow connects, so a model can talk about
 * a drawing (and refer to elements by id) without reading Excalidraw's JSON.
 */
export function describeDrawing(elements: DrawingElement[], only?: Set<string>): string {
  const live = elements.filter((e) => !e.isDeleted)
  const byId = new Map(live.map((e) => [e.id, e]))
  const label = (e: DrawingElement): string => {
    const textId = e.boundElements?.find((b) => b.type === 'text')?.id
    const own = e.type === 'text' ? e : textId ? byId.get(textId) : undefined
    const text = own?.originalText ?? own?.text
    return text ? ` «${text.replace(/\s+/g, ' ').trim()}»` : ''
  }
  const lines: string[] = []
  for (const e of live) {
    if (e.type === 'text' && e.containerId && byId.has(e.containerId)) continue // shown as its container's label
    if (only && !only.has(e.id) && !(e.containerId && only.has(e.containerId))) continue
    const box = `(${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.width)}×${Math.round(e.height)})`
    const links =
      e.type === 'arrow' || e.type === 'line'
        ? [e.startBinding && `desde ${e.startBinding.elementId}`, e.endBinding && `hasta ${e.endBinding.elementId}`].filter(Boolean).join(' ')
        : ''
    lines.push(`- ${e.id} ${e.type}${label(e)} ${box}${links ? ` ${links}` : ''}`)
  }
  return lines.join('\n') || '(dibujo vacío)'
}
