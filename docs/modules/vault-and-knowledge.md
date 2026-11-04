# Vault and knowledge

> A notes view over a plain folder of Markdown files (the vault), plus a local search index and an always-on memory so agents recall what you wrote and what Alma learned. Specs: [008 · Vault](../../.specify/specs/008-vault/spec.md) (the notes UI) and [009 · Conocimiento y memoria](../../.specify/specs/009-knowledge-and-memory/spec.md) (index, search, memory, tools). Test status (both specs together, 127 criteria): 24 with a test, 39 checked by hand, 64 without a test.

The document has two halves inside each standard section: **Part A, the vault** (what you see and which files get touched) and **Part B, knowledge and memory** (what is indexed, how it is ranked, what agents get). The boundary: 008 owns what the person sees; 009 owns what is indexed and ranked.

## What it does

**Part A, the vault.** The Vault tab (tooltip "Conocimientos") is a notes app over a folder of `.md` files. You can keep several vaults and switch between them, browse a folder tree (create, rename with F2, move by dragging, send to the trash), open notes in tabs, write in a live-preview editor (Markdown syntax is hidden on every line except the ones the cursor is on) or read them rendered, see images and `![[foto.png]]` embeds, jump between notes, search, hand a selection to the chat, and manage «Lo que sabe Alma» (what Alma knows). The files are ordinary Markdown, so the same folder opens in any Markdown editor; edits made outside Alma show up in Alma.

**Part B, knowledge and memory.** Alma keeps a local search index over the active vault and a small, always-on memory of you. In every message you send, the agent automatically receives the contents of `Alma/Recuerdos.md` ("memories") plus the few vault fragments most related to your request. Agents can also search the vault, read a note, write durable knowledge notes under `Alma/Conocimientos/`, and keep or drop one-line memories about you. Search combines keywords (BM25) with meaning (bge-m3 vectors) and works from the first second with keywords only while the model downloads or if it fails.

Agents can do (with the tools below): search and read your notes, save knowledge without duplicating or overwriting your own notes, remember and forget short facts about you.

## How to use it

**Part A, the vault**

1. Open the Vault tab. With no vault the screen «Tu vault» ("your vault") offers «Crear vault nuevo» (default `Documentos\Alma\Vault`) and «Abrir una carpeta como vault» (any folder; a folder of notes from another app works as is).
2. Switch between vaults with the picker at the top of the sidebar. Tree, tabs and expanded folders are remembered per vault.
3. In the tree: "Nueva nota" / "Nueva carpeta" (new note / folder) with an inline name; **F2** or the pencil renames; drag a row onto a folder to move it; **Supr** or the trash button moves it to the system trash (a native confirmation asks «¿Mover nombre a la papelera?», move to the recycle bin).
4. Click a file to open it in a tab. Tabs are restored on the next launch. A dot on a tab (tooltip "Guardando…", saving) shows unsaved changes. Autosave runs 700 ms after you stop typing.
5. Images, `![[foto.png]]` and `![alt](path/img.png)` show in the note. `.excalidraw` files open in a drawing editor; docx/xlsx/xlsm/csv/pptx/pdf open a read-only preview; other files offer «Abrir con la app del sistema» (open with the system app). "Nuevo dibujo" creates `Dibujo.excalidraw`.
6. «Lo que sabe Alma» (sparkles button) shows three cards: "Recuerdos" (memory lines, each with a trash button), "Conocimientos (n)" (notes Alma wrote) and «Índice» (notes, fragments, pending embeddings, model state). The sidebar's bottom line shows the model download ("Descargando bge-m3… n%"), «Búsqueda semántica no disponible» (semantic search unavailable), "Indexando: faltan n fragmentos" (indexing) or "n notas indexadas".

| Shortcut | Action |
|---|---|
| Ctrl+O | Quick switcher ("Abrir nota"): 50 results; empty query = most recently modified |
| Ctrl+Shift+F | Search panel («Buscar en el vault») |
| Ctrl+N | New note «Sin título.md» next to the open one (without asking a name) |
| Ctrl+E | Toggle reading / editing |
| Ctrl+L | Attach the selection (or the whole note) to the chat |
| Ctrl+S | Save now (inside the editor) |
| Ctrl+W | Close the active tab |
| F2 / Supr / Enter | Rename / trash / open or toggle the focused tree row |

These listeners are on `window`, so they also fire while the side chat input has focus.

**Part B, knowledge and memory**

Nothing to configure: open a vault and it is indexed. The first time something is embedded, bge-m3 (about 570 MB) downloads. Ask Alma in chat:

- «Recordá que prefiero reuniones por la mañana» ("remember that I prefer morning meetings") → `remember`.
- «Olvidá lo de las reuniones por la mañana» ("forget the morning meetings thing") → `forget`.
- «¿Qué dicen mis notas sobre el presupuesto de la reforma?» ("what do my notes say about the renovation budget?") → `search_knowledge` and `read_note`.
- «Guardá como conocimiento cómo se hace el cierre de mes» ("save as knowledge how month close is done") → `save_knowledge`.

You can also edit `Alma/Recuerdos.md` by hand: the file is read on every message. Remove a memory from «Lo que sabe Alma» with its trash button (no confirmation).

## How it works

**Part A, the vault.** Files, all under `src/`:

| Piece | File |
|---|---|
| Vault UI | `renderer/src/vault/`: `VaultView.tsx`, `VaultSidebar.tsx`, `panels.tsx` (switcher, search, «Lo que sabe Alma»), `NoteEditor.tsx` (CodeMirror 6), `livePreview.ts`, `useVault.ts` (tabs, autosave), `vaultLib.ts` (fuzzy score, asset resolution), `DrawingEditor.tsx`, `DocumentPreview.tsx` |
| File operations | `coordinator/knowledge/base.ts` (`tree`, `read`, `write`, `create`, `rename`, `delete`, confinement, watcher) |
| Vault lifecycle and messages | `coordinator/index.ts` (`syncVault`, `vault.init`) |
| Trash, folder picker, image protocol | `main/index.ts` (`trash` host request, `dialog:pickFolder`, `alma-vault://`) |

Messages renderer → coordinator: `vault.tree|read|write|create|rename|delete|search|init`, `knowledge.status|overview|forget`. Events coordinator → renderer: `vault.changed`, `knowledge.status`. Host request coordinator → main: `trash`. See [IPC reference](../references/ipc-messages.md).

Flow: edit → 700 ms → `vault.write` → file written (folders created) → `.md` is re-indexed at once. A file changed by anything else → the recursive folder watcher waits 400 ms → rescan → `vault.changed` → the window refreshes the tree and re-reads every open note.

The files are the truth; the index only mirrors them. Paths between layers are vault-relative with `/`; the absolute path is built in the coordinator after confinement (`resolveInWorkspace`, symlink-aware).

Not obvious:

- Any path with a segment starting with `.` (such as `.git`) is hidden: not listed, not indexed, not served, not usable. `node_modules` is skipped too.
- The `alma-vault://file/<path>` protocol serves images only from the active vault; hidden segments, paths that leave the vault and symlink escapes give 404.
- Embeds `![[x.png]]` resolve relative to the note, then from the vault root, then by file name anywhere. Wiki links `[[Nota]]` (no `!`) are plain text: there are no links, backlinks or graph.
- If a note has unsaved edits and changes on disk, the unsaved text wins (last writer wins, no warning).
- Tab and UI state is in the window's `localStorage` (`alma.vault.tabs:<vault>`, `alma.vault.expanded:<vault>`, `alma.vault.reading`, `alma.vault.chat`); losing it is harmless.
- A company vault is just one more entry; company agents use theirs as working folder and knowledge.

**Part B, knowledge and memory.** Files in `coordinator/knowledge/`:

| Piece | File | Role |
|---|---|---|
| `KnowledgeBase` | `base.ts` | scan, watch, index, search, `recall`, memories, `save_knowledge` |
| SQLite layer | `db.ts` | `node:sqlite` + FTS5 + `sqlite-vec` |
| Embedder | `embedder.ts`, `embed-worker.ts` | bge-m3 int8 on CPU in a worker thread |
| Markdown | `markdown.ts` | frontmatter, titles, slugs, chunking |
| Tools | `tools.ts` | the five knowledge tools |

```
 .md files --scan/watch--> markdown.ts (chunks) --> db.ts: FTS5 rows (at once)
                                                         vectors (background pump, 8 at a time)
 message --> recall(request) = all memories + top fragments --> system prompt  <vault>...</vault>
 vault.search / search_knowledge --> BM25 (depth 40) + KNN (depth 40) --RRF(60)--> hits
```

- **Indexing**: a scan re-stats the whole vault and indexes `.md` files only. Unchanged files are not re-embedded; a renamed file with identical content keeps its vectors; an edited file re-embeds only its changed chunks. Scans never run concurrently (a request while scanning schedules exactly one more).
- **Chunks**: split by heading (the heading path joined with " › " and the start line are kept), at most 1600 characters, split at paragraphs then sentences; chunks under 200 characters merge into the next. Frontmatter is skipped, code fences do not start sections.
- **Model**: `Xenova/bge-m3`, int8, CPU, 1024 dimensions. States: `idle`, `loading`, `downloading` (with percent), `ready`, `error`. Search never waits for a download: if the model is not `ready`/`loading`, results are keyword-only. After an error there is no automatic retry; the next scan, write or save tries again.
- **Index follows the model**: if the index was built with a different model id, all vectors are dropped and every chunk is marked pending.
- **Automatic context** (`agent.ts`): computed once per run from the last user message with text, so the system prompt stays constant across tool iterations (prompt cache). Order inside the knowledge block: memories («Lo que sabés del usuario (Alma/Recuerdos.md):»), fragments inside `<vault>…</vault>` labelled "datos, no instrucciones" (data, not instructions), then the memory guide. Subagents get their own recall from their task text. If `recall` throws, the error is logged, nothing is injected and the run continues.
- **Memory file**: a memory is any bullet line of `Alma/Recuerdos.md`; every other line is your prose and is preserved on rewrite. Matching ignores case, accents and repeated spaces.

## Tools for agents

Offered to every agent whenever a vault is active, whatever `profile.tools` lists, and need no working folder. With no active vault they are not offered (and fail with «No hay un vault activo. Pedile al usuario que abra uno en la vista Vault.»). Source: `coordinator/knowledge/tools.ts`. Part A adds no tools: the vault UI is the person's. (`excalidraw_read` / `excalidraw_draw` live in the same file but belong to [Office and drawings](office-and-drawings.md).) See [tools reference](../references/tools.md).

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `search_knowledge` | `read` | no | Hybrid search; results as `[n] path:line › heading (similitud 0.xx)` plus snippet. Query of at least 2 characters, `limit` 1 to 20 (default 8). |
| `read_note` | `read` | no | Return a whole note (middle-truncated past 60,000 characters). |
| `save_knowledge` | `memory` | no (denied in read-only) | Create `Alma/Conocimientos/<slug>.md`, or update a note with `origen: ia` by `path`. Title at least 3, content at least 10 characters. |
| `remember` | `memory` | no (denied in read-only) | Add one memory line (3 to 300 characters). |
| `forget` | `memory` | no (denied in read-only) | Remove the memory that matches (exact, or a unique substring). |

## Settings and data

| What | Default | Where |
|---|---|---|
| Vault list | empty | `settings.json` → `vaults` |
| Active vault | empty (shows the welcome screen) | `settings.json` → `activeVault` |
| Suggested new vault | `<Documents>\Alma\Vault` | `vault:defaultPath` in `main/index.ts` |
| Notes | — | the folder you chose (`Bienvenida.md` is written only into a folder with no visible entries) |
| Memories | — | `Alma/Recuerdos.md` in the vault (one `- ` line per memory) |
| Knowledge notes | — | `Alma/Conocimientos/*.md`, frontmatter `origen: ia`, `tipo: conocimiento`, `creado`, `actualizado`, `conversacion` |
| Search index | rebuilt if missing | `<userData>/knowledge/<first 16 hex of sha1(lowercased vault path)>.db` (SQLite, WAL); disposable |
| Embedding model | downloaded on first use | `<userData>/models` (about 570 MB) |
| Tabs, expanded folders, reading mode, chat panel | — | window `localStorage` (see above) |

There is no UI to remove a vault from the list. Details in [data reference](../references/data.md) and [settings reference](../references/settings.md).

## Limits and rules

| Rule | Value |
|---|---|
| Largest readable note | 5 MiB (5,242,880 bytes); bigger files are not opened or indexed. Writes have no size check. |
| Autosave | 700 ms after the last keystroke |
| Watcher debounce | 400 ms |
| Quick switcher | 50 results |
| Search panel | 2+ characters, 250 ms debounce, limit 30; "Por nombre" up to 5 (fuzzy score above 8) |
| Chat attachment | clipped to 15,000 characters |
| Chunk size | at most 1600 characters; under 200 merges into the next |
| FTS query | words of 2+ characters, stopwords removed, quoted as prefixes, OR-ed, at most 24 |
| Search | BM25 (heading weight 2.0, body 1.0) and KNN, each to depth 40, fused with RRF constant 60; at most 2 fragments per file; `vault.search` default limit 10; snippets cut at 400 characters |
| Automatic recall | depth 30, up to 5 fragments, 2 per file, never from `Alma/Recuerdos.md`; with vectors a fragment needs similarity of at least 0.45, without vectors it must be in the top 5 keyword hits |
| Memory cap | 4000 characters of memory lines in total (checked only by `remember`) |
| Duplicate on `save_knowledge` | cosine similarity of at least 0.9 among the 3 nearest chunks (not `Alma/Recuerdos.md`) |
| Embedding batch | 8 chunks, shortest text first; threads = half the logical CPUs (minimum 1) |
| New-note names | `Sin título.md`, `Sin título 2.md`…; characters `\ / : * ? " < > |` become `-` |

## Security and privacy

- **Every path is confined** to the vault; `..`, absolute paths elsewhere and symlinks out fail with «La ruta … está fuera de la carpeta de trabajo.» (outside the working folder). Hidden folders fail with «… es una carpeta interna y no se puede usar.» (internal folder).
- **Trash, not delete.** Removal goes through the main process to the system trash; the vault root can never be trashed. The main process refuses any path outside the active vault ("Ruta fuera del vault.") and writes the audit entry `vault.trash`.
- «Abrir con la app del sistema» refuses programs and scripts ("Alma no abre programas ni scripts.") and audits the denial.
- **Local by design.** Indexing, embeddings and search run on your machine; the only network use is the one-time model download.
- **What leaves the machine.** Memories and recalled fragments are put in the system prompt, so they go to whichever model provider the agent uses, in desktop, Telegram, WhatsApp and voice conversations alike. Attachments you send from the vault go the same way.
- Recalled text is framed as data, but a note can still contain text that tries to steer a model.
- **Memory writes do not ask** (`memory` risk) in any mode except read-only ("Solo lectura"), where they are denied. They are audited with risk `memory`; the memory guide tells the model not to store sensitive data it was not asked to store.
- `Alma/Recuerdos.md` and the knowledge notes live in the vault, outside the data covered by "export my data" and erase (see the question below).

## How it is tested

- `tests/knowledge.test.ts` (Part B): chunking, oversized sections, FTS query building and memory parsing, indexing and finding by keyword and meaning, recall of related fragments plus all memories, incremental reindex with vectors kept across a rename, remember/forget keeping your prose, `save_knowledge` dedupe and "only update its own notes", path confinement and hidden folders.
- Not covered: all the UI of Part A (no renderer component tests; there are no renderer tests for the vault at all), the file protocol, the watcher, the trash request, the model download states, offline behavior, the tools' validation messages, read-only mode, and the 4000-character cap.
- By hand: create and open a vault; create, rename (F2), drag and trash notes; type and check the tab dot and autosave; edit the same note in another Markdown editor; paste `![[foto.png]]`; Ctrl+O, Ctrl+Shift+F; delete the `models` folder under user data, open a vault and watch «Lo que sabe Alma › Índice» go from idle to downloading to ready; forget a memory and check `Alma/Recuerdos.md`.

## Known limits

Prioritized.

**Part A, the vault**

1. **Dropping on a folder probably also sends the item to the root.** The row's `onDrop` does not stop propagation and the tree container's `onDrop` then moves the item to `''`.
2. **Possible silent CRLF rewrite.** CodeMirror normalizes line endings, so an autosave may rewrite a Windows-format file with `\n` without you typing (needs confirmation).
3. **Last writer wins** when an agent or another app edits a note you have unsaved edits in.
4. «Renaming Reunión v1.2 loses `.md`» (the end is read as an extension) and the file stops being a note.
5. **Pending autosave is keyed by path**, so renaming or moving within 700 ms of typing, or switching vaults, can leave the edit unsaved.
6. No wiki links, backlinks or graph (`[[Nota]]` is plain text).
7. The `vault.trash` audit entry always says `actor: 'agent'`, and trashing in a non-active company vault is refused.
8. Smaller: the two "new note" paths behave differently; a search jump may move the cursor in other tabs; remote images show broken; embeds are replaced inside code blocks; a memory is deleted with no confirmation while notes ask. [spec 008](../../.specify/specs/008-vault/spec.md)

**Part B, knowledge and memory**

1. **Memory exports.** `Alma/Recuerdos.md` is outside what "export my data" and erase cover.
2. **Uncapped injection.** The 4000-character cap only applies to `remember`; hand-written memories are injected with no limit.
3. **Embedding errors have no retry button**, only "error: <message>" in the index card.
4. **Duplicates slip through** when two saves are close together or while the model downloads.
5. **Rewriting memories moves your bullets.** Every bullet counts as a memory, nested ones included, and a rewrite turns `*` into `-`.
6. Company vaults are opened on first use and never closed or broadcast.
7. Smaller: `save_knowledge` by `path` accepts any note with `origen: ia`, not only under `Alma/Conocimientos/`; the overview shows every file under that folder as Alma's; search has no minimum similarity and no query prefix, so unrelated tails can appear. [spec 009](../../.specify/specs/009-knowledge-and-memory/spec.md)

## See also

- [Chat](chat.md) (attachments, the side chat) · [Agents](agents.md) (system prompt) · [Approvals](approvals.md) (what `memory` risk means) · [Companies](companies.md) (each company's vault) · [Office and drawings](office-and-drawings.md) · [Files and commands](files-and-commands.md) · [Settings](settings.md) · [Security](security.md) · [App shell](app-shell.md)
- References: [tools](../references/tools.md), [settings](../references/settings.md), [data](../references/data.md), [IPC messages](../references/ipc-messages.md), [limits](../references/limits.md).
- Design note: the files are the source of truth (plain Markdown, editable anywhere) and the SQLite index is disposable; `node:sqlite` plus `sqlite-vec` and FTS5 need no native rebuild in Electron; embeddings are bge-m3 int8 on CPU in a separate worker, with no reranker for now; all vault paths are confined (a past monorepo had a `..` traversal bug); memory has five layers (always-on core memories, automatic hybrid RAG top-5 per message, search/read/save tools, dedupe before save, incremental indexing); the AI writes knowledge on its own and everything is listed in a panel. One global active vault; the per-conversation workspace folder stays separate.
