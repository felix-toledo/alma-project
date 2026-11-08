---
status: implemented
---

# 009 — Conocimiento y memoria

## 1. Summary
Alma keeps a local search index over the active vault (a folder of Markdown notes) and a small, always-on memory of the person. Every message a person sends to an agent automatically receives the contents of `Alma/Recuerdos.md` plus the few vault fragments most related to the request. Agents can also search the vault (`search_knowledge`), read a note (`read_note`), write durable knowledge notes under `Alma/Conocimientos/` (`save_knowledge`), and keep or drop one-line memories about the person (`remember`, `forget`). Search combines keyword ranking (BM25) with meaning (bge-m3 vectors) and works from the first second with keywords only while the embedding model downloads or if it fails.

## 2. Problem and goal
An agent that starts every conversation blank forces the person to repeat who they are, what they prefer and what they already wrote down. The goal: the person's own notes become retrievable by meaning and by words, what Alma learns is stored as plain Markdown the person can open in any Markdown editor, edit or delete, and nothing about this needs a cloud service (indexing and embeddings run on the machine; only the one-time model download uses the network).

## 3. Scope
**In:**
- The search index (SQLite via `node:sqlite`, FTS5, `sqlite-vec`): schema, where it lives, when files are (re)indexed, rename detection, model change.
- The embedder: bge-m3 int8 on CPU in a worker thread, first-use download, cache location, states, failure/offline behavior.
- Markdown parsing: frontmatter, titles, slugs, chunking.
- Hybrid search (BM25 + vectors fused with RRF) and the `vault.search` request that exposes it.
- Automatic context for every agent run (`Alma/Recuerdos.md` + related fragments + the memory guide in the system prompt).
- Agent tools `search_knowledge`, `read_note`, `save_knowledge`, `remember`, `forget`: inputs, outputs, risk class, files written, what read-only mode blocks.
- "What Alma knows" data: `knowledge.status`, `knowledge.overview`, `knowledge.forget`, and the `knowledge.status` broadcast.
- Opening and closing a `KnowledgeBase` for the active vault and for a company's vault.

**Out (and why):**
- The vault UI: tree, editor, tabs, shortcuts, search panel, the "Lo que sabe Alma" panel layout, welcome screen, drag/rename UI. Owned by `../008-vault/spec.md`. This spec only owns the data those screens receive (`KnowledgeStatus`, `KnowledgeOverview`, `SearchHit`) and the file operations behind `vault.read/write/create/rename/delete` only where they affect the index (§5 US-2).
- `excalidraw_read` / `excalidraw_draw` live in the same source file (`src/coordinator/knowledge/tools.ts`) and are offered together with the knowledge tools, but they belong to `../021-office-documents-and-drawings/spec.md`.
- Approval modes and the approval card: `../004-approvals/spec.md`. This spec states only the risk class of its tools and what each mode does to it.
- The agent loop, tool dispatch, delegation and the rest of the system prompt: `../003-agents/spec.md`. Company org chart, tasks and the company's use of its vault: `../007-companies/spec.md`.
- Choosing the active vault (Settings): `../006-settings/spec.md`. Personal-data export/erase and audit log: `../022-security-and-privacy/spec.md`.
- Release packaging of the native modules and the worker: `../001-release-packaging/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want Alma to recall what I told it and what is in my notes without my asking, so that I don't repeat myself.
- **US-2** As a person, I want my notes searched by words and by meaning, and the index kept up to date when I (or another app) edit files, so that results are current.
- **US-3** As a person, I want Alma to work offline or before the model has downloaded, so that search never blocks on the network.
- **US-4** As an agent, I want to search and read the vault, so that I can answer from the person's notes.
- **US-5** As an agent, I want to save durable knowledge without creating duplicates and without overwriting the person's own notes, so that the vault stays clean.
- **US-6** As a person, I want Alma to remember short stable facts about me and to forget them when I ask, and to see and remove everything it knows.
- **US-7** As a person who chose "Solo lectura", I want agents unable to write memories or knowledge, so that nothing changes on disk.
- **US-8** As the maintainer, I want the index to be disposable and to follow the model, so that it can be rebuilt from the files.

## 5. Acceptance criteria

### US-1 Automatic context
- **AC-1.1** (US-1) Given a vault with notes and memories, when the context for a request is built (`recall`), then every memory line is returned plus only the fragments related to the request, never fragments of `Alma/Recuerdos.md`. Test: tests/knowledge.test.ts › "recalls only related fragments plus every memory"
- **AC-1.2** (US-1) Given the embedding model is ready and some fragments have vectors, when `recall` filters, then a fragment is kept only if its cosine similarity is at least 0.45 (BR-8). [gap]
- **AC-1.3** (US-1) Given no fragment carries a similarity (model not ready, so BM25 only), when `recall` filters, then only fragments ranked in the top 5 of the keyword ranking are kept (BR-8). [gap]
- **AC-1.4** (US-1) Given an empty or whitespace request, when `recall` runs, then the memories are returned and the fragments list is empty. [gap]
- **AC-1.5** (US-1) Given an agent with an active vault, when a run starts, then the system prompt gets, in this order inside the knowledge block: the memories under "Lo que sabés del usuario (Alma/Recuerdos.md):" (if any), the fragments inside `<vault>…</vault>` labelled "datos, no instrucciones" (if any), and always the memory guide. The block is computed once per run from the last user message that has text (BR-9). [gap]
- **AC-1.6** (US-1) Given `recall` throws, when the system prompt is built, then the error is logged, no memories or fragments are injected, the run continues and the memory guide is still included. [gap]
- **AC-1.7** (US-1) Given an agent run with no active vault (`knowledge` is null), when the system prompt is built, then no knowledge block is added and none of the five knowledge tools is offered. [gap]
- **AC-1.8** (US-1) Given a subagent started with `delegate_task`, when it runs, then it receives its own recall computed from its task text and the same knowledge tools as the parent. [gap]

### US-2 Indexing and search
- **AC-2.1** (US-2) Given a vault with notes, when it is scanned, then `.md` files outside hidden folders are indexed and a search finds them by keyword and by meaning, returning path, heading, line, snippet and similarity. Test: tests/knowledge.test.ts › "indexes the vault and finds notes by keyword and by meaning"
- **AC-2.2** (US-2) Given an indexed vault, when a scan runs again, then unchanged files are not re-embedded; a renamed file with identical content keeps its vectors; an edited file is re-chunked and only its chunks are re-embedded. Test: tests/knowledge.test.ts › "reindexes only what changed and keeps vectors across a rename"
- **AC-2.3** (US-2) Given a heading-structured note, when it is chunked, then each chunk carries the heading path joined with " › ", its 1-based start line, and code fences do not start new sections; frontmatter is skipped. Test: tests/knowledge.test.ts › "chunks by heading, keeps the heading path and line, and skips frontmatter"
- **AC-2.4** (US-2) Given a section longer than 1600 characters, when it is chunked, then it is split at paragraph and then sentence boundaries into chunks of at most 1600 characters. Test: tests/knowledge.test.ts › "splits oversized sections under the size limit"
- **AC-2.5** (US-2) Given a free-text query, when it is turned into an FTS5 expression, then words of two or more letters or digits, without stopwords, are quoted as prefixes and OR-ed (at most 24); a query of only stopwords yields an empty expression. Test: tests/knowledge.test.ts › "builds safe FTS queries and parses memory lines"
- **AC-2.6** (US-2) Given a query made only of stopwords, when `search` runs with vectors available, then results come from the vector side alone; with no vectors the result is empty. [gap]
- **AC-2.7** (US-2) Given one note matches with many chunks, when results are returned, then at most 2 fragments per file appear, at most `limit` (default 10 for `vault.search`) in total, and each snippet is cut at 400 characters followed by "…". [gap]
- **AC-2.8** (US-2) Given a file is edited or created in the vault folder by any program, when the change is seen by the folder watcher, then a scan runs after a 400 ms quiet period and the changes are indexed; changes inside folders whose name starts with "." are ignored. [gap]
- **AC-2.9** (US-2) Given a file is deleted from disk, when the next scan runs, then its file row, chunks, FTS rows and vectors are removed. Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders" (covers the deletion through `delete`, which scans)
- **AC-2.10** (US-2) Given a `.md` file larger than 5 MiB, when it is scanned, then it is skipped (not indexed) and `read` refuses it with "demasiado grande". [gap]
- **AC-2.11** (US-2) Given a scan is requested while one is running, when the first ends, then exactly one more scan runs (requests coalesce). [gap]
- **AC-2.12** (US-2) Given chunks waiting for vectors, when the background pump runs, then it embeds them 8 at a time, shortest text first, and search keeps working with BM25 meanwhile. [gap]
- **AC-2.13** (US-2) Given a chunk is replaced while it is being embedded, when the vector arrives, then it is discarded and the new chunk stays pending. [gap]
- **AC-2.14** (US-2) Given a file is written through `write` (editor or tool), when it is a `.md`, then it is indexed immediately without waiting for the watcher. [gap]

### US-3 Model, offline and failure
- **AC-3.1** (US-3) Given the model state is not `ready` or `loading` (idle, downloading, error), when a search or recall runs, then no query vector is computed and results are keyword-only; a search never waits for a download. [gap]
- **AC-3.2** (US-3) Given the model is not in the cache, when the first text is embedded, then the worker reports `loading`, then `downloading` with an integer percent for the `.onnx` file, then `ready`; each state change is broadcast as `knowledge.status`. [manual] Delete the `models` folder under the app's user-data directory, open a vault, and watch "Lo que sabe Alma › Índice" go from "en espera" to "descargando N%" to "listo".
- **AC-3.3** (US-3) Given there is no network and no cached model, when embedding is attempted, then the state becomes `error` with the message, pending chunks stay pending, search still answers from BM25, and the next embedding attempt (a later scan, write or save) tries to load the model again (a new worker if it had exited); no automatic retry timer exists. [gap]
- **AC-3.4** (US-3) Given the embedding worker crashes or exits, when requests are waiting, then all of them are rejected with the error, the state becomes `error` and the worker is recreated on the next request. [gap]
- **AC-3.5** (US-3) Given the active vault already has vectors and the model is `idle`, when the vault is opened, then the model is loaded in the background ahead of the first query. [gap]
- **AC-3.6** (US-3) Given the index was created with another model id, when the index opens, then all vectors are dropped and every chunk is marked pending again. [gap]

### US-4 Search and read tools
- **AC-4.1** (US-4) Given an active vault, when `search_knowledge` runs, then it returns numbered results as `[n] path:line › heading (similitud 0.xx)` followed by the snippet, or "Sin resultados en el vault." when empty. [gap]
- **AC-4.2** (US-4) Given `search_knowledge` input with a query shorter than 2 characters or a limit outside 1–20, when the call is validated, then it is rejected before running. [gap]
- **AC-4.3** (US-4) Given no active vault, when any knowledge tool runs, then the call fails with "No hay un vault activo. Pedile al usuario que abra uno en la vista Vault." [gap]
- **AC-4.4** (US-4) Given a vault-relative path, when `read_note` runs, then the whole note is returned (middle-truncated beyond 60 000 characters); a missing file, a directory, a path outside the vault and a path inside a hidden folder are refused. Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders" (covers only the outside-the-vault refusal on read); the rest, and the 60 000-character truncation, [gap]
- **AC-4.5** (US-4) Given an agent and a vault, when the tools are offered, then all five knowledge tools are available to every agent whatever its profile lists, and need no working folder. [gap]

### US-5 save_knowledge
- **AC-5.1** (US-5) Given a title and content, when `save_knowledge` runs, then a note is created at `Alma/Conocimientos/<slug>.md` with frontmatter `origen: ia`, `tipo: conocimiento`, `creado`, `actualizado` and, when known, `conversacion: <thread id>`, followed by `# <title>` and the content. Test: tests/knowledge.test.ts › "saves knowledge, dedupes near-identical notes and only updates its own notes"
- **AC-5.2** (US-5) Given an existing note says almost the same (cosine similarity at least 0.9 among the 3 nearest, ignoring `Alma/Recuerdos.md`), when `save_knowledge` runs without `path`, then nothing is written and the message names the existing note (suggesting an update when it is Alma's own, or saying the user's note already covers it). Test: tests/knowledge.test.ts › "saves knowledge, dedupes near-identical notes and only updates its own notes"
- **AC-5.3** (US-5) Given `path` of a note with `origen: ia`, when `save_knowledge` runs, then the note is rewritten with the new title and content, previous frontmatter kept and `actualizado` refreshed. Test: tests/knowledge.test.ts › "saves knowledge, dedupes near-identical notes and only updates its own notes"
- **AC-5.4** (US-5) Given `path` of a note without `origen: ia`, when `save_knowledge` runs, then it fails with "es una nota del usuario; solo se pueden actualizar notas creadas por Alma." and the file is unchanged. Test: tests/knowledge.test.ts › "saves knowledge, dedupes near-identical notes and only updates its own notes"
- **AC-5.5** (US-5) Given a slug already taken, when a new note is created, then `-2`, `-3`… is appended; a title with no usable characters yields the slug `nota`; slugs drop accents and are at most 80 characters. [gap]
- **AC-5.6** (US-5) Given the model is not ready, when `save_knowledge` runs without `path`, then the duplicate check is skipped and the note is created. [gap]
- **AC-5.7** (US-5) Given `title` shorter than 3 or `content` shorter than 10 characters, when the call is validated, then it is rejected. [gap]
- **AC-5.8** (US-5) Given `path` that does not exist, when `save_knowledge` runs, then it fails with "No existe la nota …". [gap]

### US-6 remember, forget, what Alma knows
- **AC-6.1** (US-6) Given a text, when `remember` runs, then it is stored as one `- ` line in `Alma/Recuerdos.md` (created with a header on first use) and the answer is "Recordado: «…» (en Alma/Recuerdos.md).". Test: tests/knowledge.test.ts › "remembers, refuses duplicates and forgets, keeping the user prose in Recuerdos.md"
- **AC-6.2** (US-6) Given a memory that matches an existing one ignoring case, accents and spacing, when `remember` runs, then nothing is written and the answer is "Ya lo recordaba: «…».". Test: tests/knowledge.test.ts › "remembers, refuses duplicates and forgets, keeping the user prose in Recuerdos.md"
- **AC-6.3** (US-6) Given the memories plus the new line would exceed 4000 characters, when `remember` runs, then it fails with "La memoria está llena (4000 caracteres)…" pointing at `forget` and `save_knowledge`. [gap]
- **AC-6.4** (US-6) Given empty or whitespace text, when `remember` runs, then it fails with "El recuerdo está vacío."; schema also requires 3–300 characters. [gap]
- **AC-6.5** (US-6) Given a text that equals one memory (normalized) or is contained in exactly one, when `forget` runs, then that line is removed and the answer is "Olvidado: «…».", preserving the prose the person wrote in the file. Test: tests/knowledge.test.ts › "remembers, refuses duplicates and forgets, keeping the user prose in Recuerdos.md"
- **AC-6.6** (US-6) Given a text that matches no memory, when `forget` runs, then it fails with "No hay ningún recuerdo que coincida con «…»". Test: tests/knowledge.test.ts › "remembers, refuses duplicates and forgets, keeping the user prose in Recuerdos.md"
- **AC-6.7** (US-6) Given a text that is contained in several memories and equals none, when `forget` runs, then it fails listing them and asking for the exact text; nothing is removed. [gap]
- **AC-6.8** (US-6) Given a vault, when `knowledge.overview` is requested, then it returns the memory lines and the indexed notes under `Alma/Conocimientos/`, newest first by modification time, each with path, title and mtime; with no vault it returns empty lists. Test: tests/knowledge.test.ts › "saves knowledge, dedupes near-identical notes and only updates its own notes" (the `overview` notes list)
- **AC-6.9** (US-6) Given the "Lo que sabe Alma" screen, when the person presses the trash icon of a memory, then `knowledge.forget` with that exact line removes it; with no active vault the request fails with "No hay un vault abierto.". [manual] Open Vault › "Lo que sabe Alma", forget a memory and check `Alma/Recuerdos.md`.
- **AC-6.10** (US-6) Given the person edits `Alma/Recuerdos.md` by hand, when the next message is sent, then the edited bullet lines are what is injected (the file is read on every recall). [gap]

### US-7 Read-only mode
- **AC-7.1** (US-7) Given approval mode "Solo lectura" (`blocked`), when an agent calls `remember`, `forget` or `save_knowledge`, then the call is denied with "Bloqueado por el modo de aprobación", nothing is written, and the model is told not to retry. [gap]
- **AC-7.2** (US-7) Given any approval mode other than `blocked`, when an agent calls `remember`, `forget` or `save_knowledge`, then it runs without asking, noted "Memoria de Alma", even in "ask" mode. [gap]
- **AC-7.3** (US-7) Given any approval mode including `blocked`, when an agent calls `search_knowledge` or `read_note`, then it runs without asking ("Solo lectura"). [gap]
- **AC-7.4** (US-7) Given a memory-tool call (allowed or denied), when it finishes, then it is recorded in the audit trail with risk `memory`; read tools are not. [gap]

### US-8 Index lifecycle
- **AC-8.1** (US-8) Given settings change to another vault folder, when the coordinator syncs, then the previous `KnowledgeBase` is closed, a new one opens for the new folder, and `knowledge.status` and `vault.changed` are broadcast; a folder that does not exist leaves no knowledge base and a `null` status. [gap]
- **AC-8.2** (US-8) Given the index file is deleted, when the vault is opened, then everything is re-indexed and re-embedded from the files. [gap]
- **AC-8.3** (US-8) Given a company has a vault folder, when a company agent runs, then its knowledge base is that vault's (created on first use, own `Alma/` memories and notes), not the person's active vault. [gap]
- **AC-8.4** (US-8) Given a vault path or note path from the renderer or a model, when it is resolved, then it is confined to the vault root and hidden (dot) folders are refused. Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders"
- **AC-8.5** (US-8) Given status changes (scan start/end, each embedded batch, model state), when they happen, then `knowledge.status` carries `vault`, `scanning`, `files`, `chunks`, `pending` and `model` to the renderer; the request `knowledge.status` returns the same shape or `null`. Test: tests/knowledge.test.ts › "indexes the vault and finds notes by keyword and by meaning" (the `status()` counts)

## 6. Business rules
- **BR-1** Memory lives in `Alma/Recuerdos.md`; the app's knowledge notes live in `Alma/Conocimientos/`; both are plain Markdown inside the vault. These are the `es` names: a new file takes the name of the current `language`, and if a file or folder already exists under either language's name that one is used, never renamed or duplicated; the frontmatter key `origen: ia` is recognized under either language's key (spec 025 BR-23). The text Alma writes into them uses the language in effect when it writes. The knowledge block added to the system prompt (heading "Lo que sabés del usuario (Alma/Recuerdos.md):" and the memory guide) and the results of `remember`, `forget` and `save_knowledge` are English (spec 025 BR-17); the Spanish quotes in the ACs of this spec are the previous wording. (src/coordinator/knowledge/base.ts)
- **BR-2** A memory is any Markdown bullet line (`-` or `*`, optionally indented) of `Alma/Recuerdos.md`; every other line is the person's prose and is preserved on rewrite. (src/coordinator/knowledge/base.ts `parseMemories`, `writeMemories`)
- **BR-3** All memories together may not exceed 4000 characters when added with `remember`; the check counts line lengths only. (src/coordinator/knowledge/base.ts `MAX_MEMORY_CHARS`)
- **BR-4** `remember` input is 3–300 characters; whitespace is collapsed to single spaces. `forget` input is at least 2 characters. (src/coordinator/knowledge/tools.ts, base.ts)
- **BR-5** Memory comparison ignores case, accents and repeated spaces. `forget` prefers an exact match, otherwise a unique substring match. (src/coordinator/knowledge/base.ts `normalize`)
- **BR-6** Chunks are at most 1600 characters; a chunk under 200 characters is merged into the next one when the sum stays at or under 1600. Only `.md` files are indexed; files over 5 MiB, dot-prefixed files and folders and `node_modules` are skipped. (src/coordinator/knowledge/markdown.ts, base.ts `MAX_NOTE_BYTES`)
- **BR-7** Search runs BM25 (heading weighted 2.0, body 1.0, FTS5 `unicode61 remove_diacritics 2`) and cosine KNN, each to depth 40, fused by Reciprocal Rank Fusion with constant 60, max 2 fragments per file. `vault.search` default limit 10; `search_knowledge` default 8, range 1–20. (src/coordinator/knowledge/base.ts, tools.ts)
- **BR-8** Automatic recall: depth 30, up to 5 fragments, 2 per file, `Alma/Recuerdos.md` excluded. When any fused hit has a vector similarity, a fragment needs similarity at least 0.45; otherwise it must be in the top 5 keyword hits. (src/coordinator/knowledge/base.ts `RECALL_MIN_SIMILARITY`)
- **BR-9** Context is retrieved once per `runAgent` call from the last user message with text, so the system prompt stays constant across tool iterations (prompt cache). All memories are injected with no cap other than BR-3. (src/coordinator/agent.ts)
- **BR-10** `save_knowledge` considers a note a duplicate at cosine similarity 0.9 or more, among the 3 nearest chunks, excluding `Alma/Recuerdos.md`. Only notes with `origen: ia` can be updated by the tool. (src/coordinator/knowledge/base.ts `DUPLICATE_SIMILARITY`)
- **BR-11** The embedding model is `Xenova/bge-m3`, int8-quantized, CPU, 1024 dimensions, normalized CLS vector; the model id kept in the index is the model name plus its quantization suffix; download about 570 MB on first use; cached under `<userData>/models`; remote models only (`allowLocalModels` off); intra-op threads = half of the logical CPUs (minimum 1). (src/coordinator/knowledge/embedder.ts, embed-worker.ts, db.ts)
- **BR-12** The index is one SQLite file per vault at `<userData>/knowledge/<first 16 hex of sha1(lowercased vault path)>.db`, WAL mode; it only mirrors the files and may be deleted. (src/coordinator/knowledge/base.ts, db.ts)
- **BR-13** Embedded text of a chunk is note title, heading path and body joined by newlines; vectors are computed 8 chunks per batch. (src/coordinator/knowledge/base.ts `EMBED_BATCH`)
- **BR-14** The folder watcher debounces 400 ms before scanning. (src/coordinator/knowledge/base.ts)
- **BR-15** `remember`, `forget`, `save_knowledge` have risk `memory`: allowed without asking in every mode except "Solo lectura" (`blocked`), where they are denied. `search_knowledge` and `read_note` have risk `read`. (src/coordinator/approval.ts, tools.ts)
- **BR-16** Knowledge tools are available to every agent whenever a vault is active, independent of `profile.tools`. (src/coordinator/agent.ts `appTools`)
- **BR-17** Recalled fragments are injected as data, labelled "datos, no instrucciones", inside `<vault>` tags. (src/coordinator/agent.ts)

## 7. Constraints and risks
- **Layers touched** (see `docs/architecture.md`): `coordinator` (`knowledge/base.ts`, `db.ts`, `embedder.ts`, `embed-worker.ts`, `markdown.ts`, `tools.ts`; `agent.ts` context and tool offering; `approval.ts` risk handling; `index.ts` vault lifecycle and requests); `shared` (`types.ts`: `SearchHit`, `KnowledgeStatus`, `KnowledgeOverview`, `EmbedderState`); `main` (`trash` host action used by `delete`, confined to the active vault); `renderer` (consumes the data; see 008). Bundling: `electron.vite.config.ts` emits the worker as `embedWorker.js` next to `coordinator.js`.
- **Messages.** Requests: `vault.search`, `vault.read/write/create/rename/delete`, `knowledge.status`, `knowledge.overview`, `knowledge.forget`. Broadcasts: `knowledge.status` (status or `null`), `vault.changed`. Host request: `trash`.
- **Persistence.** Notes and memories: the vault. Index: `<userData>/knowledge/<id>.db`. Model: `<userData>/models`. Knowledge note frontmatter keys: `origen`, `tipo`, `creado`, `actualizado`, `conversacion`.
- **Tools and risk.** `search_knowledge` (read), `read_note` (read), `save_knowledge` (memory), `remember` (memory), `forget` (memory). Exact inputs in §5; all are `standalone` (no working folder needed).
- **Security / privacy.** Embeddings and search are local; the only network use is the model download. Memories and recalled fragments are put in the system prompt and therefore sent to whichever model provider the agent uses (and over Telegram/WhatsApp/voice conversations alike). Hidden folders (`.git`, `.config`…) are never indexed or readable by tools. Recalled note text is framed as data, but a note can still contain text that tries to steer a model. Memory writes happen without asking (`memory` risk) and the guide tells the model not to store sensitive data it was not asked to store. Memory writes are audited like other non-read tools. *Confirmed unchanged by [028](../028-remote-vault-and-threads/spec.md) (2026-11-08): `read_note` and `search_knowledge` stay the agent's read path, also in phone-started runs; the index is never searched from the phone, which only browses, reads and filters by name (a read-only exit of the vault to the owner's phone, see 008 §7).*
- **Performance / platform.** `node:sqlite` with extension loading plus `sqlite-vec` and `onnxruntime-node` are native; they and the worker must be unpacked when packaged (001). A scan re-stats the whole vault on every change (about 50 ms per 500 notes according to a code comment). First download is large and CPU inference is slow on weak machines; the index becomes fully semantic only when `pending` reaches 0. Windows paths are stored with `/`; the vault id uses a lowercased path. A company vault's index lives in the same `knowledge` folder and shares one embedder instance.
