# 010 — Plan

## 1. Approach
The bot runs inside the coordinator with long polling (grammy): no webhook, no server, no open port
([ADR 0009](../../../docs/adr/0009-telegram-long-polling-in-app.md)). The decision of who may talk to it is one pure function,
`authorizeChat`, called by every handler before anything is downloaded or run; the first allowed private chat is bound by chat id,
and from then on only that id is accepted. Messages become turns of an ordinary Alma thread with channel `telegram`, so the
conversation shows in the sidebar and runs through the same agent loop and approval broker as the desktop. `TelegramChannel` talks
to the rest of the coordinator only through `TelegramDeps`, which keeps it free of the agent loop and testable.

Rejected: a public webhook (needs an open port or a tunnel, and anyone who finds the URL reaches the machine) and trusting
usernames alone (a username can be changed or taken by someone else; a chat id cannot).

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`TelegramSettings`, `TelegramStatus`, request and event `telegram.status`, `settings.patch`), `src/shared/defaults.ts` (defaults), `src/shared/audit.ts` (throttled audit events) | types and defaults used by main, coordinator and renderer |
| coordinator | `src/coordinator/channels/telegram.ts` (`authorizeChat`, `splitForTelegram`, `TelegramChannel`), `src/coordinator/tools/telegram.ts` (`send_telegram`), `src/coordinator/index.ts` (`channelConversation`, `saveInboxImage`, reminder and house-notice delivery, `telegram.sync()` on settings), `src/coordinator/agent.ts` (tool registration, channel system prompt), `src/coordinator/tools/shell.ts` (token removed from commands' environment) | the network client and the agent loop are coordinator work |
| main | `src/main/settings.ts` (merge over defaults, `providers.telegram.apiKey` sealed with `safeStorage`, persist `settings.patch`) | owns secrets and the settings file |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (`TelegramTab`), `src/renderer/src/components/Sidebar.tsx` (paper-plane icon), `src/renderer/src/lib/state.ts` (status) | screens only |

## 3. Contracts
- `TelegramSettings { enabled; allowedUsers: string[]; agentId; chatId: number | null; threadId: string | null }`;
  `TelegramStatus { state: 'off' | 'connecting' | 'online' | 'error'; username?; error? }`.
- `authorizeChat(telegram, chat: { id; type } | undefined, username?): 'ok' | 'bind' | 'denied'`.
- `splitForTelegram(text, limit = 4096): string[]`.
- `TelegramDeps { settings(); token(); patch(patch); conversation(fresh?): Thread; ask(threadId, text): Promise<void>;
  lastAnswer(threadId): string; transcribe?(audio, mime): Promise<string>; saveImage?(bytes, name): string; onEvent(listener);
  respondApproval(approvalId, decision); onStatus(status) }`.
- `TelegramChannel`: `sync(): Promise<void>`, `currentStatus()`, `notify(text): Promise<boolean>`,
  `notifyPhoto(jpeg, caption): Promise<boolean>`, `stop()`.
- Approval button data `ap:<approvalId>:(allow|always|deny)`.
- Messages: request `telegram.status`; event `telegram.status { status }`; coordinator → main `settings.patch` when a chat is bound
  or a thread is created.
- Tool `send_telegram` (`memory`, `standalone`): `{ text: string (1–20 000); image_path?: string }`; `ToolContext.sendTelegram(text)`
  and `ToolContext.sendTelegramPhoto(jpeg, caption)` answer `false` when not connected.
- Audit actions `channel.bind` and `channel.denied` (actor `remote`; the second throttled and carrying only the chat type).

## 4. Data and persistence
- `settings.json` (main): `telegram` (defaults `enabled: true`, `allowedUsers: []`, `agentId: 'general'`, `chatId: null`,
  `threadId: null`; older files are merged over them) and `providers.telegram.apiKey` encrypted; `TELEGRAM_BOT_TOKEN` is the
  fallback when no token is saved.
- The bound `chatId` and `threadId` are patched by the coordinator and persisted by main.
- Photos go to `<dataDir>/inbox`; the conversation is an ordinary thread under `<dataDir>`. There is no other Telegram state, and
  nothing is deleted from the inbox by this feature.

## 5. Dependency injection
- `TelegramChannel` gets everything through `TelegramDeps`; `src/coordinator/index.ts` builds it with the real store, agent loop,
  voice `transcribe` and `saveInboxImage`. The pure functions need no fake at all.
- `send_telegram` reads the bot only through `ToolContext.sendTelegram` / `sendTelegramPhoto`, and the picture roots through
  `pictureRoots(ctx)` (vault, working folder, inbox). A test supplies those functions; none exists yet.
- grammy's `Bot` is created inside `start`, so the network is never touched by the unit tests that exist.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | `tests/telegram.test.ts` → `binds the first allowed user in a private chat, case-insensitively and ignoring @` | `@Felix` vs `felix`, other username, no username |
| AC-1.2 | `tests/telegram.test.ts` → `never accepts groups, even from an allowed user` | supergroup whose id equals the bound one |
| AC-1.3 | `tests/telegram.test.ts` → `once bound, only that chat works, whatever the username` | another chat with a listed username |
| AC-1.5 | `tests/audit.test.ts` → `never writes secrets and can throttle spammable events` | repeated event in one minute |
| AC-3.4 | `tests/telegram.test.ts` → `keeps short text whole and splits long text at line breaks under the limit` | 50 lines of 90+ characters at a 1000 limit |
| AC-1.9, AC-2.9, AC-2.12, AC-3.11 | [manual] | the Telegram tab with and without a token; write from a phone; "Desvincular" and write again |
| AC-1.4, AC-1.5b–1.8, AC-2.1–2.8, AC-2.10, AC-2.11, AC-3.1–3.3, AC-3.5–3.10, AC-3.12, AC-4.1–4.4, AC-5.1–5.4, AC-6.1–6.6, AC-7.1–7.10 | [gap] | priority: a denied chat must never reach `ask`, `transcribe` or a download; approval buttons from another chat; `send_telegram` with a path outside the allowed folders |

## 7. Security and privacy impact
- Only the owner's private chat is served. Denied attempts are audited as `channel.denied` (throttled, no names or text), binding as
  `channel.bind`. Authorization runs before downloads, transcription or agent runs, and on button presses.
- `send_telegram` is `memory`: it asks nothing in any mode but "Solo lectura" and writes only to the bound chat, never to other
  people. Images are limited to JPG, PNG, WebP, GIF under 8 MB inside the vault, the working folder or the inbox.
- The token is sealed with `safeStorage` ([ADR 0013](../../../docs/adr/0013-secrets-with-safestorage.md)) or read from the
  environment, and the environment variable is stripped from the commands agents run. It appears in the download URL of voice
  notes and photos, which Alma does not log.
- Messages, voice notes and photos pass through Telegram's servers (not end-to-end encrypted for bots). Whoever holds the phone
  or the Telegram account can drive the agents and approve actions.
- `docs/security/CONTROLS.md` (remote-channels row) and `docs/security/PRIVACY.md` (WhatsApp and Telegram row) cover this and
  are kept in step with it.

## 8. Rollout
- Setting `telegram.enabled`, default `true`; with no token nothing starts, and with an empty `allowedUsers` nobody can bind.
  Turn it off with "Bot activo" or by deleting the token.
- First run: the person pastes the token, lists their username, writes `/start` to the bot; the first listed user is bound,
  and the status badge goes "Conectando…" → "Conectado como @bot". Updates sent while Alma was closed are dropped.
