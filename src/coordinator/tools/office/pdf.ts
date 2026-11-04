import { degrees, PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField, rgb, StandardFonts, type PDFFont, type PDFPage } from '@cantoo/pdf-lib'
import { extractText } from 'unpdf'
import { ToolError } from '../types'
import { inSpan, parseSpan } from './common'
import { parseMarkdown, plainInline } from './markdown'

export type PdfOp =
  | { op: 'merge'; paths: string[] }
  | { op: 'delete_pages'; pages: number[] }
  | { op: 'rotate'; pages: number[]; degrees: number }
  | { op: 'fill_form'; fields: Record<string, string | boolean> }
  | { op: 'stamp'; text: string; page?: number; x?: number; y?: number; size?: number }

async function load(buffer: Buffer | Uint8Array, label: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(buffer, { ignoreEncryption: false })
  } catch (error) {
    if (/encrypt/i.test((error as Error).message)) throw new ToolError('tool.office.pdfEncrypted', { label })
    throw new ToolError('tool.office.pdfOpen', { label, error: (error as Error).message })
  }
}

function fieldValue(field: ReturnType<ReturnType<PDFDocument['getForm']>['getFields']>[number]): string {
  if (field instanceof PDFTextField) return JSON.stringify(field.getText() ?? '')
  if (field instanceof PDFCheckBox) return field.isChecked() ? 'marcada' : 'sin marcar'
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return `${JSON.stringify(field.getSelected().join(', '))} (opciones: ${field.getOptions().join(', ')})`
  if (field instanceof PDFRadioGroup) return `${JSON.stringify(field.getSelected() ?? '')} (opciones: ${field.getOptions().join(', ')})`
  return '(firma u otro tipo)'
}

export async function readPdf(buffer: Buffer, label: string, range?: string): Promise<string> {
  let pages: string[]
  try {
    pages = (await extractText(new Uint8Array(buffer), { mergePages: false })).text
  } catch (error) {
    throw new ToolError('tool.office.pdfRead', { label, error: (error as Error).message })
  }
  const span = parseSpan(range)
  const text = pages
    .map((page, i) => (inSpan(span, i + 1) ? `--- Page ${i + 1} ---\n${page.trim() || '(no text: it may be a scanned image)'}` : ''))
    .filter(Boolean)
    .join('\n\n')
  let form = ''
  try {
    const fields = (await PDFDocument.load(buffer, { ignoreEncryption: true })).getForm().getFields()
    if (fields.length) form = `\n\nForm fields (${fields.length}):\n${fields.map((f) => `- ${f.getName()}: ${fieldValue(f)}`).join('\n')}`
  } catch {
    // Text was readable; a broken or encrypted form just isn't listed.
  }
  return `PDF of ${pages.length} page(s).\n\n${text}${form}`
}

/** Standard PDF fonts only cover Latin-1 (enough for Spanish); anything else becomes "?". */
// ponytail: no embedded Unicode font; embed a TTF with @pdf-lib/fontkit if documents need other scripts or emoji.
const encodable = (font: PDFFont): ((text: string) => string) => {
  const set = new Set(font.getCharacterSet())
  return (text) => [...text.replace(/\t/g, '    ')].map((c) => (set.has(c.codePointAt(0)!) ? c : '?')).join('')
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next
      else (lines.push(line), (line = word))
    }
    lines.push(line)
  }
  return lines
}

/** Plain-layout PDF from Markdown: headings, paragraphs, lists, tables as aligned text, page breaks. No inline bold. */
export async function createPdf(markdown: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const regular = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const clean = encodable(regular)
  const [width, height, margin] = [595.28, 841.89, 56]
  let page: PDFPage = pdf.addPage([width, height])
  let y = height - margin
  const write = (text: string, font: PDFFont, size: number, indent = 0, gap = size * 0.5): void => {
    for (const line of wrap(clean(text), font, size, width - margin * 2 - indent)) {
      if (y - size < margin) ((page = pdf.addPage([width, height])), (y = height - margin))
      page.drawText(line, { x: margin + indent, y: y - size, size, font, color: rgb(0.1, 0.1, 0.12) })
      y -= size * 1.35
    }
    y -= gap
  }
  const numbers = new Map<number, number>()
  for (const block of parseMarkdown(markdown)) {
    if (block.type === 'heading') (y -= 6, write(plainInline(block.text), bold, [22, 17, 14, 12, 11, 11][block.level - 1]))
    else if (block.type === 'bullet') write(`•  ${plainInline(block.text)}`, regular, 11, 14 * (block.level + 1), 2)
    else if (block.type === 'number') {
      const n = (numbers.get(block.list) ?? 0) + 1
      numbers.set(block.list, n)
      write(`${n}.  ${plainInline(block.text)}`, regular, 11, 14 * (block.level + 1), 2)
    }
    else if (block.type === 'pagebreak') ((page = pdf.addPage([width, height])), (y = height - margin))
    else if (block.type === 'table') {
      block.rows.forEach((row, i) => write(row.map(plainInline).join('   |   '), i === 0 ? bold : regular, 10, 0, 2))
      y -= 6
    } else write(plainInline(block.text), regular, 11)
  }
  return Buffer.from(await pdf.save())
}

const pageList = (pdf: PDFDocument, pages: number[]): number[] => {
  const count = pdf.getPageCount()
  for (const n of pages) if (!Number.isInteger(n) || n < 1 || n > count) throw new ToolError('tool.office.pdfNoPage', { n, count })
  return [...new Set(pages)]
}

export async function editPdf(buffer: Buffer, label: string, ops: PdfOp[], readOther: (path: string) => Promise<Buffer>): Promise<{ buffer: Buffer; changes: string[] }> {
  const pdf = await load(buffer, label)
  const changes: string[] = []
  for (const op of ops) {
    if (op.op === 'merge') {
      for (const path of op.paths) {
        const other = await load(await readOther(path), path)
        for (const page of await pdf.copyPages(other, other.getPageIndices())) pdf.addPage(page)
        changes.push(`added ${other.getPageCount()} page(s) from ${path}`)
      }
    } else if (op.op === 'delete_pages') {
      const pages = pageList(pdf, op.pages)
      if (pages.length >= pdf.getPageCount()) throw new ToolError('tool.office.pdfAllPages')
      // Numbers refer to the PDF as it is at this step; remove from the end so they don't shift.
      for (const n of pages.sort((a, b) => b - a)) pdf.removePage(n - 1)
      changes.push(`deleted pages ${pages.sort((a, b) => a - b).join(', ')}`)
    } else if (op.op === 'rotate') {
      if (op.degrees % 90) throw new ToolError('tool.office.pdfRotate')
      for (const n of pageList(pdf, op.pages)) {
        const page = pdf.getPage(n - 1)
        page.setRotation(degrees((((page.getRotation().angle + op.degrees) % 360) + 360) % 360))
      }
      changes.push(`rotated pages ${op.pages.join(', ')} by ${op.degrees}°`)
    } else if (op.op === 'fill_form') {
      const form = pdf.getForm()
      for (const [name, value] of Object.entries(op.fields)) {
        const field = form.getFieldMaybe(name)
        if (!field) throw new ToolError('tool.office.pdfNoField', { name })
        if (field instanceof PDFTextField) field.setText(String(value))
        else if (field instanceof PDFCheckBox) (value === true || /^(s[ií]|true|x|1|marcad[ao])$/i.test(String(value)) ? field.check() : field.uncheck())
        else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) field.select(String(value))
        else throw new ToolError('tool.office.pdfFieldType', { name })
      }
      changes.push(`filled ${Object.keys(op.fields).length} field(s)`)
    } else {
      const font = await pdf.embedFont(StandardFonts.HelveticaBold)
      const pages = op.page ? pageList(pdf, [op.page]) : pdf.getPageIndices().map((i) => i + 1)
      for (const n of pages) {
        const page = pdf.getPage(n - 1)
        page.drawText(encodable(font)(op.text), { x: op.x ?? 40, y: op.y ?? 40, size: op.size ?? 14, font, color: rgb(0.75, 0.1, 0.1) })
      }
      changes.push(`stamp “${op.text}” on ${op.page ? `page ${op.page}` : 'all pages'}`)
    }
  }
  return { buffer: Buffer.from(await pdf.save()), changes }
}

