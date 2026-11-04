# 004 — Plan

## 1. Approach
Every tool declares a `ToolRisk`; one pure-ish function, `authorize(request)` in `src/coordinator/approval.ts`, turns risk, approval mode and the person's rules into an allow or deny with a note, and an `ApprovalBroker` holds the calls that are waiting for a human. The agent loop calls `authorize` once per tool call and never decides anything itself. Channels (app, Telegram, WhatsApp, voice) are only different ways to call `broker.respond`; the first answer wins. `publish` is evaluated before every rule, so no mode, list or agent setting can skip it.

Rejected: a per-tool boolean "needs approval" (it cannot express read-only mode, auto-review or "always allow" without scattered `if`s) and a single global switch (too blunt for reads vs outward actions). Decision recorded in [ADR 0012](../../../docs/adr/0012-approval-model.md).

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`ApprovalMode`, `PendingApproval`, `ToolState`, `LiveEvent` `approval.request` / `approval.resolved`, requests `approval.respond` / `approval.pending`, message `alwaysAllow`), `src/shared/defaults.ts` (`approvalMode`, `autoReview`, `DEFAULT_REVIEW_INSTRUCTIONS`) | wire types and defaults used by three layers |
| coordinator | `src/coordinator/approval.ts` (`authorize`, `ApprovalBroker`, `Decision`, reviewer and boss prompts), `src/coordinator/agent.ts` (`executeTool`: calls `authorize`, audit trail), `src/coordinator/tools/types.ts` (`ToolRisk`, `ToolDefinition.preview`), `src/coordinator/providers/types.ts` (`Provider.review`, `ReviewVerdict`), `src/coordinator/index.ts` (broker wiring, `rememberAlwaysAllow`), `src/coordinator/channels/telegram.ts`, `src/coordinator/channels/whatsapp.ts`, `src/coordinator/voice/assistant.ts` | the decision and the waiting are agent I/O; channels already live here |
| main | `src/main/index.ts` (approval notification, `alwaysAllow` handler, "Confirmar cambio de seguridad" dialog), `src/main/settings.ts` | native dialogs and `settings.json` belong to main |
| renderer | `src/renderer/src/components/ToolCard.tsx` (approval box), `ChatView.tsx` (mode selector), `SettingsDialog.tsx` (Aprobaciones tab, agent no-approval group), `Sidebar.tsx`, `lib/state.ts`, `lib/format.ts` (`APPROVAL_MODES`) | cards, markers and settings UI |

Layer rules in `docs/architecture.md` hold: coordinator and renderer import only `shared`.

## 3. Contracts
- `type ToolRisk = 'read' | 'write' | 'exec' | 'memory' | 'publish' | 'home'`; `type ApprovalMode = 'needs-approval' | 'auto-review' | 'always-allow' | 'blocked'`; `type Decision = 'allow' | 'deny' | 'always'`.
- `authorize(request: AuthorizationRequest): Promise<Authorization>` with `Authorization { allowed, note }`; the request carries settings, thread and subagent ids, tool name, `risk`, `input`, `workspace`, `taskContext`, `autoApprove`, optional `preview` and `boss`, the `signal`, the `broker` and the `setState` / `rememberAlwaysAllow` callbacks.
- `ApprovalBroker`: `ask(approval, signal): Promise<Decision>`, `respond(approvalId, decision)`, `pending(): PendingApproval[]`.
- `PendingApproval { approvalId, threadId, subagentId?, toolUseId, toolName, input, flagged, reason?, allowAlways, preview? }`.
- Requests `approval.respond {approvalId, decision}`, `approval.pending`; events `approval.request`, `approval.resolved`, `tool.state`; coordinator → main `alwaysAllow {toolName}`; Telegram callback data `ap:<approvalId>:(allow|always|deny)`.
- Tools by risk: `instagram_publish`, `email_send`, `send_whatsapp`, `home_secure_control` are `publish`; `run_command` is `exec`; MCP tools are treated as `exec`; `save_knowledge`, `remember`, `forget`, `create_reminder`, `send_telegram` are `memory`; `home_control` is `home`.

## 4. Data and persistence
- `approvalMode`, `autoReview`, `alwaysAllowTools` and each agent's `autoApproveTools` live in `settings.json` (main). "Siempre permitir" adds the name once; main persists it and logs `always-allow.add`.
- Pending approvals are memory only. After a restart they are gone; the dangling tool calls are closed with an error result (spec 002).
- Audit entries `tool.authorize` / `tool.run` for non-read calls (format in spec 022).

## 5. Dependency injection
- `authorize` receives everything through `AuthorizationRequest`; the provider is resolved with `getProvider`, which tests replace with a scripted `Provider` whose `review` returns a chosen `ReviewVerdict`.
- `ApprovalBroker` takes an `emit` function; tests collect events and answer with `broker.respond` (`autoRespond` in `tests/agent.test.ts`).
- Telegram and voice receive `respondApproval` as a constructor dependency, so their tests need no coordinator.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1, AC-2.3, AC-2.5 | `tests/agent.test.ts` → `never asks for read-only tools and blocks writes in read-only mode`, `blocks publishing in read-only mode` | write in read-only; publish in read-only |
| AC-2.1, AC-3.2 | `tests/agent.test.ts` → `asks for approval, runs the tool and feeds the result back` | tool runs only after Permitir |
| AC-2.8 | `tests/agent.test.ts` → `does not ask for approval when there is no workspace` | empty workspace |
| AC-2.9 | `tests/agent.test.ts` → `rejects invalid tool input without running it` | schema mismatch |
| AC-3.1 | `tests/agent.test.ts` → `returns an error result when the user denies` | deny then retry hint |
| AC-3.3, AC-5.1, AC-5.2 | `tests/agent.test.ts` → `always asks before publishing, even when everything else is allowed` | allow-all + always-allow + auto-approve all set |
| AC-4.1 | `tests/agent.test.ts` → `remembers "siempre permitir"` | name stored once |
| AC-4.5 | `tests/agent.test.ts` → `lets an agent run its own auto-approved tools without asking` | note "Permitido para este agente" |
| AC-6.1, AC-6.2 | `tests/agent.test.ts` → `auto-review runs safe actions and asks about flagged ones` | allow verdict vs flag verdict |
| AC-8.1, AC-8.2, AC-8.7 | `tests/agent.test.ts` → `denies pending approvals when the run is cancelled`, `closes tool calls left without results` | abort while waiting; app closed mid-run |
| AC-10.3 | `tests/telegram.test.ts` → `never accepts groups, even from an allowed user`, `once bound, only that chat works, whatever the username` | other chat or user |
| AC-11.2 | `tests/voice.test.ts` → `understands spoken yes and no` | "mejor no", unrelated sentence |
| AC-1.2, 2.2, 2.4, 2.6, 2.7, 2.10, AC-4.2–4.3, 4.6–4.7, AC-5.3–5.4, AC-6.4–6.7, AC-7.1–7.5, AC-8.3–8.6, AC-9.1–9.2, AC-10.1–10.2, 10.4–10.5, AC-11.1, 11.3–11.4 | [gap] | reviewer throws, unknown `approvalId`, two approvals at once, bad callback data |
| AC-3.4–3.8, AC-4.4, 4.8, AC-6.3, 6.8 | [manual] | checked by running the app in each mode |

## 7. Security and privacy impact
- Defines the risk class of every tool; `publish` always asks with no "Siempre permitir" and is the only thing "Permitir todo" cannot skip. An error in a reviewer or boss never auto-allows (ask, or deny when cancelled).
- The reviewer model receives the tool input (up to 8000 characters) and the person's latest message (4000): a disclosure to whichever provider is configured for review.
- Switching to "Permitir todo" needs a native confirmation in main. Telegram answers reuse the same chat check as messages.
- Already covered in `docs/security/CONTROLS.md` (human approval row) and `docs/security/RISKS.md` (R-07); no further update.

## 8. Rollout
Mode `needs-approval` is the default; the person changes it from the composer or Ajustes → Aprobaciones. Auto-review defaults to Anthropic with `DEFAULT_CLAUDE_MODEL` and `DEFAULT_REVIEW_INSTRUCTIONS`. `alwaysAllowTools` starts empty. On first run nothing asks until an agent writes or runs a command.
