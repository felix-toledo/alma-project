// Live preview for CodeMirror 6: markdown syntax is hidden and rendered on every line except the
// ones the cursor is on, where the raw text shows so it can be edited. The document itself stays plain markdown.
import { syntaxTree } from '@codemirror/language'
import { type EditorState, Facet } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { DRAWING_EXT } from '../../../shared/excalidraw'
import type { T } from '../i18n/useT'
import { drawingSvg } from './drawing'
import { openNote, vaultPathOf } from './vaultLib'

/** Maps an image reference in the note to a URL the renderer can load (alma-vault://…), or null if unknown. */
export const assetResolver = Facet.define<(target: string) => string | null, (target: string) => string | null>({
  combine: (values) => values[0] ?? (() => null)
})

/** The translator for the texts a widget draws itself (CodeMirror widgets live outside React). */
export const translator = Facet.define<T, T>({
  combine: (values) => values[0] ?? (((key: string) => key) as unknown as T)
})

const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'QuoteMark'])
const HEADING = /^ATXHeading(\d)$/

class ImageWidget extends WidgetType {
  constructor(private src: string, private alt: string) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src
  }
  toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.className = 'cm-image'
    img.loading = 'lazy'
    return img
  }
}

/** ![[Plan.excalidraw]]: the drawing itself, rendered in the current theme; double click opens it. */
class DrawingWidget extends WidgetType {
  constructor(private src: string, private t: T) {
    super()
  }
  eq(other: DrawingWidget): boolean {
    return other.src === this.src
  }
  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-drawing'
    box.textContent = this.t('vault.drawing.loading')
    box.title = this.t('vault.drawing.openTitle')
    box.addEventListener('dblclick', () => openNote(vaultPathOf(this.src)))
    drawingSvg(this.src, this.t)
      .then((svg) => box.replaceChildren(svg))
      .catch((error: Error) => (box.textContent = error.message))
    return box
  }
}

const embedWidget = (src: string, alt: string, t: T): WidgetType => (DRAWING_EXT.test(src) ? new DrawingWidget(src, t) : new ImageWidget(src, alt))

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-bullet'
    span.textContent = '•'
    return span
  }
}

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private pos: number) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = this.checked
    box.className = 'cm-task'
    box.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class RuleWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const hr = document.createElement('hr')
    hr.className = 'cm-rule'
    return hr
  }
}

const hide = Decoration.replace({})

/** Lines touched by any selection range show raw markdown. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) lines.add(n)
  }
  return lines
}

function build(view: EditorView): DecorationSet {
  const { state } = view
  const active = activeLines(state)
  const resolve = state.facet(assetResolver)
  const t = state.facet(translator)
  const ranges: { from: number; to: number; deco: Decoration }[] = []
  const isActive = (pos: number): boolean => active.has(state.doc.lineAt(pos).number)

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const heading = HEADING.exec(node.name)
        if (heading) {
          const line = state.doc.lineAt(node.from)
          ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: `cm-h cm-h${heading[1]}` }) })
          return
        }
        if (node.name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos)
            ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-quote' }) })
            pos = line.to + 1
          }
          return
        }
        if (node.name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos)
            ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-fence' }) })
            pos = line.to + 1
          }
          return false
        }
        if (node.name === 'StrongEmphasis') ranges.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: 'cm-strong' }) })
        else if (node.name === 'Emphasis') ranges.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: 'cm-em' }) })
        else if (node.name === 'Strikethrough') ranges.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: 'cm-strike' }) })
        else if (node.name === 'InlineCode') ranges.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: 'cm-inline-code' }) })

        if (isActive(node.from)) return
        if (HIDDEN_MARKS.has(node.name)) {
          // Swallow the space after "#" / ">" too, so the rendered line starts at its text.
          const next = state.doc.sliceString(node.to, node.to + 1)
          const end = (node.name === 'HeaderMark' || node.name === 'QuoteMark') && next === ' ' ? node.to + 1 : node.to
          if (end > node.from) ranges.push({ from: node.from, to: end, deco: hide })
        } else if (node.name === 'Link') {
          const text = state.doc.sliceString(node.from, node.to)
          const close = text.indexOf('](')
          if (text.startsWith('[') && close > 0) {
            ranges.push({ from: node.from, to: node.from + 1, deco: hide })
            ranges.push({ from: node.from + 1, to: node.from + close, deco: Decoration.mark({ class: 'cm-link' }) })
            ranges.push({ from: node.from + close, to: node.to, deco: hide })
          }
          return false
        } else if (node.name === 'Image') {
          const match = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?/.exec(state.doc.sliceString(node.from, node.to))
          const src = match && resolve(decodeURI(match[2]))
          if (src) ranges.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: embedWidget(src, match[1], t) }) })
          return false
        } else if (node.name === 'ListMark') {
          const mark = state.doc.sliceString(node.from, node.to)
          const after = state.doc.sliceString(node.to, node.to + 5)
          const task = /^ \[([ xX])\]/.exec(after)
          if (task) {
            ranges.push({ from: node.from, to: node.to + 4, deco: Decoration.replace({ widget: new CheckboxWidget(task[1] !== ' ', node.to + 1) }) })
          } else if (/^[-*+]$/.test(mark)) {
            ranges.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new BulletWidget() }) })
          }
        } else if (node.name === 'HorizontalRule') {
          ranges.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new RuleWidget() }) })
        }
      }
    })

    // Wiki-style embeds (![[foto.png]]) aren't CommonMark, so the parser doesn't see them.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos)
      if (!active.has(line.number)) {
        for (const match of line.text.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
          const src = resolve(match[1].trim())
          const start = line.from + match.index!
          if (src) ranges.push({ from: start, to: start + match[0].length, deco: Decoration.replace({ widget: embedWidget(src, match[1], t) }) })
        }
      }
      pos = line.to + 1
    }
  }

  ranges.sort((a, b) => a.from - b.from)
  const kept: ReturnType<Decoration['range']>[] = []
  let lastReplaceEnd = -1
  for (const { from, to, deco } of ranges) {
    // Replacements must not overlap each other (an embed inside a hidden link, say).
    const replaces = deco === hide || (deco.spec as { widget?: unknown }).widget !== undefined
    if (replaces && from < lastReplaceEnd) continue
    if (replaces) lastReplaceEnd = to
    kept.push(deco.range(from, to))
  }
  return Decoration.set(kept, true)
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
