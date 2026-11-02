---
status: implemented
---

# 008 — Vault (the "Conocimientos" notes view)

## 1. Summary
The **Vault** tab of Alma (tooltip "Conocimientos") is a notes experience over a plain folder of Markdown files.
The person can keep several vaults and switch between them, browse a folder tree (create, rename with F2, move by drag, send to
the trash), open notes in tabs, write them in a live-preview editor (Markdown syntax is hidden on every line except the ones
the cursor is on) or read them rendered, see images and `![[foto.png]]` embeds, jump between notes with Ctrl+O, search with
Ctrl+Shift+F, hand a selection to the chat with Ctrl+L, and manage "Lo que sabe Alma" (the always-on memories and the notes Alma
wrote). The files are ordinary `.md` files, so the same folder opens in any Markdown editor; edits made outside Alma are picked up.

## 2. Problem and goal
Notes that Alma reads and writes must be visible and editable by the person, in a format that is not locked into Alma. Done means:
the person can organize and edit the folder entirely from Alma, edits survive (autosave), changes made by agents or by other apps
show up without restarting, and everything Alma "knows" can be inspected, edited and deleted.

## 3. Scope
**In:**
- The Vault mode of the app: sidebar (vault picker, toolbar, folder tree, index status line), tabs, editor, reading mode,
  quick switcher, search panel (the UI only), "Lo que sabe Alma" panel (the UI only), the welcome screen when there is no vault.
- Creating, opening, renaming, moving and trashing files and folders; the autosave/reload/external-edit behavior; keyboard shortcuts.
- Images, `![[...]]` embeds and the `alma-vault://` file protocol that serves them; which file types open how.
- The coordinator messages `vault.tree|read|write|create|rename|delete|init`, `knowledge.status|overview|forget` (as the UI uses
  them), the event `vault.changed`, and the file operations of `KnowledgeBase` (`tree`, `read`, `write`, `create`, `rename`,
  `delete`, path confinement, hidden folders, the file watcher as a *signal that files changed*).
- The `trash` host request in `src/main/index.ts` (the part that moves vault items to the system trash).

**Out (and why):**
- The SQLite index, FTS5/vector storage, chunking, embeddings and the bge-m3 model, search ranking and fusion, `recall` and the
  context injected into prompts, the agent tools `search_knowledge` / `remember` / `forget` / `save_knowledge` and their rules
  (duplicates, 4000-character memory cap, "only Alma's own notes may be updated") -> `../009-knowledge-and-memory/spec.md`.
  Boundary: this spec owns *what the person sees and which files are touched*; 009 owns *what is indexed and how it is ranked*.
  The panels here only display the results 009 produces (search hits, status counts, memory lines).
- Rendering details of Excalidraw drawings, the Office/PDF preview and the agent tools that create documents and drawings
  -> `../021-office-documents-and-drawings/spec.md`. Here they are only "a file type the tree can open".
- The chat panel that can sit beside the vault view (its messages, approvals, composer) -> `../002-chat/spec.md`. Here only the
  hand-off ("Preguntarle a Alma" attachments) and the toggle.
- Company vaults as a concept (a company has its own vault folder, minutes saved there) -> `../007-companies/spec.md`; here a
  company vault is just one more entry of the vault list.
- App shell, themes and sounds -> `../023-app-shell-and-ui/spec.md`. Tools that read/write files in a chat workspace
  -> `../015-file-and-command-tools/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want to create a vault or open any existing folder (a folder of notes made with another Markdown app works as is) and switch between
  several, so that I keep separate bodies of notes.
- **US-2** As a person, I want a folder tree where I can create, rename (F2), move by drag and trash notes and folders, so that I
  organize notes like in any notes app.
- **US-3** As a person, I want to open notes in tabs and have them restored next time, so that I keep my place.
- **US-4** As a person, I want a live-preview editor and a reading mode, with autosave, so that writing is fast and nothing is lost.
- **US-5** As a person, I want images, `![[foto.png]]` embeds and drawings to show inside notes, so that notes are visual.
- **US-6** As a person, I want to find a note by name (Ctrl+O) or by content (Ctrl+Shift+F), so that I reach it quickly.
- **US-7** As a person, I want to see, edit and delete everything Alma remembers or wrote ("Lo que sabe Alma"), so that I stay in control.
- **US-8** As a person, I want edits made by an agent or by another app to appear in Alma, and my own edits not to be
  lost, so that the folder stays the single source of truth.
- **US-9** As a person, I want to pass the selected text (or a whole note/file) to the chat with one gesture, so that I can ask
  Alma about it.
- **US-10** As the maintainer, I want every vault path confined to the vault folder, hidden folders untouched and file serving
  restricted to the active vault, so that a note, a model or a link cannot reach the rest of the disk.

## 5. Acceptance criteria

### Vaults and the welcome screen (US-1)
- **AC-1.1** (US-1) [manual] Given no active vault (`activeVault` is empty), when the Vault tab opens, then the screen "Tu vault"
  offers "Crear vault nuevo" (showing the default path `Documentos\Alma\Vault`) and "Abrir una carpeta como vault"; the sidebar
  says "Todavía no hay un vault.". Checked by starting with empty `activeVault` in settings.
- **AC-1.2** (US-1) Given a folder that does not exist or is empty of visible entries, when "Crear vault nuevo" runs `vault.init`,
  then the folder is created and, only if it has no visible (non-dot) entries, a `Bienvenida.md` is written; a non-empty folder
  is left untouched. [gap]
- **AC-1.3** (US-1) [manual] Given "Crear vault nuevo" or "Abrir carpeta como vault…" (native folder picker), when a folder is
  chosen, then it is appended to the vault list (no duplicates) and becomes the active vault; cancelling the picker changes nothing.
- **AC-1.4** (US-1) [manual] Given several vaults in the list, when the picker `<select>` in the sidebar changes, then the active
  vault switches, the tree, tabs and expanded folders shown are those saved for that vault, and the picker lists each vault by its
  folder name.
- **AC-1.5** (US-1) Given the active vault changes in settings, when the coordinator receives the new settings, then the previous
  vault is closed, the new one is opened and watched, `knowledge.status` and `vault.changed` are broadcast; if the folder no longer
  exists, no vault is opened and `vault.read|write|create|rename|delete|search` fail with "No hay un vault abierto." while
  `vault.tree` answers an empty list. [gap]

### Tree: create, rename, move, trash (US-2)
- **AC-2.1** (US-2) Given the vault tree request, when the vault has files and folders, then every non-hidden entry comes back with a
  vault-relative forward-slash path, kind, size and mtime, and any path with a segment starting with `.` (e.g. `.git`) or a
  folder named `node_modules` is left out. [gap]
- **AC-2.2** (US-2) [manual] Given the tree, then folders are listed before files and both alphabetically (Spanish collation,
  numeric-aware); folders expand/collapse by click or Enter; the expanded set is remembered per vault and the folders of the open
  note are revealed automatically.
- **AC-2.3** (US-2) Given the entries list, when the tree is built, then folders sort before files and names sort alphabetically
  with `localeCompare('es', numeric)`. [gap]
- **AC-2.4** (US-2) [manual] Given the toolbar "Nueva nota" or a folder's "Nueva nota" button, when clicked, then an inline input
  appears (preselected text "Sin título") and, on Enter or blur, `<name>.md` is created in that folder (an existing `.md` suffix is
  not doubled) and opened in a tab; Escape cancels. "Nueva carpeta" does the same with the placeholder "Nueva carpeta" and
  expands the new folder.
- **AC-2.5** (US-2) Given a name typed in the tree input, when it is submitted, then every character of `\ / : * ? " < > |` is
  replaced by `-` and an empty name does nothing. [gap]
- **AC-2.6** (US-2) Given a path that already exists, when `vault.create` is requested for it, then it fails with "Ya existe <path>."
  and nothing is overwritten; creating a file writes it empty, creating a folder creates missing parents. [gap]
- **AC-2.7** (US-2) Given a tree row focused, when F2 or the pencil button is used, then an inline input opens with the name
  selected up to its extension; a name typed without an extension keeps the file's `.md`/`.excalidraw`; a name that already ends in
  `.<letters or digits>` is used as typed. [manual] (no automated renderer tests)
- **AC-2.8** (US-2) Given a source that exists and a target that does not, when `vault.rename` runs, then missing parent folders of
  the target are created, the item is moved and a rescan runs; a target that exists (other than a case-only rename of the same item)
  fails with "Ya existe <to>."; a missing source fails with "No existe <from>."; paths outside the vault or in hidden folders are
  refused. [gap]
- **AC-2.9** (US-2) [manual] Given a row dragged onto a folder row, when dropped, then the item moves into that folder keeping its
  name, the folder highlights while hovering, and open tabs/documents are re-pointed at the new paths (also for every file under a
  moved folder). Dropping into the empty area of the tree moves it to the vault root. Moving a folder into itself or into its own
  descendant, or onto its current parent, does nothing.
- **AC-2.10** (US-2) Given a rename or move that fails (name taken, bad path), when the response arrives, then the message is shown
  in red at the top of the tree and the tabs are not re-pointed. [manual] (try renaming onto an existing name)
- **AC-2.11** (US-2) [manual] Given a row, when Delete ("Supr") or the trash button is used, then a native confirmation asks
  "¿Mover «nombre» a la papelera?" (for a folder "…la carpeta «nombre» y todo su contenido…"); on accept the item goes to the system
  trash, its tabs close and its documents are dropped; on cancel nothing happens.
- **AC-2.12** (US-2) Given a delete request, when the path is the vault root (`.`), then it fails with "No se puede borrar el vault
  entero desde acá."; for any other path inside the vault the absolute path is handed to the trash and a rescan runs; a path outside
  the vault or in a hidden folder is refused. Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders"
- **AC-2.13** (US-2) Given the main process receives a `trash` host request, when the path is outside the active vault or is the
  vault root, then it answers `{ ok: false, message: 'Ruta fuera del vault.' }` and trashes nothing; otherwise it calls the system
  trash and writes the audit entry `vault.trash`. [gap]
- **AC-2.14** (US-2) [manual] Given an empty vault, the tree shows "El vault está vacío."; each file type has its own icon (note,
  image, drawing, other).

### Tabs and session (US-3)
- **AC-3.1** (US-3) [manual] Given a click on a file in the tree, Ctrl+O choice, search hit, "Abrir nota" link in a chat tool card
  or a relative `.md` link in rendered text, then the vault view is shown (the mode switches to Vault if needed), the file opens in
  a tab (or its existing tab is activated) and becomes active.
- **AC-3.2** (US-3) [manual] Given open tabs, when the app restarts, then the tabs and the active one of each vault are restored
  (`localStorage` `alma.vault.tabs:<vault>`); a tab whose file no longer exists shows the error "No existe la nota …" in the body.
- **AC-3.3** (US-3) [manual] Given a tab, when its X button, middle click or Ctrl+W is used, then it closes after saving pending
  edits and the neighboring tab (the one now at that position, else the previous, else none) becomes active.
- **AC-3.4** (US-3) [manual] Given a tab with unsaved changes, then a dot (tooltip "Guardando…") shows on it until the write succeeds.
- **AC-3.5** (US-3) [manual] Given nothing open, the body says "Abrí una nota del panel izquierdo." and lists the shortcuts
  "Ctrl+O abrir · Ctrl+N nueva nota · Ctrl+Shift+F buscar · Ctrl+E leer/editar".

### Editor, reading mode and autosave (US-4)
- **AC-4.1** (US-4) Given a `.md` file, when it is opened, then its content is read (`vault.read`, UTF-8) and shown in a CodeMirror 6
  editor with Markdown highlighting, line wrapping, undo/redo, search keymap, Tab indentation and the placeholder "Escribí acá…";
  each note gets a fresh editor (the undo history is not kept when switching tabs). [manual]
- **AC-4.2** (US-4) [manual] Given the live preview, then on every line the cursor/selection does not touch: heading marks, emphasis
  marks, code marks, strikethrough marks and quote marks are hidden and headings/bold/italic/strike/inline code/quotes/fenced code
  are styled; `[text](url)` shows only "text" as a link; `-`/`*`/`+` bullets show as "•"; `- [ ]`/`- [x]` become clickable checkboxes
  (a click toggles the character in the text); `---` becomes a rule. On the lines the cursor is on the raw Markdown shows.
- **AC-4.3** (US-4) Given typing, when 700 ms pass without another edit, then the content is written with `vault.write`; Ctrl+S
  (Mod-s in the editor) writes immediately; the tab dot clears when the write succeeds. [gap]
- **AC-4.4** (US-4) Given a write that fails, when the response arrives, then the text stays in the editor, a banner "No se pudo
  guardar: <message>" shows above the body and the next edit or save retries. [gap]
- **AC-4.5** (US-4) Given pending edits, when a tab is closed or the window unloads, then a save is attempted first (best effort on
  unload: the request may not complete). [gap]
- **AC-4.6** (US-4) Given `vault.write` for a path whose folder does not exist, then the folders are created; given a `.md` path it is
  re-indexed (009) and `status` is emitted. A path outside the vault or in a hidden folder is refused. Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders"
- **AC-4.7** (US-4) Given a file larger than 5 MiB (5 242 880 bytes), when it is read, then it fails with "<path> es demasiado grande para
  abrirlo (<n> bytes)." and the tab body shows that message; writes have no size check. [gap]
- **AC-4.8** (US-4) Given a read of a path that is not a file, then it fails with "No existe la nota <path>." and the body shows the
  message in red. [gap]
- **AC-4.9** (US-4) [manual] Given Ctrl+E or the "Leer"/"Editar" button (only for `.md`), then the note toggles between editor and
  rendered view; the choice is remembered (`alma.vault.reading`). The reading view hides the YAML frontmatter, renders GitHub-flavored
  Markdown without raw HTML, and resolves images and embeds like the editor.
- **AC-4.10** (US-4) [manual] Given Ctrl+N, then a note `Sin título.md` (then `Sin título 2.md`, … compared case-insensitively) is
  created next to the open note (or at the root when nothing is open) and opened. The "Nueva nota" toolbar button (which asks for a
  name) behaves differently.
- **AC-4.11** (US-4) [manual] Given the "Nuevo dibujo" button, then `Dibujo.excalidraw` (or `Dibujo 2…`) is created next to the open file
  with an empty drawing and opened.

### Images, embeds and file types (US-5)
- **AC-5.1** (US-5) Given a file whose name ends in png, jpg, jpeg, gif, webp, svg, bmp or avif, when opened, then the body shows the
  image through `alma-vault://file/<path>`. [manual]
- **AC-5.2** (US-5) Given `![[foto.png]]` (optionally `![[foto.png|300]]` or `#…`) on a line the cursor is not on, when the note is
  shown in the editor, then the line part is replaced by the image, resolved first relative to the note's folder, then as a path from
  the vault root, then by file name anywhere in the vault (case-insensitive, first match); if nothing resolves, the raw text stays.
  Inside a fenced code block the text is also replaced if it matches (the embed pass is not syntax-aware). [manual]
- **AC-5.3** (US-5) Given a reference and a list of entries, when `resolveAsset` runs, then it returns an `alma-vault://` URL by the
  order relative path -> vault-root path -> basename, `..` and `.` segments are normalized, `http(s)://` targets are returned unchanged
  and unknown targets give null. [gap]
- **AC-5.4** (US-5) [manual] Given `![alt](path/img.png)` (standard Markdown), then the editor and the reading view show the image
  using the same resolution; in reading view an unresolved image shows "[imagen no encontrada: …]". Remote images do not load (the
  window's content security policy allows only `self`, `data:`, `blob:`, `alma-vault:` and the local house video host for images).
- **AC-5.5** (US-5) [manual] Given `![[Plan.excalidraw]]`, then the drawing is shown as an SVG in the current theme ("Cargando dibujo…"
  first) and a double click opens it in a tab.
- **AC-5.6** (US-5) [manual] Given a `.excalidraw` file, then it opens in an Excalidraw editor (loaded lazily) that autosaves like a note;
  given a docx/xlsx/xlsm/csv/pptx/pdf file, it opens a read-only preview with "Recargar" and "Abrir con la app del sistema"; any other
  file shows "Este archivo no es una nota." with a button "Abrir con la app del sistema". Details -> 021.
- **AC-5.7** (US-5) Given a request to `alma-vault://file/<path>`, when the path resolves outside the active vault, has any segment
  starting with `.`, the vault is empty, or a symlink inside leads out of the vault, then the response is 404; otherwise the file is
  served with `Access-Control-Allow-Origin: *`. [gap]
- **AC-5.8** (US-5) Given `[[Nota]]` (a wiki link without `!`), then it is shown as plain text in both editor and reading view; it is not
  a link. [manual]

### Finding notes (US-6)
- **AC-6.1** (US-6) [manual] Given Ctrl+O (or Cmd+O), then a dialog "Abrir nota" opens with focus in the input; with an empty query it lists
  the 50 most recently modified files; otherwise the 50 best fuzzy matches of the path (without `.md`); Up/Down move, Enter opens the
  selection and closes, Escape or a click outside closes; with no match it says "No hay notas con ese nombre."
- **AC-6.2** (US-6) Given a query and a path, when `fuzzyScore` runs, then it returns 0 unless every query character appears in order
  (case-insensitive, spaces ignored), 1 for an empty query, and scores consecutive runs, word-start matches and matches in the file
  name higher. [gap]
- **AC-6.3** (US-6) [manual] Given Ctrl+Shift+F or the toolbar magnifier, then the right-hand panel "Buscar en el vault" opens; after 2+
  characters and 250 ms it calls `vault.search` (limit 30), shows "Buscando…" while waiting, lists "Por nombre" (up to 5 files whose fuzzy
  score is above 8) and "En el contenido" (note › heading, snippet, `path:line`, similarity percent when semantic search took part);
  with no result it says "Sin resultados."; a failing search shows the error message in red. Only the latest request's answer is shown.
- **AC-6.4** (US-6) [manual] Given a content hit, when clicked, then the note opens and the hit's line is selected and scrolled to the
  center of the editor. Ranking and what is indexed -> 009.
- **AC-6.5** (US-6) Given a search with no vault open, then `vault.search` fails with "No hay un vault abierto." [gap]

### "Lo que sabe Alma" (US-7)
- **AC-7.1** (US-7) [manual] Given the sparkles toolbar button, then the panel "Lo que sabe Alma" opens (only one of search/panel at a time)
  with three cards: "Recuerdos" (the bullet lines of `Alma/Recuerdos.md`), "Conocimientos (n)" (notes under `Alma/Conocimientos/` with
  title and relative time) and "Índice" (notes, fragments, pending embeddings or "todo embebido", model state, vault path).
- **AC-7.2** (US-7) [manual] Given a memory line, when its trash button is used, then `knowledge.forget` runs with that text (no
  confirmation) and the line disappears; on failure the error is shown in red. Matching rules -> 009.
- **AC-7.3** (US-7) [manual] Given "Editar Recuerdos.md" or a knowledge note link, then that file opens in a tab; the notes list has a
  trash button with a native confirmation, which calls `vault.delete`.
- **AC-7.4** (US-7) Given the knowledge overview, when no vault is open, then it answers no memories and no notes. [gap]
- **AC-7.5** (US-7) [manual] Given the panel is open and files change (`vault.changed`), then the overview is requested again.
- **AC-7.6** (US-7) [manual] Given the sidebar's bottom line, then it shows "Descargando bge-m3… n%" while the model downloads, "Búsqueda
  semántica no disponible" (error text in the tooltip) when it failed, "Indexando: faltan n fragmentos" while embeddings are pending, else
  "n notas indexadas".

### External edits and conflicts (US-8)
- **AC-8.1** (US-8) Given the vault folder, when a file changes on disk (agent tool, another app), then after a 400 ms debounce
  the vault is rescanned and `vault.changed` is broadcast; the renderer refreshes the tree and re-reads every open document. Changes inside
  hidden folders do not trigger it. [gap]
- **AC-8.2** (US-8) Given an open note with no unsaved edits, when it changes on disk, then the editor text is replaced by the new content
  (cursor position kept, clamped to the new length). [gap]
- **AC-8.3** (US-8) Given an open note with unsaved edits, when it changes on disk, then the unsaved text wins, nothing warns the person, and
  the next save overwrites the external version. [gap]
- **AC-8.4** (US-8) Given the watcher cannot start or fails, then the error is only logged in the console and the view no longer refreshes
  by itself (a restart or a vault switch re-reads). [gap]
- **AC-8.5** (US-8) Given a file renamed or deleted outside Alma while open, then the tab stays; the next re-read shows the error
  "No existe la nota …" in place of the body (unless there are unsaved edits, which stay). [gap]
- **AC-8.6** (US-8) Given a create, rename or delete through Alma, then `vault.changed` is broadcast once the rescan completes. [gap]

### Handing context to the chat (US-9)
- **AC-9.1** (US-9) [manual] Given Ctrl+L (for `.md` only) or the "Preguntar" button, then the selected text of the editor (or of the reading
  view) is attached to the chat as a chip with file and line range; with no selection the whole note is attached (clipped to 15 000
  characters). The chat panel opens beside the view. A tree row's "Preguntarle a Alma" button attaches the file the same way (non-text
  files are attached by path only). Message format -> 002.
- **AC-9.2** (US-9) [manual] Given the "Chat" button, then the side chat toggles and the state is remembered (`alma.vault.chat`).

### Keyboard shortcuts (US-6, US-4)
- **AC-10.1** (US-6) [manual] While the Vault view is shown, Ctrl/Cmd+O opens the switcher, Ctrl+Shift+F the search, Ctrl+N a new note,
  Ctrl+W closes the active tab, Ctrl+E toggles reading, Ctrl+L attaches (`.md`), Ctrl+S saves (inside the editor), F2 renames and
  Delete trashes the focused tree row, Enter opens/toggles it. The browser default of each combination is prevented. These listeners are
  on `window`, so they also fire while the side chat input has focus.

### Security and confinement (US-10)
- **AC-11.1** (US-10) Given any vault path from the renderer or a model, when it contains `..`, is absolute elsewhere, or follows a symlink
  out, then the operation fails with "La ruta <path> está fuera de la carpeta de trabajo." Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders"
- **AC-11.2** (US-10) Given a path with a segment starting with `.` (such as `.git/x.md`), when read, written, created, renamed or deleted,
  then it fails with "<path> es una carpeta interna y no se puede usar." Test: tests/knowledge.test.ts › "confines every path to the vault and never touches hidden folders"
- **AC-11.3** (US-10) Given a vault with a hidden `.git` folder, then its contents never appear in the tree, in search results or in the served
  files. Test: tests/knowledge.test.ts › "indexes the vault and finds notes by keyword and by meaning" (search part); tree and protocol parts [gap].
- **AC-11.4** (US-10) Given the OS `shell.openPath` used by "Abrir con la app del sistema", when the file is a program or script
  (`EXECUTABLE` pattern), then Alma refuses ("Alma no abre programas ni scripts.") and audits the denial. [gap]

## 6. Business rules
- **BR-1** The vault is the folder; the files are the source of truth, the search index only mirrors them. (src/coordinator/knowledge/base.ts)
- **BR-2** Paths between layers are vault-relative with `/`; the absolute path is only built in the coordinator after confinement
  (`resolveInWorkspace`, realpath-aware) and in the renderer for "Abrir con la app del sistema". (base.ts, tools/paths.ts, VaultView.tsx)
- **BR-3** Any path with a segment that starts with `.` is hidden: not listed, not indexed, not served, not usable; `node_modules` is also
  skipped by the tree/scan walk. (base.ts `isHidden`, `walk`; main/index.ts protocol)
- **BR-4** Maximum readable note size: 5 MiB (`MAX_NOTE_BYTES`). Larger files are not opened and not indexed. (base.ts)
- **BR-5** Autosave delay: 700 ms after the last keystroke (`AUTOSAVE_MS`). (useVault.ts)
- **BR-6** The watcher is recursive on the vault root; a change schedules a rescan after 400 ms; scans never run concurrently (a second
  request while scanning schedules one more run). (base.ts)
- **BR-7** Only `.md` files are indexed and only `.md` and `.excalidraw` files are loaded as text documents by the editor layer. (base.ts, useVault.ts)
- **BR-8** Trash, not delete: removal goes through the system trash via the main process; the vault root can never be trashed. (base.ts, main/index.ts)
- **BR-9** Tab and UI state lives in the browser storage of the window, per vault where it makes sense: `alma.vault.tabs:<vault>`,
  `alma.vault.expanded:<vault>`, and globally `alma.vault.reading`, `alma.vault.chat`, `alma.mode`. Losing it is harmless. (useVault.ts, VaultSidebar.tsx, VaultView.tsx, App.tsx)
- **BR-10** New-note naming: `Sin título.md`, then `Sin título 2.md`, `Sin título 3.md`…, compared case-insensitively. Drawings: `Dibujo.excalidraw`, `Dibujo 2.excalidraw`… (useVault.ts)
- **BR-11** Tree names: `\ / : * ? " < > |` become `-`; trimmed; new notes get `.md` appended unless the name already ends in it. (VaultSidebar.tsx)
- **BR-12** Quick switcher: shows up to 50 results; empty query = most recently modified first. Search panel: query of 2+ characters, 250 ms debounce,
  limit 30, "Por nombre" up to 5 with fuzzy score above 8. (panels.tsx)
- **BR-13** Attachments to the chat are clipped to 15 000 characters. (src/renderer/src/lib/attachments.ts)
- **BR-14** The default location for a new vault is `<Documents>\Alma\Vault`. The welcome note `Bienvenida.md` is written only into a folder with no visible entries. (main/index.ts, coordinator/index.ts)
- **BR-15** Alma's own files inside a vault: `Alma/Recuerdos.md` (memories) and `Alma/Conocimientos/` (AI-written notes); the UI treats them as
  ordinary files that are also summarized in "Lo que sabe Alma". (base.ts; semantics in 009)
- **BR-16** Unsaved edits win over a reload from disk (see AC-8.3). (useVault.ts)
- **BR-17** Files are read and written as UTF-8 text. (base.ts)

## 7. Constraints and risks
- **Layers touched:** renderer `src/renderer/src/vault/*` (`VaultView.tsx`, `VaultSidebar.tsx`, `panels.tsx`, `NoteEditor.tsx`, `livePreview.ts`,
  `useVault.ts`, `vaultLib.ts`, `DrawingEditor.tsx`, `DocumentPreview.tsx`, `drawing.ts`, `vault.css`), `src/renderer/src/components/Markdown.tsx`,
  `components/ToolCard.tsx` ("Abrir nota"), `App.tsx` (mode, vault switching, side chat), `lib/attachments.ts`; main `src/main/index.ts` (`alma-vault`
  protocol, `trash` host action, `dialog:pickFolder`, `shell:openPath`, `vault:defaultPath`); coordinator `src/coordinator/index.ts` (vault messages,
  `syncVault`, `vault.init`) and `src/coordinator/knowledge/base.ts` (file operations); shared `src/shared/types.ts` (`VaultEntry`, request/event types,
  `Settings.vaults`/`activeVault`).
- **Messages (renderer -> coordinator):** `vault.tree`, `vault.read`, `vault.write`, `vault.create`, `vault.rename`, `vault.delete`, `vault.search`,
  `vault.init`, `knowledge.status`, `knowledge.overview`, `knowledge.forget`. **Events (coordinator -> renderer):** `vault.changed` (renderer bumps
  `vaultVersion`), `knowledge.status`. **Host request (coordinator -> main):** `trash`. **Window API:** `defaultVaultPath`, `pickFolder`, `openPath`.
- **Persistence:** the notes themselves (user-chosen folders); the vault list and the active vault in settings (`vaults`, `activeVault`; default empty);
  UI state in `localStorage` (BR-9). The search index is per vault in `<userData>/knowledge/<sha1(root).slice(0,16)>.db` (009). No UI removes a vault from the list.
- **Tools exposed to agents:** none from this spec's UI; the tools are in `src/coordinator/knowledge/tools.ts` (009) and `excalidraw_draw` (021). The
  `trash` request is a host action, not a tool.
- **Security / privacy:** every path is confined; hidden folders are unusable; `alma-vault://` serves only the active vault, refuses hidden segments and
  symlink escapes, and is allowed by the window CSP for `img-src`, `connect-src` and `frame-src`; remote images are blocked by the CSP. Vault content is
  user data; it leaves the machine only when it is sent to a model provider as search results/context/attachments (009, 002). The audit log records
  `vault.trash` with the vault-relative path and `actor: 'agent'`. Update `docs/security/` only if this changes.
- **Platform:** Windows paths: the renderer builds `settings.activeVault + '\\' + path` for `openPath`; case-insensitive name collision checks in the
  renderer; `fs.watch` recursive is native on Windows (not guaranteed on Linux); `rename` allows case-only renames.
- **Performance:** every change re-stats the whole vault (about 50 ms for 500 notes, noted in code); the renderer re-reads every open document and the
  whole tree on each `vault.changed`; the tree is not virtualized.
