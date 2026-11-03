import { DatabaseSync } from 'node:sqlite'
import { load as loadSqliteVec } from 'sqlite-vec'
import type { Chunk } from './markdown'

export const EMBEDDING_DIMS = 1024

export interface FileRow {
  path: string
  mtime: number
  size: number
  hash: string
  title: string
  origin: string
}

export interface ChunkHit {
  id: number
  path: string
  heading: string
  body: string
  line: number
}

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists files (
  path text primary key, mtime integer not null, size integer not null, hash text not null,
  title text not null, origin text not null default ''
);
create table if not exists chunks (
  id integer primary key, path text not null, heading text not null, body text not null,
  line integer not null, embedded integer not null default 0
);
create index if not exists chunks_path on chunks(path);
create index if not exists chunks_pending on chunks(embedded) where embedded = 0;
create virtual table if not exists chunks_fts using fts5(body, heading, tokenize = 'unicode61 remove_diacritics 2');
create virtual table if not exists chunks_vec using vec0(embedding float[${EMBEDDING_DIMS}] distance_metric=cosine);
`

/**
 * The vault's search index: one SQLite file with FTS5 (BM25) and sqlite-vec (cosine KNN).
 * It only mirrors the .md files, so deleting it just means a full reindex.
 */
export class KnowledgeDb {
  private db: DatabaseSync

  constructor(file: string, modelId: string) {
    this.db = new DatabaseSync(file, { allowExtension: true })
    loadSqliteVec(this.db)
    this.db.exec('pragma journal_mode = wal; pragma synchronous = normal;')
    this.db.exec(SCHEMA)
    // Vectors from another model live in another space: drop them and re-embed.
    const stored = this.db.prepare(`select value from meta where key = 'model'`).get() as { value: string } | undefined
    if (stored && stored.value !== modelId) {
      this.db.exec('delete from chunks_vec; update chunks set embedded = 0;')
    }
    this.db.prepare(`insert or replace into meta(key, value) values ('model', ?)`).run(modelId)
  }

  files(): Map<string, FileRow> {
    const rows = this.db.prepare('select * from files').all() as unknown as FileRow[]
    return new Map(rows.map((row) => [row.path, row]))
  }

  file(path: string): FileRow | undefined {
    return this.db.prepare('select * from files where path = ?').get(path) as FileRow | undefined
  }

  touch(path: string, mtime: number, size: number): void {
    this.db.prepare('update files set mtime = ?, size = ? where path = ?').run(mtime, size, path)
  }

  /** Replaces a file's chunks in one transaction; the new chunks wait for embedding. */
  replaceFile(row: FileRow, chunks: Chunk[]): void {
    this.transaction(() => {
      this.deleteChunks(row.path)
      this.db
        .prepare('insert or replace into files(path, mtime, size, hash, title, origin) values (?, ?, ?, ?, ?, ?)')
        .run(row.path, row.mtime, row.size, row.hash, row.title, row.origin)
      const insert = this.db.prepare('insert into chunks(path, heading, body, line) values (?, ?, ?, ?)')
      const fts = this.db.prepare('insert into chunks_fts(rowid, body, heading) values (?, ?, ?)')
      for (const chunk of chunks) {
        const { lastInsertRowid } = insert.run(row.path, chunk.heading, chunk.body, chunk.line)
        fts.run(lastInsertRowid, chunk.body, chunk.heading)
      }
    })
  }

  removeFile(path: string): void {
    this.transaction(() => {
      this.deleteChunks(path)
      this.db.prepare('delete from files where path = ?').run(path)
    })
  }

  /** Moves a file's rows when it was renamed without changing its content: no re-embedding needed. */
  renameFile(from: string, to: string): void {
    this.transaction(() => {
      this.db.prepare('delete from files where path = ?').run(to)
      this.db.prepare('update files set path = ? where path = ?').run(to, from)
      this.db.prepare('update chunks set path = ? where path = ?').run(to, from)
    })
  }

  private deleteChunks(path: string): void {
    const ids = this.db.prepare('select id from chunks where path = ?').all(path) as { id: number }[]
    const fts = this.db.prepare('delete from chunks_fts where rowid = ?')
    const vec = this.db.prepare('delete from chunks_vec where rowid = ?')
    for (const { id } of ids) {
      fts.run(id)
      vec.run(BigInt(id))
    }
    this.db.prepare('delete from chunks where path = ?').run(path)
  }

  /** Similar lengths together: a batch is padded to its longest text, so mixed lengths waste most of the compute. */
  pending(limit: number): ChunkHit[] {
    return this.db
      .prepare('select id, path, heading, body, line from chunks where embedded = 0 order by length(body) limit ?')
      .all(limit) as unknown as ChunkHit[]
  }

  storeEmbeddings(rows: { id: number; vector: Float32Array }[]): void {
    this.transaction(() => {
      const insert = this.db.prepare('insert or replace into chunks_vec(rowid, embedding) values (?, ?)')
      // The chunk may have been replaced while it was being embedded; then its id is gone and nothing is marked.
      const mark = this.db.prepare('update chunks set embedded = 1 where id = ?')
      for (const row of rows) {
        if (mark.run(row.id).changes) insert.run(BigInt(row.id), row.vector)
      }
    })
  }

  counts(): { files: number; chunks: number; pending: number } {
    const row = this.db
      .prepare('select (select count(*) from files) files, (select count(*) from chunks) chunks, (select count(*) from chunks where embedded = 0) pending')
      .get() as { files: number; chunks: number; pending: number }
    return { files: Number(row.files), chunks: Number(row.chunks), pending: Number(row.pending) }
  }

  /** BM25 over chunk text and headings. `match` is an FTS5 expression. */
  keyword(match: string, limit: number): ChunkHit[] {
    return this.db
      .prepare(
        `select c.id, c.path, c.heading, c.body, c.line from chunks_fts f join chunks c on c.id = f.rowid
         where chunks_fts match ? order by bm25(chunks_fts, 1.0, 2.0) limit ?`
      )
      .all(match, limit) as unknown as ChunkHit[]
  }

  /** Nearest chunks by cosine distance (0 = same direction). */
  nearest(vector: Float32Array, limit: number): (ChunkHit & { distance: number })[] {
    return this.db
      .prepare(
        `select c.id, c.path, c.heading, c.body, c.line, v.distance from
           (select rowid, distance from chunks_vec where embedding match ? and k = ?) v
         join chunks c on c.id = v.rowid order by v.distance`
      )
      .all(vector, limit) as unknown as (ChunkHit & { distance: number })[]
  }

  knowledgeFiles(prefix: string): FileRow[] {
    return this.db.prepare(`select * from files where path like ? escape '\\' order by mtime desc`).all(`${likeEscape(prefix)}%`) as unknown as FileRow[]
  }

  private transaction(work: () => void): void {
    this.db.exec('begin')
    try {
      work()
      this.db.exec('commit')
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}
