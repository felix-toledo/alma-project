---
status: implemented
---

# 017 — Conectores MCP

## 1. Summary
A person can plug external MCP (Model Context Protocol) servers into Alma: local programs started over stdio, or remote servers
reached over HTTP(S). Each server can be switched on or off and limited to an allow-list of its tools. Its tools then appear to the
agents that are allowed to use MCP under the name `mcp__<server>__<tool>`, and go through the normal approval policy like any
other command-class tool. Servers are added by hand, with one click (Chrome DevTools), or by pasting an `mcp.json` in the
Claude Desktop / Cursor format. Adding or changing a local command makes the main process ask the person in a native dialog first.

## 2. Problem and goal
Alma's built-in tools cannot cover every service a person wants an agent to use (browsers, GitHub, databases, a company's own
API). MCP is the common plug for that. Done means: the person can connect a server in a few seconds, sees whether it works and
which tools it offers, controls which tools and which agents can use it, and cannot be made to run a new program on their machine
without a prompt that the page itself cannot click.

## 3. Scope
**In:** the MCP manager (connect, list tools, call, disconnect), the two transports, per-server enable/disable and tool
allow-list, tool naming and descriptions as agents see them, how results come back, connection failures, `mcp.json` import,
the "Conectores MCP" tab of the settings dialog, the sidebar MCP counter, the per-agent "Conectores MCP" switch, the native
confirmation for stdio commands (`src/main/guard.ts` + `settings:update` in `src/main/index.ts`).

**Out (and why):**
- How approval modes decide, the approval card and "always allow" rules: `../004-approvals/spec.md` (MCP tools are only one more
  caller of that policy).
- Threat model, audit trail and the rest of the security controls: `../022-security-and-privacy/spec.md`.
- Agent profile editing in general (provider, model, instructions): `../003-agents/spec.md`; company agents never get MCP
  (`../007-companies/spec.md`).
- The rest of the settings dialog and where settings are stored: `../006-settings/spec.md`.
- OAuth for remote servers, SSE fallback, MCP resources/prompts: not part of this feature.

## 4. Users and stories
- **US-1** As a person using Alma, I want to connect a local MCP program, so that my agents can use its tools.
- **US-2** As a person using Alma, I want to connect a remote MCP server by URL and headers, so that my agents can use a hosted service.
- **US-3** As a person using Alma, I want to switch a server off or remove it, so that its tools stop being available without losing its configuration.
- **US-4** As a person using Alma, I want to expose only some tools of a big server, so that agents are not flooded with hundreds of tools.
- **US-5** As a person using Alma, I want to see whether each server is connected, failing or off, and why, so that I can fix it.
- **US-6** As a person using Alma, I want to import my existing `mcp.json` from Claude Desktop or Cursor, so that I do not retype servers.
- **US-7** As a person using Alma, I want Alma to ask me before it starts a program I (or a page) just configured, so that nothing runs on my computer without my say.
- **US-8** As a person using Alma, I want to choose which agents can use MCP and to be asked before an MCP tool runs, so that a third-party server cannot act silently.
- **US-9** As an agent, I want MCP tools listed next to my other tools with clear names and results, so that I can call them and understand failures.

## 5. Acceptance criteria

### Connecting and listing (US-1, US-2, US-9)
- **AC-1.1** (US-1) Given an enabled stdio server whose command starts and speaks MCP, when the manager syncs, then the server is reported `connected` with the tools it lists (name and description), after passing through a `connecting` state that is broadcast. Test: tests/mcp.test.ts › "connects to a stdio server, lists and calls its tools"
- **AC-1.2** (US-9) Given a connected server called "mi eco" with tools `echo` and `fail`, when an agent's tool list is built, then each tool is named `mcp__mi_eco__echo` / `mcp__mi_eco__fail` (characters outside `a-zA-Z0-9_-` become `_`). Test: tests/mcp.test.ts › "connects to a stdio server, lists and calls its tools"
- **AC-1.3** (US-9) Given a very long server or tool name, when the qualified name is built, then it is cut to 64 characters. [gap]
- **AC-1.4** (US-9) Given a tool with a description, when it is offered to a model, then its description is `[MCP <server>] <description>` cut to 1024 characters; a tool with no description uses its name as description. [gap]
- **AC-1.5** (US-9) Given a connected server, when `call` runs a tool with an input, then the text of the result is returned with `isError: false`; when the tool answers with `isError`, then the text comes back with `isError: true`. Test: tests/mcp.test.ts › "connects to a stdio server, lists and calls its tools"
- **AC-1.6** (US-9) Given a tool result that contains non-text parts, when it is turned into text, then text parts are kept, an embedded resource contributes its text (or `[recurso <uri>]`), any other part becomes `[contenido <tipo> omitido]`, structured content is used (as JSON) only when no part produced text, and an empty result is `(sin contenido)`. [gap]
- **AC-1.7** (US-9) Given a name that no connected server exposes (server removed, disabled, failed or tool outside the allow-list), when `call` is invoked, then it throws `La herramienta MCP <nombre> no está disponible.` [gap]
- **AC-1.8** (US-9) Given the agent run is aborted while an MCP call is in flight, when the signal fires, then the call is cancelled through the same signal; a call that does not answer in 300 seconds fails by timeout. [gap]
- **AC-1.9** (US-2) Given an enabled `http` server, when the manager connects, then it uses the streamable-HTTP transport with the configured headers on every request. [gap]
- **AC-1.10** (US-1) Given a stdio server with `args`, `env` and `cwd`, when it is launched, then it gets the SDK's default environment plus the configured `env` (and nothing else from Alma's own environment), and runs in `cwd` when one is set. [gap]
- **AC-1.11** (US-1) Given a server that does not answer the handshake within 30 seconds, when connecting, then it ends in `error` with the failure message. [gap]

### Enable, disable, remove, allow-list (US-3, US-4)
- **AC-2.1** (US-3) Given a server with `enabled: false`, when the manager syncs, then it is reported `disabled`, no process or connection is started and it contributes no tools. Test: tests/mcp.test.ts › "reports disabled and broken servers without throwing"
- **AC-2.2** (US-4) Given a server with a non-empty `tools` list, when it connects, then only the listed tool names are exposed to agents and shown in its status; an empty or missing list exposes all. Test: tests/mcp.test.ts › "exposes only allowlisted tools"
- **AC-2.3** (US-3) Given a connected server that is then removed from the configuration, when the manager syncs, then it is closed, disappears from the status list and its tools are gone. Test: tests/mcp.test.ts › "disconnects servers removed from the configuration"
- **AC-2.4** (US-3) Given a connected server, when its entry changes in any field (including `enabled`, `tools`, `env`), then the old connection is closed and a new one is made with the new configuration; an entry that did not change is left connected. [gap]
- **AC-2.5** (US-3) Given the settings change for any reason (any `settings` message reaches the coordinator), when it syncs MCP, then only changed servers are touched. [gap]
- **AC-2.6** (US-3) Given a server toggled "Activo" in the settings tab, when the checkbox changes, then the configuration is saved with the new `enabled` value (and, if it turns a stdio server on, the native confirmation of AC-6.x applies). [manual] Check: Ajustes › Conectores MCP, toggle "Activo" and watch the badge change.
- **AC-2.7** (US-3) Given a server in the list, when "Quitar" is pressed, then it is removed at once, with no confirmation question. [manual] Check: press "Quitar" on a test server.

### Failures and lifecycle (US-5)
- **AC-3.1** (US-5) Given a stdio command that does not exist, when the manager syncs, then that server is `error` with a message, the sync does not throw, other servers are unaffected and the broken one exposes no tools. Test: tests/mcp.test.ts › "reports disabled and broken servers without throwing"
- **AC-3.2** (US-5) Given a connected server whose process or connection later closes by itself, when that happens, then its state becomes `error` with `La conexión se cerró.`, its tools disappear from agents, and it is not reconnected automatically. [gap]
- **AC-3.3** (US-5) Given a server in `error`, when the person presses "Reconectar" in the settings tab, then every server is closed and connected again from the current configuration and the new statuses are returned. [gap]
- **AC-3.4** (US-5) Given the app starts, when the coordinator receives its first settings, then all configured servers are connected in the background without blocking the rest of start-up. [gap]
- **AC-3.5** (US-5) Given Alma quits, when the coordinator shuts down, then every MCP connection (and stdio child process) is closed. [gap]
- **AC-3.6** (US-5) Given a configuration change arrives while a server is still connecting, when the old attempt finishes, then it is closed and discarded rather than shown. [gap]
- **AC-3.7** (US-9) Given an MCP call that throws (server died, timeout), when the agent runs the tool, then the model receives an error result `Error: <message>` and the run continues. [gap]

### Settings UI (US-1, US-2, US-5)
- **AC-4.1** (US-5) Given the "Conectores MCP" tab, when servers exist, then each row shows its name, a badge (`N herramientas` when connected, otherwise `disabled` / `connecting` / `error`, `desconocido` if no status yet), its command line or URL, its error text if any, and the tool names when connected. [manual] Check: connect a working and a broken server and read the rows.
- **AC-4.2** (US-5) Given no servers, when the tab opens, then it says "No hay conectores. Agregá uno o importá tu mcp.json." [manual] Check: open the tab with an empty list.
- **AC-4.3** (US-1) Given the form "Nuevo servidor" with type "Comando local (stdio)", when the person fills name and command, then "Agregar" becomes enabled; spaces in the name become `-`; arguments are one per line; environment is `CLAVE=valor` per line; allowed tools are separated by commas, spaces or lines; the server is saved enabled. [manual] Check: add `npx` with two arguments and an `A=1` variable; see them in the row.
- **AC-4.4** (US-2) Given the form with type "Remoto (HTTPS)", when the person fills name and URL, then "Agregar" becomes enabled; headers are `Nombre: valor` per line. [manual] Check: add a remote server with an Authorization header.
- **AC-4.5** (US-1) Given no server named `chrome-devtools`, when the tab opens, then a "Chrome DevTools" card offers "Agregar Chrome", which adds a stdio server `npx -y chrome-devtools-mcp@1.11.0`, enabled; once a server with that name exists the card disappears. [manual] Check: press "Agregar Chrome" on a machine with Chrome and ask an agent to open a page.
- **AC-4.6** (US-5) Given any state, when the sidebar shows MCP, then it says "MCP: N conectado(s)" and, if some failed, " · N con error"; it is hidden when no server is configured. [manual] Check: connect one good and one broken server.
- **AC-4.7** (US-9) Given a tool call from an MCP tool, when it is shown in the chat or in Telegram status text, then the chat card is labelled `<servidor> · <herramienta>` and the Telegram status drops the `mcp__` prefix and turns `_` into spaces. [manual] Check: trigger an MCP tool from chat and from Telegram.

### Import of mcp.json (US-6)
- **AC-5.1** (US-6) Given text in the Claude Desktop / Cursor shape, when imported, then `command` entries become enabled stdio servers (args, env), `url` entries become enabled http servers (headers), and entries that are not objects are skipped. Test: tests/providers.test.ts › "reads Claude Desktop / Cursor style configs"
- **AC-5.2** (US-6) Given a JSON object without the `mcpServers` wrapper, when imported, then the top-level keys are read as servers. [gap]
- **AC-5.3** (US-6) Given an entry with `tools` (array) and/or `cwd` (string), when imported, then they are kept (`tools` as strings). [gap]
- **AC-5.4** (US-6) Given an entry with neither `url` nor `command`, when imported, then it is skipped; an entry with both uses the `url`. [gap]
- **AC-5.5** (US-6) Given text that is not valid JSON, when the person presses "Importar", then the parser's error message is shown under the box and nothing is saved. [manual] Check: paste `{oops` and press "Importar".
- **AC-5.6** (US-6) Given valid JSON with no server in it, when imported, then the box shows "No se encontró ningún servidor." and nothing is saved. [manual] Check: paste `{"mcpServers":{}}`.
- **AC-5.7** (US-6) Given a valid import, when saved, then the imported servers are merged over the existing ones (a same name is overwritten) and the box is cleared. [manual] Check: import a file with a name that already exists and see it replaced.

### Native confirmation (US-7) — security view in `../022-security-and-privacy/spec.md`
- **AC-6.1** (US-7) Given a settings change, when a stdio server is new, has a different command, arguments, folder or environment, or goes from off to on, then it is listed as a program to confirm, as `<name>: <command> <args>`. Test: tests/guard.test.ts › "flags new, changed and re-enabled commands only"
- **AC-6.2** (US-7) Given a settings change that touches only a server's `tools`, a remote server, or a new/changed stdio server that is disabled, when compared, then nothing is listed. Test: tests/guard.test.ts › "flags new, changed and re-enabled commands only"
- **AC-6.3** (US-7) Given `settings:update` with programs to confirm, when it arrives in main, then a native warning dialog "Confirmar cambio de seguridad" ("Alma va a ejecutar estos programas en tu computadora:" plus the list) with buttons "Permitir" / "Cancelar" (default Cancelar) is shown before anything is saved. [manual] Check: add a stdio server from the settings tab and read the dialog; the page cannot click it.
- **AC-6.4** (US-7) Given the person answers "Cancelar" or closes the dialog, when the update is refused, then nothing is saved, the call fails with "Cambio cancelado." and a `settings.update` audit entry with outcome `denied` and target `mcpServers` is written. [gap]
- **AC-6.5** (US-7) Given the person answers "Permitir", when the update goes through, then it is saved, pushed to the coordinator, and the server connects. [gap]
- **AC-6.6** (US-7) Given a change of only `env` or `cwd` of a stdio server, when the dialog is shown, then the list line shows only command and arguments (it looks the same as before). [gap]

### Who can use MCP and approvals (US-8)
- **AC-7.1** (US-8) Given an agent profile with "Conectores MCP" off, when its tools are built, then no MCP tool is offered to it; with it on, all connected servers' exposed tools are offered. [gap]
- **AC-7.2** (US-8) Given a model asks for an MCP tool name not in the list offered to that agent, when the call is processed, then it is refused with "La herramienta … no está disponible para este agente." [gap]
- **AC-7.3** (US-8) Given an allowed MCP tool call, when the approval policy runs, then the tool counts as risk `exec` (not `read`): in "Pedir aprobación" the person is asked, in "Solo lectura" it is blocked, in "Siempre permitir" it runs, and "always allow" / a per-agent auto-approve list matches by the qualified name. [gap]
- **AC-7.4** (US-8) Given an MCP tool call that ran, when it ends, then the audit trail records it with the qualified tool name, risk `exec` and the decision. [gap]
- **AC-7.5** (US-8) Given the person creates a new agent profile in the agent editor, when it opens, then "Conectores MCP" starts unchecked. [manual] Check: Ajustes › Agentes, new agent, see the checkbox. Defaults of the seeded agents: see `../003-agents/spec.md`.

## 6. Business rules
- **BR-1** A server entry is `stdio` (`command`, optional `args`, `env`, `cwd`) or `http` (`url`, optional `headers`), plus `enabled` and an optional `tools` allow-list; empty or missing list = all tools. (src/shared/types.ts)
- **BR-2** The settings default is no servers (`mcpServers: {}`). (src/shared/defaults.ts)
- **BR-3** The name agents see is `mcp__` + server name + `__` + tool name, each part with every character outside `[a-zA-Z0-9_-]` replaced by `_`, the whole cut to 64 characters. (src/coordinator/mcp.ts)
- **BR-4** The description given to the model is `[MCP <server>] <description>` cut to 1024 characters. (src/coordinator/mcp.ts)
- **BR-5** Connecting waits at most 30 s; a tool call at most 300 s. (src/coordinator/mcp.ts)
- **BR-6** The client identifies itself as `alma` version `0.1.0`. (src/coordinator/mcp.ts)
- **BR-7** A stdio server's environment is the SDK default environment plus the configured `env`; Alma's provider keys are not passed. (src/coordinator/mcp.ts; `docs/security/CONTROLS.md`)
- **BR-8** Only `connected` servers contribute tools; `disabled`, `connecting` and `error` servers contribute none. (src/coordinator/mcp.ts)
- **BR-9** Servers are reconciled by comparing the whole serialized entry: new or changed entries (re)connect, removed ones close, unchanged ones are kept. "Reconectar" forces all. (src/coordinator/mcp.ts)
- **BR-10** There is no automatic reconnection after a connection drops or an attempt fails. (src/coordinator/mcp.ts)
- **BR-11** MCP tools have no declared risk of their own; the agent loop treats them as `exec`. (src/coordinator/agent.ts)
- **BR-12** An agent gets MCP tools only if its profile has `allowMcp`. Company agents are created with it off. (src/coordinator/agent.ts, src/shared/company.ts)
- **BR-13** An MCP result is shown to the model as text, truncated in the middle if too long; an `isError` result is marked as an error for the model and the card. (src/coordinator/agent.ts, src/coordinator/mcp.ts)
- **BR-14** Import accepts `{ "mcpServers": {…} }` or the bare map; imported servers are always `enabled`; the optional `type` field is ignored. (src/shared/mcp-import.ts)
- **BR-15** A settings update is confirmed natively when it adds a stdio server that would launch, or changes the command, arguments, folder or environment of one, or enables one. Remote servers are never confirmed. (src/main/guard.ts)
- **BR-16** The Chrome DevTools shortcut is pinned to `chrome-devtools-mcp@1.11.0`. (src/renderer/src/components/SettingsDialog.tsx)

## 7. Constraints and risks
- **Layers touched:** `shared` (`types.ts`, `mcp-import.ts`, `defaults.ts`), `coordinator` (`mcp.ts`, `agent.ts`, `index.ts`), `main` (`guard.ts`, `index.ts` for `settings:update`), `renderer` (`SettingsDialog.tsx` McpTab, `Sidebar.tsx`, `lib/format.ts`, `lib/state.ts`).
- **Messages:** requests `mcp.status` and `mcp.reconnect`; event `mcp.status` (list of `McpServerStatus`: `name`, `state` ∈ disabled / connecting / connected / error, `error?`, `tools`). The renderer asks for status at start and then follows events.
- **Persistence:** `mcpServers` lives in `settings.json` in the user data folder, written by the main process. `env` values and `headers` (which may carry tokens) are stored there in plain text and sent to the renderer with the public settings; only provider API keys are encrypted.
- **Security:** a stdio server is arbitrary code with the user's permissions (R-12 in `docs/security/RISKS.md`). Controls: native confirmation (BR-15), allow-list, minimal environment, per-agent switch, approval policy. Remote servers see whatever the agent sends in tool arguments. Tool output from a server is untrusted text given to the model.
- **Platform:** `StdioClientTransport` spawns the command directly (no shell); `npx` shortcuts need Node on the PATH. Server stderr is piped and not shown. Large servers should use the allow-list (the type comment cites ~200 tools).
- **Tests:** `tests/mcp.test.ts` uses the stdio fixture `tests/fixtures/echo-mcp-server.mjs` (tools `echo` and `fail`); no test uses an http server.
