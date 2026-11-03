# Agent tools reference

Every tool an agent can call, grouped by module. All rows were checked against the code (`defineTool({ name: … })` objects
and `agent.ts`). Tool names, risk values and file names are the literal ones from the code. For the behavior of each
module see the module docs: [files and commands](../modules/archivos-y-comandos.md), [office and drawings](../modules/office-y-dibujos.md),
[images](../modules/imagenes.md), [vault and knowledge](../modules/vault-y-conocimiento.md), [routines](../modules/rutinas.md),
[web and mail](../modules/web-y-correo.md), [Telegram](../modules/telegram.md), [WhatsApp](../modules/whatsapp.md),
[Instagram](../modules/instagram.md), [home](../modules/casa.md), [companies](../modules/empresas.md), [MCP](../modules/mcp.md),
[agents](../modules/agentes.md) and [approvals](../modules/aprobaciones.md).

## 1. Risk and approval

Each tool declares one `ToolRisk` (`src/coordinator/tools/types.ts:15`). The approval decision lives in `authorize()`
(`src/coordinator/approval.ts:135`), called from `executeTool()` in `src/coordinator/agent.ts:323`.

| Risk | Meaning (from the code comment) |
|---|---|
| `read` | Never needs approval. |
| `write` | Goes through the approval policy (changes files, devices, schedules, spends money on images). |
| `exec` | Goes through the approval policy (runs programs). Also the risk assigned to every MCP tool (see below). |
| `memory` | Alma's own notes in the vault, reminders, internal company task board, own Telegram chat. Written without asking; blocked only in read-only mode. |
| `home` | Everyday control of the house (lights, scenes, the plan). Like `memory`, never asks. |
| `publish` | Acts on the outside world in the user's name. The user approves every single call. |

Approval modes (`ApprovalMode`, `src/shared/types.ts:7`; labels in `src/renderer/src/lib/format.ts:3`; default
`needs-approval`, `src/shared/defaults.ts:199`):

| Risk | Pedir aprobación (`needs-approval`) | Auto-review (`auto-review`) | Permitir todo (`always-allow`) | Solo lectura (`blocked`) |
|---|---|---|---|---|
| `read` | Runs, no question | Runs, no question | Runs, no question | Runs, no question |
| `memory` | Runs, no question | Runs, no question | Runs, no question | Denied ("Bloqueado por el modo de aprobación") |
| `home` | Runs, no question | Runs, no question | Runs, no question | Denied |
| `write`, `exec` | Asks the user, unless the tool is in the agent's `autoApproveTools`, the company auto-approve list or `alwaysAllowTools` | A reviewer model judges it; `allow` runs it, `flag` asks the user (flagged), a reviewer error asks the user. The same exceptions skip the review | Runs, no question | Denied (the exceptions do not apply) |
| `publish` | Asks the user every time, with no "always allow" button | Same as Pedir: asks every time | Same: asks every time | Denied |

Details that matter and are easy to miss, all in `approval.ts`:

- Order of checks: `read` passes first, then `blocked` denies everything else (so in Solo lectura even `memory` and `home` tools stop), then `memory` and `home` pass, then `publish`, then the `autoApprove` / `alwaysAllowTools` lists, then the mode (`approval.ts:136-173`).
- `publish` ignores the mode, `autoApproveTools` and `alwaysAllowTools`. The approval card is built with `allowAlways = false`, so the choice "always" does not exist for it.
- In a company, `publish` first goes to the agent's boss, an LLM review in the boss's voice (`bossReview`). If the boss flags it, the call is rejected without reaching the user; if the boss allows it, the user is still asked. If the agent reports straight to the board (no boss), only the user is asked. If the boss review fails, the user is asked with the error as reason.
- Choosing "always" on a `write`/`exec` tool adds it to `alwaysAllowTools` (`src/coordinator/index.ts:237`); the rule is by tool name, not by input.
- Switching to Permitir todo needs a native confirmation dialog in the main process (`src/main/index.ts:359`). Its text says publications keep asking.
- `delegate_task` is not authorized as a tool: `executeTool` calls `delegate()` before `authorize()` (`agent.ts:338`). The subagent's own tool calls are authorized one by one.
- Tools that are not in the registry (every MCP tool) get `risk = 'exec'` (`agent.ts:374`), so they follow the `write`/`exec` row.
- `COMPANY_AUTO_APPROVE` (`agent.ts:25`): in a company, `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image` and `compose_image` are added to the auto-approve list. `run_command` still asks.
- Audit: every call whose risk is not `read` is recorded with `audit()` (`agent.ts:396`).
- Input is validated with the tool's Zod schema before anything runs; invalid input returns an error result and no approval is asked (`agent.ts:343`). Results go back through `truncateMiddle` (60,000 characters, see [limites.md](limites.md)).

## 2. Who gets which tools

`runAgent()` (`agent.ts:254`) builds the tool list of every run from three sources:

| Group | How it is offered | Tools |
|---|---|---|
| Profile tools ("builtin") | Only the names listed in the agent's `profile.tools` (see `builtinTools`, `src/coordinator/tools/index.ts`) | 12: `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`, `generate_image`, `compose_image`, `instagram_publish`, `office_read`, `office_create`, `office_edit` |
| App tools | Offered to every agent regardless of its profile (`appTools()`, `agent.ts:62`), each gated by a condition (table below) | 46 |
| Delegation | `delegate_task`, only if `profile.canDelegate`, depth 0, there is at least one other non-company agent, and the agent is not in a company (`agent.ts:260`) | 1 |
| MCP | All tools of connected MCP servers, only if `profile.allowMcp` | variable, named `mcp__<server>__<tool>` |

"Standalone" (`standalone: true`) means the tool does not touch the thread's workspace folder, so it works without one.
Builtin tools that are not standalone (`read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`,
`generate_image`, `compose_image`, `instagram_publish`) fail with "Sin carpeta de trabajo" when the conversation has no workspace
(`agent.ts:351`, which only checks tools found in the registry). The three office tools and every app tool are
`standalone`. MCP tools and `delegate_task` are not checked.

Conditions for the app tools (`agent.ts:62-74`):

| App tool group | Offered when |
|---|---|
| Vault and knowledge (7) | There is an active vault (`ctx.knowledge`). In a company run, it is the company's vault |
| Routines (4), web (2), `send_telegram`, `look_at_image` | Always |
| Home (19) | The house service exists, the setting `home.enabled` is on, and the agent is not a company agent |
| Mail (3) | Mail is configured: address, IMAP host, SMTP host and the app password are all set (`emailConfigured`, `tools/email.ts:12`) |
| WhatsApp (2) | The linked WhatsApp is on (a company only gets it when `company.whatsapp` is set) |
| Company (7) | Only when the run belongs to a company agent. These are the "company-only" tools |

MCP naming: `mcp__${server}__${tool}` with every character outside `[a-zA-Z0-9_-]` replaced by `_`, cut to 64 characters
(`qualify()`, `src/coordinator/mcp.ts:22`). The description shown to the model is `[MCP <server>] <description>` cut to 1024
characters. Because of the 64-character cut, two long tool names of the same server can collide.

Defaults: the general agents get `FILE_TOOLS` (`read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`,
`office_read`, `office_create`, `office_edit`) plus `generate_image` and `compose_image`; read-only profiles get `read_file`, `list_dir`, `search_files`, `office_read`
(`src/shared/defaults.ts`).

## 3. Tool table

Grouped by module. Columns: **name**, **module**, **risk**, **approval** (what happens in the normal modes, see section 1),
**purpose**, **source file** (under `src/coordinator/`). "Asks" in the approval column means Pedir and Auto-review ask
(Auto-review only when the reviewer flags it or fails) and Permitir todo does not; every non-`read` tool is denied in Solo lectura.
Availability: **profile** = needs the name in `profile.tools`; **app** = offered to every agent when its condition holds;
**company** = company agents only.

### Files and commands (profile tools)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `read_file` | files and commands | `read` | never asks | Read a text file in the workspace | `tools/fs.ts:55` |
| `list_dir` | files and commands | `read` | never asks | List a folder of the workspace | `tools/fs.ts:76` |
| `search_files` | files and commands | `read` | never asks | Regex search in the text files of the workspace (skips `node_modules`, `.git`, build folders) | `tools/fs.ts:110` |
| `write_file` | files and commands | `write` | asks (auto in companies) | Create or overwrite a file | `tools/fs.ts:150` |
| `edit_file` | files and commands | `write` | asks (auto in companies) | Replace text in an existing file | `tools/fs.ts:167` |
| `run_command` | files and commands | `exec` | asks, always, including in companies | Run a shell command (PowerShell on Windows, bash elsewhere); the command is also written to the audit trail | `tools/shell.ts:37` |

### Office documents (profile tools, standalone)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `office_read` | office | `read` | never asks | Read a Word, Excel, PowerPoint or PDF file | `tools/office/index.ts:34` |
| `office_create` | office | `write` | asks (auto in companies) | Create a Word, Excel or PowerPoint file | `tools/office/index.ts:112` |
| `office_edit` | office | `write` | asks (auto in companies) | Edit an existing office file | `tools/office/index.ts:174` |

### Images and Instagram (profile tools)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `generate_image` | images | `write` | asks (auto in companies) | Generate an image with an image model | `tools/media.ts:41` |
| `compose_image` | images | `write` | asks (auto in companies) | Build an original image from Alma's template library and the user's pieces; saves a PNG and an editable SVG | `tools/media.ts:66` |
| `instagram_publish` | Instagram | `publish` | always asks the user (boss first in a company), no "always" | Publish an image post to Instagram | `tools/media.ts:102` |

### Delegation (agents)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `delegate_task` | agents | none declared (not authorized) | not asked; the subagent's tools are | Hand a subtask (`agent`, `title`, `task`) to another agent, which works alone and returns its final text; several calls in one reply run in parallel | `agent.ts:24`, `agent.ts:116`, `agent.ts:436` |

### Vault, memory and knowledge (app tools, standalone, need an active vault)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `search_knowledge` | vault and knowledge | `read` | never asks | Semantic search over the vault | `knowledge/tools.ts:12` |
| `read_note` | vault and knowledge | `read` | never asks | Read a whole note by relative path | `knowledge/tools.ts:31` |
| `save_knowledge` | vault and knowledge | `memory` | never asks | Save durable knowledge as a note in the knowledge folder of the vault (no duplicates) | `knowledge/tools.ts:42` |
| `remember` | vault and knowledge | `memory` | never asks | Add a stable fact about the user to the memory file, one line per call | `knowledge/tools.ts:57` |
| `forget` | vault and knowledge | `memory` | never asks | Remove a memory line | `knowledge/tools.ts:68` |
| `excalidraw_read` | office and drawings | `read` | never asks | Read an Excalidraw drawing from the vault | `knowledge/tools.ts:97` |
| `excalidraw_draw` | office and drawings | `memory` | never asks | Create or modify an Excalidraw drawing in the vault | `knowledge/tools.ts:111` |

### Routines and reminders (app tools, standalone, always offered)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `create_reminder` | routines | `memory` | never asks | Schedule a reminder message | `tools/routines.ts:51` |
| `create_routine` | routines | `write` | asks | Schedule a routine: at the given time an agent runs a task alone in a new conversation | `tools/routines.ts:79` |
| `list_routines` | routines | `read` | never asks | List reminders and routines with id, schedule and state | `tools/routines.ts:111` |
| `delete_routine` | routines | `memory` | never asks | Delete a reminder or routine by id | `tools/routines.ts:126` |

### Web (app tools, standalone, always offered)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `web_search` | web and mail | `read` | never asks | Search the web; returns title, link and snippet | `tools/web.ts:116` |
| `fetch_url` | web and mail | `read` | never asks | Fetch a page and return it as text; private hosts are refused | `tools/web.ts:145` |

### Mail (app tools, standalone, only when mail is configured)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `email_search` | web and mail | `read` | never asks | Search the mailbox (most recent mails; Gmail search syntax in `query`) | `tools/email.ts:64` |
| `email_read` | web and mail | `read` | never asks | Read a full mail by the uid from `email_search` | `tools/email.ts:98` |
| `email_send` | web and mail | `publish` | always asks the user (boss first in a company) | Send a mail over SMTP | `tools/email.ts:130` |

### Telegram and WhatsApp (app tools, standalone)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `send_telegram` | Telegram | `memory` | never asks | Message (or send a picture to) the user's own Telegram chat with the bot, never other people. Always offered; fails if Telegram is not connected | `tools/telegram.ts:8` |
| `send_whatsapp` | WhatsApp | `publish` | always asks the user (boss first in a company) | Send a WhatsApp message from the user's number to a contact | `tools/whatsapp.ts:14` |
| `whatsapp_recent` | WhatsApp | `read` | never asks | Messages received since Alma is open (not old history) | `tools/whatsapp.ts:36` |

### Home (app tools, standalone, only when `home.enabled` and the agent is not a company agent)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `home_overview` | home | `read` | never asks | Rooms, devices with state, modes and rules | `tools/home.ts:141` |
| `home_find` | home | `read` | never asks | Find devices by words and return their ids | `tools/home.ts:173` |
| `home_control` | home | `home` | never asks | Everyday control (lights, plugs, covers, speakers) | `tools/home.ts:184` |
| `home_secure_control` | home | `publish` | always asks the user | Locks, alarms, sirens, gates and garage doors | `tools/home.ts:204` |
| `home_call_service` | home | `write` | asks | Call any Home Assistant service directly | `tools/home.ts:239` |
| `home_add_device` | home | `write` | asks | Start adding a device | `tools/home.ts:287` |
| `home_edit_device` | home | `write` | asks | Rename a device or move it to another room | `tools/home.ts:314` |
| `home_remove_device` | home | `write` | asks | Remove (or hide) a device | `tools/home.ts:329` |
| `home_plan` | home | `read` | never asks | Show the floor plan: floors, rooms, device positions | `tools/home.ts:342` |
| `home_plan_edit` | home | `home` | never asks | Edit the plan: floors, rooms, doors and device positions, several operations per call | `tools/home.ts:369` |
| `home_plan_from_drawing` | home | `home` | never asks | Build the rooms of a floor from an Excalidraw drawing in the vault | `tools/home.ts:398` |
| `home_plan_from_image` | home | `home` | never asks | Build the rooms of a floor by looking at a picture | `tools/home.ts:420` |
| `camera_look` | home | `write` | asks | Take a photo from a house camera and answer what is seen | `tools/home.ts:454` |
| `camera_photo` | home | `write` | asks | Take a photo and send it to Telegram without analyzing it | `tools/home.ts:480` |
| `camera_watch` | home | `write` | asks | Watch a camera for a limited time and notify the user (notification and Telegram, with photo) when a condition is met; `action` start / stop / list | `tools/home.ts:499` |
| `home_scene` | home | `home` | never asks | Activate a mode (scene) by name | `tools/home.ts:534` |
| `home_modes` | home | `write` | asks | Create, show or delete modes (scenes) | `tools/home.ts:551` |
| `home_rules` | home | `write` | asks | `create_automation` (Home Assistant automation), `create_judgment` (rule where Alma wakes up, looks and decides), plus list / toggle / delete | `tools/home.ts:593` |
| `home_history` | home | `read` | never asks | Recent history of a device or sensor | `tools/home.ts:655` |

`look_at_image` is defined in `tools/home.ts` but is not part of the `homeTools` array; `appTools()` adds it on its own, so
it is offered to every agent, with or without the house.

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `look_at_image` | images / home | `read` | never asks | Look at an image (a picture the user sent, a capture, a vault image) and answer a question about it | `tools/home.ts:443` |

### Company tools (company agents only, standalone)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `assign_task` | companies | `memory` | never asks | Give a task to someone on your team | `tools/company.ts:21` |
| `update_task` | companies | `memory` | never asks | Report your task as `review`, `done` or `blocked` (blocked tells the boss) | `tools/company.ts:41` |
| `review_task` | companies | `memory` | never asks | Approve a team delivery or send it back with what to fix | `tools/company.ts:53` |
| `list_tasks` | companies | `read` | never asks | List tasks of yours, your team or the company | `tools/company.ts:65` |
| `ask_colleague` | companies | `memory` | never asks | Ask your boss, a report or a dotted-line colleague a quick question without creating a task | `tools/company.ts:86` |
| `escalate` | companies | `memory` | never asks | Pass a decision, problem or approval request to the boss (or to the user, if there is no boss) | `tools/company.ts:103` |
| `schedule_meeting` | companies | `memory` | never asks | Schedule a meeting among members | `tools/company.ts:115` |

### MCP tools (dynamic)

| name | module | risk | approval | purpose | source file |
|---|---|---|---|---|---|
| `mcp__<server>__<tool>` | MCP | `exec` (fixed by `agent.ts:374`; there is no per-tool risk) | asks like `write`/`exec`; never `read` | Any tool of a connected MCP server, for agents with `allowMcp` | `mcp.ts:22`, `agent.ts:266` |

## 4. Count

| Group | Tools |
|---|---|
| Profile tools (files 5, shell 1, images 3, office 3) | 12 |
| App tools: vault and knowledge 7, routines 4, web 2, `send_telegram` 1, `look_at_image` 1, home 19, mail 3, WhatsApp 2, company 7 | 46 |
| `delegate_task` | 1 |
| **Total fixed tools registered in code** | **59** |
| MCP tools | variable (one per tool of each connected server) |

By risk, over the 59 fixed tools: `read` 19, `memory` 13, `home` 5, `write` 16, `exec` 1, `publish` 4 (`instagram_publish`, `email_send`,
`send_whatsapp`, `home_secure_control`); `delegate_task` has no risk (19 + 13 + 5 + 16 + 1 + 4 = 58, plus `delegate_task` = 59).

Written by hand from the code; when you add a row, verify the name in the code.
