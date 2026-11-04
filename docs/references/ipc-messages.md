# Reference: messages between layers

The contracts between the three processes: renderer (window), main (Electron) and coordinator (utility process). Grouped by hop, in the order a message travels. Layers and rules: [docs/architecture.md](../architecture.md). Window shell and security gates: [docs/modules/app-shell.md](../modules/app-shell.md) and [docs/modules/security.md](../modules/security.md). Specs: [023 · App shell](../../.specify/specs/023-app-shell-and-ui/spec.md), [006 · Configuraciones](../../.specify/specs/006-settings/spec.md), [022 · Seguridad](../../.specify/specs/022-security-and-privacy/spec.md).

```
renderer ──window.desktop (preload)──┬─ ipcRenderer.invoke ──► main        (settings, dialogs, Instagram, shell)
                                     └─ MessagePort ─────────► coordinator (RequestEnvelope / AudioEnvelope)
renderer ◄── MessagePort ─────────── coordinator   (ResponseEnvelope, EventEnvelope)
renderer ◄── ipcRenderer.send ────── main          (settings:changed, app:openThread, app:reminder, coordinator:*)
main ──── parentPort ──► coordinator   (ParentToCoordinator)
main ◄─── parentPort ─── coordinator   (CoordinatorToParent, incl. host.request)
```

Types: `src/shared/types.ts` (envelopes, requests, events, parent messages), `src/shared/desktop-api.ts` (`DesktopApi`). Code: `src/preload/index.ts`, `src/main/index.ts`, `src/coordinator/index.ts`.

## Validation at a glance

`docs/architecture.md` says IPC messages are validated at the border (Zod). In the code that is **not so**: `zod` is imported only for tool inputs (`src/coordinator/agent.ts`, `tools/*`, `compose/`, `knowledge/tools.ts`) and for the reviewer's output schema in `providers/anthropic.ts`. There is no `safeParse` or `.parse` in `src/main`, in `src/coordinator/index.ts`, in `src/coordinator/home/index.ts` or in `src/preload`.

| Message family | Schema validation | What protects it instead |
|---|---|---|
| Preload API / `ipcMain.handle` channels | No (TypeScript types only, erased at run time) | `isTrusted(event)` (top frame of Alma's own window, same page); hand-written checks in `settings:setApiKey`, `settings:setCompanySecret`, `shell:openPath`; native confirmation in `settings:update` |
| `RequestEnvelope` (renderer → coordinator) | No: `handle()` casts `event.data`; only `kind === 'request'` is checked | Paths are confined inside each method (`resolveInWorkspace`, vault confinement); `home.connectExternal` checks the URL starts with `http(s)://` |
| `AudioEnvelope` | No (`kind === 'audio'` check only) | none; fire-and-forget |
| `ParentToCoordinator`, `CoordinatorToParent`, `HostRequest` | No | Same-process-family trust. `trash` is re-checked in main to be inside the active vault; `image.render` trusts the coordinator's path |
| Settings read from disk, patches from the window | No | Shallow merge with defaults |
| Tool inputs (agent → tool) | **Yes**, Zod (`builtin.schema.safeParse`, `DelegateInput.safeParse` in `src/coordinator/agent.ts`) | Not an IPC message; listed for contrast |
| Responses and events (coordinator → renderer) | No | Typed by TypeScript only |

Unknown request: `handle()` has no `default` branch for non-`home.` methods, so an unknown `method` answers `{ ok: true, result: undefined }`. `home.*` methods throw "Pedido desconocido: …" for an unknown one.

## 1. Preload API: `window.desktop`

Defined in `src/shared/desktop-api.ts`, built in `src/preload/index.ts`, exposed with `contextBridge.exposeInMainWorld('desktop', api)`. Context isolation on, sandbox on, no Node in the page.

| Member | Type | Maps to | Validated |
|---|---|---|---|
| `platform` | string | `process.platform` | n/a |
| `coordinator.send(message)` | `(RequestEnvelope) => void` | `port.postMessage`; queued until the port arrives | No |
| `coordinator.sendAudio(pcm)` | `(ArrayBuffer) => void` | `port.postMessage({ kind: 'audio', pcm })`. Copied, not transferred (a port to a utility process drops ArrayBuffers in the transfer list); dropped, not queued, while reconnecting | No |
| `coordinator.onMessage(listener)` | returns unsubscribe | Every `CoordinatorMessage` from the port | No |
| `coordinator.onConnected(listener)` | returns unsubscribe | Fires each time a fresh port arrives (first connect and after a coordinator restart) | n/a |
| `settings.get()` | `Promise<PublicSettings>` | `invoke('settings:get')` | No |
| `settings.update(patch)` | `Promise<PublicSettings>` | `invoke('settings:update', patch)` | No |
| `settings.setApiKey(provider, apiKey)` | `Promise<PublicSettings>` | `invoke('settings:setApiKey', …)` | Provider id against a list |
| `settings.setCompanySecret(companyId, secret)` | `Promise<PublicSettings>` | `invoke('settings:setCompanySecret', …)` | Company must exist |
| `settings.onChanged(listener)` | returns unsubscribe | `on('settings:changed')` | n/a |
| `instagram.status()` / `connect()` / `disconnect()` | `Promise<InstagramStatus>` | `invoke('instagram:status' \| 'instagram:connect' \| 'instagram:disconnect')` | No arguments |
| `onOpenThread(listener)` | `(threadId) => void` | `on('app:openThread')` | n/a |
| `onReminder(listener)` | `({ title, body }) => void` | `on('app:reminder')` | n/a |
| `pickFolder()` | `Promise<string \| null>` | `invoke('dialog:pickFolder')` | No arguments |
| `openPath(path)` | `Promise<string>` (empty = ok, otherwise an error text) | `invoke('shell:openPath', path)` | Hand-written, see below |
| `defaultVaultPath()` | `Promise<string>` | `invoke('vault:defaultPath')` | No arguments |

The preload connects on load: `ipcRenderer.send('coordinator:connect')`, and again when main sends `coordinator:restarted`. Requests sent before the port exists are queued (`queue`); microphone audio is not.

On the renderer side `src/renderer/src/lib/coordinator.ts` wraps this: `request(req)` assigns `reqId` (counter from 1), keeps a promise per id and resolves or rejects on the matching `ResponseEnvelope`. There is no timeout and pending promises are not rejected when the coordinator restarts (read from the code; I did not run it).

## 2. IPC channels handled in main

All `ipcMain.handle` channels go through `handle()` in `src/main/index.ts`, which rejects anything that is not the top frame of Alma's own window on the page it loaded: error "Origen no autorizado" and audit `ipc.rejected` (throttled 60 s).

### Invoke channels (renderer to main)

| Channel | Payload | Returns | What it does | Notes |
|---|---|---|---|---|
| `settings:get` | none | `PublicSettings` | Settings without any key or company password | |
| `settings:update` | `Partial<PublicSettings>` | `PublicSettings` | Merges the patch, saves, pushes the full settings to the coordinator, applies tray, login item and voice hotkey. Native confirmation dialog first if the patch adds/changes/re-enables a stdio MCP command or moves `approvalMode` to `always-allow`; "Cancelar" throws "Cambio cancelado." and audits `settings.update` denied. Audits changed key names | Only `providers.xai.baseUrl` is honored under `providers` |
| `settings:setApiKey` | `(provider: SecretProviderId, apiKey: string)` | `PublicSettings` | Trims, seals and saves one key; audits `secret.set` / `secret.clear` | Unknown id throws "Proveedor desconocido" |
| `settings:setCompanySecret` | `(companyId: string, secret: string)` | `PublicSettings` | Saves or forgets a company mailbox password | Unknown company throws "Empresa desconocida" |
| `instagram:status` | none | `{ connected }` | Looks for the `sessionid` cookie in the `persist:instagram` partition | `src/main/instagram.ts` |
| `instagram:connect` | none | `{ connected }` | Opens Instagram's login in an app window; resolves when it closes; audits `instagram.connect` | |
| `instagram:disconnect` | none | `{ connected }` | Clears the partition storage; audits `instagram.disconnect` | |
| `dialog:pickFolder` | none | `string \| null` | Native folder picker | |
| `shell:openPath` | `path: string` | `''` or error text | Opens a folder or document with the OS. Refuses non-string, relative or missing paths («La ruta no existe.») and files with executable or script extensions ("Alma no abre programas ni scripts.", audit `shell.openPath` denied) | |
| `vault:defaultPath` | none | `string` | `Documents\Alma\Vault` | |

### Fire-and-forget channel (renderer to main)

| Channel | Payload | What it does |
|---|---|---|
| `coordinator:connect` | none | If the sender is trusted: starts the coordinator if needed, creates a `MessageChannelMain`, sends one port to the coordinator (`{ type: 'client' }`) and the other to the window (`coordinator:port`). An untrusted sender is ignored silently, with no audit line |

### Events (main to renderer)

| Channel | Payload | When | Preload member |
|---|---|---|---|
| `coordinator:port` | `null` + a `MessagePort` | After `coordinator:connect` | `coordinator.*` (internal) |
| `coordinator:restarted` | none | The coordinator exited with a non-zero code and main restarted it | internal (preload reconnects) |
| `settings:changed` | none | Settings changed outside the window (`settings.patch` from the coordinator, `alwaysAllow`) | `settings.onChanged` |
| `app:openThread` | `threadId: string` | A notification was clicked | `onOpenThread` |
| `app:reminder` | `{ title, body }` | A `notify` with `always` (reminders, home notices): also shown in-app because OS toasts can be dropped | `onReminder` |

### Not an IPC channel but part of the surface

- `alma-vault://file/<vault-relative path>`: protocol handler that serves vault files to the editor (404 outside the active vault, for hidden segments, for symlinks that leave the vault; adds `Access-Control-Allow-Origin: *`).
- Permission handlers: only microphone (audio, never video) and clipboard write are granted to the main window. `<webview>` is refused.

## 3. Coordinator protocol: requests (renderer to coordinator)

Over the MessagePort. Envelope: `RequestEnvelope = { kind: 'request', reqId: number } & CoordinatorRequest`. The answer is `{ kind: 'response', reqId, ok: true, result }` or `{ kind: 'response', reqId, ok: false, error: string }` (the error text is `error.message`). Handler: `handle()` in `src/coordinator/index.ts`, except `home.*` which `handle()` forwards to `HomeService.handle()` in `src/coordinator/home/index.ts`. Validation: none for any row (see the table at the top).

The field `kind` is reserved by the envelope: `vault.create` therefore names its field `entry` (comment in `types.ts`).

### Conversations and runs

| Method | Payload | Result | What it does |
|---|---|---|---|
| `threads.list` | none | `ThreadSummary[]` | All conversations, newest first |
| `threads.get` | `threadId` | `Thread` | One full conversation; error «La conversación no existe.» |
| `threads.create` | `agentId, workspace` | `Thread` | New conversation; broadcasts `thread.updated` |
| `threads.update` | `threadId, title?, agentId?, workspace?` | `ThreadSummary` | Rename, change agent or folder |
| `threads.delete` | `threadId` | `null` | Aborts the run if any, deletes the file |
| `chat.send` | `threadId, text` | `null` (answers at once) | Starts an agent run (`startRun`); throws if one is already running; progress arrives as events |
| `chat.stop` | `threadId` | `null` | Aborts the run |
| `runs.active` | none | `string[]` | Thread ids with a run in progress |
| `approval.respond` | `approvalId, decision: 'allow' \| 'deny' \| 'always'` | `null` | Answers a pending approval (`ApprovalBroker.respond`); `always` also adds to `alwaysAllowTools` through main |
| `approval.pending` | none | `PendingApproval[]` | Approvals still waiting (to rebuild the UI after a reconnect) |
| `files.image` | `threadId, path` | data URL | A workspace image for previews, confined to the thread's workspace |
| `files.saveImage` | `name, base64` | path string | Saves a pasted or dropped picture to `inbox/` |

### Models, MCP, images

| Method | Payload | Result | What it does |
|---|---|---|---|
| `models.list` | `provider: ProviderId` | `string[]` sorted | Lists the provider's models with its key (`getProvider(...).listModels()`) |
| `images.models` | `provider?: ImageProviderId` | models list | `listImageModels` in `src/coordinator/images.ts` |
| `mcp.status` | none | `McpServerStatus[]` | State of each MCP server |
| `mcp.reconnect` | none | `McpServerStatus[]` | Forces a re-sync of every server |
| `email.test` | none | result of `testEmail` | Logs in to IMAP and SMTP without reading or sending |

### Routines

| Method | Payload | Result | What it does |
|---|---|---|---|
| `routines.state` | none | `Record<id, RoutineState>` | Run history snapshot |
| `routines.runNow` | `routineId` | thread id or `null` | Runs a task now; a reminder only notifies and is not "used up"; unknown id throws «La rutina no existe.» |

### Vault and knowledge

Paths are vault-relative; `activeVault()` throws «No hay un vault abierto.» when none is open.

| Method | Payload | Result | What it does |
|---|---|---|---|
| `vault.tree` | none | `VaultEntry[]` | Files and folders (empty list with no vault) |
| `vault.read` | `path` | file content | |
| `vault.write` | `path, content` | | Writes a note |
| `vault.create` | `path, entry: 'file' \| 'folder'` | | |
| `vault.rename` | `from, to` | | |
| `vault.delete` | `path` | | Moves to the recycle bin through the `trash` host request |
| `vault.search` | `query, limit?` | `SearchHit[]` | Hybrid BM25 + vector search |
| `vault.init` | `path` | `null` | Creates the folder and a `Bienvenida.md` if it is empty (works with no active vault) |
| `knowledge.status` | none | `KnowledgeStatus \| null` | Index and embedding model state |
| `knowledge.overview` | none | `KnowledgeOverview` | Lines of `Alma/Recuerdos.md` and notes in `Alma/Conocimientos` |
| `knowledge.forget` | `text` | | Removes matching memories |

### Channels, voice, privacy

| Method | Payload | Result | What it does |
|---|---|---|---|
| `telegram.status` | none | `TelegramStatus` | |
| `whatsapp.status` | none | `WhatsAppStatus` | |
| `whatsapp.logout` | none | `null` | Unlinks and deletes `whatsapp-auth/`; a new QR appears if still enabled |
| `voice.status` | none | `VoiceStatus` | |
| `voice.trigger` | none | `null` | Start listening now (hotkey or button); while speaking, stop |
| `voice.played` | none | `null` | The window finished playing what Alma said |
| `voice.enroll` | `samples: ArrayBuffer[]` (mono 16 kHz Int16 PCM) | `{ consistency }` | Learns the voice print |
| `voice.profile` | none | `{ enrolled, enrolledAt? }` | |
| `voice.forgetProfile` | none | `null` | Deletes `voice-profile.json` |
| `voice.testSpeaker` | `sample: ArrayBuffer` | similarity 0 to 1 | Tunes the threshold |
| `voice.say` | `text` | `null` | Speaks a text |
| `voice.elevenVoices` | none | `{ id, name, preview, labels }[]` | ElevenLabs voices (needs the key) |
| `privacy.export` | `targetDir` | path of the new folder | Copies personal data; audits `privacy.export` |
| `privacy.erase` | none | `null` | Deletes conversations, `inbox/` and the voice print; audits `privacy.erase` |

### Companies

All take `companyId`; an unknown company throws from `companies.company(...)`.

| Method | Extra payload | Result | What it does |
|---|---|---|---|
| `company.snapshot` | none | `CompanySnapshot` | Tasks, meetings, activity, spend, who is working |
| `company.task.create` | `title, description, assignee` | task | Creates it as the user |
| `company.task.comment` | `taskId, text` | `null` | |
| `company.task.review` | `taskId, approve, comment?` | | Approve, or send back with a comment |
| `company.task.move` | `taskId, status: TaskStatus` | `null` | |
| `company.task.delete` | `taskId` | `null` | |
| `company.meeting.create` | `topic, agenda[], participants[], chair, at, prepHours` | meeting | |
| `company.meeting.start` / `say` / `end` / `cancel` | `meetingId` (+ `text` for `say`) | `null` | Meeting control |
| `company.whatsapp.status` | none | `WhatsAppStatus` | `{ state: 'off' }` if no session exists |
| `company.whatsapp.logout` | none | `null` | |

### Home (Casa)

Handler: `src/coordinator/home/index.ts`.

| Method | Payload | Result | What it does |
|---|---|---|---|
| `home.status` | none | `HomeEngineStatus` | |
| `home.install` / `home.start` | none | `null` at once | Runs in the background; progress arrives as `home.engine` events |
| `home.stop` / `home.uninstall` | none | `null` | |
| `home.connectExternal` | `url, token` | `null` | Checks `http(s)://`, verifies against `/api/config`, stores sealed |
| `home.advanced` | none | login of the managed Home Assistant | For the "avanzado" button |
| `home.snapshot` | none | `HomeSnapshot` | Empty one while the engine is not ready |
| `home.control` | `entityId, service, data?` | `null` | Calls a Home Assistant service |
| `home.thing.update` / `home.thing.remove` | `id`, `name?`, `areaId?` | | Rename or move / remove a device |
| `home.integrations` / `home.entries` | none | lists | Available integrations / configured entries |
| `home.flow.start` / `step` / `abort` | `domain` / `flowId, data?, menu?` / `flowId` | `FlowStep` / `null` | Add-a-device config flow |
| `home.entry.remove` | `entryId` | `null` | |
| `home.plan.get` / `set` / `fromDrawing` | none / `plan` / `path, floorId?` | `HomePlan` | Floor plan; `fromDrawing` builds rooms from an Excalidraw file in the vault |
| `home.camera.snapshot` | `entityId` | JPEG data URL | |
| `home.rules` | none | `HomeRulesView` | |
| `home.rule.toggle` / `home.rule.delete` | `kind, id, enabled?` | `null` | `kind`: `ha`, `judgment` (and `watch` for delete) |

### Audio stream

| Message | Payload | Direction | What it does |
|---|---|---|---|
| `AudioEnvelope` `{ kind: 'audio', pcm }` | 80 ms of mono 16 kHz Int16 PCM | renderer to coordinator | `VoiceAssistant.audio(pcm)`. No response. Handled before the request check in `attachClient` |

## 4. Coordinator protocol: events (coordinator to renderer)

`EventEnvelope = { kind: 'event', event: LiveEvent }`, sent by `broadcast()` to every connected port; the same events reach in-process listeners (`onEvent` taps: Telegram, WhatsApp, voice). `scope` is `{ threadId, subagentId? }`. All unvalidated.

| `type` | Payload | Emitted by | Meaning |
|---|---|---|---|
| `run.started` | `threadId` | `src/coordinator/index.ts` | A run began |
| `run.finished` | `threadId, error?` | `index.ts` | A run ended (no `error` when cancelled) |
| `stream.text` / `stream.thinking` | `scope, text` | `agent.ts` | Streaming deltas |
| `stream.tool` | `scope, id, name` | `agent.ts` | The model started a tool call |
| `message` | `scope, message: ChatMessage` | `agent.ts`, `index.ts` | A finished message |
| `tool.state` | `threadId, toolUseId, state: ToolState` | `agent.ts` | Tool progress: `pending-approval`, `reviewing`, `running`, `done`, `denied`, `error` |
| `subagent.started` | `threadId, run: SubagentRun` | `agent.ts` | A delegated run began |
| `subagent.finished` | `threadId, subagentId, status` | `agent.ts` | It ended |
| `approval.request` | `approval: PendingApproval` | `approval.ts` | Asks the person; also triggers a desktop notification |
| `approval.resolved` | `approvalId` | `approval.ts` | Closed (answered, aborted) |
| `thread.updated` | `summary: ThreadSummary` | `index.ts` | Title, agent or time changed, or created |
| `mcp.status` | `servers: McpServerStatus[]` | `index.ts` (from `McpManager`) | |
| `routines.state` | `state` | `index.ts` (from `RoutineRunner`) | |
| `vault.changed` | none | `index.ts` | Files in the active vault changed (editor, tool, or another app) |
| `knowledge.status` | `status: KnowledgeStatus \| null` | `index.ts` | Index progress; `null` with no vault |
| `telegram.status` | `status: TelegramStatus` | `index.ts` | |
| `whatsapp.status` | `status: WhatsAppStatus` | `index.ts` | QR data URL while linking |
| `company.whatsapp` | `companyId, status` | `index.ts` | |
| `company.changed` | `companyId` | `company/engine.ts` | The window reloads the snapshot |
| `voice.status` | `status: VoiceStatus` | `voice/assistant.ts` | |
| `voice.play` | `playback: VoicePlayback, last` | `voice/assistant.ts` | Audio for the window to play (`pcm`, `encoded` or `system`); on `last` the window answers `voice.played` |
| `voice.stop` | none | `voice/assistant.ts` | Stop playing now (barge-in) |
| `home.engine` | `status` | `home/index.ts` | Engine install and start progress |
| `home.snapshot` | `snapshot` | `home/index.ts` | Devices state |
| `home.plan` | `plan` | `home/index.ts` | Floor plan changed |
| `home.rules` | `rules: HomeRulesView` | `home/index.ts` | |
| `home.flow` | `step: FlowStep` | `home/index.ts` | A step of adding a device needs the window (QR, external page) |

## 5. Main and coordinator

Over the utility process `parentPort`. Types in `src/shared/types.ts`. Unvalidated.

### Main to coordinator (`ParentToCoordinator`)

| `type` | Payload | Sent when | Coordinator does |
|---|---|---|---|
| `init` | `dataDir, settings` | Right after fork | Stores settings; opens audit, thread store, routines, vault, Telegram, voice, WhatsApp, companies, home; applies retention |
| `settings` | `settings` (full, decrypted) | After every save | Replaces settings; re-syncs retention, MCP, vault, Telegram, voice, WhatsApp, company channels, home |
| `client` | a `MessagePort` | When a window connects | `attachClient(port)`: starts listening for requests and audio |
| `host.result` | `reqId, ok, message` | Answer to a host request | Resolves the waiting promise |
| `voice.trigger` | none | The global hotkey was pressed | `voice.trigger()` |

### Coordinator to main (`CoordinatorToParent`)

| `type` | Payload | Main does |
|---|---|---|
| `alwaysAllow` | `toolName` | If not listed, appends to `alwaysAllowTools`, audits `always-allow.add`, pushes settings, sends `settings:changed` |
| `settings.patch` | `patch: Partial<Omit<Settings, 'providers'>>` | `settings.update(patch)` with no confirmation dialog, pushes back, sends `settings:changed`. Used for routines, bound Telegram chat, channel thread ids |
| `notify` | `title, body, threadId?, always?` | System notification when the window is not focused (always with `always`; then also `app:reminder` and a taskbar flash). Click shows the window and sends `app:openThread` |
| `host.request` | `reqId, request: HostRequest` | See below; answers with `host.result` |

### Host requests (`HostRequest`, coordinator to main)

The coordinator wraps these in `host.request(...)` (`Host` in `src/coordinator/tools/types.ts`), which allocates `reqId` and waits for `host.result`. There is no timeout. Handler: `handleHostRequest()` in `src/main/index.ts`.

| `action` | Payload | Caller | Main does | Check in main |
|---|---|---|---|---|
| `instagram.publish` | `imagePath, caption, testMode` | `instagram_publish` tool (`tools/media.ts`) | Drives the Instagram web page in the app browser (`publishToInstagram`); audits `instagram.publish` | none beyond the coordinator's own checks |
| `image.render` | `svg, width, height, outPath` | `compose_image` tool (`tools/media.ts`) | Rasterizes the SVG to PNG (`renderSvgToPng`, `src/main/render.ts`) | none: trusts that `outPath` is inside the workspace |
| `trash` | `path` | Vault delete (`src/coordinator/index.ts`, for the active vault and company vaults) | Moves to the recycle bin; audits `vault.trash` | Refuses a path outside the active vault or the vault root ("Ruta fuera del vault.") |
| `secret.seal` | `text` | Home engine (`home/index.ts`) | `encrypt(text)` with `safeStorage` (empty string without a secure store, unless plaintext is allowed) | none |
| `secret.open` | `text` | Home engine | `decrypt(text)` | none |

Reply: `{ ok: boolean, message: string }`; for `secret.*` the result text is in `message`, so an error text and a secret travel in the same field.

## Known limits

- No schema validation on any IPC, request, parent or host message, although `docs/architecture.md` describes validation at the border. `settings:update` accepts any key and shape.
- An unknown request method answers success with no result (outside `home.*`).
- `coordinator:connect` rejects untrusted senders silently, with no audit.
- `settings.patch` from the coordinator bypasses the native confirmation, so a patch with an MCP command or `approvalMode` would not ask. The coordinator today sends only routines and channel bindings (read from the code; the type allows more).
- No timeout on renderer requests or on host requests.
- Text inputs in Mail and Voice call `settings:update` on every keystroke.

See also: [settings.md](settings.md), [data.md](data.md), [docs/modules/settings.md](../modules/settings.md), [docs/modules/approvals.md](../modules/approvals.md), [docs/modules/voice.md](../modules/voice.md), [docs/modules/home.md](../modules/home.md), [docs/modules/companies.md](../modules/companies.md), [docs/modules/vault-and-knowledge.md](../modules/vault-and-knowledge.md).

Written by hand from the code; when you add a row, verify the name in the code
