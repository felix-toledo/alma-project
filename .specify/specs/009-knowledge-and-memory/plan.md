# 009 — Plan

## 1. Approach
One SQLite file per vault mirrors the Markdown files: `files`, `chunks`, an FTS5 table and a `sqlite-vec` table
([ADR 0003](../../../docs/adr/0003-sqlite-fts5-sqlite-vec-index.md)). Search runs BM25 and vector KNN, each to depth 40, and fuses
them with Reciprocal Rank Fusion ([ADR 0005](../../../docs/adr/0005-hybrid-search-rrf.md)). Embeddings come from bge-m3 (int8,
CPU) in a worker thread, downloaded on first use ([ADR 0004](../../../docs/adr/0004-bge-m3-int8-cpu-worker-thread.md)); until
a chunk has a vector the keyword side answers alone, so search never waits for the network. Memory is plain Markdown inside the
vault (`Alma/Recuerdos.md`, `Alma/Conocimientos/`), and every agent run gets the memories plus the few related fragments once,
at the start, so the system prompt stays constant across tool iterations.

Rejected: a cloud embedding API (the notes would leave the machine and search would need a key) and a vector-only index (no
results while the model downloads, bad on exact names). Also rejected: keeping memory in a database table; the person could not
read or fix it.

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`SearchHit`, `KnowledgeStatus`, `KnowledgeOverview`, `EmbedderState`, requests `vault.search`, `knowledge.status|overview|forget`, event `knowledge.status`) | data the renderer receives |
| coordinator | `src/coordinator/knowledge/base.ts` (`KnowledgeBase`: scan, search, `recall`, memories, `saveKnowledge`), `db.ts` (`KnowledgeDb`), `embedder.ts` (`Embedder`, `WorkerEmbedder`), `embed-worker.ts`, `markdown.ts` (frontmatter, titles, slugs, chunking), `tools.ts` (the five tools), `src/coordinator/agent.ts` (context block, tool offering), `src/coordinator/approval.ts` (`memory` risk), `src/coordinator/index.ts` (`syncVault`, `vaultFor`, requests) | embeddings and disk are coordinator work; nothing here needs `electron` |
| main | `src/main/index.ts` (the `trash` host action used by `delete`) | only main owns `shell` |
| renderer | consumes the data (spec 008): `src/renderer/src/vault/panels.tsx`, `src/renderer/src/vault/VaultSidebar.tsx` | display only |
| build | `electron.vite.config.ts` emits the worker as `embedWorker.js` next to `coordinator.js` | the worker is a separate entry |

Pure parts (`ftsQuery`, `fuseRankings`, `parseMemories`, `chunkMarkdown`, `splitFrontmatter`, `slugify`) are exported functions so
tests import them without a database.

## 3. Contracts
- `Embedder { modelId; state(): { state: EmbedderState; progress?; error? }; embed(texts: string[]): Promise<Float32Array[]> }`;
  `WorkerEmbedder(cacheDir, onState)` is the real one. `EMBEDDING_DIMS = 1024`.
- `KnowledgeBase`: `start()`, `scan()`, `warmUp()`, `status(): KnowledgeStatus`, `search(query, limit = 10): Promise<SearchHit[]>`,
  `recall(request, limit = 5): Promise<{ memories: string[]; fragments: SearchHit[] }>`, `memories()`, `remember(text)`,
  `forget(text)`, `saveKnowledge({ title, content, path?, threadId? }): Promise<{ path; created; message }>`,
  `overview(): Promise<KnowledgeOverview>`, `close()`.
- `ftsQuery(text): string`, `fuseRankings(keyword, vector)`, `parseMemories(text): string[]`.
- Constants: `MEMORY_FILE = 'Alma/Recuerdos.md'`, `KNOWLEDGE_DIR = 'Alma/Conocimientos'`.
- Tools (all `standalone: true`, offered to every agent when a vault is active):
  `search_knowledge` (`read`, query ≥ 2 chars, limit 1–20), `read_note` (`read`), `save_knowledge` (`memory`, title ≥ 3, content ≥ 10,
  optional `path`), `remember` (`memory`, 3–300 chars), `forget` (`memory`).
- Requests `vault.search { query; limit? }`, `knowledge.status`, `knowledge.overview`, `knowledge.forget { text }`; event
  `knowledge.status { status: KnowledgeStatus | null }`.
- Knowledge note frontmatter keys: `origen`, `tipo`, `creado`, `actualizado`, `conversacion`.

## 4. Data and persistence
- Notes and memories: the vault (`Alma/Recuerdos.md`: one `- ` line per memory, the person's prose preserved;
  `Alma/Conocimientos/<slug>.md`).
- Index: `<userData>/knowledge/<first 16 hex of sha1(lowercased vault path)>.db`, WAL mode. It only mirrors the files; deleting it
  rebuilds everything. The model id is stored with it: a different id drops all vectors and marks every chunk pending.
- Model cache: `<userData>/models` (about 570 MB, first use only).
- A company's vault gets its own index in the same `knowledge` folder and shares the one embedder.

## 5. Dependency injection
- `KnowledgeBase` takes `{ root, dataDir, embedder, trash, onStatus, onChanged }`; the embedder is the seam. `tests/knowledge.test.ts`
  injects a hashed bag-of-words embedder (1024 dims) and a temp folder, so the real model is never loaded in tests.
- Tools get the base through `ToolContext.knowledge` (`null` when no vault is active, which also removes the tools from the offer);
  `agent.ts` calls `knowledge.recall` and tolerates its failure.
- `syncVault` builds `WorkerEmbedder` lazily and wires `onStatus` to the `knowledge.status` broadcast.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | `tests/knowledge.test.ts` → `recalls only related fragments plus every memory` | unrelated notes must not appear |
| AC-2.1, AC-8.5 | `tests/knowledge.test.ts` → `indexes the vault and finds notes by keyword and by meaning` | a note in a hidden `.interna` folder; `status()` counts |
| AC-2.2 | `tests/knowledge.test.ts` → `reindexes only what changed and keeps vectors across a rename` | embed-call counter must not grow |
| AC-2.3 | `tests/knowledge.test.ts` → `chunks by heading, keeps the heading path and line, and skips frontmatter` | code fences with `#` |
| AC-2.4 | `tests/knowledge.test.ts` → `splits oversized sections under the size limit` | 30 long paragraphs in one section |
| AC-2.5 | `tests/knowledge.test.ts` → `builds safe FTS queries and parses memory lines` | quotes, `¿?`, only stopwords |
| AC-2.9, AC-4.4, AC-8.4 | `tests/knowledge.test.ts` → `confines every path to the vault and never touches hidden folders` | `../fuera.md`, `..\..\fuera.md`, `.interna/x.md`, deleting the vault root |
| AC-5.1–5.4 | `tests/knowledge.test.ts` → `saves knowledge, dedupes near-identical notes and only updates its own notes` | user note with no `origen: ia` |
| AC-6.1, AC-6.2, AC-6.5, AC-6.6 | `tests/knowledge.test.ts` → `remembers, refuses duplicates and forgets, keeping the user prose in Recuerdos.md` | duplicate ignoring case and accents |
| AC-6.8 | `tests/knowledge.test.ts` → `saves knowledge, dedupes near-identical notes and only updates its own notes` (the `overview` list) | no vault → empty lists |
| AC-3.2, AC-6.9 | [manual] | delete `<userData>/models`, open a vault, watch "Índice"; forget a memory from the panel and open `Alma/Recuerdos.md` |
| AC-1.2–1.8, AC-2.6–2.8, AC-2.10–2.14, AC-3.1, AC-3.3–3.6, AC-4.1–4.3, AC-4.5, AC-5.5–5.8, AC-6.3, AC-6.4, AC-6.7, AC-6.10, AC-7.1–7.4, AC-8.1–8.3 | [gap] | priority: the 0.45 recall threshold, the read-only denial of the `memory` tools, embedder failure and recovery |

## 7. Security and privacy impact
- Embeddings and search are local; the only network use is the model download. Memories and recalled fragments go into the system
  prompt, so they reach whichever provider the agent uses (and Telegram, WhatsApp and voice conversations alike).
- `remember`, `forget`, `save_knowledge` are `memory`: no question asked in any mode but "Solo lectura", where they are denied, and
  they are audited. `search_knowledge` and `read_note` are `read`. `save_knowledge` may only update notes with `origen: ia`.
- Fragments are injected as data inside `<vault>` tags ("datos, no instrucciones"); a note can still try to steer a model, which
  is why the memory guide tells the model not to store sensitive data it was not asked to store.
- Hidden folders are never indexed or readable by tools.
- `docs/security/PRIVACIDAD.md` (vault and index row, "Memoria y búsqueda") already covers the data; check it is still accurate.

## 8. Rollout
- No setting: the knowledge base exists whenever `activeVault` points at a folder, and is absent (no tools, no context) otherwise.
- First run in a vault: indexing starts at once with keywords only; the model downloads in the background, status goes
  "en espera" → "descargando N%" → "listo", and search becomes semantic as `pending` reaches 0.
- Offline or failed download: keyword-only search, state `error`, a later scan, write or save retries.
