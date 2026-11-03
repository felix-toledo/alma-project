// Markdown helpers for the vault: frontmatter, titles, slugs and heading-aware chunking.

export interface Chunk {
  /** Heading path, e.g. "Proyecto › Ideas". Empty before the first heading. */
  heading: string
  body: string
  /** 1-based line where the chunk starts, for jumping to it in the editor. */
  line: number
}

/** ~400 tokens of Spanish: small enough for precise retrieval, large enough to keep a paragraph's context. */
const MAX_CHUNK_CHARS = 1600
const MIN_CHUNK_CHARS = 200

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function splitFrontmatter(text: string): { data: Record<string, string>; body: string; bodyLine: number } {
  const match = FRONTMATTER.exec(text)
  if (!match) return { data: {}, body: text, bodyLine: 1 }
  const data: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line)
    if (pair) data[pair[1]] = pair[2].replace(/^["']|["']$/g, '').trim()
  }
  return { data, body: text.slice(match[0].length), bodyLine: match[0].split('\n').length }
}

/** Single-line YAML scalar; quoted whenever it could be misread. */
export function yamlValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return /^[\w .,áéíóúñü/-]*$/i.test(flat) && !/^[-?:]/.test(flat) ? flat : JSON.stringify(flat)
}

export function noteTitle(path: string, text: string): string {
  const heading = /^#\s+(.+)$/m.exec(splitFrontmatter(text).body)
  if (heading) return heading[1].trim()
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '')
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return slug || 'nota'
}

/** Splits a note into chunks along headings, then paragraphs, so each chunk is one coherent piece of text. */
export function chunkMarkdown(text: string): Chunk[] {
  const { body, bodyLine } = splitFrontmatter(text)
  const lines = body.split(/\r?\n/)
  const chunks: Chunk[] = []
  const headings: string[] = []
  let buffer: string[] = []
  let bufferLine = bodyLine
  let inFence = false

  const flush = (): void => {
    const content = buffer.join('\n').trim()
    if (content) {
      const heading = headings.filter(Boolean).join(' › ')
      for (const piece of splitLong(content)) chunks.push({ heading, body: piece.text, line: bufferLine + piece.offset })
    }
    buffer = []
  }

  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = heading[1].length
      headings.length = level
      headings[level - 1] = heading[2].replace(/#+\s*$/, '').trim()
      bufferLine = bodyLine + i + 1
      return
    }
    if (buffer.length === 0) bufferLine = bodyLine + i
    buffer.push(line)
  })
  flush()
  return mergeSmall(chunks)
}

/** Breaks an oversized section at paragraph, then sentence, boundaries. `offset` is in lines. */
function splitLong(text: string): { text: string; offset: number }[] {
  if (text.length <= MAX_CHUNK_CHARS) return [{ text, offset: 0 }]
  const pieces: { text: string; offset: number }[] = []
  let current = ''
  let currentOffset = 0
  let lineCursor = 0
  for (const paragraph of text.split(/\n\s*\n/)) {
    const parts = paragraph.length > MAX_CHUNK_CHARS ? paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph] : [paragraph]
    for (const part of parts) {
      if (current && current.length + part.length > MAX_CHUNK_CHARS) {
        pieces.push({ text: current.trim(), offset: currentOffset })
        current = ''
      }
      if (!current) currentOffset = lineCursor
      current += (current ? (parts.length > 1 ? '' : '\n\n') : '') + part
    }
    lineCursor += paragraph.split('\n').length + 1
  }
  if (current.trim()) pieces.push({ text: current.trim(), offset: currentOffset })
  return pieces
}

/** Tiny sections (a heading with one line) carry little meaning alone: fold them into the next chunk. */
function mergeSmall(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = []
  for (const chunk of chunks) {
    const previous = out[out.length - 1]
    if (previous && previous.body.length < MIN_CHUNK_CHARS && previous.body.length + chunk.body.length <= MAX_CHUNK_CHARS) {
      previous.body = `${previous.body}\n\n${chunk.heading ? `${chunk.heading.split(' › ').pop()}\n` : ''}${chunk.body}`
    } else {
      out.push({ ...chunk })
    }
  }
  return out
}
