import { AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, Packer, PageBreak, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx'
import { ToolError } from '../types'
import { inSpan, parseSpan } from './common'
import { parseInline, parseMarkdown, type MdBlock, type Span } from './markdown'
import { childElements, closest, countInParagraphs, elements, escapeXml, firstChild, openZip, parseXml, replaceInParagraphs, serializeXml, zipToBuffer, zipXml, type Element } from './xml'

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const DOCUMENT = 'word/document.xml'

// ---------------------------------------------------------------------------
// Reading: body-level paragraphs are p1, p2…, tables t1, t2… (the same refs office_edit takes).

interface Block {
  ref: string
  el: Element
  /** Paragraphs seen so far, this one included (for ranges). */
  pCount: number
}

function blocks(body: Element): Block[] {
  let p = 0
  let t = 0
  const list: Block[] = []
  for (const el of childElements(body)) {
    if (el.tagName === 'w:p') list.push({ ref: `p${++p}`, el, pCount: p })
    else if (el.tagName === 'w:tbl') list.push({ ref: `t${++t}`, el, pCount: p })
    else if (el.tagName !== 'w:sectPr') list.push({ ref: '', el, pCount: p })
  }
  return list
}

const isOn = (rPr: Element | undefined, tag: string): boolean => {
  const el = firstChild(rPr, tag)
  return !!el && !['0', 'false', 'off'].includes(el.getAttribute('w:val') ?? '')
}

function runText(run: Element): string {
  let text = ''
  for (const el of childElements(run)) {
    if (el.tagName === 'w:t') text += el.textContent ?? ''
    else if (el.tagName === 'w:tab') text += '\t'
    else if (el.tagName === 'w:br') text += el.getAttribute('w:type') === 'page' ? '[page break]' : '\n'
    else if (el.tagName === 'w:cr') text += '\n'
  }
  return text
}

const ownRuns = (p: Element): Element[] => elements(p, 'w:r').filter((r) => closest(r, 'w:p') === p)

const paragraphText = (p: Element): string => ownRuns(p).map(runText).join('')

function paragraphMarkdown(p: Element, headings: Map<string, number>): string {
  const segments: Span[] = []
  for (const run of ownRuns(p)) {
    const rPr = firstChild(run, 'w:rPr')
    const span = { text: runText(run), bold: isOn(rPr, 'w:b'), italic: isOn(rPr, 'w:i') }
    const last = segments.at(-1)
    if (last && last.bold === span.bold && last.italic === span.italic) last.text += span.text
    else if (span.text) segments.push(span)
  }
  const text = segments
    .map(({ text, bold, italic }) => {
      if (!text.trim() || !(bold || italic)) return text
      const mark = bold && italic ? '***' : bold ? '**' : '*'
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!
      return `${lead}${mark}${core}${mark}${trail}`
    })
    .join('')
  const pPr = firstChild(p, 'w:pPr')
  const level = headings.get(firstChild(pPr, 'w:pStyle')?.getAttribute('w:val') ?? '')
  if (level) return `${'#'.repeat(level)} ${text}`
  const numPr = firstChild(pPr, 'w:numPr')
  if (numPr) return `${'  '.repeat(Number(firstChild(numPr, 'w:ilvl')?.getAttribute('w:val') ?? 0))}- ${text}`
  return text
}

/** Style id → heading level. Word localizes style ids (Ttulo1, berschrift1) but not their names ("heading 1"). */
function headingStyles(styles: Element | null): Map<string, number> {
  const map = new Map<string, number>()
  for (const style of styles ? elements(styles, 'w:style') : []) {
    const name = (firstChild(style, 'w:name')?.getAttribute('w:val') ?? '').toLowerCase()
    const id = style.getAttribute('w:styleId') ?? ''
    const level = /^heading (\d)$/.exec(name)?.[1] ?? (name === 'title' ? '1' : undefined)
    if (level) map.set(id, Number(level))
  }
  for (let i = 1; i <= 6; i++) if (![...map.values()].includes(i)) map.set(`Heading${i}`, i)
  return map
}

function tableMarkdown(tbl: Element): string {
  const rows = elements(tbl, 'w:tr')
    .filter((tr) => closest(tr, 'w:tbl') === tbl)
    .map((tr) => elements(tr, 'w:tc').filter((tc) => closest(tc, 'w:tbl') === tbl).map((tc) => elements(tc, 'w:p').map(paragraphText).join(' ').replace(/\|/g, '\\|').trim()))
  const width = Math.max(0, ...rows.map((r) => r.length))
  const lines = rows.map((r) => `| ${r.join(' | ')} |`)
  if (lines.length > 1) lines.splice(1, 0, `|${' --- |'.repeat(width)}`)
  return `(tabla de ${rows.length} filas × ${width} columnas)\n${lines.join('\n')}`
}

async function load(buffer: Buffer, label: string) {
  const zip = await openZip(buffer, label)
  const doc = await zipXml(zip, DOCUMENT, label)
  const body = elements(doc, 'w:body')[0]
  if (!body) throw new ToolError('tool.office.noBody', { label })
  const stylesFile = zip.file('word/styles.xml')
  const styles = stylesFile ? parseXml(await stylesFile.async('string'), 'word/styles.xml').documentElement : null
  return { zip, doc, body, styles }
}

export async function readDocx(buffer: Buffer, label: string, range?: string): Promise<string> {
  const { body, styles } = await load(buffer, label)
  const headings = headingStyles(styles)
  const span = parseSpan(range)
  const all = blocks(body)
  const lines: string[] = []
  for (const block of all) {
    // A table counts as sitting right after the paragraph before it.
    if (!inSpan(span, block.el.tagName === 'w:p' ? block.pCount : block.pCount + 1)) continue
    if (block.el.tagName === 'w:p') {
      const text = paragraphMarkdown(block.el, headings)
      if (text.trim()) lines.push(`${block.ref}: ${text}`)
    } else if (block.el.tagName === 'w:tbl') lines.push(`${block.ref}: ${tableMarkdown(block.el)}`)
    else {
      const text = elements(block.el, 'w:p').map(paragraphText).join('\n').trim()
      if (text) lines.push(`(${block.el.tagName}): ${text}`)
    }
  }
  const paragraphs = all.filter((b) => b.el.tagName === 'w:p').length
  const tables = all.filter((b) => b.el.tagName === 'w:tbl').length
  return `Word document: ${paragraphs} paragraphs, ${tables} tables${span ? ` (showing paragraphs ${range})` : ''}. Empty paragraphs are omitted.\n\n${lines.join('\n') || '(no text)'}`
}

// ---------------------------------------------------------------------------
// Creating: Markdown → docx with the `docx` library.

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const runs = (text: string, bold = false): TextRun[] =>
  parseInline(text).map((s) => new TextRun({ text: s.text, bold: bold || s.bold, italics: s.italic, font: s.code ? 'Consolas' : undefined }))
const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' }

function toDocx(block: MdBlock): Paragraph | Table {
  switch (block.type) {
    case 'heading':
      return new Paragraph({ heading: HEADINGS[block.level - 1], children: runs(block.text) })
    case 'bullet':
      return new Paragraph({ bullet: { level: block.level }, children: runs(block.text) })
    case 'number':
      return new Paragraph({ numbering: { reference: 'numeros', level: block.level, instance: block.list }, children: runs(block.text) })
    case 'pagebreak':
      return new Paragraph({ children: [new PageBreak()] })
    case 'table':
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
        rows: block.rows.map(
          (row, i) => new TableRow({ tableHeader: i === 0, children: row.map((cell) => new TableCell({ children: [new Paragraph({ children: runs(cell, i === 0) })] })) })
        )
      })
    default:
      return new Paragraph({ children: runs(block.text) })
  }
}

export async function createDocx(markdown: string): Promise<Buffer> {
  const children = parseMarkdown(markdown).map(toDocx)
  const document = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'numeros',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
          }))
        }
      ]
    },
    sections: [{ children: children.length ? children : [new Paragraph({})] }]
  })
  return Packer.toBuffer(document)
}

// ---------------------------------------------------------------------------
// Editing in place: the XML is changed directly, so everything else in the file (styles, images, headers) is kept.

/** Markdown → raw OOXML that uses the document's own heading styles. */
// ponytail: lists become "•"/"1." text with an indent instead of real Word numbering; add numbering.xml entries if users notice.
function markdownToOoxml(markdown: string, styleNames: Map<string, string>): string {
  const run = (s: Span, extra = ''): string => {
    const props = `${s.bold ? '<w:b/>' : ''}${s.italic ? '<w:i/>' : ''}${s.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>' : ''}${extra}`
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(s.text)}</w:t></w:r>`
  }
  const para = (text: string, pPr = '', runExtra = '', bold = false): string =>
    `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${parseInline(text).map((s) => run({ ...s, bold: bold || s.bold }, runExtra)).join('')}</w:p>`
  const listStyle = styleNames.get('list paragraph')
  const numbers = new Map<number, number>()
  return parseMarkdown(markdown)
    .map((block) => {
      switch (block.type) {
        case 'heading': {
          const id = styleNames.get(`heading ${block.level}`)
          if (id) return para(block.text, `<w:pStyle w:val="${escapeXml(id)}"/>`)
          return para(block.text, '', `<w:sz w:val="${[36, 30, 26, 24, 22, 22][block.level - 1]}"/>`, true)
        }
        case 'bullet':
        case 'number': {
          const n = (numbers.get(block.type === 'number' ? block.list : -1) ?? 0) + 1
          if (block.type === 'number') numbers.set(block.list, n)
          const prefix = block.type === 'number' ? `${n}. ` : '• '
          const pPr = `${listStyle ? `<w:pStyle w:val="${escapeXml(listStyle)}"/>` : ''}<w:ind w:left="${720 * (block.level + 1)}" w:hanging="360"/>`
          return para(prefix + block.text, pPr)
        }
        case 'pagebreak':
          return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
        case 'table': {
          const cols = block.rows[0].length
          const b = (side: string): string => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`
          const grid = `<w:tblGrid>${`<w:gridCol w:w="${Math.floor(9000 / cols)}"/>`.repeat(cols)}</w:tblGrid>`
          const rows = block.rows.map((row, i) => `<w:tr>${row.map((cell) => `<w:tc>${para(cell, '', '', i === 0)}</w:tc>`).join('')}</w:tr>`).join('')
          return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b).join('')}</w:tblBorders></w:tblPr>${grid}${rows}</w:tbl>`
        }
        default:
          return para(block.text)
      }
    })
    .join('')
}

export type DocxOp =
  | { op: 'replace'; find: string; with: string; all?: boolean }
  | { op: 'insert_after'; ref?: string; find?: string; markdown: string }
  | { op: 'delete'; ref: string }

export async function editDocx(buffer: Buffer, label: string, ops: DocxOp[]): Promise<{ buffer: Buffer; changes: string[] }> {
  const { zip, doc, body, styles } = await load(buffer, label)
  const styleNames = new Map(
    (styles ? elements(styles, 'w:style') : []).map((s) => [(firstChild(s, 'w:name')?.getAttribute('w:val') ?? '').toLowerCase(), s.getAttribute('w:styleId') ?? ''])
  )
  // Refs always point at the document as it was read, even after earlier ops in the same call.
  const original = blocks(body).filter((b) => b.ref)
  const byRef = new Map(original.map((b) => [b.ref, b.el]))
  const changes: string[] = []
  const blockOf = (ref: string): Element => {
    const el = byRef.get(ref.trim().toLowerCase())
    if (!el) throw new ToolError('tool.office.docxNoRef', { ref })
    if (!el.parentNode) throw new ToolError('tool.office.docxDeleted', { ref })
    return el
  }
  for (const op of ops) {
    if (op.op === 'replace') {
      const paragraphs = elements(doc, 'w:p')
      const found = countInParagraphs(paragraphs, 'w:p', 'w:t', op.find)
      if (!found) throw new ToolError('tool.office.docxNotFound', { find: op.find })
      if (found > 1 && !op.all) throw new ToolError('tool.office.docxAmbiguous', { find: op.find, count: found })
      replaceInParagraphs(paragraphs, 'w:p', 'w:t', op.find, op.with, true)
      changes.push(`replaced “${op.find}” → “${op.with}” (${found} time(s))`)
    } else if (op.op === 'insert_after') {
      let anchor: Element | undefined
      if (op.ref) anchor = blockOf(op.ref)
      else if (op.find) {
        const find = op.find
        anchor = blocks(body).find((b) => b.ref && elements(b.el, 'w:p').concat(b.el.tagName === 'w:p' ? [b.el] : []).some((p) => paragraphText(p).includes(find)))?.el
        if (!anchor) throw new ToolError('tool.office.docxNoParagraph', { find: op.find })
      } else throw new ToolError('tool.office.docxNeedsRef')
      const fragment = parseXml(`<w:body xmlns:w="${W_NS}">${markdownToOoxml(op.markdown, styleNames)}</w:body>`, 'markdown')
      let after: Element = anchor
      for (const node of childElements(fragment.documentElement!)) {
        const imported = doc.importNode(node, true) as Element
        anchor.parentNode!.insertBefore(imported, after.nextSibling)
        after = imported
      }
      // Word wants a paragraph between a table and the end of the body.
      const next = after.nextSibling as Element | null
      if (after.tagName === 'w:tbl' && (!next || next.tagName === 'w:sectPr')) anchor.parentNode!.insertBefore(doc.createElementNS(W_NS, 'w:p'), next)
      changes.push(`inserted content after ${op.ref ?? `“${op.find}”`}`)
    } else {
      const el = blockOf(op.ref)
      el.parentNode!.removeChild(el)
      changes.push(`borrado ${op.ref}`)
    }
  }
  zip.file(DOCUMENT, serializeXml(doc))
  return { buffer: await zipToBuffer(zip), changes }
}
