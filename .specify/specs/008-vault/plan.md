# 008 — Plan

## 1. Approach
The vault is the folder itself: Alma keeps no copy of the notes. The coordinator owns every file operation through one class,
`KnowledgeBase` (`tree/read/write/create/rename/delete`), and the renderer is a thin editor over six `vault.*` requests plus one
`vault.changed` event. A recursive `fs.watch` with a 400 ms debounce is only a *signal that something changed*; the renderer then
re-reads the tree and its open documents, so agents and other apps can edit the same folder. The editor is CodeMirror 6 with a
small live-preview plugin; images are served to the window through an `alma-vault://` protocol that main confines to the active
vault. Removal goes to the system trash through a host request, because only main owns `shell`.

Rejected: a notes database (or copying notes into `<userData>`), which would lock the notes inside Alma and need import/export.
See [ADR 0006](../../../docs/adr/0006-vault-as-plain-markdown.md). Also rejected: letting the renderer touch the disk
(forbidden by the layer rules; every path would need its own confinement).

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`VaultEntry`, `vault.*` requests, `vault.changed`, `Settings.vaults/activeVault`, `HostRequest` `trash`), `src/shared/desktop-api.ts` (`pickFolder`, `openPath`, `defaultVaultPath`) | types used by renderer, main and coordinator |
| coordinator | `src/coordinator/knowledge/base.ts` (file operations, `isHidden`, `walk`, watcher), `src/coordinator/tools/paths.ts` (`resolveInWorkspace`, realpath-aware confinement), `src/coordinator/index.ts` (`syncVault`, `activeVault`, request handlers, `vault.init`) | all disk access and confinement; the renderer never sees an absolute path |
| main | `src/main/index.ts` (`alma-vault` protocol, `trash` host action, `dialog:pickFolder`, `shell:openPath`, `vault:defaultPath`), `src/preload/index.ts` | owns `electron` (`protocol`, `shell`, `dialog`); re-checks the path is inside the active vault |
| renderer | `src/renderer/src/vault/` (`VaultView.tsx`, `VaultSidebar.tsx`, `panels.tsx`, `NoteEditor.tsx`, `livePreview.ts`, `useVault.ts`, `vaultLib.ts`, `DrawingEditor.tsx`, `DocumentPreview.tsx`, `drawing.ts`, `vault.css`), `src/renderer/src/components/Markdown.tsx`, `src/renderer/src/components/ToolCard.tsx`, `src/renderer/src/lib/attachments.ts`, `src/renderer/src/App.tsx` | screens and UI state only |

Pure helpers (`fuzzyScore`, `resolveAsset`, `buildTree`, `noteName`) stay in `vaultLib.ts`: only the renderer uses them.

## 3. Contracts
- `VaultEntry { path; kind: 'file' | 'folder'; size; mtime }`, paths vault-relative with `/`.
- Requests (renderer → coordinator): `vault.tree`, `vault.read { path }`, `vault.write { path; content }`,
  `vault.create { path; entry: 'file' | 'folder' }`, `vault.rename { from; to }`, `vault.delete { path }`, `vault.search { query; limit? }`,
  `vault.init { path }`, `knowledge.status`, `knowledge.overview`, `knowledge.forget { text }` (the last three belong to
  [009](../009-knowledge-and-memory/spec.md); here only their UI use).
- Event: `vault.changed` (the renderer bumps `vaultVersion`). Host request coordinator → main: `{ action: 'trash'; path }`
  answering `{ ok, message? }`.
- `KnowledgeBase`: `tree(): Promise<VaultEntry[]>`, `read(path): Promise<{ content; mtime }>`, `write(path, content): Promise<{ mtime }>`,
  `create(path, kind)`, `rename(from, to)`, `delete(path)`, `resolve(path): string` (throws `ToolError` outside the vault or in a hidden folder).
- Protocol `alma-vault://file/<path>`; window API `pickFolder()`, `openPath(path)`, `defaultVaultPath()`.
- No agent tool is added by this feature, so no `ToolRisk` applies; `trash` is a host action, not a tool.

## 4. Data and persistence
- Notes: user-chosen folders, UTF-8, read/written whole (5 MiB read cap).
- Settings (`settings.json`, main): `vaults: string[]` and `activeVault: string`, both empty by default. No UI removes a vault from the list.
- UI state in `localStorage`: `alma.vault.tabs:<vault>`, `alma.vault.expanded:<vault>`, `alma.vault.reading`, `alma.vault.chat`, `alma.mode`.
  Losing it is harmless.
- Search index: per vault under `<userData>/knowledge/` (owned by 009).
- Nothing to migrate; a vault is just a folder, and a folder without notes gets `Bienvenida.md` only through `vault.init`.

## 5. Dependency injection
- `KnowledgeBase` receives `{ root, dataDir, embedder, trash, onStatus, onChanged }`. Tests pass a temp folder, a fake embedder
  (hashed bag of words) and no real trash; `trash` is only a function, so the file operations are testable without Electron.
- The coordinator calls `trash` through the host-request channel; main's handler gets the active vault from settings.
- The renderer reaches the coordinator only through `window.desktop` and its typed `coordinator` client; there is nothing to
  inject, which is why most of the UI is verified by hand.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-2.12, AC-4.6, AC-11.1, AC-11.2 | `tests/knowledge.test.ts` → `confines every path to the vault and never touches hidden folders` | `../fuera.md`, `..\..\fuera.md`, `.interna/x.md`, deleting the vault root |
| AC-11.3 | `tests/knowledge.test.ts` → `indexes the vault and finds notes by keyword and by meaning` (search part) | a hidden folder with a matching note |
| AC-1.2, AC-1.5, AC-2.1, AC-2.3, AC-2.5, AC-2.6, AC-2.8, AC-2.13, AC-4.3–4.5, AC-4.7, AC-4.8, AC-5.3, AC-5.7, AC-6.2, AC-6.5, AC-7.4, AC-8.1–8.6, AC-11.4 | [gap] | see Backlog below |
| AC-1.1, AC-1.3, AC-1.4, AC-2.2, AC-2.4, AC-2.7, AC-2.9–2.11, AC-2.14, AC-3.1–3.5, AC-4.1, AC-4.2, AC-4.9–4.11, AC-5.1, AC-5.2, AC-5.4–5.6, AC-5.8, AC-6.1, AC-6.3, AC-6.4, AC-7.1–7.3, AC-7.5, AC-7.6, AC-9.1, AC-9.2, AC-10.1 | [manual] | run the app with an empty `activeVault`, then with a vault of notes, images and a drawing; try each gesture |

Backlog: the `[gap]` rows are the first candidates for tests (`vault.rename` onto an existing name, `vault.create` on an existing
path, `fuzzyScore`, `resolveAsset`, the 5 MiB cap, the `trash` host check). `fuzzyScore`, `resolveAsset` and the name sanitizer are
pure and sit where a renderer-free test can import them.

## 7. Security and privacy impact
- No new tool and no new risk class. Every path from the renderer or a model is confined (`resolveInWorkspace`, realpath-aware);
  segments starting with `.` and `node_modules` are never listed, indexed, served or usable.
- `alma-vault://` serves only the active vault, answers 404 for hidden segments and symlink escapes; the window CSP allows it for
  images and blocks remote images.
- `trash` is re-checked in main (inside the active vault, never the root) and audited as `vault.trash`.
- "Abrir con la app del sistema" refuses programs and scripts (`EXECUTABLE`) and audits the denial.
- Vault content leaves the machine only as search results, context or attachments sent to a model provider.
- `docs/security/CONTROLS.md` (file-opening row) and `docs/security/PRIVACY.md` (vault row) already describe this; they are
  checked, not extended, unless a rule above changes.

## 8. Rollout
- No flag. The default is no vault: the Vault tab shows the welcome screen ("Tu vault") until a folder is created or opened;
  the default location offered is `<Documents>\Alma\Vault`.
- Existing settings without `vaults` / `activeVault` merge over the empty defaults. The first vault opened gets `Bienvenida.md`
  only if the folder has no visible entries.
