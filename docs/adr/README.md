# Architecture Decision Records

Decisions the code already embodies and that would be costly to reverse. Format: [ADR-FORMAT.md](../../.claude/skills/domain-modeling/ADR-FORMAT.md). Numbering is sequential and never reused.

Rules for reading them:

- Status `accepted` means the decision is in the code today.
- Where no document explains why, the ADR says `Rationale not documented` and, if useful, an inference labeled as such.
- "Alternatives: not documented" means no source names a rejected option; none were invented.
- Sources are the design notes (the maintainer's recorded rationale), [HOME-AUTOMATION-PLAN.md](../HOME-AUTOMATION-PLAN.md), the constitution, `docs/security/*` and the specs.

| # | Decision | Status |
|---|---|---|
| [0001](0001-coordinator-as-utility-process.md) | Coordinator runs as an Electron `utilityProcess`, separate from main | accepted |
| [0002](0002-layer-rules-enforced-by-test.md) | Layer rules are enforced by a test, not by convention | accepted |
| [0003](0003-sqlite-fts5-sqlite-vec-index.md) | Knowledge index: `node:sqlite` + FTS5 + `sqlite-vec`, one disposable file per vault | accepted |
| [0004](0004-bge-m3-int8-cpu-worker-thread.md) | Embeddings: bge-m3 int8 on CPU in a worker thread | accepted |
| [0005](0005-hybrid-search-rrf.md) | Hybrid search: BM25 + vectors fused with RRF | accepted |
| [0006](0006-vault-as-plain-markdown.md) | Vault is plain `.md` files | accepted |
| [0007](0007-home-assistant-in-hidden-wsl2.md) | Home Assistant in a hidden WSL2 distro plus Alma's own 2D plan | accepted |
| [0008](0008-voice-in-js-on-onnxruntime.md) | Voice assistant in JavaScript on onnxruntime, no Python | accepted |
| [0009](0009-telegram-long-polling-in-app.md) | Telegram via long polling (grammy) inside the app | accepted |
| [0010](0010-whatsapp-via-baileys.md) | WhatsApp via Baileys (unofficial protocol) on the person's own number | accepted |
| [0011](0011-instagram-in-app-browser-session.md) | Instagram publishing through an in-app browser session, approval mandatory | accepted |
| [0012](0012-approval-model.md) | Approval model: `ToolRisk` classes, four modes, auto-review, `publish` always asks | accepted |
| [0013](0013-secrets-with-safestorage.md) | Secrets sealed with `safeStorage` | accepted |
| [0014](0014-pnpm-as-package-manager.md) | pnpm is the package manager; never npm | accepted |
| [0015](0015-companies-task-driven-wakeups.md) | Companies: agent teams that wake only for concrete triggers | accepted |
| [0016](0016-biome-lint-only-no-formatter.md) | Biome lint only, no formatter yet | accepted |
| [0017](0017-sdd-pipeline.md) | SDD pipeline | accepted |
| [0018](0018-typed-dictionaries-no-i18n-library.md) | Typed Spanish/English dictionaries in `src/shared`, no i18n library (spec 025) | accepted |
| [0019](0019-names-follow-language-existing-wins.md) | Names Alma writes follow the language; an existing name always wins (spec 025) | accepted |
| [0020](0020-remote-access-one-security-layer-transport-strategy.md) | Remote access: one security layer, the transport is a strategy (spec 026) | accepted |
| [0021](0021-remote-access-tailscale-pwa.md) | Remote access: Tailscale transport, installed PWA, paired phones (specs 026, 028) | accepted |

Candidates not written because no evidence supports them as separate decisions: the choice of Electron itself, and the choice of React/CodeMirror (the design note covers CodeMirror only as part of the vault editor, in [0006](0006-vault-as-plain-markdown.md)).
