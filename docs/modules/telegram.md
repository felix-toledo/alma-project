# Telegram

> A Telegram bot that runs inside Alma and lets the owner talk to an agent, approve actions, and receive reminders from a phone. Spec: [010 · Telegram](../../.specify/specs/010-telegram/spec.md). Test status: 5 criteria with a test, 4 manual-only, 49 without a test (58 in total).

## What it does

The person creates a bot with @BotFather, pastes its token in Alma, and lists their own Telegram username. From then on:

- **Chat.** The owner's private chat with the bot is one more conversation in Alma. Text, voice notes and photos go to an agent, and the answer comes back to the phone.
- **Casa panel.** `/home` (or the fixed "🏠 Casa" button) shows the house as button menus: rooms with their devices to tap on/off, scenes ("Modos") to activate, and cameras to get a still. Locks, alarms and gates ask for confirmation in the chat before acting.
- **Approvals.** When an agent needs permission, the bot sends a message with buttons "Permitir" (allow) and "Rechazar" (reject), plus "Siempre" (always) when that is allowed. The same approval stays answerable in the desktop app. When Alma proposes a company (`create_company`, spec 029), the message has Permitir and Rechazar and never "Siempre"; if the whole proposal does not fit in the message, Permitir is left out and the text says to see it on the desktop (Rechazar stays).
- **Notices.** Reminders, house alerts (a rule fired, a camera condition) and company notices arrive as Telegram messages.
- **Agents can message the owner.** The tool `send_telegram` sends text or one image to the bound chat.
- **Morning greeting** (spec 033, only with the nightly dream on). At the person's first wake signal of the day, the greeting the dream wrote at night is sent to the bound chat and appended to the Telegram conversation as an assistant message, once. When that first message came over Telegram, the greeting is sent after the answer to it (the Telegram conversation is a single thread); the desktop and the phone get it at once. Not connected, not bound or failing: it is skipped and not retried, logged without its text, and the other channels and the greeting's own conversation are unaffected.

It talks to one private chat only. Groups, supergroups and channels are always refused. There is no server and no open port: the bot uses long polling to `api.telegram.org`.

## How to use it

1. In Telegram, talk to @BotFather, create a bot, and copy the token.
2. In Alma open «Configuración → Telegram» (Settings → Telegram). Paste the token and press "Guardar token" (Save token). The badge goes "Conectando…" then "Conectado como @bot".
3. Under «Quién puede escribirle» (who may write to it), type your Telegram username (with or without `@`; Enter or "Agregar"). Pick which agent answers.
4. Open the `t.me/<bot>` link shown once the bot is online and send `/start`. The first listed user who writes privately is bound to the bot by chat id.
5. Write or send a voice note. The bot answers "Pensando…" (thinking) and replaces it with the answer.

Chat commands:

| Command | Effect |
|---|---|
| `/start` | Replies «Hola, soy Alma. … Tocá 🏠 Casa (o mandá /home) para manejar tu casa.» and shows the fixed "🏠 Casa" keyboard button. Runs no agent. |
| `/nuevo` | Starts a new Telegram conversation («Listo, conversación nueva.»). The old one stays in the sidebar. |
| `/home` | Opens the Casa panel (rooms, scenes, cameras) instead of asking the agent. |
| any other `/x` | Treated as ordinary text for the agent. |

Asking Alma to message you, from any chat: «mandame por Telegram cuando termines» (send me a Telegram when you finish), «avisame por Telegram si...» (tell me on Telegram if...).

Other controls in the tab: "Borrar" (delete the stored token; shown only when the token is in settings, not in the environment), the "Bot activo" (bot active) checkbox, and "Desvincular" (unbind) in the allowed-users card. The Telegram thread shows a paper-plane icon with the tooltip «Conversación de Telegram» in the sidebar.

## How it works

Pieces:

| File | Role |
|---|---|
| `src/coordinator/channels/telegram.ts` | The channel: grammy bot, `authorizeChat`, `splitForTelegram`, status, approvals, `notify`, `notifyPhoto`, the `/home` panel wiring. |
| `src/coordinator/channels/home-menu.ts` | The Casa panel as pure functions: room/scene/camera views, `toggleControl`, `sensitiveActions`, short callback tokens (`HomeTokens`), `parseHomeCallback`, `isHomeOpenText`. |
| `src/coordinator/tools/telegram.ts` | The `send_telegram` tool. |
| `src/coordinator/index.ts` | Wiring: `channelConversation`, `deliverReminder`, `notifyHome`, `saveInboxImage`, token lookup. |
| `src/coordinator/agent.ts` | Registers the tool and adds the channel text to the system prompt. |
| `src/main/settings.ts` | Persists `telegram` and the encrypted token. |
| `src/renderer/src/components/SettingsDialog.tsx` (`TelegramTab`), `Sidebar.tsx` | The tab and the sidebar icon. |

Flow of one message:

```
phone ──> api.telegram.org <── long polling ── channel (coordinator)
                                   │ authorizeChat: deny / bind / ok
                                   │ voice note -> transcribe; photo -> <data>/inbox
                                   ▼
                       channelConversation -> Telegram thread (channel 'telegram')
                                   ▼
                          agent run; tool names edit the "Pensando…" placeholder
                                   ▼
                     answer split at 4096 chars -> sendMessage
```

Non-obvious points:

- **Authorization is a pure function** (`authorizeChat`) and runs in every handler before anything is downloaded or run. While `chatId` is `null` it accepts a private chat whose username is in `allowedUsers` (case-insensitive, `@` ignored) and returns "bind". Once `chatId` is set, only that id passes and `allowedUsers` is no longer consulted.
- **Binding** saves `chatId` through a `settings.patch` message to main. The thread id is saved the same way.
- **Restart rules.** Applying settings restarts the bot only if the token or the enabled flag changed. A new token forgets the old approval buttons.
- **Placeholder edits.** While the agent runs, the placeholder is edited with the tool name (prefix `mcp__` removed, underscores as spaces), at most every 1.5 s and only when the text changed.
- **Company tools and the whole-input rule (spec 029 BR-23).** `approvalPrompt` (`channels/texts.ts`) and `askApproval` ask `canAnswerFrom('telegram', approval, 1500)`: for `create_company` / `edit_company`, when `JSON.stringify(input, null, 1)` is longer than 1500 characters, the message carries the `chan.seeOnDesktop` text instead of the cut input and no Permitir button; other tools keep the cut and their buttons. A press goes to the broker with the channel `telegram` (`approvals.respond(id, decision, 'telegram')`), which also refuses an allow it could not have shown whole, so a stale or hand-made callback cannot approve it; the approval stays pending for the desktop. The audit entry of the call records the channel. The tools are offered in the Telegram thread like in any desktop chat.
- **Approval buttons** carry `ap:<approvalId>:<allow|always|deny>`. After resolution (from either side) the message is edited to its original text plus "(respondido)" (answered). Only approvals for the Telegram conversation are sent; approvals for desktop chats, routines and companies never go to Telegram.
- **Casa panel buttons** carry `hm:<action>[:<token>[:<arg>]]` (`home-menu.ts`). Buttons never embed entity ids (they can exceed the 64-byte `callback_data` cap); they carry a short token that resolves against the live snapshot, and stale tokens answer "that panel expired, send /home again". Every tap re-reads the snapshot; after acting, the room is re-read ~800 ms later so the buttons show the new state. `/home` is caught in the text handler rather than `bot.command`, because grammY would run both handlers and send the panel twice.
- **Voice notes** are downloaded and handed to the transcriber of the [voice module](voice.md), echoed back as `🎙️ «texto»` and then handled like typed text. **Photos**: the largest size is saved in `<data>/inbox` and the agent is told «[El usuario te mandó una imagen: <ruta>. Mirala con look_at_image.]».
- **Channel prompt.** In a Telegram thread the agent is told it is on a phone: brief answers, no tables or long code blocks, audios arrive transcribed.
- **Messages between layers.** Request `telegram.status`; event `telegram.status` on every change; coordinator to main `settings.patch`.

## Tools for agents

| Tool | `ToolRisk` | Asks approval | Purpose |
|---|---|---|---|
| `send_telegram` | `memory` | No (only the read-only mode `blocked` forbids it) | Send text (1–20 000 characters) and/or an image (`image_path`) to the bound chat. Also offered to company agents; needs no working folder (`standalone`). |

Error messages the model sees: «Telegram no está conectado: falta el token del bot en Configuración → Telegram, o el usuario todavía no le escribió al bot para vincular su chat.» (not connected or not bound), «Telegram no aceptó el mensaje/la foto: <message>» (Telegram refused), «Telegram no está disponible desde acá.» (no Telegram capability in the run). Success returns «Mensaje enviado por Telegram.» or «Foto enviada por Telegram.».

## Settings and data

| Setting | Default | Meaning |
|---|---|---|
| `telegram.enabled` | `true` | Bot runs when a token exists. |
| `telegram.allowedUsers` | `[]` | Usernames allowed to bind. Empty means nobody can bind. |
| `telegram.agentId` | `general` | Agent that answers (falls back to the default agent if deleted). |
| `telegram.chatId` | `null` | Bound chat id; written by the coordinator. |
| `telegram.threadId` | `null` | Current Telegram thread; written by the coordinator. |
| `providers.telegram.apiKey` | empty | Bot token, stored encrypted in `settings.json`. |
| `TELEGRAM_BOT_TOKEN` (environment) | unset | Used only when no token is saved in settings. |

Data: settings in main's `settings.json`; the conversation is an ordinary thread under the data folder; photos in `<data>/inbox`. Nothing deletes the inbox. Older saved settings are merged over these defaults.

## Limits and rules

| Value | Where |
|---|---|
| Message cap 4096 characters; longer text is split at the last `\n\n`, `\n` or `. ` after half the limit, else at the limit | `TELEGRAM_LIMIT`, `splitForTelegram` |
| Placeholder edited at most every 1500 ms | `STATUS_EDIT_MS` |
| Approval input shown cut at 1500 characters (`APPROVAL_INPUT_LIMIT`); not cut for `create_company` / `edit_company`: no Permitir instead | `texts.ts`, `telegram.ts` |
| Photo captions cut at 1000 characters | `notifyPhoto` |
| `send_telegram` images: JPG, PNG, WebP, GIF, under 8 MB, inside the vault, the working folder or the inbox | tool |
| Polling starts with `drop_pending_updates`: anything sent while Alma was closed is lost | `start` |

Alma must be running (window or tray). Nothing is received while it is closed.

## Security and privacy

- Only the owner's private chat is served. A denied private chat gets «No estás autorizado para usar este bot. Para habilitarte, agregá @usuario en Alma → Configuración → Telegram.» (not authorized to use this bot) and nothing runs or downloads; a denied group gets silence.
- Binding is audited as `channel.bind` and denials as `channel.denied` (actor `remote`, throttled to one line a minute, chat type only, no names or text). See [security](security.md) and `../security/CONTROLS.md`.
- Messages, voice notes and photos go through Telegram's servers, which are not end-to-end encrypted for bots. Reminders, camera photos and the morning greeting's text (spec 033) sent to the phone leave the machine too.
- Anyone holding the owner's phone or Telegram account can drive the agents and approve actions.
- The token is encrypted at rest. `TELEGRAM_BOT_TOKEN` is removed from the environment of commands that agents run (`src/coordinator/tools/shell.ts`). The token appears in the download URL used for voice notes and photos; Alma does not log it.
- Unrecognized message types (stickers, documents, video, location, edits) are ignored silently.

## How it is tested

`tests/telegram.test.ts` covers `authorizeChat` (bind, groups denied, bound chat only; AC-1.1 to 1.3) and `splitForTelegram` (AC-3.4). `tests/telegram-home.test.ts` covers the Casa panel: toggle mapping, sensitive actions, tokens, callback parsing, views and the 64-byte cap. `tests/audit.test.ts` covers the audit throttle (AC-1.5). Spec 029 adds three cases to `tests/telegram.test.ts`: company tools ask only the bound chat with Permitir and Rechazar and no Siempre and create on Permitir (`AC-2.8 (029)`), no Permitir when the proposal does not fit (`AC-2.12 (029)`), and other tools keep the cut and their buttons. Everything else in the spec is marked `[gap]`: connection states, handlers, approvals, `send_telegram`, photo and voice paths. Nothing here needs a live Telegram account in tests; there are no tests with a fake bot yet.

By hand: configure a bot, check the badge, write from the phone, press an approval button, press "Desvincular" and write again from another allowed user, send a voice note and a photo. For the Casa panel: send `/home`, open a room, toggle a light, activate a scene, open a camera, and confirm a lock.

## Known limits

1. **Probable bug: photos are saved with a broken name.** `saveInboxImage` sanitizes with `/[^w.-]+/g` (no backslash before `w`), so letters are replaced by `_` and the `.jpg` extension is lost; `look_at_image` may then refuse the file. Confirmed still present at `src/coordinator/index.ts:352`.
2. Voice notes and photos are downloaded without checking HTTP status or size.
3. A second message while the agent works is rejected with «No pude completar el pedido: Ya hay una ejecución en curso en esta conversación.» and not queued.
4. Reminders and notices are lost silently if the bot is offline.
5. `send_telegram` never asks, though it sends data out (limited to the bound chat).
6. Removing a user from the list does not unbind the chat; "Desvincular" keeps `threadId`.
7. `enabled` defaults to `true`, and the unauthorized reply reveals the bot's `@username`.

Spec: [010](../../.specify/specs/010-telegram/spec.md).

## See also

[WhatsApp](whatsapp.md) (the other chat channel) · [Voz](voice.md) (transcription of voice notes) · [Aprobaciones](approvals.md) · [Rutinas](routines.md) (reminders delivered here) · [Casa](home.md) · [Seguridad](security.md) · [Herramientas](../references/tools.md) · [Ajustes](../references/settings.md) · [Architecture](../architecture.md)
