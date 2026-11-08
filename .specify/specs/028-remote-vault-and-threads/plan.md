# 028 — Plan

<!-- Written after spec.md became `ready` (human, 2026-11-08). Contracts and signatures only, never logic. Grounded in the working tree of 2026-11-08 (026 mostly implemented; the owner's session already changed AC-8.7 `mergeState`/`nextSince`, the `alma-shell-v5` cache, the single-run `Pair.tsx` and the stable-effect fix in `Cameras`/`Home`: not redone here). -->

## 1. Approach
Reuse, never copy. The phone gets eight new narrow-API operations that sit in the same `RemoteChannel` pipeline as every other route (Host/Origin, session, rate limit, strict schema, `authorizeRemote`, handler, audit). Notes go through the existing `KnowledgeBase` (`tree`, `read`, `resolve` confinement) and a **pure** reachability/listing layer moved to `src/shared/vault`; conversations go through the existing thread store and the **same** `startRun` entry (`deps.ask`), abort (`deps.cancel`) and approval broker the shared remote thread uses. The only new stateful piece is `RunTies` (in memory: which device started which run), which gives "one run per device", "approvals only for runs the device started" and "abort on access cut".

Rejected: (a) a second read path for notes in `coordinator/channels` (breaks AC-7.4); (b) a separate chat loop for by-id sends (breaks AC-7.5); (c) a per-device approval store (the broker already owns pending approvals, we only filter by `threadId` + `RunTies`). No ADR: nothing here is hard to reverse (no new dependency: `react-markdown` and `remark-gfm` are already root dependencies and are bundled into the PWA by the existing `vite.remote.config.ts`; no storage format; no new third party).

## 2. Layers touched
| Layer | Files (new `+` / changed `~`) | Why it lives there |
|---|---|---|
| shared | `~ types.ts` (`RemoteScope` += `'vault' \| 'history'`; `RemoteSettings` += `continueHistory`, `vaultExcluded`); `~ remote/settings.ts`; `~ remote/confirmations.ts`; `~ remote/authorize.ts`; `~ remote/api.ts` (routes, bodies, `Refusal`); `+ remote/wire.ts` (zod-free response types the PWA may import); `+ remote/status.ts` (`statusView`); `+ vault/paths.ts` (pure vault rules, moved/new); `+ threads.ts` (`isCompanyThread`, `listableThreads`); `~ remote/limits.ts` (stale "STUB" header only); `~ i18n/{es,en}/remote.ts`, `~ i18n/{es,en}/main.ts` | Pure, used by 2+ layers (coordinator, renderer, main, PWA via `shared/remote/*` only) |
| coordinator | `+ channels/remote/notes.ts` (`NotesFlow`); `+ channels/remote/threads.ts` (`ThreadsFlow`); `+ channels/remote/runs.ts` (`RunTies`); `+ channels/remote/thread-view.ts` (pure window/fit extracted from `ChatFlow`); `~ channels/remote/chat.ts`, `approvals.ts`, `push.ts`, `channel.ts`, `audit.ts`, `transport.ts` (`REFUSAL_STATUS`), `devices-admin.ts` (device-gone hook), `tailscale-transport.ts` (CSP, pending Q5); `~ knowledge/base.ts` (`readBytes`, read-only, confined with `resolve`); `~ index.ts` (wiring only) | Where agents, threads and I/O live |
| main | `~ messages.ts` (`remoteDialog`, new kinds); `~ index.ts` (exclusion-move entry, pending Q6); `~ settings.ts` only if sanitize needs nothing new (it already calls `sanitizeRemote`) | Native confirmations and settings on disk |
| renderer | `~ remote/ScopesCard.tsx` (two scopes + sub-switch); `+ remote/ExclusionCard.tsx`; `~ vault/vaultLib.ts` (re-export from `shared/vault/paths`); `~ App.tsx` (use `listableThreads`, one definition of "Chat tab list") | The PC "Remote access" tab (spec 006/026/023) |
| remote-client | `~ App.tsx`, `~ usePwa.ts`, `~ screens/{Chat,Home,Cameras,Settings,Header,Approvals}.tsx`, `+ screens/{Notes,Note,Conversations,Conversation,StateView}.tsx`, `+ lib/{notes,threads,outcome,screen-state,nav,markdown,can,latest}.ts`, `~ i18n/{index,es,en}.ts`, `~ pwa.css`, `~ public/sw.js` (SHELL bump) | The phone app; imports only `remote-client/` and `shared/remote/` |
| tests | see §6 | |
| docs | see T63-T66 | Constitution V: same PR |

No new arrow breaks `docs/architecture.md`. Two **new** architecture rules (T60) keep the new modules honest.

## 3. Contracts
Signatures only. Scope ids are `'vault'` (the "Notes" scope, key `remote.scope.vault`) and `'history'` (key `remote.scope.history`), which is what `main/messages.ts` already composes as `` `remote.scope.${scope}` ``.

### 3.1 Settings (shared)
```ts
export type RemoteScope = 'chat' | 'approve' | 'home' | 'cameras' | 'vault' | 'history'
export interface RemoteSettings {
  /* existing fields unchanged */
  continueHistory: boolean        // sub-switch under History; off at every turn-on
  vaultExcluded: string[]         // vault-relative folders, kept across turn-ons
}
// sanitizeRemote: invalid items of vaultExcluded are dropped one by one; a non-array value
// resets the list AND forces scopes.vault=false (fail closed: a lost exclusion list must not widen access).
export function planRemoteChange(before: RemoteSettings, after: RemoteSettings, dormantNames: string[], context: { activeVault: string }): { confirmations: RemoteConfirmation[]; next: RemoteSettings }
export type RemoteConfirmation = /* existing */ | { kind: 'scope'; scope: RemoteScope; vaultFolder?: string } | { kind: 'continue' } | { kind: 'unexclude'; folder: string }
```
Order (fixed, tested): enable, scopes in `['chat','approve','home','cameras','vault','history']`, `sensitive`, `continue`, cameras in list order, then removed exclusions in list order. Turn-on resets the six scopes, `sensitive` and `continueHistory` and keeps `cameras` and `vaultExcluded`. Adding an exclusion asks nothing. Removing one asks, also while remote is off (same precedent as adding a camera).

### 3.2 Routes (shared/remote/api.ts)
All new routes are `auth: 'session'`, POST (the schema validates a body; the channel already rejects invalid bodies before any handler). `RouteSpec` gains `continue?: true` (route needs the sub-switch) and `audit` gains `'open'` (writes an entry with a target, outcome `ok` or `error`).
| Method + path | scope | extra | audit | body (strict) |
|---|---|---|---|---|
| POST `/api/notes/list` | `vault` | | none | `{ folder: string<=PATH_MAX }` (`''` = root) |
| POST `/api/notes/find` | `vault` | | none | `{ query: string<=200 }` |
| POST `/api/notes/read` | `vault` | | open | `{ path: string<=PATH_MAX }` |
| POST `/api/notes/image` | `vault` | | open | `{ target: string<=PATH_MAX, from: string<=PATH_MAX }` (`from=''` when opened directly) |
| POST `/api/threads/list` | `history` | | none | `{ offset: int>=0 }` |
| POST `/api/threads/read` | `history` | | open | `{ id, before?: int>=0, since?: int>=0, wait?: boolean }` |
| POST `/api/threads/send` | `history` | `continue` | open | `{ id, text: string<=chatChars }` |
| POST `/api/threads/stop` | `history` | | open | `{ id }` |
`PATH_MAX = 1024`, `id: string 1..64` (technical bounds, see §10). `GET /api/status` is reshaped (§3.4). `GET /api/state` and `GET /api/approvals` keep their routes and become device-aware (§3.5). `ROUTES` stays the closed list; no rename/delete/search/write route exists (AC-2.7, AC-3.7).

`Refusal` gains: `'write-off'` (403), `'unavailable'` (404, notes, files, images: one answer), `'gone'` (404, threads: missing = company), `'unsupported'` (415), `'run-active'` (409). `'busy'` (409) is reused for `thread.busy`; `'too-large'` (413) for note and photo. `REFUSAL_STATUS` is a `Record<Refusal, number>`, so a new refusal without a status fails typecheck.

### 3.3 Wire types (shared/remote/wire.ts, types only, importable by the PWA)
```ts
export interface NoteEntry { name: string; kind: 'file' | 'folder'; size: number; mtime: number }   // no absolute path, ever
export interface NoteList { folder: string; entries: NoteEntry[] }        // vault.none is a refusal-free state: { vault: 'none' }
export type NoteListResult = { vault: 'none' } | NoteList
export interface NoteFound { path: string; name: string }                  // <= 50
export interface NoteText { path: string; content: string; mtime: number }
export interface NoteImage { photo: string /* base64 */; mediaType: string }
export interface ThreadRow { id: string; title: string; agentId: string; channel?: string; updatedAt: number; current: boolean }
export interface ThreadPage { rows: ThreadRow[]; more: boolean }
export interface ThreadWindow { rev: number; running: boolean; waiting: boolean; messages: { index: number; role: 'user' | 'assistant'; text: string; at: number }[]; earlier: boolean }
export interface StatusView { scopes: Record<'chat' | 'approve' | 'home' | 'cameras' | 'vault' | 'history', boolean>; sensitive: boolean; continue: boolean }
```
`ApprovalView` (api.ts) gains `thread?: string` (absent = the shared remote thread).

### 3.4 Status (AC-6.11)
`statusView(remote: RemoteSettings): StatusView` (pure, shared/remote/status.ts). `/api/status` returns exactly `StatusView` (the existing `deviceId` field is dropped; the phone already holds it).

### 3.5 Run ties and approvals (coordinator)
```ts
export interface RunTies {
  start(deviceId: string, threadId: string): { ok: true } | { error: 'run-active' }
  end(deviceId: string, threadId: string): void
  activeFor(deviceId: string): string | null
  ownerOf(threadId: string): string | null
  abortWhere(predicate: (tie: { deviceId: string; threadId: string; shared: boolean }) => boolean, cancel: (threadId: string) => void): number
}
// ApprovalsFlow.list(deviceId): shared-thread approvals + approvals whose threadId is owned by deviceId.
// ApprovalsFlow.answer(deviceId, id, decision): same visibility rule; anything else answers 'already-answered'.
// ChatFlow.state(since, deviceId); waiters carry deviceId so approvals are built per device.
// PushFlow.notify(approval): shared thread -> every subscribed device (as 026); owned thread -> only its owner.
```

### 3.6 Injected dependencies (RemoteDeps additions)
```ts
interface RemoteVault {
  state(): 'none' | 'ready'                          // no active vault, or its folder is missing
  tree(): Promise<VaultEntry[]>
  readText(path: string): Promise<{ content: string; mtime: number }>
  readBytes(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; mtime: number }>   // new KnowledgeBase method, confined by resolve()
}
vault(): RemoteVault | null
threads: { list(): ThreadSummary[]; get(id: string): Thread | undefined; isRunning(id: string): boolean }
```
`ask`, `cancel`, `pendingApprovals`, `respondApproval`, `onEvent`, `record`, `settings` are reused unchanged. Company detection uses `settings().agents` through `isCompanyThread`.

### 3.7 Pure shared vault API (shared/vault/paths.ts)
```ts
export const IMAGE_EXT: RegExp; export function fileKind(path: string): 'note' | 'image' | 'other'
export function fuzzyScore(query: string, text: string): number                      // moved from renderer vaultLib, behavior frozen by a characterization test
export function isExcluded(path: string, excluded: readonly string[]): boolean       // vault-relative, case-insensitive, covers subfolders
export function isReachable(path: string, excluded: readonly string[]): boolean      // no dot segment, no node_modules segment, not excluded, not absolute, no '..'
export function listFolder(entries: VaultEntry[], folder: string, excluded: readonly string[], language: Language): NoteEntry[]
export function findByName(entries: VaultEntry[], query: string, excluded: readonly string[], limit: 50): { path: string; name: string }[]
export function resolveVaultAsset(target: string, notePath: string, entries: VaultEntry[]): string | null   // PC rules (relative, exact, by file name), vault path not URL
export function staleExclusions(excluded: readonly string[], entries: VaultEntry[]): string[]
export function moveExclusions(excluded: readonly string[], from: string, to: string): string[]
```
`shared/threads.ts`: `isCompanyThread(agentId: string, agents: { id: string; companyId?: string }[]): boolean`, `listableThreads<T extends { agentId: string }>(rows: T[], agents): T[]`.

### 3.8 PWA contracts (remote-client/lib)
```ts
export type Operation = 'notes.list' | 'notes.find' | 'notes.read' | 'notes.image' | 'threads.list' | 'threads.read' | 'threads.send' | 'threads.stop' | 'chat' | 'home' | 'cameras' | 'status'
export type Outcome = { ok: true } | { ok: false; reason: Refusal | 'network' | 'not-delivered' }
export function outcomeKey(reason: Refusal | 'network' | 'not-delivered', operation: Operation): PwaKey   // Record<Refusal,...>: exhaustive by type
export type ScreenState<T> = { kind: 'loading'; since: number } | { kind: 'content'; data: T } | { kind: 'empty' } | { kind: 'error'; key: PwaKey; retry: boolean } | { kind: 'scopeOff'; key: PwaKey } | { kind: 'unreachable' } | { kind: 'revoked' }
export function nextScreenState<T>(prev: ScreenState<T>, event: ScreenEvent<T>, now: number): ScreenState<T>   // content is dropped on any non-content event (AC-1.6, AC-4.2)
export type Route = { tab: 'chat'|'notes'|'home'|'cameras'|'settings'; view: 'top' | 'conversations' | 'conversation' | 'folder' | 'note'; ... }
export const NAV_ORDER: readonly ['chat','notes','home','cameras','settings']
export function navReduce(route: Route, action: NavAction): Route
export function classifyLink(href: string, notePath: string): { kind: 'note'; path: string } | { kind: 'external'; url: string } | { kind: 'blocked' }
export function mergeWindow(prev: ThreadWindow | null, next: ThreadWindow): ThreadWindow    // by index; earlier pages prepend; no cap at 30 once the person loads earlier
export function canList(status: StatusView): { key: PwaKey; on: boolean }[]
```
`translatePwa(language, key, params?)` gains `{name}` interpolation (needed by `remote.pwa.version`).

### 3.9 New and changed UI text keys
Table of §6.1 of the spec, plus the keys its ACs need that the table does not list (proposed text in the dictionaries at T10/T45; the spec table should get them at T64): `main.remote.scope.vaultDetail` (the vault folder line of AC-1.2), `remote.pwa.can.chat` / `.home` / `.cameras` / `.notes` / `.threads` / `.on` / `.off`, `remote.pwa.notes.title`, `remote.pwa.notes.find` (field label), `remote.pwa.nav` (aria-label of the bar), `remote.pwa.thread.compose` (field label), `remote.pwa.error.invalid` (a request the PC rejected as malformed), `remote.pwa.error.generic`-free: every outcome has a concrete key (AC-6.3).

## 4. Data and persistence
- Settings: three new members of `settings.json` `remote` (`scopes.vault`, `scopes.history`, `continueHistory`, `vaultExcluded`). Old files load through `sanitizeRemote` field by field: missing = off / empty, nothing migrates.
- `RunTies`: memory only. A coordinator restart ends every run anyway, so nothing is persisted (and "what the phone looked at" is not stored: AC-4.5).
- Threads: no schema change. A phone-started run writes into the thread file exactly as a PC-started one.
- Audit: new `remote.*` actions, existing hash chain, identifiers only.
- Phone: nothing stored (BR-26). `idb` keeps key/session/subscription only; `sw.js` keeps the shell only.
- Vault: read-only. No file is created, written, renamed or trashed by any new code.

## 5. Dependency injection
`RemoteChannel` receives `vault()`, `threads` and (already) `ask`, `cancel`, `pendingApprovals`, `respondApproval`, `onEvent`, `record`, `settings`, `now`, `post`. `NotesFlow({ vault, settings })`, `ThreadsFlow({ threads, ask, cancel, ties, settings, chat, onEvent })`, `RunTies()` (pure, no clock). The harness `tests/support/remote-harness.ts` gains: a vault fake (an in-memory entry list + file map + byte map + `state` switch + counters of reads, to prove "nothing read when scope off"), a thread fake (`list/get/isRunning` backed by `chat.threads`, a settings `agents` list with one company agent), and per-thread `askCalls`/`cancelCalls` (already present). Confinement tests (T18) use a real temp vault with a real `KnowledgeBase` and a fake embedder as `tests/knowledge.test.ts` does, with a directory junction for the symlink case (works on Windows without elevation).

## 6. Test strategy
Every test title carries `AC-x.y (028)`. IDs repeat across specs and `tests/specs.test.ts` matches an id anywhere in `tests/`, so a 026 test would satisfy a 028 id by accident: the **close-out task (T69) replaces every `[gap]` with an explicit `Test: tests/x.test.ts › "title"`**, which is the strong gate.

| AC | Test file → name (prefix) | Adversarial cases |
|---|---|---|
| 1.1 | `tests/remote-notes-scopes.test.ts` → `AC-1.1 (028) verdicts…`; `tests/remote-threads.test.ts` → `AC-1.1 (028) scope off reads nothing…` | vault fake read counter = 0; send with continue off = `write-off` and `ask` never called; Chat tab unaffected |
| 1.2 | `remote-notes-scopes` → `AC-1.2 (028) plan order…`; `tests/remote-main.test.ts` → `AC-1.2 (028) dialogs…` | several at once; denied second dialog saves nothing; off asks nothing; vault folder named |
| 1.3 | `remote-notes-scopes` → `AC-1.3 (028) turn-on resets…` | list kept; malformed settings sanitize fail closed |
| 1.4 | `remote-notes-scopes` → `AC-1.4 (028) stripRemotePatch…` | patch with only new keys strips to nothing |
| 1.5 | `tests/remote-tools.test.ts` → `AC-1.5 (028) no tool…` | scan of tool registry and sources for the new keys |
| 1.6 | `remote-threads` → `AC-1.6 (028) next request refused…`; `remote-notes` same; `tests/remote-client-states.test.ts` → `AC-1.6 (028) content is dropped…` | scope off, remote off, revoke, kill switch; open long poll released |
| 1.7 | `remote-notes`, `remote-threads` → `AC-1.7 (028) unknown device…` | iterate the eight routes; body identical to another route's refusal |
| 1.8 | `remote-notes-scopes` → `AC-1.8 (028) excluding asks nothing…` | |
| 1.9 | `tests/remote-vault-logic.test.ts` → `AC-1.9 (028)…`; `remote-notes` → `AC-1.9 (028) typed, linked, embedded…` | case change `PRIVATE/`, subfolder, `..` back into it, backslash, trailing slash |
| 1.10 | `remote-notes-scopes` + `remote-main` → `AC-1.10 (028)…` | removal while remote off; denied keeps the folder |
| 1.11 | `remote-vault-logic` → `AC-1.11 (028) move and stale…`; rendering manual (T43) | outside rename = stale, new path not excluded; prefix rewrite for descendants |
| 2.1 | `remote-vault-logic` + `remote-notes` → `AC-2.1 (028)…` | 1,000 entries, collation ñ, hidden, excluded, `Alma/` listed |
| 2.2 | `remote-notes` → `AC-2.2 (028)…`; `remote-client-states` → key mapping | folder empty vs vault none vs folder missing mid-session |
| 2.3 | `remote-notes` → `AC-2.3 (028) text as UTF-8…`; `tests/remote-client-notes.test.ts` → `AC-2.3 (028) frontmatter hidden, wiki links plain…` | CRLF, BOM, frontmatter only |
| 2.4 | `remote-vault-logic`, `remote-notes` → `AC-2.4 (028) one answer…` | missing, folder, `..`, absolute, `.git/x.md`, junction out, `node_modules`, excluded: response bytes identical |
| 2.5 | `remote-notes` → `AC-2.5 (028)…` | exactly 1 MB passes, +1 byte refused, no partial |
| 2.6 | `remote-notes` + `remote-client-notes` → `AC-2.6 (028)…` | changed and deleted between list and open |
| 2.7 | `remote-notes-scopes` → `AC-2.7 (028) route snapshot…`; `remote-notes` → no absolute root in any body | |
| 2.8 | `remote-notes-scopes` → `AC-2.8 (028)…`; `remote-notes` handler not called | missing, number, 1025 chars, extra key |
| 2.9 | `remote-notes` → `AC-2.9 (028) shared limit…` | 60 mixed list/read/image then 429 |
| 2.10 | `remote-vault-logic`, `remote-notes` → `AC-2.10 (028)…` | empty query, 51 matches, hidden/excluded never, content never matched |
| 2.11 | `remote-notes` → `AC-2.11 (028)…` | 2 MB passes, +1 refused with the note still rendering (client key) |
| 2.12 | `remote-client-notes` → `AC-2.12 (028) nothing remote, nothing executes…` (`renderToStaticMarkup`; falls back to [manual] if vitest cannot render TSX) | `<script>`, raw HTML, `![x](https://evil/x.png)`, `javascript:` |
| 2.13 | [manual] checklist in T58 | |
| 2.14 | `remote-notes` + `remote-client-states` → `AC-2.14 (028)…` | `.excalidraw`, `.pdf`, `.docx`; still listed |
| 2.15 | `remote-client-notes` → `AC-2.15 (028) links…` | `../x.md#h`, encoded, `mailto:`, `javascript:`, absolute path |
| 3.1 | `remote-threads` + `remote-vault-logic` → `AC-3.1 (028)…` | 31 threads, company agent hidden, newest first, same function as renderer |
| 3.2 | `remote-threads` + `remote-client-states` → `AC-3.2 (028)…` | |
| 3.3 | `remote-threads` → `AC-3.3 (028)…` | tool-only messages dropped, thinking never, 1 MB fit, earlier page |
| 3.4 | `remote-threads` → `AC-3.4 (028) one answer…` | unknown id vs company id: identical bytes |
| 3.5 | `remote-threads` + `remote-client-states` → `AC-3.5 (028)…` | deleted by retention while open |
| 3.6 | `remote-threads` → `AC-3.6 (028)…` | 8000 ok, 8001 `invalid`/`tooLong`; ask throws = failed; user message first |
| 3.7 | `remote-threads` + `remote-notes-scopes` snapshot → `AC-3.7 (028)…` | send into company id |
| 3.8 | `remote-threads` → `AC-3.8 (028)…` | PC-run, other phone, nothing queued, `ask` not called |
| 3.9 | `tests/remote-runs.test.ts` → `AC-3.9 (028) waiting…` | approve off, approval stays pending for the broker |
| 3.10 | `remote-threads` → `AC-3.10 (028)…` | after "New conversation" the old shared thread loses the mark |
| 3.11 | `remote-threads` + `remote-client-notes` → `AC-3.11 (028)…` | wait released on message, on run end, on `close()`, after 25 s |
| 3.12 | `remote-threads` + `remote-client-notes` → `AC-3.12 (028)…` | astral characters, CRLF, 10,000-char line |
| 3.13 | `remote-runs` → `AC-3.13 (028)…` | telegram/voice/whatsapp kind threads; harness `post` and any channel fake record zero calls (see Q8) |
| 3.14 | `remote-threads` → `AC-3.14 (028)…` | by-id send to the shared id behaves as Chat; other id never re-points `conversation()` |
| 3.15 | `remote-runs` → `AC-3.15 (028)…` | publish always asks, no "always", answered elsewhere = alreadyAnswered, 1500 cut |
| 3.16 | `remote-runs` → `AC-3.16 (028)…` | PC-, Telegram-, other-phone-started runs invisible and unanswerable |
| 3.17 | `remote-runs` → `AC-3.17 (028)…` | run goes only through `deps.ask`; approval mode read from settings, no phone-specific branch |
| 3.18 | `remote-runs` → `AC-3.18 (028)…` | stop of a run this device did not start is refused; pending approvals denied |
| 3.19 | `remote-runs` → `AC-3.19 (028)…` | Chat-tab run then by-id send, and the reverse |
| 3.20 | `remote-runs` → `AC-3.20 (028)…` | kill switch/remote off/revoke/sweep/forget; History off; continue off; committed text kept |
| 4.1 | `tests/remote-client.test.ts` → `AC-4.1 (028) sw…`; `remote-notes`/`remote-threads` → `no-store` | `/api/notes/*` and `/api/threads/*` never cached |
| 4.2 | `remote-client-states` → `AC-4.2 (028) re-enter refetches…` | |
| 4.3 | `tests/remote-push.test.ts` → `AC-4.3 (028)…` | body empty, headers carry no content |
| 4.4 | `tests/remote-privacy.test.ts` → `AC-4.4 (028)…` | reads make zero `post` calls; send uses `ask` only |
| 4.5 | `remote-privacy` → `AC-4.5 (028)…` | snapshot of `<dataDir>/remote` before/after |
| 4.6 | `remote-privacy` → `AC-4.6 (028)…` | export and erase unchanged |
| 4.7 | `remote-runs` → `AC-4.7 (028)…` | device-run: only owner pushed; unanswerable approvals: none |
| 5.1 | `tests/remote-audit.test.ts` → `AC-5.1 (028)…` | listing/find/list not audited; refused open is `error` |
| 5.2 | `remote-audit` → `AC-5.2 (028) known strings never reach the trail…` | titles, message text, note text, query |
| 5.3 | `remote-audit` → `AC-5.3 (028)…` | throttle one per minute |
| 5.4 | `remote-audit` → `AC-5.4 (028)…` | `record` throws |
| 5.5 | [manual] T38 | automated part: `readRemoteActivity` returns the new entries |
| 6.1 | `remote-client-notes` → `AC-6.1 (028) nav order and current…` + [manual] | |
| 6.2 | `remote-client-notes` → `AC-6.2 (028) back goes up one level…` + [manual] | |
| 6.3 | `remote-client-states` → `AC-6.3 (028) every refusal has exactly one key`, `…state machine…` | a new `Refusal` fails typecheck and the test |
| 6.4 | `remote-client-states` → `AC-6.4 (028)…` | typed message kept, backoff reused, no stale content |
| 6.5 | `remote-client-states` → `AC-6.5 (028)…` | |
| 6.6 | `remote-client-states` → `AC-6.6 (028) retry only where it helps` | |
| 6.7 | `remote-client-states` → `AC-6.7 (028) can-list…` + [manual] | no language switch, no scope control in the screen (source scan) |
| 6.8 | `tests/remote-i18n.test.ts` → `AC-6.8 (028) parity`; `tests/i18n-ratchet.test.ts` → `AC-6.8 (028) the gate covers src/remote-client` | negative fixture |
| 6.9 / 6.10 / 6.12 | [manual] T62 | |
| 6.11 | `remote-notes-scopes` → `AC-6.11 (028) status keys…` | exact key list |
| 7.1 | `remote-notes-scopes` → `AC-7.1 (028) route snapshot` (and the 026 snapshot test updated) | every new route has scope, audit class, strict schema |
| 7.2 | `remote-notes-scopes` → `AC-7.2 (028)…` | same verdict for any caller |
| 7.3 | [manual] PR diff review vs spec §7 | |
| 7.4 | `tests/knowledge.test.ts` → `AC-7.4 (028) readBytes confinement`; `tests/architecture.test.ts` → rule + negative fixture | `..`, absolute, dot, junction |
| 7.5 | `remote-runs` → `AC-7.5 (028) one run path`; `architecture.test.ts` | harness `ask`/`cancel` are the only entries |

## 7. Security and privacy impact
- **ToolRisk:** no new tool, no `ToolRisk` (BR-5, AC-1.5). Reads are not tool calls (BR-12). Runs the phone starts keep each tool's own risk under the unchanged policy; `publish` always asks; in "Permitir todo" `exec` and `write` do not ask, a phone-started run included (R-14 and CONTROLS say so plainly).
- **New data flow:** vault text/images and conversation text leave the PC to the owner's own paired phone over Tailscale (no new third party). A message into a conversation goes to that conversation's provider as any message does.
- **Attack surface:** eight routes behind the same pipeline; a stolen unlocked phone with History + continue on can drive an agent inside a desktop conversation (its folder, tools). Controls: switches, native confirmations, one phone-started run per device, abort on access cut, revoke, 15-day expiry, kill switch.
- **Fail-closed details:** one identical `unavailable` answer for notes and `gone` for threads; corrupt exclusion list forces Notes off; refusals carry no path or title; audit carries identifiers only; `Cache-Control: no-store` forced by the transport on every API response; responses never contain the vault's absolute root.
- **Residual / accepted (document, not mitigate):** a phone can copy or screenshot what it shows; a rename outside Alma moves an excluded folder out of its exclusion (shown as stale, AC-1.11); moving a note out of an excluded folder inside Alma widens access by the person's own act; the approval prompts of Telegram/WhatsApp/voice threads (see Q8).
- **Docs in the same PR:** `docs/security/RISKS.md` R-14, `CONTROLS.md`, `PRIVACY.md`, `docs/modules/remote-access.md`, `docs/modules/security.md`, `docs/context.md`, specs of spec §7.1 (T63-T66).

## 8. Rollout
No flag: the feature is dormant behind its own switches. Every switch is off at every turn-on; the exclusion list is empty on first run; existing installs load with the new scopes off. First run on the PC: the tab shows Notes (read-only) and Conversations with a hint, the sub-switch only while Conversations is on, and an empty exclusion list. First run on the phone: five destinations; Notes and Conversations show `remote.pwa.scopeOff` until switched on. Installed phones get the new shell on the next load because the service-worker cache name is bumped (T67). Turn off: any switch, remote access, the tray kill switch, or revoke.

## 9. Findings: spec vs code (go back to the human; none is answered here)
| # | Finding | Where | Why it matters |
|---|---|---|---|
| Q1 | AC-3.14 says a by-id send into the shared thread has "the same busy rule" as the Chat tab, AC-3.8 says a PC-running thread answers `thread.busy`. Today a Chat-tab send while the **PC** runs in the shared thread answers `failed` (ChatFlow only knows its own `running` flag; `ask` throws). | `chat.ts` `send` | Default in this plan: by-id sends answer `busy` in every case; Chat tab unchanged. Confirm. |
| Q2 | BR-20/AC-3.9: "approve off shows `thread.waiting`". Does the Chat tab's shared-thread run get `waiting` too? Today it shows nothing. | `chat.ts` state | Default: `waiting` is in both `threads/read` and `/api/state`. Confirm. |
| Q3 | BR-18 turns the sub-switch off only at remote turn-on. Turning History off and on again leaves `continueHistory` true with no new confirmation (same as 026's `sensitive` under home today). | `confirmations.ts` | Widening without a dialog. Should History-off also reset the sub-switch (and then asking again)? |
| Q4 | BR-11 says the 2-connections-per-device limit applies, but nothing enforces it: `RateLimiter.open` is never called (026 AC-10.3 is `[gap]`). Live follow adds a second long poll next to `/api/state`. | `limits.ts`, `channel.ts` | Wire it in 028, leave as 026 debt, or lift? |
| Q5 | The PWA CSP is `default-src 'self'; frame-ancestors 'none'`: `img-src` falls back to `'self'`, so `data:` and `blob:` images are blocked. AC-2.11 needs inline images; the camera still already uses a `data:` URL, so it may be broken today (not verified on a phone). | `tailscale-transport.ts:59`, `Cameras.tsx` | T1 verifies; the fix (`img-src 'self' data:`) is a security-surface change to confirm and document. **Verified 2026-11-08 (headless Chrome + CDP, not a phone):** a `data:` image is blocked by the PWA CSP (`img-src` not set, falls back to `default-src 'self'`), so camera stills are broken today too. **Fixed 2026-11-08 (T55, Q15):** `PWA_CSP` is now `default-src 'self'; img-src 'self' data:; frame-ancestors 'none'`; nothing else loosened (no `https:`, no `blob:`), pinned by `tests/remote-tailscale.test.ts` › `AC-2.11 (028) the PWA CSP lets data: images load…`. CONTROLS/RISKS record it in T63. |
| Q6 | AC-1.11: "a rename in Alma's own vault view carries the exclusion along". `vault.rename` goes renderer to coordinator, but the coordinator may not touch `remote` settings (BR-5, `stripRemotePatch`), and a remove+add would trip the `unexclude` dialog. Options: renderer calls a dedicated main entry after a successful rename (plan default, same trust as `settings:update`), or coordinator sends a typed move message. Also: does renaming an ancestor rewrite descendant exclusions (plan default: yes, prefix rewrite)? | `coordinator/index.ts` `vault.rename`, `main/index.ts` | Weakens or keeps BR-5; human decides. |
| Q7 | AC-2.4 and BR-3 list `node_modules` as refused, but 008 BR-3 only skips it in the tree/scan walk: `KnowledgeBase.read('node_modules/x.md')` succeeds today. Plan: the pure `isReachable` rejects it before any read; the desktop is not changed. | `knowledge/base.ts` | Confirm the stricter phone rule is intended (and 008 untouched). |
| Q8 | AC-3.13/BR-34: nothing goes to the conversation's channel. But Telegram, WhatsApp and the voice assistant react to `approval.request` for **their bound thread** (`telegram.ts:293`, `assistant.ts:295`): a phone-started run in the Telegram/voice thread would send the approval prompt (tool name and input) to that chat or speak it, and the first answer there resolves it. | `telegram.ts`, `whatsapp.ts`, `voice/assistant.ts` | New outward flow the spec does not mention. Accept and document, or suppress for runs tied to a phone? |
| Q9 | AC-6.11 says the status operation returns "nothing else"; it returns `deviceId` today. Plan drops it (the phone has it). | `channel.ts` `status` | Minor; confirm. |
| Q10 | 026 `limits.ts` still carries a "STUB: wrong on purpose" header although the values are right. Chore, in T6. | `shared/remote/limits.ts` | Informational. |
| Q11 | `tests/specs.test.ts` matches `AC-x.y` anywhere in `tests/`, so 026 and 028 ids collide. Mitigated by T69; a durable fix (per-spec id scoping) is a gate change for the human to approve (Constitution II). | `tests/support/specs.ts` | Recommendation. |

## 10. Defaults chosen in this plan (technical, not business rules; confirm or change)
Path bound 1024 chars and thread id 1..64 in the schemas; conversation list paged by `offset`, deduplicated by id on the phone; name filter matches **files** only on the path without `.md` (the PC quick switcher, 008 AC-6.1); a refused open is audited with outcome `error`, a served one `ok`; an exclusion removal asks even while remote is off; confirmation order as in §3.1; a note's 1 MB is measured on its UTF-8 bytes (not on the JSON body); `stop` needs History but not the sub-switch (nothing to stop once the sub-switch aborted the run); one `nav` history entry per level using `pushState`; SVG images are shown in `<img>` only.

## 11. UI system references (BR-10; `console-ui` and `umbra-ui` loaded for this plan)
Nothing is invented. **PC tab:** existing `card`, `row`, `remote-sub`, `muted small`, native checkbox inside `.row` (re-themed by `plain-app.css`), the `ScopesCard` pattern of the cameras list for the exclusion rows; no new component, no new token. **Phone:** the existing `--pwa-*` tokens that mirror umbra (`--pwa-bg`, `--pwa-elevated`, `--pwa-glass`, `--pwa-glass-hover`, `--pwa-border(-strong)`, `--pwa-text`, `--pwa-accent(-solid)`, `--pwa-warm`, `--pwa-focus`, `--pwa-danger`, radii `--pwa-r-card/-pill/-sm`, `--pwa-dur`, `--pwa-ease`, `--pwa-glow-soft/-focus`) and classes `.pwa`, `.pwa-header`, `.pwa-note`, `.pwa-error`, `.pwa-spinner`, `.pwa-actions`, `.pwa-card`, `.pwa-muted`, `.pwa-input`, `.pwa-compose`, `.pwa-messages`, `.pwa-user/.pwa-agent`, `.pwa-tabs/.pwa-active`, `.pwa-things`, `.pwa-photo`, button variants `primary/ghost/danger`. Umbra concepts mapped: `Tabs` (the bar, with `aria-current="page"` instead of `aria-pressed`), `MenuList`/`Tile` (folder, note and conversation rows, 44 px), `Skeleton` and `Spinner` (loading), `Modal` (kept native `confirm()` for "Forget this PC" as in 026 AC-8.6), halo focus and `prefers-reduced-motion` already in `pwa.css`; sounds/music are not added (BR-36). **Explicit extensions** (named in T57, using only existing tokens): `.pwa-skeleton`, `.pwa-state` (icon + text + optional retry), `.pwa-back` (header back control), `.pwa-prose` (rendered markdown), `.pwa-badge` (the "current" mark), `.pwa-list` rows; safe-area and keyboard handling via `env(safe-area-inset-bottom)`/`100dvh`. Icons: Lucide at 20 px, stroke 1.75, as the PWA uses today (umbra's default is 24; matching the neighboring code).

## 12. Prerequisite gates (state, not decided here)
- **R-02** (Home Assistant on `0.0.0.0`): **still open** (`docs/security/RISKS.md` marks it Open; `src/coordinator/home/engine.ts:137` still reads `server_host: 0.0.0.0`; 026 `tasks.md` T0 is unchecked). 026 makes T0 a precondition of T23, T24 and T31 (house and listener). 028 adds no listener and touches no house code; only T61 changes how the Home and Cameras **screens** show states of 026's existing routes. Whether 028 may start before T0 merges is the human's call.
- **R-01** (vulnerable dependencies, Electron below 44.9.1): open, blocked on the libsignal/baileys decision. Per 026 OQ-16 it gates a **release** that includes remote access, not implementation. 028 adds no dependency.
- Spec dependency: the separate chat-disappearing `/fix` should land first so the Chat screen under test is stable (spec §7).

## 13. Decisions on Q1-Q11 (taken while the owner slept)

The owner went to sleep after saying "accept everything, go full" (2026-11-08). Q1-Q11 of §9 were answered by the session with the conservative option, so the owner can review and veto each one in the morning. Each is one small change if reversed.

- **Q1** by-id send into the shared thread answers `busy` when the PC runs there; the Chat tab keeps its 026 behavior.
- **Q2** `thread.waiting` (approve scope off) applies to the Chat tab's shared-thread run too.
- **Q3** turning History off also resets the continue sub-switch to off (fail closed); it needs a new dialog to come back.
- **Q4** the 2-connections-per-device limit stays 026 debt (AC-10.3 `[gap]`); 028 does not wire it. Flag in T69.
- **Q5** if T1 shows `data:` images are blocked by the PWA CSP, T55 adds `img-src 'self' data:` only (never `https:`, never `blob:`). Flag it prominently in the final report: it is a security-surface change.
- **Q6** the plan default: a typed call from the renderer to `main`, no dialog, that only rewrites existing exclusion entries and their descendants.
- **Q7** `node_modules` is rejected by the pure `isReachable` check before any read; the desktop is unchanged.
- **Q8** suppress: a phone-started run in a Telegram, WhatsApp or voice thread must not send or speak the approval prompt to that channel (OQ-35: nothing goes out). T35 implements and tests the suppression.
- **Q9** `/api/status` drops `deviceId`.
- **Q10** the stale STUB header in `limits.ts` is removed in T6.
- **Q11** no gate change; T69 writes explicit `Test:` citations for `[gap]` ACs.
- **R-02 (127.0.0.1 engine)** still open. 028 adds no listener and no house code, so it does not block 028 implementation. R-01 gates a release only. Both stay on the owner's list.
- **Q12** (phase 2) an exclusion entry that canonicalizes to the vault root (`/`) fails closed: it excludes everything.
- **Q13** (phase 2) `src/remote-client` may import `shared/vault/` (pure, no I/O) besides `shared/remote/`; T60 updates the architecture rule and pins it with a test.
- **Q14** (phase 0) the dead documentation URL `https://github.com/syntax-tree/hast-util-to-jsx-runtime` (inside a react-markdown error string, never fetched) joins `ACCEPTED_HOSTS` with that reason.
- **Q15** (phase 0) the PWA CSP fix (T55) ships in phase 3 because camera stills are already broken today by the same CSP: `img-src 'self' data:` only.
- **Q16** (phase 3) listing a hidden, excluded or missing folder returns an empty folder (existence is never revealed); the phone cannot say "folder gone" for those. Accepted.
- **Q17** (phase 3) a case-variant path is served under the vault's real casing (follows the case-insensitive exclusion rule); T64 documents it. `find`'s wire type (`{found}` / `{vault:'none'}`) is added in T48; `NotesFlow` exposes the resolved path so T37 can audit images.
- **Q18** (phase 4b) turning only the chat scope off does not abort a shared-thread run (AC-3.20 and BR-35 do not list it); turning approve or Notes off aborts nothing (approve off gives the phone `waiting`). Documented as accepted in R-14.
- **Q19** (phase 4b) quiet-for-phone-runs hides the approval prompt AND the streamed text and tool events from Telegram, WhatsApp and voice for a phone-started thread (a voice turn open at that moment would otherwise speak the phone run's text). The PC window can still answer.
- **Q20** (phase 8b) the list row carries `agentName` (AC-3.1 says which agent answers) and the window carries `ownRun`, so Stop follows the server and survives reopening the conversation.
- **Q21** (review) quality-review findings are fixed in a dedicated pass; the single-flight session renewal (a lost race wiped the phone's device key) is a 026-era bug amplified by 028's parallel requests.
