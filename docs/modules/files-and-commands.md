# Files and commands

> The six workspace tools (read, list, search, write, edit files; run a command) that let an agent work inside the folder you picked for a conversation, plus the one tool contract every Alma tool follows. Spec: [015](../../.specify/specs/015-file-and-command-tools/spec.md). Test status: about 22 criteria with a test, about 44 without (the "[gap]" ones, mostly error messages and limits).

## What it does

**For the person.** An agent can look around your project folder, read and search files, create and edit files, and run commands such as builds, tests and git. Everything is confined to the **working folder** of the conversation (the one you choose with the folder button in the chat). Reading never asks you. Writing a file or running a command goes through the approval policy (see [approvals](approvals.md)).

**For an agent.** Six tools, all with Spanish descriptions and Spanish error messages so the model can correct itself:

- `read_file`, `list_dir`, `search_files`: look.
- `write_file`, `edit_file`: change files.
- `run_command`: PowerShell on Windows (bash elsewhere), with a time limit and cancel.

This module also defines how any tool call is validated, gated, run and shown (the `ToolDefinition` / `ToolContext` contract). Web, mail, vault, house and the rest all use it.

## How to use it

1. Open a conversation and press the **folder button** to pick the working folder. Without one, file tools fail with «No hay carpeta de trabajo seleccionada…» (no working folder selected) and nothing is asked.
2. Ask in chat. Real phrases:
   - «Leé `package.json` y decime qué scripts hay» (read it and tell me which scripts exist).
   - «Buscá dónde se usa `resolveInWorkspace`» (find where it is used).
   - «Corré los tests» (run the tests).
3. When the agent wants to write or run something, an approval card appears (unless you chose "allow all" or "always allow" for that tool). Each tool call shows as a card with a Spanish label ("Leer archivo", "Listar carpeta", "Buscar", "Escribir archivo", "Editar archivo", "Ejecutar comando"), a one-line summary and, expanded, the "Resultado" or "Error" in a monospace block.
4. Default agents: General, Programador and most others carry all six tools (via `FILE_TOOLS` in `src/shared/defaults.ts`); Investigador and Revisor carry only the three read tools (plus `office_read`).

## How it works

Files in `src/coordinator/tools/`:

| File | Role |
|---|---|
| `types.ts` | `ToolDefinition`, `ToolContext`, `ToolError`, `defineTool`, `truncateMiddle` |
| `paths.ts` | `resolveInWorkspace`, `displayPath` (confinement) |
| `fs.ts` | `read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, glob conversion |
| `shell.ts` | `run_command`, `commandEnv` |
| `index.ts` | `builtinTools` registry |
| `../agent.ts` | `executeTool`: validate, authorize, run, report; `appTools` |
| `../approval.ts` | the approval policy |

```
model asks tool_use ─► known tool? (builtin, app tool, MCP) ─no─► «La herramienta X no está disponible para este agente.»
        │ yes
        ▼
 Zod schema ─fail─► is_error result (INVALID_JSON + issues), nothing asked
        │ ok
        ▼
 needs workspace? (not `standalone`) ─none─► error, nothing asked
        │
        ▼
 approval (risk + mode + per-tool rules; `read` never asks) ─deny─► «No se ejecutó: Rechazado por vos…»
        │ allow
        ▼
 tool.run(input, ctx) ─► string (cut to 60 000 chars, start and end kept) ─► tool_result
        │ throws ToolError ─► message verbatim, is_error
        │ other error      ─► "Error: <message>", is_error
```

Non-obvious points:

- **Confinement** (`resolveInWorkspace`): resolves against the workspace's real path, rejects results outside it, and also rejects when the closest *existing* ancestor's real path is outside (so a junction or symlink inside the folder cannot lead out). Absolute paths inside the folder are accepted; an empty path means the root.
- **Confinement applies to the file tools only.** A command run with `run_command` can reach anywhere the user can.
- Several tool calls in one model turn run concurrently and come back in call order.
- A run stops after 80 model turns (`MAX_ITERATIONS`).
- `commandEnv` removes Alma's own provider keys from the command's environment and adds `CI=1`, `NO_COLOR=1`. Stdin is closed, so interactive prompts cannot hang.
- App tools (vault, routines, web, Telegram, `look_at_image`, house, mail, WhatsApp, company tools) are offered to every agent whatever its `profile.tools`; MCP tools are treated as risk `exec`.
- `ToolDefinition` = `name`, Spanish `description`, `risk`, optional `standalone`, Zod `schema` (also sent to the provider as JSON Schema), `run(input, ctx)` returning a string, optional `preview(input, ctx)` for the approval card (if `preview` throws, the card is shown without it).
- `ToolContext` carries `workspace`, `signal`, current `settings`, `host`, and optionally `knowledge`, `threadId`, `agentId`, `saveRoutines`, `sendTelegram`, `sendTelegramPhoto`, `company`, `home`, `inboxDir`, `whatsapp`. Tools take what they need from it; they do not import singletons (see [architecture](../architecture.md)).

## Tools for agents

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `read_file` | `read` | no | Read a text file with numbered lines (`offset`, `limit`). |
| `list_dir` | `read` | no | List a folder, folders first; `depth` 1–4. |
| `search_files` | `read` | no | Regex search over text files, optional `glob`, `case_sensitive`. |
| `write_file` | `write` | per mode | Create or fully replace a file (creates folders). |
| `edit_file` | `write` | per mode | Replace a unique `old_string` (or all with `replace_all`). |
| `run_command` | `exec` | per mode | Run a shell command in the workspace; `timeout_seconds` 1–600. |

"Per mode" means the approval mode decides: ask, auto-review, allow all, read-only (blocked, which denies these), plus per-tool "always allow" and per-agent auto-approve. See [approvals](approvals.md) and [references/tools.md](../references/tools.md).

In a **company**, `write_file`, `edit_file`, `office_create`, `office_edit`, `generate_image` and `compose_image` are auto-approved for the company agent (`COMPANY_AUTO_APPROVE` in `agent.ts`). `run_command` still asks. (Spec 015 BR-3 lists only the first two; the code has the longer list.)

## Settings and data

No settings of its own besides the approval mode and each agent's tool list. Nothing is stored by these tools: they read and write inside your working folder. Tool results are saved with the conversation. Audit lines for non-read calls go to the audit trail (see [security](security.md)).

## Limits and rules

| What | Value |
|---|---|
| Max file size to read or edit | 2 MiB (2 097 152 bytes) |
| `read_file` lines | default 2000, max 5000; `offset` and `limit` must be integers ≥ 1 |
| "Binary" file | a NUL byte in the first 8000 bytes |
| `list_dir` | depth 1–4 (default 1), stops at 1000 lines with "… (listado truncado)" |
| Folders never entered | `node_modules`, `.git`, `out`, `dist`, `build`, `.next`, `__pycache__`, `.venv` |
| `search_files` | skips files over 1 MiB and binaries; first 300 matches; each line cut to 300 characters |
| Any tool result | cut to 60 000 characters, middle replaced by "… [N caracteres omitidos] …" |
| `run_command` timeout | default 120 s, range 1–600 s |
| `run_command` output kept | head 200 000 + tail 200 000 characters while running, then 60 000 on return |
| Shell | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` on Windows; `$SHELL` or `/bin/bash` with `-lc` elsewhere |
| Stopping | `taskkill /T /F` on Windows, process-group kill on POSIX |
| Model turns per run | 80 |

Variables removed from the command environment (case-insensitive): `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `TELEGRAM_BOT_TOKEN`.

## Security and privacy

- **Confinement** of the file tools to the working folder (see "How it works"). A model that is tricked into `../../x` or a symlinked path gets a `ToolError`.
- **`run_command` is arbitrary code execution as you.** There is no sandbox and no command denylist; only approval gates it. It inherits your environment minus the eight keys above, so other secrets in your environment (a GitHub token, cloud credentials) are visible to the command. The mailbox password and other secrets kept in settings are not in the environment.
- Inputs are validated with the tool's Zod schema before anything else, including before the approval request.
- `write_file` replaces an existing file with no backup and no preview: the approval card shows the raw input.
- Everything an agent reads (file contents, command output) goes to the model provider.
- Rationale for the denylist approach: not documented.

## How it is tested

- `tests/tools.test.ts`: path resolution and escape rejection, numbered read/write round trip, `list_dir` ordering, search with `node_modules` skipped, glob matching, `edit_file` uniqueness and literal `$`, `run_command` exit code and timeout, `truncateMiddle`.
- `tests/web.test.ts`: `commandEnv` keeps provider keys out.
- `tests/agent.test.ts`: approval ask/allow/deny, invalid input, read-only mode, no-workspace behavior.
- Not covered: symlink and UNC rejection, size and binary limits, `search_files` caps and errors, `list_dir` depth and truncation, cancel signal, `ToolError` vs other errors, concurrent calls, audit lines.
- By hand: open a tool card in the chat and check the label, the one-line summary and the "Resultado"/"Error" block.

## Known limits

1. Command output decoding: chunks are decoded one by one as UTF-8, so a multi-byte character split across chunks can be corrupted, and PowerShell 5.1 may emit a non-UTF-8 code page.
2. `run_command` inherits the whole environment except eight named keys (denylist, not allowlist). Product decision.
3. A dangling symlink inside the workspace that points outside passes the check, so `write_file` could write through it.
4. Two `edit_file` calls on the same file in one model turn run concurrently and can race.
5. `write_file` has no preview (no diff) on the approval card. Product decision.
6. No line-ending normalization: an `old_string` with `\n` does not match a CRLF file.
7. `list_dir` says "truncated" when it hits exactly 1000 lines even if nothing was cut; symlinked entries show as plain names.
8. `displayPath` uses the workspace string as given while files resolve under its real path, so through a junction or 8.3 name the shown path could start with `..`.
9. An abort that fires just before the command's listener is registered is not noticed until the timeout.
10. Most of the limits above have no test (the "[gap]" criteria).

## See also

[approvals](approvals.md) · [agents](agents.md) · [chat](chat.md) · [web-and-mail](web-and-mail.md) · [office-and-drawings](office-and-drawings.md) · [images](images.md) · [security](security.md) · [references/tools.md](../references/tools.md) · [architecture](../architecture.md)
