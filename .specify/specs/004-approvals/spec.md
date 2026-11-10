---
status: implemented
---

# 004 — Aprobaciones

## 1. Summary
Before an agent's tool call runs, Alma decides whether the person must say yes first. The decision depends on the tool's declared risk (`read`, `write`, `exec`, `memory`, `publish`, `home`) and on one of four approval modes the person picks: "Pedir aprobación" (ask), "Auto-review" (a reviewer model judges each action), "Permitir todo" (allow all) and "Solo lectura" (read-only). The person can also mark tools as "Siempre permitir", or let a single agent run chosen tools without asking. Anything that acts outward in the person's name (`publish`) always asks, whatever the mode. Pending approvals appear as cards in the chat and can be answered from Telegram buttons, by voice, or (WhatsApp, owned by 011) by text.

## 2. Problem and goal
Agents can write files, run PowerShell, send mail and move locks. The person needs to stay in control without being asked about every harmless read. Done means: reads never ask, writes and commands ask according to a mode the person can see and change at any time, outward actions always ask, and a pending question can be answered from wherever the person is (the app, the phone, out loud) and dies cleanly when the run is cancelled.

## 3. Scope
**In:** `authorize()` policy per mode and risk; per-tool "Siempre permitir" and per-agent auto-approve; the auto-review verdict flow; the boss review of outgoing actions in a company; the approval broker (pending list, respond, abort); approval cards, status texts, sidebar markers and the "Aprobaciones" settings tab in the UI; answering from Telegram buttons and by voice; the tool-state and audit trail that approvals leave.
**Out (and why):**
- How Telegram, WhatsApp and voice conversations work as channels: `../010-telegram/spec.md`, `../011-whatsapp/spec.md`, `../019-voice/spec.md`. Only the approval side is here.
- The native confirmation dialog when switching to "Permitir todo", and the audit log format: `../022-security-and-privacy/spec.md`.
- What each tool does once approved: `../015-file-and-command-tools/spec.md`, `../016-web-and-mail/spec.md`, `../013-house-engine-and-devices/spec.md`.
- Company org chart and tasks: `../007-companies/spec.md` (only the boss-review step of `publish` is here).
- Provider implementation of the reviewer call: `../005-providers/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want reads to never ask me anything, so that agents can look around freely.
- **US-2** As a person, I want to choose how much Alma asks before writing files or running commands (ask / auto-review / allow all / read-only), so that I match the risk to the folder I am working in.
- **US-3** As a person, I want to see exactly what an agent wants to do and answer Permitir / Siempre permitir / Rechazar, so that I decide with the real input in front of me.
- **US-4** As a person, I want a reviewer model to wave through safe actions and only interrupt me for risky ones, so that I am not asked for every edit.
- **US-5** As a person, I want actions that act in my name outside the computer (posting, sending mail or WhatsApp, unlocking a door) to always ask me, whatever mode I am in.
- **US-6** As a person, I want to review and revoke "Siempre permitir" rules, and to let one agent skip approval for specific tools, so that trust is granular and reversible.
- **US-7** As a person away from the desk, I want to answer an approval from Telegram buttons or by saying yes or no, so that a run is not stuck waiting for me.
- **US-8** As a person, I want cancelling a run to cancel its pending approvals, so that nothing runs later by accident.
- **US-9** As a company boss agent, I want to review what my reports send out before it reaches the person, so that the person only sees worthwhile outgoing actions.

## 5. Acceptance criteria

### Policy by risk and mode
- **AC-1.1** (US-1) Given any approval mode (including read-only), when an agent calls a `read` tool such as `list_dir`, then it runs with no approval request. Test: tests/agent.test.ts › "never asks for read-only tools and blocks writes in read-only mode"
- **AC-1.2** (US-1) Given a `read` tool call, when it is authorized, then the tool state note is "Solo lectura". [gap]
- **AC-2.1** (US-2) Given mode "Pedir aprobación" (`needs-approval`, the default), when an agent calls a `write` or `exec` tool, then an approval request is emitted, the tool state is `pending-approval`, and the tool runs only after the person answers Permitir. Test: tests/agent.test.ts › "asks for approval, runs the tool and feeds the result back"
- **AC-2.2** (US-2) Given mode "Permitir todo" (`always-allow`), when an agent calls a `write` or `exec` tool, then it runs with note "Modo «siempre permitir»" and no request is emitted. [gap]
- **AC-2.3** (US-2) Given mode "Solo lectura" (`blocked`), when an agent calls a `write` tool, then it is not run, its state is `denied` with note "Bloqueado por el modo de aprobación", and no approval request is emitted. Test: tests/agent.test.ts › "never asks for read-only tools and blocks writes in read-only mode"
- **AC-2.4** (US-2) Given mode "Solo lectura", when an agent calls an `exec` tool (including an MCP tool), a `memory` tool (`remember`, `save_knowledge`) or a `home` tool (`home_control`), then each is denied with the same note. [gap]
- **AC-2.5** (US-2) Given mode "Solo lectura", when an agent calls a `publish` tool, then it is denied without asking. Test: tests/agent.test.ts › "blocks publishing in read-only mode"
- **AC-2.6** (US-2) Given any mode except "Solo lectura", when an agent calls a `memory` tool, then it runs with note "Memoria de Alma" and never asks; likewise a `home` tool runs with note "Control de la casa". [gap]
- **AC-2.7** (US-2) Given the person changes the approval mode while a run is in progress, when the next tool call is authorized, then the new mode applies (settings are read live per call, and again right before `run`). [gap]
- **AC-2.8** (US-2) Given a built-in tool call that is not `standalone` and a thread with no working folder, when the tool is called, then no approval is requested; the tool fails with "No hay carpeta de trabajo seleccionada…" instead. Test: tests/agent.test.ts › "does not ask for approval when there is no workspace"
- **AC-2.9** (US-2) Given a tool the agent is not offered, or whose input fails its schema, when it is called, then no approval is requested and an error result goes back to the model. Test: tests/agent.test.ts › "rejects invalid tool input without running it"
- **AC-2.10** (US-2) Given a tool that is not a built-in (an MCP tool), when it is authorized, then it is treated as `exec`. [gap]

### Approval card and answers
- **AC-3.1** (US-3) Given a pending approval, when the person answers Rechazar, then the tool does not run, its state is `denied` with note "Rechazado por vos", and the model receives an error result saying it was not executed and not to retry the same action. Test: tests/agent.test.ts › "returns an error result when the user denies"
- **AC-3.2** (US-3) Given a pending approval, when the person answers Permitir, then the tool runs and its state note is "Aprobado por vos". Test: tests/agent.test.ts › "asks for approval, runs the tool and feeds the result back"
- **AC-3.3** (US-3) Given a pending approval of a tool that has a preview (for example `instagram_publish`), when the card is shown, then it carries the preview (image, caption, note) so the person approves the actual post; a preview that throws is silently dropped. Test: tests/agent.test.ts › "always asks before publishing, even when everything else is allowed"
- **AC-3.4** (US-3) [manual] A pending approval shows in the tool card in the chat: a warning icon, the title "¿Permitir esta acción?", the reason if any, the tool input (command, file path and content, a diff for `edit_file`, or the post preview) and the buttons "Permitir" (labelled "Publicar" for `instagram_publish`), "Siempre permitir" (only when `allowAlways`) and "Rechazar". Checked by asking an agent to run a command in "Pedir aprobación" mode.
- **AC-3.5** (US-3) [manual] The thread shows a "!"-style dot/marker in the sidebar and in a company's chat list ("Esperando tu aprobación") while it has a pending approval, and a subagent's card stays open while it waits so its buttons are visible. Checked by delegating a task whose subagent writes a file.
- **AC-3.6** (US-3) Given an approval is requested, when it is emitted, then the main process shows a native notification: "Un agente necesita tu aprobación" with the thread title, or "Post listo para Instagram" with the first caption line for `instagram_publish`. [manual] Checked with the window in the background.
- **AC-3.7** (US-3) Given the app is reopened or the renderer reloads while approvals are pending, when it starts, then it asks the coordinator for the pending list (`approval.pending`) and shows the cards. [manual] Checked by reloading the window during a pending approval.
- **AC-3.8** (US-3) Given a tool state, when shown, then the status text is "Esperando tu aprobación", "Auto-review evaluando…", "Ejecutando…", "Listo", "No ejecutado" or "Error", followed by "· <note>" explaining who or what decided. [manual] Checked in any tool card.

### Siempre permitir and per-agent rules
- **AC-4.1** (US-6) Given a pending approval with `allowAlways`, when the person answers "Siempre permitir", then the tool runs and the tool name is remembered through `rememberAlwaysAllow`. Test: tests/agent.test.ts › "remembers"
- **AC-4.2** (US-6) Given a tool in `alwaysAllowTools`, when an agent calls it (and it is not `publish`), then it runs with note "Permitido por tu regla" in "Pedir aprobación" and "Auto-review" modes, without asking or calling the reviewer. [gap]
- **AC-4.3** (US-6) Given the coordinator remembers an always-allow tool, when it does, then it appends the name to its settings copy once (no duplicates), tells main (`alwaysAllow`), and main persists it, records `always-allow.add` in the audit log and tells the window to refresh settings. [gap]
- **AC-4.4** (US-6) [manual] The "Aprobaciones" settings tab lists each remembered tool with a "Quitar" button that removes it from `alwaysAllowTools`; with none it says "Ninguna. Aparecen acá cuando elegís «Siempre permitir» en una aprobación." Checked in Ajustes › Aprobaciones.
- **AC-4.5** (US-6) Given an agent whose `autoApproveTools` contains a tool, when that agent calls it, then it runs with note "Permitido para este agente" without asking, even in "Pedir aprobación" mode. Test: tests/agent.test.ts › "lets an agent run its own auto-approved tools without asking"
- **AC-4.6** (US-6) Given a run started by a camera rule with `autoApprove: ['camera_look']`, when the agent calls `camera_look`, then it runs without asking ("Permitido para este agente"). [gap]
- **AC-4.7** (US-6) Given an agent working in a company, when it calls `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image` or `compose_image`, then it runs without asking; `run_command` still asks. [gap]
- **AC-4.8** (US-6) [manual] The agent editor lists, under "Sin pedir aprobación (para este agente)", a checkbox for each of the agent's tools except read-only tools and `instagram_publish`. Checked in Ajustes › Agentes.

### Publish always asks
- **AC-5.1** (US-5) Given mode "Permitir todo", the tool in `alwaysAllowTools` and the agent's `autoApproveTools`, when an agent calls `instagram_publish`, then an approval request is still emitted with `allowAlways: false`, carrying the post preview. Test: tests/agent.test.ts › "always asks before publishing, even when everything else is allowed"
- **AC-5.2** (US-5) Given a pending `publish` approval, when the person answers "always", then the call runs once and nothing is remembered; the note is "Aprobado por vos". Test: tests/agent.test.ts › "always asks before publishing, even when everything else is allowed"
- **AC-5.3** (US-5) Given `email_send`, `send_whatsapp` or `home_secure_control` (locks, alarms, sirens, gates and garage doors; `risk: 'publish'`), when an agent calls them in any mode but read-only, then each asks the person with no "Siempre permitir" option. [gap] *Amended by [029](../029-alma-creates-companies/spec.md) (2026-11-08): `create_company` (`publish`) is in this list: it asks in every mode but read-only, with no "Siempre permitir" (029 AC-2.3, AC-2.4).*
- **AC-5.4** (US-5) Given `home_control` (risk `home`) is called on a lock, alarm or gate/garage/door cover, when it runs, then it fails and points to `home_secure_control`, so the approval cannot be skipped by using the everyday tool. [gap]

### Auto-review
- **AC-6.1** (US-4) Given mode "Auto-review" and the reviewer answers "allow", when an agent calls a `write` or `exec` tool, then it runs with note "Auto-review: <reason>", with state `reviewing` first, and the person is not asked. Test: tests/agent.test.ts › "auto-review runs safe actions and asks about flagged ones"
- **AC-6.2** (US-4) Given mode "Auto-review" and the reviewer answers "flag", when the tool is called, then an approval request is emitted with `flagged: true` and the reviewer's reason, and the call is denied if the person rejects. Test: tests/agent.test.ts › "auto-review runs safe actions and asks about flagged ones"
- **AC-6.3** (US-4) Given a flagged approval, when the card is shown, then its title is "Auto-review marcó esta acción como potencialmente peligrosa." followed by the reason, with the card styled as flagged. [manual] Checked by making the reviewer flag `rm -rf`.
- **AC-6.4** (US-4) Given mode "Auto-review" and the reviewer call fails (no key, network error), when the tool is called, then the person is asked with `flagged: false` and the reason "Auto-review no disponible: <error message>". [gap]
- **AC-6.5** (US-4) Given the reviewer is evaluating and the run is cancelled, when the review call rejects, then the call is denied with note "Cancelado" and the person is not asked. [gap]
- **AC-6.6** (US-4) Given a review, when the prompt is built, then it contains the person's review instructions (or "(ninguna)"), the working folder, the user's latest request cut to 4000 characters and the tool name and input as JSON cut to 8000 characters. [gap]
- **AC-6.7** (US-4) Given the Anthropic reviewer refuses or returns no parsed output, when asked to review, then the verdict is "flag" with reason "El revisor no pudo evaluar esta acción.". [gap]
- **AC-6.8** (US-4) [manual] The "Aprobaciones" tab lets the person choose the reviewer's provider (Anthropic, xAI, DeepSeek, Vercel AI Gateway), model and instructions, and "Guardar auto-review" is enabled only when they differ from the saved ones. Checked in Ajustes › Aprobaciones.

### Company boss review
- **AC-7.1** (US-9) Given an agent in a company with a boss agent and a `publish` call, when it is authorized, then the state is `reviewing` ("Lo revisa <boss>") and the boss model gives a verdict first. [gap]
- **AC-7.2** (US-9) Given the boss flags the action, when the verdict arrives, then the call is denied with note "Rechazado por <boss>: <reason>" and the person is never asked. [gap]
- **AC-7.3** (US-9) Given the boss allows the action, when the verdict arrives, then the person is asked (no "Siempre permitir") with reason "Aprobado por <boss>: <reason>". [gap]
- **AC-7.4** (US-9) Given the boss review throws, when not cancelled, then the person is asked with reason "<boss> no pudo revisarlo: <error>"; when cancelled, the call is denied as "Cancelado". [gap]
- **AC-7.5** (US-9) Given an agent that reports straight to the Directorio (no boss agent), when it publishes, then only the person is asked. [gap]

### Broker: pending, resolve, abort
- **AC-8.1** (US-8) Given a pending approval, when the run's signal aborts, then the approval resolves as denied, `approval.resolved` is emitted, the tool state is `denied` with note "Cancelado", the tool never runs and the history still ends with the tool results. Test: tests/agent.test.ts › "denies pending approvals when the run is cancelled"
- **AC-8.2** (US-8) Given a pending approval, when it is requested, then `pending()` lists it with a fresh `approvalId`, and a broadcast `approval.request` event carries the tool name, input, `flagged`, `reason`, `allowAlways`, thread and subagent. Test: tests/agent.test.ts › "denies pending approvals when the run is cancelled"
- **AC-8.3** (US-8) Given an `approvalId` that is unknown or already answered, when a response arrives, then it is ignored and nothing is emitted twice. [gap]
- **AC-8.4** (US-8) Given a pending approval, when it is answered, then `approval.resolved` is emitted, the card disappears in every window, and the entry leaves `pending()`. [gap]
- **AC-8.5** (US-8) Given a turn with several tool calls, when they need approval, then they run concurrently and several approvals can be pending at once, each answered on its own. [gap]
- **AC-8.6** (US-8) Given an approval nobody answers, when time passes, then it stays pending: there is no timeout. [gap]
- **AC-8.7** (US-8) Given the app closed while tools were running, when the conversation is reopened, then dangling tool calls are closed with an error result "Interrumpido: …". Test: tests/agent.test.ts › "closes tool calls left without results"

### Trail
- **AC-9.1** (US-3) Given a non-`read` tool call, when it is denied, then the audit log records `tool.authorize` / `denied`; when it runs, `tool.run` with outcome ok or error. Each entry carries risk, thread, agent, the decision note and the argument names, plus the command text for `run_command`. [gap]
- **AC-9.2** (US-3) Given a `read` tool call, when it runs, then nothing is added to the audit log. [gap]

### Answering from Telegram
- **AC-10.1** (US-7) Given an approval on the thread bound to the Telegram chat, when it is requested, then the bot sends to the bound chat: "¿Permitir esta acción?" (or "⚠️ Auto-review marcó esta acción como riesgosa." when flagged), the reason, "Herramienta: <name>" and the input JSON cut at 1500 characters, with inline buttons "Permitir", "Siempre" (only when `allowAlways`) and "Rechazar". [gap]
- **AC-10.2** (US-7) Given the buttons, when the person taps one, then the approval is answered allow / always / deny, the tap shows "Permitido" or "Rechazado", and the message is edited to add "(respondido)" when the approval resolves (also if it was answered in the app). [gap]
- **AC-10.3** (US-7) Given a button tap from a chat or user that is not the bound private chat of an allowed user, when received, then it is ignored without answering the approval (same chat check as messages). Test: tests/telegram.test.ts › "never accepts groups, even from an allowed user", "once bound, only that chat works, whatever the username"
- **AC-10.4** (US-7) Given callback data that does not match `ap:<id>:(allow|always|deny)`, when received, then it is ignored. [gap]
- **AC-10.5** (US-7) Given approvals for threads other than the Telegram one, when requested, then nothing is sent to Telegram. [gap]

### Answering by voice
- **AC-11.1** (US-7) Given an approval on the voice conversation's thread, when requested, then Alma says "Necesito tu permiso para <tool name with spaces>[, y podría ser riesgoso]. ¿Sí o no?", records the answer and responds allow for yes and deny for no. [gap]
- **AC-11.2** (US-7) Given a spoken answer, when parsed, then "Sí, dale" is yes, "no, cancelá" and "mejor no" are no, and an unrelated sentence is neither. Test: tests/voice.test.ts › "understands spoken yes and no"
- **AC-11.3** (US-7) Given an answer that is neither yes nor no, when heard, then Alma asks again once ("No te entendí. ¿Sí o no?"); after two unclear answers the approval is left pending in the app. [gap]
- **AC-11.4** (US-7) Given the voice path, when the person says yes, then it is always a one-time allow: voice cannot answer "Siempre permitir". [gap]

### Answering from a paired phone
- **AC-12.1** (US-7) Given a paired phone with the approve scope on, when an approval on the remote thread is requested, then the phone lists it with the same question Telegram shows, the input cut at 1500 characters, and answers allow or deny through the existing broker. Test: tests/remote-approvals.test.ts › "allow y deny llegan al broker existente", "la entrada se corta a 1500 caracteres" *Amended by [029](../029-alma-creates-companies/spec.md) (2026-11-08): for `create_company`, when the input does not fit in the phone's cut the phone does not offer allow (deny stays) and points to the desktop, where the approval stays pending (029 BR-23, AC-2.12); every other tool is unchanged.*
- **AC-12.2** (US-7) Given an approval already answered on another surface, or an unknown id, when the phone answers, then it gets 409 already-answered and nothing runs twice. Test: tests/remote-approvals.test.ts › "409 already-answered y nada corre dos veces", "un id desconocido da 409 already-answered"
- **AC-12.3** (US-7) Given the approve scope off, when the phone lists or answers, then it sees nothing and everything stays pending; the phone never answers always, like voice. Test: tests/remote-approvals.test.ts › "con approve apagado no se ven ni se responden, y siguen pendientes", "el esquema no tiene always y la tarjeta nunca lo ofrece (ni en publish)"

## 6. Business rules
- **BR-1** Order of decision in `authorize` (src/coordinator/approval.ts): `read` → allowed; mode `blocked` → denied (all other risks, including `memory`, `home`, `publish`); `memory` → allowed; `home` → allowed; `publish` → boss review / ask (ignores every rule below); the agent's auto-approve list → allowed; `alwaysAllowTools` → allowed; then by mode.
- **BR-2** Modes (`ApprovalMode`): `needs-approval` "Pedir aprobación" (default), `auto-review` "Auto-review", `always-allow` "Permitir todo", `blocked` "Solo lectura". (src/shared/types.ts, src/shared/defaults.ts, src/renderer/src/lib/format.ts)
- **BR-3** Matrix of what each mode does, by risk. "Ask" = approval card; "reviewer" = reviewer model decides, asks only if it flags or fails.

| Risk | Pedir aprobación | Auto-review | Permitir todo | Solo lectura |
|---|---|---|---|---|
| `read` | runs | runs | runs | runs |
| `write` | ask | reviewer | runs | denied |
| `exec` (and MCP tools) | ask | reviewer | runs | denied |
| `memory` | runs | runs | runs | denied |
| `home` | runs | runs | runs | denied |
| `publish` | ask (boss first in a company), no "Siempre" | same | same | denied |

  "Runs" for `write` / `exec` is overridden to "runs" by the agent's auto-approve list or `alwaysAllowTools` in the first two modes (BR-1).
- **BR-4** `publish` approvals have `allowAlways: false`. Answering "always" on them counts as a one-time allow and is not remembered. Tools with `publish`: `instagram_publish`, `email_send`, `send_whatsapp`, `home_secure_control`. (src/coordinator/approval.ts) *Amended by [029](../029-alma-creates-companies/spec.md) (2026-11-08): `create_company` is also `publish`; here `publish` also covers a model creating autonomous agents (029 BR-3).*
- **BR-5** `memory` tools (no approval): `save_knowledge`, `remember`, `forget`, `create_reminder`, `delete_routine`, `send_telegram` (to the person's own chat), the company tools `assign_task`, `update_task`, `review_task`, `ask_colleague`, `escalate`, `schedule_meeting`, and `excalidraw_draw`. `home` tools: `home_control`, `home_plan_edit`, `home_plan_from_drawing`, `home_plan_from_image`, `home_scene`. `write` tools include `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image`, `compose_image`, `create_routine`, `home_call_service`, `home_add_device`, `home_edit_device`, `home_remove_device`, `home_modes`, `home_rules`, `camera_look`, `camera_photo`, `camera_watch`. `exec`: `run_command`. (each tool's file under src/coordinator)
- **BR-6** A tool that is not a built-in or app tool (an MCP tool) has risk `exec`. (src/coordinator/agent.ts)
- **BR-7** Decisions are `allow`, `deny` and `always`. Notes shown and recorded: "Solo lectura", "Memoria de Alma", "Control de la casa", "Permitido para este agente", "Permitido por tu regla", "Modo «siempre permitir»", "Auto-review: <reason>", "Aprobado por vos", "Permitido siempre por vos", "Rechazado por vos", "Cancelado", "Bloqueado por el modo de aprobación".
- **BR-8** The reviewer verdict is `allow` or `flag` plus a one-sentence reason; its system prompt is in English (spec 025 BR-17), says to flag when in doubt, and the reason is shown to the person in the app language (spec 025 BR-18). The reviewer sees the user's instructions for the review (default text in `DEFAULT_REVIEW_INSTRUCTIONS`: flag mass or out-of-scope deletes, installs and system changes, sending data to the internet, publishing, pushing or paying, reading credentials or personal data; allow reads, builds, tests and scoped edits), the working folder, the user's latest message (4000 chars) and the call (8000 chars of JSON). (src/coordinator/approval.ts, src/shared/defaults.ts)
- **BR-9** Reviewer settings default to Anthropic with `DEFAULT_CLAUDE_MODEL`; changing them is via the "Aprobaciones" tab. (src/shared/defaults.ts)
- **BR-10** A reviewer that errors, or an auto-review that is cancelled, never auto-allows: error → ask the person; cancelled → denied.
- **BR-11** There is no time limit on a pending approval; it ends only by an answer or by the run's abort signal. (src/coordinator/approval.ts)
- **BR-12** `MAX_ITERATIONS` is 80 model turns per run, so a run cannot ask for approvals forever. (src/coordinator/agent.ts)
- **BR-13** Tools the company's agents run without asking: `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image`, `compose_image`, plus the agent's own `autoApproveTools`. Default agent templates for the community manager and designer auto-approve `generate_image`, `compose_image`, `write_file`, `edit_file`. (src/coordinator/agent.ts, src/shared/defaults.ts)
- **BR-14** After a denial the model is told: "No se ejecutó: <note>. No reintentes la misma acción; consultá al usuario si la necesitás."
- **BR-15** Telegram approval text shows the input JSON cut at 1500 characters; buttons carry `ap:<approvalId>:<decision>`. (src/coordinator/channels/telegram.ts) *Amended by [029](../029-alma-creates-companies/spec.md) (2026-11-08): for `create_company`, when the input does not fit in 1500 characters Telegram does not offer Permitir and says to see the proposal on the desktop (029 BR-23, AC-2.12); other tools keep the cut and their buttons.*
- **BR-16** By voice, a maximum of two attempts to understand yes or no. (src/coordinator/voice/assistant.ts)
- **BR-17** Switching the mode to "Permitir todo" from another mode needs a native confirmation in main ("Confirmar cambio de seguridad"; detail: publications still ask). Cancelling throws "Cambio cancelado." (src/main/index.ts; see 022)

- **BR-18** Answers from a paired phone reuse the existing approval broker: the first answer from any surface (app, Telegram, voice, phone) wins and later ones get `already-answered`. The phone offers allow and deny only, never always (spec 026 BR-12). *Amended by [028](../028-remote-vault-and-threads/spec.md) (2026-11-08): the phone also answers the approvals of a run it started in a conversation by id, only that device and only with the approve scope on; first answer wins and "always" stays unavailable, unchanged.*

## 7. Constraints and risks
- Layers touched: `shared` (types `ApprovalMode`, `PendingApproval`, `ToolState`, `LiveEvent` `approval.request` / `approval.resolved`, request `approval.respond` / `approval.pending`); `coordinator` (`approval.ts`, `agent.ts` `executeTool`, `index.ts` broker and `rememberAlwaysAllow`, `channels/telegram.ts`, `channels/whatsapp.ts`, `voice/assistant.ts`); `main` (`index.ts`: notification, `alwaysAllow` message, confirmation dialog); `renderer` (`ToolCard.tsx`, `ChatView.tsx` mode selector, `SettingsDialog.tsx` Aprobaciones tab and agent editor, `Sidebar.tsx`, `lib/state.ts`, `lib/format.ts`).
- Messages: `approval.respond {approvalId, decision}`, `approval.pending`; events `approval.request`, `approval.resolved`, `tool.state`; coordinator → main `alwaysAllow {toolName}` and `notify`.
- Persistence: `approvalMode`, `autoReview`, `alwaysAllowTools` and each agent's `autoApproveTools` live in settings (main). Pending approvals are in memory only; after a restart they are gone and dangling tool calls are closed with an error result.
- Security: an unreviewed "Permitir todo" mode is the widest door; `publish` and secure home controls are the only things it cannot skip. The reviewer model receives the tool input (which can contain file contents or commands) and the person's latest message: that is a third-party disclosure to whichever provider is configured for review (see 022).
- The same approval can be answered by the app, Telegram, WhatsApp and voice; the first answer wins and the others are ignored.
- Platform: notifications and dialogs are Electron/Windows native.
