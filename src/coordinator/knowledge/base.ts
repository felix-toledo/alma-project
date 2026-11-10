import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { applyChanges, type Change, MAX_MEMORY_CHARS } from '../../shared/dream/apply'
import type { Language } from '../../shared/i18n/language'
import { isOwnNote, namesOf, resolveName, type NameKey } from '../../shared/i18n/names'
import type { KnowledgeOverview, KnowledgeStatus, SearchHit, VaultEntry } from '../../shared/types'
import { memoryHeader } from '../generated'
import { resolveInWorkspace } from '../tools/paths'
import { ToolError, toolText, type ToolContext } from '../tools/types'
import { STOPWORDS } from './stopwords'
import { KnowledgeDb, type ChunkHit, type FileRow } from './db'
import type { Embedder } from './embedder'
import { chunkMarkdown, noteTitle, slugify, splitFrontmatter, yamlValue } from './markdown'

export const ALMA_DIR = 'Alma'
/** Alma's memory file and knowledge folder under each language's name (BR-23); the base picks one per vault. */
const inAlma = (key: NameKey): Record<Language, string> => ({ es: `${ALMA_DIR}/${namesOf(key).es}`, en: `${ALMA_DIR}/${namesOf(key).en}` })
export const MEMORY_FILES = inAlma('names.memoryFile')
export const KNOWLEDGE_DIRS = inAlma('names.knowledgeDir')
/** The dream journal folder (spec 033 BR-16). */
export const DREAM_DIRS = inAlma('names.dreamsDir')

export type ApplyResult = ReturnType<typeof applyChanges>
/** The Spanish names: what a vault with neither one gets under `es`. */
export const MEMORY_FILE = MEMORY_FILES.es
export const KNOWLEDGE_DIR = KNOWLEDGE_DIRS.es

type Say = Pick<ToolContext, 'reportText'>

const MAX_NOTE_BYTES = 5 * 1024 * 1024
const EMBED_BATCH = 8
const RRF_K = 60
/** bge-m3 cosine similarity: unrelated Spanish text sits around 0.30–0.35, a real match above ~0.55. */
const RECALL_MIN_SIMILARITY = 0.45
const DUPLICATE_SIMILARITY = 0.9


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

interface Options {
  root: string
  dataDir: string
  embedder: Embedder
  /** Moves a file or folder to the system trash (the main process owns `shell`). */
  trash(absolutePath: string): Promise<void>
  onStatus(status: KnowledgeStatus): void
  onChanged(): void
  /** The app language when a note is written (Spanish when the caller does not say). */
  language?(): Language
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
  /** remember, forget, editor saves of the memory file and the dream write it one at a time (spec 033 AC-6.5). */
  private memoryQueue: Promise<unknown> = Promise.resolve()

  constructor(private options: Options) {
    this.root = options.root
    if (!existsSync(this.root)) throw new ToolError('tool.vault.missing', { path: this.root })
    const indexDir = join(options.dataDir, 'knowledge')
    mkdirSync(indexDir, { recursive: true })
    const id = createHash('sha1').update(this.root.toLowerCase()).digest('hex').slice(0, 16)
    this.db = new KnowledgeDb(join(indexDir, `${id}.db`), options.embedder.modelId)
  }

  private get language(): Language {
    return this.options.language?.() ?? 'es'
  }

  /** The memory file or knowledge folder in use: the one that exists, else the current language's name (BR-23). */
  private nameInUse(names: Record<Language, string>): string {
    return resolveName(this.language, names, (name) => existsSync(join(this.root, ...name.split('/'))))
  }

  /** The vault path of Alma's memories file. */
  memoryFile(): string {
    return this.nameInUse(MEMORY_FILES)
  }

  private knowledgeDir(): string {
    return this.nameInUse(KNOWLEDGE_DIRS)
  }

  private isMemoryFile(path: string): boolean {
    return path === MEMORY_FILES.es || path === MEMORY_FILES.en
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
      console.error('[knowledge] could not watch the vault:', error)
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
    // The index keeps the Spanish marker for a note of Alma's whichever language wrote it.
    const data = splitFrontmatter(text).data
    const origin = isOwnNote(data) ? namesOf('names.originValue').es : (data[namesOf('names.originKey').es] ?? '')
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
    // The dream journal holds hunches: never injected unasked, still found by search and read (spec 033 BR-5).
    // Either language's folder, in any case: Windows names `alma/sueños` the same folder as `Alma/Sueños`.
    const journal = [`${DREAM_DIRS.es}/`, `${DREAM_DIRS.en}/`].map((dir) => dir.toLowerCase())
    const inJournal = (path: string): boolean => journal.some((dir) => path.toLowerCase().startsWith(dir))
    const fused = (await this.rawSearch(request, 30)).filter((hit) => !this.isMemoryFile(hit.path) && !inJournal(hit.path))
    const hasVectors = fused.some((hit) => hit.similarity !== undefined)
    const relevant = fused.filter((hit) =>
      hasVectors ? (hit.similarity ?? 0) >= RECALL_MIN_SIMILARITY : (hit.keywordRank ?? Infinity) < limit
    )
    return { memories, fragments: dedupePerFile(relevant, 2).slice(0, limit).map((hit) => ({ ...toHit(hit), snippet: hit.body })) }
  }

  // ---------------------------------------------------------------------------
  // Files (for the editor and the tools)

  resolve(path: string): string {
    if (isHidden(path)) throw new ToolError('tool.kb.hidden', { path })
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
    if (!info?.isFile()) throw new ToolError('tool.kb.noNote', { path })
    if (info.size > MAX_NOTE_BYTES) throw new ToolError('tool.kb.tooBig', { path, bytes: info.size })
    return { content: await readFile(absolute, 'utf8'), mtime: Math.floor(info.mtimeMs) }
  }

  /** Raw bytes of a vault file (images for the phone), read-only, confined by `resolve` and refused over `maxBytes` from its stat, before any read. */
  async readBytes(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; mtime: number }> {
    const absolute = this.resolve(path)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) throw new ToolError('tool.kb.noNote', { path })
    if (info.size > maxBytes) throw new ToolError('tool.kb.tooBig', { path, bytes: info.size })
    return { bytes: await readFile(absolute), mtime: Math.floor(info.mtimeMs) }
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.memoryQueue.then(task)
    this.memoryQueue = run.catch(() => {})
    return run
  }

  write(path: string, content: string): Promise<{ mtime: number }> {
    return this.isMemoryFile(path) ? this.serialized(() => this.writeNow(path, content)) : this.writeNow(path, content)
  }

  private async writeNow(path: string, content: string): Promise<{ mtime: number }> {
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
    if (existsSync(absolute)) throw new ToolError('tool.kb.exists', { path })
    if (kind === 'folder') await mkdir(absolute, { recursive: true })
    else await this.write(path, '')
    this.options.onChanged()
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.resolve(from)
    const target = this.resolve(to)
    if (!existsSync(source)) throw new ToolError('tool.kb.notFound', { path: from })
    if (existsSync(target) && source.toLowerCase() !== target.toLowerCase()) throw new ToolError('tool.kb.exists', { path: to })
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
    await this.scan()
  }

  async delete(path: string): Promise<void> {
    const absolute = this.resolve(path)
    if (absolute === this.root) throw new ToolError('tool.kb.cannotDeleteRoot')
    await this.options.trash(absolute)
    await this.scan()
  }

  // ---------------------------------------------------------------------------
  // Alma's own notes: short memories and AI-written knowledge

  async memories(): Promise<string[]> {
    const text = await readFile(join(this.root, ...this.memoryFile().split('/')), 'utf8').catch(() => '')
    return parseMemories(text)
  }

  private async writeMemories(lines: string[]): Promise<void> {
    const file = this.memoryFile()
    const absolute = join(this.root, ...file.split('/'))
    const current = await readFile(absolute, 'utf8').catch(() => '')
    // Keep whatever the user wrote around the list; only the bullet lines are rewritten.
    const prose = current ? current.split(/\r?\n/).filter((line) => !/^\s*[-*]\s+/.test(line)).join('\n').trimEnd() : memoryHeader(this.language).trimEnd()
    await this.writeNow(file, `${prose}\n\n${lines.map((line) => `- ${line}`).join('\n')}\n`)
  }

  remember(text: string, ctx: Say = {}): Promise<string> {
    return this.serialized(() => this.rememberNow(text, ctx))
  }

  private async rememberNow(text: string, ctx: Say): Promise<string> {
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line) throw new ToolError('tool.kb.emptyMemory')
    const memories = await this.memories()
    if (memories.some((m) => normalize(m) === normalize(line))) return toolText(ctx, 'tool.kb.alreadyRemembered', { line })
    const total = memories.reduce((sum, m) => sum + m.length, 0) + line.length
    if (total > MAX_MEMORY_CHARS) {
      throw new ToolError('tool.kb.memoryFull', { max: MAX_MEMORY_CHARS })
    }
    await this.writeMemories([...memories, line])
    return toolText(ctx, 'tool.kb.remembered', { line, file: this.memoryFile() })
  }

  forget(text: string, ctx: Say = {}): Promise<string> {
    return this.serialized(() => this.forgetNow(text, ctx))
  }

  private async forgetNow(text: string, ctx: Say): Promise<string> {
    const memories = await this.memories()
    const wanted = normalize(text)
    let matches = memories.filter((m) => normalize(m) === wanted)
    if (matches.length === 0) matches = memories.filter((m) => normalize(m).includes(wanted))
    if (matches.length === 0) throw new ToolError('tool.kb.noMemoryMatch', { text })
    if (matches.length > 1) throw new ToolError('tool.kb.manyMemoryMatches', { count: matches.length, data: matches.map((m) => `- ${m}`).join('\n') })
    await this.writeMemories(memories.filter((m) => m !== matches[0]))
    return toolText(ctx, 'tool.kb.forgotten', { line: matches[0] })
  }

  /**
   * The dream's changes against the file as it is now, in the memory writer's turn (spec 033 BR-20). The journal is
   * written first, so no memory changes without its record; a failed journal leaves the memory file untouched.
   */
  applyDreamChanges(snapshot: string[], changes: Change[], journal: (result: ApplyResult) => Promise<void>): Promise<ApplyResult> {
    return this.serialized(async () => {
      const result = applyChanges(await this.memories(), snapshot, changes)
      await journal(result)
      if (result.applied.length) await this.writeMemories(result.lines)
      return result
    })
  }

  /** The journal folder in use: an existing one under either language's name wins (BR-16, ADR 0019). */
  journalFolder(): string {
    return this.nameInUse(DREAM_DIRS)
  }

  /**
   * Creates the night's note, or appends one more section to a file already there, changing nothing in it (AC-5.7).
   * `signal`: the dream's; aborted before the write, nothing is written (AC-1.4).
   */
  async writeJournal(date: string, firstContent: string, section: string, signal?: AbortSignal): Promise<string> {
    const path = `${this.journalFolder()}/${date}.md`
    const existing = await readFile(join(this.root, ...path.split('/')), 'utf8').catch(() => null)
    signal?.throwIfAborted()
    if (existing === null) {
      await this.write(path, firstContent)
      return path
    }
    const eol = existing.includes('\r\n') ? '\r\n' : '\n'
    const end = existing === '' || existing.endsWith('\n') ? '' : eol
    await this.write(path, `${existing}${end}${eol}${section.replace(/\r?\n/g, eol)}`)
    return path
  }

  /**
   * Creates or updates an AI knowledge note. Before creating, looks for a note that already says the same
   * (Mem0-style dedupe) and points the model at it instead of writing a duplicate.
   */
  async saveKnowledge(input: { title: string; content: string; path?: string; threadId?: string }, ctx: Say = {}): Promise<{ path: string; created: boolean; message: string }> {
    const now = new Date().toISOString()
    if (input.path) {
      const existing = await this.read(input.path)
      const { data } = splitFrontmatter(existing.content)
      if (!isOwnNote(data)) throw new ToolError('tool.kb.userNote', { path: input.path })
      // The note keeps the key it already has, in whichever language it was written.
      const updated = resolveName(this.language, namesOf('names.updatedKey'), (key) => key in data)
      await this.write(input.path, knowledgeNote(input.title, input.content, { ...data, [updated]: now }))
      return { path: input.path, created: false, message: toolText(ctx, 'tool.kb.updated', { path: input.path }) }
    }

    const vector = await this.queryVector(`${input.title}\n${input.content}`)
    if (vector) {
      const duplicate = this.db.nearest(vector, 3).find((hit) => 1 - hit.distance >= DUPLICATE_SIMILARITY && !this.isMemoryFile(hit.path))
      if (duplicate) {
        const own = this.db.file(duplicate.path)?.origin === 'ia'
        return {
          path: duplicate.path,
          created: false,
          message: toolText(ctx, own ? 'tool.kb.duplicateOwn' : 'tool.kb.duplicateUser', { path: duplicate.path, similarity: (1 - duplicate.distance).toFixed(2) })
        }
      }
    }

    const base = `${this.knowledgeDir()}/${slugify(input.title)}`
    let path = `${base}.md`
    for (let n = 2; existsSync(join(this.root, ...path.split('/'))); n++) path = `${base}-${n}.md`
    await this.write(path, knowledgeNote(input.title, input.content, this.newNoteData(now, input.threadId)))
    return { path, created: true, message: toolText(ctx, 'tool.kb.saved', { path }) }
  }

  /** The frontmatter of a note Alma writes now, in the current language. */
  private newNoteData(now: string, threadId?: string): Record<string, string> {
    const text = (key: NameKey): string => namesOf(key)[this.language]
    return {
      [text('names.originKey')]: text('names.originValue'),
      [text('names.typeKey')]: text('names.typeValue'),
      [text('names.createdKey')]: now,
      [text('names.updatedKey')]: now,
      ...(threadId ? { [text('names.conversationKey')]: threadId } : {})
    }
  }

  async overview(): Promise<KnowledgeOverview> {
    const notes = this.db.knowledgeFiles(`${this.knowledgeDir()}/`).map((row) => ({ path: row.path, title: row.title, mtime: row.mtime }))
    return { memories: await this.memories(), memoryFile: this.memoryFile(), notes }
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
