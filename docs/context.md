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
The class a tool declares — `read`, `write`, `exec`, `memory`, `publish`, `home` — which the approval policy keys on. `publish` always asks.
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
A thread created by something other than the chat box: `telegram`, `whatsapp`, `voice` or `company`. It shows a channel icon in the sidebar; routine and house-rule threads have none.
_Avoid_: external chat, remote thread

**Attachment**:
A vault file the person drags onto the composer; it is appended to the message as a numbered "Adjuntos del vault" block and treated as data, not instructions. A pasted picture is not an attachment, it goes to the inbox.
_Avoid_: upload, context file

**Inbox**:
The `<userData>/inbox/` folder that holds pictures pasted in chat, received over Telegram, or taken from cameras. `look_at_image` may read from it.
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
A system dialog that the page cannot click, shown before Alma starts new code (a new stdio MCP server) or stops asking for approval ("Permitir todo").
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
The model that looks at pictures for `look_at_image`, camera stills and plan photos; chosen in «Configuración → Casa», otherwise the first agent with a key. Pictures never enter an agent's conversation, only the text answer does.
_Avoid_: image model (that generates pictures), multimodal model

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
