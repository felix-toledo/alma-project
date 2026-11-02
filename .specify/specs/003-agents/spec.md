---
status: implemented
---

# 003 — Agentes

## 1. Summary
An **agent profile** is a named configuration (instructions, provider, model, effort, tools) that the person edits in
Configuración → Agentes. Alma ships nine default profiles. Each conversation is run by one profile: the agent loop sends the
conversation to the profile's model, runs the tools the model asks for (after the approval policy), feeds the results back and
repeats until the model stops asking for tools. A profile that may delegate can hand independent subtasks to other profiles
with `delegate_task`; those subagents run in parallel, each in its own message history, and return their final text.

## 2. Problem and goal
One model with one prompt and every tool is a poor fit for very different jobs (read-only research, coding with commands,
publishing to Instagram, a different vendor's model). Goal: the person defines several agents, picks one per conversation (or
per channel/routine), and the main agent can split work across specialists without the work fanning out without bound.

## 3. Scope
**In:**
- the default profile set and the editable profile fields (name, description, instructions, provider, model, effort, tools, MCP
  on/off, may-delegate, per-agent no-approval tools);
- the run loop in `src/coordinator/agent.ts`: turns, iteration cap, parallel tool execution, tool-result handling, abort, errors,
  repair of a history cut off mid-tool-call;
- `delegate_task` and subagents (parallelism, depth limit, what they inherit);
- what goes into the system prompt each turn and which tools a run is offered;
- the agent editor tab (`AgentsTab` in `src/renderer/src/components/SettingsDialog.tsx`) and the per-chat agent selector.

**Out (and why):**
- approval modes, "siempre permitir", auto-review policy, previews: `../004-approvals/spec.md`;
- provider clients, API keys, model lists, streaming, retries: `../005-providers/spec.md`;
- the settings dialog as a whole (other tabs, persistence of settings.json): `../006-settings/spec.md`;
- company seats (org chart, tasks, budgets, company agents' prompt): `../007-companies/spec.md`;
- the chat UI, message list and thread storage: `../002-chat/spec.md`;
- what each individual tool does (files, shell, web, mail, house, Office, images): specs 015, 016, 020, 021, 013/014;
- vault recall itself (how fragments are found): `../008-vault/spec.md`, `../009-knowledge-and-memory/spec.md`;
- routines/Telegram/WhatsApp/voice choosing an agent: 018, 010, 011, 019 (this spec only states the fallback rule, BR-14).

## 4. Users and stories
- **US-1** As a person, I want an agent to carry out a request using tools (asking me when needed), so that the work gets done on my computer.
- **US-2** As a person, I want to stop a running agent, so that I stay in control.
- **US-3** As a person, I want the main agent to split independent work across specialist agents running in parallel, so that big tasks finish faster.
- **US-4** As a person, I want to create and edit agents (model, instructions, tools), so that each one fits a job and a vendor.
- **US-5** As a person, I want an agent to know where it is, what day it is and what my notes say, so that its answers are grounded.
- **US-6** As a person, I want a conversation whose app closed mid-action to remain usable, so that I never have a broken thread.
- **US-7** As a person, I want to choose which agent answers a conversation, so that I can switch specialists.

## 5. Acceptance criteria

### Run loop (US-1, US-2, US-6)
- **AC-1.1** (US-1) Given the model asks for `write_file` and the person approves, when the run continues, then the tool runs, its result is sent back to the model, the run ends with the model's final text, and the thread holds user / assistant / tool-result / assistant messages. Test: tests/agent.test.ts › "asks for approval, runs the tool and feeds the result back"
- **AC-1.2** (US-1) Given the person denies a tool call, when the model gets the result, then it is an error result starting "No se ejecutó: Rechazado por vos…" and the tool state is `denied`. Test: tests/agent.test.ts › "returns an error result when the user denies"
- **AC-1.3** (US-1) Given the model asks for a tool whose input does not match its schema, when the call is handled, then nothing runs and the model receives an error result containing `INVALID_JSON` and the validation issues. Test: tests/agent.test.ts › "rejects invalid tool input without running it"
- **AC-1.4** (US-1) Given the model asks for a tool that is not among the tools offered to this agent, when the call is handled, then the model gets the error "La herramienta X no está disponible para este agente." and the tool state is `error` ("Herramienta no disponible"). [gap]
- **AC-1.5** (US-1) Given a built-in tool that acts on the workspace and the conversation has no working folder, when the model calls it, then no approval is requested and the model gets "No hay carpeta de trabajo seleccionada…". Test: tests/agent.test.ts › "does not ask for approval when there is no workspace"
- **AC-1.6** (US-1) Given several tool calls in one model turn, when they are executed, then they are started together (not one after another) and all results go back in a single user message in the same order as the calls. [gap]
- **AC-1.7** (US-1) Given a turn that stopped for `max_tokens` with tool calls in it, when the loop handles it, then none of the tools run, each call gets an error result saying the input was truncated, and the loop goes on to the next turn. Test: tests/agent.test.ts › "does not run tools from a turn cut off by max_tokens"
- **AC-1.8** (US-1) Given a turn that stopped with `refusal`, when the loop handles it, then the assistant message carries the notice "El modelo rechazó la solicitud." (plus the provider's detail, if any), no tool of that turn runs, and the run ends. [gap]
- **AC-1.9** (US-1) Given a turn that stopped with `max_tokens` and no tool calls, when the loop handles it, then the assistant message carries the notice "La respuesta se cortó por el límite de tokens." and the run ends. [gap]
- **AC-1.10** (US-1) Given a model that keeps asking for tools, when 80 model turns have been made, then the loop stops without error and returns the last assistant text (possibly empty). [gap]
- **AC-1.11** (US-1) Given a tool whose `run` throws a `ToolError`, when handled, then the model gets that message as an error result; given any other exception, it gets `Error: <message>`; in both cases the tool state is `error` and the run continues. [gap]
- **AC-1.12** (US-1) Given a tool result longer than 60 000 characters, when it is returned to the model, then only the first and last 30 000 characters are kept with a "… [N caracteres omitidos] …" marker in the middle. [gap]
- **AC-1.13** (US-1) Given an MCP tool (agent allows MCP), when the model calls it, then it goes through the same approval check as `exec`, and its text result (error flag included) is returned to the model. [gap]
- **AC-1.14** (US-1) Given each assistant turn, when it arrives, then a `message` event is emitted and the thread is persisted before the tools run, and again after the tool results are appended. [gap]
- **AC-1.15** (US-1) Given any model turn that reports usage, when the turn ends, then the usage is stored on the assistant message and passed to the run's `onUsage` callback (only company runs set one). [gap]
- **AC-2.1** (US-2) Given a run waiting for an approval, when the person stops it, then the pending approval is denied with note "Cancelado", the tool does not run, and the history ends with a tool-result message. Test: tests/agent.test.ts › "denies pending approvals when the run is cancelled"
- **AC-2.2** (US-2) Given the run is aborted while the model streams, when the provider rejects, then the run ends without an error being shown to the person (an aborted run is a cancellation, not a failure). [gap]
- **AC-2.3** (US-2) Given the signal is aborted before a tool call is handled, when it is handled, then the model gets "Cancelado por el usuario." and the state is `denied` ("Cancelado"). [gap]
- **AC-2.4** (US-1) Given the agent's provider has no usable key, when a run starts, then the run ends with the provider's configuration error ("Falta la API key de …") shown on the conversation. [gap]
- **AC-2.5** (US-1) Given a conversation is already running, when another message is sent to it, then it is refused with "Ya hay una ejecución en curso en esta conversación." [gap]
- **AC-6.1** (US-6) Given a history whose last message is an assistant message with tool calls and no results, when the next message is sent, then every dangling call is closed with an error result ("Interrumpido: la app se cerró…") before the new user message, and a history that is already consistent is left alone. Test: tests/agent.test.ts › "closes tool calls left without results"

### Subagents (US-3)
- **AC-3.1** (US-3) Given two `delegate_task` calls in one turn, when they run, then both subagents run at the same time, each gets only its task as its first message, and the parent receives both final texts in order. Test: tests/agent.test.ts › "runs delegated subagents in parallel and returns their results"
- **AC-3.2** (US-3) Given a subagent run, when it starts and ends, then it is recorded in the thread (`subagents[id]` with agent name, title, task, status `running` → `done`, its own messages) and `subagent.started` / `subagent.finished` events are emitted. Test: tests/agent.test.ts › "runs delegated subagents in parallel and returns their results"
- **AC-3.3** (US-3) Given a subagent, when its tools are offered, then `delegate_task` is not among them even if its profile has `canDelegate`. Test: tests/agent.test.ts › "does not let subagents delegate further"
- **AC-3.4** (US-3) Given a profile with `canDelegate` at the top level, when the tools are built, then `delegate_task` is offered. Test: tests/agent.test.ts › "runs delegated subagents in parallel and returns their results"
- **AC-3.11** (US-3) Given `canDelegate` false, or no other non-company agent, or a company agent, when the tools are built, then `delegate_task` is not offered; when offered, its description lists every other non-company agent as id, name and description. [gap]
- **AC-3.5** (US-3) Given `delegate_task` names an agent id that does not exist, when handled, then the model gets `No existe el agente "<id>".` and the state is `error`. [gap]
- **AC-3.6** (US-3) Given `delegate_task` input missing `agent`, `title` or `task`, when handled, then the model gets an `INVALID_JSON` error result. [gap]
- **AC-3.7** (US-3) Given a subagent that fails with an exception, when handled, then the parent gets "El subagente <nombre> falló: <mensaje>" as an error result, the run is marked `error` (or `cancelled` if the run was aborted) and `subagent.finished` is still emitted. [gap]
- **AC-3.8** (US-3) Given a subagent that ends with no text, when handled, then the parent receives "(el subagente terminó sin una respuesta de texto)". [gap]
- **AC-3.9** (US-3) Given a subagent runs a tool that needs approval, when the request is sent, then it is tagged with the subagent's id so the person can tell which subagent asks. [gap]
- **AC-3.10** (US-3) Given a subagent, when its system prompt is built, then it contains "Sos un subagente…" and no channel guide (voice, Telegram, WhatsApp) even if the conversation came from a channel. [gap]

### Profiles and editor (US-4, US-7)
- **AC-4.1** (US-4) Given a fresh install, when settings are created, then the agent ids are unique, the default agent id (`general`) is one of them, and every tool a default agent lists exists in `BUILTIN_TOOLS`. Test: tests/defaults.test.ts › "has unique agent ids and a default agent that exists"
- **AC-4.2** (US-4) Given the default set, then it contains General, Investigador, Programador, Revisor, Grok, DeepSeek, Vercel AI Gateway, Multimedia and Community Manager with the tools and flags of BR-1. [gap] (only Multimedia, Vercel and the id/default invariants are tested)
- **AC-4.15** (US-4) Given the Multimedia default agent, then it exists, can write files and run commands, and its prompt explains Remotion rendering. Test: tests/defaults.test.ts › "ships a Multimedia agent that can run Remotion and only uses known tools"
- **AC-4.3** (US-4) Given the Vercel profile, then its provider is `vercel` and settings have an empty key slot for it. Test: tests/defaults.test.ts › "ships a Vercel AI Gateway agent with its own key slot"
- **AC-4.4** (US-4) Given the Multimedia agent, then it can run commands but `run_command` is not in its no-approval list. Test: tests/defaults.test.ts › "ships a Multimedia agent that can run Remotion and only uses known tools"
- **AC-4.5** (US-4) Given an agent with its own no-approval tools (Community Manager, `write_file`), when the model calls one in "needs-approval" mode, then it runs without asking and the note reads "Permitido para este agente". Test: tests/agent.test.ts › "lets an agent run its own auto-approved tools without asking"
- **AC-4.6** (US-4) Given an agent that lists `instagram_publish` in its no-approval list, when it publishes, then the person is still asked. Test: tests/agent.test.ts › "always asks before publishing, even when everything else is allowed"
- **AC-4.7** (US-4) [manual] Settings → Agentes lists the non-company agents with provider name and "· por defecto" on the default one; selecting one fills the form; "+ Nuevo agente" saves and selects a new profile ("Nuevo agente", Anthropic, first Claude model, effort `medium`, tools `read_file`, `list_dir`, `search_files`, MCP off, no delegation). Check by opening the tab.
- **AC-4.8** (US-4) [manual] Editing any field enables "Guardar cambios" and "Descartar"; saving replaces the profile in settings; discarding restores the saved values. Check by editing and reopening the tab.
- **AC-4.9** (US-4) [manual] Changing the provider in the form resets the model (first Claude model for Anthropic, empty for the others) and swaps the suggestion list; the refresh button next to the model field fetches the provider's model list and shows an error under the field if it fails; the label hints what an empty model means. Check with a configured and an unconfigured provider.
- **AC-4.10** (US-4) [manual] The "Sin pedir aprobación" group offers only the agent's currently checked tools that are not read-only and are not `instagram_publish`. Check by toggling tools.
- **AC-4.11** (US-4) [manual] "Usar por defecto" sets the default agent; "Borrar" asks "¿Borrar el agente «…»?" and is disabled for the default agent (tooltip "Elegí otro agente por defecto antes de borrar este") and when only one agent exists. Check by trying both.
- **AC-4.12** (US-7) [manual] The chat header's "Agente" selector lists every agent (company ones included) and changing it applies to the conversation from the next message; the footer shows the agent's model (or "modelo automático") and effort. Check in a chat.
- **AC-4.13** (US-7) Given a conversation whose agent id no longer exists, when a message is sent, then the first agent in the list answers. [gap]
- **AC-4.14** (US-4) Given a settings file saved by an older version, when it is loaded, then agents get the Office tools once, the Multimedia agent is added once (and stays deleted if later deleted), and agents with `generate_image` get `compose_image`. [gap]

### Prompt and context (US-5)
- **AC-5.1** (US-5) Given any run, when the system prompt is built, then it contains the profile's instructions, the working folder (or a request to pick one when none), the shell name (PowerShell on Windows), a statement that Internet is available through `web_search`/`fetch_url`, and the local date, time and time zone. [gap]
- **AC-5.2** (US-5) Given an open vault, when a run starts, then the memories and the vault fragments closest to the latest user text are added to the system prompt once for the whole run, followed by the knowledge guide; if recall fails the run continues without them. [gap]
- **AC-5.3** (US-5) Given a voice conversation at top level, when each turn is requested, then the effort is `low` instead of the profile's effort. [gap]
- **AC-5.4** (US-5) Given a profile that has an Office tool, when the prompt is built, then the Office guide is appended. [gap]
- **AC-5.5** (US-5) Given the house is enabled and the run is not a company's, when the prompt is built, then the house guide is appended and the home tools are offered; given a company agent, neither. [gap]
- **AC-5.6** (US-5) Given a company agent, when the prompt is built, then it contains the company, mission, goals, the agent's position, boss, team and colleagues. [gap]
- **AC-5.7** (US-5) Given a top-level run from voice, WhatsApp, Telegram or a company, when the prompt is built, then the matching channel guide is appended. [gap]
- **AC-5.8** (US-5) Given any agent, when tools are built, then the app tools (routines, web, `send_telegram`, `look_at_image`; vault tools if a vault is open; mail tools if mail is configured; WhatsApp tools if linked) are offered even if the profile does not list them. [gap]

## 6. Business rules
- **BR-1** Default profiles, in order (`src/shared/defaults.ts`): `general` (General: main agent, may delegate, MCP on, Claude, effort `high`); `investigador` (read-only tools `read_file`, `list_dir`, `search_files`, `office_read`; `medium`; no MCP; no delegation); `programador` (all file tools, commands, Office, images; `medium`; MCP on; no delegation); `revisor` (read-only like Investigador; code review with evidence); `grok` (xAI, empty model, `high`, may delegate); `deepseek` (DeepSeek, empty model, `high`, may delegate); `vercel` ("Vercel AI Gateway", empty model, `high`, may delegate); `multimedia` (Remotion video producer; all file tools; `medium`; no MCP; auto-approves `generate_image`, `compose_image`, `write_file`, `edit_file`); `community-manager` (Instagram posts; file read/write/edit, Office, images and `instagram_publish`, no `run_command`; `medium`; auto-approves `generate_image`, `compose_image`, `write_file`, `edit_file`). General, Programador, Grok, DeepSeek, Vercel and Multimedia also get `generate_image` and `compose_image`. Anthropic defaults use `claude-opus-5-5`.
- **BR-2** `AgentProfile` fields: `id`, `name`, `description` (read by other agents and shown in the chat welcome), `systemPrompt`, `provider` (`anthropic`, `xai`, `deepseek`, `vercel`, `meta`), `model` (empty = provider default, see spec 005), `effort` (`low`, `medium`, `high`, `xhigh`, `max`), `tools` (built-in tool names), `allowMcp`, `canDelegate`, optional `companyId`, optional `autoApproveTools`. (`src/shared/types.ts`)
- **BR-3** Built-in tools an agent can be given (`BUILTIN_TOOLS`): `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`, `office_read`, `office_create`, `office_edit`, `generate_image`, `compose_image`, `instagram_publish`. Names in a profile that match no built-in tool are ignored. (`src/shared/defaults.ts`, `src/coordinator/tools/index.ts`)
- **BR-4** A run stops after 80 model turns. (`MAX_ITERATIONS`, src/coordinator/agent.ts)
- **BR-5** Every tool result sent to the model is capped at 60 000 characters (first and last half kept) except error results, which are sent whole. (`truncateMiddle`, src/coordinator/tools/types.ts)
- **BR-6** The tools a run offers are: the profile's built-in tools; `delegate_task` (BR-8); the app tools every agent gets (vault tools if a vault is open, routine/reminder tools, `web_search`, `fetch_url`, `send_telegram`, `look_at_image`, house tools if the house is on and the agent is not a company's, mail tools if mail is configured, WhatsApp tools if linked, company tools for company agents); and the MCP tools if `allowMcp`. (src/coordinator/agent.ts)
- **BR-7** Tool inputs are validated against the tool's schema before anything runs; MCP tools are not validated here. A tool whose risk is unknown (MCP) is treated as `exec` for approval. (src/coordinator/agent.ts)
- **BR-8** Delegation: only a top-level run (depth 0) whose profile has `canDelegate`, that is not a company agent, and with at least one other non-company agent, is offered `delegate_task` (`agent`, `title`, `task`). Subagents are one level deep and are never offered it. (src/coordinator/agent.ts)
- **BR-9** A subagent starts with only its `task` as a message (it does not see the parent conversation), runs with its own profile (provider, model, tools, no-approval list), and shares the parent's working folder, abort signal, approval broker, vault, MCP connections, settings and channels; its approvals carry the subagent id. Its final assistant text is the result the parent receives. The parent's tool call and the subagent run share the same id. (src/coordinator/agent.ts)
- **BR-10** Tool calls of one model turn are executed concurrently (`Promise.all`), including concurrent approval requests. (src/coordinator/agent.ts)
- **BR-11** The system prompt is built once per run (so it is stable across the tool iterations of that run and the provider's prompt cache can reuse it). Order: profile instructions; "Entorno" block (working folder, shell, Internet, local date and time); subagent notice (depth > 0); delegation note (when `delegate_task` is offered); channel guide (top level only); company context, or the house guide; Office guide (if the profile has an `office_*` tool); knowledge context. The date is therefore fixed at the start of a run. (src/coordinator/agent.ts)
- **BR-12** Per-agent no-approval tools (`autoApproveTools`) skip approval in every approval mode except read-only ("blocked", which denies them), and never for `publish`-risk tools, which always ask. Company agents additionally auto-approve `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image`, `compose_image`. A run may also carry extra auto-approved tools (e.g. a house rule's `camera_look`). (src/coordinator/agent.ts; policy in spec 004)
- **BR-13** Approval mode and rules are read live: a change in settings applies to the next tool call, and the tool receives fresh settings after its approval wait. (src/coordinator/agent.ts)
- **BR-14** Which agent runs a conversation: the thread's `agentId`; if that id no longer exists, the first agent in settings; a new chat uses `defaultAgentId`. Channels (Telegram, WhatsApp, voice), routines and house rules use their configured agent and fall back to `defaultAgentId` when it no longer exists. The default agent cannot be deleted from the editor. (src/coordinator/index.ts, SettingsDialog.tsx)
- **BR-15** Voice conversations at top level use effort `low`; every other run uses the profile's effort. (src/coordinator/agent.ts)
- **BR-16** A company agent whose member or company is over budget cannot start a run ("No puede trabajar: …"). (src/coordinator/index.ts; budgets in spec 007)
- **BR-17** A run emits streaming events per scope (parent thread or subagent): `stream.text`, `stream.thinking`, `stream.tool`, `message`, `tool.state`, `subagent.started`, `subagent.finished`, and the thread-level `run.started` / `run.finished`. (src/shared/types.ts)
- **BR-18** Non-read tool calls (risk other than `read`) are written to the audit trail with outcome (`ok`, `denied`, `error`), tool, risk, thread, agent, who decided, argument names and, for `run_command`, the command line. (src/coordinator/agent.ts; see spec 022)

## 7. Constraints and risks
- **Layers touched:** `shared` (`AgentProfile`, `Effort`, `defaults.ts`), `coordinator` (`agent.ts`, `tools/`, `providers/`, `index.ts` startRun), `main` (`settings.ts` loads/migrates agents), `renderer` (`SettingsDialog.tsx` AgentsTab, `ChatView.tsx` selector, `state.ts` run events).
- **Persistence:** agent profiles live in `settings.json` under the user data folder (see spec 006); conversations (messages, `subagents`, `toolStates`) in the thread store (spec 002). Subagent runs persist inside their thread.
- **Tools exposed here:** `delegate_task` (no `ToolRisk`: it is handled inside the loop and never goes through `authorize`; the subagent's own tool calls do).
- **Security / privacy:** the profile's instructions, the working folder path, the local date, vault fragments and memories are sent to the agent's provider. A profile's `tools` and `allowMcp` are the only per-agent capability limits besides approval; app tools are not limited by the profile.
- **Platform:** the shell named in the prompt is PowerShell on Windows, bash elsewhere; the time zone comes from the OS.
- **Risk:** an unvalidated profile can be saved (empty name, empty instructions, empty Anthropic model).
