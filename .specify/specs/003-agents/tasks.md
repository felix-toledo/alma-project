# 003 — Tasks

- [x] **T1** (BR-2, BR-3) Define `AgentProfile`, `Effort`, `ProviderId` in `src/shared/types.ts` and `BUILTIN_TOOLS`, `READ_ONLY_TOOLS` in `src/shared/defaults.ts` — typecheck only
- [x] **T2** (AC-4.1, BR-1) Test `tests/defaults.test.ts` › `has unique agent ids and a default agent that exists` fails → add `DEFAULT_AGENTS` and `defaultSettings` in `src/shared/defaults.ts`
- [x] **T3** (AC-4.15, AC-4.4) Test `tests/defaults.test.ts` › `ships a Multimedia agent that can run Remotion and only uses known tools` fails → add the Multimedia profile (no `run_command` in its no-approval list)
- [x] **T4** (AC-4.3) Test `tests/defaults.test.ts` › `ships a Vercel AI Gateway agent with its own key slot` fails → add the Vercel profile and its key slot
- [x] **T5** (AC-4.2, BR-1) Add the General, Investigador, Programador, Revisor, Grok, DeepSeek and Community Manager profiles in `src/shared/defaults.ts` — [gap]: no automated test yet (only Multimedia, Vercel and the id invariants are tested)
- [x] **T6** (AC-1.1, AC-1.2, BR-10) Test `tests/agent.test.ts` › `asks for approval, runs the tool and feeds the result back` and `returns an error result when the user denies` fail → implement `runAgent` and `executeTool` in `src/coordinator/agent.ts`
- [x] **T7** (AC-1.3, AC-1.5, BR-7) Test `tests/agent.test.ts` › `rejects invalid tool input without running it` and `does not ask for approval when there is no workspace` fail → validate input and workspace before `authorize` in `src/coordinator/agent.ts`
- [x] **T8** (AC-1.7) Test `tests/agent.test.ts` › `does not run tools from a turn cut off by max_tokens` fails → give each call an error result and continue
- [x] **T9** (AC-2.1, AC-6.1) Test `tests/agent.test.ts` › `denies pending approvals when the run is cancelled` and `closes tool calls left without results` fail → abort handling and `repairDanglingToolUses`
- [x] **T10** (AC-1.4, AC-1.6, AC-1.8–1.15, AC-2.2–2.5, BR-4, BR-5, BR-6) Implement the rest of the loop (unavailable tool, parallel results in order, refusal and token notices, 80-turn cap, error results, 60 000-character cap via `truncateMiddle`, MCP calls, persistence points, usage) in `src/coordinator/agent.ts` and `src/coordinator/tools/types.ts` — [gap]: no automated test yet
- [x] **T11** (AC-3.1, AC-3.2, AC-3.4, BR-8, BR-9, BR-17) Test `tests/agent.test.ts` › `runs delegated subagents in parallel and returns their results` fails → implement `delegate`, `delegateSpec` and `subagent.*` events
- [x] **T12** (AC-3.3) Test `tests/agent.test.ts` › `does not let subagents delegate further` fails → drop `delegate_task` when `depth > 0`
- [x] **T13** (AC-3.5–3.11, BR-8, BR-9) Implement unknown-agent, invalid-input, failure, empty-result, tagged-approval and prompt rules for subagents in `src/coordinator/agent.ts` — [gap]: no automated test yet
- [x] **T14** (AC-4.5, AC-4.6, BR-12, BR-13) Test `tests/agent.test.ts` › `lets an agent run its own auto-approved tools without asking` and `always asks before publishing, even when everything else is allowed` fail → pass `autoApprove` into `authorize` in `src/coordinator/agent.ts`
- [x] **T15** (AC-5.1–5.8, BR-11, BR-15, BR-18) Build the system prompt once per run, tool set, channel and company guides, voice effort and audit trail in `src/coordinator/agent.ts` — [gap]: no automated test yet
- [x] **T16** (AC-4.13, AC-2.4, BR-14, BR-16) Wire agent fallback, budget gate and missing-key error in `startRun` (`src/coordinator/index.ts`) — [gap]: no automated test yet
- [x] **T17** (AC-4.14) Migrate older saves (Office tools, Multimedia once, `compose_image`) in `src/main/settings.ts` — [gap]: no automated test yet
- [x] **T18** (AC-4.7–4.12) Build `AgentsTab` in `src/renderer/src/components/SettingsDialog.tsx` and the agent selector in `src/renderer/src/components/ChatView.tsx` — [manual]: open Ajustes → Agentes, create, edit, discard, set default, delete; change the agent in a chat
