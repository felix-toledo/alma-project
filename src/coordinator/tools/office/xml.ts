import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { ToolError } from '../types'

export type { Document, Element }

export function parseXml(text: string, label: string): Document {
  const parser = new DOMParser({
    locator: false,
    onError(level, message) {
      if (level !== 'warning') throw new ToolError(`XML dañado en ${label}: ${message}`)
    }
  })
  return parser.parseFromString(text, 'text/xml')
}

export const serializeXml = (doc: Document): string => new XMLSerializer().serializeToString(doc)

export function elements(root: Element | Document, tag: string): Element[] {
  const list = root.getElementsByTagName(tag)
  return Array.from({ length: list.length }, (_, i) => list.item(i)!)
}

export const childElements = (el: Element): Element[] =>
  Array.from({ length: el.childNodes.length }, (_, i) => el.childNodes.item(i)).filter((n): n is Element => n?.nodeType === 1)

export const firstChild = (el: Element | undefined, tag: string): Element | undefined => (el ? childElements(el).find((c) => c.tagName === tag) : undefined)

/** Nearest ancestor (or self) with that tag. */
export function closest(node: Node, tag: string): Element | null {
  let current: Node | null = node
  while (current && !(current.nodeType === 1 && (current as Element).tagName === tag)) current = current.parentNode
  return current as Element | null
}

export const escapeXml = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export async function openZip(buffer: Buffer | Uint8Array, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buffer)
  } catch {
    throw new ToolError(`${label} no es un documento de Office válido (el archivo está dañado o no es lo que dice su extensión).`)
  }
}

export async function zipXml(zip: JSZip, name: string, label: string): Promise<Document> {
  const file = zip.file(name)
  if (!file) throw new ToolError(`${label} no es un documento válido: falta ${name}.`)
  return parseXml(await file.async('string'), name)
}

export const zipToBuffer = (zip: JSZip): Promise<Buffer> => zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })

/** Each paragraph's text nodes (only its own, not those of a text box nested inside it). */
function textNodes(paragraph: Element, paragraphTag: string, textTag: string): Element[] {
  return elements(paragraph, textTag).filter((t) => closest(t, paragraphTag) === paragraph)
}

const occurrences = (text: string, find: string): number => text.split(find).length - 1

export function countInParagraphs(paragraphs: Element[], paragraphTag: string, textTag: string, find: string): number {
  return paragraphs.reduce((sum, p) => sum + occurrences(textNodes(p, paragraphTag, textTag).map((t) => t.textContent ?? '').join(''), find), 0)
}

/**
 * Replaces text even when Word/PowerPoint split it across several runs (spell check, edits, formatting).
 * The replacement takes the formatting of the run where the match starts. Matches never cross paragraphs.
 */
export function replaceInParagraphs(paragraphs: Element[], paragraphTag: string, textTag: string, find: string, replacement: string, preserveSpace: boolean): number {
  let count = 0
  for (const p of paragraphs) {
    const nodes = textNodes(p, paragraphTag, textTag)
    let from = 0
    for (;;) {
      const texts = nodes.map((t) => t.textContent ?? '')
      const at = texts.join('').indexOf(find, from)
      if (at < 0) break
      const end = at + find.length
      let offset = 0
      let placed = false
      nodes.forEach((node, i) => {
        const start = offset
        offset += texts[i].length
        if (offset <= at || start >= end) return
        const before = texts[i].slice(0, Math.max(0, at - start))
        const after = texts[i].slice(Math.max(0, end - start))
        node.textContent = before + (placed ? '' : replacement) + after
        placed = true
        if (preserveSpace) node.setAttribute('xml:space', 'preserve')
      })
      from = at + replacement.length
      count++
    }
  }
  return count
}
