# MCP connectors

> Lets the person plug external MCP (Model Context Protocol) servers into Alma, local programs or remote services, and exposes their tools to the agents allowed to use them. Spec: [017 · MCP](../../.specify/specs/017-mcp/spec.md). Test status: 50 criteria, 10 with a test, 40 without (14 of those are marked manual, interface only).

## What it does

- The person connects MCP servers: a **local program** started over stdio, or a **remote server** reached over HTTP(S) (streamable-HTTP transport only).
- Each server can be switched on or off, removed, and limited to an allow-list of its tools, so a big server does not flood the agents with hundreds of tools.
- The person sees per server whether it is connected, connecting, failing or off, why, and which tools it offers.
- Servers are added by hand, with one click ("Chrome DevTools"), or by pasting an `mcp.json` in the Claude Desktop / Cursor format.
- Connected tools appear to the agents that are allowed to use MCP, named `mcp__<server>__<tool>`. They go through the normal approval policy as command-class (`exec`) tools.
- Adding or changing a local command makes the main process ask the person in a native dialog first. The settings page cannot click it.

Not implemented: OAuth for remote servers, SSE fallback, MCP resources and prompts, automatic reconnection.

## How to use it

All in Settings → "Conectores MCP" tab.

1. **Add a local program.** In the form "Nuevo servidor" ("New server") choose "Comando local (stdio)". Fill name and command. Name: spaces become `-`. Arguments: one per line. Environment: `CLAVE=valor` per line. Allowed tools: separated by commas, spaces or lines (empty = all). Press "Agregar" (enabled once name and command are filled). The server is saved enabled.
2. **Add a remote server.** Choose "Remoto (HTTPS)". Fill name and URL. Headers: `Nombre: valor` per line.
3. **One click for Chrome.** If no server named `chrome-devtools` exists, a "Chrome DevTools" card offers "Agregar Chrome", which adds a stdio server `npx -y chrome-devtools-mcp@1.11.0`. It needs Node on the PATH. Then ask an agent, for example: "abrí esta página en Chrome" (open this page in Chrome).
4. **Import.** Paste an `mcp.json` in the import box and press "Importar". Bad JSON shows the parser's error under the box; valid JSON with no servers shows "No se encontró ningún servidor."; otherwise the servers are merged over existing ones (a same name is overwritten) and the box clears.
5. **Read the rows.** Each row shows name, a badge (`N herramientas` when connected, otherwise `disabled`, `connecting`, `error`; `desconocido` if no status yet), the command line or URL, the error text, and the tool names.
6. **Switch off / remove / retry.** The "Activo" checkbox keeps the configuration. "Quitar" ("Remove") deletes the server at once, with no confirmation. "Reconectar" ("Reconnect") closes and reconnects every server from the current configuration.
7. **Choose which agents use MCP.** Settings → Agentes, the "Conectores MCP" checkbox of each profile. A new profile starts unchecked.
8. **Sidebar.** Shows "MCP: N conectado(s)" and, if some failed, " · N con error"; hidden when no server is configured.
9. **Confirm.** When you add a stdio server, change its command, arguments, folder or environment, or turn one on, Alma shows a native warning "Confirmar cambio de seguridad" ("Confirm security change"): "Alma va a ejecutar estos programas en tu computadora:" ("Alma will run these programs on your computer:") plus the list, buttons "Permitir" / "Cancelar" (default Cancelar). Nothing is saved until you answer "Permitir".

In chat, an MCP tool call card is labelled `<server> · <tool>`. In Telegram status text the `mcp__` prefix is dropped and `_` becomes a space.

## How it works

```
 renderer  SettingsDialog (McpTab) ──settings:update──> main/index.ts
                                                          │ newCommands() in main/guard.ts
                                                          │ -> native dialog "Permitir / Cancelar"
                                                          ▼ (saved to settings.json, pushed)
 coordinator  index.ts  `settings` message ──> McpManager.sync(servers)   (src/coordinator/mcp.ts)
                                                 ├─ stdio : StdioClientTransport (spawn, no shell)
                                                 └─ http  : StreamableHTTPClientTransport
              agent.ts  toolSpecs() ──> tools named mcp__server__tool  (only if profile.allowMcp)
                        call(name, input, signal) ──> text result
```

| File | Role |
|---|---|
| `src/coordinator/mcp.ts` | `McpManager`: connect, list tools, call, disconnect, status, qualified names, result to text. |
| `src/coordinator/agent.ts` | Adds `ctx.mcp.toolSpecs()` when the profile has `allowMcp`; runs `ctx.mcp.call` and treats MCP tools as `exec` risk. |
| `src/coordinator/index.ts` | Syncs MCP on every `settings` message; handles `mcp.status` and `mcp.reconnect`; broadcasts `mcp.status`. |
| `src/main/guard.ts` | `newCommands(before, after)`: which stdio programs need confirming. |
| `src/main/index.ts` | `settings:update`: native confirmation, audit entry on denial. |
| `src/shared/types.ts`, `defaults.ts`, `mcp-import.ts` | Server config type, default `mcpServers: {}`, `mcp.json` parser. |
| `src/renderer/src/components/SettingsDialog.tsx` (McpTab), `Sidebar.tsx` | The tab and the counter. |

Flow details worth knowing:

- **Reconciliation.** `sync` compares the whole serialized entry of each server. New or changed entries (any field, including `enabled`, `tools`, `env`) close the old connection and connect again; removed ones close; unchanged ones stay connected. Because every `settings` message triggers a sync, only changed servers are touched. "Reconectar" forces all.
- **First start.** When the coordinator receives its first settings, all servers connect in the background without blocking start-up. If a configuration change arrives while a server is still connecting, the old attempt is closed and discarded when it finishes.
- **States.** `disabled` (no process, no tools), `connecting` (broadcast), `connected` (tools exposed), `error` (message, no tools). Only `connected` servers contribute tools.
- **Drops.** If a connected server's process or connection closes by itself, its state becomes `error` with `La conexión se cerró.` and its tools disappear. There is no automatic reconnect.
- **Naming.** `mcp__` + server + `__` + tool, each part with every character outside `[a-zA-Z0-9_-]` replaced by `_`, the whole cut to 64 characters (provider tool-name limits; the code comment cites OpenAI's 64). Two different names can collapse to the same one (`my server` and `my_server`); the first match wins.
- **Description.** `[MCP <server>] <description>` cut to 1024 characters; with no description the tool name is used.
- **Results.** Text parts are kept; an embedded resource contributes its text or `[recurso <uri>]`; other parts become `[contenido <tipo> omitido]`; structured content is used (as JSON) only when no part produced text; empty is `(sin contenido)`. A result flagged `isError` comes back as an error for the model and the card. The agent loop truncates long results in the middle.
- **Cancel and failure.** The agent run's abort signal cancels an in-flight call. A call that throws (server died, timeout) reaches the model as `Error: <message>` and the run continues. A tool not exposed (server removed, off, failed, outside the allow-list) throws `La herramienta MCP <nombre> no está disponible.`; a name the agent was not offered is refused with "La herramienta … no está disponible para este agente."
- **Import.** Accepts `{ "mcpServers": {…} }` or the bare map. `command` entries become stdio servers (args, env, optional `cwd`, `tools`), `url` entries become http servers (headers); non-object entries and entries with neither are skipped; with both, `url` wins; the optional `type` is ignored; imported servers are always enabled.

## Tools for agents

MCP adds tools dynamically, one per exposed tool of each connected server. They have no declared `ToolRisk` of their own: the agent loop treats every one as `exec`.

| Name | Risk | Asks approval | Purpose |
|---|---|---|---|
| `mcp__<server>__<tool>` | `exec` (assigned by the agent loop) | per approval mode: asks in "Pedir aprobación", blocked in "Solo lectura", runs in "Siempre permitir"; "always allow" and per-agent auto-approve lists match on the qualified name | Whatever the server's tool does. |

The audit trail records each call with the qualified name, risk `exec` and the decision. See [aprobaciones.md](aprobaciones.md) and [herramientas.md](../references/herramientas.md).

## Settings and data

| What | Default | Where |
|---|---|---|
| `mcpServers` (map name -> `{ type: 'stdio', command, args?, env?, cwd?, enabled, tools? }` or `{ type: 'http', url, headers?, enabled, tools? }`) | `{}` | `settings.json` in the user data folder, written by main |
| `allowMcp` per agent profile | on for some seeded agents, off for others; off for a new custom profile and for every company agent | agent profiles in settings |

An empty or missing `tools` list exposes all tools of the server. `env` values and `headers` are stored in plain text in `settings.json` and sent to the renderer with the public settings; only provider API keys are encrypted. Nothing else is persisted: statuses are in memory. See [ajustes.md](../references/ajustes.md) and [datos.md](../references/datos.md).

## Limits and rules

| Rule | Value |
|---|---|
| Connection handshake | 30 s, then `error` |
| Tool call | 300 s, then it fails by timeout |
| Qualified tool name | at most 64 characters |
| Tool description | at most 1024 characters |
| Client identity | `alma`, version `0.1.0` |
| stdio environment | the SDK default environment plus the configured `env`; Alma's provider keys are not passed |
| Reconnection | none automatic |
| Chrome DevTools shortcut | pinned to `chrome-devtools-mcp@1.11.0` |
| Company agents | never get MCP |

Server stderr is piped and not shown. `StdioClientTransport` spawns the command directly (no shell). The type comment cites about 200 tools as "large"; use the allow-list for those.

## Security and privacy

- **A stdio server is arbitrary code with your user's permissions.** The spec ties this to R-12 in [RIESGOS.md](../security/RIESGOS.md); controls are in [CONTROLES.md](../security/CONTROLES.md).
- **Asks before running a new program.** `newCommands` lists a stdio server that is new, has a different command, arguments, folder or environment, or goes from off to on. A change of only `tools`, a remote server, or a disabled stdio server lists nothing. On "Cancelar" nothing is saved, the call fails with "Cambio cancelado." and a `settings.update` audit entry with outcome `denied` and target `mcpServers` is written. Remote servers are never confirmed.
- **Per-agent switch and approval policy** decide who can call a tool and whether the person is asked.
- **Minimal environment** for child programs (above).
- **What leaves the machine:** a remote server sees whatever the agent sends in the tool arguments, and its headers (which may hold tokens). A stdio server can do anything its code does. Tool output from a server is untrusted text given to the model.
- **Stored:** tokens in `env` and `headers` sit in plain text in `settings.json` (see below).
- Security view of the confirmation: [seguridad.md](seguridad.md).

## How it is tested

- `tests/mcp.test.ts` (4 cases) against the stdio fixture `tests/fixtures/echo-mcp-server.mjs` (tools `echo` and `fail`): connect, list and call; disabled and broken servers do not throw; allow-list; removal disconnects.
- `tests/guard.test.ts` (1 case): `newCommands` flags new, changed and re-enabled commands only.
- `tests/providers.test.ts`: "reads Claude Desktop / Cursor style configs" covers the import.
- Not covered: the http transport (no test uses an http server), the 30 s and 300 s timeouts, abort, result conversion for non-text parts, name truncation, reconciliation of changed entries, the `allowMcp` gate and the exec-risk policy in the agent loop, the native dialog itself, and all of the Settings tab.
- By hand: Settings → Conectores MCP. Add a working and a broken server and read the rows; add `npx` with two arguments and an `A=1` variable; add a remote server with an Authorization header; press "Agregar Chrome"; paste `{oops` and `{"mcpServers":{}}` into the import box; add a stdio server and read the native dialog; trigger an MCP tool from chat and from Telegram.

## Known limits

1. **Tokens in plain text.** `env` values and `headers` are in `settings.json` and go to the renderer, unlike provider keys.
2. **Remote servers are barely guarded.** The form says "Remoto (HTTPS)" but any URL is accepted (including `http://` and local addresses); adding or changing one asks for no confirmation; no SSE fallback, no OAuth..
3. **The confirmation can look identical to the last one.** A change of only `env` or `cwd` shows just command and arguments.
4. **Name collisions.** Sanitizing and the 64-character cut can map two different servers or tools to one name; the first wins silently.
5. **No retry.** A dropped server stays in `error` until "Reconectar" or a settings change.
6. **"Quitar" has no confirmation** and removes env and headers with it; adding a server with an existing name silently overwrites it.
7. **Every MCP tool counts as `exec`.** A harmless read-only tool still asks in "Pedir aprobación"..
8. **Inconsistent `allowMcp` defaults.** Some seeded agents have it on and others off; policy or accident of the seed data is not documented.
9. Rationale for these choices is not documented beyond the spec's questions.

## See also

- [aprobaciones.md](aprobaciones.md): how `exec` risk and "always allow" decide.
- [seguridad.md](seguridad.md): threat model, audit trail, native confirmations.
- [agentes.md](agentes.md): the per-profile "Conectores MCP" switch; [empresas.md](empresas.md): company agents never get MCP.
- [configuraciones.md](configuraciones.md): the Settings dialog and `settings.json`.
- [telegram.md](telegram.md): how MCP tool calls show in status text.
- [app-shell.md](app-shell.md): main process and settings update path.
- Reference: [herramientas.md](../references/herramientas.md), [ajustes.md](../references/ajustes.md), [mensajes-ipc.md](../references/mensajes-ipc.md), [limites.md](../references/limites.md).
