# 012 — Plan

## 1. Approach
Publishing is split across the process boundary on purpose. The coordinator owns the tool (`instagram_publish`): it validates the post, builds the approval preview and asks the main process, through the host request channel, to publish. The main process owns the browser: the person logs in once on Instagram's real login page in an Electron window with its own partition (`persist:instagram`), so Alma keeps cookies and never the password; later posts are made by driving the Instagram website in a visible window with the Chrome DevTools protocol. A "test mode" setting, on by default, fills the whole post but never clicks "Compartir". Any failure leaves the window open so the person can finish by hand.
Rejected: Instagram's Graph API, which needs a Business or Creator account tied to a Facebook page and an app review, so it does not fit a personal desktop tool; and asking the person for their password, which Alma must never handle. See [ADR 0011](../../../docs/adr/0011-instagram-in-app-browser-session.md).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`InstagramStatus`, `Settings.instagram`, `HostRequest`), `src/shared/defaults.ts` (`instagram.testMode: true`, `community-manager` agent, `BUILTIN_TOOLS`), `src/shared/desktop-api.ts` (`instagram` API) | Vocabulary shared by coordinator, main, preload and renderer |
| coordinator | `src/coordinator/tools/media.ts` (`instagramPublishTool`), `src/coordinator/index.ts` (`host.request` bridge, "Post listo para Instagram" notification), `src/coordinator/approval.ts` (the `publish` rule, shared with other tools), `src/coordinator/tools/paths.ts` (workspace check) | The tool and the approval flow run in the utility process, which cannot open windows |
| main | `src/main/instagram.ts` (new: session, login window, `publishToInstagram`), `src/main/index.ts` (host request handler, IPC handlers, audit), `src/preload/index.ts` (`instagram.*` bridge) | Only main owns windows, sessions and the debugger |
| renderer | `src/renderer/src/components/SettingsDialog.tsx` (`InstagramTab`), `src/renderer/src/components/ToolCard.tsx` (post preview, "Publicar"), `src/renderer/src/components/RoutinesDialog.tsx` (template) | Display and the few controls |

No arrow breaks `docs/architecture.md`: the coordinator reaches main only through `HostRequest`, and `electron` stays in `src/main/`.

## 3. Contracts
- `InstagramStatus = { connected: boolean }`; `Settings.instagram = { testMode: boolean }`.
- `HostRequest` member `{ action: 'instagram.publish'; imagePath: string; caption: string; testMode: boolean }`; the reply is `{ ok: boolean; message: string }` (`host.request` → `{ type: 'host.request', reqId, request }`, answered by `{ type: 'host.result', reqId, ok, message }`).
- Tool `instagram_publish` — `ToolRisk` `publish`, not standalone; input `{ image_path: string; caption: string (max 2200) }`; `preview` returns `{ imageDataUrl?, caption, note? }`.
- Preload / IPC: `window.desktop.instagram.status|connect|disconnect` over `instagram:status|connect|disconnect`, each returning `InstagramStatus`.
- Main: `instagramStatus()`, `connectInstagram(parent?)`, `disconnectInstagram()`, `publishToInstagram(PublishRequest)`; `INSTAGRAM_PARTITION = 'persist:instagram'`.
- Audit events: `instagram.connect`, `instagram.disconnect` (actor `user`), `instagram.publish` (actor `agent`, outcome only).

## 4. Data and persistence
- Session cookies live in the Electron partition `persist:instagram` under the user data folder; "connected" means a non-empty `sessionid` cookie.
- `settings.json` holds `instagram.testMode`; older files without the section get the default.
- No post history is stored; the agent's own `publicaciones.md` is a convention of its prompt.
- The legacy "MultiAgente" profile folder is carried over once when the new profile has no `settings.json`.

## 5. Dependency injection
The tool receives `ToolContext.host` (`request`), `ToolContext.settings` and the workspace, so tests fake the host and observe the request it received. Approval seams are `ApprovalBroker` and the settings object in `tests/agent.test.ts`. The base URL comes from `ALMA_INSTAGRAM_URL`, so the browser automation can be pointed at a local stand-in page instead of Instagram. The automation itself needs a display and is checked by hand.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1–1.4, 2.1 | [manual] fresh profile, log in with a real account, close the window early, disconnect and reopen the tab | window closed before logging in |
| AC-2.2, 2.3 | [gap] | empty `sessionid` cookie |
| AC-6.1, 3.1 | `tests/media.test.ts` → `previews the post and hands it to the host` | |
| AC-6.2–6.4 | `tests/media.test.ts` → `rejects missing images, unsupported formats and too many hashtags` | missing file, `.gif`, 31 hashtags |
| AC-6.6 | `tests/media.test.ts` → `reports the host failure to the model` | host answers `ok: false` |
| AC-6.5, 6.7, 6.8 | [gap] | caption of 2201 characters, `..` path, no working folder |
| AC-3.2 | `tests/media.test.ts` → `previews the post and hands it to the host` (note on); note off is [gap] | |
| AC-3.3 | `tests/agent.test.ts` → `always asks before publishing, even when everything else is allowed` | "allow all" plus an "always allow" rule |
| AC-3.4 | `tests/agent.test.ts` → `blocks publishing in read-only mode` | |
| AC-3.5, 3.8, 3.9 | [gap] | rejection, cancellation, image over 12 MB, boss flag |
| AC-3.6, 3.7, 7.5 | [manual] trigger a publish with the community manager (window focused and unfocused) and read Settings → Agentes | |
| AC-4.1, 5.2, 5.3 | [gap] | no session, exception while publishing |
| AC-4.2–4.4, 5.1 | [manual] run against a real account (test mode on and off) and against a stand-in page without the "Crear" button | confirmation never appears |
| AC-7.1, 7.4 | [gap] | settings from an older version |
| AC-7.2, 7.3 | [manual] toggle test mode and publish; open Rutinas and use the template | |

## 7. Security and privacy impact
- `instagram_publish` is `publish`: asks on every call whatever the approval mode, rules or per-agent list; no "Siempre"; boss review first inside a company; only "solo lectura" blocks it. The approval shows the real image and caption.
- Alma never sees the password. Cookies stay in a separate partition on this machine; disconnecting clears it. Image and caption leave the machine only when a post is published, to Instagram (Meta).
- The window is sandboxed (`contextIsolation`, `sandbox`, no Node); injected helpers only read the DOM. Audit records actions without caption or image content.
- `docs/security/PRIVACY.md` lists Instagram under "Publicaciones, siempre con aprobación" (the post leaves the machine only after approval).

## 8. Rollout
Test mode is on by default, so the first publishes stop before "Compartir". Instagram is not connected until the person presses "Conectar Instagram"; with no session the tool fails with a message pointing to Configuración → Instagram. The "Post diario de Instagram" routine is only a template: nothing is scheduled until the person saves it.
