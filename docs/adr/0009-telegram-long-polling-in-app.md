---
status: accepted
---

# Telegram runs inside the app with long polling (grammy), bound to one private chat

The Telegram bot runs inside the coordinator with `grammy` and long polling (`src/coordinator/channels/telegram.ts`): no webhook, no server, no open port. The person creates the bot with @BotFather and configures token, allowed users and the answering agent in Settings. The bot serves private chats only; the first allowed user who writes becomes the **bound chat**, and from then on only that chat id is accepted. Each Telegram chat is an ordinary conversation in the sidebar (`/nuevo` starts another). Approvals arrive as Permitir / Rechazar ("Allow" / "Reject") buttons. Ported from the ALMA monorepo's telegram-bot.

## Why

Design note "channels-voice-design": the user wants everything configurable in Settings, local-first, with no extra services to run. The spec states the goal: reach Alma from the phone without exposing the machine to strangers who find the bot ([spec 010](../../.specify/specs/010-telegram/spec.md), section 2). Why long polling over a webhook: Rationale not documented. Inference: a webhook would need a public endpoint.

## Considered options

Alternatives: not documented.

## Consequences

- Alma must be running (window or tray) to receive anything; pending updates are dropped on the next start (`drop_pending_updates`).
- Messages, voice notes and photos pass through Telegram's servers (bots are not end-to-end encrypted); whoever holds the phone or the Telegram account can drive agents and approve actions.
- The bot token is a secret slot ([ADR 0013](0013-secrets-with-safestorage.md)); it appears in file-download URLs (not logged by Alma).
- `send_telegram` has risk `memory` and never asks, though it sends data off the machine; its target is limited to the bound chat.
- Reminders and notices are delivered only if the bot is online at that moment; a failure is silent.
- A second message while the agent is still working is answered with an error, not queued.
- Default `telegram.enabled` is `true`, so the bot starts as soon as a token exists.
