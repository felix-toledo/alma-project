import PptxGenJS from 'pptxgenjs'
import type JSZip from 'jszip'
import { notesText, PresentationError, shapeTexts, slideRefs, tableRows, type ParseXml, type SlideRef, type XmlNode } from '../../../shared/pptx'
import { ToolError } from '../types'
import { inSpan, parseSpan } from './common'
import { countInParagraphs, elements, openZip, parseXml, replaceInParagraphs, serializeXml, zipToBuffer, zipXml, type Document } from './xml'

export interface DeckSpec {
  slides: { title: string; bullets?: string[]; notes?: string; table?: (string | number | null)[][] }[]
  theme?: { background?: string; text?: string; accent?: string; font?: string }
}

export type PptxOp = { op: 'replace'; find: string; with: string } | { op: 'delete_slide'; index: number }

const parse: ParseXml = (xml) => parseXml(xml, 'presentation') as unknown as XmlNode

const refsOf = (zip: JSZip, label: string): Promise<SlideRef[]> =>
  slideRefs(zip, parse).catch((error: Error) => {
    throw error instanceof PresentationError ? new ToolError('tool.office.pptxInvalid', { label }) : error
  })

export async function readPptx(buffer: Buffer, label: string, range?: string): Promise<string> {
  const zip = await openZip(buffer, label)
  const refs = await refsOf(zip, label)
  const span = parseSpan(range)
  const parts: string[] = []
  for (const [i, ref] of refs.entries()) {
    if (!inSpan(span, i + 1)) continue
    const file = zip.file(ref.path)
    if (!file) continue
    const slide = parse(await file.async('string'))
    const lines = shapeTexts(slide).map((s) => `  [${s.name}] ${s.lines.join(' / ')}`)
    for (const rows of tableRows(slide)) lines.push(`  [table]\n${rows.map((r) => `    | ${r.join(' | ')} |`).join('\n')}`)
    const notes = await notesText(zip, ref, parse)
    if (notes) lines.push(`  [notes] ${notes.replace(/\n/g, ' / ')}`)
    parts.push(`Slide ${i + 1}:\n${lines.join('\n') || '  (no text)'}`)
  }
  return `PowerPoint presentation with ${refs.length} slide(s).\n\n${parts.join('\n\n')}`
}

const hex = (color: string | undefined, fallback: string): string => (color ?? fallback).replace(/^#/, '').toUpperCase()

export async function createPptx(spec: DeckSpec): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  const background = hex(spec.theme?.background, 'FFFFFF')
  const text = hex(spec.theme?.text, '1F2937')
  const accent = hex(spec.theme?.accent, '2563EB')
  const fontFace = spec.theme?.font ?? 'Calibri'
  // pptxgenjs mutates option objects, so every call gets fresh ones.
  for (const s of spec.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: background }
    slide.addText(s.title, { x: 0.5, y: 0.3, w: 12.3, h: 1, fontSize: 32, bold: true, color: accent, fontFace })
    const hasBullets = !!s.bullets?.length
    if (hasBullets) {
      slide.addText(
        s.bullets!.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.6, y: 1.5, w: 12, h: s.table ? 2.3 : 5.5, fontSize: 20, color: text, fontFace, valign: 'top' }
      )
    }
    if (s.table?.length) {
      const rows = s.table.map((row, i) =>
        row.map((cell) => ({ text: String(cell ?? ''), options: i === 0 ? { bold: true, color: 'FFFFFF', fill: { color: accent } } : {} }))
      )
      slide.addTable(rows, { x: 0.6, y: hasBullets ? 4 : 1.5, w: 12, fontSize: 14, color: text, fontFace, border: { type: 'solid', pt: 0.5, color: 'BFBFBF' } })
    }
    if (s.notes) slide.addNotes(s.notes)
  }
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
}

export async function editPptx(buffer: Buffer, label: string, ops: PptxOp[]): Promise<{ buffer: Buffer; changes: string[] }> {
  const zip = await openZip(buffer, label)
  const refs = await refsOf(zip, label)
  const slides = new Map<string, Document>()
  for (const ref of refs) slides.set(ref.path, await zipXml(zip, ref.path, label))
  const pres = await zipXml(zip, 'ppt/presentation.xml', label)
  const presRels = await zipXml(zip, 'ppt/_rels/presentation.xml.rels', label)
  const types = await zipXml(zip, '[Content_Types].xml', label)
  const changes: string[] = []
  const deleted = new Set<number>()
  for (const op of ops) {
    if (op.op === 'replace') {
      const docs = [...slides.values()]
      const found = docs.reduce((n, doc) => n + countInParagraphs(elements(doc, 'a:p'), 'a:p', 'a:t', op.find), 0)
      if (!found) throw new ToolError('tool.office.pptxNotFound', { find: op.find })
      for (const doc of docs) replaceInParagraphs(elements(doc, 'a:p'), 'a:p', 'a:t', op.find, op.with, false)
      changes.push(`replaced “${op.find}” → “${op.with}” (${found} time(s))`)
    } else {
      // Indexes refer to the deck as it was read; the slide is removed from the list, the package and its content types.
      const ref = refs[op.index - 1]
      if (!ref || deleted.has(op.index)) throw new ToolError('tool.office.pptxNoSlide', { index: op.index, count: refs.length })
      if (refs.length - deleted.size <= 1) throw new ToolError('tool.office.pptxLastSlide')
      deleted.add(op.index)
      for (const el of elements(pres, 'p:sldId')) if (el.getAttribute('r:id') === ref.relId) el.parentNode?.removeChild(el)
      for (const el of elements(presRels, 'Relationship')) if (el.getAttribute('Id') === ref.relId) el.parentNode?.removeChild(el)
      for (const part of [ref.path, ref.notesPath].filter((p): p is string => !!p)) {
        zip.remove(part)
        zip.remove(part.replace(/([^/]+)$/, '_rels/$1.rels'))
        for (const el of elements(types, 'Override')) if (el.getAttribute('PartName') === `/${part}`) el.parentNode?.removeChild(el)
      }
      slides.delete(ref.path)
      changes.push(`borrada la diapositiva ${op.index}`)
    }
  }
  for (const [path, doc] of slides) zip.file(path, serializeXml(doc))
  zip.file('ppt/presentation.xml', serializeXml(pres))
  zip.file('ppt/_rels/presentation.xml.rels', serializeXml(presRels))
  zip.file('[Content_Types].xml', serializeXml(types))
  return { buffer: await zipToBuffer(zip), changes }
}
