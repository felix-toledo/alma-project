// Excalidraw in the window: loads the library on demand (it's ~3 MB), turns the ops agents queue into real elements
// (laying out text needs a canvas, which only the window has) and renders drawings embedded in notes.
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { DrawingElement, DrawingFile, DrawingSkeleton } from '../../../shared/excalidraw'
import { parseDrawing } from '../../../shared/excalidraw'
import type { T } from '../i18n/useT'

type Library = typeof import('@excalidraw/excalidraw')
let library: Promise<Library> | null = null

/** Fonts are served by the app itself (see electron.vite.config.ts), never from a CDN. */
export function loadExcalidraw(): Promise<Library> {
  ;(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL('./excalidraw/', document.baseURI).href
  library ??= import('@excalidraw/excalidraw')
  return library
}

export const isDark = (): boolean => document.documentElement.dataset.theme !== 'light'

// Text is measured when agent ops are converted; without the hand-drawn font loaded, labels get the width of the
// fallback font and wrap ("Lanzamient o"). Excalidraw only registers its fonts once its editor mounts, so a drawing
// seen first embedded in a note needs this. The file is Excalifont's Latin subset (accents and `ñ`) in 0.18.1.
let font: Promise<unknown> | null = null
function ensureFont(): Promise<unknown> {
  font ??= (async () => {
    const face = new FontFace('Excalifont', `url(${new URL('./excalidraw/fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2', document.baseURI).href})`)
    document.fonts.add(await face.load())
  })().catch(() => undefined)
  return font
}

type Element = ExcalidrawElement & DrawingElement
const GAP = 120

type Box = { x: number; y: number; width: number; height: number; type?: string }
const center = (e: Box): [number, number] => [e.x + e.width / 2, e.y + e.height / 2]
/** A shape the agent didn't size gets room for its label (an ellipse or diamond holds less text than its box). */
function boxOf(shape: DrawingSkeleton): Box {
  const lines = (shape.text ?? '').split('\n')
  const roomy = shape.type === 'ellipse' || shape.type === 'diamond' ? 1.5 : 1
  const width = shape.width ?? Math.max(160, Math.max(...lines.map((l) => l.length)) * 12 * roomy + 50)
  const height = shape.height ?? Math.max(80, lines.length * 26 * roomy + 40)
  return { x: shape.x ?? 0, y: shape.y ?? 0, width, height, type: shape.type }
}
const EDGE_GAP = 6

/** Where the line from the shape's center towards (tx, ty) leaves its outline (box, ellipse or diamond). */
function edgePoint(box: Box, tx: number, ty: number): [number, number] {
  const [cx, cy] = center(box)
  const dx = tx - cx
  const dy = ty - cy
  const a = box.width / 2
  const b = box.height / 2
  if (!dx && !dy) return [cx, cy]
  const t =
    box.type === 'ellipse'
      ? 1 / Math.hypot(dx / a, dy / b)
      : box.type === 'diamond'
        ? 1 / (Math.abs(dx) / a + Math.abs(dy) / b)
        : Math.min(a / Math.abs(dx || 1e-9), b / Math.abs(dy || 1e-9))
  const gap = EDGE_GAP / Math.hypot(dx, dy)
  return [cx + dx * (t + gap), cy + dy * (t + gap)]
}

/** `boxes`: where every shape is (this batch and the drawing), so a connecting arrow is drawn between them. */
function toSkeleton(shape: DrawingSkeleton, inBatch: Set<string>, boxes: Map<string, Box>): ExcalidrawElementSkeleton {
  const base = { id: shape.id, x: shape.x ?? 0, y: shape.y ?? 0, strokeColor: shape.strokeColor, backgroundColor: shape.backgroundColor, ...(shape.backgroundColor ? { fillStyle: 'solid' as const } : {}) }
  if (shape.type === 'text') return { ...base, type: 'text', text: shape.text ?? '' }
  if (shape.type === 'arrow' || shape.type === 'line') {
    // Route it edge to edge up front: its label is placed relative to where the arrow is created.
    const from = shape.start ? boxes.get(shape.start) : undefined
    const to = shape.end ? boxes.get(shape.end) : undefined
    const [fx, fy] = from ? center(from) : [base.x, base.y]
    const [tx, ty] = to ? center(to) : [fx + (shape.width ?? 150), fy + (shape.height ?? 0)]
    const [x1, y1] = from ? edgePoint(from, tx, ty) : [fx, fy]
    const [x2, y2] = to ? edgePoint(to, fx, fy) : [tx, ty]
    return {
      ...base,
      type: shape.type,
      x: x1,
      y: y1,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      points: [
        [0, 0],
        [x2 - x1, y2 - y1]
      ],
      label: shape.text ? { text: shape.text } : undefined,
      // Shapes from this same batch bind natively; existing ones are bound afterwards (see bindToExisting).
      start: shape.start && inBatch.has(shape.start) ? { id: shape.start } : undefined,
      end: shape.end && inBatch.has(shape.end) ? { id: shape.end } : undefined
    } as ExcalidrawElementSkeleton
  }
  return { ...base, ...boxOf(shape), type: shape.type, label: shape.text ? { text: shape.text } : undefined } as ExcalidrawElementSkeleton
}

/** An arrow from or to a shape that was already in the drawing (already routed by toSkeleton): bind those ends. */
function bindToExisting(arrow: Element, shape: DrawingSkeleton, inBatch: Set<string>, all: Map<string, Element>): void {
  const existing = (id?: string): Element | undefined => (id && !inBatch.has(id) ? all.get(id) : undefined)
  for (const [end, target] of [['startBinding', existing(shape.start)], ['endBinding', existing(shape.end)]] as const) {
    if (!target) continue
    Object.assign(arrow, { [end]: { elementId: target.id, focus: 0, gap: 8 } })
    Object.assign(target, { boundElements: [...(target.boundElements ?? []), { id: arrow.id, type: 'arrow' }] })
  }
}

/** Applies the agent ops queued in the file. `changed` says whether there was anything to apply (then save it). */
export async function applyOps(drawing: DrawingFile): Promise<{ drawing: DrawingFile; changed: boolean }> {
  const ops = drawing.alma?.ops ?? []
  if (!ops.length) return { drawing, changed: false }
  const [{ convertToExcalidrawElements }] = await Promise.all([loadExcalidraw(), ensureFont()])
  let elements = drawing.elements as Element[]
  const files = { ...drawing.files }
  for (const op of ops) {
    if (op.replace) elements = []
    if (op.delete?.length) {
      const gone = new Set(op.delete)
      elements = elements.map((e) => (gone.has(e.id) || (e.containerId && gone.has(e.containerId)) ? { ...e, isDeleted: true } : e))
    }
    const live = elements.filter((e) => !e.isDeleted)
    if (op.mermaid) {
      const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw')
      const parsed = await parseMermaidToExcalidraw(op.mermaid, { themeVariables: { fontSize: '18px' } })
      const added = convertToExcalidrawElements(parsed.elements as ExcalidrawElementSkeleton[], { regenerateIds: true }) as Element[]
      Object.assign(files, parsed.files ?? {})
      // A diagram goes to the right of what's already there, not on top of it.
      if (live.length) {
        const dx = Math.max(...live.map((e) => e.x + e.width)) + GAP - Math.min(...added.map((e) => e.x))
        const dy = Math.min(...live.map((e) => e.y)) - Math.min(...added.map((e) => e.y))
        for (const e of added) Object.assign(e, { x: e.x + dx, y: e.y + dy })
      }
      elements = [...elements, ...added]
    }
    if (op.elements?.length) {
      const shapes = op.elements.map((s, i) => (s.id ? s : { ...s, id: `alma-${Date.now().toString(36)}-${i}` }))
      const inBatch = new Set(shapes.map((s) => s.id!))
      const boxes = new Map<string, Box>([...live.map((e) => [e.id, e as Box] as const), ...shapes.filter((s) => s.type !== 'arrow' && s.type !== 'line').map((s) => [s.id!, boxOf(s)] as const)])
      const added = convertToExcalidrawElements(shapes.map((s) => toSkeleton(s, inBatch, boxes)), { regenerateIds: false }) as Element[]
      const all = new Map([...elements, ...added].map((e) => [e.id, e]))
      for (const shape of shapes) {
        const arrow = all.get(shape.id!)
        if (arrow && (shape.type === 'arrow' || shape.type === 'line')) bindToExisting(arrow, shape, inBatch, all)
      }
      elements = [...elements, ...added]
    }
  }
  const { alma: _done, ...rest } = drawing
  return { drawing: { ...rest, elements, files }, changed: true }
}

/** A drawing embedded in a note (![[Plan.excalidraw]]), as an SVG in the current theme. */
export async function drawingSvg(url: string, t: T): Promise<SVGSVGElement> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(t('vault.drawing.readFailed', { status: response.status }))
  const { drawing } = await applyOps(parseDrawing(await response.text()))
  const { exportToSvg } = await loadExcalidraw()
  return exportToSvg({
    elements: drawing.elements as unknown as ExcalidrawElement[],
    appState: { ...drawing.appState, exportBackground: false, exportWithDarkMode: isDark(), exportPadding: 12 },
    files: drawing.files as never
  })
}
