# 015 — Plan

## 1. Approach
Six small tools (`read_file`, `list_dir`, `search_files`, `write_file`, `edit_file`, `run_command`) behind one contract: a Zod schema, a `ToolRisk`, a `run(input, ctx)` that returns a string and fails with `ToolError`. Every path goes through a single function, `resolveInWorkspace`, which canonicalizes the closest existing ancestor so symlinks and junctions cannot leave the folder. The tool never decides whether to ask: the agent loop validates the input, applies the approval policy by risk and only then calls `run`. Rejected: running commands in an OS sandbox or container (heavy on Windows, and a half-working sandbox gives false confidence); the confinement covers file tools only and `run_command` is gated by approval, as decided in [ADR 0012](../../../docs/adr/0012-approval-model.md).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/defaults.ts` (default profiles and their tool-name lists) | Profile defaults are read by coordinator and settings screen |
| coordinator | `src/coordinator/tools/types.ts` (contract, `ToolError`, `truncateMiddle`), `paths.ts` (`resolveInWorkspace`, `displayPath`), `fs.ts` (five file tools, `globToRegExp`), `shell.ts` (`run_command`, `commandEnv`), `index.ts` (`builtinTools`), `src/coordinator/agent.ts` (`executeTool`), `src/coordinator/approval.ts` | Disk, processes and the run loop; nothing here needs `electron` |
| main | none | |
| renderer | `src/renderer/src/components/ToolCard.tsx`, `src/renderer/src/lib/format.ts` (labels and one-line summaries) | Presentation only |

## 3. Contracts
- `ToolRisk = 'read' | 'write' | 'exec' | 'memory' | 'publish' | 'home'`.
- `ToolDefinition<I>`: `name`, `description` (Spanish), `risk`, `standalone?`, `schema` (Zod, also turned into JSON Schema by `jsonSchemaOf`), `run(input, ctx): Promise<string>`, `preview?(input, ctx)`; built with `defineTool`.
- `ToolContext`: `workspace`, `signal`, `settings`, `host`, plus optional `knowledge`, `threadId`, `agentId`, `saveRoutines`, `sendTelegram`, `sendTelegramPhoto`, `company`, `home`, `inboxDir`, `whatsapp`.
- Helpers: `resolveInWorkspace(workspace, path): string`, `displayPath(workspace, absolute): string`, `globToRegExp(glob): RegExp`, `commandEnv(env?): NodeJS.ProcessEnv`, `truncateMiddle(text, max?)`.
- Tools (name → `ToolRisk`): `read_file`, `list_dir`, `search_files` read; `write_file`, `edit_file` write; `run_command` exec.
- Inputs: `read_file {path, offset?, limit?}`, `list_dir {path?, depth?}`, `search_files {pattern, path?, glob?, case_sensitive?}`, `write_file {path, content}`, `edit_file {path, old_string, new_string, replace_all?}`, `run_command {command, timeout_seconds?}`.

## 4. Data and persistence
Tools write only into the person's workspace; they keep no state of their own. Tool results are stored with the thread; non-read calls leave an audit line (see `docs/security/CONTROLS.md`). Nothing is migrated.

## 5. Dependency injection
Tools receive everything through `ToolContext` (workspace, abort signal, settings). Tests use a temp directory as workspace and a fake `ToolContext`; `commandEnv` takes the environment as an argument so keys can be injected; the agent tests drive `runAgent` with a scripted provider and an `ApprovalBroker`.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-4.1 | `tests/tools.test.ts` → "resolves relative paths inside the workspace" | |
| AC-4.2 | `tests/tools.test.ts` → "rejects paths that escape the workspace" | `..`, absolute path elsewhere |
| AC-4.3 | `tests/tools.test.ts` → "requires a workspace" | |
| AC-1.1, AC-2.1 | `tests/tools.test.ts` → "writes nested files and reads them back numbered" | |
| AC-1.8, AC-7.8 | `tests/tools.test.ts` → "keeps the start and the end" | output over 60 000 characters |
| AC-1.9 | `tests/tools.test.ts` → "lists directories with folders first" | |
| AC-1.15 | `tests/tools.test.ts` → "searches text files and skips node_modules" | |
| AC-1.16 | `tests/tools.test.ts` → "matches simple and recursive globs" | `**`, `?`, case |
| AC-2.2 | `tests/tools.test.ts` → "refuses to write outside the workspace" | nothing written |
| AC-2.4 | `tests/tools.test.ts` → "edits a unique fragment and rejects ambiguous ones" | repeated, absent |
| AC-2.5 | `tests/tools.test.ts` → "does not treat $ in replacement text specially" | `$&`, `$1`, `$'` |
| AC-3.1 | `tests/tools.test.ts` → "runs in the workspace and reports the exit code" | |
| AC-3.2 | `tests/tools.test.ts` → "stops commands that exceed the timeout" | |
| AC-5.1 | `tests/web.test.ts` → "keeps the provider keys out of commands the model runs" | case-insensitive names |
| AC-7.1 | `tests/agent.test.ts` → "asks for approval, runs the tool and feeds the result back" | |
| AC-7.2 | `tests/agent.test.ts` → "returns an error result when the user denies" | |
| AC-7.3 | `tests/agent.test.ts` → "rejects invalid tool input without running it" | missing `content` |
| AC-7.4, AC-7.6 | `tests/agent.test.ts` → "never asks for read-only tools and blocks writes in read-only mode" | |
| AC-7.5 | `tests/agent.test.ts` → "does not ask for approval when there is no workspace" | |
| AC-4.4–4.9, 1.2–1.7, 1.10–1.14, 1.17–1.23, 2.3, 2.6–2.9, 3.3–3.9, 5.2, 7.7, 7.9–7.13 | [gap] | backlog: symlink and junction escape, UNC paths, binary and oversized files, cancellation |
| AC-7.14 | [manual] | run an agent against a folder and open each card |

## 7. Security and privacy impact
- Risk classes as in §3; `read` never asks, `write` and `exec` follow the approval mode, "siempre permitir" and auto-approve; mode "blocked" denies them.
- `run_command` is arbitrary code as the user and is not confined to the workspace; its environment drops Alma's provider keys but keeps everything else.
- File contents and command output go to the model provider.
- Docs: the "las claves no llegan a lo que el modelo ejecuta" control and risk R-03 in `docs/security/CONTROLS.md` and `docs/security/RISKS.md`.

## 8. Rollout
No setting. The tools exist for every agent whose profile lists them (General and Programador have all six, Investigador and Revisor only the three reads); a conversation without a working folder gets a clear error instead of an approval card. Default approval mode is "ask".
