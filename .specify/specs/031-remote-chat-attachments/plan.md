# 031 — Plan

Spec 031 is `ready` (no Open Questions; the §8 table is the owner's delegation record). This plan does not change §1 to §8. Test files and task ids are in `tasks.md`. Where the spec is silent or contradicts itself, §10 lists the gap and the provisional reading the plan builds on; none is answered silently, and the tasks that depend on an unanswered gap are marked `[BLOCKED]`.

## 0. Coordination

Specs 030 (built except its phone half and docs) and 032 (drafted by another session, edits the same remote files) share files with this plan. Rules: `git status` before every task; never overwrite a hunk you did not write; edits to a shared file are additive and small; the protected-files manifest is recomputed **last**, from the files as they are then (T44).

| File | Other owner | 031 touches |
|---|---|---|
| `src/shared/remote/{api,authorize,settings,confirmations,status,wire}.ts`, `src/shared/types.ts` (`RemoteSettings`) | 032 (home modes: a sub-switch, routes, status keys, confirmations) | new `sendFiles` field, `Refusal` members, 3 routes, `files` route flag, `StatusView.sendFiles`, wire type of a message |
| `src/coordinator/channels/remote/channel.ts`, `transport.ts`, `audit.ts` | 032 | handlers, purge hooks, audit detail, refusal statuses |
| `src/renderer/src/remote/ScopesCard.tsx`; `src/shared/i18n/{es,en}/remote.ts` | 032 | one sub-switch row under Chat; three keys |
| `src/remote-client/{i18n/es.ts,i18n/en.ts,lib/outcome.ts,lib/can.ts,lib/status.ts,screens/Settings.tsx,pwa.css,usePwa.ts}` | 032 | attach keys, `attach` operation, can-list row, `.pwa-chip` |
| `tests/support/remote-harness.ts`, `tests/support/remote-protected.json` | 032 | a fake `files` dependency; hashes |
| `src/shared/attach/*`, `src/coordinator/attachments/*`, `src/coordinator/vision.ts` | 030 (built) | **new files only** (`phone.ts`, `phone-chips.ts`, `readers.ts`, `coordinator/attachments/phone.ts`); two small delegations: `AttachmentService` `attachments.readers` case and `vision.ts` `visionModel` call the new shared helper (no behavior change; their tests stay green) |
| `.specify/specs/030-chat-attachments/tasks.md` T32, RISKS R-16 (h) | 030 | T32 is completed by this plan (T33, T34); ticked at the end |

Specs 026, 027 and 028 are **not edited** by this plan or by the tasks until the very last task, and then only with the owner of that session (T62).

## 1. Approach

The phone does nothing the desktop cannot already do; it only reaches the same store through the same pipeline. Three new narrow-API routes (put to the shared thread, put to a conversation by id, remove a pending upload) go through the unchanged security pipeline of `RemoteChannel` (device, scope, sub-switch, schema, limits, audit). The only new authority is the sub-switch `remote.sendFiles`, decided by the pure `authorizeRemote` and changed only by `main` through the pure `planRemoteChange`. A put calls a coordinator class, `PhoneFiles`, that applies spec 030's own functions in one fixed order (size bound, secret-name, `classifyFile`, provider notice, `AttachmentStore.store`); the remote module (`uploads.ts`, new, protected) keeps only the in-memory list of pending uploads (device, conversation, put time) and imports no file-system API. A send gains an optional list of pending ids; the flow claims them (strictly: this device, this conversation, unexpired, at most 5, no duplicates) and hands them to the same `ask` the PC uses, whose `composeUserMessage` binds them. The phone's thread views get one pure projection (name, kind, size). The PWA gets one composer part (button, chips, picker, on-phone JPEG shrink) used by both screens.

**Rejected alternatives** (the spec rules them out; recorded here for the record): chunked or resumable upload and raising the 1 MB cap (BR-3: partial files on the PC, a bigger attack surface); shrinking photos on the PC (it has no image decoder: 030 plan); a second store or a second type list for the phone (BR-5); a pending-upload table on disk (BR-7: memory only, the 30-day sweep is the backstop); sending the stored id inside thread views (BR-10).

**ADR:** none. No new dependency, no new storage format, no new third party; pending state is in memory and the files use spec 030's store. If the human wants the choice of "one refusal union for the wire" (§3.2) recorded as an ADR, it is one short file.

**Dependencies:** none. `pnpm` only.

## 2. Layers touched

| Layer | Files (new **N** / changed **C**; **P** = in `tests/support/remote-protected.json` today, **P+** = new file that must be added) | Why it lives there |
|---|---|---|
| shared | **N** `src/shared/attach/phone.ts` (limits, file plan, shrink loop, pending rules, projection, name of a re-encoded picture), **N** `src/shared/attach/phone-chips.ts` (chip state machine), **N** `src/shared/attach/readers.ts` (providers that read a conversation's attachments; the vision-model choice moved here from the coordinator). **C P** `src/shared/remote/api.ts` (`Refusal` members, schemas, `ROUTES`, `RouteSpec.files`, `audit: 'upload'`), **C P** `authorize.ts` (Files gate), **C P** `status.ts`, **C P** `wire.ts` (status key, message attachments type). **C** `settings.ts`, `confirmations.ts` (not in the manifest today: see §10 G1), `src/shared/types.ts` (`RemoteSettings.sendFiles`, `RemoteConfirmation`), `defaults.ts` if the remote default lives there, `i18n/{es,en}/remote.ts` | pure rules used by the coordinator, `main` and the PWA; Constitution IV |
| coordinator | **N P+** `channels/remote/uploads.ts` (pending list, put/remove/claim, expiry, purge). **C P** `channel.ts` (3 routes, `files` gate input, purge hooks, audit of uploads and send counts), `chat.ts` and `threads.ts` (`ids` through the sends; `markOpened`; public `reachable`), `thread-view.ts` (projection, attachment-only messages), `audit.ts` (new ops, `detail`), `transport.ts` (statuses of the new `Refusal` members). **N** `coordinator/attachments/phone.ts` (`PhoneFiles`, `refusalOf`). **C** `coordinator/index.ts` (wiring only), `attachments/service.ts` (readers case delegates), `vision.ts` (delegates) | the store, the pipeline and the run entry are coordinator concerns |
| main | **C** `src/main/messages.ts` (`remoteDialog` case `attachments`), `src/main/index.ts` (context for `planRemoteChange`, records the acknowledgment), `src/main/settings.ts` only if its remote sanitiser is not `sanitizeRemote` (verify, §10 G1) | native confirmation the page cannot click |
| renderer | **C** `src/renderer/src/remote/ScopesCard.tsx` (one sub-switch row under Chat) | where the person turns it on |
| remote-client (PWA) | **N** `lib/attach.ts` (network), `lib/shrink.ts` (canvas glue), `screens/useAttachments.ts`, `screens/AttachBar.tsx`, `screens/FileLines.tsx`. **C** `lib/outcome.ts`, `lib/chat.ts`, `lib/threads.ts`, `lib/poll.ts`, `lib/can.ts`, `lib/status.ts`, `usePwa.ts`, `screens/Chat.tsx`, `screens/Conversation.tsx`, `screens/useConversation.ts`, `screens/Settings.tsx`, `i18n/{es,en}.ts`, `pwa.css` | the phone screens; `src/remote-client` imports `shared` only |

No new arrow breaks `docs/architecture.md`: `shared/attach/*` imports only `shared`; `shared/remote/wire.ts` imports a type from `shared/attach/phone.ts` (shared to shared); the remote module imports `shared` and its siblings, never `node:fs`; `remote-client` imports no `node:*`.

## 3. Contracts (signatures only)

### 3.1 Shared: `src/shared/attach/phone.ts`

```ts
// BR-3, BR-7. REMOTE_LIMITS (shared/remote/limits.ts) is not touched (AC-9.5).
export const PHONE_ATTACH: { maxFileBytes: 700_000; maxFiles: 5; maxPending: 5; pendingTtlMs: 900_000 }

export interface PhoneAttachmentView { name: string; kind: AttachmentKind; size: number }       // BR-10: nothing else
export function phoneAttachmentViews(attachments: readonly MessageAttachment[] | undefined): PhoneAttachmentView[]   // BR-13: the one projection

export type PhonePlan = { action: 'send' } | { action: 'shrink' } | { action: 'refuse'; reason: 'too-big' | 'type' | 'too-many' }
export function planPhoneFile(file: { name: string; size: number }, chipsHeld: number): PhonePlan   // AC-8.1; type by ALLOWED_EXTENSIONS, no second list

export const SHRINK_STEPS: readonly { maxSide: number; quality: number }[]    // plan data, BR-4 leaves the steps to the plan; first step is the biggest
export function shrinkToFit<T extends { size: number }>(encode: (step: { maxSide: number; quality: number }) => Promise<T>, limit?: number): Promise<T | null>   // first result within the limit, else null (never sent larger)
export function reencodedPictureName(now: number): string                     // imagen-<now>.jpg (030 AC-1.5)

export interface PendingUpload { id: string; deviceId: string; threadId: string; putAt: number }
export function pendingExpired(upload: PendingUpload, now: number): boolean   // 15 minutes
export function canHoldAnother(pendingOfDevice: number): boolean               // fewer than 5
export function claimUploads(held: readonly PendingUpload[], ask: { deviceId: string; threadId: string; ids: readonly unknown[] }, now: number): { ok: true; ids: string[] } | { ok: false }   // AC-4.2: one answer for every cause
```

`src/shared/attach/phone-chips.ts` (AC-8.3, AC-8.6, AC-8.7; the reducer returns the effects the screen performs):

```ts
export type ChipState = 'preparing' | 'uploading' | 'ready' | 'failed'
export interface Chip { key: string; name: string; state: ChipState; id?: string; reason?: PhoneChipReason }
export type PhoneChipReason = Refusal | 'network' | 'too-big' | 'type' | 'too-many' | 'unreadable'   // every member has one dictionary key (AC-8.5)
export type ChipEvent = /* added | prepared | uploaded(id) | failed(reason) | remove(key) | expired(id) */
export type ChipEffect = { type: 'abort'; key: string } | { type: 'remove-remote'; id: string }
export function chipsReduce(chips: readonly Chip[], event: ChipEvent): { chips: Chip[]; effects: ChipEffect[] }
export function canSendNow(chips: readonly Chip[], text: string, running: boolean): boolean   // false while any chip is preparing or uploading
```

`src/shared/attach/readers.ts` (AC-1.4, AC-2.8, BR-11):

```ts
export function pickVisionModel(settings: Settings, env: Readonly<Record<string, string | undefined>>): { provider: ProviderId; model: string }   // moved from coordinator/vision.ts, same behavior
export function threadReaders(settings: Settings, thread: Pick<Thread, 'agentId' | 'model'>, images: boolean, env: Readonly<Record<string, string | undefined>>): ProviderId[]   // the conversation's provider, plus the vision provider for pictures
export function acknowledgeNotice(current: Settings['attachments'], providers: readonly ProviderId[]): Settings['attachments']   // 030 list, no duplicates
```

### 3.2 Shared remote (protected files)

```ts
// shared/types.ts
export interface RemoteSettings { /* existing */ sendFiles: boolean }   // BR-2; off at every turn-on; cannot outlive Chat

// shared/remote/confirmations.ts: one member, after 'continue' in the fixed order
export type RemoteConfirmation = /* existing */ | { kind: 'attachments'; providers: ProviderId[] }
export function planRemoteChange(before, after, dormantNames, context: { activeVault: string; attachReaders: ProviderId[] }): { confirmations: RemoteConfirmation[]; next: RemoteSettings }

// shared/remote/api.ts
export type Refusal = /* existing */ | 'attach-off' | 'notice-needed' | 'too-many' | 'secret-name' | 'file-type' | 'file-content' | 'file-empty' | 'file-malformed' | 'storage'
// existing reused for the rest: 'too-large' (size), 'busy', 'gone' (company, unknown, deleted), 'unavailable' (any send with a bad id), 'scope-off', 'write-off', 'rate-limited', 'unknown-device', 'invalid'
export interface RouteSpec { /* existing */ files?: 'always' | 'with-ids'; audit: 'none' | 'change' | 'picture' | 'open' | 'upload' }
export const attachmentIds: z.ZodType<string[]>    // array of strings, each at most 64 characters, a technical bound on the array length only (§10 G4)
export const putBody: z.ZodType<{ name: string; size: number; base64: string }>                    // strict; name 1..512; size int; base64 at most 933 336 characters; decodedLength === size
export const putThreadBody: z.ZodType<{ id: string; name: string; size: number; base64: string }>  // strict; the same plus the conversation id
export const removeBody: z.ZodType<{ id: string }>                                                  // strict; id at most 64 characters
export const chatSendBody: z.ZodType<{ text: string; attachments?: string[] }>                      // strict; text up to 8000; blank text only with at least one id
export const threadsSendBody: z.ZodType<{ id: string; text: string; attachments?: string[] }>       // strict; same rule

// ROUTES gains (paths are the plan's; names of scope, audit class and flag are the spec's AC-9.1)
{ method: 'POST', path: '/api/chat/attach',        auth: 'session', scope: 'chat',                 files: 'always', audit: 'upload', body: putBody }
{ method: 'POST', path: '/api/threads/attach',     auth: 'session', scope: 'history', continue: true, files: 'always', audit: 'upload', body: putThreadBody }
{ method: 'POST', path: '/api/attachments/remove', auth: 'session', scope: ['chat', 'history'],    files: 'always', audit: 'change', body: removeBody }   // scope [BLOCKED §10 G5]
// '/api/chat/send' and '/api/threads/send' gain files: 'with-ids'. '/api/chat/new' stays emptyBody (a key is refused, AC-4.4).

// shared/remote/authorize.ts: one new input, one new verdict
export function authorizeRemote(input: { device; remote; route; cameraId?; carriesFiles?: boolean }): { ok: true } | { ok: false; reason: Refusal }
// order: device, scope, sensitive, continue, FILES ('attach-off' when route.files is 'always', or 'with-ids' and carriesFiles, and !remote.sendFiles), camera

// shared/remote/wire.ts and status.ts
export interface StatusView { /* existing */ sendFiles: boolean }                        // counted only while Chat is on (AC-1.9)
export interface ThreadWindow { messages: { index; role; text; at; attachments?: PhoneAttachmentView[] }[] /* rest unchanged */ }
```

Wire answers: a stored put answers `200 { ok: true, attachment: { id, name, kind, size } }`; a refusal is `refusalResponse(reason)` (status per `transport.ts`, body `{ error: reason }`, byte-identical on every transport); a remove always answers `200 { ok: true }` (AC-3.2). Statuses proposed for the new members, technical not business: `attach-off` 403, `notice-needed` 403, `too-many` 409, `secret-name` 422, `file-type` 415, `file-content` 422, `file-empty` 422, `file-malformed` 422, `storage` 500.

### 3.3 Coordinator

```ts
// channels/remote/uploads.ts (protected, new). Imports no node:fs; talks to the store only through PhoneFilesPort.
export interface PhoneFilesPort {
  put(input: { threadId: string; name: string; size: number; base64: string }): { ok: true; attachment: MessageAttachment } | { ok: false; reason: Refusal }
  remove(id: string): void
  readersOwed(threadId: string, ids: readonly string[]): ProviderId[]      // providers that would read these, minus the acknowledged ones (re-check at send, BR-11)
}
export interface UploadsDeps {
  settings(): Settings; now(): number
  sharedId(): string
  reachable(id: string): Thread | undefined          // the ThreadsFlow rule: company, unknown and deleted are undefined
  isRunning(threadId: string): boolean                // any run, whoever started it
  files: PhoneFilesPort
  timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }   // fakes in tests; real ones are unref'd
}
export class UploadsFlow {
  put(deviceId: string, target: { shared: true } | { shared: false; id: string }, body: { name: string; size: number; base64: string }): { response: RemoteResponse; stored?: { kind: AttachmentKind; size: number } }
  remove(deviceId: string, id: string): RemoteResponse
  claim(deviceId: string, threadId: string, ids: readonly string[] | undefined): { ok: true; ids: string[] } | { ok: false }   // ids undefined: ok with none
  bound(deviceId: string, ids: readonly string[]): void      // the send was accepted: stop tracking, delete nothing
  dropDevice(deviceId: string): void; dropThread(threadId: string): void; dropAll(): void   // delete file and record; used by the purge hooks
}

// coordinator/attachments/phone.ts (new, unprotected)
export class PhoneFiles implements PhoneFilesPort { constructor(deps: { store: Pick<AttachmentStore, 'store' | 'remove' | 'lookup'>; threads: { get(id: string): Thread | undefined }; settings(): Settings; env(): Readonly<Record<string, string | undefined>> }) }
export function refusalOf(reason: RefusalReason): Refusal    // exhaustive: type -> file-type, content -> file-content, empty -> file-empty, malformed-image -> file-malformed, too-big and total -> too-large, company -> gone, storage -> storage, too-many -> too-many, bad-payload and unreadable -> invalid

// RemoteDeps (channel.ts) and the flows
//   ask(threadId: string, text: string, attachments?: string[]): Promise<void>      // index.ts: startRun(threadId, text, { attachments }).done
//   files: PhoneFilesPort
//   threads: RemoteThreads gains markOpened(id: string, at: number): void
//   ChatFlow.send(deviceId, text, ids?) and ThreadsFlow.send(deviceId, id, text, ids?); ThreadsFlow.reachable becomes public
// audit.ts: ROUTE_OPS gains '/api/chat/attach' and '/api/threads/attach' -> 'remote.attachments.put', '/api/attachments/remove' -> 'remote.attachments.remove'
//   auditRemote(record, op, outcome, deviceId?, { actor?, target?, detail? }) with detail limited to numbers and kinds
```

Order of checks in a put (provisional, §10 G8): pipeline (device, scope, sub-switch, schema, limits) -> target (`gone`) -> `busy` -> `too-many` (cap) -> `PhoneFiles.put`: `too-large` (decoded bytes) -> `secret-name` -> `file-empty`, `file-type`, `file-content` (`classifyFile`) -> `notice-needed` -> `file-malformed` -> `storage`. A send: pipeline -> `gone` -> `run-active` -> `busy` -> `unavailable` (claim) -> `notice-needed` (re-check) -> `ask`.

### 3.4 PWA

```ts
// lib/outcome.ts: Operation gains 'attach'; BASE gains the nine members; BY_OPERATION('attach'): too-large -> remote.pwa.attach.tooBig, busy -> remote.pwa.attach.busy, gone -> remote.pwa.thread.gone, unavailable -> remote.pwa.attach.expired (on send), storage -> remote.pwa.attach.storage, attach-off -> remote.pwa.attach.off, notice-needed -> remote.pwa.attach.noticeNeeded, secret-name -> .secret, file-type -> .type, file-content -> .content, file-empty -> .empty, file-malformed -> .malformed, too-many -> .tooMany; network -> remote.pwa.pcUnreachable
export function attachOutcomeKey(reason: PhoneChipReason): PwaKey   // exhaustive Record: a reason without a key is a type error and a test failure
export function putFile(deps: { fetch; token; target: { id?: string }; file: { name: string; base64: string; size: number }; signal?: AbortSignal }): Promise<{ ok: true; attachment: MessageAttachment } | Failed>
export function removeUpload(deps: { fetch; token; id: string }): Promise<{ ok: true } | Failed>
export function validateChatInput(text: string, files?: number): ChatValidation   // blank text is valid with at least one ready file
```

The PWA reads the sub-switch from `/api/status` (`sendFiles`); the next request changes it without a reload (AC-8.4).

## 4. Data and persistence

- **Settings:** `remote.sendFiles` (boolean) in the settings file; absent reads as `false` (AC-1.1, no migration). `sanitizeRemote` reads it `false` when Chat is off.
- **Attachment files:** spec 030's store (`<userData>/inbox/attachments/<id>/<stored name>` and `<id>.json`); a put adds one record exactly as a desktop attach does. 30-day rule, deletion with the conversation, erase and no-export are 030's (AC-3.4 is a characterization).
- **Pending uploads:** memory only, in `UploadsFlow` (`deviceId`, `threadId`, `putAt`, an expiry timer). After a restart nothing is pending; the files wait for the 30-day sweep (AC-3.3, G15 of 030). A put also fires the store's `opened` hook, so it restarts the target conversation's 30 days exactly as a desktop attach does (§10 G12).
- **Audit:** `remote.attachments.put` and `remote.attachments.remove` through the existing hash-chained trail; `detail` holds `deviceId` and numbers/kinds only. The store's own `attachment.store|refuse|remove` entries stay.
- **Phone:** nothing persisted (BR-19); bytes and chips in memory; the service worker is not changed and never caches `/api/*`.
- **Orphans:** a pending file whose answer was lost, or one lost to a restart, is reclaimed by expiry or the 30-day sweep (BR-14); written as a residual in `RISKS.md`.

## 5. Dependency injection

- `UploadsDeps` (above) is built in `RemoteChannel`'s constructor from `RemoteDeps`; tests fake `files`, `timers`, `isRunning`, `reachable` and `now`. `RemoteDeps` gains `files` (required, so a build that forgets to wire it fails typecheck instead of silently refusing) and the longer `ask`. The shared test harness `tests/support/remote-harness.ts` grows a fake `files` and a recording `ask` (T21).
- `PhoneFiles` takes the real `AttachmentStore`, a `threads` lookup, `settings()` and `env()`; tests use a temp-dir `AttachmentStore` with a fake clock (the pattern of `tests/attach-store.test.ts`).
- `main` receives no new dependency: `index.ts` calls the pure `threadReaders(settings, { agentId: remote.agentId }, true, process.env)` and passes the result in the `planRemoteChange` context; the acknowledgment is the pure `acknowledgeNotice`.
- The PWA's `usePwa` already injects `fetch` and the token; `putFile` and `removeUpload` use `postJson`. The chips run through `createSerial` (030) so uploads go one at a time.

## 6. Test strategy

Test titles carry `AC-x.y (031)`. Files: **A** `tests/attach-phone-rules.test.ts`, **B** `tests/remote-attach-settings.test.ts`, **C** `tests/remote-attach-routes.test.ts`, **D** `tests/attach-phone-service.test.ts`, **E** `tests/remote-attach-uploads.test.ts`, **F** `tests/remote-attach-send.test.ts`, **G** `tests/remote-attach-view.test.ts`, **H** `tests/remote-attach-audit.test.ts`, **I** `tests/remote-attach-protected.test.ts`, **J** `tests/remote-client-attach.test.ts`, **K** `tests/remote-attach-relay.test.ts`. The renderer and the PWA have no component harness except `renderToStaticMarkup` (`tests/remote-client-render.test.ts`); their rules are pure functions above, and the screens are verified by the `run` skill and the manual steps.

| AC | Test file → name | Adversarial cases |
|---|---|---|
| 1.1 | B → `AC-1.1 (031) sendFiles is off by default and at every turn-on` | settings without the field; non-boolean; turn-on with it set; off-then-on |
| 1.2 | B → `AC-1.2 (031) turning sendFiles on asks once, in the fixed order; turning it off asks nothing` ; B → `AC-1.2 (031) the dialog has Cancel as default` (same style as `tests/remote-main.test.ts`) | on with continue on in the same change (order); Cancel saves nothing |
| 1.3 | B → `AC-1.3 (031) sendFiles cannot outlive Chat` | Chat turned off in the same patch; document with sendFiles on and Chat off reads off |
| 1.4 | B → `AC-1.4 (031) the dialog names the providers; Allow acknowledges them; Cancel acknowledges nothing` ; A → `AC-1.4 (031) threadReaders and acknowledgeNotice` | vision provider equal to the chat provider (listed once); already acknowledged; unknown provider id dropped |
| 1.5 | B → `AC-1.5 (031) the coordinator's patch cannot carry sendFiles` ; B → `AC-1.5 (031) no tool reads or changes the remote settings` | patch with `remote.sendFiles`; every registered tool's name, description and schema scanned |
| 1.6 | C → `AC-1.6 (031) sendFiles off refuses a put and a send with ids; text-only sends are unaffected` | zero reads from disk, no run, nothing stored (fake `files` call count 0) |
| 1.7 | C → `AC-1.7 (031) put gate: Chat for the shared thread; History, continue and Files for a conversation` ; C → `AC-1.7 (031) authorizeRemote is transport-free` | each switch off in turn; the verdict names `scope-off`, `write-off`, `attach-off` |
| 1.8 | C → `AC-1.8 (031) unknown, revoked and idle-expired devices get the same refusal on the new routes` | no token, junk token, revoked mid-session |
| 1.9 | C → `AC-1.9 (031) status returns sendFiles and no other new key` ; J → `AC-1.9 (031) the can-list shows Send files` | Chat off with sendFiles on |
| 2.1 | D → `AC-2.1 (031) a valid file is stored through the 030 store and bound to the target` ; E → `AC-2.1 (031) put answers id, name, kind, size and calls no provider` | provider fake call count 0 |
| 2.2 | D → `AC-2.2 (031) the PC classifies the bytes` ; C → `AC-2.2 (031) the answer names the reason` | `.png` that is `MZ`, SVG, HTML, archive, no extension, NUL at byte 7999 and 8000, empty (see G3) |
| 2.3 | C → `AC-2.3 (031) 700 000 passes, 700 001 is refused, claimed size is not trusted` ; C → `AC-2.3 (031) malformed bodies never reach a handler` | bad base64, size mismatch, extra keys, missing field, a 1 MB body (transport cap), empty file `[BLOCKED G3]` |
| 2.4 | D → `AC-2.4 (031) secret-looking names are refused with no override` | `.env`, `.env.local`, `*.pem`, `id_rsa`, `passwords.xlsx`, case; near misses (`environment.txt`) |
| 2.5 | D → `AC-2.5 (031) pictures lose their metadata whatever the phone did` ; D → `... a malformed picture is refused` | JPEG with GPS, PNG `eXIf`, WebP; truncated JPEG |
| 2.6 | E → `AC-2.6 (031) a company, an unknown and a deleted conversation answer the same gone` | byte-identical bodies; nothing stored |
| 2.7 | E → `AC-2.7 (031) a put into a conversation with a run in progress is busy` | a run started by the PC, by a phone, by the Chat tab |
| 2.8 | D → `AC-2.8 (031) a provider that was not acknowledged refuses with notice-needed` ; E → same through the flow | picture adds the vision provider; both acknowledged; conversation's agent changed |
| 2.9 | A → `AC-2.9 (031) pending rules` ; E → `AC-2.9 (031) a sixth pending upload is too-many and a freed slot works again` | removed, sent, expired free the slot; another device is unaffected |
| 2.10 | C → `AC-2.10 (031) uploads add no limit but the cap; REMOTE_LIMITS is unchanged` ; C → `AC-2.10 (031) 61st request in a minute is rate-limited; the handler running past 30 s answers failed` | fake clock |
| 2.11 | D → `AC-2.11 (031) a failing write answers storage and leaves nothing` | fake write failure; no record |
| 3.1 | E → `AC-3.1 (031) a pending upload is deleted on remove, expiry, revoke, forget, idle expiry, off, kill switch, sub-switch off, Chat off and new conversation`, one case each; `AC-3.1 (031) a sent attachment survives every one of them` | fake timers at 14:59 and 15:00; sent file untouched |
| 3.2 | E → `AC-3.2 (031) removing what is not yours deletes nothing and answers the same` | another device's id, a sent attachment, unknown, malformed, empty string |
| 3.3 | E → `AC-3.3 (031) after a restart nothing is pending` | a send naming old ids is `unavailable`; file still on disk |
| 3.4 | D → `AC-3.4 (031) erase removes pending uploads with the store; export excludes attachments` | characterization; broken on purpose once |
| 4.1 | F → `AC-4.1 (031) a send with ids runs through ask with the attachments and then they stop being pending` ; F → `... a send with no ids is as today and blank text is refused` | 1 and 5 ids; empty text with ids; 8000 characters |
| 4.2 | A → claim cases ; F → `AC-4.2 (031) a bad id refuses the whole send with one answer` | unknown, expired, another device's, another conversation's, sent, malformed, 6 ids, duplicate; others stay pending |
| 4.3 | F → `AC-4.3 (031) other refusals keep the uploads pending` | busy, run-active, 8001 characters, sub-switch off, agent changed (notice-needed) |
| 4.4 | F → `AC-4.4 (031) an attachment-only message starts the run; /api/chat/new refuses a files key` ; `composeUserMessage` empty text case | no new conversation can carry files |
| 4.5 | F → `AC-4.5 (031) a send into a Telegram, WhatsApp or voice conversation sends nothing outward` | the fake channel's outbound count 0 |
| 4.6 | F → `AC-4.6 (031) read_attachment is read and a phone-started run keeps its approvals` | the registered tool's risk; approvals only for the starting device |
| 5.1 | G → `AC-5.1 (031) the phone sees name, kind and size only` | message with 5 attachments; no id, path, bytes, removed state |
| 5.2 | G → `AC-5.2 (031) marker strings in id, stored name and size never reach the phone` ; A → projection | the characterization is broken on purpose (serialise `attachments` whole) to see it fail |
| 5.3 | G → `AC-5.3 (031) an attachment-only message is listed; a message with neither is left out` | `earlier` counts attachment-only messages |
| 5.4 | G → `AC-5.4 (031) attachment lists count toward the 1 MB cap` | 100 messages × 5 names of 512 characters |
| 5.5 | G → `AC-5.5 (031) a swept attachment still shows its name` | record `removedAt` set |
| 5.6 | G → `AC-5.6 (031) attachments from the desktop, Telegram or a routine show the same way` | |
| 6.1 | G → `AC-6.1 (031) the first read of a conversation by id sets lastOpenedAt` | `updatedAt` and order untouched |
| 6.2 | G → `AC-6.2 (031) since, before, gone and listings do not` | long-poll repeat; company id |
| 6.3 | G + `tests/attach-store.test.ts` style → `AC-6.3 (031) the 30 days restart and a deleted file stays deleted` | |
| 6.4 | G → `AC-6.4 (031) the Chat tab's state poll does not set it; a send does` | |
| 7.1 | H → `AC-7.1 (031) one remote.attachments.put entry per put, with kind and size when stored` ; `... a remove is audited as a change` ; `... a send adds the count` | refused file: outcome denied, no kind/size |
| 7.2 | H → `AC-7.2 (031) markers fed through every new operation never reach the trail or a log` | marker in name, text, base64, id |
| 7.3 | H → `AC-7.3 (031) refusals are denied and throttled; a failing trail does not interrupt` | sink that throws |
| 7.4 | H → `AC-7.4 (031) every new response is no-store` ; J → `AC-7.4 (031) the phone keeps no chip or file` ; `... the service worker does not cache /api` | |
| 7.5 | K → `AC-7.5 (031) a put and a send cross the sealed relay and nothing else is contacted` | marker scan of the wire; fake fetch records hosts |
| 7.6 | [manual] | remote-activity list |
| 8.1 | A → `AC-8.1 (031) the phone's file plan and the shrink loop` | 700 000 and 700 001 pictures; a GIF over; a PDF over; `.svg`; `.env`; 6th chip; a picture that never fits; encoder throwing |
| 8.2 | [manual] Android + iPhone | |
| 8.3 | A → `AC-8.3 (031) chip transitions and effects` ; J → `AC-8.3 (031) uploads go one at a time` | X on ready (remove-remote); X on uploading (abort); send disabled while preparing/uploading |
| 8.4 | J → `AC-8.4 (031) the attach button follows the status without a reload` | status flips on the next request |
| 8.5 | J → `AC-8.5 (031) every reason has exactly one key and retry only where it helps` | a type-level exhaustive map plus a test that lists the union |
| 8.6 | J → `AC-8.6 (031) offline during an upload or a send keeps text and chips, queues nothing` | fake fetch rejects |
| 8.7 | J → `AC-8.7 (031) unavailable on send marks the chip expired` | |
| 8.8 | J → `AC-8.8 (031) attachment lines render as plain text` (`renderToStaticMarkup`) ; [manual] look | name `<script>`, markdown, a link-looking name |
| 8.9 | J → `AC-8.9 (031) every new key exists in es and en` ; the existing i18n and hardcoded-text gates | |
| 8.10, 8.11 | [manual] | |
| 9.1 | C → `AC-9.1 (031) the route table snapshot` | |
| 9.2 | C → `AC-9.2 (031) authorizeRemote for a put` | covered with 1.7 |
| 9.3 | I → `AC-9.3 (031) the remote module imports no file-system API and holds no copy of the rules` | negative fixture: a copy with `node:fs` and a `.png` list fails |
| 9.4 | I → `AC-9.4 (031) uploads.ts is in the manifest and the manifest matches` ; `tests/remote-relay-contract.test.ts` | |
| 9.5 | A/I → `AC-9.5 (031) REMOTE_LIMITS is unchanged and the phone limit is its own constant` | |
| 9.6 | I → `AC-9.6 (031) Telegram, WhatsApp and voice are unchanged` | the 030 AC-8.1 test still passes |
| 9.7 | [manual] | read the PR diff against §7 |

## 7. Security and privacy impact

- **ToolRisk:** none: no tool is added (BR-22). `read_attachment` stays `read`. The routes are narrow-API operations, authorized by `authorizeRemote`.
- **The protected security layer changes.** Files in `tests/support/remote-protected.json` that this plan edits: `shared/remote/api.ts`, `authorize.ts`, `wire.ts`, `status.ts`; `coordinator/channels/remote/channel.ts`, `chat.ts`, `threads.ts`, `thread-view.ts`, `audit.ts`, `transport.ts`. New file to add: `coordinator/channels/remote/uploads.ts`. `devices-admin.ts` and `runs.ts` are **not** edited: the purge on revoke, forget, idle expiry and erase hangs on the existing `onDeviceGone` callback in `channel.ts`; on off and the kill switch on `stop()`; on sub-switch or Chat off on `reconcile()`; on "New conversation" on `chatNew`. Not in the manifest, so no hash change (but still reviewed as security code): `shared/remote/settings.ts`, `confirmations.ts`. **Rules for every edit to these files:** the words `relay`, `routing id` and `shell manifest` do not appear in any added or removed line or in `uploads.ts` (tests `verify-027` and `remote-relay-contract` scan them); the hashes are recomputed once, at T44, after all other edits (and again if any later task touches a protected file). `tests/remote-relay-contract.test.ts` must pass with the new hashes. `tests/verify-027-optin-unchanged-channel.test.ts` diffs the working tree against git `HEAD`: **it stays red until the change is committed**, and its transport-file test pins the edit set of `transport.ts` (§10 G2: blocked on a human decision).
- **Attack surface:** a stolen, unlocked, paired phone with Chat and Files on can park up to 5 files of 700 000 bytes per device (about 3.5 MB, 17.5 MB over the 5 devices) for 15 minutes unless sent, and with a send make the agent read them under the usual approvals and an acknowledged provider. Controls: the sub-switch (off at every turn-on, native confirmation, `main` only), the Chat scope, `classifyFile` on the bytes, secret-name refusal, metadata strip, the cap of 5 and the 15-minute expiry, the 60-per-minute limit, 15-day idle expiry, revoke, the kill switch, audit by device with kinds and sizes. Residual (to `RISKS.md`): hostile text inside an allowed file; an answer lost after the file was stored leaves a pending upload that counts toward the cap until it expires; files of an expired-by-restart upload wait up to 30 days; attachment names are shown to a phone with History or Chat on; in «Permitir todo» a phone-started run's `exec` does not ask (028, already documented).
- **Secrets and logs:** names, ids, text and base64 never enter the audit trail, logs or errors (BR-17; AC-7.2 scans). The provider notice is acknowledged only on the PC.
- **Third parties:** none new. A file crosses Tailscale, or the sealed relay frames; it reaches a model provider only when a run reads it (030).
- **Docs in the same PR** (tasks T56 to T61): `docs/security/PRIVACY.md` (a file from the phone is kept 30 days on the PC; pending 15 minutes; the relay carries it sealed and unreadable; names shown to the phone), `docs/security/CONTROLS.md` (rows for the sub-switch, the cap and expiry, the secret-name refusal with no override, names-only view, the purge hooks), `docs/security/RISKS.md` (extend row **R-14** with the new items, as the spec says; update **R-16 (h)**, which describes the phone gap as open; the next free id in the register is R-17, §10 G6), `docs/modules/remote-access.md`, `docs/modules/chat.md`, `docs/references/settings.md`, `limits.md`, `data.md`, `tools.md` (a note, no new tool), `docs/context.md` (**Attachment** loses "or on the paired phone"; **Send files** and **Pending upload** lose "draft").

## 8. Rollout

Behind the sub-switch, off by default and at every turn-on; turning it off is one click and needs no dialog. First run: nothing changes for anyone who does not turn it on; the PWA shows the attach button disabled with the reason. Existing settings load with `sendFiles: false`. No data migration. The phone app is served by the PC (or the relay), so a new PC build brings the new app; an old cached app against a new PC sees an unknown field in the status as absent and shows the button disabled (the status reader treats a missing key as off).

## 9. Technical decisions flagged for the human (no business rule in them)

1. One closed `Refusal` union carries every new reason, so the existing exhaustive maps (`REFUSAL_STATUS` in `transport.ts`, `BASE` in `outcome.ts`) make AC-8.5 a compile-time property. Cost: nine lines in `transport.ts` (§10 G2).
2. `threadReaders` and `pickVisionModel` move to `shared` because `main` must name the providers in the native dialog and may not import the coordinator. `vision.ts` and the `attachments.readers` case delegate; behavior is unchanged.
3. Shrink steps (`SHRINK_STEPS`): the plan proposes a longest side of 2048, 1600, 1280, 1024, 800 px at JPEG quality 0.85 for the first and 0.7 for the rest; they are data in one constant and the rule stays "fits or is refused".
4. Pending expiry uses one unref'd timer per upload and is also checked lazily at claim time, so a missed timer never lets an expired upload be sent.

## 10. Gaps and provisional readings (found while planning; not decided)

| # | Where | Gap or contradiction | Provisional reading used / effect |
|---|---|---|---|
| G1 | spec §7 "Expected protected files" | Lists `settings.ts` and `confirmations.ts`; neither is in `remote-protected.json`. The manifest has no `stepup.ts` either. It also lists `devices-admin.ts`, `runs.ts`, which this plan does not need to edit | Only manifest files that are actually edited get a new hash; `uploads.ts` is added. No effect on rules |
| G2 | `tests/verify-027-optin-unchanged-channel.test.ts`, "the only edit to the transport interface is the new member of the id union" | New `Refusal` members force an edit of `REFUSAL_STATUS` in `transport.ts` (spec §7 also expects it); that test accepts no other edit of `transport.ts` against `HEAD`. The spec says both tests must pass | **T45 `[BLOCKED]`**: the human decides whether that pin is amended in the same change. Everything else goes ahead |
| G3 | AC-2.2 vs AC-2.3 | Both list "an empty file": AC-2.2 as refused by `classifyFile` with a named reason (so the phone can show `remote.pwa.attach.empty`), AC-2.3 as rejected at the boundary before any handler (which would answer `invalid`) | **T16 `[BLOCKED]`**. The boundary schema is written for every other case; the empty-file case waits |
| G4 | AC-4.2 vs AC-2.3 | "More than 5 ids, a duplicate, a malformed id" must all answer `unavailable`, but a boundary schema must bound the array to protect memory | Schema accepts up to a technical bound (64 strings of at most 64 characters, within the 1 MB body cap); beyond it `invalid`. Needs confirmation that this bound is acceptable |
| G5 | AC-3.2, AC-1.8 | The scope the remove route needs (and whether it needs the Files sub-switch) is not written | **T25 `[BLOCKED]`** (route authorization only): reading used meanwhile is "Chat or History, and Files"; the flow itself (T24) is not blocked |
| G6 | spec §7 security, docs table | Says "R-14 row ... R-15 of 030 cross-referenced". In `RISKS.md` 030's row is **R-16**; R-15 is spec 029's. Rows end at R-16, so the next free id is R-17. Twenty older specs also cite R-17 to R-29 in another sense | Plan extends R-14 (as written) and updates R-16 (h); no new row unless the human asks for R-17 |
| G7 | spec §7 UI | Says the PC sub-switch row "reuses the Toggle already used for the other sub-switches"; `ScopesCard.tsx` uses plain checkbox rows (`label.row.remote-sub`, `p.muted.small.remote-sub`) | The new row copies the neighbouring markup |
| G8 | spec, order of refusals | When several refusals apply to one put or send, which one the phone shows is not written | The order in §3.3; tests that pin the order are labelled provisional |
| G9 | BR-15, AC-6.1 | A second no-`before` no-`since` read of the same conversation (the Refresh button, reopening it) is "a first read in an open" again | Counts again (the narrowest literal reading: every such read) |
| G10 | AC-3.1 | History or continue turned off does not purge by-id pending uploads (only Files, Chat, off, revoke are listed); a send is refused by the gate and the upload expires in 15 minutes | As written |
| G11 | AC-7.1 | The entry for a refused put carries no reason | As written: outcome only (`denied` for a refusal, `error` for `storage`) |
| G12 | 030 `AttachmentStore.store` | Storing fires the `opened` hook: a put restarts the target conversation's 30 days even if the upload is never sent. The spec does not mention it | Reused as the desktop does; written in `PRIVACY.md` |
| G13 | AC-2.6, 028 AC-3.4 | The Chat tab's put with no remote thread yet would create the shared thread (`conversation()` creates it lazily) | Left as the Chat tab's send does today |
| G14 | spec header, 030 plan §9 | The id the put returns to the phone is the store's attachment id (what the model sees on its reference line); BR-10 calls ids capabilities for the model | As AC-2.1 says; flagged because the phone holds it in memory for up to 15 minutes |
