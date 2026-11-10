# Alma codebase inventory: building blocks for a nightly "sleep/dream" phase, proactive initiatives and a built-in AI browser

Scope: read-only research of the repo at `E:/Tembiapo/Ilist-multiagents` (state of the working tree on 2026-11-08, branch `main`, many uncommitted modifications). Sources are repo files; paths are repo-relative, line numbers where useful. CodeGraph MCP was unavailable (connection closed), so this was done with grep/read.

## 1. Memory and knowledge: vault, embeddings, the "5-layer memory", consolidation/decay

### Takeaway
Memory today is a flat, append/remove-only system: one Markdown file of bullet "memories" (`Alma/Recuerdos.md`, always injected) plus a hybrid BM25 + bge-m3 vector index over the vault, with agent tools to search/read/save/remember/forget. There is **no** consolidation, summarization, decay, expiry or reflection process of any kind; the only "forgetting" is the explicit `forget` tool and an optional thread-retention deletion.

### Cited Findings
- The "five layers" are documented as: always-on core memories, automatic hybrid RAG top-5 per message, search/read/save tools, dedupe before save, incremental indexing — [docs/modules/vault-and-knowledge.md:193](docs/modules/vault-and-knowledge.md). Note these are mechanisms, not tiers of memory (no episodic/semantic split).
- Code lives in `src/coordinator/knowledge/`: `base.ts` (`KnowledgeBase`: scan, watch, index, search, `recall`, memories, `save_knowledge`), `db.ts` (`node:sqlite` + FTS5 + `sqlite-vec`), `embedder.ts`/`embed-worker.ts` (bge-m3 int8 on CPU in a worker thread), `markdown.ts` (chunking), `tools.ts` (the five tools) — [docs/modules/vault-and-knowledge.md:76-84](docs/modules/vault-and-knowledge.md); ADRs [0003](docs/adr/0003-sqlite-fts5-sqlite-vec-index.md), [0004](docs/adr/0004-bge-m3-int8-cpu-worker-thread.md), [0005](docs/adr/0005-hybrid-search-rrf.md), [0006](docs/adr/0006-vault-as-plain-markdown.md).
- Model `Xenova/bge-m3`, int8, CPU, 1024 dims; ~570 MB downloaded on first use into `<userData>/models`; search falls back to keyword-only when the model is not ready — [docs/modules/vault-and-knowledge.md:95,123](docs/modules/vault-and-knowledge.md).
- Index is disposable: `<userData>/knowledge/<sha1-prefix>.db` (SQLite WAL); the Markdown files are the source of truth — [docs/modules/vault-and-knowledge.md:65,122](docs/modules/vault-and-knowledge.md).
- Memory = any bullet line of `Alma/Recuerdos.md`; `remember` adds (3–300 chars), `forget` removes exact/unique-substring match; total cap 4000 chars enforced only by `remember` (`MAX_MEMORY_CHARS = 4000`) — [src/coordinator/knowledge/base.ts:33,390,403](src/coordinator/knowledge/base.ts); [docs/context.md:95-97](docs/context.md).
- Knowledge notes: `save_knowledge` writes `Alma/Conocimientos/<slug>.md` with frontmatter `origen: ia`, `tipo: conocimiento`, `creado`, `actualizado`, `conversacion`; dedupe if cosine ≥ 0.9 among 3 nearest chunks — [docs/modules/vault-and-knowledge.md:108,121,143](docs/modules/vault-and-knowledge.md).
- Automatic recall per run: `recall(request, limit=5)` returns all memories + up to 5 fragments (2/file, similarity ≥ 0.45 with vectors), computed once per run from the last user message — [src/coordinator/knowledge/base.ts:276](src/coordinator/knowledge/base.ts); [src/coordinator/agent.ts:173-190](src/coordinator/agent.ts) (`knowledgeContext`, comment "Layered memory, as in ChatGPT/Letta"); [docs/modules/vault-and-knowledge.md:97,141](docs/modules/vault-and-knowledge.md).
- Knowledge tools risks: `search_knowledge`/`read_note` = `read`; `save_knowledge`/`remember`/`forget` = `memory` (never ask, denied only in read-only mode) — [docs/modules/vault-and-knowledge.md:104-110](docs/modules/vault-and-knowledge.md).
- No decay/consolidation code: grep for `decay|consolid|summar|expire|ttl|prune` in `src/coordinator/knowledge/base.ts` returns nothing; spec 009 (status `implemented`) has no out-of-scope/summarization section — [src/coordinator/knowledge/base.ts](src/coordinator/knowledge/base.ts); [.specify/specs/009-knowledge-and-memory/spec.md:2](.specify/specs/009-knowledge-and-memory/spec.md).
- The only token-saving "compaction" is per-request trimming of old tool results/images (`compactHistory`: keep 600 chars from each end of old tool results, 1500 in the current turn, drop old images); the stored thread is never modified and no summary is produced — [src/coordinator/context.ts:1-48](src/coordinator/context.ts); used at [src/coordinator/agent.ts:252](src/coordinator/agent.ts).
- Thread retention: `privacy.threadRetentionDays` (default 0 = keep) deletes untouched threads; checked at start and every 12 h — [src/coordinator/index.ts:683-690,962-963](src/coordinator/index.ts); default in [src/shared/defaults.ts:125](src/shared/defaults.ts).
- Threads are one JSON file each under `<userData>/threads` (`ThreadStore`) — [src/coordinator/store.ts:14-24](src/coordinator/store.ts).
- Known limits relevant to a dream phase: memory cap not enforced on hand edits ("Uncapped injection"), duplicates slip through during model download, rewriting memories moves bullets/turns `*` into `-`, `Alma/Recuerdos.md` is outside "export my data"/erase — [docs/modules/vault-and-knowledge.md:179-187](docs/modules/vault-and-knowledge.md).
- No wiki links/backlinks/graph (`[[Nota]]` is plain text) — [docs/modules/vault-and-knowledge.md:71,175](docs/modules/vault-and-knowledge.md).
- Privacy: memories and recalled fragments are put in the system prompt and go to the agent's model provider — [docs/modules/vault-and-knowledge.md:153](docs/modules/vault-and-knowledge.md).

### Inferences
- A nightly "dream" job would have raw material in `<userData>/threads/*.json` (all conversations), `Alma/Recuerdos.md`, `Alma/Conocimientos/`, and the audit trail; it would write through the existing `memory`-risk tools (`remember`, `forget`, `save_knowledge`), which need no approval — so consolidation writes would be silent by default unless a spec decides otherwise (Open Question material).
- The 4000-char memory cap and the "only update notes with `origen: ia`" rule are natural guardrails a consolidation pass would rely on; summarizing/merging memories would require a new rewrite operation (today `KnowledgeBase` only adds/removes single lines).
- Re-reading of past threads by a model sends their content to the provider again (R-13), a new privacy flow worth documenting in `docs/security/PRIVACY.md`.

### Gaps
- No existing design of memory tiers (episodic vs semantic), importance scores, timestamps per memory line, or "last used" tracking — memory lines carry no metadata, so decay would need new storage.
- Did not read `base.ts` in full; exact internal API for bulk rewrite of `Recuerdos.md` not verified.

## 2. Scheduling: routines/reminders, background jobs, what runs when closed or asleep

### Takeaway
There is a working in-process scheduler (`RoutineRunner`, 30 s tick) for one-off, daily-at-time (with weekdays) and every-N-minutes routines and reminders; it only runs while the Alma process is alive (tray keeps it alive when the window closes). Nothing runs when Alma is quit or the PC sleeps; missed runs have simple catch-up rules (same-day catch-up for daily, late fire for once, single run for interval). Several other independent 30 s / periodic clocks exist (companies, home rules, camera watches, retention, remote idle sweep).

### Cited Findings
- Two kinds: **reminder** (notify only, no model tokens) and **routine** (agent runs a task alone in a new thread) — [docs/modules/routines.md:7-12](docs/modules/routines.md); glossary [docs/context.md:35-37](docs/context.md).
- Runner: `RoutineRunner`, `TICK_MS = 30_000`, first tick 5 s after start, no overlap per routine, `lastRunAt` set at launch, `running` flags cleared at load, state in `<data>/routines-state.json` — [src/coordinator/routines.ts:8-74](src/coordinator/routines.ts).
- Pure due-time logic in `shared/schedule.ts` (`isDue`, next run, description); tested in `tests/schedule.test.ts` — [docs/modules/routines.md:38,57-63,125](docs/modules/routines.md).
- Launch: `launchRoutine` creates thread "Rutina · name · date" and calls `startRun(thread.id, routine.prompt, { unattended: true })`; on finish/failure sends a `notify` to main — [src/coordinator/index.ts:664-680](src/coordinator/index.ts).
- `unattended` only changes the reply-language rule in the system prompt; it does **not** relax approvals — [src/coordinator/agent.ts:56,130](src/coordinator/agent.ts); [src/coordinator/prompts/system.ts:14](src/coordinator/prompts/system.ts).
- A routine's tools follow the normal approval policy; "An unattended routine can hang forever" waiting for approval with no timeout — [docs/modules/routines.md:70,134](docs/modules/routines.md); [docs/modules/approvals.md:100](docs/modules/approvals.md).
- Background: closing the window keeps Alma in the tray (`background.runInTray`, default on); "Abrir al iniciar Windows (minimizada)" (`background.launchAtLogin`, default off, passes `--hidden`) — [src/shared/defaults.ts:124](src/shared/defaults.ts); [src/main/index.ts:342-348,405-412](src/main/index.ts).
- "If the computer sleeps or Alma is closed nothing fires and the missed-run rules above apply on return" — [docs/modules/routines.md:112](docs/modules/routines.md). Daily: missed slot caught up same day only; once: fires late on first tick; interval: runs once after a long closure — [docs/modules/routines.md:59-61,138](docs/modules/routines.md).
- Agent tools: `create_reminder` (`memory`), `create_routine` (`write`, asks), `list_routines` (`read`), `delete_routine` (`memory`) — [docs/modules/routines.md:78-83](docs/modules/routines.md). No pause/edit tool — [docs/modules/routines.md:135](docs/modules/routines.md).
- Routine results do not reach Telegram (only reminders do) — [docs/modules/routines.md:118,139](docs/modules/routines.md).
- Agents always get local date/time in the system prompt (`environmentBlock(..., localNow())`) — [src/coordinator/agent.ts:130](src/coordinator/agent.ts); [docs/modules/routines.md:44](docs/modules/routines.md).
- Other clocks started at coordinator init: retention every 12 h, MCP sync, vault sync, Telegram, voice, WhatsApp, `companies.start()` (engine tick 30 s, ADR 0015), `home.start()` (judgment rules, camera watches resume 5 s after start) — [src/coordinator/index.ts:950-975](src/coordinator/index.ts); [docs/adr/0015-companies-task-driven-wakeups.md](docs/adr/0015-companies-task-driven-wakeups.md); [docs/modules/home.md:141-143](docs/modules/home.md). Remote device idle sweep hourly — [src/coordinator/channels/remote/channel.ts:384](src/coordinator/channels/remote/channel.ts).
- Companies already embody a "sleep and wake only for a concrete trigger" pattern (task assigned, review, per-position weekday routine default 09:00, meeting prep N hours before) to bound cost — [docs/adr/0015-companies-task-driven-wakeups.md](docs/adr/0015-companies-task-driven-wakeups.md); [docs/modules/companies.md:9,31](docs/modules/companies.md).

### Inferences
- A nightly dream phase could be implemented as a built-in routine kind (reusing `shared/schedule.ts` daily schedule + `RoutineRunner`), but "nightly" collides with "PC asleep / Alma closed": with current semantics a daily slot missed overnight is only caught up the same calendar day, so a 03:00 dream that the PC slept through would run on wake only if it is still that day. A "run on next wake/idle" rule does not exist.
- No power-save blocker or wake-timer is used, so Alma cannot wake the PC to dream (inference from absence of `powerSaveBlocker`/`powerMonitor` in `src/`).

### Gaps
- `shared/schedule.ts` was not read line by line; exact catch-up semantics taken from docs.
- No evidence of any job queue/persistence beyond `routines-state.json` and company JSON.

## 3. Channels to reach the user proactively (unsolicited messages)

### Takeaway
The coordinator can already push unsolicited content to the owner via: desktop notifications + in-app alert (`notify` message to main), Telegram (`telegram.notify`/`notifyPhoto`, and the agent tool `send_telegram`, risk `memory` = no approval), and voice TTS (`voice.say`). WhatsApp self-chat and the phone PWA have **no** unsolicited-message path today (the PWA gets only content-free approval pushes; `send_whatsapp` is for other contacts and is `publish`).

### Cited Findings
- Desktop: coordinator sends `{type:'notify', title, body, threadId?, always?}` to main; main's `notify()` shows an Electron `Notification` (suppressed if window focused unless `always`), and with `always` also an in-app alert (`app:reminder`) + `flashFrame`; click opens the thread — [src/main/index.ts:164-178,296-297](src/main/index.ts).
- Notice texts are pure functions per language (`reminderNotice`, `routineNotice`, `ruleFailedNotice`, `watch*Notice`, `companyNotice`) — [src/coordinator/notices.ts](src/coordinator/notices.ts).
- Telegram: `notify(text)` sends to the bound `chatId` (split at 4096) and returns false if not connected/bound; `notifyPhoto(jpeg, caption)` — [src/coordinator/channels/telegram.ts:166-180](src/coordinator/channels/telegram.ts).
- `deliverReminder` = desktop notify (always) + Telegram `⏰ <message>`; `notifyHome` = desktop + Telegram (with photo) — [src/coordinator/index.ts:293-296,506-512](src/coordinator/index.ts).
- `send_telegram` tool: risk `memory`, no approval (only read-only mode blocks it), text 1–20 000 chars and/or one image, also offered to company agents, `standalone` — [docs/modules/telegram.md:78-84](docs/modules/telegram.md); listed under `memory` in [docs/modules/approvals.md:79](docs/modules/approvals.md). Injected via `ToolContext.sendTelegram` / `sendTelegramPhoto` — [src/coordinator/tools/types.ts:42,52](src/coordinator/tools/types.ts); [src/coordinator/index.ts:248,255](src/coordinator/index.ts).
- Telegram is long-polling with `drop_pending_updates: true` (messages sent while Alma was closed are lost) and talks to one bound private chat only — [src/coordinator/channels/telegram.ts:151](src/coordinator/channels/telegram.ts); [docs/modules/telegram.md:15,109](docs/modules/telegram.md); [docs/adr/0009-telegram-long-polling-in-app.md](docs/adr/0009-telegram-long-polling-in-app.md).
- Company notices (budget, stuck, delivery, meeting) also go to Telegram "even if you did not ask for them" — [docs/modules/companies.md:141,171](docs/modules/companies.md).
- Voice: `VoiceAssistant.say(text)` exists, reachable via the `voice.say` request (renderer→coordinator, "Speaks a text") — [src/coordinator/voice/assistant.ts:450](src/coordinator/voice/assistant.ts); [src/coordinator/index.ts:923-924](src/coordinator/index.ts); [docs/references/ipc-messages.md:171](docs/references/ipc-messages.md). The main window uses `backgroundThrottling: false` so voice keeps working while hidden in the tray — [src/main/index.ts:335-336](src/main/index.ts).
- WhatsApp: Alma answers only in the owner's self chat («Mensajes para mí»); `send_whatsapp` sends to contacts, risk `publish`, always asks — [docs/modules/whatsapp.md:8-11,62](docs/modules/whatsapp.md); glossary "Self chat" [docs/context.md:145-147](docs/context.md).
- Phone PWA (spec 026/028): push is content-free and only for pending approvals ("Tenés una aprobación pendiente"); push hosts are allow-listed — [docs/modules/remote-access.md:12,63](docs/modules/remote-access.md); [src/shared/remote/push.ts:1-30](src/shared/remote/push.ts).

### Inferences
- The cheapest proactive surface is Telegram + desktop notify; both are already wired and unapproved. A "morning brief" could be a routine whose agent calls `send_telegram` — feasible today without new code except routine results not being forwarded automatically.
- Because `send_telegram` is `memory` (no approval), a proactive engine that lets agents message the owner would not hit approvals; whether that is acceptable for *initiatives* (vs. answers) is an Open Question for the spec, not something to infer.
- Writing unsolicited text into the WhatsApp self chat would need a new channel method (not present) and touches R-05 (Baileys ToS).
- A proactive push to the phone PWA would change PD-15's "push carries no content" stance only if content were included; a content-free "Alma has something for you" push would fit the existing design.

### Gaps
- Did not verify whether `voice.say` can be triggered by the coordinator itself without a renderer request (it is a request handler; an internal call is plausible but untested).
- No rate-limit/quiet-hours logic found for any channel.

## 4. Presence / wake signals

### Takeaway
There is effectively **no** user-presence detection: no Electron `powerMonitor` (lock/unlock, suspend/resume, idle time), no "first message of the day" logic, and Home Assistant integration does not surface `person`/`device_tracker`/presence entities as things. The only "wake" concepts are the voice wake word and the company engine's task-driven wake-ups.

### Cited Findings
- Grep for `powerMonitor|lock-screen|unlock-screen|getSystemIdle|suspend|resume|idle` across `src/` finds no OS-presence code; hits are unrelated (embedder state `'idle'`, remote pairing state machine, remote device idle expiry of 15 days, voice wake-word) — [src/coordinator/channels/remote/store.ts:59-69](src/coordinator/channels/remote/store.ts); [src/coordinator/voice/assistant.ts:102](src/coordinator/voice/assistant.ts).
- Voice wake word "Ey Alma" (model `hola_alma`) with optional speaker check — [docs/context.md:179-181](docs/context.md); [docs/modules/voice.md:55-65](docs/modules/voice.md).
- Voice conversation thread idle > 1 h is replaced by a new one — [docs/context.md:175-177](docs/context.md).
- Home: device domains Alma models are `light, switch, input_boolean, camera, media_player, cover, fan, climate, humidifier, water_heater, lock, alarm_control_panel, siren, valve, vacuum, lawn_mower`; everything else is a sensor of some device — [src/shared/home.ts:38-58](src/shared/home.ts). `person`, `device_tracker`, `zone` are not handled (grep finds no references in `src/coordinator/home` or `src/shared/home.ts`).
- Judgment rules (`triggers.ts`) fire on any entity state change matching `to`, a time window and a cooldown, waking an agent in a new thread "Casa · <rule> · <date>"; `camera_look` auto-approved; nothing fires when Alma is closed — [docs/modules/home.md:143](docs/modules/home.md); [src/coordinator/index.ts:515-525](src/coordinator/index.ts); glossary [docs/context.md:305-307](docs/context.md).
- House "modes" (HA scenes such as "Noche", "Me fui", "Cine") exist and are activated by tools — [docs/context.md:301-303](docs/context.md).
- Camera watch: time-limited vision polling (≥10 s, 1–360 min) that notifies on a match — [docs/context.md:309-311](docs/context.md); [docs/modules/home.md:141](docs/modules/home.md).
- HA engine runs in hidden WSL2 distro `alma-home`, recorder purge 7 days — [docs/modules/home.md:11,103](docs/modules/home.md); [docs/adr/0007-home-assistant-in-hidden-wsl2.md](docs/adr/0007-home-assistant-in-hidden-wsl2.md).
- Remote phone devices track `lastSeen` (used for 15-day expiry), not user presence — [src/coordinator/channels/remote/store.ts:59-69](src/coordinator/channels/remote/store.ts).

### Inferences
- Presence signals for proactive timing would be new: Electron `powerMonitor` events (`lock-screen`, `unlock-screen`, `suspend`, `resume`, `getSystemIdleTime`) can only be used in `main` (layer rule: `electron` only in `main/` and `coordinator/index.ts`), so they would travel to the coordinator as a new typed message.
- A judgment rule can already watch a HA sensor (e.g., a motion `binary_sensor`) if the user has one attached to a device — but HA `person`/`device_tracker` entities would likely be filtered out of the snapshot since they are not in `DEVICE_DOMAINS` (inference; triggers.ts not read in full).
- "First user message of the day" could be derived in the coordinator from `ThreadStore` timestamps (`ts` on messages) without new storage.

### Gaps
- Did not read `src/coordinator/home/triggers.ts` to confirm whether rules can target non-device entities like `person.*`.

## 5. Approvals and risk: how a proactive action would pass

### Takeaway
Every tool declares `ToolRisk = read | write | exec | memory | publish | home`. `read`, `memory` and `home` never ask (except read-only mode); `write`/`exec` depend on the approval mode; `publish` always asks the person on every call, never "always allow", with boss review first inside a company. Unattended runs (routines, home rules, company wake-ups) use exactly the same policy and simply wait indefinitely for an answer.

### Cited Findings
- `ToolRisk` definition and semantics (memory: "written without asking, blocked only in read-only mode"; publish: "the user approves every single call") — [src/coordinator/tools/types.ts:10-16](src/coordinator/tools/types.ts); constitution Clause V [.specify/memory/constitution.md:153-157](.specify/memory/constitution.md).
- Decision order in `authorize` (read → blocked → memory/home → publish (boss then person) → agent autoApprove → alwaysAllowTools → mode) — [docs/modules/approvals.md:39-47](docs/modules/approvals.md); code in `src/coordinator/approval.ts` (`ApprovalBroker`, `authorize`, `autoReview`, `bossReview`) — [docs/modules/approvals.md:37](docs/modules/approvals.md).
- Risk matrix by mode — [docs/modules/approvals.md:53-60](docs/modules/approvals.md). Modes: `needs-approval` (default), `auto-review`, `always-allow`, `blocked` — [docs/modules/approvals.md:20-25](docs/modules/approvals.md).
- Tools per risk (e.g., `publish`: `instagram_publish`, `email_send`, `send_whatsapp`, `home_secure_control`; `memory` includes `send_telegram`, `create_reminder`, `delete_routine`, `remember`) — [docs/modules/approvals.md:74-81](docs/modules/approvals.md). Glossary adds that `publish` also covers a model creating/changing autonomous agents (spec 029) — [docs/context.md:31-33](docs/context.md).
- MCP tools are classified `exec` by the agent loop — [docs/modules/approvals.md:68](docs/modules/approvals.md); [docs/modules/mcp.md:70-74](docs/modules/mcp.md).
- No timeout on pending approvals; pending approvals live in memory and are lost on restart — [docs/modules/approvals.md:94,100,127](docs/modules/approvals.md).
- Approvals can be answered from the app, Telegram buttons (`ap:<id>:allow|always|deny`, only for Telegram-conversation runs), voice yes/no, WhatsApp text, paired phone — [docs/modules/approvals.md:13,32-33,115-116](docs/modules/approvals.md); [docs/modules/telegram.md:72](docs/modules/telegram.md) ("approvals for desktop chats, routines and companies never go to Telegram").
- Run-level auto-approve exists: `startRun(..., { autoApprove: [...] })`, used by home judgment rules for `camera_look` because "the user approved this rule's instructions when it was made" — [src/coordinator/index.ts:207,523-524](src/coordinator/index.ts).
- `create_routine` is `write` because "it sets up a task that later runs unattended"; rationale for `create_reminder`/`delete_routine` being `memory` "not documented" — [docs/modules/routines.md:116,143](docs/modules/routines.md).
- Companies: boss review of `publish`, monthly USD budget per company/member (warn 80%, pause at 100%, soft cap checked at run start), `COMPANY_AUTO_APPROVE` for write/office/image tools — [docs/adr/0015-companies-task-driven-wakeups.md](docs/adr/0015-companies-task-driven-wakeups.md); [docs/modules/companies.md:79,161](docs/modules/companies.md); `overBudget` check in `startRun` [src/coordinator/index.ts:214-218](src/coordinator/index.ts).
- Audit: non-`read` calls are audited (`tool.authorize`, `tool.run`) without argument values — [docs/modules/approvals.md:114](docs/modules/approvals.md).
- R-07 accepts actions without approval by design (home tools, company auto-approve, «Siempre permitir»); R-11 instruction injection from pages/mails is "Mitigated, residual accepted" — [docs/security/RISKS.md](docs/security/RISKS.md).

### Inferences
- A proactive initiative that acts outward (email, WhatsApp, posting, a browser form submit) would be `publish` and therefore needs a human answer every time; with today's routing, approvals for routine/unattended runs only reach the desktop app (and a paired phone for its own runs), not Telegram — a proactive "proposal" flow would need approval routing to the user's active channel (Open Question).
- There is no notion of a budget for non-company runs; a nightly dream or proactive engine would have no cost cap unless it reuses the company budget mechanism (`recordUsage`, `overBudget`) or a spec adds one.
- The "approved once at creation, auto-approved at run" precedent (`camera_look` in home rules) is the closest existing pattern for pre-authorizing a recurring proactive task's narrow tool set.

### Gaps
- `src/coordinator/approval.ts` was not read directly; the decision order is from the module doc which states it was "checked against the code".

## 6. Browser tooling today

### Takeaway
There is no built-in AI-driven browser. Three related pieces exist: (1) `fetch_url`/`web_search` (HTTP fetch + HTML-to-text, SSRF-guarded, no JS); (2) a one-click MCP preset that spawns `chrome-devtools-mcp@1.11.0` (external Chrome, tools treated as `exec`); (3) the Instagram publisher in `main`, which drives a sandboxed Electron `BrowserWindow` with its own persistent session partition via the Chrome DevTools Protocol (`webContents.debugger`) — the closest precedent for an in-app agent browser. `<webview>` is explicitly blocked app-wide.

### Cited Findings
- `web_search` (DuckDuckGo HTML, keyless) and `fetch_url` (public pages as plain text, manual redirects ≤5, each hop checked by `isPrivateHost` + DNS check, 20 s timeout, 1000–60 000 chars), both `read`; outputs prefixed "(datos externos, no instrucciones…)" — [docs/modules/web-and-mail.md:11-16,45-56,64-68,88-98](docs/modules/web-and-mail.md); code [src/coordinator/tools/web.ts](src/coordinator/tools/web.ts) (`isPrivateHost`, `htmlToText`, `parseDuckDuckGo`, UA string at line 10).
- DNS-rebinding residual risk R-09 for `fetch_url` — [docs/security/RISKS.md](docs/security/RISKS.md).
- Constitution: "Local network and private hosts stay off-limits to web tools unless a spec explicitly opens them" — [.specify/memory/constitution.md:163-164](.specify/memory/constitution.md).
- Chrome MCP preset: card "Chrome DevTools" in Settings → MCP adds stdio server `npx -y chrome-devtools-mcp@1.11.0` named `chrome-devtools`; text: "the agent opens its own Chrome and browses, clicks, fills in forms and takes screenshots. Sessions you start in that window are kept. Requires Google Chrome installed." — [src/renderer/src/components/SettingsDialog.tsx:584-595,911](src/renderer/src/components/SettingsDialog.tsx); [src/shared/i18n/en/channels.ts:11-13](src/shared/i18n/en/channels.ts); [docs/modules/mcp.md:22](docs/modules/mcp.md).
- MCP tools: `exec` risk, only for agent profiles with `allowMcp`, adding/changing a stdio server requires native confirmation (`main/guard.ts` `newCommands`), no auto-reconnect, no OAuth — [docs/modules/mcp.md:7-14,28,46-53,61,70-74](docs/modules/mcp.md); `McpManager` in [src/coordinator/mcp.ts](src/coordinator/mcp.ts).
- Instagram in-app browser: partition `persist:instagram`, UA stripped of `Alma`/`Electron` tokens, `BrowserWindow` with `contextIsolation: true, sandbox: true, nodeIntegration: false`, CDP via `win.webContents.debugger.attach('1.3')`, a `PageDriver` that injects read-only DOM helpers and clicks via CDP input; visible window; on failure stays open for manual completion — [src/main/instagram.ts:1-40,68,231-250](src/main/instagram.ts); ADR [docs/adr/0011-instagram-in-app-browser-session.md](docs/adr/0011-instagram-in-app-browser-session.md) ("needs a display and the main window, so it cannot run headless").
- Coordinator reaches main-only capabilities through `Host.request(HostRequest)`; current actions: `instagram.publish`, `image.render`, `trash`, `secret.seal/open`, `remote.confirm`, `remote.open` — [src/shared/types.ts:820-832](src/shared/types.ts); [src/coordinator/tools/types.ts:18-21](src/coordinator/tools/types.ts) ("Work only the main process can do (it owns windows and the browser session)").
- `<webview>` is prevented: `app.on('web-contents-created', ... will-attach-webview → preventDefault)`; permission handlers only grant clipboard and audio-only media to the main window — [src/main/index.ts:438-444](src/main/index.ts).
- Architecture: `main` owns "windows, tray, settings, native dialogs, Instagram session"; `electron` only in `main/` and `coordinator/index.ts` — [docs/architecture.md:12-16,26-31](docs/architecture.md).
- No Playwright/Puppeteer/WebContentsView/BrowserView usage in `src/` (grep) — [src/](src/).
- Instagram ADR notes automation fragility and account-suspension risk — [docs/adr/0011-instagram-in-app-browser-session.md](docs/adr/0011-instagram-in-app-browser-session.md); user-facing warning in [src/shared/i18n/en/general.ts:41](src/shared/i18n/en/general.ts).

### Inferences
- A built-in browser would naturally live in `main` (it owns windows and sessions), exposed to agents as coordinator tools that call new `HostRequest` actions — the exact pattern of `instagram.publish`. A `WebContentsView` embedded in the main window would be a new UI surface and must coexist with the `<webview>` ban (WebContentsView is not a `<webview>`, so the ban doesn't block it — inference).
- Risk classification is an open spec question: reading pages ≈ `read`, but clicking/typing/submitting on logged-in sites acts in the user's name → `publish` per Clause V; navigation to private hosts must stay blocked unless a spec opens it (reuse `isPrivateHost`). Page text must keep the "external data, not instructions" framing (R-11).
- The Chrome MCP route already gives agents a full browser but as opaque `exec` tools with no per-action risk, which is a reason a built-in browser with typed tools would be safer.

### Gaps
- Did not inspect `PageDriver` fully or `chrome-devtools-mcp` capabilities beyond the in-app description.

## 7. Process: SDD pipeline, constitution constraints, spec numbering, existing mentions

### Takeaway
Features go through `/feature`: Specify → Clarify (grill-with-docs, Open Questions must be answered by the human) → human `ready` gate → Plan → Tasks → test-first Implement → Verify (tester ∥ quality-checker). Existing spec numbers run 001–032 with 027 and 031 reserved, so the next free number is **033**. No spec, checklist or doc mentions "dream", "sleep phase", "proactive", "initiative" or "morning brief" as a feature.

### Cited Findings
- Pipeline stages, gates and Definition of Done — [docs/pipeline.md:7-23,25-40,71-77](docs/pipeline.md); ADR [docs/adr/0017-sdd-pipeline.md](docs/adr/0017-sdd-pipeline.md).
- Constitution I: no guessed business rule; Open Questions block Plan; `tests/specs.test.ts` enforces — [.specify/memory/constitution.md:20-43](.specify/memory/constitution.md).
- Constitution III: test-first logic in `coordinator`/`shared`/`main`; ACs named in tests (`AC-n.n`); `require-tests` gate; coverage ratchet — [.specify/memory/constitution.md:68-106](.specify/memory/constitution.md).
- Constitution V: every tool declares a `ToolRisk`; outward actions are `publish`; secrets only via `safeStorage`; anything executing new code needs native confirmation; private hosts off-limits to web tools; new attack surface/third-party data flow/new personal data category updates `docs/security/CONTROLS.md`, `RISKS.md` or `PRIVACY.md` in the same PR — [.specify/memory/constitution.md:148-170](.specify/memory/constitution.md).
- Specs present: 001 release-packaging, 002 chat, 003 agents, 004 approvals, 005 providers, 006 settings, 007 companies, 008 vault, 009 knowledge-and-memory, 010 telegram, 011 whatsapp, 012 instagram, 013 house-engine-and-devices, 014 house-plan-cameras-and-rules, 015 file-and-command-tools, 016 web-and-mail, 017 mcp, 018 routines-and-reminders, 019 voice, 020 images, 021 office-documents-and-drawings, 022 security-and-privacy, 023 app-shell-and-ui, 024 voice-control-models-and-meta, 025 i18n-es-en, 026 remote-access, 028 remote-vault-and-threads, 029 alma-creates-companies, 030 chat-attachments, 032 remote-home-modes-and-lights — [.specify/specs/README.md:16-52](.specify/specs/README.md) and directory listing of `.specify/specs/`.
- 027 reserved for the relay, 031 reserved for phone attachments; "Numbering: next free NNN, never reused" — [.specify/specs/README.md:49-54](.specify/specs/README.md).
- In-progress: 001 draft, 026 ready, 028 ready, 029/030/032 draft — [.specify/specs/README.md:43-52](.specify/specs/README.md).
- Grep for `dream|sueñ|proactiv|initiative|morning brief|brief` in `.specify` and `docs` only hits unrelated uses of "brief" (answer briefly on Telegram/WhatsApp/remote; "company brief" in 029; "design brief" in 026) — [.specify/specs/010-telegram/spec.md:89](.specify/specs/010-telegram/spec.md), [.specify/specs/011-whatsapp/spec.md:77](.specify/specs/011-whatsapp/spec.md), [.specify/specs/026-remote-access/spec.md:8](.specify/specs/026-remote-access/spec.md), [.specify/specs/029-alma-creates-companies/spec.md:116,140](.specify/specs/029-alma-creates-companies/spec.md).
- Repo root also has `CHECKLIST-028-remote-notes-and-threads.md` (spec 028 related, not relevant here) — repo root listing.
- Project rules: pnpm only; commits `type(area): summary`, no Claude Co-Authored-By; UI work loads `console-ui` and `umbra-ui` skills; user-facing text via `src/shared/i18n` es/en dictionaries — [CLAUDE.md](CLAUDE.md).

### Inferences
- The three ideas (dream phase, proactive initiatives, built-in browser) each change user-visible behavior and add risk/data flows, so each is a *Feature* (full spec) per [docs/pipeline.md:44-50](docs/pipeline.md); they would likely be specs 033, 034, 035 (or one umbrella spec), each requiring `docs/security/` updates.
- Glossary already forbids "cron job", "schedule", "alarm" as names for routines ([docs/context.md:35-37](docs/context.md)); new terms (e.g., "dream", "initiative") must be added to `docs/context.md` during Clarify.

### Gaps
- None material; spec contents beyond 004/009/018 statuses were not read in depth.

## 8. Architecture layers: where new pieces would live

### Takeaway
Strict layering (`shared` leaf; `renderer`, `main`, `coordinator` never import sideways; `electron` only in `main/` and `coordinator/index.ts`) enforced by `tests/architecture.test.ts`. Schedulers, agents, channels, knowledge and tools live in `coordinator`; OS signals, windows and browser sessions live in `main`; pure rules go in `shared` with tests.

### Cited Findings
- Process/layer diagram and ownership table — [docs/architecture.md:5-34](docs/architecture.md); constitution IV [.specify/memory/constitution.md:112-146](.specify/memory/constitution.md).
- "Where new things go": tool → `src/coordinator/tools/<name>.ts` exporting `ToolDefinition` (name, `risk`, Zod schema, `run`) registered in `tools/index.ts` or `agent.ts`; channel → `src/coordinator/channels/`; setting → `shared/types` + `shared/defaults` + `main/settings.ts` + `SettingsDialog` (+ native confirmation if it runs new code); screen → `src/renderer/src/<area>/`; business rule → pure function in `shared/` — [docs/architecture.md:54-64](docs/architecture.md).
- Functional core / imperative shell; dependency injection via `ToolContext`/`Host`; Zod at the edges; strategies for providers/channels — [docs/architecture.md:42-50](docs/architecture.md).
- `ToolContext` already injects `knowledge`, `saveRoutines`, `sendTelegram`, `sendTelegramPhoto`, `home`, `whatsapp`, `company`, `host`, `signal` — [src/coordinator/tools/types.ts:26-58](src/coordinator/tools/types.ts).
- Coordinator is an Electron `utilityProcess` started by main; settings live in main and are pushed to the coordinator; coordinator patches via `settings.patch` — [docs/architecture.md:17-22](docs/architecture.md); [src/coordinator/index.ts:276-279](src/coordinator/index.ts); ADR [docs/adr/0001-coordinator-as-utility-process.md](docs/adr/0001-coordinator-as-utility-process.md).
- `startRun(threadId, text, { noAsk, autoApprove, unattended })` is the single entry to launch any agent run (used by routines, home rules, companies, channels, remote) — [src/coordinator/index.ts:206-271](src/coordinator/index.ts).

### Inferences
- Dream/consolidation engine: `src/coordinator/` (e.g., beside `routines.ts`), reusing `startRun` with `unattended: true` and `KnowledgeBase`; pure selection/scoring rules (what to consolidate, when it is "night", quiet hours) in `src/shared/` with tests.
- Proactive initiatives: decision logic pure in `shared/`; delivery via existing `notify` + `telegram.notify`; presence signals from `main` (`powerMonitor`) as a new typed main→coordinator message.
- Built-in browser: window/session/CDP in `src/main/` (like `instagram.ts`), new `HostRequest` actions in `shared/types.ts`, agent tools in `src/coordinator/tools/`, UI (if a visible pane) in `src/renderer/src/<area>/`.

### Gaps
- Did not read `tests/support/arch.ts` `RULES` list to confirm every rule (e.g., whether a new `main` module may import a specific shared module).
