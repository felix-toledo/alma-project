import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { KnowledgeOverview, KnowledgeStatus, SearchHit, VaultEntry } from '../../shared/types'
import { resolveInWorkspace } from '../tools/paths'
import { ToolError } from '../tools/types'
import { KnowledgeDb, type ChunkHit, type FileRow } from './db'
import type { Embedder } from './embedder'
import { chunkMarkdown, noteTitle, slugify, splitFrontmatter, yamlValue } from './markdown'

export const ALMA_DIR = 'Alma'
export const MEMORY_FILE = `${ALMA_DIR}/Recuerdos.md`
export const KNOWLEDGE_DIR = `${ALMA_DIR}/Conocimientos`

const MAX_NOTE_BYTES = 5 * 1024 * 1024
const EMBED_BATCH = 8
const RRF_K = 60
/** bge-m3 cosine similarity: unrelated Spanish text sits around 0.30–0.35, a real match above ~0.55. */
const RECALL_MIN_SIMILARITY = 0.45
const DUPLICATE_SIMILARITY = 0.9
const MAX_MEMORY_CHARS = 4000

const STOPWORDS = new Set(
  'de la el los las un una unos unas y o u a al del en con por para que como es son se su sus lo le les mi mis tu tus me te nos ya no si sí pero mas más muy este esta estos estas ese esa eso the of and to in is'.split(' ')
)

/** FTS5 expression for free text: every meaningful word as a quoted prefix, OR-ed so BM25 ranks partial matches. */
export function ftsQuery(text: string): string {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].filter((w) => !STOPWORDS.has(w))
  return words.slice(0, 24).map((w) => `"${w}"*`).join(' OR ')
}

/** Reciprocal Rank Fusion: merges rankings without calibrating BM25 against cosine scores. */
export function fuseRankings(keyword: ChunkHit[], vector: (ChunkHit & { distance: number })[]): (ChunkHit & { score: number; similarity?: number; keywordRank?: number })[] {
  const merged = new Map<number, ChunkHit & { score: number; similarity?: number; keywordRank?: number }>()
  keyword.forEach((hit, rank) => merged.set(hit.id, { ...hit, score: 1 / (RRF_K + rank + 1), keywordRank: rank }))
  vector.forEach((hit, rank) => {
    const entry = merged.get(hit.id) ?? { ...hit, score: 0 }
    entry.score += 1 / (RRF_K + rank + 1)
    entry.similarity = 1 - hit.distance
    merged.set(hit.id, entry)
  })
  return [...merged.values()].sort((a, b) => b.score - a.score)
}

export function parseMemories(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1])
    .filter((line): line is string => !!line)
}

const normalize = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()

const MEMORY_HEADER = `# Recuerdos

Lo que Alma recuerda de vos. Se incluye en todas las conversaciones. Editá o borrá líneas cuando quieras.

`

interface Options {
  root: string
  dataDir: string
  embedder: Embedder
  /** Moves a file or folder to the system trash (the main process owns `shell`). */
  trash(absolutePath: string): Promise<void>
  onStatus(status: KnowledgeStatus): void
  onChanged(): void
}

/**
 * One open vault: its files (the source of truth), the search index that mirrors them, and Alma's own notes.
 * Every path from the renderer or a model is vault-relative and confined to the vault.
 */
export class KnowledgeBase {
  readonly root: string
  private db: KnowledgeDb
  private watcher: FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private scanning: Promise<void> | null = null
  private rescan = false
  private pumping = false
  private closed = false

  constructor(private options: Options) {
    this.root = options.root
    if (!existsSync(this.root)) throw new Error(`El vault no existe: ${this.root}`)
    const indexDir = join(options.dataDir, 'knowledge')
    mkdirSync(indexDir, { recursive: true })
    const id = createHash('sha1').update(this.root.toLowerCase()).digest('hex').slice(0, 16)
    this.db = new KnowledgeDb(join(indexDir, `${id}.db`), options.embedder.modelId)
  }

  /** Indexes what changed since last time, then keeps watching the folder (edits made by other apps count too). */
  start(): void {
    void this.scan()
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename && isHidden(filename.toString())) return
        this.scheduleScan()
      })
      this.watcher.on('error', (error) => console.error('[knowledge] watcher:', error))
    } catch (error) {
      console.error('[knowledge] no se pudo vigilar el vault:', error)
    }
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      void this.scan()
    }, 400)
  }

  // ponytail: every change re-stats the whole vault (~50 ms for 500 notes); track per-path events if vaults reach tens of thousands of files.
  scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true
      return this.scanning
    }
    this.scanning = this.doScan()
      .catch((error) => console.error('[knowledge] scan failed:', error))
      .finally(() => {
        this.scanning = null
        if (this.rescan && !this.closed) {
          this.rescan = false
          void this.scan()
        }
      })
    return this.scanning
  }

  private async doScan(): Promise<void> {
    const known = this.db.files()
    const seen = new Set<string>()
    const changed: { path: string; mtime: number; size: number }[] = []
    for await (const file of this.walk(this.root)) {
      if (this.closed) return
      if (!file.path.toLowerCase().endsWith('.md')) continue
      seen.add(file.path)
      const row = known.get(file.path)
      if (!row || row.mtime !== file.mtime || row.size !== file.size) changed.push(file)
    }
    const removed = [...known.keys()].filter((path) => !seen.has(path))
    const removedByHash = new Map(removed.map((path) => [known.get(path)!.hash, path]))

    for (const file of changed) {
      if (this.closed) return
      await this.indexFile(file.path, file, removedByHash)
    }
    for (const path of removedByHash.values()) this.db.removeFile(path)
    this.emitStatus()
    this.options.onChanged()
    void this.pump()
  }

  private async indexFile(path: string, info?: { mtime: number; size: number }, renamedFrom?: Map<string, string>): Promise<void> {
    const absolute = join(this.root, ...path.split('/'))
    const meta = info ?? (await stat(absolute).then((s) => ({ mtime: Math.floor(s.mtimeMs), size: s.size }), () => null))
    if (!meta || meta.size > MAX_NOTE_BYTES) return
    const text = await readFile(absolute, 'utf8').catch(() => null)
    if (text === null) return
    const hash = createHash('sha1').update(text).digest('hex')
    const existing = this.db.file(path)
    if (existing?.hash === hash) return this.db.touch(path, meta.mtime, meta.size)
    const previous = renamedFrom?.get(hash)
    if (previous) {
      renamedFrom!.delete(hash)
      this.db.renameFile(previous, path)
      return this.db.touch(path, meta.mtime, meta.size)
    }
    const origin = splitFrontmatter(text).data.origen ?? ''
    const row: FileRow = { path, mtime: meta.mtime, size: meta.size, hash, title: noteTitle(path, text), origin }
    this.db.replaceFile(row, chunkMarkdown(text))
  }

  /** Embeds pending chunks in the background, a batch at a time; search keeps working with BM25 meanwhile. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let batch = this.db.pending(EMBED_BATCH); batch.length && !this.closed; batch = this.db.pending(EMBED_BATCH)) {
        const titles = new Map<string, string>()
        const texts = batch.map((chunk) => {
          if (!titles.has(chunk.path)) titles.set(chunk.path, this.db.file(chunk.path)?.title ?? '')
          return [titles.get(chunk.path), chunk.heading, chunk.body].filter(Boolean).join('\n')
        })
        const vectors = await this.options.embedder.embed(texts)
        if (this.closed) return
        this.db.storeEmbeddings(batch.map((chunk, i) => ({ id: chunk.id, vector: vectors[i] })))
        this.emitStatus()
      }
    } catch (error) {
      if (!this.closed) console.error('[knowledge] embedding failed:', error)
    } finally {
      this.pumping = false
      if (!this.closed) this.emitStatus()
    }
  }

  /** Loads the model ahead of the first query when the index already has vectors (nothing pending to trigger it). */
  warmUp(): void {
    const { chunks, pending } = this.db.counts()
    if (chunks > pending && this.options.embedder.state().state === 'idle') {
      void this.options.embedder.embed(['calentando']).catch(() => {})
    }
  }

  status(): KnowledgeStatus {
    return { vault: this.root, scanning: !!this.scanning, ...this.db.counts(), model: this.options.embedder.state() }
  }

  emitStatus(): void {
    this.options.onStatus(this.status())
  }

  // ---------------------------------------------------------------------------
  // Search

  /** Only use vectors when the model is (or is about to be) in memory, so a search never waits on a download. */
  private async queryVector(query: string): Promise<Float32Array | null> {
    const { state } = this.options.embedder.state()
    if (state !== 'ready' && state !== 'loading') return null
    const [vector] = await this.options.embedder.embed([query]).catch(() => [])
    return vector ?? null
  }

  async search(query: string, limit = 10): Promise<SearchHit[]> {
    const fused = await this.rawSearch(query, 40)
    return dedupePerFile(fused, 2)
      .slice(0, limit)
      .map((hit) => ({ ...toHit(hit), snippet: hit.body.length > 400 ? `${hit.body.slice(0, 400)}…` : hit.body }))
  }

  private async rawSearch(query: string, depth: number): Promise<ReturnType<typeof fuseRankings>> {
    const match = ftsQuery(query)
    const keyword = match ? this.db.keyword(match, depth) : []
    const vector = await this.queryVector(query)
    return fuseRankings(keyword, vector ? this.db.nearest(vector, depth) : [])
  }

  /**
   * Context for the system prompt: the user's memories plus the vault fragments most related to the request.
   * With vectors, a fragment must be semantically close; without them (model still downloading), top BM25 only.
   */
  async recall(request: string, limit = 5): Promise<{ memories: string[]; fragments: SearchHit[] }> {
    const memories = await this.memories()
    if (!request.trim()) return { memories, fragments: [] }
    const fused = (await this.rawSearch(request, 30)).filter((hit) => hit.path !== MEMORY_FILE)
    const hasVectors = fused.some((hit) => hit.similarity !== undefined)
    const relevant = fused.filter((hit) =>
      hasVectors ? (hit.similarity ?? 0) >= RECALL_MIN_SIMILARITY : (hit.keywordRank ?? Infinity) < limit
    )
    return { memories, fragments: dedupePerFile(relevant, 2).slice(0, limit).map((hit) => ({ ...toHit(hit), snippet: hit.body })) }
  }

  // ---------------------------------------------------------------------------
  // Files (for the editor and the tools)

  resolve(path: string): string {
    if (isHidden(path)) throw new ToolError(`${path} es una carpeta interna y no se puede usar.`)
    return resolveInWorkspace(this.root, path)
  }

  private rel(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/')
  }

  private async *walk(dir: string): AsyncGenerator<VaultEntry> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        yield { path: this.rel(full), kind: 'folder', size: 0, mtime: 0 }
        yield* this.walk(full)
      } else if (entry.isFile()) {
        const info = await stat(full).catch(() => null)
        if (info) yield { path: this.rel(full), kind: 'file', size: info.size, mtime: Math.floor(info.mtimeMs) }
      }
    }
  }

  async tree(): Promise<VaultEntry[]> {
    const entries: VaultEntry[] = []
    for await (const entry of this.walk(this.root)) entries.push(entry)
    return entries
  }

  async read(path: string): Promise<{ content: string; mtime: number }> {
    const absolute = this.resolve(path)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) throw new ToolError(`No existe la nota ${path}.`)
    if (info.size > MAX_NOTE_BYTES) throw new ToolError(`${path} es demasiado grande para abrirlo (${info.size} bytes).`)
    return { content: await readFile(absolute, 'utf8'), mtime: Math.floor(info.mtimeMs) }
  }

  async write(path: string, content: string): Promise<{ mtime: number }> {
    const absolute = this.resolve(path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')
    if (path.toLowerCase().endsWith('.md')) await this.indexFile(path)
    void this.pump()
    this.emitStatus()
    const info = await stat(absolute)
    return { mtime: Math.floor(info.mtimeMs) }
  }

  async create(path: string, kind: 'file' | 'folder'): Promise<void> {
    const absolute = this.resolve(path)
    if (existsSync(absolute)) throw new ToolError(`Ya existe ${path}.`)
    if (kind === 'folder') await mkdir(absolute, { recursive: true })
    else await this.write(path, '')
    this.options.onChanged()
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.resolve(from)
    const target = this.resolve(to)
    if (!existsSync(source)) throw new ToolError(`No existe ${from}.`)
    if (existsSync(target) && source.toLowerCase() !== target.toLowerCase()) throw new ToolError(`Ya existe ${to}.`)
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    await this.scan()
  }

  async delete(path: string): Promise<void> {
    const absolute = this.resolve(path)
    if (absolute === this.root) throw new ToolError('No se puede borrar el vault entero desde acá.')
    await this.options.trash(absolute)
    await this.scan()
  }

  // ---------------------------------------------------------------------------
  // Alma's own notes: short memories and AI-written knowledge

  async memories(): Promise<string[]> {
    const text = await readFile(join(this.root, ...MEMORY_FILE.split('/')), 'utf8').catch(() => '')
    return parseMemories(text)
  }

  private async writeMemories(lines: string[]): Promise<void> {
    const absolute = join(this.root, ...MEMORY_FILE.split('/'))
    const current = await readFile(absolute, 'utf8').catch(() => '')
    // Keep whatever the user wrote around the list; only the bullet lines are rewritten.
    const prose = current ? current.split(/\r?\n/).filter((line) => !/^\s*[-*]\s+/.test(line)).join('\n').trimEnd() : MEMORY_HEADER.trimEnd()
    await this.write(MEMORY_FILE, `${prose}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`)
  }

  async remember(text: string): Promise<string> {
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line) throw new ToolError('El recuerdo está vacío.')
    const memories = await this.memories()
    if (memories.some((m) => normalize(m) === normalize(line))) return `Ya lo recordaba: «${line}».`
    const total = memories.reduce((sum, m) => sum + m.length, 0) + line.length
    if (total > MAX_MEMORY_CHARS) {
      throw new ToolError(`La memoria está llena (${MAX_MEMORY_CHARS} caracteres). Olvidá algo obsoleto con forget o guardalo como conocimiento con save_knowledge.`)
    }
    await this.writeMemories([...memories, line])
    return `Recordado: «${line}» (en ${MEMORY_FILE}).`
  }

  async forget(text: string): Promise<string> {
    const memories = await this.memories()
    const wanted = normalize(text)
    let matches = memories.filter((m) => normalize(m) === wanted)
    if (matches.length === 0) matches = memories.filter((m) => normalize(m).includes(wanted))
    if (matches.length === 0) throw new ToolError(`No hay ningún recuerdo que coincida con «${text}».`)
    if (matches.length > 1) throw new ToolError(`Coinciden ${matches.length} recuerdos; indicá el texto exacto:\n${matches.map((m) => `- ${m}`).join('\n')}`)
    await this.writeMemories(memories.filter((m) => m !== matches[0]))
    return `Olvidado: «${matches[0]}».`
  }

  /**
   * Creates or updates an AI knowledge note. Before creating, looks for a note that already says the same
   * (Mem0-style dedupe) and points the model at it instead of writing a duplicate.
   */
  async saveKnowledge(input: { title: string; content: string; path?: string; threadId?: string }): Promise<{ path: string; created: boolean; message: string }> {
    const now = new Date().toISOString()
    if (input.path) {
      const existing = await this.read(input.path)
      const { data } = splitFrontmatter(existing.content)
      if (data.origen !== 'ia') throw new ToolError(`${input.path} es una nota del usuario; solo se pueden actualizar notas creadas por Alma.`)
      await this.write(input.path, knowledgeNote(input.title, input.content, { ...data, actualizado: now }))
      return { path: input.path, created: false, message: `Actualicé ${input.path}.` }
    }

    const vector = await this.queryVector(`${input.title}\n${input.content}`)
    if (vector) {
      const duplicate = this.db.nearest(vector, 3).find((hit) => 1 - hit.distance >= DUPLICATE_SIMILARITY && hit.path !== MEMORY_FILE)
      if (duplicate) {
        const own = this.db.file(duplicate.path)?.origin === 'ia'
        return {
          path: duplicate.path,
          created: false,
          message: own
            ? `No guardé nada: ${duplicate.path} ya dice casi lo mismo (similitud ${(1 - duplicate.distance).toFixed(2)}). Si hay algo nuevo, actualizala con save_knowledge pasando path: "${duplicate.path}" y el contenido completo.`
            : `No guardé nada: la nota del usuario ${duplicate.path} ya cubre esto (similitud ${(1 - duplicate.distance).toFixed(2)}).`
        }
      }
    }

    const base = `${KNOWLEDGE_DIR}/${slugify(input.title)}`
    let path = `${base}.md`
    for (let n = 2; existsSync(join(this.root, ...path.split('/'))); n++) path = `${base}-${n}.md`
    await this.write(path, knowledgeNote(input.title, input.content, { origen: 'ia', tipo: 'conocimiento', creado: now, actualizado: now, ...(input.threadId ? { conversacion: input.threadId } : {}) }))
    return { path, created: true, message: `Guardé el conocimiento en ${path}.` }
  }

  async overview(): Promise<KnowledgeOverview> {
    const notes = this.db.knowledgeFiles(`${KNOWLEDGE_DIR}/`).map((row) => ({ path: row.path, title: row.title, mtime: row.mtime }))
    return { memories: await this.memories(), notes }
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.watcher?.close()
    await this.scanning
    this.db.close()
  }
}

function knowledgeNote(title: string, content: string, data: Record<string, string>): string {
  const frontmatter = Object.entries(data).map(([key, value]) => `${key}: ${yamlValue(value)}`).join('\n')
  const body = content.trim().replace(/^#\s+.+\n+/, '')
  return `---\n${frontmatter}\n---\n# ${title.trim()}\n\n${body}\n`
}

function isHidden(path: string): boolean {
  return path.split(/[\\/]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')
}

function dedupePerFile<T extends { path: string }>(hits: T[], perFile: number): T[] {
  const counts = new Map<string, number>()
  return hits.filter((hit) => {
    const count = (counts.get(hit.path) ?? 0) + 1
    counts.set(hit.path, count)
    return count <= perFile
  })
}

function toHit(hit: ReturnType<typeof fuseRankings>[number]): Omit<SearchHit, 'snippet'> {
  return { path: hit.path, heading: hit.heading, line: hit.line, score: hit.score, ...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}) }
}
