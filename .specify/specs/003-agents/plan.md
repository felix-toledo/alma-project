# 003 — Plan

## 1. Approach
An agent profile is plain data (`AgentProfile`) and the loop is one function, `runAgent(profile, messages, ctx)`, that talks to a `Provider`, runs the tool calls of each turn concurrently after `authorize()`, and repeats until the model stops asking for tools. A subagent is the same function called again with a fresh message list and `depth + 1`; `delegate_task` is handled inside the loop (it never goes through `authorize`, the subagent's own calls do). The loop is bounded by `MAX_ITERATIONS` (80) and delegation by depth, so work cannot fan out without limit.

Rejected: a separate orchestrator/worker framework or recursive delegation. One level of subagents covers "split independent work across specialists" and keeps approvals, abort and persistence on a single code path. Layering and the coordinator process: [ADR 0001](../../../docs/adr/0001-coordinator-as-utility-process.md), [ADR 0002](../../../docs/adr/0002-layer-rules-enforced-by-test.md); the approval policy used by every tool call: [ADR 0012](../../../docs/adr/0012-approval-model.md).

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`AgentProfile`, `Effort`, `ProviderId`), `src/shared/defaults.ts` (`DEFAULT_AGENTS`, `BUILTIN_TOOLS`, `READ_ONLY_TOOLS`, `DEFAULT_CLAUDE_MODEL`, `defaultSettings`) | the profile shape and the default set are read by main (migration), renderer (editor) and coordinator |
| coordinator | `src/coordinator/agent.ts` (`runAgent`, `executeTool`, `delegate`, `systemPrompt`, `repairDanglingToolUses`, `MAX_ITERATIONS`), `src/coordinator/tools/index.ts` (`builtinTools`, `builtinToolsByName`), `src/coordinator/tools/types.ts` (`truncateMiddle`, `ToolError`), `src/coordinator/providers/types.ts` (`Provider`, `TurnRequest`, `TurnResult`), `src/coordinator/index.ts` (`startRun`: agent fallback, budget gate) | the loop is I/O for an agent; it needs no Electron |
| main | `src/main/settings.ts` (loads and migrates agents: Office tools, Multimedia, `compose_image`) | main owns `settings.json` |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (`AgentsTab`), `src/renderer/src/components/ChatView.tsx` (agent selector, model and effort footer) | editing and picking agents |

No new arrow against `docs/architecture.md`.

## 3. Contracts
- `AgentProfile { id, name, description, systemPrompt, provider, model, effort, tools, allowMcp, canDelegate, companyId?, autoApproveTools? }`.
- `runAgent(profile: AgentProfile, messages: ChatMessage[], ctx: RunContext): Promise<string>`; `RunContext` carries `getSettings`, `thread`, `scope`, `signal`, `depth`, `approvals`, `mcp`, `host`, `knowledge`, `emit`, `persist`, `rememberAlwaysAllow`, `autoApprove?`, `onUsage?`.
- `repairDanglingToolUses(messages): boolean`.
- Tool `delegate_task { agent, title, task }`: no `ToolRisk` (handled in the loop); the subagent's tools carry their own risk. Offered only when `profile.canDelegate && depth === 0 && !company` and at least one other non-company agent exists; its description lists the roster.
- Events per scope: `stream.text | stream.thinking | stream.tool`, `message`, `tool.state`, `subagent.started | subagent.finished`, `run.started | run.finished`.
- `Provider.streamTurn(request): Promise<TurnResult>` with `stopReason` `end_turn | tool_use | max_tokens | refusal | other`.
- Offered tools: the profile's built-ins, `delegate_task`, app tools (vault, routines, `web_search`, `fetch_url`, `send_telegram`, `look_at_image`, house, mail, WhatsApp, company), and MCP tools when `allowMcp`.

## 4. Data and persistence
- Profiles live in `settings.json` under the user data folder (spec 006); `main/settings.ts` merges stored agents over `DEFAULT_AGENTS` and runs the three one-time migrations (`officeToolsAdded`, `multimediaAdded`, `compose_image` backfill).
- Conversations, `subagents` and `toolStates` live in the thread file (spec 002); a subagent run persists inside its thread.
- Nothing new on disk.

## 5. Dependency injection
- `runAgent` imports no singleton: settings, signal, broker, MCP, host, knowledge, emit and persist all arrive in `RunContext`.
- `tests/agent.test.ts` mocks `../src/coordinator/providers` with a scripted `Provider` (each test decides every model turn), uses a real `ApprovalBroker` with an event sink, a temp workspace and a `McpManager` with no servers.
- `tests/defaults.test.ts` reads `DEFAULT_AGENTS` and `BUILTIN_TOOLS` directly.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1 | `tests/agent.test.ts` → `asks for approval, runs the tool and feeds the result back` | final message sequence |
| AC-1.2 | `tests/agent.test.ts` → `returns an error result when the user denies` | denied state |
| AC-1.3 | `tests/agent.test.ts` → `rejects invalid tool input without running it` | schema mismatch, nothing runs |
| AC-1.5 | `tests/agent.test.ts` → `does not ask for approval when there is no workspace` | empty workspace |
| AC-1.7 | `tests/agent.test.ts` → `does not run tools from a turn cut off by max_tokens` | truncated input |
| AC-2.1 | `tests/agent.test.ts` → `denies pending approvals when the run is cancelled` | abort while waiting |
| AC-6.1 | `tests/agent.test.ts` → `closes tool calls left without results` | already consistent history |
| AC-3.1, 3.2, 3.4 | `tests/agent.test.ts` → `runs delegated subagents in parallel and returns their results` | two parallel calls, order kept |
| AC-3.3 | `tests/agent.test.ts` → `does not let subagents delegate further` | subagent with `canDelegate` |
| AC-4.1 | `tests/defaults.test.ts` → `has unique agent ids and a default agent that exists` | every default tool is a built-in |
| AC-4.15, 4.4 | `tests/defaults.test.ts` → `ships a Multimedia agent that can run Remotion and only uses known tools` | `run_command` not auto-approved |
| AC-4.3 | `tests/defaults.test.ts` → `ships a Vercel AI Gateway agent with its own key slot` | key slot present |
| AC-4.5 | `tests/agent.test.ts` → `lets an agent run its own auto-approved tools without asking` | note "Permitido para este agente" |
| AC-4.6 | `tests/agent.test.ts` → `always asks before publishing, even when everything else is allowed` | publish in the no-approval list |
| AC-1.4, 1.6, 1.8–1.15, AC-2.2–2.5, AC-3.5–3.11, AC-4.2, 4.13, 4.14, AC-5.1–5.8 | [gap] | unknown tool, refusal, 80-turn cap, over-60 000-character result, subagent that throws |
| AC-4.7–4.12 | [manual] | edit, save, discard, delete the default agent in Ajustes → Agentes |

## 7. Security and privacy impact
- `delegate_task` has no `ToolRisk`; every tool a subagent calls goes through `authorize()` with the same mode, tagged with the subagent id (spec 004).
- The profile's instructions, working folder, local date, vault fragments and memories are sent to the agent's provider. A profile's `tools` and `allowMcp` are the only per-agent capability limits; app tools are offered to every agent.
- No secrets in prompts. No change to `docs/security/`: approval and audit coverage already in `CONTROLS.md` and R-07 in `RISKS.md`.

## 8. Rollout
No flag. Fresh installs get the nine default profiles with `general` as default; older settings files are migrated once on load (Office tools, Multimedia agent, `compose_image`). The default agent cannot be deleted from the editor.
