# Approvals

> The policy that decides, before every tool call, whether the person must say yes first: four approval modes, "always allow" rules, a reviewer model, a boss review in companies, and the question itself (answerable in the app, from Telegram buttons, by voice, or from a paired phone). Spec: [004 Aprobaciones](../../.specify/specs/004-approvals/spec.md). Test status: 63 criteria, 20 with a test, 34 without a test (`[gap]`), 9 checked by hand (`[manual]`).

## What it does

- **Reads never ask.** Anything a tool declares as `read` runs in every mode.
- The person picks how much Alma asks before writing files or running commands, with four modes, and can change the mode at any moment (even mid-run: it applies to the next tool call).
- Each pending question shows the real input (command, file path and content, a diff for `edit_file`, the Instagram post preview) and offers **Permitir** (allow), **Siempre permitir** (always allow) and **Rechazar** (reject).
- **Auto-review**: a reviewer model judges each action and only interrupts the person when it flags one.
- Anything that acts outward in the person's name (`publish` risk) always asks, whatever the mode, and never offers "always allow".
- In a company, the boss agent reviews what a report sends out before it reaches the person.
- The person can answer from the app, from Telegram buttons, by saying yes or no, or (WhatsApp, see [whatsapp](whatsapp.md)) by text. The first answer wins.
- Cancelling a run denies its pending approvals, so nothing runs later by accident.

## How to use it

- **Choose the mode**: the selector in the chat composer (it is a global setting, not per thread), or «Configuración → Aprobaciones».

| Mode (`ApprovalMode`) | Label | Hint shown |
|---|---|---|
| `needs-approval` (default) | «Pedir aprobación» | asks before writing files, running commands or using MCP |
| `auto-review` | Auto-review | a reviewer model judges each action; asks only if it flags it |
| `always-allow` | «Permitir todo» | runs everything without asking; "use only in test folders" |
| `blocked` | «Solo lectura» | blocks writes, commands and MCP; the agent can only read |

- Switching to "«Permitir todo»" from another mode needs a native confirmation ("Confirmar cambio de seguridad"; publications still ask). Cancelling gives "Cambio cancelado.".
- **Answer a question**: the tool card in the chat shows «¿Permitir esta acción?» (or «Auto-review marcó esta acción como potencialmente peligrosa.» plus the reason, styled as flagged). The button reads "Publicar" for `instagram_publish`. The sidebar shows «Esperando tu aprobación» on that thread, and a desktop notification says «Un agente necesita tu aprobación» (or "Post listo para Instagram" with the first caption line).
- **Always allow rules**: the tab lists every remembered tool with «Quitar» (remove). With none it says «Ninguna. Aparecen acá cuando elegís Siempre permitir en una aprobación.»
- **Per-agent rule**: «Configuración → Agentes» → «Sin pedir aprobación (para este agente)» ([agents](agents.md)).
- **Reviewer**: the tab lets you choose the reviewer's provider (Anthropic, xAI, DeepSeek, Vercel AI Gateway), model and instructions. "Guardar auto-review" is enabled only when they differ from the saved ones. Default instructions flag mass or out-of-scope deletes, installs and system changes, sending data to the internet, publishing, pushing or paying, and reading credentials or personal data; they allow reads, builds, tests and scoped edits.
- **Telegram**: the bot sends «¿Permitir esta acción?» (or «⚠️ Auto-review marcó esta acción como riesgosa.»), the reason, "Herramienta: <name>" and the input cut at 1500 characters, with buttons Permitir / Siempre / Rechazar. Only the bound private chat can answer.
- **Voice**: Alma says «Necesito tu permiso para <tool>[, y podría ser riesgoso]. ¿Sí o no?» ("I need your permission to ...[, and it could be risky]. Yes or no?"). Say «sí, dale» or «no, cancelá» / "mejor no". Voice can only allow once, never "always".

## How it works

Files: `src/coordinator/approval.ts` (`ApprovalBroker`, `authorize`, `autoReview`, `bossReview`), `src/coordinator/agent.ts` (`executeTool` builds the request), `src/coordinator/index.ts` (broker, `rememberAlwaysAllow`, notifications), `channels/telegram.ts`, `channels/remote/approvals.ts`, `voice/assistant.ts`, `src/main/index.ts` (`alwaysAllow` message, confirmation dialog), renderer `ToolCard.tsx`, `ChatView.tsx`, `SettingsDialog.tsx`, `Sidebar.tsx`, `lib/state.ts`, `lib/format.ts`.

Order of decision in `authorize` (checked against the code):

1. `read` → allowed ("«Solo lectura»").
2. mode `blocked` → denied («Bloqueado por el modo de aprobación»), for every other risk including `memory`, `home`, `publish`.
3. `memory` → allowed ("Memoria de Alma"). `home` → allowed («Control de la casa»).
4. `publish` → if the agent has a boss: state `reviewing` («Lo revisa <boss>»), the boss model gives a verdict; flag = denied («Rechazado por <boss>: <reason>») and the person is not asked; allow = the person is asked with reason «Aprobado por <boss>: <reason>». Otherwise the person is asked directly. Never "always allow"; ignores everything below.
5. The running agent's `autoApprove` list (profile `autoApproveTools`, the company set, or extras passed by the run such as a camera rule's `camera_look`) → allowed («Permitido para este agente»).
6. `alwaysAllowTools` → allowed («Permitido por tu regla»).
7. By mode: `always-allow` → allowed ("Modo «siempre permitir»"); `auto-review` → state `reviewing`, reviewer verdict `allow` runs ("Auto-review: <reason>"), `flag` asks the person with `flagged: true`; reviewer error → asks the person with reason "Auto-review no disponible: <error>"; cancelled → denied "Cancelado"; `needs-approval` → asks.

Rule 6 comes before the mode switch, so a tool in `alwaysAllowTools` also reports «Permitido por tu regla» in "«Permitir todo»" mode (the spec only mentions the first two modes).

Matrix by risk:

| Risk | «Pedir aprobación» | Auto-review | «Permitir todo» | «Solo lectura» |
|---|---|---|---|---|
| `read` | runs | runs | runs | runs |
| `write` | ask | reviewer | runs | denied |
| `exec` (and MCP tools) | ask | reviewer | runs | denied |
| `memory` | runs | runs | runs | denied |
| `home` | runs | runs | runs | denied |
| `publish` | ask (boss first in a company) | same | same | denied |

(`write`/`exec` run without asking in the first two modes when rule 5 or 6 applies.)

The broker: `ApprovalBroker.ask` creates an `approvalId`, stores the waiter, emits `approval.request`, and resolves on `respond(approvalId, decision)` or when the run's abort signal fires (decision `deny`, note "Cancelado"). Unknown or already-answered ids are ignored. `pending()` feeds `approval.pending` so a reloaded window repaints the cards. A denial is reported to the model as «No se ejecutó: <note>. No reintentes la misma acción; consultá al usuario si la necesitás.» ("Not executed: <note>. Do not retry the same action; ask the user if you need it.").

"Siempre permitir": the coordinator appends the tool name to its settings copy once, sends `alwaysAllow {toolName}` to main, which persists it, writes the audit entry `always-allow.add` and tells the window to refresh settings. Answering "always" on a `publish` call counts as a one-time allow and remembers nothing.

Tool risk classification of a call whose tool is not a built-in or app tool (an MCP tool) is `exec`.

## Tools for agents

Approval is not a tool; it is applied to every tool. Risk by tool (verified in `src/coordinator`):

| Risk | Tools |
|---|---|
| `read` | `read_file`, `list_dir`, `search_files`, `office_read`, `web_search`, `fetch_url`, `email_search`, `email_read`, `whatsapp_recent`, `list_routines`, `list_tasks`, `search_knowledge`, `read_note`, `excalidraw_read`, `look_at_image`, `home_overview`, `home_find`, `home_plan`, `home_history` |
| `write` | `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image`, `compose_image`, `create_routine`, `home_call_service`, `home_add_device`, `home_edit_device`, `home_remove_device`, `home_modes`, `home_rules`, `camera_look`, `camera_photo`, `camera_watch` |
| `exec` | `run_command` (and every MCP tool, by default) |
| `memory` | `save_knowledge`, `remember`, `forget`, `excalidraw_draw`, `create_reminder`, `delete_routine`, `send_telegram`, `assign_task`, `update_task`, `review_task`, `ask_colleague`, `escalate`, `schedule_meeting` |
| `home` | `home_control`, `home_plan_edit`, `home_plan_from_drawing`, `home_plan_from_image`, `home_scene` |
| `publish` | `instagram_publish`, `email_send`, `send_whatsapp`, `home_secure_control`, `create_company`, `edit_company` (spec 029; `edit_company` is a placeholder that always fails for now) |

`home_control` refuses locks, alarms and gate/garage covers and points to `home_secure_control`, so the approval cannot be skipped through the everyday tool. Full table: [references/tools.md](../references/tools.md).

## Settings and data

| Setting | Default |
|---|---|
| `approvalMode` | `needs-approval` |
| `autoReview` | `{ provider: 'anthropic', model: 'claude-opus-5-5', instructions: DEFAULT_REVIEW_INSTRUCTIONS }` |
| `alwaysAllowTools` | `[]` |
| agent `autoApproveTools` | none (Multimedia and Community Manager: `generate_image`, `compose_image`, `write_file`, `edit_file`) |

All live in `settings.json` (main). Pending approvals are in memory only: after a restart they are gone and dangling tool calls are closed with an error result "Interrumpido: ...". Company agents also run `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image`, `compose_image` without asking; `run_command` still asks. See [references/settings.md](../references/settings.md).

## Limits and rules

| Rule | Value |
|---|---|
| Time limit on a pending approval | none; it ends only by an answer or the run's abort |
| Model turns per run (bounds endless asking) | 80 |
| Reviewer prompt: user's latest request | cut to 4000 chars |
| Reviewer prompt: tool input as JSON | cut to 8000 chars |
| Boss prompt: boss instructions | cut to 3000 chars |
| Reviewer `max_tokens` (Anthropic) | 4096 |
| Telegram approval text: input | cut to 1500 chars (`APPROVAL_INPUT_LIMIT`); for `create_company` / `edit_company` it is not cut: if the input does not fit, Permitir is withheld instead (spec 029 BR-23) |
| Voice attempts to understand yes/no | 2 |
| Reviewer failure to judge | verdict `flag` (fail safe); an error asks the person, never auto-allows |

## Security and privacy

- "«Permitir todo»" is the widest door; only `publish` calls (including `home_secure_control`) and the read-only mode override it.
- The reviewer receives the tool input (it can contain file contents or commands) and the person's latest message (cut as above). That goes to whichever provider is configured for review, or to the boss agent's provider ([providers](providers.md), [security](security.md)).
- Non-`read` calls are audited: `tool.authorize` / `denied`, `tool.run` / `ok` or `error`, with risk, thread, agent, decision note, argument names and the command line for `run_command`. Reads are not audited. Argument values are not stored.
- Telegram buttons are accepted only from the bound private chat of an allowed user; callback data must match `ap:<id>:(allow|always|deny)`.
- A paired phone answers through the same broker (first answer wins, later ones get `already-answered`); it needs the approve scope and sees the request cut at 1500 characters ([remote-access](remote-access.md)). Since spec 028 the phone also sees and answers the approvals of a run it started in a conversation by id, and only that device does; the policy is not stricter for it, so in «Permitir todo» mode `exec` and `write` do not ask in a phone-started run either, while `publish` always asks. With the approve scope off the phone shows that the run waits for an approval on the PC and the approval stays pending for the other surfaces. A phone-started run in a Telegram, WhatsApp or voice conversation does not send or speak its approval prompt on that channel.
- **Company tools (spec 029).** `create_company` is `publish`, so every rule above applies: it asks in every mode but «Solo lectura» (denied), nothing skips it, «Siempre» is never offered and «always» counts as one allow. Alma is not a company agent, so there is no boss step. It is offered only to attended, top-level runs of agents outside any company, on the desktop, Telegram or the paired phone. The desktop card is `CompanyProposalCard` (rows from the pure `proposalOfCreation`): read-only, Permitir / Rechazar, with a flag on any position that auto-approves an `exec` tool. **Whole-input rule (BR-23):** `canAnswerFrom(via, approval, limit)` is false for these two tools on Telegram and the phone when `JSON.stringify(input, null, 1)` is longer than the 1500-character limit; then Telegram sends «see it on the desktop» instead of the cut input and leaves out Permitir, the phone's approval view has `whole: false` and its flow answers `already-answered` to an allow, and `ApprovalBroker.respond(approvalId, decision, via)` ignores an allow from that channel, so the approval stays pending for the desktop. Rechazar is never withheld. **Answering channel:** `respond` takes the channel (`desktop`, `telegram`, `phone`), the broker returns it in `Authorization.via` and `executeTool` puts it in the audit entry `company.create` / `company.edit` (company id, number of positions, channel; never names or text). Other answer paths (voice, WhatsApp) pass no channel and are not gated, which is safe only because the tools are not offered there. Not done: no audit entry for a call that fails validation before the card; `edit_company` is a placeholder. See [companies](companies.md) and `../security/CONTROLS.md`.

## How it is tested

- With a test (`tests/agent.test.ts`): ask-then-run, deny, read-only mode (reads run, writes and publish denied), no ask without a workspace, invalid input, auto-review allow and flag, "always allow" is remembered, per-agent auto-approve, publish always asks, cancel denies pending approvals, dangling calls. `tests/telegram.test.ts`: only the bound private chat works. `tests/voice.test.ts`: spoken yes/no parsing. Spec 029: `tests/company-approval.test.ts` (publish tools ask in every mode and cannot be remembered, read-only denies, a denial changes nothing, stopping denies with «Cancelado», no boss step, the broker refuses an allow from Telegram or the phone when the input does not fit, deny is never refused, the answer carries its channel), plus the Telegram and phone cases in `tests/telegram.test.ts` and `tests/remote-approvals.test.ts` and the card logic of `tests/remote-client-conversations.test.ts`.
- Not covered: "«Permitir todo»" itself, notes per mode, reviewer failure and cancel paths, review prompt contents, boss review (all five criteria), audit entries, always-allow persistence in main, broker edge cases (unknown id, concurrent approvals), Telegram message text and buttons, the voice flow and its retry.
- By hand: the approval card in each mode, the flagged style (make the reviewer flag `rm -rf`), the notification with the window in the background, reloading the window during a pending approval, the Aprobaciones tab.

## Known limits

1. "«Solo lectura»" also denies `memory` and `home` tools, so `remember` and `home_control` stop working, while its hint says it blocks "escrituras, comandos y MCP" and the `ToolRisk` comment says memory is blocked only in read-only mode. Product decision: is blocking house control intended?
2. No timeout: a run waiting for an answer from a phone or voice stays suspended until Stop.
3. Voice and WhatsApp handle one pending approval at a time; parallel tool calls may collide there (Telegram answers each by id).
4. A name-only "Siempre permitir" or per-agent rule on an MCP tool allows that name forever across agents and modes, even if the server's behavior changes.
5. For a sub-agent, auto-review judges against the sub-agent's task text, not the person's original request.
6. When a run is cancelled, Telegram edits the message to "(respondido)" though nobody answered.
7. `home_secure_control` is tagged `publish`, so a company boss would review it, but house tools are not offered in companies, so this likely never happens. Confirm.
8. The flag «can run commands without asking» on a company proposal covers only the position's own auto-approved list. In «Permitir todo», with a «Siempre permitir» rule or when the reviewer lets it pass, a company agent's `run_command` also runs unasked (risk [R‑15](../security/RISKS.md)).

Most of the policy has no test; boss review in particular is untested.

## See also

[agents](agents.md) · [chat](chat.md) · [providers](providers.md) · [security](security.md) · [companies](companies.md) · [telegram](telegram.md) · [whatsapp](whatsapp.md) · [voice](voice.md) · [home](home.md) · [web-and-mail](web-and-mail.md) · [references/tools.md](../references/tools.md) · [references/ipc-messages.md](../references/ipc-messages.md)
