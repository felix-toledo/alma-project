# 030 — Plan

Spec 030 is `ready` (no Open Questions). This plan does not change §1 to §8 of the spec. Test files and task ids are in `tasks.md`. Where the spec leaves a detail open, §10 lists it as a provisional reading for the human to confirm; none is answered silently.

## 0. Coordination with 029

Spec 029 (`../029-alma-creates-companies/spec.md`) is planned in parallel and edits some of the same files. **Implement 029 first**, then 030, and rebase 030's edits onto it. The shared files:

| File | 029 touches | 030 touches |
|---|---|---|
| `src/coordinator/agent.ts` | `appTools` (company tools), maybe `RunContext` | `appTools` (+`readAttachmentTool`), `RunContext` (+`attachments`), `systemPrompt` (+attachments sentence), the `compactHistory(...)` call site (+expansion) |
| `src/shared/types.ts` | tool/proposal types, maybe `CoordinatorRequest` | `ChatMessage.attachments`, `Thread.lastOpenedAt`, `Settings.attachments`, `CoordinatorRequest` (+5 methods, `chat.send` field), `HostRequest` (+1 action) |
| `src/shared/i18n/es.ts`, `en.ts` (the spread of dictionaries), `.../tools.ts` | new keys | one new file `attach.ts` per language, plus one `...attach` in each spread; tool-result keys live in `attach.ts` too, so `tools.ts` is not edited |
| `src/coordinator/index.ts` | handler cases for company creation | `handle()` delegates to one service (`AttachmentService`); `startRun`, `applyRetention` neighbour, init block |
| `src/main/settings.ts`, `shared/defaults.ts` | possibly | `attachments` default and sanitizer |
| `docs/context.md`, `docs/security/*`, `docs/modules/agents.md`, `.specify/specs/README.md`, specs 003 BR-12 and 015 BR-12 (app-tools list) | yes | yes |

To keep merge conflicts small, 030 puts its logic in new folders (`src/shared/attach/`, `src/coordinator/attachments/`, `src/main/attach.ts`) and touches the shared files above with one-line additions only. The `tools.test` / architecture tests that count the app-tools list must be updated by whichever spec lands second.

## 1. Approach

Everything with a rule in it is a pure function in `src/shared/attach/` (type allow-list by extension and leading bytes, size and per-message limits, folder-drop plan, name hardening, secret-name detection, masking, metadata stripping, sweep decision, the model-facing text, display rules). The coordinator owns the store (`<userData>/inbox/attachments/<id>/<stored name>` plus one record file per attachment), re-validates every upload on the bytes (BR-10), strips picture metadata, runs the 30-day sweep, and exposes the read-only app tool `read_attachment` (risk `read`, `standalone`, takes an id, never a path). The message carries a structured `attachments` list; the model-facing text (heading and one reference line each) is produced at the single place where the history is handed to the provider (`agent.ts`, next to `compactHistory`), so no provider changes. Main only adds a native file picker, reads the bytes of paths the page legitimately holds (drop/paste/picker/folder), and guards "open with the system app". The renderer composes and displays.

**Rejected alternatives** (reasons in spec BR-4, repeated for the record): widening `read_file` to the inbox (would let `list_dir` enumerate every conversation's files); copying files into the working folder (writes into the person's projects); inlining file content in the message (costs tokens every turn); native image blocks (020 BR-14: the agent never holds an image); a library for EXIF (see §9).

**ADR:** none. The storage format (a folder per attachment plus a small JSON record) is easily reversible: the store is disposable after 30 days and nothing else reads it. If the human prefers an ADR for the record format, it is one short file.

**Dependencies:** none new. Metadata stripping is a byte-level rewrite (no image decoder); PDF extraction uses `unpdf` and Office extraction uses the existing `office/*` readers (`exceljs`, `docx`/`jszip`, `pptx`). `pnpm` only; no git dependency is added, so the `libsignal` exception (R-01) is not touched. Decision for the human, only if wanted: an image library (for example `sharp`, a native module) would allow re-encoding, but it changes pixels and adds a native build; this plan does not use one.

## 2. Layers touched

| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | new `src/shared/attach/{rules,classify,plan,names,secrets,exif,sweep,compose,display,request}.ts`; changed `types.ts`, `defaults.ts`, `desktop-api.ts`, `i18n/{es,en}.ts` + new `i18n/{es,en}/attach.ts` (and `main.ts` keys) | pure rules used by renderer (show), coordinator (guard) and main (limits) |
| coordinator | new `src/coordinator/attachments/{store,service,expand,read-tool}.ts`; changed `agent.ts`, `index.ts`, `store.ts` (`ThreadStore`), `tools/types.ts` (`ToolContext.attachments`), `tools/paths.ts` (`inboxFileName` delegates), `tools/home.ts` (`look_at_image` removed error), `tools/office/index.ts` (export a buffer reader), `channels/remote/threads.ts` (phone open hook), `privacy.ts` (comments only; behavior already covers it) | store, index, sweep, tool, history expansion do I/O for an agent |
| main | new `src/main/attach.ts` (pure helpers: read outcomes, folder listing, grants, open guard); changed `index.ts` (IPC handlers, host action, `shell:openPath` guard), `settings.ts` (sanitizer), `src/preload/index.ts` | native dialog and disk reads the page cannot do; `electron` stays in main |
| renderer | `components/ChatView.tsx`, `components/MessageList.tsx`, `lib/attachments.ts`, `App.tsx` (`threads.open`), new `components/AttachmentChips.tsx`, `components/AttachDialogs.tsx`, CSS in `styles.css`/`vault/vault.css` | composer and transcript UI only calling shared functions |

No new arrow breaks `docs/architecture.md`: `shared/attach` imports nothing; it uses `Uint8Array`, never `Buffer` or `node:*`, so the renderer can import it. The vault-attachment module `shared/attachments.ts` is not renamed; the new folder is `attach/` to avoid an ambiguous `./attachments` import.

## 3. Contracts

Signatures and types only.

### 3.1 Shared (`src/shared/attach/`)

```ts
// rules.ts: one constant (BR-13, BR-14, BR-3, BR-7)
export const ATTACH_LIMITS: { maxFileBytes: 2_097_152; maxFiles: 5; maxTotalBytes: 10_485_760; sniffBytes: 8000; sweepDays: 30; sweepEveryMs: 43_200_000 }
export type AttachmentKind = 'image' | 'text' | 'pdf' | 'office'
export const ALLOWED_EXTENSIONS: Readonly<Record<string, AttachmentKind>>   // BR-13 list, lower case, with the dot
export type RefusalReason =
  | 'type' | 'content' | 'empty' | 'too-big' | 'too-many' | 'total'
  | 'unreadable' | 'malformed-image' | 'storage' | 'company' | 'bad-payload'
export type ReadFailure = 'missing' | 'is-folder' | 'denied' | 'busy' | 'unreadable'

// classify.ts
export function classifyFile(name: string, head: Uint8Array, size: number): { ok: true; kind: AttachmentKind; ext: string } | { ok: false; reason: RefusalReason }

// plan.ts
export interface Candidate { name: string; size: number; kind: AttachmentKind }
export function planAdditions(existing: readonly { size: number }[], candidates: readonly Candidate[]): { accepted: Candidate[]; refused: { name: string; reason: 'too-many' | 'total' }[] }
export function planFolderDrop(direct: readonly { name: string; size: number }[], subfolders: number, existing: readonly { size: number }[]): { refuseAll: false; files: ...; skippedFolders: number } | { refuseAll: true; reason: 'too-many' | 'total'; skippedFolders: number }

// request.ts (Zod at the coordinator boundary, AC-2.6)
export const StoreRequestSchema: z.ZodType<{ threadId: string; name: string; size: number; base64: string }>
export function decodedLength(base64: string): number | null          // strict alphabet and padding; null = malformed; computed without allocating

// names.ts
export function sanitizeFileName(name: string): string                 // the character step of today's inboxFileName (letters, digits, _ . -; runs become _; last 60 kept)
export function storedFileName(original: string): string               // sanitizeFileName + reserved names, leading/trailing dots, empty, extension kept
export function defaultPictureName(name: string, now: number): string // 002 AC-5.6

// secrets.ts
export function isSecretLikeName(name: string, path?: string): boolean
export function maskSecrets(text: string): { text: string; masked: number }

// exif.ts
export function stripMetadata(kind: 'jpeg' | 'png' | 'webp' | 'gif', bytes: Uint8Array): Uint8Array   // throws MalformedImageError; gif returned as is
export class MalformedImageError extends Error {}

// sweep.ts (injected clock)
export function isSweepDue(lastOpenedAt: number, now: number): boolean
export function planSweep(records: readonly SweepRecord[], openedAt: Readonly<Record<string, number | undefined>>, running: ReadonlySet<string>, now: number): string[]  // attachment ids whose file should be deleted

// compose.ts (model-facing English, BR-19, BR-21)
export interface MessageAttachment { id: string; name: string; kind: AttachmentKind; size: number }
export const ATTACHMENTS_HEADING: string
export const ATTACHMENTS_SYSTEM_SENTENCE: string
export function attachmentsText(items: readonly (MessageAttachment & { path?: string })[]): string   // heading + "[n] <id> (<name>, <size>)" lines; a picture line carries its path
export function firstMessageTitle(text: string, attachments: readonly MessageAttachment[], untitled: string): string

// display.ts
export function hasThumbnail(a: Pick<MessageAttachment, 'kind'>): boolean            // raster pictures only
export function canOpenWithSystemApp(name: string): boolean                           // BR-25 list
export function unacknowledgedReaders(readers: readonly ProviderId[], acknowledged: readonly ProviderId[]): ProviderId[]
export function canAttachTo(thread: { agentId: string }, agents: readonly { id: string; companyId?: string }[]): boolean   // reuses isCompanyThread
```

`shared/types.ts`:

```ts
export interface ChatMessage { /* existing */ attachments?: MessageAttachment[] }   // BR-21
export interface Thread { /* existing */ lastOpenedAt?: number }                    // BR-16
export interface Settings { /* existing */ attachments: { noticeAcknowledged: ProviderId[] } }  // BR-20, AC-3.1; default []

export type CoordinatorRequest =
  | /* existing, with */ { method: 'chat.send'; threadId: string; text: string; attachments?: string[] }   // ids
  | { method: 'attachments.store'; threadId: string; name: string; size: number; base64: string }          // -> StoreResult
  | { method: 'attachments.remove'; id: string }                                                           // chip X
  | { method: 'attachments.preview'; id: string }                                                          // -> PreviewResult
  | { method: 'attachments.open'; id: string }                                                             // BR-25
  | { method: 'attachments.readers'; threadId: string; images: boolean }                                   // -> ProviderId[]
  | { method: 'threads.open'; threadId: string }                                                           // sets lastOpenedAt

export type StoreResult = { ok: true; attachment: MessageAttachment } | { ok: false; reason: RefusalReason }
export type PreviewResult = { state: 'removed' | 'unknown' } | { state: 'present'; mediaType?: string; base64?: string }   // bytes only for raster pictures

export type HostRequest = /* existing */ | { action: 'attachment.open'; path: string }   // main re-checks root and extension
```

### 3.2 `read_attachment` (coordinator app tool)

```ts
// name: 'read_attachment'   risk: 'read'   standalone: true   (Constitution V; AC-4.6)
schema: z.object({
  id: z.string().describe('Attachment id from the reference line of the message'),   // an id, never a path
  range: z.string().optional().describe('PDF pages, Word paragraphs, PowerPoint slides, Excel/CSV cell range (as office_read)'),
  sheet: z.string().optional().describe('Excel: only this sheet'),
  offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(5000).optional()   // text files, as read_file
})
// result starts with the data line (key tool.attachment.read), then the text; masked count reported; truncateMiddle(text, 60_000)
// errors (ToolError keys): tool.attachment.unknown, .badId, .removed, .binary, .tooBig, .unreadable
```

The tool is added to `appTools(ctx)` unconditionally (like `lookAtImageTool`), so a sub-agent and a thread with no working folder have it (AC-4.6, AC-4.7). It reads through `ctx.attachments`, never through the file system paths of the call.

### 3.3 Injection (`ToolContext` / `RunContext`)

```ts
export interface AttachmentReader {
  lookup(id: string): AttachmentLookup     // strict id pattern checked first; never lists
}
export type AttachmentLookup =
  | { state: 'present'; record: AttachmentRecord; path: string }
  | { state: 'removed'; record: AttachmentRecord }
  | { state: 'unknown' }
export interface AttachmentRecord { id: string; threadId: string; originalName: string; storedName: string; size: number; kind: AttachmentKind; createdAt: number; removedAt?: number }
// ToolContext.attachments?: AttachmentReader     RunContext.attachments?: AttachmentReader
```

### 3.4 IPC main/preload (`shared/desktop-api.ts`, typed; the renderer has no disk)

```ts
attach: {
  /** Preload only: webUtils.getPathForFile; '' when the File has no path on disk (a pasted screenshot). Registers a one-use grant in main. */
  pathOf(file: File): string
  /** Native dialog, several files, no type filter (refusals carry reasons). Grants the returned paths. */
  pick(): Promise<string[]>
  /** stat; for a folder, its direct regular files and the number of other entries. Grants the listed files. */
  inspect(path: string): Promise<PathInfo>
  /** Reads a granted path (size checked before reading); consumes the grant. */
  read(path: string): Promise<PathRead>
}
export type PathInfo =
  | { kind: 'file'; name: string; size: number }
  | { kind: 'folder'; name: string; files: { path: string; name: string; size: number }[]; skipped: number }
  | { kind: 'failed'; reason: ReadFailure }
export type PathRead = { ok: true; name: string; size: number; base64: string } | { ok: false; reason: ReadFailure | 'too-big' }
```

IPC channels: `attach:grant` (send, from `pathOf`), `attach:pick`, `attach:inspect`, `attach:read` — all through the existing `handle()` wrapper (trusted-frame check). Main keeps an in-memory set of granted paths; `inspect`/`read` of a path not granted answers `failed` / `{ok:false, reason:'denied'}`. Rationale: without it, a compromised page could ask main to read any file up to 2 MiB; with it, only paths that came from a real picker result or a real `File` object.

### 3.5 Open with the system app (BR-25, AC-7.5)

The renderer never has the stored path. It calls `attachments.open {id}`; the coordinator checks the record exists, the file is present and `canOpenWithSystemApp(storedName)`, then sends `HostRequest {action:'attachment.open', path}`; main re-checks that the path is inside `<userData>/inbox/attachments/` and the extension is on the same list (the list is shared, imported from `shared/attach/display.ts`) before `shell.openPath`. The existing `shell:openPath` handler additionally refuses any path inside that folder, so there is no other route.

## 4. Data and persistence

- **Store:** `<userData>/inbox/attachments/<id>/<stored name>`, `id` = `crypto.randomUUID()` (unguessable; ids are the capability, BR-24). Strict id pattern checked before any path is built.
- **Index record:** one file per attachment beside the folder, `<userData>/inbox/attachments/<id>.json` (`AttachmentRecord`), written atomically (temp file and rename, like `ThreadStore.flush`), mode `0o600`. It cannot collide with a stored file name because that lives inside `<id>/`. Per-record files were chosen over one `index.json` so a corrupt record loses one attachment, not the index, and there is no shared write to race. The sweep and `lookup` read records from the directory; a record that fails to parse is skipped and logged without names.
- **Sweep:** deletes `<id>/` and sets `removedAt` in the record (the record stays so tools and chips can say "removed" instead of "unknown"); the record is deleted with its conversation.
- **`lastOpenedAt`:** optional field on the thread JSON. Written by a new `ThreadStore.markOpened(id, now)` that **does not** change `updatedAt` (retention, 002 BR-6, and the sidebar order key on `updatedAt`; opening a conversation must not extend retention or reorder the list). Old threads load without it.
- **Settings:** `attachments.noticeAcknowledged: ProviderId[]`, default `[]`, sanitized on load like other settings (unknown ids dropped).
- **Messages:** `ChatMessage.attachments` holds `{id,name,kind,size}` only; the message text block holds what the person typed (kept even when empty, so `compactHistory` still sees a real user message). Threads saved before this spec have none and render as before (AC-7.2).
- **Export and erase:** `EXPORTED` in `privacy.ts` does not list `inbox`, so export excludes the store (AC-5.5); `erasePersonalFiles(inboxDir())` already removes `inbox/` recursively, which contains the store (AC-5.2). Deleting a conversation (person, retention, erase) deletes its files and records at once through a `ThreadStore` delete hook (AC-5.4).
- **Legacy inbox files** (pasted pictures before this spec, Telegram photos, camera stills) are not in the index and are never swept (AC-6.6). Pasted pictures from now on go through the new store (020 BR-13 amendment); Telegram photos still go to `inbox/telegram-<id>.jpg` through `saveInboxImage`, which stays (AC-8.1).
- **Sweep timer:** at coordinator `init` next to `applyRetention()`, then every `ATTACH_LIMITS.sweepEveryMs` (`setInterval(...).unref()`), skipping thread ids in `runs`.

## 5. Dependency injection

- `AttachmentStore(inboxDir, clock, log)` — the directory, an injected `now()` and a logger that takes only ids, kinds, sizes and counts (AC-5.7). Tests use a temp dir and a fake clock.
- `AttachmentService({ store, threads, settings, runs, host })` — handles the six new request methods; `index.ts` `handle()` only delegates. Tests give it a fake `ThreadStore`, fake host and fake settings.
- `ToolContext.attachments` / `RunContext.attachments` — the `AttachmentReader`; `agent.ts` passes it to sub-agents (`ctx` is spread into the sub-run).
- `expandAttachments(messages, lookup)` in `coordinator/attachments/expand.ts` — pure over messages and a lookup function; called once in `runAgent` as `compactHistory(expandAttachments(messages, ctx.attachments))`; the stored thread is never modified.
- `ThreadStore` gets an optional `onDelete(id)` hook and `markOpened(id, now)`.
- Main: `src/main/attach.ts` exports pure helpers taking `fs` functions and the grants set as arguments (tests fake them); `index.ts` is the thin shell.
- Tests fake the provider (`tests/agent.test.ts` fake `Provider`) to assert that nothing is sent until the message is sent.

## 6. Test strategy

Test titles carry `AC-x.y (030)` because ids repeat across specs. Files: **R** `tests/attach-rules.test.ts`, **S** `tests/attach-secrets.test.ts`, **X** `tests/attach-exif.test.ts` (fixtures builders in `tests/support/attach-fixtures.ts`), **T** `tests/attach-store.test.ts`, **L** `tests/attach-tool.test.ts`, **G** `tests/attach-agent.test.ts`, **M** `tests/attach-main.test.ts`, **P** `tests/attach-remote.test.ts`. The renderer has no component tests (Constitution III); its rules are pure functions above, and the UI is verified by the `run` skill.

| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | G → `AC-1.1 (030) storing an attachment sends nothing to any provider` ; T → `AC-1.1 (030) a valid file is stored with a record` | fake provider counts calls = 0; store then no send |
| AC-1.2 | T → `AC-1.2 (030) remove deletes the stored file and its record at once` | unknown id; already removed; id with path characters |
| AC-1.3 | G → `AC-1.3 (030) a failed send keeps the stored attachments and a successful one binds them` | run already active; no agent; an id of another conversation |
| AC-1.4 | R → `AC-1.4 (030) each file is checked on its own and refused ones do not drop accepted ones` | mixed good/bad/oversize batch |
| AC-1.5 | R → `AC-1.5 (030) default picture names` | empty name; `image.png`; real name kept |
| AC-1.6 | manual (Explorer copy of two files, paste) | — |
| AC-1.7 | manual; R covers the shared check → `AC-1.7 (030) any dropped type goes through classify` | vault drag (`text/x-alma-path`) untouched, checked by hand |
| AC-1.8 | manual (dialog, cancel, keyboard, gamepad) ; M → `AC-1.8 (030) pick grants only the returned paths` | cancel returns `[]` |
| AC-1.9 | R → `AC-1.9 (030) folder drop` ; M → `AC-1.9 (030) inspect lists direct regular files only` | subfolders, symlink, over count, over total, empty folder |
| AC-1.10 | manual (composer disabled while running) | — |
| AC-1.11 | R → `AC-1.11 (030) company threads cannot take attachments` (rule); UI manual | agent of a company; deleted agent |
| AC-2.1 | R → `AC-2.1 (030) classify` | `.png` that is `MZ`, SVG, HTML, zip, no extension, `.exe`, `.bat`, NUL at byte 7999 and 8000, UTF-16 text, double extension, upper case |
| AC-2.2 | R → `AC-2.2 (030) size boundary` ; T → `AC-2.2 (030) the coordinator re-checks the real size` | 2 097 152 ok, +1 refused, pictures included |
| AC-2.3 | R → `AC-2.3 (030) per-message count and total` | 6th file; 10 MiB + 1; chips already present |
| AC-2.4 | M → `AC-2.4 (030) read outcomes carry a reason` | missing, folder, EACCES, EBUSY, over limit unread |
| AC-2.5 | T → `AC-2.5 (030) a failing write leaves no partial file and no record` | read-only dir, disk-full fake |
| AC-2.6 | R → `AC-2.6 (030) store payload validation` ; T → same at the service | bad base64, empty, size mismatch, over limit by claim and by bytes, nothing written |
| AC-2.7 | R → `AC-2.7 (030) title from the first attachment` ; G → `AC-2.7 (030) an attachment-only message can be sent` | text plus attachment keeps the text title; long name |
| AC-3.1 | R → `AC-3.1 (030) unacknowledged readers` ; G → `AC-3.1 (030) readers include the vision provider for pictures` | already acknowledged; two providers; no picture |
| AC-3.2 | S → `AC-3.2 (030) secret-looking names` | every pattern of BR-20, case, path segment, `.env.local`, near misses (`environment.txt`) |
| AC-3.3 | X → `AC-3.3 (030) strips metadata` | JPEG Exif+GPS+XMP+IPTC, PNG eXIf/text, WebP EXIF/XMP, pixels/kept segments byte-identical, input not mutated, GIF as is |
| AC-3.4 | X → `AC-3.4 (030) malformed pictures are refused` ; T → `... never stored` | truncated segment, bad lengths, RIFF size mismatch, no IEND |
| AC-3.5 | S → `AC-3.5 (030) masks values and counts them` ; L → `AC-3.5 (030) the tool result says how many were masked` | each BR-20 family, none present, adjacent values, very long text |
| AC-4.1 | R → `AC-4.1 (030) attachments text` ; G → `AC-4.1 (030) the provider receives the heading, reference lines and the system sentence` | picture path line, odd characters in names |
| AC-4.2 | G → `AC-4.2 (030) pictures are never image blocks` | — |
| AC-4.3 | G → `AC-4.3 (030) a non-picture line carries no content` | — |
| AC-4.4 | L → `AC-4.4 (030) text`, `... office and pdf`, `... binary`, `... long result` | NUL file, 60 001 chars, corrupt docx, encrypted PDF |
| AC-4.5 | L → `AC-4.5 (030) ids only` | missing id, removed, `..\x`, absolute path, drive letter, empty, extra-long, uppercase uuid, no listing method |
| AC-4.6 | L → `AC-4.6 (030) risk read, standalone, no approval, read-only mode, no workspace` | |
| AC-4.7 | L → `AC-4.7 (030) any existing id reads, a sub-agent included` | id from another conversation |
| AC-5.1 | R → `AC-5.1 (030) hostile names` | separators, `..`, `CON`, `nul.txt`, trailing dot/space, `a.txt:stream`, control characters, 300 characters, non-Latin, empty; extension kept; two same names stay apart |
| AC-5.2 | T → `AC-5.2 (030) erase removes the store` | |
| AC-5.3 | T → `AC-5.3 (030) layout and record` | |
| AC-5.4 | T → `AC-5.4 (030) deleting a conversation deletes its files` (delete, retention, erase) | other conversations untouched |
| AC-5.5 | T → `AC-5.5 (030) export does not copy attachments` | |
| AC-5.6 | T → `AC-5.6 (030) the same file twice is stored twice` | |
| AC-5.7 | T → `AC-5.7 (030) no log or audit line carries names or contents` | marker in name and content across store, refuse, read, sweep |
| AC-6.1 | R → `AC-6.1 (030) the 30-day rule` ; T → `AC-6.1 (030) sweep deletes due files only` | 29 d 23 h kept, exactly 30 d deleted, clock injected |
| AC-6.2 | T → `AC-6.2 (030) sweep skips running conversations` ; G → `AC-6.2 (030) the scheduler runs at start and every 12 hours` | fake timers |
| AC-6.3 | T → `AC-6.3 (030) opening restarts the clock and a deleted file stays deleted` | |
| AC-6.4 | manual (delete a stored file, reopen); L → `AC-6.4 (030) read_attachment and look_at_image say removed` | |
| AC-6.5 | T → `AC-6.5 (030) a locked file does not stop the others and is retried` | |
| AC-6.6 | R → `AC-6.6 (030) only indexed files are swept` ; T same on disk | legacy inbox picture, Telegram photo, camera still left alone |
| AC-6.7 | T → `AC-6.7 (030) lastOpenedAt` ; P → `AC-6.7 (030) opening on the phone` | does not change `updatedAt` or list order; routine, house-rule, company runs do not set it; attach sets it |
| AC-7.1 | manual (picture + file, restart) | — |
| AC-7.2 | R → `AC-7.2 (030) old messages still fold` | English and legacy Spanish heading |
| AC-7.3 | manual (both languages); `tests/i18n.test.ts` parity plus `AC-7.3 (030) every attach key exists in es and en` | |
| AC-7.4 | R → `AC-7.4 (030) thumbnails only for raster pictures` | |
| AC-7.5 | R → `AC-7.5 (030) the open list` ; M → `AC-7.5 (030) the open guard and the openPath refusal` | `.ts`, `.xlsm`, `.exe`, case, store root with `..` |
| AC-8.1 | `tests/telegram.test.ts` → `AC-8.1 (030) Telegram photos still land as telegram-<id>.jpg` ; P → `AC-8.1 (030) the phone view carries no attachments` | WhatsApp/voice unchanged by construction (no edits) |

Cross-cutting guards added with the work: an architecture test that nothing under `src/shared/attach/` imports `node:*`; a test that `read_attachment` is in `appTools`; and the existing typo guard on `[^w.-]` keeps passing.

## 7. Security and privacy impact

- **Tool risk:** `read_attachment` is `read`, `standalone`, never asks, also in "Solo lectura" (spec AC-4.6). It cannot list, takes an id only, and reads only inside the store. Any existing id is readable from any conversation or sub-agent (BR-24, accepted by the human); ids are 122-bit random, never shown to the person, only to the model.
- **Prompt injection:** an attachment is data (BR-2). The heading, the data line at the top of every result and the system sentence say so; the real guard stays the approval policy. Nothing inside a file changes tools or approvals.
- **Privacy flows:** a new category of stored personal data (any accepted file) with its own retention (30 days from last opened); new flow to a third party (file text to the answering provider, a picture to the vision provider). Measures: the per-provider notice (settings-remembered), the secret-name warning (never a refusal), masking of text the model reads, metadata stripping of stored pictures. Honest limits to write in `RISKS.md`: masking is pattern-based (unknown formats and JSON-quoted keys pass, see §10), pixels are not scanned, the name warning sees only name and path, the notice informs but does not stop.
- **Path and name attacks:** hardened stored names, a strict id pattern, the store root resolved and checked before any read or delete, no renderer-supplied path ever used for a read or open other than through a one-use grant.
- **Memory pressure over IPC:** a 2 MiB file is about 2.8 MB base64; the coordinator rejects by claimed and by estimated length before decoding (AC-2.6); main checks `stat` before reading.
- **Hostile files in the UI:** thumbnails only for raster pictures via `data:`/`blob:` (CSP `img-src` already allows both; SVG is refused at the door); "open" only for the BR-25 list, double-checked in coordinator and main.
- **Audit and logs:** ids, kinds, sizes and counts only (AC-5.7). `audit()` entries: `attachment.store`, `attachment.refuse`, `attachment.sweep` with counts. The existing `redact()` is unchanged (22 BR-4); masking is a new function.
- **Docs to update in the same PR** (tasks T47 to T51): `docs/security/PRIVACY.md` (inventory row, what leaves the machine, the notice, the 30-day rule, erasure), `docs/security/CONTROLS.md` (secret-name warning, masking, metadata strip, store confinement, allow-list, `read_attachment` limits, open guard), `docs/security/RISKS.md` (new R-15 with residuals), `docs/modules/chat.md`, `docs/modules/files-and-commands.md`, `docs/modules/security.md`, `docs/modules/agents.md` (app-tools list), `docs/context.md` (Attachment and Inbox terms from "draft" to the built behavior). Amendments to specs 002, 003, 015, 020, 022, 025 (spec §3 "Amends") are applied when 030 is implemented.

## 8. Rollout

No feature flag: attaching is an explicit act (BR-1) and the composer gains a button. First run: the first send with an attachment shows the provider notice (default `noticeAcknowledged: []`). Existing threads render as before; no data migration; legacy inbox files are never swept. Turning it off: not provided (spec does not ask for a switch); removing the button disables the feature, and the sweep only touches indexed files.

## 9. Dependency and technical decisions flagged for the human

1. No new dependency is needed. If the human wants decoding, re-encoding or downscaling later, that is a new spec (BR-14 refuses large pictures instead) and a dependency decision (pnpm only; a native module needs the build to be checked on Windows; no git dependency, `libsignal` exception untouched).
2. The `attach:*` IPC uses one-use path grants (§3.4). It is a planner design choice with no business rule in it; flagged because it adds a main-side rule the spec does not mention.
3. A record per attachment on disk (§4) instead of one index file; reversible.

## 10. Provisional readings and gaps found in the spec (to confirm; not decided)

Each item is the narrowest literal reading the plan builds on; a different answer changes one named test and one function.

| # | Where | Gap | Provisional reading used |
|---|---|---|---|
| G1 | AC-4.4, 015 BR-5 | The spec says 60 000 characters; the code constant is `MAX_RESULT_CHARS = 24_000` in `tools/types.ts` (015 AC-1.8 also says 60 000) | `read_attachment` passes `60_000` explicitly. The 015 mismatch is a separate `/fix` |
| G2 | BR-8 vs instruction to reuse `inboxFileName` | BR-8 puts the sanitiser in `shared`; `inboxFileName` is in `coordinator/tools/paths.ts` and does not handle `..`, reserved names (`CON`), trailing dots | The character step moves to `shared` (`sanitizeFileName`); `inboxFileName` delegates to it (its 002 AC-5.7 tests keep passing); `storedFileName` adds the hardening |
| G3 | AC-3.3 | Does stripping remove the EXIF `Orientation` tag? Without it, phone photos may show sideways to the vision model | Strip all EXIF, including orientation (strictest reading of "no camera metadata") |
| G4 | BR-13 | A `.png` whose bytes are really a JPEG (two allowed types disagree) | Refused as `content`: the extension names a type and the bytes must be that type |
| G5 | BR-14, AC-1.9, AC-2.3 | Do chips already in the composer count toward 5 files / 10 MiB? When a total is exceeded, can a later smaller file still fit? Does the folder rule count all direct files or only acceptable ones? | Existing chips count; files are taken in order and a refused file consumes no budget; the folder rule counts all direct regular files |
| G6 | AC-3.1 | Which providers get the notice: sub-agents started by `delegate_task` may use other providers; the model can be changed after the notice | Notice computed at send for the thread's effective provider and, when a picture is attached, the vision provider (`visionModel(settings)`); sub-agent providers are not included |
| G7 | BR-7, AC-5.4 | A record whose conversation no longer exists (a crash between deleting a thread and its files) | `planSweep` skips records with no known last-opened time; they stay until erase. Needs a human answer if they should be deleted |
| G8 | AC-6.7 | "Opened on the phone": which route, and does every long-poll repeat count? | The first read of a conversation by id on the History scope counts; repeats within the same open do not need to |
| G9 | AC-4.1, BR-24 | The system-prompt sentence: always, or only when the history has attachments? Do company agents get `read_attachment`? | Sentence added with the tool, always; tool in `appTools` for every agent |
| G10 | AC-2.7 | Cut rule for a very long first-attachment name as a title | Same cut as AC-2.5 (60 characters, 57 plus an ellipsis) |
| G11 | AC-3.5, BR-20 | Masking uses the `redact()` patterns; JSON/YAML quoted keys such as `"password": "x"` do not match them; also whether text from PDF/Office is masked | Same patterns plus the added families; Office/PDF text is masked too; the quoted-key miss is written as a residual in RISKS.md |
| G12 | AC-1.9 | Symlinks, junctions and hidden/system files inside a dropped folder | Only regular files are listed; anything else counts as "skipped" like a subfolder |
| G13 | BR-20 | "Matched on the path": per whole path or per segment | Pattern applied to the file name and to each path segment |
| G14 | AC-2.6 | An empty (0-byte) file | Refused as `empty` in the renderer and the coordinator |
| G15 | spec silent | Files stored but never sent (chip dropped by closing the app or switching conversation) | Kept until the 30-day sweep (the conversation's last-opened time was set at attach) |
| G16 | BR-21 and 028 | An attachment-only message has an empty text block; the phone shows an empty bubble | Not changed by this spec (phone out of scope, BR-22) |
| G17 | BR-23 | AC-1.10 disables attaching during a run; a chip added before a run started by another channel | Disabled while `running`, chips kept |
