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
| 027 | [alma-e2e-relay](./027-alma-e2e-relay/spec.md) | ready (set on the human's authorization while away; OQ-18 and OQ-19 are provisional defaults to confirm on return; plan and tasks written; ADR 0022 proposed; tasks T1 to T32 built in the repository, nothing deployed, verification T33 and the human tasks pending): an Alma-run relay, operated by the maintainer, as a third transport for the remote channel (phone, relay, PC) plus the session-key end-to-end layer promised by 026 BR-23 and ADR 0020; one transport at a time, opt-in, no accounts, the relay sees only ciphertext and keeps nothing; the 026 channel stays unchanged |
| 028 | [remote-vault-and-threads](./028-remote-vault-and-threads/spec.md) | ready, no open questions: phone app reads the vault (Notes scope, read-only) and reads and continues other conversations (History scope), plus phone app polish; 027 is the relay spec (ready; built, not deployed) |
| 029 | [alma-creates-companies](./029-alma-creates-companies/spec.md) | ready: Alma creates and edits (never deletes) companies through `publish` tools with a native approval card, sharing the Equipos creation logic; no open questions; plan and tasks written, `create_company` built, `edit_company` blocked on plan gap G-1 and the brief header on G-2 |
| 030 | [chat-attachments](./030-chat-attachments/spec.md) | ready, no open questions: images and files (2 MiB each) in the desktop composer, `read_attachment`, privacy measures, 30-day sweep; built except the phone `lastOpenedAt` (T32), the docs and security tasks (T47 to T50), the i18n audit and the manual walk; existing specs amended (T51) |
| 031 | [remote-chat-attachments](./031-remote-chat-attachments/spec.md) | built (T0 to T55 and T62 to T63 done; docs T56 to T61, i18n audit T64 and verify T65 pending), T45 blocked on G2 (the verify-027 transport pin), manual phone walk pending; ready, no open questions (13 decided by the planner on the owner's delegation, owner may veto): phone attaches photos and files in the Chat tab and in conversations (new "Send files" sub-switch under Chat, files ≤ 700 000 bytes, photos shrunk on the phone, same 030 checks on the PC), phone shows attachments by name, plus the phone halves of 030 AC-6.7 (`lastOpenedAt`) and AC-8.1; touches the 027-protected security layer (manifest hashes updated deliberately) |
| 032 | [remote-home-modes-and-lights](./032-remote-home-modes-and-lights/spec.md) | draft, no open questions (all 16 answered by the owner, awaiting the human's `ready`): phone Casa tab activates house modes (HA scenes; one that holds a lock/alarm/gate needs the locks sub-switch plus a passkey step-up) and sets light brightness, color (8 swatches) and white tone; 031 stays reserved for phone attachments (027 is taken by the relay spec) |
| 033 | [nightly-dream-and-morning-greeting](./033-nightly-dream-and-morning-greeting/spec.md) | ready, no open questions (Q1-Q34 answered by the owner on 2026-11-09; status set on the owner's relayed instruction while away, he may revert it); plan and tasks written (T0-T45, after 034); built: every task done but T5 (blocked on the economy table's prices, plan §9 B-1, so no dream runs yet) and T45's manual walk; ADR 0023 accepted: opt-in nightly dream (fixed pipeline with no tools, cheapest economy model with a key, cost cap, catch-up when the PC slept) that writes a sourced journal `Alma/Sueños/` (`Alma/Dreams/` in English) and adds, replaces and removes lines of `Recuerdos.md` without review, plus one morning greeting on Telegram, desktop and phone (History scope, one more fixed push text amending 026 BR-27) at the first wake signal; unattended approvals and quiet hours moved to 035; uses 034 when present |
| 034 | [presence-signals](./034-presence-signals/spec.md) | ready, no open questions (Q1-Q11 answered by the owner on 2026-11-09; status set on the owner's relayed instruction while away, he may revert it); plan and tasks written (T0-T15, built before 033): `powerMonitor` resume/unlock, a once-a-minute idle poll and Alma's start in `main`, a new typed message to the coordinator, and a pure once-a-day "back after 4 h or more" wake-signal rule in `shared`, the day starting at 02:00, given only when a consumer can use it; first consumer 033, later 035 |
| 038 | [image-models-create-and-see](./038-image-models-create-and-see/spec.md) | built (T0 to T19 done, spec amendments T26 to T32 done; docs T21 to T25 not ticked yet, i18n audit T33 and test citations T35 pending; the manual walk of the UI T20 and the real-provider check T34 are pending: nothing was rendered or clicked and no real provider was called); ready, all 12 questions resolved on 2026-11-09 (owner's delegation, veto-able): Configuración → Imágenes chooses the provider/model that creates pictures and the one that sees them (today under Casa), and a provider with no model resolves to its newest model able to create or see; 035 to 037 stay reserved for the dream/initiatives/browser plan |

Numbering: next free `NNN`, never reused. A spec that is abandoned stays, with its status line explaining why in §1.
