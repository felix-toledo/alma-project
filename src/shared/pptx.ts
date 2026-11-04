import type JSZip from 'jszip'

// Slide order and text of a .pptx, shared by the coordinator (xmldom) and the vault preview (the browser's DOMParser).

/** The DOM subset both parsers provide. */
export interface XmlNode {
  getElementsByTagName(tag: string): { length: number; item(index: number): XmlNode | null }
  getAttribute(name: string): string | null
  textContent: string | null
}

export type ParseXml = (xml: string) => XmlNode

export const elementsOf = (root: XmlNode, tag: string): XmlNode[] => {
  const list = root.getElementsByTagName(tag)
  return Array.from({ length: list.length }, (_, i) => list.item(i)!)
}

/** Resolves a relationship target against the part that holds it (`ppt/slides/slide1.xml` + `../notesSlides/n.xml`). */
export function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.') parts.push(segment)
  }
  return parts.join('/')
}

const relsPathOf = (part: string): string => {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`
}

async function xml(zip: JSZip, path: string, parse: ParseXml): Promise<XmlNode | null> {
  const file = zip.file(path)
  return file ? parse(await file.async('string')) : null
}

export interface SlideRef {
  /** Zip path, e.g. ppt/slides/slide3.xml */
  path: string
  /** The relationship id in presentation.xml.rels */
  relId: string
  notesPath?: string
}

/** Not a PowerPoint file (the callers say so in their language). */
export class PresentationError extends Error {
  constructor() {
    super('Not a valid PowerPoint presentation.')
  }
}

/** Slides in presentation order (sldIdLst), not file-name order. */
export async function slideRefs(zip: JSZip, parse: ParseXml): Promise<SlideRef[]> {
  const pres = await xml(zip, 'ppt/presentation.xml', parse)
  const rels = await xml(zip, 'ppt/_rels/presentation.xml.rels', parse)
  if (!pres || !rels) throw new PresentationError()
  const targets = new Map(elementsOf(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target') ?? '']))
  const refs: SlideRef[] = []
  for (const id of elementsOf(pres, 'p:sldId')) {
    const relId = id.getAttribute('r:id') ?? ''
    const path = resolvePart('ppt/presentation.xml', targets.get(relId) ?? '')
    const slideRels = await xml(zip, relsPathOf(path), parse)
    const notes = slideRels && elementsOf(slideRels, 'Relationship').find((r) => r.getAttribute('Type')?.endsWith('/notesSlide'))
    refs.push({ path, relId, notesPath: notes ? resolvePart(path, notes.getAttribute('Target') ?? '') : undefined })
  }
  return refs
}

export const paragraphLines = (root: XmlNode): string[] =>
  elementsOf(root, 'a:p')
    .map((p) => elementsOf(p, 'a:t').map((t) => t.textContent ?? '').join(''))
    .filter((line) => line.trim())

/** Text boxes and placeholders, with the shape name PowerPoint shows in the selection pane. */
export function shapeTexts(slide: XmlNode): { name: string; lines: string[] }[] {
  return elementsOf(slide, 'p:sp')
    .map((sp) => ({ name: elementsOf(sp, 'p:cNvPr')[0]?.getAttribute('name') ?? '', lines: paragraphLines(sp) }))
    .filter((shape) => shape.lines.length)
}

export const tableRows = (slide: XmlNode): string[][][] =>
  elementsOf(slide, 'a:tbl').map((tbl) => elementsOf(tbl, 'a:tr').map((tr) => elementsOf(tr, 'a:tc').map((tc) => paragraphLines(tc).join(' '))))

/** Speaker notes: the body placeholder of the notes slide (skips the slide image and number). */
export async function notesText(zip: JSZip, ref: SlideRef, parse: ParseXml): Promise<string> {
  const notes = ref.notesPath ? await xml(zip, ref.notesPath, parse) : null
  if (!notes) return ''
  const body = elementsOf(notes, 'p:sp').filter((sp) => elementsOf(sp, 'p:ph').some((ph) => ph.getAttribute('type') === 'body'))
  return body.flatMap(paragraphLines).join('\n')
}
