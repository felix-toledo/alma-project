# Alma

A Windows desktop agent: one person, many agents, local tools and local data. This file is the glossary of terms already resolved; check it before asking the same question twice, and add a term the moment a Clarify round settles it (see the `domain-modeling` skill for the format).

## Language

**Coordinator**:
The Electron `utilityProcess` that runs the agents, tools, channels and knowledge base. Everything that thinks or does I/O for an agent lives here.
_Avoid_: backend, server, worker

**Main**:
The Electron main process: windows, tray, settings, dialogs, the Instagram browser session. It hosts the coordinator and mediates the renderer.
_Avoid_: app, shell

**Renderer**:
The React UI. It has no direct access to disk, network or the coordinator.
_Avoid_: frontend, client

**Agent profile**:
A named configuration (provider, model, instructions) the person edits. The main agent can delegate to others.
_Avoid_: bot, persona

**Subagent**:
A run an agent starts with `delegate_task`; several run in parallel and cannot delegate again.
_Avoid_: child agent, worker

**Approval mode**:
The policy deciding which tool calls ask the person first (ask, auto-review, allow all, read-only, plus per-tool "always allow").
_Avoid_: permissions, safety level

**Tool risk**:
The class a tool declares — `read`, `write`, `exec`, `memory`, `publish`, `home` — which the approval policy keys on. `publish` always asks. Besides acting outward on the user's behalf, `publish` is also the class for a model creating or changing autonomous agents (a company, spec 029).
_Avoid_: danger level, scope

**Reminder** / **Routine**:
A reminder only notifies; a routine makes an agent do a task alone in a new conversation. Both can be one-off, fixed-time or recurring.
_Avoid_: alarm, cron job, schedule

**Vault**:
A folder of plain Markdown notes, indexed in SQLite (FTS5 + vectors). Alma's own notes live under `Alma/`.
_Avoid_: notebook, database

**Company**:
A team of agents with an org chart, tasks that wake agents, meetings and budgets; the boss agent asks the person for approvals.
_Avoid_: workspace, project

**House** (Casa):
The domotics feature: a Home Assistant engine Alma manages, plus Alma's own 2D floor plan of the home.
_Avoid_: smart home, hub

## Language: chat and conversations

**Thread**:
A saved conversation, one JSON file under `<userData>/threads/`. It has a title, an agent, a working folder and, when it came from elsewhere, a channel.
_Avoid_: chat (as a noun for the stored thing), session, conversation file

**Draft**:
The assistant turn still being streamed, built live from stream events and replaced by the committed message when the turn ends.
_Avoid_: partial message, buffer

**Working folder**:
The folder a thread's file tools are confined to (`read_file`, `write_file`, `run_command`…), chosen per thread. It is unrelated to the active vault.
_Avoid_: workspace (the code says `workspace`, the UI says "carpeta"), project folder, cwd

**Channel thread**:
A thread created by something other than the chat box: `telegram`, `whatsapp`, `voice`, `company` or `remote` (the paired phone). It shows a channel icon in the sidebar; routine and house-rule threads have none.
_Avoid_: external chat, remote thread

**Attachment**:
Two kinds, both treated as data and never as instructions. (1) A vault file the person drags onto the composer: it is appended to the message as a numbered "Adjuntos del vault" block. (2) Since spec 030, a picture or a file of an allowed type (PNG, JPEG, WebP, GIF, PDF, Word, Excel, PowerPoint, text and source files; 2 MiB each, at most 5 files and 10 MiB per message) that the person pastes, drops, drops as a folder or picks with the file dialog in the desktop composer, or, since spec 031, attaches from the paired phone's chat when the **Send files** sub-switch is on (700 000 bytes each from the phone). It is stored in the **Attachment store**, listed in the message as a heading plus one reference line per file (id, name, size), and the agent reads a document with `read_attachment` and looks at a picture with `look_at_image`. Pictures lose their location and camera metadata, text read from a file has secret-looking values masked, and a file is deleted 30 days after its conversation was last opened (the message keeps a «removed» chip). Not available in company agents' conversations, Telegram, WhatsApp or voice; the paired phone shows a message's attachments by name, kind and size only, never their content.
_Avoid_: upload, context file

**Attachment store**:
Spec 030. The folder `<userData>/inbox/attachments/` with one folder per attachment (`<id>/<sanitised name>`) and one record `<id>.json` (conversation, original name, size, kind, creation and removal time). The id is a random UUID and the only way to name a file: tools and the page never receive a path to build on, and nothing can list the store. The 30-day sweep and the deletion with the conversation act only on files this index knows.
_Avoid_: library, uploads, gallery

**Inbox**:
The `<userData>/inbox/` folder that holds pictures received over Telegram or taken from cameras and, in older versions, pictures pasted in chat; its `attachments/` subfolder is the **Attachment store** (files and pictures attached in chat since spec 030). `look_at_image` may read from it. «Borrar mi historial» empties the whole folder.
_Avoid_: downloads, uploads folder

**Effort**:
The agent profile's reasoning level (`low`, `medium`, `high`, `xhigh`, `max`). Claude 4.6+/5.x receive it as `output_config.effort`, DeepSeek as `reasoning_effort`, xAI chat models ignore it.
_Avoid_: thinking level, reasoning budget

**Refusal fallback**:
The Anthropic server-side beta (`server-side-fallback-2026-07-01`) that Alma switches on for the newest Claude models. If a turn still ends in `refusal`, its tools do not run and the run ends with «El modelo rechazó la solicitud.».
_Avoid_: retry, safety fallback

**App tools**:
The tools every agent gets whatever its profile lists (routines, `web_search`, `fetch_url`, `send_telegram`, `look_at_image`, and vault, mail, WhatsApp and house tools when those exist). A profile's `tools` list only limits the built-in file and command tools.
_Avoid_: built-in tools (those are the profile-listed file and command tools), core tools

**Subagent run**:
One execution of a subagent started by `delegate_task`: its own message history, one level deep, returning only its final text, shown nested inside the parent's tool card.
_Avoid_: child run, task run

## Language: knowledge and vault

**Memory**:
One short, stable fact about the person: a bullet line in `Alma/Recuerdos.md`, always injected into the system prompt. Written with `remember`, removed with `forget`; capped at 4000 characters in total when added by a tool.
_Avoid_: note, fact, preference

**Knowledge note**:
A durable note Alma writes with `save_knowledge` under `Alma/Conocimientos/`, marked `origen: ia` in its frontmatter. Only notes with that mark can be updated by the tool.
_Avoid_: AI note, document

**Recall**:
The automatic retrieval done for every agent run: all memories plus the few vault fragments most related to the person's last message, injected into the system prompt as data.
_Avoid_: RAG, context lookup, autosearch

**Fragment**:
A chunk of a note returned by search (path, heading path, start line, snippet, similarity). Chunks are at most 1600 characters and split by heading.
_Avoid_: chunk (used inside the index code), snippet, passage

**Embedder**:
The component that turns text into a vector: bge-m3 int8 on CPU inside a worker thread, downloaded on first use. Its state is `idle`, `loading`, `downloading`, `ready` or `error`.
_Avoid_: model, vectorizer

**Embed**:
To compute the vector of a chunk. Chunks wait as `pending` until embedded, 8 at a time; search uses keywords only meanwhile.
_Avoid_: index (the verb for scanning files), vectorize

**Hybrid search**:
Keyword ranking (FTS5 BM25) and vector nearest-neighbour ranking fused with Reciprocal Rank Fusion, at most 2 fragments per file.
_Avoid_: semantic search (it is both), RAG

**Live preview**:
The editor mode that renders Markdown on every line the cursor does not touch (CodeMirror 6).
_Avoid_: WYSIWYG, preview pane

**Reading mode**:
The vault view that shows a note fully rendered and read-only; Ctrl+E toggles it with editing.
_Avoid_: view mode, preview

**Quick switcher**:
The "Abrir nota" dialog opened with Ctrl+O to find a note by name.
_Avoid_: file picker, command palette

**«Lo que sabe Alma»** ("what Alma knows"):
The panel of the vault view where the person sees, edits and deletes every memory and every knowledge note Alma wrote, plus the index status.
_Avoid_: memory manager, knowledge panel

## Language: channels and connectors

**Bound chat**:
The single Telegram private chat the bot answers: the first allowed user who writes gets bound by chat id; afterwards only that id is accepted.
_Avoid_: linked chat, owner chat

**Self chat**:
The person's own WhatsApp chat («Mensajes para mí», "Messages to me"), the only chat Alma answers. Alma's messages in it start with a robot mark.
_Avoid_: saved messages, own chat

**Linked device**:
How Alma appears to WhatsApp: one more device of the person's own number, paired by QR through the unofficial Baileys library.
_Avoid_: bot account, WhatsApp bot

**Test mode** (Instagram):
A setting, on by default, in which `instagram_publish` fills in the whole post but never presses "Compartir"; it still returns success.
_Avoid_: dry run, draft post

**MCP connector**:
A configured Model Context Protocol server, local (stdio) or remote (HTTPS), that can be switched on or off per server.
_Avoid_: plugin, integration, extension

**Qualified tool name**:
The name an agent sees for an MCP tool: `mcp__<server>__<tool>`, characters outside `a-zA-Z0-9_-` replaced by `_`, cut at 64.
_Avoid_: tool id, full name

**Tool allow-list**:
The optional per-server list of MCP tools that agents may see; tools outside it are not offered and cannot be called.
_Avoid_: tool filter, whitelist

**Routine run**:
One execution of a routine: an agent starts a new thread titled "Rutina · name · date" and works alone. A tool that needs approval still waits for the person.
_Avoid_: job run, cron execution

## Language: voice

**Voice conversation**:
The thread with channel `voice` that the assistant uses; a thread idle for more than 1 hour is replaced by a new one. Answers are short and spoken.
_Avoid_: call, voice session

**Wake word**:
The phrase that starts a voice turn while the assistant is listening: "Ey Alma", the same in both languages, always (spec 025). The shipped model (`resources/wakewords/hola_alma_v0.1.onnx`, id `hola_alma`) already recognizes it; "Hola Alma" was a wrong name, so only the displayed phrase changes.
_Avoid_: hotword, trigger phrase

**Voice print**:
The owner's voice vector, trained from three phrases and stored locally in `voice-profile.json`. It is biometric data and is checked only on wake-word starts.
_Avoid_: voiceprint file, speaker profile

**Barge-in**:
The person talking over Alma to interrupt her; detected by 5 consecutive chunks louder than the learned echo level.
_Avoid_: interruption, talk-over

**Filler**:
A short spoken phrase ("Mmm…", "Dame un segundo, que busco.") played at once while the agent is still thinking or searching.
_Avoid_: placeholder phrase, stall

## Language: approvals and security

**Auto-review**:
The approval mode in which a reviewer model judges each action using the person's review instructions and answers `allow` or `flag`; a flag or a reviewer error asks the person.
_Avoid_: AI approval, auto-approve

**Always allow** vs **agent auto-approve**:
"Siempre permitir" is a global per-tool rule saved when the person picks it on an approval card (`alwaysAllowTools`). Auto-approve is a per-agent list (`autoApproveTools`) of tools that one agent runs without asking. Neither ever applies to `publish`.
_Avoid_: allowlist, whitelist, trust

**Boss review**:
In a company, the first check of any `publish` call: the agent's direct boss judges it with its own instructions; only if the boss approves is the person asked.
_Avoid_: manager approval, peer review

**Audit trail**:
The tamper-evident log of what agents did and who allowed it: `<userData>/audit/*.jsonl`, each line chained to the previous by SHA-256. It stores identifiers, not message content.
_Avoid_: log, history

**Native confirmation**:
A system dialog that the page cannot click, shown before Alma starts new code (a new stdio MCP server), stops asking for approval ("Permitir todo") or turns on remote access (spec 026).
_Avoid_: confirm prompt, modal

**Private host**:
A local, loopback or LAN address that `fetch_url` refuses to reach.
_Avoid_: internal URL, localhost (the rule is wider than localhost)

**Secret slot**:
One of the named places where an encrypted secret lives in settings (`anthropic`, `xai`, `deepseek`, `vercel`, `meta`, `openai`, `telegram`, `elevenlabs`, `email`), plus one mailbox password per company.
_Avoid_: key store, credential

**Public settings**:
Settings as the renderer sees them: the same shape as the stored settings, but API keys are replaced by "is one stored".
_Avoid_: client settings, safe settings

**Host request**:
A request the coordinator sends to main for something only main can do (publish to Instagram, render an SVG to PNG, trash a vault file, seal or open a secret).
_Avoid_: IPC call, RPC

## Language: companies

**Board** (Directorio):
The person, at the top of every org chart. Its actor id is `user`; the system's is `system`.
_Avoid_: owner, admin, CEO

**Member**:
A position in a company's org chart, bound to one agent. It reports to another member or to the board.
_Avoid_: employee, staff, seat

**Dotted line**:
A `collaborates` link between two members who may ask each other questions without reporting to one another; it is symmetric.
_Avoid_: peer link, relation

**Head**:
The first member with no boss (or the first member if none); by default it chairs meetings and answers the company's WhatsApp.
_Avoid_: CEO, leader

**Delivery**:
A task a member sends to review with `update_task(review)`. It is reviewed by the task's creator (the board's by the person, a member's by that member's agent).
_Avoid_: submission, handoff

**Revision cap**:
A task may come back from review at most 2 times; the third send-back blocks it and notifies the person.
_Avoid_: retry limit

**Chair**:
The member who runs a meeting: opens it, announces each agenda item, closes it, writes the minutes and creates the tasks.
_Avoid_: host, moderator

**Minutes**:
The Markdown record of a meeting at `Reuniones/<date> <topic>.md` in the company vault: summary, decisions, tasks, preparations, transcription.
_Avoid_: notes, transcript (that is only a section)

**Monthly budget**:
A USD cap per company and optionally per member, estimated from token usage at list prices; warns at 80% and pauses agents at 100%. A new month starts at zero.
_Avoid_: quota, spending limit

## Language: house

**Engine**:
The Home Assistant instance Casa depends on. **Managed**: installed and run by Alma in the hidden WSL2 distro `alma-home`. **External**: one the person already has, reached by URL and token.
_Avoid_: server, hub (the hub is Alma's client of the engine), backend

**Adopted engine**:
A managed engine already running on the default port that Alma takes over, using its stored credentials, instead of starting a second process.
_Avoid_: attached engine, reused instance

**Thing**:
Alma's unit for something in the house: a Home Assistant device and its controllable entities (a light, a camera), with kind, state and sensitivity. Sensors belong to their thing.
_Avoid_: device (the UI says "dispositivo"), entity (the HA record underneath)

**Sensitive device**:
A lock, alarm (including siren) or a garage, gate or door cover. It is controlled only through `home_secure_control`, which asks on every call.
_Avoid_: critical device, secure device

**Config flow**:
Home Assistant's step-by-step form for adding a brand (account, IP, QR, link, progress), which Alma draws as its own "Agregar dispositivo" dialog.
_Avoid_: wizard, setup form

**Brand**:
An integration offered when adding a device (Tuya, Sonoff/eWeLink, ONVIF, Hue, Chromecast…). Not to be confused with the person's own brand pieces in `biblioteca/`.
_Avoid_: vendor, manufacturer

**Plan**:
Alma's own 2D, top-down floor plan of the home (`plan.json`, centimetres): floors, rooms, doors and device positions. Rooms map to Home Assistant areas. It is built from an Excalidraw drawing, a photo, or by hand.
_Avoid_: map, layout

**Mode** (house):
A Home Assistant scene created and activated with `home_modes` / `home_scene` ("Noche", "Me fui", "Cine"). Unrelated to the approval mode.
_Avoid_: scene (in the UI), profile, preset

**Judgment rule**:
A house rule that needs criteria: when one entity's state matches, the cooldown has passed and the time window allows, it wakes an agent in a new thread with the event. Simple rules instead become Home Assistant automations and cost no AI.
_Avoid_: smart rule, AI rule, trigger

**Camera watch**:
A time-limited vision polling of a camera (every 10 s or more, for 1 to 360 minutes) that notifies when what the person asked to see appears.
_Avoid_: surveillance, monitor, recording

**Still**:
One camera picture saved to the inbox (`camera_look`, `camera_photo`); a still is tried up to 6 times if the camera is slow.
_Avoid_: snapshot (the code uses that word for the live state of the house too), screenshot, frame

**Vision model**:
The model that looks at pictures for `look_at_image`, camera stills and plan photos; chosen in «Configuración → Imágenes» (the group that sees; before spec 038 it was in «Configuración → Casa»), as a provider and a model or as a provider only. With a provider only, Alma uses the newest model of that provider that can see, but only after the person confirmed that provider by name; otherwise, and when nothing is chosen («Automático»), the model of the house agent, else the default agent, else the first agent with a key. Pictures never enter an agent's conversation, only the text answer does.
_Avoid_: image model (that generates pictures), multimodal model

## Language: remote access

Spec [026](../.specify/specs/026-remote-access/spec.md). Terms below are the ones the human decided; whatever is still open is listed in that spec's Open Questions, not here.

**Remote channel**:
The single shared security layer, in `coordinator/channels`, through which a paired phone reaches Alma: device identity, scopes, step-up and the audit trail. It is identical whichever transport carries the bytes, and it exposes a narrow API built for the phone, not the desktop UI.
_Avoid_: remote control, remote API (that is only the set of operations the phone may call)

**Transport**:
The swappable piece of the remote channel that only moves bytes between the phone and the PC (Tailscale through `tailscale serve`; a local one that exists only in tests; an Alma-run **relay**, spec [027](../.specify/specs/027-alma-e2e-relay/spec.md), draft). It carries no authority: being reachable over a transport never grants access.
_Avoid_: connection, tunnel, network, provider (providers are model providers)

**Device** (remote):
A paired phone, with its own key, name and scopes, that the person can revoke alone without touching the others. Not a **Thing** (a house device), and not a WhatsApp **Linked device**; the audit trail records it as `detail.deviceId`.
_Avoid_: phone (in code and specs), client, session

**Pairing**:
The one-time ritual that turns a phone into a device: a one-use QR that expires in 3 minutes, then a 6-digit code the person compares on both screens and approves on the PC (a native confirmation). Scanning the QR alone grants nothing; at most 5 devices can be paired.
_Avoid_: login, linking (WhatsApp's QR is a linked device), enrolment

**Scope** (remote):
One capability a device may use: chat, approve, home automation, cameras (still pictures of the cameras the person allowed one by one, seen in transit and never saved on the PC; each camera added needs a native confirmation and the list persists across turn-ons), and, since spec [028](../.specify/specs/028-remote-vault-and-threads/spec.md), **Notes** and **History**: six in all. Scopes are global (not per device), all off every time remote access is turned on, and each is enabled separately on the PC. Locks and alarms are a sub-switch under home automation, and **Continue conversations** a sub-switch under History; each is off by default and needs its own native confirmation (locks and alarms also need a step-up to open or disarm). Unrelated to **Tool risk**, which classifies tools, not capabilities.
_Avoid_: permission, role, access level

**Step-up**:
A WebAuthn passkey assertion, made on the phone and verified by the PC, required on every action that opens or disarms a sensitive device (locks, alarms, sirens, gate, garage and door covers), with no time window and no fallback; the passkey is registered during pairing. Closing, locking and arming need none, nor do a siren's trigger or silence or a cover's stop or set-position. It is added to the approval card, not a replacement.
_Avoid_: 2FA, PIN, re-login

**Send files** (remote, spec [031](../.specify/specs/031-remote-chat-attachments/spec.md), built; not yet run on a real phone):
A sub-switch under the Chat scope that lets a paired phone put photos and files (up to 700 000 bytes each, at most 5 per message) on the PC and send them with a message, in the Chat tab and in conversations it may continue. Off at every turn-on, confirmed natively, never changed by the coordinator. The PC re-checks every file with the same rules as the desktop (spec 030); the phone never acknowledges the provider notice and cannot override the secret-name refusal.
_Avoid_: upload permission, attach scope

**Pending upload** (remote, spec [031](../.specify/specs/031-remote-chat-attachments/spec.md), built; not yet run on a real phone):
A file a phone put in the attachment store that no message has yet bound. It belongs to that device and conversation, at most 5 per device, and is deleted at once when removed, when the device is cut off or the switch is turned off, or after 15 minutes. Once a send binds it, it is an ordinary attachment (30-day rule of spec 030).
_Avoid_: draft attachment, temp file

**Dormant device**:
A paired device while remote access is off: it stays in the list, cannot connect, and returns when remote access is turned on again (the native confirmation names it). Its 15-day idle clock keeps running, so a long-dormant device is removed automatically. Not the same as a revoked device, which is deleted at once.
_Avoid_: disabled device, inactive device

**Notes scope** (remote):
Spec [028](../.specify/specs/028-remote-vault-and-threads/spec.md), status `ready` (built, close-out pending). A scope that lets a paired phone browse, read and filter by name the notes of the active vault, read-only, minus the folders on the **Exclusion list**; no content or semantic search. Only the active vault is served, `Alma/` has no special rule, and nothing is stored on the phone. Notes (`.md`) are rendered and images shown up to 2 MB; any other file type is listed but not served; a note over 1 MB is refused; a path with a different casing is served under the vault's real casing. The remote chat agent's own `read_note` and `search_knowledge` are a separate path that this scope does not gate. Its own switch, global, off every time remote access is turned on, with its own native confirmation naming the vault folder. Not the same as History.
_Avoid_: vault access, vault permission

**History scope** (remote):
Spec [028](../.specify/specs/028-remote-vault-and-threads/spec.md), status `ready` (built, close-out pending). A scope that lets a paired phone list and read the conversations the PC's Chat tab lists (company-agent threads never), as text of user and assistant messages only. Its own switch, global, off every time remote access is turned on, with its own native confirmation. Continuing conversations is a further sub-switch under History (**Continue conversations**), also off at every turn-on and with its own native confirmation, so History can be read-only; turning History off turns the sub-switch off too. A message the phone sends into a conversation is written by id and never re-points the shared remote thread; the approvals of a run the phone started are shown to it only when the approve scope is on, and the app's normal approval policy applies (`publish` always asks).
_Avoid_: chat history, thread access

**Continue conversations** (remote):
The sub-switch under the History scope that lets a paired phone send a message into a listed conversation by its id (up to 8000 characters) and stop the run it started. The conversation keeps its own agent, model and working folder, and the PC runs it through the same entry as a message typed on the PC; a conversation that is already running answers busy and nothing is queued. Nothing goes out to the conversation's own channel (Telegram, WhatsApp, voice). The Chat tab's shared remote thread is governed by the chat scope, not by this sub-switch.
_Avoid_: reply from the phone, remote edit

**Run tie** (remote):
The in-memory link between a device and the run it started (in the shared remote thread or in a conversation by id). It gives one phone-started run per device, shows a device the approvals of its own run only, and lets Alma abort that device's runs when access is cut (kill switch, remote off, revoke, History or the sub-switch off). It is never written to disk: a restart ends every run anyway.
_Avoid_: session, lock, owner

**Exclusion list** (remote):
The folders of the vault that the person chose on the PC to hide from the phone. Excluding a folder needs no confirmation (it narrows access) and removing an exclusion asks a native confirmation (it widens access); there is no allow-list. Matched by vault-relative path, case-insensitive, covering every folder under it. Kept across turn-ons of remote access. A folder renamed or moved in Alma's own vault view takes its exclusion along; one renamed outside Alma shows as stale in the «Acceso remoto» tab and its new location is not excluded until the person excludes it.
_Avoid_: blocklist, hidden folders (those are dot-folders the vault already hides from everyone)

**Relay** (remote):
Spec [027](../.specify/specs/027-alma-e2e-relay/spec.md), status `ready` (built, not deployed). A server run by Alma that is a third **Transport** for the remote channel, chosen instead of Tailscale (one at a time, never both, no fallback): the PC connects outward to it over a WebSocket, the phone reaches it over HTTPS, and it forwards sealed frames between them. It has no accounts, holds no key that opens a frame, keeps nothing, buffers nothing, and is opt-in and off by default with its own native confirmation. It sees only metadata (that two endpoints talk, when, how much, and the sizes and timing of frames). It is operated by the project maintainer personally, on voluntary donations. Not the same as Tailscale's relays (DERP), which belong to Tailscale.
_Avoid_: cloud, proxy, tunnel, server (too generic: the PC also serves the PWA over Tailscale)

**End-to-end session** (remote):
Spec [027](../.specify/specs/027-alma-e2e-relay/spec.md), status `ready`. The sealed channel between one phone and the PC, with session keys only those two hold, that carries every request and answer over the **Relay**. It is part of the relay transport, not of the remote channel, and is separate from the bearer session of the channel (1 hour, renewed by signing); the Tailscale path does not use it. Built from ephemeral keys on both sides (so past traffic stays sealed if long-term keys leak), with the transcript signed by the PC's identity key and, after pairing, the phone's device key; at pairing the phone checks the PC's signed transcript against the fingerprint in the QR, and the 6-digit code stays the 026 one. Counters reject replay and reordering; keys are renewed at every reconnect and hourly; a tampered frame ends the session. WebCrypto only.
_Avoid_: tunnel, VPN, TLS (TLS is hop-by-hop; this one survives the relay)

**Routing id** (remote):
Spec [027](../.specify/specs/027-alma-e2e-relay/spec.md), status `ready` (built, not deployed). 128 random bits that name one PC at the **Relay** and form the host of its per-PC address, `<routing id>.<relay domain>`; the PC registers it by signing a challenge with its identity key. It is an address, not an identity of a person, and knowing it grants nothing: every request still needs a device credential. The device key and the passkey are bound to the origin it forms. The relay keeps no binding for it across a restart (provisional answer, to be confirmed): the first valid claimant wins until the real PC registers again, a known residual denial of service.
_Avoid_: account, room, user id

**Shell pin** (remote):
Spec [027](../.specify/specs/027-alma-e2e-relay/spec.md), status `ready` (built, not deployed). The gate by which the phone app refuses a PWA shell version the PC did not announce: the PC sends the official shell hash of its own build inside the end-to-end session, signed by its identity key. The hash of each release is published and shown in the app's Settings screen so it can be compared. It is best-effort: it catches a wrong, stale or partly tampered deployment, but the web platform lets the origin replace the service worker itself, so it does not stop an operator who deliberately serves a hostile app (at the first install, at a service-worker update or at a fresh load).
_Avoid_: pin (it is not a wall), update check, code signing (the signer is the person's own PC, not Alma)

## Language: dream and presence

Specs [033](../.specify/specs/033-nightly-dream-and-morning-greeting/spec.md) and [034](../.specify/specs/034-presence-signals/spec.md), both `ready` and built (the owner sets `implemented`; 033's economy-model table awaits confirmed prices, so no dream runs yet). Terms below are the ones the owner decided on 2026-11-08 and 2026-11-09; neither spec has an open question.

**Dream** («Sueño»):
An opt-in nightly pass, off by default. Between 02:00 and 06:00 local, or at the first start or resume after a missed window, Alma rereads the user and assistant text of the conversations it has not dreamt yet (never company-agent threads; anything not typed by the person and not written by Alma goes in as data, never as instructions) with the cheapest economy model among the providers with a key, and without asking adds, replaces and removes lines of `Alma/Recuerdos.md` (keeping it at or under 4000 characters: replacements and removals first, then additions in order while they fit, the rest skipped and listed). It never reads a message more than 7 days old. It is a fixed pipeline with no tools, governed as risk `memory`, never runs in the read-only mode, is capped per night (USD 0.25 by default, 0.01 to 5), and is all or nothing: an interrupted dream applies nothing and is retried once the same day (at a start, a resume or a check inside the night window, whichever comes first); one aborted by turning the switch off is not retried. A night with nothing new from the person is skipped and counts as dreamt. Several missed nights make one dream.
_Avoid_: consolidation, reflection, batch job, sleep mode

**Dream journal**:
The note a dream writes in the active vault, `Alma/Sueños/YYYY-MM-DD.md` (`Alma/Dreams/` in English; an existing folder name wins), dated the day the dream ran: every memory added, replaced or removed (old lines verbatim) and every change skipped, each citing its sources as thread id plus message `ts`, a speculative section of hunches that never enters `Recuerdos.md`, and a footer with provider, model and estimated cost; frontmatter `origen: ia` and `tipo: sueño` (`origin: ai`, `type: dream` in English). A completed dream writes one even when it changed nothing, and a file already at that path gets one more section appended. Alma never deletes it, deleting its sources leaves it, automatic recall never injects it (search and `read_note` still reach it), and «Exportar mis datos» copies it.
_Avoid_: dream log, diary, report

**Morning greeting**:
A few lines the dream writes at night and Alma delivers as is, with no model call, once a day, at the first wake signal: to the Telegram bound chat, as a desktop notification, and as a content-free push with a fixed text to a paired phone while the History scope is on. It lives in its own new conversation, answered by the main agent; the first opening of Alma after delivery lands there (on the phone, only with the History scope on). A channel that fails is not retried. When the first message of the day came over Telegram, the greeting follows the answer in the Telegram thread. No dream result, no greeting; a dream stopped at the cap has one only if it was written before the cap stopped it, and then it says so; one not delivered by the next night window is dropped. It has no switch of its own.
_Avoid_: morning brief, digest, daily summary

**Wake signal**:
The once-a-day decision that the person's day has started, the day running from 02:00 to 02:00 local. Spec 034 gives it when the screen is unlocked, the PC resumes, the person touches a PC left unlocked, or Alma starts (however it was started), each after an absence of 4 hours or more (a constant); a start with no known last activity, or an unlock whose lock was never seen, gives none. For the morning greeting, the person's first message of the day also counts. A signal is given only when a consumer can use it at that moment (for the greeting: written, or a catch-up dream running); one no consumer can use does not use up the day. Consumers get only "the person is back now". Only the date of the last signal and the last known activity time are stored, only while a consumer is on, never exported and cleared by «Borrar mi historial»; nothing about it leaves the PC.
_Avoid_: presence, activity, heartbeat, wake-up

## Language: images and interface

**Composition**:
An original image drawn by `compose_image` from Alma's own pieces (templates, palettes, fonts, backgrounds, shapes) with no image model, saved as an editable SVG and a PNG.
_Avoid_: generated image (that is `generate_image`), design

**Biblioteca**:
The `biblioteca/` folder inside the working folder where the person puts their own logo, SVG pieces, fonts, `paletas.json` palettes and `recetas.json` recipes. Their pieces win over built-ins of the same name.
_Avoid_: asset folder, brand kit

**Receta** (recipe):
A saved combination in `recetas.json` (template, palette, fonts, background, pieces) that an agent applies with `recipe: "name"`, filling in only the texts.
_Avoid_: preset, template (a template is one of the 12 built-in layouts)

**App language**:
The `language` setting (`es` or `en`) chosen in «Configuración», defaulting to the system language. One value drives the renderer's text, the messages main and the coordinator show the person, dates, numbers and sorting, and the voice (speech-to-text and text-to-speech). A change takes effect live, with no restart. Only `es` and `en` exist (a regional code maps to its base language; any other system language starts in `en`); Spanish stays rioplatense and English is US English; formats are `es-AR` and `en-US`, 24-hour. Agents do not get the app language injected: they follow a general rule to answer in the language the person speaks in, and fall back to the app language only when there is no incoming message. Names Alma writes to disk follow the language for new files, and an existing name under either language always wins.
_Avoid_: locale, UI language (it covers more than the UI), interface language

**Model-facing text**:
Text written for the model, not the person. The app language never rewrites the tool descriptions or the prompts the person saved. The prompts Alma itself writes for the model, the tool descriptions, and the text of `ToolError` and tool results, are in English whatever the app language is; the person sees them translated on cards.
_Avoid_: internal text, hidden text

**Tray mode**:
The `background.runInTray` setting: closing the window hides it and Alma keeps running in the system tray (needed for reminders, Telegram, voice and house rules).
_Avoid_: background mode, minimize to tray

**Ambience**:
The console-style atmosphere: the slow animated backdrop, synthesized interface sounds and ambient music, each with an off switch.
_Avoid_: theme, skin

**Focus halo**:
The glow and 1.06 scale drawn around the focused or hovered control, the base of keyboard and gamepad navigation.
_Avoid_: focus ring, outline

**Reminder toast**:
The in-app notice of a due reminder that stays until the person closes it, shown in addition to the Windows notification because Windows can drop toasts.
_Avoid_: popup, banner
