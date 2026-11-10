# Agents

> Named agent profiles (instructions, provider, model, tools) and the loop that runs one: ask the model, run the tools it requests, feed the results back, repeat. A main agent can delegate to sub-agents that run in parallel. Spec: [003 Agentes](../../.specify/specs/003-agents/spec.md). Test status: 55 criteria, 17 with a test, 32 without a test (`[gap]`), 6 checked by hand (`[manual]`).

## What it does

- The person keeps several **agent profiles** and picks one per conversation (or per channel, routine or house rule). Alma ships nine.
- An agent works through tools (files, commands, Office, images, web, vault, routines, house, mail, MCP...), asking the person first when the approval policy says so ([approvals](approvals.md)).
- A profile with "may delegate" can hand independent subtasks to other profiles with `delegate_task`. The sub-agents run at the same time, each with its own history, and return their final text. Sub-agents cannot delegate again.
- The person can stop a run at any time, and a conversation whose app closed mid-action stays usable.
- Each turn the agent is told where it is (working folder, shell, local date and time), and receives memories and the vault fragments closest to the latest message.

## How to use it

- **Pick an agent**: the "Agente" selector in the chat header; it applies from the next message. New chats use the default agent (`general`).
- **Edit agents**: «Configuración → Agentes» (`AgentsTab` in `SettingsDialog.tsx`). The list shows non-company agents with the provider name and «· por defecto» ("· default") on the default one.
  - "+ Nuevo agente" creates "Nuevo agente": Anthropic, first Claude model, effort `medium`, tools `read_file`, `list_dir`, `search_files`, MCP off, no delegation.
  - Editing any field enables "Guardar cambios" (save) and "Descartar" (discard).
  - Changing the provider resets the model (first Claude model for Anthropic, empty for the others). The refresh button next to the model field fetches the provider's model list.
  - The group «Sin pedir aprobación (para este agente)» ("No approval needed (for this agent)") offers only the agent's checked tools that are not read-only and not `instagram_publish`.
  - "Usar por defecto" (use as default) sets the default. "Borrar" (delete) asks «¿Borrar el agente …?» and is disabled for the default agent and when only one agent exists.
- **Ask for delegation** in chat with the `general`, `grok`, `deepseek` or `vercel` agent: «Investigá estas tres carpetas en paralelo y haceme un resumen» (research these three folders in parallel and give me a summary).

Default profiles (`src/shared/defaults.ts`; the spec's summary says ten but the code, and the spec's own BR-1, have nine):

| id | Provider | Effort | Delegates | MCP | Tools | No-approval tools |
|---|---|---|---|---|---|---|
| `general` | Anthropic | high | yes | yes | file tools, commands, Office, `generate_image`, `compose_image` | none |
| `investigador` | Anthropic | medium | no | no | `read_file`, `list_dir`, `search_files`, `office_read` | none |
| `programador` | Anthropic | medium | no | yes | same as `general` | none |
| `revisor` | Anthropic | medium | no | no | same as `investigador` | none |
| `grok` | xAI (empty model) | high | yes | yes | same as `general` | none |
| `deepseek` | DeepSeek (empty model) | high | yes | yes | same as `general` | none |
| `vercel` | Vercel AI Gateway (empty model) | high | yes | yes | same as `general` | none |
| `multimedia` | Anthropic | medium | no | no | same as `general` (Remotion video producer) | `generate_image`, `compose_image`, `write_file`, `edit_file` |
| `community-manager` | Anthropic | medium | no | no | read/write/edit files, Office, images, `instagram_publish` (no `run_command`) | same four |

Anthropic defaults use `claude-opus-5-5`. "File tools" = `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`, `office_read`, `office_create`, `office_edit`.

## How it works

Files: `src/coordinator/agent.ts` (loop, `executeTool`, `delegate`, system prompt), `src/coordinator/index.ts` (`startRun`), `src/shared/defaults.ts` (profiles), `src/shared/types.ts` (`AgentProfile`), `src/main/settings.ts` (loads and migrates agents), `src/renderer/src/components/SettingsDialog.tsx`.

`AgentProfile` fields: `id`, `name`, `description` (read by other agents and shown in the chat welcome), `systemPrompt`, `provider` (`anthropic`, `xai`, `deepseek`, `vercel`, `meta`), `model` (empty = provider default, see [providers](providers.md)), `effort` (`low`, `medium`, `high`, `xhigh`, `max`), `tools`, `allowMcp`, `canDelegate`, optional `companyId`, optional `autoApproveTools`.

Run loop (`runAgent`):

```
startRun -> pick profile (thread.agentId, else first agent) -> runAgent(profile, messages, ctx)
  build tools: profile built-ins + delegate_task? + app tools + MCP tools (if allowMcp)
  build system prompt ONCE (instructions, environment, notices, guides, knowledge)
  for up to 80 turns, unless aborted:
     provider.streamTurn(...)            -> emits stream.* events
     push assistant message, emit `message`, persist
     no tool calls, or refusal  -> stop
     stop_reason max_tokens     -> every call gets an error "input truncated"; no tool runs
     else Promise.all(executeTool(...)) -> one user message of tool_result blocks, persist
```

`executeTool` order: aborted? («Cancelado por el usuario.») → tool not offered? → `delegate_task`? → validate input with Zod (`INVALID_JSON` error result) → no working folder for a non-`standalone` built-in? (error, no approval asked) → the tool's own `validate` hook, if any, whose `ToolError` ends the call with no approval asked (spec 029; a rejection here writes no audit entry yet) → the tool's `preview` for the card (a `previewRequired` tool without one is refused) → `authorize` ([approvals](approvals.md)) → run → `tool.state` events and an audit entry for every non-`read` call. Settings are re-read after the approval wait, so changes made while waiting apply.

Delegation (`delegate`): the sub-agent's run is stored in `thread.subagents[<tool call id>]`, starts with only its `task` as a message, uses its own profile (provider, model, tools, no-approval list) and shares the parent's folder, abort signal, approval broker, vault, MCP, settings and channels. Its approvals carry the sub-agent id. `delegate_task` is offered only when the run is top level (depth 0), the profile has `canDelegate`, it is not a company run, and at least one other non-company agent exists. The tool description lists those agents with id, name and description.

System prompt order (built once per run, so it stays stable for the provider's prompt cache and the date is fixed at the start of the run): profile instructions; "Entorno" block (folder, shell, Internet through `web_search`/`fetch_url`, local date, time and time zone); sub-agent notice (depth > 0); delegation note; channel guide (voice/Telegram/WhatsApp/company, top level only); company context or the house guide; Office guide (if the profile has an `office_*` tool); knowledge context (memories and nearest vault fragments, then the knowledge guide; failures are skipped). Voice conversations at top level use effort `low`.

App tools offered to every agent whatever the profile lists: routine/reminder tools, `web_search`, `fetch_url`, `send_telegram`, `look_at_image`, `read_attachment` (spec 030; `read`, `standalone`, reads a chat attachment by id), vault tools (vault open), mail tools (mail configured), WhatsApp tools (linked), house tools (house on and not a company run), company tools (company agents). Spec 029 adds `create_company` and `edit_company` (both `publish`), offered by `offersCompanyAuthoring` only to an attended, top-level run (depth 0, not unattended) of an agent with no company seat, in a desktop, Telegram or paired-phone thread, and only when the run carries an authoring host (set once main has answered with the default vault path); never in voice or WhatsApp threads. `edit_company` is a placeholder that always fails for now.

Which agent runs a conversation: the thread's `agentId`; if that no longer exists, the first agent in settings. Channels, routines and house rules use their configured agent and fall back to `defaultAgentId`.

## Tools for agents

`delegate_task` is the only tool this module owns. It is handled inside the loop and never goes through `authorize` (no `ToolRisk`); the sub-agent's own calls do.

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `delegate_task` (`agent`, `title`, `task`) | none (handled in the loop) | no | run another profile as a sub-agent and get its final text |

Built-in tools a profile can list (`BUILTIN_TOOLS`): `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`, `office_read`, `office_create`, `office_edit`, `generate_image`, `compose_image`, `instagram_publish`. Names that match nothing are ignored. Risk of each tool: [references/tools.md](../references/tools.md).

## Settings and data

| Setting | Default | Notes |
|---|---|---|
| `agents` | the nine profiles above | in `settings.json`; older files are migrated: Office tools added once, Multimedia added once (stays deleted if deleted later), `compose_image` added where `generate_image` exists |
| `defaultAgentId` | `general` | cannot be deleted from the editor |

Conversations, `subagents` and `toolStates` live in the thread store ([chat](chat.md)). Settings details: [settings](settings.md), [references/settings.md](../references/settings.md).

## Limits and rules

| Rule | Value | Source |
|---|---|---|
| Model turns per run | 80 (`MAX_ITERATIONS`); then the run ends silently | `agent.ts` |
| Tool result size sent to the model | 60 000 chars (first and last 30 000 kept, with "… [N caracteres omitidos] …") | `tools/types.ts` `truncateMiddle` |
| Sub-agent depth | one level; sub-agents never get `delegate_task` | `agent.ts` |
| Tool calls in one turn | run concurrently (`Promise.all`), results in call order in a single message | `agent.ts` |
| Runs per thread | 1 | `index.ts` |
| Company agent over budget | cannot start ("No puede trabajar: …") | `index.ts` |

The 60 000-character cap is applied to every run result, including MCP results flagged as errors and the sub-agent's final text. Error results built by the loop itself (invalid input, tool not available, thrown errors) are sent whole.

## Security and privacy

- The profile's instructions, the working folder path, the local date, vault fragments and memories are sent to the agent's provider ([providers](providers.md)).
- The profile's `tools` and `allowMcp` are the only per-agent capability limits besides approval. App tools are not limited by the profile (see below).
- Every non-`read` call is written to the audit trail with outcome, risk, thread, agent, who decided, argument names and, for `run_command`, the command line.
- A tool the loop does not know (an MCP tool) is treated as `exec` for approval.

## How it is tested

- With a test (`tests/agent.test.ts`): approve and run, deny, invalid input, no working folder, max-tokens cut, cancel with pending approval, parallel sub-agents, no nested delegation, per-agent auto-approve, dangling tool calls. `tests/defaults.test.ts`: unique ids and existing default, Multimedia and Vercel profiles.
- Not covered: unknown tool, refusal and plain max-tokens notices, the 80-turn cap, error-result handling, the 60 000 cap, MCP calls, sub-agent failure paths, all prompt-building pieces, settings migration, and the default profile set beyond the tested invariants.
- By hand: the whole agent editor (create, edit, discard, provider switch, delete rules) and the chat selector.

## Known limits

1. Hitting the 80-turn cap ends the run with no notice or error.
2. App tools (`send_telegram`, routines, mail, WhatsApp, house, vault) are offered to every agent, so a "read-only" Investigador can still message Telegram or create routines. Product decision: should the profile restrict them?
3. `delegate_task` looks up the target among all agents, so a guessed id of a company agent (or of itself) works although the roster never lists it.
4. The editor does not validate: empty Anthropic model, blank name or instructions can be saved.
5. `autoApproveTools` entries stay in the profile after the tool is unchecked and then become invisible in the editor.
6. The system prompt (with the date) is fixed for the whole run; a run crossing midnight keeps the old date.
7. Sub-agents of a voice conversation use their own profile's effort, not `low`.
8. Settings → Agentes hides company agents but the chat selector shows them.
9. Error results are not truncated, only successful ones.

Also: the spec's summary says "ten" default profiles; there are nine.

## See also

[chat](chat.md) · [approvals](approvals.md) · [providers](providers.md) · [settings](settings.md) · [companies](companies.md) · [mcp](mcp.md) · [vault-and-knowledge](vault-and-knowledge.md) · [files-and-commands](files-and-commands.md) · [references/tools.md](../references/tools.md) · [references/limits.md](../references/limits.md)
