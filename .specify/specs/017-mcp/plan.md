# 017 — Plan

## 1. Approach
One `McpManager` in the coordinator owns every connection. It reconciles the configured servers on each settings change (connect
new or changed entries, close removed ones), exposes the connected servers' tools to the agent loop as ordinary tool specs named
`mcp__<server>__<tool>`, and forwards calls through the MCP SDK client (`StdioClientTransport` or
`StreamableHTTPClientTransport`). The agent loop treats those tools as `exec` risk, so the existing approval policy applies with no
new mechanism. Adding or changing a local command is confirmed by the main process in a native dialog, because the page (and so a
prompt-injected renderer) must not be able to click it.

Rejected: letting the renderer or an agent register servers and start them directly. A stdio server is arbitrary code with the
user's permissions; the confirmation has to live where the page cannot answer it (see
[ADR 0012](../../../docs/adr/0012-approval-model.md) for the approval model it plugs into).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`McpServerConfig`, `McpServerStatus`, `mcp.*` messages), `src/shared/mcp-import.ts`, `src/shared/defaults.ts` | Types cross the process boundary; import parsing is pure and tested without a process |
| coordinator | `src/coordinator/mcp.ts`, `src/coordinator/agent.ts`, `src/coordinator/index.ts` | Owns child processes and network; the agent loop decides who gets the tools and how they are authorized |
| main | `src/main/guard.ts`, `src/main/index.ts` (`settings:update`) | Writes settings and owns native dialogs; the pure diff lives in `guard.ts` |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (McpTab), `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/lib/format.ts`, `src/renderer/src/lib/state.ts` | Settings tab, counter, card labels; no network or disk |

## 3. Contracts
- `McpServerConfig` = `{ type: 'stdio'; command; args?; env?; cwd?; enabled }` | `{ type: 'http'; url; headers?; enabled }`, each
  with an optional `tools: string[]` allow-list. `Settings.mcpServers: Record<string, McpServerConfig>`, default `{}`.
- `McpServerStatus` = `{ name; state: 'disabled' | 'connecting' | 'connected' | 'error'; error?; tools: { name; description? }[] }`.
- Requests `mcp.status` and `mcp.reconnect` (both answer with `McpServerStatus[]`); event `mcp.status` with the same list.
- `class McpManager(onStatus)`: `statuses()`, `toolSpecs(): ToolSpec[]`, `has(name)`, `sync(configs, force?)`,
  `call(name, input, signal): Promise<{ text; isError }>`, `closeAll()`.
- `importMcpJson(text): Record<string, McpServerConfig>` (throws the parser's error on invalid JSON).
- `newCommands(before, after): string[]` in `src/main/guard.ts`: lines `<name>: <command> <args>` to confirm.
- MCP tools are not `ToolDefinition`s and declare no `ToolRisk`: `agent.ts` authorizes them as `exec`. `AgentProfile.allowMcp`
  gates them per agent.

## 4. Data and persistence
`mcpServers` lives in `settings.json` (user data folder), written by main. `env` values and `headers` are stored there as plain
text; only provider API keys use `safeStorage`. No new file. Connection state is in memory only and rebuilt at start.

## 5. Dependency injection
`McpManager` receives only its `onStatus` callback; the agent run receives the manager through `RunContext.mcp`. Tests drive a real
stdio server, `tests/fixtures/echo-mcp-server.mjs` (tools `echo`, `fail`), launched with `process.execPath`. `newCommands` and
`importMcpJson` are pure. The Electron dialog is not tested; its decision is the pure `newCommands`.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1, 1.2, 1.5 | `tests/mcp.test.ts` → `connects to a stdio server, lists and calls its tools` | tool answering `isError` |
| AC-2.1, 3.1 | `tests/mcp.test.ts` → `reports disabled and broken servers without throwing` | command that does not exist |
| AC-2.2 | `tests/mcp.test.ts` → `exposes only allowlisted tools` | |
| AC-2.3 | `tests/mcp.test.ts` → `disconnects servers removed from the configuration` | |
| AC-5.1 | `tests/providers.test.ts` → `reads Claude Desktop / Cursor style configs` | non-object entries |
| AC-6.1, 6.2 | `tests/guard.test.ts` → `flags new, changed and re-enabled commands only` | tools-only change, remote server, disabled new command |
| AC-1.3, 1.4, 1.6–1.11, 2.4–2.5, 3.2–3.7, 5.2–5.4, 6.4–6.6, 7.1–7.4 | [gap] | long names, non-text results, abort, timeout, dropped connection |
| AC-2.6, 2.7, 4.1–4.7, 5.5–5.7, 6.3, 7.5 | [manual] — Ajustes › Conectores MCP with a working and a broken server | `{oops`, empty `mcpServers` |

## 7. Security and privacy impact
- Every MCP tool is `exec`: asks in "Pedir aprobación", blocked in "Solo lectura", audited with its qualified name.
- Native confirmation (main process) before a new, changed or re-enabled stdio command runs; remote servers are not confirmed.
- A stdio child gets the SDK default environment plus the configured `env`; Alma's provider keys are never passed.
- Company agents are created with `allowMcp` off; per-agent switch for the rest. Tool output is untrusted text for the model.
- Docs: `docs/security/RIESGOS.md` (R-12, arbitrary code) and `docs/security/CONTROLES.md` (confirmation, minimal environment).

## 8. Rollout
No flag: with no servers configured nothing starts (`mcpServers: {}`). Seeded agents carry their own `allowMcp` defaults; a new
profile starts with it off. The Chrome DevTools card is the one-click start, pinned to `chrome-devtools-mcp@1.11.0`. Turning a
server off in the tab disconnects it without losing its configuration.
