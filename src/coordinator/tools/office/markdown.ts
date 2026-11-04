// The small Markdown subset the office tools write: headings, paragraphs, lists, pipe tables and page breaks.

export type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'bullet'; level: number; text: string }
  | { type: 'number'; level: number; text: string; list: number }
  | { type: 'table'; rows: string[][] }
  | { type: 'pagebreak' }

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

const PAGE_BREAK = /^\s*(\\pagebreak|\\newpage|<!--\s*(pagebreak|salto de p[aá]gina)\s*-->)\s*$/i

export function parseMarkdown(markdown: string): MdBlock[] {
  const blocks: MdBlock[] = []
  let para: string[] = []
  let lists = 0
  const flush = (): void => {
    if (para.length) blocks.push({ type: 'para', text: para.join(' ') })
    para = []
  }
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    const number = /^(\s*)\d+[.)]\s+(.*)$/.exec(line)
    const pageBreak = PAGE_BREAK.test(line)
    const table = /^\s*\|/.test(line)
    if (!line.trim() || pageBreak || heading || bullet || number || table) flush()
    const last = blocks.at(-1)
    if (!line.trim()) continue
    else if (pageBreak) blocks.push({ type: 'pagebreak' })
    else if (heading) blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
    else if (bullet) blocks.push({ type: 'bullet', level: Math.min(2, Math.floor(bullet[1].length / 2)), text: bullet[2] })
    else if (number) {
      if (last?.type !== 'number') lists++
      blocks.push({ type: 'number', level: Math.min(2, Math.floor(number[1].length / 2)), text: number[2], list: lists })
    } else if (table) {
      if (/^\s*\|?[\s:|-]+$/.test(line) && line.includes('-')) continue
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
      if (last?.type === 'table') last.rows.push(cells)
      else blocks.push({ type: 'table', rows: [cells] })
    } else para.push(line.trim())
  }
  flush()
  for (const block of blocks) {
    if (block.type !== 'table') continue
    const width = Math.max(...block.rows.map((r) => r.length))
    for (const row of block.rows) while (row.length < width) row.push('')
  }
  return blocks
}

/** **bold**, *italic* and `code`; no nesting. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = []
  let index = 0
  for (const match of text.matchAll(/\*\*(.+?)\*\*|\*(\S(?:.*?\S)?)\*|`([^`]+)`/g)) {
    if (match.index > index) spans.push({ text: text.slice(index, match.index) })
    if (match[1] !== undefined) spans.push({ text: match[1], bold: true })
    else if (match[2] !== undefined) spans.push({ text: match[2], italic: true })
    else spans.push({ text: match[3], code: true })
    index = match.index + match[0].length
  }
  if (index < text.length) spans.push({ text: text.slice(index) })
  return spans
}

export const plainInline = (text: string): string => parseInline(text).map((s) => s.text).join('')
