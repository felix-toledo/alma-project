# Alma — specs

One folder per feature: `NNN-slug/` with `spec.md`, `plan.md` and `tasks.md` (plan and tasks once the spec is `ready`).
Templates: [`../templates/`](../templates). Pipeline: [`docs/pipeline.md`](../../docs/pipeline.md). Rules: [`../memory/constitution.md`](../memory/constitution.md).

`tests/specs.test.ts` checks every folder here on each `pnpm test`.

## How to read them

- Each acceptance criterion cites the test that covers it (`Test: tests/x.test.ts › "title"`), or is tagged
  `[gap]` (testable, no test yet) or `[manual]` (UI/hardware, checked by hand).
- **The `[gap]` list is the test backlog.** `grep -rc "\[gap\]" .specify/specs` counts it per spec. It only shrinks:
  when you add a test, replace the tag with the citation.
- Spanish text quoted in specs written before [025](./025-i18n-es-en/spec.md) is the `es` value of a dictionary key (rioplatense, unchanged); the English value lives in the dictionary. From 025 on, specs cite UI text by dictionary key.

| # | Spec | Area |
|---|---|---|
| 002 | [chat](./002-chat/spec.md) | threads, messages, composer, streaming |
| 003 | [agents](./003-agents/spec.md) | profiles, run loop, sub-agents |
| 004 | [approvals](./004-approvals/spec.md) | approval modes and auto-review |
| 005 | [providers](./005-providers/spec.md) | Anthropic, xAI, DeepSeek, gateways |
| 006 | [settings](./006-settings/spec.md) | settings, secrets, every settings tab |
| 007 | [companies](./007-companies/spec.md) | companies: org chart, tasks, meetings, budgets |
| 008 | [vault](./008-vault/spec.md) | the notes view |
| 009 | [knowledge-and-memory](./009-knowledge-and-memory/spec.md) | index, search, embeddings, memory |
| 010 | [telegram](./010-telegram/spec.md) | Telegram channel |
| 011 | [whatsapp](./011-whatsapp/spec.md) | WhatsApp channel |
| 012 | [instagram](./012-instagram/spec.md) | Instagram publishing |
| 013 | [house-engine-and-devices](./013-house-engine-and-devices/spec.md) | Home Assistant engine, devices |
| 014 | [house-plan-cameras-and-rules](./014-house-plan-cameras-and-rules/spec.md) | plan, cameras, scenes, rules |
| 015 | [file-and-command-tools](./015-file-and-command-tools/spec.md) | file and shell tools |
| 016 | [web-and-mail](./016-web-and-mail/spec.md) | web search/fetch, email |
| 017 | [mcp](./017-mcp/spec.md) | MCP connectors |
| 018 | [routines-and-reminders](./018-routines-and-reminders/spec.md) | routines and reminders |
| 019 | [voice](./019-voice/spec.md) | voice assistant |
| 020 | [images](./020-images/spec.md) | image generation, composition, vision |
| 021 | [office-documents-and-drawings](./021-office-documents-and-drawings/spec.md) | Word/Excel/PowerPoint/PDF, drawings |
| 022 | [security-and-privacy](./022-security-and-privacy/spec.md) | secrets, guard, audit, privacy |
| 023 | [app-shell-and-ui](./023-app-shell-and-ui/spec.md) | windows, tray, IPC, console-style UI |
| 024 | [voice-control-models-and-meta](./024-voice-control-models-and-meta/spec.md) | voice cancel/end, model per chat, Meta default, fewer tokens, pop-up CSS |
| 025 | [i18n-es-en](./025-i18n-es-en/spec.md) | `language` setting, es/en dictionaries, agent and voice language, docs in English (ready: the code is done; manual walks pending, see its tasks.md Close-out) |
| 026 | [remote-access](./026-remote-access/spec.md) | remote channel (phone pairing, scopes, step-up, audit) over a swappable transport, Tailscale first, plus the installed PWA (implemented; the `[manual]` ACs need a real iPhone and the native dialogs; R-02 and R-01 closed; off by default until spec 001 delivers signing, BR-10) |

## In progress

| # | Spec | Status |
|---|---|---|
| 001 | [release-packaging](./001-release-packaging/spec.md) | draft: packager, signing, update channel and versioning not decided |
| 028 | [remote-vault-and-threads](./028-remote-vault-and-threads/spec.md) | ready, no open questions: phone app reads the vault (Notes scope, read-only) and reads and continues other conversations (History scope), plus phone app polish; 027 stays reserved for the relay |
| 029 | [alma-creates-companies](./029-alma-creates-companies/spec.md) | draft: Alma creates and edits (never deletes) companies through `publish` tools with a native approval card, sharing the Equipos creation logic; no open questions, awaiting `ready` |
| 030 | [chat-attachments](./030-chat-attachments/spec.md) | draft: images and files (2 MiB each) in the desktop composer, `read_attachment`, privacy measures, 30-day sweep; no open questions, awaiting `ready` |
| 032 | [remote-home-modes-and-lights](./032-remote-home-modes-and-lights/spec.md) | draft, no open questions (all 16 answered by the owner, awaiting the human's `ready`): phone Casa tab activates house modes (HA scenes; one that holds a lock/alarm/gate needs the locks sub-switch plus a passkey step-up) and sets light brightness, color (8 swatches) and white tone; 031 stays reserved for phone attachments |

Numbering: next free `NNN`, never reused. A spec that is abandoned stays, with its status line explaining why in §1.
