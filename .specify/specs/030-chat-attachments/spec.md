---
status: draft
---

# 030 — Chat attachments (images and files)

## 1. Summary
In the desktop chat the person can already paste or drop a picture (it is saved in the inbox and the agent looks at it with `look_at_image`) and drag vault notes onto the composer. Any other file dragged from the computer is silently ignored. This spec lets the person attach pictures and files (up to 2 MiB each, from an allow-list of types) to a message from the desktop composer by pasting, dropping, dropping a folder or picking with a native dialog. The person is told what will leave the machine, is warned about files that look like secrets, and gets pictures stripped of location metadata. The agent reads a non-picture attachment on demand through a new read-only tool, `read_attachment`, as data and never as instructions, with secret-looking values masked. Attachments are deleted from disk after 30 days without the conversation being opened.

## 2. Problem and goal
A person who wants an agent to work on a PDF, a spreadsheet, a log or a document has to put it in the working folder or the vault by hand and then name it in the message; dropping it in the chat does nothing and says nothing. Done means: a file dropped, pasted or picked in the composer is either attached visibly or refused visibly with a reason, the agent can use what was attached, the person knows what leaves the machine and is warned before a likely secret does, and attachments do not stay on disk forever.

## 3. Scope
**In:**
- Attaching images and files to a message in the desktop composer by paste (including files copied in Explorer), drag and drop, folder drop and a native file picker.
- Accepted types, the 2 MiB per-file limit, per-message limits, and the visible refusal of anything else (replaces the silent ignore of 002 AC-5.5).
- The `read_attachment` tool and how an attachment reaches the model.
- Privacy measures: provider notice, secret-name warning, masking of extracted text, EXIF/GPS stripping of pictures.
- Storage, the 30-day sweep, deletion with the conversation, and what the transcript shows for attachments, including removed ones.

**Out (and why):**
- Telegram, WhatsApp, voice and the paired phone: they have their own channels and limits (010, 011, 019, 026). All out of scope (BR-22); phone uploads are a later spec.
- Vault attachments ("Preguntarle a Alma"): unchanged (002 AC-5.1 to AC-5.4, BR-7).
- Generating, composing or looking at pictures: `../020-images/spec.md`; attached pictures keep `look_at_image` (BR-18).
- Creating or editing Office files and PDFs: `../021-office-documents-and-drawings/spec.md`; this spec reuses its reading, it does not change it.
- Attachments in company agents' conversations (BR-24).
- Automatic downscaling of large pictures (BR-14: refused instead).

**Amends (the existing specs are not edited here; each amendment is applied when this spec is implemented):**
- `002-chat`:
  - US-6 and §3 In (composer): attachments gain files.
  - AC-2.5 and BR-2: an attachment-only first message titles the thread with the first file's name.
  - AC-3.1: the send button is enabled with attachments and no text.
  - AC-4.11: the folded block in the sent bubble becomes the structured attachments of BR-21 (the old heading still renders for old threads).
  - AC-5.5: "Only `image/*` files are taken; other dropped files are ignored" is replaced by any accepted type (BR-13) and a visible refusal (AC-2.1).
  - AC-5.6 (default name, unchanged) and AC-5.7 (stored name: the sanitiser of BR-8, which also corrects the `\w` defect).
  - AC-5.8: the placeholder with attachments applies to every kind.
  - §7 Persistence: "pictures from the composer in the inbox" gains files, the store layout and the 30-day sweep.
- `020-images`: AC-6.1 and BR-13 (a pasted picture now also passes the 2 MiB limit and EXIF stripping and lives under `inbox/attachments/<id>/`); AC-6.5 (erase) and AC-5.1/AC-5.2 (`look_at_image` roots) unchanged because the store is inside the inbox; BR-14 unchanged (Q about native image blocks resolved: BR-18).
- `003-agents` BR-12 and `015-file-and-command-tools` BR-12: the app-tools list gains `read_attachment`.
- `022-security-and-privacy`:
  - AC-8.1 and BR-10: export keeps excluding attachments (now stated).
  - AC-8.2: erase includes the whole attachment store.
  - AC-8.3 and `002` AC-1.8: deleting a conversation by retention also deletes its attachments at once (BR-17); the new 30-day sweep is separate from thread retention.
  - AC-6.7: the attachments folder is inside the received-images root.
  - BR-4: unchanged (the masking of BR-20 is a new function, not `redact()`).
  - `docs/security/PRIVACY.md`, `CONTROLS.md`, `RISKS.md` (§7).
- `025-i18n-es-en`: new dictionary keys; text the model reads stays English (025 BR-17).
- `010-telegram` AC-5.1/AC-5.4 and `026`/`028`: not amended (Telegram photos keep today's behavior; the phone is out).
- `docs/context.md`: the Attachment and Inbox terms (done).

## 4. Users and stories
- **US-1** As the person, I want to attach a picture or a file to my message by pasting, dropping or picking it, so that I don't have to move it to a folder and name it in the text.
- **US-2** As the person, I want a file that cannot be attached to be refused with a reason, so that I never think something was sent when it was not.
- **US-3** As the person, I want the agent to be able to read what I attached, so that the attachment is worth the effort.
- **US-4** As the person, I want to know what leaves my machine, be warned about files that look like secrets, and have location data removed from my pictures, so that attaching does not leak more than I meant.
- **US-5** As the person, I want to see in the conversation what I attached, also after restarting and also when the file has been removed, so that I can follow what the agent was given.
- **US-6** As the person, I want attachments to disappear from disk on their own after a while, with the conversation, and with my data when I erase it, so that they do not outlive what I need.
- **US-7** As the maintainer, I want the rules for types, sizes, names, secret names, masking, EXIF stripping and the sweep in pure functions in `shared`, so that they are tested without a window.

## 5. Acceptance criteria
Tags: `[gap]` = testable, no test yet; `[manual]` = checked by hand.

### Attaching (US-1)
- **AC-1.1** (US-1) Given the desktop composer, when the person adds an image or a file in any of the ways of BR-6 and the file passes the rules of BR-13 and BR-14, then a chip with the file name and a remove X appears, the file is stored (BR-17) and nothing is sent to any provider until the message is sent. [gap]
- **AC-1.2** (US-1) Given a chip, when the person presses its X before sending, then the attachment is not part of the message and its stored file is deleted at once. [gap]
- **AC-1.3** (US-1) Given a message with attachments, when `chat.send` is accepted, then the chips are cleared; when it fails (a run already active, no agent), then the typed text is restored and the chips stay, as for pictures today (002 AC-3.3, AC-5.4). [gap]
- **AC-1.4** (US-1) Given several files at once (drop, folder drop, picker), then each is checked on its own: the accepted ones get chips and each refused one is reported (AC-2.x), without losing the accepted ones. [gap]
- **AC-1.5** (US-1) Given a pasted or dropped picture with no name or the default name `image.png`, then it is named `imagen-<timestamp>.png` (002 AC-5.6 unchanged). [gap]
- **AC-1.6** (US-1) Given files copied in Windows Explorer and pasted into the composer, then each becomes a chip or a refusal like a dropped file. [manual] Copy two files in Explorer and paste.
- **AC-1.7** (US-1) Given files dragged from the computer onto the chat, then files of any type are checked as in AC-1.1 and AC-2.x (not only `image/*`); a vault file dragged from the vault tree is still a vault attachment (002 AC-5.4). [manual]
- **AC-1.8** (US-1) Given the composer, then it has an attach button that opens a native file dialog allowing several files; cancelling changes nothing; the button is reachable with the keyboard and the gamepad focus (umbra-ui). [manual]
- **AC-1.9** (US-1) Given a folder is dropped, then only the files directly inside it are considered, each checked as a dropped file; its subfolders are skipped and the person is told; if those files exceed the count or total of BR-14, the whole folder is refused with a message. [gap]
- **AC-1.10** (US-1) Given a run in progress on the thread, then attaching is disabled like the rest of the composer. [manual]
- **AC-1.11** (US-1) Given a company agent's conversation (Empresas → Chats), then there is no attach button and a file dropped or pasted there is refused with a message. [manual]

### Refusals and failures (US-2)
- **AC-2.1** (US-2) Given a file whose type is not on the allow-list (BR-13) by extension or by its leading bytes (a `.png` that is really an executable, an SVG, an HTML file, an archive, a file with no extension, a text file with a NUL byte in its first 8000 bytes), when it is dropped, pasted or picked, then no chip appears, nothing is stored, and the person sees a message that names the file and the reason. It is never ignored silently. [gap]
- **AC-2.2** (US-2) Given a file of 2 097 152 bytes or less, then it passes the size rule; given one byte more, then it is refused with a message naming the file and the limit, and nothing is stored. This holds for pictures too, which are not downscaled. [gap]
- **AC-2.3** (US-2) Given more than 5 files in a message, or more than 10 MiB in total, then the files that exceed it are refused with a message and nothing of them is stored. [gap]
- **AC-2.4** (US-2) Given a file that cannot be read (deleted after dropping, locked, a folder where a file was expected, no permission), then it is refused with the reason and nothing is stored. [gap]
- **AC-2.5** (US-2) Given storing fails (disk full, store not writable), then the chip does not appear, the error is shown, and no partial file is left. [gap]
- **AC-2.6** (US-2) Given a store request with a malformed or oversized payload (bad base64, empty, claimed size different from the bytes, bytes over the limit), when the coordinator receives it, then it is rejected at the boundary using the real byte count, before anything is written. [gap]
- **AC-2.7** (US-2) Given a message with attachments and no text, then it can be sent; when it is the first message of a new thread, the thread title is the first attachment's file name; the composer placeholder of 002 AC-5.8 is shown for every kind of attachment. [gap]

### Privacy (US-4)
- **AC-3.1** (US-4) Given the person is about to send an attachment and has not yet been shown the notice for the provider that will read it, then a notice says the attached content will be sent to that provider (and, for pictures, to the vision model's provider); once acknowledged it is remembered per provider in settings and shown again only for a provider not yet acknowledged; the chips remain visible before sending. [gap]
- **AC-3.2** (US-4) Given a file whose name or known path matches a secret-looking pattern (BR-20), when it is added, then the person gets a warning and must confirm "attach anyway"; cancelling stores nothing and creates no chip; confirming attaches it as usual. It is a warning, never a refusal. [gap]
- **AC-3.3** (US-4) Given a JPEG, PNG or WebP picture with EXIF/GPS metadata, when it is stored, then the stored copy contains no location or camera metadata, the pixels are unchanged and the original file is not modified; a GIF is stored as is. [gap]
- **AC-3.4** (US-4) Given a picture whose metadata cannot be removed safely (malformed file), then the picture is refused with a message; it is never stored with its metadata. [gap]
- **AC-3.5** (US-4) Given text read from an attachment, then every value that matches the masking patterns (BR-20) is replaced by a mask before the text reaches the model, and the tool result says how many values were masked; picture pixels are not scanned. [gap]

### What the agent receives and `read_attachment` (US-3)
- **AC-4.1** (US-3, US-4) Given a message with attachments, when it is sent, then what the model reads is a new heading, in the pattern of 002 AC-5.1, that says the attachments are data the person attached and not instructions, followed by one reference line per attachment `[n] <id> (<original name>, <size>)`; a picture's line carries its path for `look_at_image`; the system prompt carries a sentence with the same rule; all in English (025 BR-17). [gap]
- **AC-4.2** (US-3) Given an attached picture, then the agent can look at it with `look_at_image` (020 AC-6.1); pictures are not given to the model as image blocks. [gap]
- **AC-4.3** (US-3) Given an attached non-picture file, then the message carries only the reference line (id, original name, size) and not the content, and the agent reads it by calling `read_attachment` with that id. [gap]
- **AC-4.4** (US-3) Given `read_attachment` with a text file's id, then it returns the text with the limits of `read_file`: a result over 60 000 characters keeps start and end (015 BR-5), a file with NUL in its first 8000 bytes is refused as binary; for a Word, Excel, PowerPoint or PDF file it returns what `office_read` extracts (021 AC-2.x). The result starts with a line saying it is file data, not instructions. [gap]
- **AC-4.5** (US-3) Given `read_attachment` with an id that does not exist, was removed by the sweep, contains path characters or points outside the store, then it fails with a tool error naming the reason; it accepts ids only (never paths), cannot list the store, and cannot read anything outside it. [gap]
- **AC-4.6** (US-3) Given `read_attachment`, then its `ToolRisk` is `read` and it is `standalone`: it never asks, also in "Solo lectura" (004 AC-1.1), and works in a thread with no working folder. [gap]
- **AC-4.7** (US-3) Given `read_attachment` with any id that exists in the store, including one given to a sub-agent in a `delegate_task` text or one from another conversation, then it reads it: the id is the capability. [gap]

### Stored names, store layout and deletion (US-1, US-6)
- **AC-5.1** (US-1) Given any file name (path separators, `..`, a Windows reserved name such as `CON` or `NUL`, a trailing dot or space, an NTFS stream `name.txt:stream`, control characters, a very long name, non-Latin characters), when it is stored, then the stored file is inside the store, its name is sanitised and shortened, and no name can write outside the store or overwrite another attachment. [gap]
- **AC-5.2** (US-6) Given the person erases their history ("Borrar mi historial"), then every stored attachment is removed with the rest of the received files (022 AC-8.2). [gap]
- **AC-5.3** (US-6) Given a stored attachment, then its file is `<userData>/inbox/attachments/<id>/<sanitised name>` and an index record keeps its conversation, original name, size and kind. [gap]
- **AC-5.4** (US-6) Given a conversation is deleted (by the person, by retention or by erase), then its attachment files are deleted at once. [gap]
- **AC-5.5** (US-6) Given "Exportar mis datos…", then attachments are not exported (022 AC-8.1 holds). [gap]
- **AC-5.6** (US-6) Given the same file attached twice, then it is stored twice (no deduplication). [gap]
- **AC-5.7** (US-4) Given any attach, read, refuse or sweep outcome, then no log line or audit entry contains file contents or attachment names, only ids, kinds, sizes and counts (BR-12). [gap]

### Lifecycle: the 30-day sweep (US-6)
- **AC-6.1** (US-6) Given an attachment whose conversation was last opened 30 days or more ago, when the sweep runs, then the stored file is deleted; given 29 days 23 hours, then it is kept. The message text, the other attachments and the other conversations are untouched. [gap]
- **AC-6.2** (US-6) Given the coordinator, then the sweep runs when it starts and every 12 hours, like retention (002 BR-6); a conversation with a run in progress is never swept. [gap]
- **AC-6.3** (US-6) Given the conversation is opened again, then its 30 days restart; a file already deleted does not come back. [gap]
- **AC-6.4** (US-5, US-6) Given a message whose attachment file was removed, then the message still renders, and its chip shows the name and a "removed" state instead of failing; `read_attachment` and `look_at_image` return a tool error saying the file was removed. [manual] Delete a stored file and reopen the thread.
- **AC-6.5** (US-6) Given a file that cannot be deleted by the sweep (locked), then the others are still processed, the failure is logged without file names, and it is retried at the next sweep. [gap]
- **AC-6.6** (US-6) Given the sweep, then it deletes only files the attachments index knows; legacy inbox pictures, Telegram photos and camera snapshots keep today's behavior (kept until erase). [gap]
- **AC-6.7** (US-6) Given a conversation, then its last-opened time is set when it is selected in the desktop window, when it is opened on the phone, and when a user message is sent into it from any channel; a routine, house-rule or company run does not set it; a conversation that gets an attachment has it set at that moment. [gap]

### Transcript (US-5)
- **AC-7.1** (US-5) Given a sent message with attachments, then the transcript shows them with the message (name, and a thumbnail for pictures), from the structured attachments of BR-21, and they are still shown after restarting the app. [manual] Attach one picture and one file, restart.
- **AC-7.2** (US-5) Given a thread saved before this spec (a message with the English heading "Attached image…" or the legacy Spanish heading), then it renders as before (002 AC-4.11). [gap]
- **AC-7.3** (US-5) Given the composer, then every user-facing text of attaching (chip, refusals, notice, warning, picker, removed state) is in the Spanish and English dictionaries. [manual] Check both languages.
- **AC-7.4** (US-5) Given an attachment, then a thumbnail is shown only for PNG, JPEG, WebP and GIF; every other type shows an icon and the name. [gap]
- **AC-7.5** (US-5) Given a chip or an attachment in the transcript, then "open with the system app" is offered only for PNG, JPEG, WebP, GIF, PDF, .docx, .xlsx, .pptx, .txt, .md, .csv, .json and .log; for source-code types and .xlsm it is not offered, and an attachment is never launched through any other path. [gap]

### Channels not in scope
- **AC-8.1** (US-3) Given Telegram, WhatsApp, voice or the paired phone, then their behavior is unchanged by this spec (Telegram photos still land in the inbox as `telegram-<id>.jpg`, 020 AC-6.2). [gap]

## 6. Business rules
Rules the code must obey. Everything here is decided: (human) = said by the human; (planner) = chosen by the planner on the human's delegation (the human accepted it with "re bien todo", 2026-11-08, and may still veto); (accepted) = proposed by the planner and accepted by the human.

- **BR-1** Attaching is an explicit act of the person in the composer. Nothing is attached automatically, and an agent never attaches on the person's behalf.
- **BR-2** An attachment is data, not instructions. This holds for text read from the file, for a reference handed to the agent and for a picture: the message and the tool result say so, as vault attachments and `office_read` already do (002 AC-5.1, 021 AC-2.1). Content found inside a file never changes the approval policy or the tools offered.
- **BR-3** (human) The limit is 2 MB per file. *Read as 2 MiB = 2 097 152 bytes, the same number as `read_file` (015 BR-5), so anything attachable is readable; the human may say decimal 2 MB instead.* It applies to every kind of file, pictures included.
- **BR-4** (planner, on the human's delegation) A non-picture attachment is read by a new app tool `read_attachment`, `ToolRisk` `read`, `standalone`, that takes the attachment id (never a path) and reads only inside the attachments store. *Why: the layers allow it (a coordinator tool receiving the store folder through `ToolContext`, as `inboxDir` already is; no new IPC and no renderer or main logic); it matches the 2 MiB `read_file` limit and reuses the `read_file` text rules and the `office_read` extraction; it works with no working folder and for a sub-agent that is given the id; it keeps the confinement controls of 015 and 022 intact (widening `read_file` to the inbox would let `list_dir` enumerate every conversation's files, and copying into the working folder would write into the person's projects); and it costs tokens only when the agent actually reads (inlining costs them every turn).*
- **BR-5** (human) Privacy measures, all required: (a) a notice that attached content goes to the provider of the agent's model; (b) a warning, with a confirmation, for secret-bearing file names; (c) masking of secret-looking values in text read from an attachment, and removal of EXIF/GPS metadata from stored pictures. Redaction is best-effort, not a guarantee (§7). Details: BR-20.
- **BR-6** (human) Ways to attach, all of them: paste (including files copied in Explorer), drag and drop, a native picker button, and folder drop. Folder drop behavior: BR-15.
- **BR-7** (human) An attachment file is deleted from disk when 30 days pass without its conversation being opened. (planner) The sweep runs at start and every 12 hours, like retention (002 BR-6), skips conversations with a run in progress, and leaves the message in place with a "removed" chip.
- **BR-8** A stored attachment lives under one folder owned by the app (the store); the stored name is derived from the original with every character outside a safe set replaced and is never used as a path by the renderer; the sanitiser is a pure function in `shared`, tested with hostile names (AC-5.1). *Known defect to fix separately: the existing sanitiser in `saveInboxImage` (`src/coordinator/index.ts`, line 500) is written `/[^w.-]+/g` (a literal `w`, not `\w`), which turns almost every letter of a name into `_`; 002 AC-5.7 documents it the same way. It goes to `/fix`, not into this spec.* The stored bytes are never changed, except for the metadata strip of BR-5(c).
- **BR-9** Validation of type and size, the secret-name check, the masking, the metadata strip, the name sanitiser and the sweep decision (is this file due?) are pure functions in `shared` with an injected clock; the renderer only calls them and shows the result (Constitution III).
- **BR-10** The coordinator re-checks type and size on the bytes it receives. The renderer's check is a convenience, never the guard (Constitution IV).
- **BR-11** Text for the model is English; text for the person goes through the dictionaries (025).
- **BR-12** Secrets, file contents and attachment names are not written to logs or audit entries (022 BR-4).
- **BR-13** (accepted) Accepted types are an allow-list checked by extension and by leading bytes: pictures PNG, JPEG, WebP, GIF; text and code files (.txt, .md, .markdown, .csv, .json, .log, .css, .yml, .yaml, .toml, .ini, .xml, .sql and the source extensions .js, .ts, .jsx, .tsx, .py, .java, .c, .h, .cpp, .cs, .go, .rs, .php, .rb), accepted only if no NUL appears in the first 8000 bytes; PDF; Word (.docx), Excel (.xlsx, .xlsm) and PowerPoint (.pptx) as `office_read` reads them (021 AC-4.1). Everything else (executables, scripts such as .bat .cmd .ps1 .vbs .sh, archives, SVG, HTML, legacy Office formats, files with no extension) is refused with a message. The list lives in one constant in `shared`.
- **BR-14** (accepted) Per message: at most 5 files and 10 MiB in total. A picture over 2 MiB is refused (no automatic downscaling).
- **BR-15** (accepted) Folder drop takes only the files directly inside the folder; subfolders are skipped with a message; if those files exceed BR-14, the whole folder is refused.
- **BR-16** (accepted) A conversation is "opened" when it is selected in the desktop window, opened on the phone, or receives a user message from any channel (a `lastOpenedAt` on the thread); routine, house and company runs do not count. The sweep covers only files stored by this feature.
- **BR-17** (accepted) Store layout and lifecycle: `<userData>/inbox/attachments/<id>/<sanitised name>` with an index of conversation, original name, size and kind; deleting a conversation (by the person, retention or erase) deletes its files at once; export keeps excluding them (022 AC-8.1); removing a chip deletes the stored file at once; no deduplication.
- **BR-18** (accepted) Attached pictures keep `look_at_image` (020 BR-14: the agent never holds an image).
- **BR-19** (accepted) Wording: a new heading in the pattern of 002 AC-5.1, a reference line `[n] <id> (<original name>, <size>)`, a data line at the top of every `read_attachment` result, and a sentence in the system prompt.
- **BR-20** (accepted) Privacy details: the notice is shown once per provider and remembered in settings; secret-looking names are `.env*`, `.npmrc`, `.netrc`, `*.pem`, `*.key`, `*.pfx`, `*.ppk`, `id_rsa*`, `id_ed25519*`, `*.kdbx`, `passwords.*`, `credentials*`, and browser profile files such as `Login Data` and `Cookies`, matched on the name and, when the path is known, on the path; masking covers the patterns of `redact()` in `shared/audit` (`xai|sk|LLM` keys, `Bearer` tokens, `password|token|secret|api_key = value`) plus private-key blocks (`-----BEGIN … PRIVATE KEY-----`) and AWS access key ids, GitHub tokens, Google API keys and Slack tokens, as a new pure function in `shared` (the audit module is node-only), and the tool result says how many values were masked; EXIF/GPS is stripped from JPEG, PNG and WebP, and GIF is left as is. *The exact list of cloud-key formats is the planner's elaboration of "common cloud key formats".*
- **BR-21** (accepted) The user message carries a structured `attachments` list (id, name, kind, size) that the transcript renders and the provider layer turns into the text of BR-19; old threads render as before.
- **BR-22** (accepted) Voice, Telegram, WhatsApp and the paired phone are out of scope; the phone gets its own later spec.
- **BR-23** (accepted) A message may consist only of attachments; a new thread is titled with the first file's name; the placeholder of 002 AC-5.8 shows for every kind; attaching while a run is in progress stays disabled.
- **BR-24** (accepted) Attachments are not available in company agents' conversations. A sub-agent can read an attachment whose id is given in its `delegate_task` text, and `read_attachment` reads any id in the store (ids are unguessable and unlistable; the id is the capability).
- **BR-25** (accepted, tightened by the planner) Display: thumbnails only for raster pictures (PNG, JPEG, WebP, GIF); other types show an icon and name. "Open with the system app" is offered only for pictures, PDF, .docx, .xlsx, .pptx, .txt, .md, .csv, .json and .log. *This is narrower than the accepted default ("only the accepted types"): source-code types would be launched by Windows script hosts or editors and .xlsm can carry macros, so they are not openable from a chip. The human may widen it.*

## 7. Constraints and risks
- **Layers touched** (see `docs/architecture.md`):
  - `shared`: type and size rules, secret-name patterns, masking, EXIF stripper, name sanitiser, the sweep decision, the structured `attachments` field on the user message and its migration-free rendering of old threads, the store request type next to `files.saveImage` (`shared/types.ts`), the dictionary keys.
  - `renderer`: `ChatView.tsx` (today `addImages` keeps only `f.type.startsWith('image/')` and `onDrop` only takes images or `text/x-alma-path`), `lib/attachments.ts`, `MessageList` for the display, the picker button, the notice and warning dialogs.
  - `main`: the native file dialog and, where the page cannot get a path (Explorer paste, folder drop), the file system read; new IPC entries go in `shared/desktop-api.ts` and the preload (the renderer has no disk).
  - `coordinator`: the store request (generalising `files.saveImage` / `saveInboxImage` in `index.ts`), the attachments index and `lastOpenedAt` on the thread, the `read_attachment` tool (registered in `appTools`, `inboxDir` already reaches `ToolContext`), the sweep timer, deletion with the conversation, `privacy.ts` (`erasePersonalFiles`). `read_attachment` reuses text and Office extraction from sibling tool modules, inside the coordinator.
- **Security / privacy:** a new category of stored personal data (any accepted file the person owns) with its own retention (30 days from last opened), and a new flow to a third party (the file's text to the answering provider; a picture to the vision provider). `docs/security/PRIVACY.md` (what leaves the machine, the notice, the 30-day rule), `CONTROLS.md` (secret-name warning, masking, EXIF strip, the store confinement, the allow-list and the `read_attachment` limits) and `RISKS.md` (residual risks) change in the same PR. Honest limits: the masking is a pattern match, so a secret in a format the patterns do not know goes through, and pixels are not scanned; the secret-name warning sees only the name and path, not the content; the notice informs but does not stop; an allow-listed file can still contain hostile text, so the real guard against prompt injection is the approval policy (BR-2). Other risks to cover in the plan: path traversal and Windows names (AC-5.1), memory pressure from base64 over IPC (AC-2.6), a hostile file shown in the transcript (BR-25), the `read_attachment` surface (it reads only ids in the store, risk `read`, no listing, but any id is readable by any conversation: BR-24).
- **Performance / platform:** Windows paths and reserved names; a 2 MiB file is about 2.8 MB as base64 over IPC; where the page cannot read the disk the main process reads the path; the sweep is one directory pass every 12 hours.

## 8. Open Questions
None — all resolved on 2026-11-08, defaults accepted by the human.
