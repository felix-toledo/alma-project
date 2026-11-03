---
status: implemented
---

# 015 — Herramientas de archivos y comandos

## 1. Summary
An agent can look around, read, search, create and edit files inside the conversation's working folder, and run PowerShell commands there (bash on non-Windows). Every path the model supplies is checked so it cannot leave that folder. Reads never ask the person; writes and commands go through the approval policy. The same `ToolDefinition` / `ToolContext` contract is shared by every tool in Alma (files, web, mail, vault, routines, house…), and this spec also records how a tool's result reaches the model and the screen.

## 2. Problem and goal
An agent that only talks is not useful on a computer; one that can touch any file or run anything is dangerous. Goal: a small, predictable set of workspace tools with bounded output, a hard confinement to the folder the person picked for the conversation, and a uniform way for tools to fail so the model can correct itself.

## 3. Scope
**In:** `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`; `resolveInWorkspace` / `displayPath`; glob handling; `commandEnv`; `truncateMiddle`; the `ToolDefinition`, `ToolContext`, `ToolRisk`, `ToolError`, `standalone`, `preview` contract; how `executeTool` validates, gates, runs and reports a tool call; how the tool card shows it.

**Out (and why):**
- The approval policy itself (modes, "siempre permitir", auto-review, boss review): `../004-approvals/spec.md`.
- The agent loop, profiles, delegation, which tools a profile carries: `../003-agents/spec.md`.
- Tool card layout and chat rendering: `../002-chat/spec.md`, `../023-app-shell-and-ui/spec.md`.
- Web and mail tools: `../016-web-and-mail/spec.md`. Office documents and drawings: `../021-office-documents-and-drawings/spec.md`. Images: `../020-images/spec.md`. Vault tools: `../008-vault/spec.md`. MCP tools: `../017-mcp/spec.md`.
- Security overview and audit trail: `../022-security-and-privacy/spec.md`. Settings dialog: `../006-settings/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want my agents to read and search my project folder, so that they can answer questions about it without me pasting files.
- **US-2** As a person, I want agents to create and edit files in that folder, so that the work ends up on disk, and I want to be asked before it happens (unless I allowed it).
- **US-3** As a person, I want agents to run builds, tests and git, so that they can verify their own work, with a time limit and a way to cancel.
- **US-4** As a person, I want no agent action to reach outside the working folder, even if the model is tricked or mistaken.
- **US-5** As a person, I want my provider keys kept out of the commands the model runs.
- **US-6** As an agent, I want clear, short Spanish error messages from tools, so that I can retry with a better input instead of getting stuck.
- **US-7** As the maintainer, I want one tool contract (name, risk, schema, run, optional preview), so that adding a tool is mechanical and the approval policy applies to it automatically.

## 5. Acceptance criteria

### Path confinement (US-4)
- **AC-4.1** (US-4) Given a workspace, when a relative path inside it is resolved, then the absolute path under the workspace is returned. Test: tests/tools.test.ts › "resolves relative paths inside the workspace"
- **AC-4.2** (US-4) Given a path with `..` that leaves the workspace, or an absolute path elsewhere, when it is resolved, then a `ToolError` "La ruta … está fuera de la carpeta de trabajo." is thrown. Test: tests/tools.test.ts › "rejects paths that escape the workspace"
- **AC-4.3** (US-4) Given no workspace string, when a path is resolved, then `ToolError` "No hay carpeta de trabajo seleccionada para esta conversación." Test: tests/tools.test.ts › "requires a workspace"
- **AC-4.4** (US-4) Given a workspace path that no longer exists on disk, when a path is resolved, then `ToolError` "La carpeta de trabajo no existe: <path>". [gap]
- **AC-4.5** (US-4) Given an absolute path that points inside the workspace, when resolved, then it is accepted. [gap]
- **AC-4.6** (US-4) Given a directory symlink/junction inside the workspace that points outside it, when a path through it (existing or not yet created) is resolved, then it is rejected, because the closest existing ancestor is canonicalized before the check. [gap]
- **AC-4.7** (US-4) Given a Windows UNC path (`\\server\share\x`) or a path on another drive, when resolved, then it is rejected as outside the workspace. [gap]
- **AC-4.8** (US-4) Given an empty `path`, when resolved, then it means the workspace root. [gap]
- **AC-4.9** (US-4) Given a file, when `displayPath` formats it, then it is relative to the workspace with forward slashes, and the root itself is shown as `.`. [gap]

### read_file (US-1)
- **AC-1.1** (US-1) Given a text file, when `read_file` runs with `offset` and `limit`, then it returns only those lines, each as `<line number><TAB><text>` (numbers right-aligned to a common width), followed by `… (N líneas en total)` when more lines remain. Test: tests/tools.test.ts › "writes nested files and reads them back numbered"
- **AC-1.2** (US-1) Given no `offset`/`limit`, when `read_file` runs, then it starts at line 1 and returns at most 2000 lines. [gap]
- **AC-1.3** (US-1) Given a path that does not exist, when `read_file` runs, then `ToolError` "No existe: <path>". [gap]
- **AC-1.4** (US-1) Given a path that is a folder, when `read_file` runs, then `ToolError` "<path> es una carpeta; usá list_dir." [gap]
- **AC-1.5** (US-1) Given a file larger than 2 MiB (2 097 152 bytes), when `read_file` runs, then `ToolError` "<path> pesa N bytes; es demasiado grande para leerlo entero." [gap]
- **AC-1.6** (US-1) Given a file whose first 8000 bytes contain a NUL byte, when `read_file` runs, then `ToolError` "<path> parece un archivo binario." [gap]
- **AC-1.7** (US-1) Given an input with `offset` < 1, `limit` < 1 or `limit` > 5000, or non-integers, when the call is validated, then it is rejected before running (see AC-7.3). [gap]
- **AC-1.8** (US-1) Given a result longer than 60 000 characters, when `read_file` returns, then the middle is replaced by `… [N caracteres omitidos] …`. Test: tests/tools.test.ts › "keeps the start and the end"

### list_dir (US-1)
- **AC-1.9** (US-1) Given a folder with sub-folders and files, when `list_dir` runs without arguments, then entries are listed folders first (names end in `/`), then files, each group in `localeCompare` order. Test: tests/tools.test.ts › "lists directories with folders first"
- **AC-1.10** (US-1) Given `depth` 2–4, when `list_dir` runs, then sub-folders are expanded to that depth with two spaces of indent per level, except `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `__pycache__`, `.venv`, which are listed but never entered. [gap]
- **AC-1.11** (US-1) Given an empty folder, when `list_dir` runs, then it returns "(carpeta vacía)". [gap]
- **AC-1.12** (US-1) Given a listing that reaches 1000 lines, when `list_dir` runs, then output stops at 1000 lines and ends with "… (listado truncado)". [gap]
- **AC-1.13** (US-1) Given a path that is a file or does not exist, when `list_dir` runs, then `ToolError` "No se puede listar <path>". [gap]
- **AC-1.14** (US-1) Given `depth` outside 1–4, when the call is validated, then it is rejected. [gap]

### search_files (US-1)
- **AC-1.15** (US-1) Given a pattern and a `glob`, when `search_files` runs, then it returns `path:line: text` for each matching line in matching text files, skipping `node_modules` and the other skipped folders. Test: tests/tools.test.ts › "searches text files and skips node_modules"
- **AC-1.16** (US-1) Given a simple glob (`*.ts`) or a recursive glob (`src/**/*.tsx`), when converted, then `*` does not cross `/`, `**` does (and `src/**/x` also matches `src/x`), `?` is one non-`/` character, and matching is case-insensitive. Test: tests/tools.test.ts › "matches simple and recursive globs"
- **AC-1.17** (US-1) Given a glob without a slash, when `search_files` filters, then it matches either the workspace-relative path or the file's base name. [gap]
- **AC-1.18** (US-1) Given no `case_sensitive`, when `search_files` runs, then the regex is case-insensitive; with `case_sensitive: true` it is not. [gap]
- **AC-1.19** (US-1) Given an invalid regular expression, when `search_files` runs, then `ToolError` "Expresión regular inválida: …". [gap]
- **AC-1.20** (US-1) Given no match, when `search_files` runs, then it returns "Sin coincidencias.". [gap]
- **AC-1.21** (US-1) Given more than 300 matching lines, when `search_files` runs, then it returns the first 300 followed by "… (más de 300 coincidencias; afiná la búsqueda)"; each line's text is trimmed and cut at 300 characters. [gap]
- **AC-1.22** (US-1) Given files larger than 1 MiB or binary files, when `search_files` walks, then they are skipped silently. [gap]
- **AC-1.23** (US-1) Given the run is aborted while walking, when `search_files` is running, then it stops walking and returns what it had found so far (no error). [gap]

### write_file / edit_file (US-2)
- **AC-2.1** (US-2) Given a path whose folders do not exist, when `write_file` runs, then the folders are created, the file is written as UTF-8, and the result is "Escrito <path> (N bytes).". Test: tests/tools.test.ts › "writes nested files and reads them back numbered"
- **AC-2.2** (US-2) Given a path outside the workspace, when `write_file` runs, then it fails with `ToolError` and nothing is written. Test: tests/tools.test.ts › "refuses to write outside the workspace"
- **AC-2.3** (US-2) Given an existing file, when `write_file` runs, then its content is replaced entirely without any prior check or backup. [gap]
- **AC-2.4** (US-2) Given an `old_string` that appears more than once and no `replace_all`, when `edit_file` runs, then `ToolError` "old_string aparece N veces…"; with a unique `old_string` the file is edited; with `replace_all` every occurrence is replaced; with an absent `old_string` the error is "old_string no aparece en el archivo…". Test: tests/tools.test.ts › "edits a unique fragment and rejects ambiguous ones"
- **AC-2.5** (US-2) Given a `new_string` containing `$&`, `$1` or `$'`, when `edit_file` runs, then it is inserted literally. Test: tests/tools.test.ts › "does not treat $ in replacement text specially"
- **AC-2.6** (US-2) Given a missing, folder, over-2-MiB or binary target, when `edit_file` runs, then the same errors as `read_file` (AC-1.3 to AC-1.6) are raised and nothing is written. [gap]
- **AC-2.7** (US-2) Given an empty `old_string`, when the call is validated, then it is rejected (`min(1)`). [gap]
- **AC-2.8** (US-2) Given a successful edit, when `edit_file` returns, then the result is "Editado <path> (1 reemplazo)." or "(N reemplazos)" when `replace_all` replaced several. [gap]
- **AC-2.9** (US-2) Given `write_file` targets an existing folder path, when it runs, then the raw filesystem error is returned as "Error: …" (not a `ToolError` message). [gap]

### run_command (US-3, US-5)
- **AC-3.1** (US-3) Given a command, when `run_command` runs, then it executes with the workspace as working directory and returns "Código de salida: N" followed by the combined stdout/stderr. Test: tests/tools.test.ts › "runs in the workspace and reports the exit code"
- **AC-3.2** (US-3) Given a command that outlives `timeout_seconds`, when the time passes, then the process tree is killed and the result starts "Proceso detenido: tiempo agotado tras Ns.". Test: tests/tools.test.ts › "stops commands that exceed the timeout"
- **AC-3.3** (US-3) Given no `timeout_seconds`, when `run_command` runs, then the limit is 120 s; values outside 1–600 or non-integers are rejected at validation. [gap]
- **AC-3.4** (US-3) Given the run is cancelled (abort signal) while the command is running, when the signal fires, then the process tree is killed and the result starts "Proceso detenido: cancelado por el usuario.". [gap]
- **AC-3.5** (US-3) Given a command that prints nothing, when it ends, then the output part is "(sin salida)". [gap]
- **AC-3.6** (US-3) Given a command that prints more than 400 000 characters, when output is buffered, then only the first 200 000 and last 200 000 are kept, and the final text is further cut to 60 000 with the middle omitted. [gap]
- **AC-3.7** (US-3) Given the shell cannot be started, when `run_command` runs, then the result is "No se pudo ejecutar el comando: <message>" (returned as a normal result, not thrown). [gap]
- **AC-3.8** (US-3) Given a workspace that is empty or missing on disk, when `run_command` runs, then the working directory is resolved like a file path and the same `ToolError`s as AC-4.3/AC-4.4 apply. [gap]
- **AC-3.9** (US-3) Given any command text, when `run_command` runs, then the tool itself applies no content filtering; only approval gates it. [gap]
- **AC-5.1** (US-5) Given an environment holding Alma's provider keys (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `TELEGRAM_BOT_TOKEN`, matched case-insensitively), when `commandEnv` builds the command's environment, then those variables are removed, everything else is kept, and `CI=1` and `NO_COLOR=1` are added. Test: tests/web.test.ts › "keeps the provider keys out of commands the model runs"
- **AC-5.2** (US-5) Given a command run, when the child process is spawned, then standard input is closed (no interactive prompts) and the process is hidden (`windowsHide`). [gap]

### Contract: validation, approval, errors, display (US-2, US-6, US-7)
- **AC-7.1** (US-2) Given a `write`/`exec` tool call and the default approval mode, when the agent calls it, then an approval request is shown first, the tool runs only after "allow", and the tool state ends `done` with note "Aprobado por vos". Test: tests/agent.test.ts › "asks for approval, runs the tool and feeds the result back"
- **AC-7.2** (US-2) Given the person denies, when the agent called `run_command`, then the command does not run, the model receives an error result starting "No se ejecutó: Rechazado por vos…", and the state is `denied`. Test: tests/agent.test.ts › "returns an error result when the user denies"
- **AC-7.3** (US-6) Given tool input that fails the Zod schema (e.g. `write_file` without `content`), when the agent calls it, then nothing runs, no approval is asked, and the model receives an `is_error` result whose content is JSON with `INVALID_JSON` and `issues`. Test: tests/agent.test.ts › "rejects invalid tool input without running it"
- **AC-7.4** (US-4) Given approval mode "blocked" (shown as read-only), when an agent calls `list_dir` and `write_file`, then the read runs without asking and the write is denied with note "Bloqueado por el modo de aprobación". Test: tests/agent.test.ts › "never asks for read-only tools and blocks writes in read-only mode"
- **AC-7.5** (US-6) Given a conversation without a working folder, when the agent calls a non-`standalone` tool such as `write_file`, then no approval is asked and the model receives the error "No hay carpeta de trabajo seleccionada. Pedile al usuario que elija una con el botón de carpeta." Test: tests/agent.test.ts › "does not ask for approval when there is no workspace"
- **AC-7.6** (US-7) Given a tool whose risk is `read`, when the agent calls it, then it never needs approval, whatever the mode (except that validation and workspace checks still apply). Test: tests/agent.test.ts › "never asks for read-only tools and blocks writes in read-only mode"
- **AC-7.7** (US-6) Given a tool throws a `ToolError`, when the agent catches it, then the model receives its message verbatim as an `is_error` result; any other thrown error is reported as "Error: <message>". [gap]
- **AC-7.8** (US-6) Given a tool result longer than 60 000 characters, when the agent builds the tool result, then it is cut in the middle with the omitted-characters marker. Test: tests/tools.test.ts › "keeps the start and the end"
- **AC-7.9** (US-7) Given a tool name not in the agent's profile tools nor in the always-offered app tools, when the model calls it, then the result is "La herramienta X no está disponible para este agente." [gap]
- **AC-7.10** (US-7) Given a tool declares a `preview`, when approval is requested, then the preview is attached to the request; if `preview` throws, the approval is asked without it. [gap]
- **AC-7.11** (US-7) Given a tool whose risk is not `read` ran, was denied or failed, when the call finishes, then an audit event (`tool.authorize` or `tool.run`, actor `agent`) is written with the risk, thread, agent, decision and argument names; for `run_command` the command text is included. Read tools are not audited. [gap]
- **AC-7.12** (US-7) Given the settings change while a call waits for approval, when the tool finally runs, then it receives the fresh settings. [gap]
- **AC-7.13** (US-6) Given several tool calls in one model turn, when they run, then they execute concurrently and their results come back in call order in one message. [gap]
- **AC-7.14** (US-6) [manual] In the chat, a file/command call shows a card with a Spanish label (e.g. "Leer archivo", "Ejecutar comando"), a one-line summary of the input (path, pattern and glob, or the command), and, when expanded, the result in a monospace block labelled "Resultado" or "Error". Checked by running an agent against a folder and opening the card.

## 6. Business rules
- **BR-1** The six workspace tools are registered in `builtinTools` and are only offered to an agent whose profile lists them (`profile.tools`). Default profiles: General and Programador have all six; Investigador and Revisor only `read_file`, `list_dir`, `search_files`. (src/coordinator/tools/index.ts, src/shared/defaults.ts)
- **BR-2** Risk classes: `read_file`, `list_dir`, `search_files` = `read`; `write_file`, `edit_file` = `write`; `run_command` = `exec`. `read` never asks; the rest follow the approval mode, per-tool "siempre permitir", per-agent auto-approve; mode "blocked" denies them. (src/coordinator/tools/*.ts, src/coordinator/approval.ts)
- **BR-3** In a company, `write_file` and `edit_file` are auto-approved for the company agent; `run_command` still asks. (src/coordinator/agent.ts `COMPANY_AUTO_APPROVE`)
- **BR-4** Every path argument goes through `resolveInWorkspace`: it resolves against the real path of the workspace, rejects results outside it, and also rejects when the closest existing ancestor's real path is outside (symlinks/junctions). (src/coordinator/tools/paths.ts)
- **BR-5** Limits: read file ≤ 2 MiB; `read_file` default 2000 lines, max 5000; search skips files > 1 MiB; text is "binary" if a NUL appears in the first 8000 bytes; `list_dir` depth 1–4 (default 1), cap 1000 lines; `search_files` cap 300 matches, 300 characters per matched line; any tool result is cut to 60 000 characters keeping start and end. (src/coordinator/tools/fs.ts, types.ts)
- **BR-6** Folders never searched or descended: `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `__pycache__`, `.venv`. (src/coordinator/tools/fs.ts)
- **BR-7** `run_command`: default timeout 120 s, range 1–600 s; command runs with `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` on Windows, `$SHELL` (or `/bin/bash`) with `-lc` elsewhere; stdin closed; kill is `taskkill /T /F` on Windows or the process group on POSIX; stdout and stderr are merged in arrival order. (src/coordinator/tools/shell.ts)
- **BR-8** The command environment is the app's own `process.env` minus Alma's provider keys, plus `CI=1` and `NO_COLOR=1`. The mailbox password and other secrets in settings are not in the environment. (src/coordinator/tools/shell.ts)
- **BR-9** A tool's failure is a thrown `ToolError` (message returned to the model) or any other error (returned as "Error: …"); either way the result is flagged `is_error` and the tool state is `error`. Tool messages are in Spanish rioplatense. (src/coordinator/tools/types.ts, src/coordinator/agent.ts)
- **BR-10** Inputs are validated with the tool's Zod schema before anything else, including before the approval request. (src/coordinator/agent.ts)
- **BR-11** A tool without `standalone: true` needs the conversation's workspace; without one it fails before asking for approval. `standalone: true` tools (web, mail, vault, routines, house, office, Telegram, WhatsApp, company) do not. (src/coordinator/tools/types.ts, src/coordinator/agent.ts)
- **BR-12** App tools (vault, routines, web, Telegram, `look_at_image`, house when enabled and not in a company, mail when configured, WhatsApp when linked, company tools in a company) are offered to every agent regardless of `profile.tools`. A tool call whose name is neither a builtin, an app tool nor an MCP tool is refused; MCP tools are treated as risk `exec`. (src/coordinator/agent.ts)
- **BR-13** `ToolDefinition` = `name`, `description` (Spanish, read by the model), `risk`, optional `standalone`, Zod `schema` (also converted to JSON Schema for the provider), `run(input, ctx): Promise<string>`, optional `preview(input, ctx)` for the approval card. A tool returns a string. (src/coordinator/tools/types.ts)
- **BR-14** `ToolContext` carries: `workspace`, `signal`, current `settings`, `host`, and optional `knowledge`, `threadId`, `agentId`, `saveRoutines`, `sendTelegram`, `sendTelegramPhoto`, `company`, `home`, `inboxDir`, `whatsapp`. Tools take what they need from it instead of globals. (src/coordinator/tools/types.ts)
- **BR-15** A run stops after 80 model turns. (src/coordinator/agent.ts `MAX_ITERATIONS`)
- **BR-16** Chat labels for the tools: read_file "Leer archivo", list_dir "Listar carpeta", search_files "Buscar", write_file "Escribir archivo", edit_file "Editar archivo", run_command "Ejecutar comando". (src/renderer/src/lib/format.ts)

## 7. Constraints and risks
- Layers touched: `coordinator` only for behavior (`src/coordinator/tools/{fs,shell,paths,types,index}.ts`, `src/coordinator/agent.ts`, `src/coordinator/approval.ts`); `shared` for default agents and tool-name lists (`src/shared/defaults.ts`); `renderer` for the card (`src/renderer/src/components/ToolCard.tsx`, `src/renderer/src/lib/format.ts`).
- Persistence: tools write only to the person's workspace folder; nothing of their own is stored. Tool results are saved with the thread (see 002). Audit lines for non-read calls go to the audit trail (see 022).
- Security / privacy: `run_command` is arbitrary code execution as the user, gated only by approval; there is no sandbox and no command denylist. Workspace confinement applies to the file tools, **not** to what a command can do. Commands inherit the user's environment minus the listed provider keys, so other secrets in the environment are visible. File contents and command output go to the model provider.
- Platform: Windows first (PowerShell 5.1 syntax; `-ExecutionPolicy Bypass`), POSIX fallback exists. Windows path comparison is case-insensitive via `path.relative`.
- Performance: `search_files` reads whole files sequentially; each matching file is read fully (≤ 1 MiB).

