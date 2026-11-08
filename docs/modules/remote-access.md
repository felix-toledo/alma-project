# Remote access

> Control Alma from a phone browser: chat, approvals, house, cameras, notes and conversations over Tailscale, paired by QR, everything off by default. Spec: [026 · Remote access](../../.specify/specs/026-remote-access/spec.md), extended by [028 · Remote notes, conversations and phone app polish](../../.specify/specs/028-remote-vault-and-threads/spec.md). Test status: all 11 features with automated tests (210+ assertions across the `remote-*` suites); the phone-side checks (Tailscale on iOS/Android, install prompt, push delivery, passkey on a real phone) are manual (`S1`–`S3`).

## What it does

- Serves a phone web app (PWA) from the person's own PC over their Tailscale tailnet: the PC exposes nothing to the public internet.
- Pairs one phone at a time with a QR plus a 6-digit code typed on the PC; the phone also registers a passkey so sensitive actions ask for the fingerprint or face again.
- Gives the phone six scopes, each a separate on/off switch on the PC: chat, answer approvals, house control, camera pictures, **Notes** (read the active vault, read-only) and **History** (read other conversations), plus the sub-switches locks and alarms (under house) and **continue conversations** (under History). Everything starts off.
- Lets the phone read notes and conversations without keeping anything: the phone stores no note and no conversation, and the vault is never written from the phone.
- Reuses the same tools the desktop uses for chat, approvals, house and cameras, so the same rules, confirmations and audit apply (PD-10).
- Notifies the phone when an approval is waiting: the push carries no content, the phone fetches the question when opened (PD-15).

## How to use it

**Turn it on.** «Configuración» → Acceso remoto → «Activar el acceso remoto». The setup wizard walks through it: install Tailscale, sign in with the same account on PC and phone, serve over HTTPS, test the connection, then pair the phone. Each step explains what to do and what can go wrong; the wizard remembers where it stopped.

**Pair a phone.** On the last wizard step (or the pairing card later), the PC shows a QR and a fingerprint (two words). Scan the QR with the phone camera, open the link, type the 6-digit code shown on the PC, and confirm the fingerprint words match. The PC asks for confirmation in a native dialog; only then the phone is paired. At most 5 phones, each also registers a passkey during pairing (PD-5).

**Use the phone.** The PWA has five destinations, always in this order: Chat, Notes, «Casa» (house), «Cámaras» (cameras) and «Ajustes» (settings); approvals show on the Chat screen. See "Phone app navigation" below. Chat is plain text (no pictures, no files, 8000 characters per message). Approvals show the full request with **Permitir** (allow once) and **Rechazar** (reject) — like voice, the phone never answers «Siempre permitir»; a question already answered elsewhere says so. «Casa» lists the same devices as the desktop with the same confirmations; opening a lock or disarming the alarm asks for the passkey. «Cámaras» shows one still per camera («Ver foto»). The phone can be forgotten from its own «Ajustes» tab («Olvidar este teléfono») or revoked from the PC at any moment.

**Revoke.** «Configuración» → Acceso remoto → the device card → «Revocar». The phone stops working immediately; an idle phone (15 days without use) and an expired approval question are swept automatically. Turning the whole feature off stops the server at once (the tray icon stays only if «run in tray» is also on).

## How it works

Pieces:

| File | Role |
|---|---|
| `src/coordinator/channels/remote/` | The channel: HTTP API, pairing, sessions, one flow per scope (`chat.ts`, `approvals.ts`, `home.ts`, `cameras.ts`, `notes.ts`, `threads.ts`), `runs.ts` (run ties), `thread-view.ts` (message windows), `quiet.ts` (keeps channels silent about phone-started runs) |
| `src/shared/remote/`, `src/shared/vault/`, `src/shared/threads.ts` | Pure core: API contract (`api.ts`, `wire.ts`), limits (`limits.ts`), authorization (`authorize.ts`), crypto (`crypto.ts`), pairing and step-up machines, WebAuthn, audit/activity row builders, `status.ts`; vault path rules (reachable, excluded, listing, find by name, asset resolution) and the one definition of which conversations are listable |
| `src/remote-client/` | The PWA: screens, offline shell, keys in IndexedDB; `lib/` holds the pure rules (navigation, screen states, refusal-to-text mapping, markdown links) |
| `src/renderer/src/remote/` | PC tab: settings hook, wizard, pairing/devices/scopes/exclusion/activity cards |
| `src/main/` | Tray state, host confirmations, sealed storage of the channel keys |

**One security layer, transport as strategy** (BR-1). `RemoteChannel` owns every check; the transport (Tailscale Serve, or the in-memory test transport) only moves bytes. The network listener binds loopback only and refuses anything that is not from the tailnet (T0, PD-8).

**Pairing** (PD-7). The PC creates an offer (QR payload, single use, 3 minutes) and a 6-digit code derived from it (HMAC-SHA256, 3 attempts, then a 5-minute lockout; 5 offers per minute). The phone proves possession of the offer, the person confirms on the PC, and the passkey registration (challenge bound to offer + PC nonce) completes the binding. The fingerprint (two words) defends against pairing with the wrong host on the tailnet.

**Sessions.** The phone holds an opaque Bearer token (1 hour, in memory on the PC, PD-1); the refresh token (sealed, 15 days of idle) renews it silently. Every request re-checks: known device, scope on, sensitive action needs a fresh step-up, camera pictures need the cameras scope.

**Step-up** (BR-24). Locks, alarms and gate/garage covers need a passkey assertion made in the last 60 seconds for that exact device + thing + action (single use, fail closed). A stolen unlocked phone can chat and answer approvals until revoked, but cannot open or disarm anything without the owner's biometrics.

**Narrow API.** A closed list of routes (`ROUTES` in `src/shared/remote/api.ts`; a snapshot test fails when one is added without a scope, an audit class and a strict body schema), each validating its body at the edge: `chat/send|new|stop`, `state`, `approvals`, `approvals/answer`, `home/things|control`, `cameras`, `cameras/still`, `status`, plus `hello`, `pair/*`, `session/*`, `stepup/challenge`, `push/*`, `pong`, `forget`. Spec 028 adds eight POST routes, all behind a session, the pure authorization verdict and the shared rate limit:

| Route | Scope | Audited |
|---|---|---|
| `notes/list` (a folder), `notes/find` (by name) | Notes | no |
| `notes/read` (a note), `notes/image` (an image a note embeds or links) | Notes | yes: vault-relative path, outcome |
| `threads/list` (30 a page) | History | no |
| `threads/read` (last 30 text messages, or an earlier page; with `since` + `wait` a long poll) | History | yes: conversation id, outcome (the `since` polling is not) |
| `threads/send` | History + continue conversations | yes: conversation id, outcome |
| `threads/stop` | History | yes: conversation id, outcome |

`GET /api/status` returns exactly the on/off state of each scope and sub-switch (no device id, exclusions or camera ids). No route writes, renames, deletes or searches the vault, and none renames or deletes a conversation or changes its agent, model or folder. Chat input is text only (8000 chars), the model answer is cut at 1500 chars for approvals; polls are long (25 s) so the phone makes no WebSocket (PD-6).

**Notes** (028). Reads go through the active vault at each request. The pure `isReachable` rejects dot segments, `node_modules`, `..`, absolute paths and excluded folders, and the file must be listed by the vault's own tree; bytes come from `KnowledgeBase.readBytes`, confined like the desktop. Every unreachable path (missing, hidden, excluded, outside the vault, a junction out) gets the same `unavailable` answer. Listing a hidden, excluded or missing folder returns an empty folder, so existence is never revealed. `.md` notes are served as UTF-8 text (over 1 MB: refused, never cut); images up to 2 MB as base64; any other type is `unsupported` but still listed. A path in a different casing is served under the vault's real casing. The name filter searches file paths (not content) of the whole reachable vault, up to 50, with the same fuzzy rule as the PC's quick switcher. With no active vault, or its folder gone, the phone gets `vault: none`.

**Conversations** (028). The list is what the PC's Chat tab lists (`listableThreads`; company-agent threads never), newest first; the shared remote thread carries a `current` mark. A missing id and a company id answer the same `gone`. Sending runs the conversation's own agent through the one run entry the PC uses; the user message is committed first. A device has at most one phone-started run (`run-active`), a conversation already running anywhere answers `busy` (nothing queued, nothing interrupted), and only the starter can stop its run. The conversation the phone writes into follows live (long poll); others are snapshots with a refresh control. Sending into the shared remote thread's id behaves like the Chat tab and never re-points it. The run follows the app's normal approval policy (see Security and privacy).

**Run ties and approvals** (028). `RunTies` (memory only) records which device started which run. A device sees and answers the approvals of the shared remote thread (as in 026) and of its own by-id runs, only with the approve scope on; with approve off the phone shows "waiting for an approval on the PC" and the approval stays pending for the other surfaces. The content-free push for a by-id run goes to its starter only. When access is cut, the runs are aborted through the PC's own abort (their approvals resolve as denied): the kill switch, remote off, and a revoked, forgotten or swept device abort that device's runs; History or the sub-switch off aborts the by-id runs. A run in the shared thread survives turning only the chat scope off. `quiet.ts` sits between the coordinator and Telegram, WhatsApp and the voice assistant: while a phone-started run is going, its approval prompt and streamed text are not forwarded to those channels, and an answer from them for a phone-owned approval is ignored (the PC window still gets every event and can answer).

**Push** (PD-15). The PC signs its own VAPID key and sends empty pushes through the browser vendor's service when an approval lands on a remote thread and the approve scope is on. The Service Worker wakes, shows a generic «Tenés una aprobación pendiente» ("You have a pending approval") with no details, and the phone fetches the question over Tailscale when opened.

**Audit.** Remote changes and camera pictures are audited like desktop ones (`remote.authorize`, `remote.run`, `remote.pair.approved`, `remote.revoke`, `remote.stepup.*`), plus the four failures (wrong Tailscale identity, unknown/expired device, scope off, bad step-up). The PC activity card reads them back newest-first, at most 50 rows.

## Phone app navigation

- **Bar.** A persistent bar with five destinations in a fixed order (`NAV_ORDER`): Chat, Notes, «Casa», «Cámaras», «Ajustes». The current one is marked and exposed to assistive technology (`aria-current="page"`). A destination whose scope is off stays visible and shows its state ("turned off on the PC"), because scopes can change while the app is open.
- **Chat.** The shared remote thread as in 026 (send, stop, "New conversation", approvals). Its header has a Conversations entry: the list (30 a page, "load more", the shared thread marked as this phone's chat) and, from it, a conversation. Reading shows the last 30 messages with "load earlier". The compose box appears only when continue conversations is on; the conversation this phone writes into follows live, the others show a snapshot with a refresh control. Approval cards of the phone's own by-id run are marked with their conversation.
- **Notes.** Folder list (folders first), a name field that searches the whole reachable vault, and the note reader (GitHub-flavored Markdown without raw HTML, frontmatter hidden, `[[wiki links]]` as plain text, relative links open inside the reader under the same rules, external links open in the browser only on a tap, remote images never fetched, images lazy-loaded so a note with many images does not trip the rate limit).
- **Back.** The system back gesture and the on-screen control go up one level (note to its folder, folder to its parent, conversation to the list, the list to Chat) and leave the app only from a top level. Position is kept while the app stays open and is never stored.
- **States.** Every screen that loads from the PC has the same set: loading (after a short threshold), empty (what is missing), error (one concrete cause), scope off, PC unreachable (retries by itself with backoff; a typed message stays in the box) and revoked. "Retry" is offered only where trying again can help, not for a scope that is off, a revoked phone, a note that is too big or a rate limit. A pure mapping gives every refusal exactly one text, and a test fails when a new refusal has none. On any non-content state the content is dropped from memory; coming back to a screen asks the PC again.
- **Settings.** The connection state, a read-only list of what this phone can do now (chat, approve, house, cameras, locks and alarms, notes, conversations, continue conversations, each on or off), the app version and «Olvidar este teléfono» with its confirmation. No language switch (the app follows the phone) and no scope controls (those are PC-only).
- **Look.** Dark only, `umbra-ui` adapted to touch, the slow background kept, reduced motion honored, without sounds or music. Texts are keys of the PWA's own Spanish and English dictionaries, checked for parity.

## Settings and data

| Setting (`remote.*`) | Default |
|---|---|
| `enabled` | `false` (off by default, BR-10) |
| `scopes: chat, approve, home, cameras, vault, history` | all `false` (re-confirmed every time the feature is turned on; `vault` is shown as «Notas», `history` as «Conversaciones») |
| `sensitive`, `continueHistory` | `false` (sub-switches; off at every turn-on; `continueHistory` also resets when History is turned off) |
| `vaultExcluded` | `[]` (vault-relative folders hidden from the phone; kept across turn-ons; a damaged value resets the list and turns Notes off) |
| `tailscale` | `{ mode: 'auto', hostName, port }` (Serve lifecycle; port picked free) |
| `devices` | at most 5 paired phones |

On disk under `<dataDir>/remote/`: `devices.json` (names, scopes, timestamps; no key material), `channel-sealed` and `push-sealed` (keys sealed with the OS keychain). The phone keeps its keys in IndexedDB and its Service Worker caches only the app shell, never `/api` (BR-32). Export includes `remote-devices.json` (names and dates, no keys); erase revokes every phone and deletes the directory.

## Limits and rules

Single source: `REMOTE_LIMITS` (`src/shared/remote/limits.ts`).

| Rule | Value |
|---|---|
| Pairing code attempts / lockout | 3 attempts, then 5-minute lockout |
| Offer | single use, 3 minutes |
| Offers per minute | 5 |
| Paired phones | 5 |
| Idle phone sweep | 15 days |
| Session / refresh | 1 hour / 15 days idle |
| Step-up assertion | 60 seconds, single use, bound to device + thing + action |
| Chat message / history window | 8000 chars / last 30 messages, 1 MB cap (oldest cut) |
| Camera still | 1 MB, at most 2 MB decoded |
| Note / note image | 1 MB of UTF-8 text, refused over it / 2 MB |
| Name filter | up to 50 results, file names only |
| Conversation list / messages | 30 a page, "load more" / last 30, "load earlier" pages of 30, within the 1 MB cap |
| Phone-started runs | 1 per device at a time |
| Requests per device | 60 a minute, shared by every route (notes, images and conversations add no limit of their own) |
| Long-poll / test wait | 25 s / 10 s |
| Held long polls per device | 2 (the state poll plus one conversation follow); short requests do not count; a third is refused as rate-limited |
| Request timeout | 30 s, then the generic `500 failed` answer (the long poll answers first) |
| Approval text to the phone | 1500 chars |

## Security and privacy

- Off by default at every level: feature, scopes, Serve. Turning the feature on re-asks for every scope; turning it off stops the server immediately.
- The threat model is explicit about what pairing does and does not defend ([RISKS.md](../security/RISKS.md) R-14): the fingerprint defeats pairing with the wrong host, not a compromised PC; a stolen token is valid up to 1 hour; an unlocked phone chats and approves until revoked.
- Secrets (channel keys, push keys, refresh tokens) are sealed with the OS keychain, never logged, never in fixtures or prompts; the window only learns whether they exist.
- Push carries no content through the vendor; camera stills travel only over the tailnet; the tailnet identity of every request is checked (PD-8).
- Privacy: pairing metadata (names, dates) is exported without key material and erased on request; idle phones are forgotten automatically. See [PRIVACY.md](../security/PRIVACY.md).
- Vault text and images, and conversation text, now reach the owner's phone (Notes and History scopes). Before spec 028 vault content left the PC only toward a model provider ([vault-and-knowledge](vault-and-knowledge.md), [security](security.md)). Nothing goes to a new third party and nothing is stored on the phone; responses are `no-store`, the service worker never handles `/api/`, and the PWA CSP allows `data:` images only (camera stills and note images), never a remote one.
- A stolen, unlocked phone with History and «continue conversations» on can make an agent work inside a desktop conversation. The approval policy is the app's normal one: in «Permitir todo» mode `exec` and `write` do not ask, a phone-started run included; `publish` always asks. Narrowing it is not done in this spec ([R‑14](../security/RISKS.md)).
- The remote chat agent can still call `read_note` and `search_knowledge` in the shared remote thread; the Notes scope gates the direct reader only.
- Audit entries for notes and conversations carry the device, the outcome and a vault-relative path or a conversation id, never text or titles.

## How it is tested

- `tests/remote-*.test.ts` cover the pure core (authorize order, pairing machine, crypto, limits, passkey registration/login, step-up), the channel over the in-memory test transport (pairing end to end with a fake PC confirmation, sessions and sweep, chat window and caps, approvals first-answer-wins, house reuse of the same tools and risks, camera stills, devices admin, audit entries, refusals byte-identical), the coordinator wiring (privacy export/erase, tray state, tool trail) and the PWA bundle (no Node imports, no hard-coded host, Service Worker never caches `/api`, own dictionaries complete).
- Spec 028 adds `tests/remote-notes-scopes.test.ts` (settings, confirmation order, route snapshot, status keys), `remote-vault-logic` (reachable, excluded, listing, find, asset resolution, exclusion moves), `remote-notes`, `remote-threads`, `remote-runs` (run ties, approvals, abort on cut, quiet channels), `remote-audit`, `remote-privacy`, and for the phone `remote-client-notes`, `remote-client-states`, `remote-client-conversations`, `remote-client-can` and `remote-i18n`. Titles carry `(028)` because acceptance-criterion ids repeat across specs.
- Not covered automatically: the renderer cards and wizard (typecheck, lint and a manual run, like every screen), the real Tailscale Serve lifecycle, and the phone-side manual checks below.
- By hand (spec §S1–S3): install Tailscale on a real Android and iPhone, pair each, chat, answer an approval from each surface, operate a lock with the passkey, take a camera still, kill the PWA for a day and check the push arrives with no content, revoke mid-session, uninstall Tailscale and check the PC marks the channel down.
- By hand for 028 (the headless Chrome checks are done; a real phone and a screen reader are not): turn on Notes and see the native dialog name the vault folder; exclude a folder and check it vanishes from the phone and from the filter; open a note with an image, a very long note and an unsupported file; turn on History, then the sub-switch (a second dialog); continue a PC conversation and watch it update on the PC; with a Telegram conversation, check nothing arrives on Telegram; stop a run; turn History off mid-run and check the run stops; try "Permitir todo" and confirm that `exec` does not ask. Check the activity list on the PC shows the opens, sends and stops. Accessibility per release: 44 px targets, contrast, focus ring, screen reader, 200 % text, landscape, reduced motion.

## Known limits

- Needs Tailscale on PC and phone with the same account; without it the channel reports `tailscaleDown` and the wizard explains how to install it. Serve setup and the human Tailscale tasks (S2) are tracked separately from this spec's code.
- The phone needs the PC on and Alma running; there is no cloud relay and no offline queue beyond the cached shell.
- iOS may evict the browser storage (keys and cache) under pressure; then the phone must pair again.
- Renaming the PC (its Tailscale hostname) invalidates keys and passkeys: every phone must pair again. The machine name is visible in TLS certificate logs.
- «No internet» on the phone only reflects what the OS reports (PD-13); a captive portal can lie.
- 028 limits: notes are read-only (no create, edit, rename or delete from the phone); no content or semantic search from the phone; company conversations and company vaults are not reachable; only the active vault is served; the phone cannot start a conversation with a chosen agent or change a conversation's agent, model or folder; the 2-connections-per-device limit of 026 is still not enforced (026 AC-10.3); a rename of an excluded folder outside Alma leaves it listed as stale until the person fixes it; the real-phone checks (screen reader, 200 % text, landscape, keyboard over the compose box) are manual.

## See also

- [settings](settings.md) (the Acceso remoto tab), [approvals](approvals.md) (answering from the phone), [home](home.md) (the same house and camera tools, remotely), [security](security.md) (tray and privacy), [app-shell](app-shell.md) (tray icon).
- Threats and controls: [RISKS.md](../security/RISKS.md) (R-14), [CONTROLS.md](../security/CONTROLS.md) (C-remote-*), [PRIVACY.md](../security/PRIVACY.md).
