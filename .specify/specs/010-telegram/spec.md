---
status: implemented
---

# 010 — Telegram

## 1. Summary
Alma can be reached from the person's phone through a Telegram bot that runs inside the app (long polling, no server and no open
port). The person creates a bot with @BotFather, pastes its token in Configuración → Telegram and lists their own username; the
first listed user who writes to the bot privately is bound to it by chat id. From then on that single chat talks to an agent
(text, voice notes, photos), gets "Permitir / Rechazar" buttons when an agent needs approval, and receives reminders, house
notices and anything an agent sends with `send_telegram`.

## 2. Problem and goal
The person is not always at the computer. They want to ask Alma things, hear back about long tasks, approve risky actions and
get reminders on the phone, without exposing the machine to strangers who find the bot. Done means: only the owner's private chat
can use the bot, every conversation appears in the sidebar like any other, and the channel state and its errors are visible in
settings.

## 3. Scope
**In:**
- Bot lifecycle (start / restart / stop from settings), connection state and error messages.
- Authorization: allowed users, first-contact binding to a chat id, private chats only, unbinding.
- Commands `/start` and `/nuevo`; handling of text, voice notes / audio files and photos; answer delivery (placeholder, status
  edits, splitting long answers).
- Approvals asked with inline buttons.
- Outbound: `notify` (reminders, house notices, company notices), `notifyPhoto`, tool `send_telegram` (text and image).
- Telegram section of the settings dialog; the Telegram thread in the sidebar.

**Out (and why):**
- How approval modes decide whether to ask: `../004-approvals/spec.md`. Here only the Telegram surface of an approval.
- Creating and scheduling reminders and routines: `../018-routines-and-reminders/spec.md` (here only that they are delivered).
- Speech-to-text engines and voice settings: `../019-voice/spec.md` (here only that a voice note is handed to `transcribe`).
- What `look_at_image` does with a picture and the camera tools: `../020-images/spec.md`, `../014-house-plan-cameras-and-rules/spec.md`.
- Agent runs, threads and the sidebar in general: `../002-chat/spec.md`, `../003-agents/spec.md`.
- Secret storage and audit trail as a whole: `../022-security-and-privacy/spec.md`.
- The other chat channel: `../011-whatsapp/spec.md`.

## 4. Users and stories
- **US-1** As the owner, I want only my own private chat to be able to use the bot, so that a stranger who finds the bot cannot drive my agents.
- **US-2** As the owner, I want to connect a bot from settings and see whether it is online or why not, so that I can fix a wrong token or a duplicate bot.
- **US-3** As the owner, I want to write or speak to Alma from my phone and get the agent's answer, so that I can use it away from the computer.
- **US-4** As the owner, I want to send Alma a photo, so that an agent can look at it.
- **US-5** As the owner, I want to approve or reject an agent's action with a button, so that a task does not stall while I am away from the desktop.
- **US-6** As the owner, I want reminders, house alerts and agent messages delivered to my phone, so that I see them in time.
- **US-7** As an agent, I want `send_telegram` to message the user (text or image), so that I can report the result of a long task.
- **US-8** As the owner, I want my Telegram conversation to appear in the sidebar and to start a new one with `/nuevo`, so that I can review it on the desktop and keep topics apart.

## 5. Acceptance criteria

### Authorization (US-1)
- **AC-1.1** (US-1) Given no chat is bound and `allowedUsers` lists `@Felix`, when a private chat from `felix` (any case, with or without `@` in the list) writes, then the verdict is "bind"; a different username or a user without username is "denied". Test: tests/telegram.test.ts › "binds the first allowed user in a private chat, case-insensitively and ignoring @"
- **AC-1.2** (US-1) Given any configuration, when the message comes from a group, supergroup or channel, then it is denied even if the sender is an allowed user or the chat id equals the bound one. Test: tests/telegram.test.ts › "never accepts groups, even from an allowed user"
- **AC-1.3** (US-1) Given a bound chat id, when a private chat writes, then only the chat with that id is accepted, whatever its username; a different chat is denied even if its username is in the list. Test: tests/telegram.test.ts › "once bound, only that chat works, whatever the username"
- **AC-1.4** (US-1) Given a "bind" verdict, when the first message is handled, then the chat id is saved into `settings.telegram.chatId` (persisted by main) and an audit entry `channel.bind` (actor `remote`) is written. [gap]
- **AC-1.5** (US-1) Given repeated audit events of the same action and target flagged `throttle`, when they are written within a minute, then only one line is kept. Test: tests/audit.test.ts › "never writes secrets and can throttle spammable events"
- **AC-1.5b** (US-1) Given a denied verdict, when any handler runs, then an audit entry `channel.denied` (actor `remote`) is written with only the chat type, no names and no text. [gap]
- **AC-1.6** (US-1) Given a denied private chat, when it writes `/start`, text, a voice note or a photo, then the bot replies "No estás autorizado para usar este bot. Para habilitarte, agregá @usuario en Alma → Configuración → Telegram." (or "tu cuenta (no tiene nombre de usuario)"), and no agent runs and nothing is downloaded. [gap]
- **AC-1.7** (US-1) Given a denied message from a group, when it arrives, then the bot stays silent (no reply). [gap]
- **AC-1.8** (US-1) Given a message type with no handler (sticker, document, video, location, edited message), when it arrives, then nothing happens and nothing is answered. [gap]
- **AC-1.9** (US-1) [manual] In Configuración → Telegram → "Quién puede escribirle", with a chat bound, the card says "Vinculado a tu chat privado…"; pressing "Desvincular" clears the chat id so the next allowed user who writes becomes the bound one. Check by pressing it and writing from the phone.

### Connection and settings (US-2)
- **AC-2.1** (US-2) Given Telegram is enabled and a token exists, when settings are applied, then the status goes `connecting` and, after the bot is initialized and polling starts, `online` with the bot's `@username`. [gap]
- **AC-2.2** (US-2) Given Telegram is disabled or the token is empty, when settings are applied, then a running bot is stopped and the status is `off`. [gap]
- **AC-2.3** (US-2) Given the token or the enabled flag did not change, when settings are applied again, then the running bot is left alone (no restart). [gap]
- **AC-2.4** (US-2) Given the token changes while a bot runs, when settings are applied, then the old bot is stopped (approval buttons forgotten) and a new one starts with the new token. [gap]
- **AC-2.5** (US-2) Given Telegram rejects the token (message contains 401 or "unauthorized"), when the bot is initialized, then the status is `error` with "el token no es válido (revisalo en @BotFather)."; given a 409 or "conflict" the error is "otro programa está usando este bot (¿quedó ALMA corriendo?)."; any other error shows its own message. [gap]
- **AC-2.6** (US-2) Given polling fails after it started, when the error reaches the channel, then the status becomes `error` with the described message. [gap]
- **AC-2.7** (US-2) Given an error is thrown inside a message handler, when it happens, then it is logged and polling keeps going (the bot does not go silent). [gap]
- **AC-2.8** (US-2) Given the bot starts, when polling begins, then updates that arrived while Alma was closed are dropped (`drop_pending_updates`). [gap]
- **AC-2.9** (US-2) [manual] The Telegram tab shows the badge "Apagado / Conectando… / Conectado como @bot / Error", the error text under it in red, a password field (placeholder "Token guardado (pegá otro para reemplazarlo)" when one exists), "Guardar token", "Borrar" (only when the token is stored in settings, not when it comes from the environment), the "Bot activo" checkbox and, once online, a `t.me/<bot>` link with "mandale /start". Check by opening the tab with and without a token.
- **AC-2.10** (US-2) Given the token is not in settings, when `TELEGRAM_BOT_TOKEN` is set in the environment of Alma, then that value is used; a token saved in settings takes precedence. [gap]
- **AC-2.11** (US-2) Given a fresh install, when settings load, then Telegram is `enabled: true`, `allowedUsers` is empty, `agentId` is `general`, `chatId` and `threadId` are `null`; settings saved by older versions are merged over these defaults. [gap]
- **AC-2.12** (US-2) [manual] In "Quién puede escribirle" the person adds a username (with or without `@`, Enter or "Agregar"; duplicates ignored case-insensitively) and removes one with the X on its badge. Check in the tab.

### Conversation (US-3, US-8)
- **AC-3.1** (US-3) Given an authorized chat, when it sends `/start`, then the bot replies "Hola, soy Alma. Escribime o mandame un audio. /nuevo empieza una conversación nueva." and runs no agent. [gap]
- **AC-3.2** (US-3) Given an authorized chat, when it sends text, then the bot replies "Pensando…", runs the agent on the Telegram conversation, and replaces the placeholder with the agent's last answer; if the answer is empty it says "Listo.". [gap]
- **AC-3.3** (US-3) Given a run is in progress, when the agent uses tools, then the placeholder is edited to "Pensando… (nombre de la herramienta)" (prefix `mcp__` removed, underscores as spaces), only when the text changed and at most once every 1.5 s. [gap]
- **AC-3.4** (US-3) Given an answer longer than 4096 characters, when it is delivered, then it is split at paragraph, line or sentence breaks into pieces of at most 4096 characters; the first replaces the placeholder and the rest are new messages; short text stays whole. Test: tests/telegram.test.ts › "keeps short text whole and splits long text at line breaks under the limit"
- **AC-3.5** (US-3) Given the run fails or is rejected (for example a run is already in progress in that conversation), when the error is raised, then the reply is "No pude completar el pedido: <message>". [gap]
- **AC-3.6** (US-3) Given the placeholder cannot be edited, when the answer is ready, then the first piece is sent as a new message instead. [gap]
- **AC-3.7** (US-3) Given a message beginning with a slash command other than `/start` and `/nuevo`, when it arrives, then it is treated as ordinary text for the agent. [gap]
- **AC-3.8** (US-8) Given no Telegram thread exists (or `threadId` points to a deleted one), when the first authorized message arrives, then a thread with channel `telegram` is created, assigned to the configured agent (or the default agent if that one no longer exists), and its id saved in `settings.telegram.threadId`. [gap]
- **AC-3.9** (US-8) Given a Telegram thread exists whose agent differs from the one chosen in settings, when a message arrives, then the thread's agent is switched to the chosen one. [gap]
- **AC-3.10** (US-8) Given an authorized chat, when it sends `/nuevo`, then a new Telegram thread replaces the old one as the target (the old thread stays in the sidebar) and the bot replies "Listo, conversación nueva.". [gap]
- **AC-3.11** (US-8) [manual] A Telegram thread shows a Send (paper plane) icon with tooltip "Conversación de Telegram" in the sidebar; its messages (including the user's, and tool cards) are visible on the desktop. Check by writing from the phone.
- **AC-3.12** (US-3) Given a Telegram thread, when an agent runs in it, then its system prompt tells it the conversation is by Telegram from a phone: answer briefly, no tables or long code blocks, audios arrive transcribed. [gap]

### Voice notes (US-3)
- **AC-4.1** (US-3) Given voice is set up, when an authorized chat sends a voice note or audio file, then the file is downloaded from Telegram, transcribed, echoed back as "🎙️ «texto»" and then handled exactly like typed text. [gap]
- **AC-4.2** (US-3) Given the transcription is empty, when the note is processed, then the bot replies "No entendí el audio." and no agent runs. [gap]
- **AC-4.3** (US-3) Given no `transcribe` capability is available, when a voice note arrives, then the bot replies "Todavía no puedo escuchar audios: activá la voz en Alma → Configuración → Voz.". [gap]
- **AC-4.4** (US-3) Given the download or the transcription throws, when processing, then the bot replies "No pude transcribir el audio: <message>". [gap]

### Photos (US-4)
- **AC-5.1** (US-4) Given an authorized chat sends a photo, when it arrives, then the largest size is downloaded, saved in the inbox folder (`<data>/inbox`) as a `telegram-<id>.jpg`-style file, and the agent receives "[El usuario te mandó una imagen: <ruta>. Mirala con look_at_image.]" followed by the caption on a new line when there is one. [gap]
- **AC-5.2** (US-4) Given the photo cannot be downloaded or saved, when it is processed, then the bot replies "No pude bajar la foto: <message>". [gap]
- **AC-5.3** (US-4) Given no image-saving capability is available, when a photo arrives, then the bot replies "Todavía no puedo mirar fotos.". [gap]
- **AC-5.4** (US-4) Given a photo was saved in the inbox, when the agent calls `look_at_image` with the path it was given, then the picture is read (the inbox is one of the readable roots). [gap]

### Approvals (US-5)
- **AC-6.1** (US-5) Given the bot is online with a bound chat, when an approval is requested for the Telegram thread, then a message is sent with the text "¿Permitir esta acción?" (or "⚠️ Auto-review marcó esta acción como riesgosa." when flagged), the reason, "Herramienta: <name>" and the input as JSON (cut at 1500 characters with "…"), and buttons "Permitir", "Rechazar" and, only when the approval allows it, "Siempre". [gap] *Amended by [029](../029-alma-creates-companies/spec.md) (2026-11-08): for `create_company`, when the input JSON does not fit in the 1500 characters, the message says to see the proposal on the desktop instead of showing the cut JSON, has no "Permitir" (only "Rechazar") and the approval stays pending for the desktop (029 BR-23, AC-2.12).*
- **AC-6.2** (US-5) Given an approval message, when an authorized chat presses a button, then the decision (allow / always / deny) is sent to the approval broker and the button press is acknowledged with "Permitido" (allow, always) or "Rechazado" (deny). [gap]
- **AC-6.3** (US-5) Given an approval is resolved (from Telegram or from the desktop), when the event arrives, then the Telegram message is edited to its original text plus "(respondido)". [gap]
- **AC-6.4** (US-5) Given a button press from a chat that fails authorization, or callback data that does not match `ap:<id>:(allow|always|deny)`, when it arrives, then it is ignored (acknowledged without effect). [gap]
- **AC-6.5** (US-5) Given an approval for a different conversation than the Telegram one (desktop chat, routine, company), when it is requested, then nothing is sent to Telegram. [gap]
- **AC-6.6** (US-5) Given no chat is bound or the bot is stopped, when an approval is requested, then nothing is sent (it stays available on the desktop). [gap]


### Outbound (US-6, US-7)
- **AC-7.1** (US-6) Given the bot is online and a chat is bound, when a reminder fires, then "⏰ <text>" is sent to that chat, split if over 4096 characters; the desktop notification is sent regardless. [gap]
- **AC-7.2** (US-6) Given the bot is not connected or no chat is bound, when `notify` is called, then it sends nothing and returns false without raising; a rejection from Telegram is logged on the console only. [gap]
- **AC-7.3** (US-6) Given house notices (a rule fired, a watched camera condition) and company notices (title and body), when they are raised, then they are also sent to Telegram through the same `notify` (with the picture and a caption of at most 1000 characters when a photo exists). [gap] *Amended by [033](../033-nightly-dream-and-morning-greeting/spec.md) (2026-11-09): with the nightly dream on, the morning greeting also reaches the bound chat through the same `notify`, once a day, and is appended to the Telegram thread as an assistant message; when the person's first message of the day came over Telegram, it is sent after the answer to it. Routine results still do not reach Telegram (033 BR-28, AC-7.4, AC-7.10).*
- **AC-7.4** (US-7) Given `send_telegram` with `text`, when it runs and the bot is online with a bound chat, then the text is sent (split at 4096) and the tool returns "Mensaje enviado por Telegram.". [gap]
- **AC-7.5** (US-7) Given `send_telegram` with `image_path`, when it runs, then the image (JPG, PNG, WebP, GIF, under 8 MB, inside the vault, the working folder or the inbox) is sent as a photo with `text` as caption (cut at 1000) and the tool returns "Foto enviada por Telegram."; a path outside those folders or a non-image raises a tool error. [gap]
- **AC-7.6** (US-7) Given Telegram is off, has no token, or no chat is bound yet, when `send_telegram` runs, then it fails with "Telegram no está conectado: falta el token del bot en Configuración → Telegram, o el usuario todavía no le escribió al bot para vincular su chat." [gap]
- **AC-7.7** (US-7) Given Telegram rejects the message or photo, when `send_telegram` runs, then it fails with "Telegram no aceptó el mensaje: <message>" / "Telegram no aceptó la foto: <message>". [gap]
- **AC-7.8** (US-7) Given the run context has no Telegram capability, when `send_telegram` runs, then it fails with "Telegram no está disponible desde acá.". [gap]
- **AC-7.9** (US-7) Given `send_telegram` is called with empty `text` or more than 20 000 characters, when the input is validated, then the call is rejected as invalid input before running. [gap]
- **AC-7.10** (US-7) Given any agent in any approval mode except "blocked", when it calls `send_telegram`, then it runs without asking (risk `memory`); in "blocked" mode it is not allowed. [gap]

## 6. Business rules
- **BR-1** The bot only talks to private chats; groups, supergroups and channels are always denied. (src/coordinator/channels/telegram.ts `authorizeChat`)
- **BR-2** While `chatId` is null, a private chat is accepted only if its username (case-insensitive, `@` ignored) is in `allowedUsers`, and the first such chat is bound. Once `chatId` is set, only that chat id is accepted and `allowedUsers` is no longer consulted. (same)
- **BR-3** Telegram messages are capped at 4096 characters; longer text is split at the last `\n\n`, `\n` or `. ` found after half of the limit, otherwise at the limit. (same, `TELEGRAM_LIMIT`, `splitForTelegram`)
- **BR-4** The "Pensando…" placeholder is edited with tool names at most once every 1500 ms. (same, `STATUS_EDIT_MS`)
- **BR-5** Approval buttons carry `ap:<approvalId>:<allow|always|deny>`; "Siempre" appears only when the approval allows it (never for `publish` tools). Input shown is cut at 1500 characters. Fixed texts the code sends on this channel (button labels, bot-command descriptions, status replies) follow `language`, the `es` ones being quoted in this spec; what the agent writes follows the language of the incoming message; yes/no replies are understood in Spanish and English (spec 025 BR-15). (same; src/coordinator/approval.ts)
- **BR-6** Photo captions sent by the bot are cut at 1000 characters. (same, `notifyPhoto`)
- **BR-7** The Telegram conversation is answered by `settings.telegram.agentId`, falling back to the default agent if it was deleted; `/nuevo` creates a new thread instead of clearing the old one. (src/coordinator/index.ts `channelConversation`)
- **BR-8** Polling starts with `drop_pending_updates`; there is no webhook and no listening port. (same, `start`)
- **BR-9** `send_telegram` has risk `memory`, is `standalone` (needs no working folder), is offered to every agent (also company agents), has text 1–20 000 characters and an optional `image_path`, and writes only to the bound chat, never to other people. (src/coordinator/tools/telegram.ts)
- **BR-10** The bot token is stored encrypted in `settings.json` (`providers.telegram.apiKey`) or read from `TELEGRAM_BOT_TOKEN`; the environment variable is removed from the environment of commands agents run. (src/main/settings.ts, src/coordinator/tools/shell.ts)
- **BR-11** Authorization is checked on every handler (commands, text, voice, photo and button presses) before anything is downloaded or run. (src/coordinator/channels/telegram.ts `check`)


## 7. Constraints and risks
- **Layers:** `coordinator` (channel, tool, wiring), `shared` (`TelegramSettings`, `TelegramStatus`, events `telegram.status`, request `telegram.status`), `main` (settings persistence and the encrypted token), `renderer` (settings tab, sidebar icon, status in app state).
- **Files:** src/coordinator/channels/telegram.ts, src/coordinator/tools/telegram.ts, src/coordinator/index.ts (channel wiring, `channelConversation`, `deliverReminder`, `notifyHome`, `saveInboxImage`), src/coordinator/agent.ts (tool registration, channel system prompt), src/main/settings.ts, src/shared/types.ts, src/shared/defaults.ts, src/renderer/src/components/SettingsDialog.tsx (`TelegramTab`), src/renderer/src/components/Sidebar.tsx, src/renderer/src/lib/state.ts. Library: grammy 1.46.
- **Persistence:** settings (`telegram`, `providers.telegram.apiKey`) in main's `settings.json`; the bound `chatId` and `threadId` are patched by the coordinator and persisted by main (`settings.patch`). Photos go to `<dataDir>/inbox`. The conversation is an ordinary thread under `<dataDir>`. There is no other Telegram state, and nothing is deleted from the inbox by this feature.
- **Messages between layers:** request `telegram.status` (returns the current status); event `telegram.status` broadcast on every change; coordinator → main `settings.patch` when binding or when a thread is created.
- **Tool:** `send_telegram` (risk `memory`).
- **Security / privacy:** only the owner's private chat is served; denied attempts are audited (`channel.denied`, throttled, no names or text), binding is audited (`channel.bind`). Messages, voice notes and photos travel through Telegram's servers (not end-to-end encrypted for bots). Photos requested from cameras and reminders go to Telegram. The token appears in the download URL used for voice notes and photos (not logged by Alma). A person who holds the phone or the Telegram account can drive the agents and approve actions. See `docs/security/CONTROLS.md` and `PRIVACY.md`.
- **Platform:** Alma must be running (window or tray); nothing is received while it is closed (pending updates are dropped on the next start). Needs internet access to `api.telegram.org`.
