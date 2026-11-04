# 002 — Plan

## 1. Approach
The coordinator owns every conversation: it persists threads, runs the agent and broadcasts typed `LiveEvent`s; the window only mirrors them. The renderer keeps one pure reducer (`lib/state.ts`) that folds events into UI state, so streaming, sub-agents and background threads share one code path, and anything that starts a run (Telegram, WhatsApp, voice, routines, house rules, companies) goes through the same `startRun`. The window talks to the coordinator over the direct MessagePort ([ADR 0001](../../../docs/adr/0001-coordinator-as-utility-process.md)); layer rules from [ADR 0002](../../../docs/adr/0002-layer-rules-enforced-by-test.md).

Rejected: (a) the renderer owning the thread and asking the coordinator for single answers: a run would die with the window and channel conversations would have no home; (b) one `threads.json` or a database for all threads: every save rewrites everything and one corrupt byte loses all history. One file per thread keeps a bad file from blocking the others and makes retention and delete a file removal.

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`Thread`, `ThreadSummary`, `ChatMessage`, `Block`, `ToolState`, `SubagentRun`, `LiveEvent`, `CoordinatorRequest`), `src/shared/defaults.ts` (`privacy.threadRetentionDays` default 0), `src/shared/desktop-api.ts` (`pickFolder`) | wire types used by coordinator, main and renderer |
| coordinator | `src/coordinator/store.ts` (`ThreadStore`, `summarize`, `UNTITLED`), `src/coordinator/index.ts` (`handle`, `startRun`, `titleFrom`, `applyRetention`, `saveInboxImage`, `VOICE_SESSION_MS`, channel thread creation), `src/coordinator/agent.ts` (`repairDanglingToolUses`, event emission), `src/coordinator/tools/paths.ts` (`resolveInWorkspace`), `src/coordinator/tools/media.ts` (`imageDataUrl`) | disk and the run are I/O for an agent; they must outlive the window |
| main | `src/main/index.ts` (`dialog:pickFolder`, `notify` and `app:openThread`, `setWindowOpenHandler` / `will-navigate`), `src/preload/index.ts` | native dialog, notifications and link policy need Electron |
| renderer | `src/renderer/src/App.tsx`, `components/{ChatView,MessageList,ToolCard,Sidebar,Markdown,WorkspaceImage,ErrorBoundary}.tsx`, `lib/{state,coordinator,attachments,format}.ts`, `src/renderer/index.html` (CSP) | screens, the reducer and attachment composition; no disk or network |

No new arrow against `docs/architecture.md`: renderer and coordinator import only `shared`.

## 3. Contracts
- `ThreadStore`: `list(): ThreadSummary[]`, `get(id): Thread` (throws "La conversación no existe."), `create(agentId, workspace, channel?)`, `delete(id)`, `save(id)` (debounced), `flush(id)`, `flushAll()`.
- Requests: `threads.list | threads.get | threads.create {agentId, workspace} | threads.update {threadId, title?, agentId?, workspace?} | threads.delete`, `chat.send {threadId, text}`, `chat.stop`, `runs.active`, `files.image {threadId, path}`, `files.saveImage {name, base64}`. `approval.*` belongs to 004.
- Events: `run.started`, `run.finished {error?}`, `stream.text | stream.thinking | stream.tool` (with `EventScope {threadId, subagentId?}`), `message`, `tool.state`, `subagent.started | subagent.finished`, `thread.updated {summary}`.
- `startRun(threadId, text, {noAsk?, autoApprove?}): {done}`: throws "Ya hay una ejecución en curso en esta conversación.", "No hay agentes configurados.", "No puede trabajar: <reason>.".
- Renderer: `reducer(state, action)`, `scopeKey(scope)`; `composeMessage(text, attachments)`, `splitMessage(message)`, `textAttachment`, `drawingAttachment`, `fileAttachment`; `threadTitle(title)`, `relativeTime(ts)` in `lib/format.ts`.
- No new tool; `files.image` is a request, not an agent tool.

## 4. Data and persistence
- `<userData>/threads/<uuid>.json`, JSON, mode 0600, written to `<id>.json.tmp` then renamed; saves debounced 300 ms; `flushAll` on shutdown. Older files missing `subagents` / `toolStates` get `{}` on load; unreadable files are skipped with a console error.
- `<userData>/inbox/<base36 time>-<name>` for pasted pictures (`files.saveImage`); privacy erase removes it (spec 022).
- Renderer `localStorage`: last mode, last company, "vault chat open", always inside try/catch; losing it only resets the mode to Chat.
- Retention: `privacy.threadRetentionDays` from settings; deletion writes audit `privacy.retention`.

## 5. Dependency injection
- `runAgent` receives a `RunContext` (settings getter, thread, scope, signal, `emit`, `persist`, broker, host); `startRun` builds it, so the loop never imports the store.
- Tests fake the provider (`vi.mock('../src/coordinator/providers')`), the `ApprovalBroker` event sink and a temp workspace (`tests/agent.test.ts`). Workspace tests use temp folders (`tests/tools.test.ts`).
- `ThreadStore` takes the data dir in its constructor, so a test can point it at a temp folder.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.7 | `tests/agent.test.ts` → `closes tool calls left without results` | already consistent history left alone |
| AC-3.9 | `tests/agent.test.ts` → `asks for approval, runs the tool and feeds the result back` | tool result alternates user/assistant |
| AC-3.20 | `tests/agent.test.ts` → `does not run tools from a turn cut off by max_tokens` | truncated input never runs |
| AC-3.10 | `tests/agent.test.ts` → `denies pending approvals when the run is cancelled` | abort while approving |
| AC-4.10 | `tests/agent.test.ts` → `runs delegated subagents in parallel and returns their results` | two sub-agents at once |
| AC-5.9 | `tests/tools.test.ts` → `rejects paths that escape the workspace`, `requires a workspace` | `..`, absolute path, empty workspace |
| AC-1.1–1.6, 1.8, 1.9 | [gap] | corrupt file, missing id, retention with a running thread |
| AC-2.4–2.6, AC-3.2–3.6, 3.11–3.12, 3.14–3.16, AC-4.11–4.12, AC-5.1–5.3, 5.7, 5.10, AC-6.6, AC-7.1–7.5 | [gap] | double send, vanished agent, over-budget company agent, blank rename |
| AC-2.1–2.3, 2.7–2.11, AC-3.1, 3.7, 3.8, 3.13, 3.17, 3.18, AC-4.1–4.9, 4.13, AC-5.4–5.6, 5.8, AC-6.1–6.5 | [manual] | checked by running the app; see each criterion |

Pure logic extracted from the UI (reducer, attachments, formats) lives under `src/renderer/src/lib`; moving it to `src/shared` for tests is the way to close the `[gap]` rows.

## 7. Security and privacy impact
- No new tool and no new `ToolRisk`. Model output is untrusted: raw HTML is not rendered, remote images are replaced by a placeholder, links open only http(s) in the system browser, CSP allows images from self, `data:`, `blob:`, `alma-vault:` and local 127.0.0.1.
- Vault attachments travel as text labelled "datos, no instrucciones".
- `files.image` is confined to the thread's working folder, PNG/JPEG/WebP, 12 MB.
- Threads store full conversation text in clear on disk. `docs/security/PRIVACY.md` already lists `threads/` with its retention and erase options; no change.

## 8. Rollout
No flag. Existing thread files load unchanged. Retention is off by default (0). First run shows the empty screen with "Nueva conversación"; the last chosen mode defaults to Chat.
