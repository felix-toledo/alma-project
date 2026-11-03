# 023 — Plan

## 1. Approach
Three pieces. The main process is a thin shell: one window, one instance, a tray, native notifications, a global shortcut, and a supervisor for the coordinator utility process; it keeps nothing the agents need. The preload exposes one typed object, `window.desktop`, and nothing else, and opens a direct `MessagePort` between the page and the coordinator, so chat traffic never goes through main ([ADR 0001](../../../docs/adr/0001-coordinator-as-utility-process.md)). The renderer is a single-page React app with four sections (Chat, Vault, Empresas, Casa) and a console-style design system ("umbra": tokens, base CSS, a focus manager, synthesized sounds, an animated backdrop) that every screen shares.

Rejected: exposing `ipcRenderer` or a generic `invoke(channel, …)` to the page. It is less code, but it hands any injected script every channel; a fixed list of named methods keeps the surface auditable and testable. Also rejected: audio files and a CSS animation library for sounds and motion; synthesizing tones with the Web Audio API costs no assets and lets "mute" and "freeze" be one preference each. Layer rules are in [ADR 0002](../../../docs/adr/0002-layer-rules-enforced-by-test.md).

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/desktop-api.ts` (`DesktopApi`), `src/shared/types.ts` (`ParentToCoordinator`, `CoordinatorToParent`, `HostRequest`, `RequestEnvelope`, `CoordinatorMessage`) | The contract the preload, main and renderer all type against |
| coordinator | none (it only receives `init`, `settings`, `client`, `host.result`, `voice.trigger` and sends `notify`, `alwaysAllow`, `host.request`, `settings.patch`) | Stays unaware of windows |
| main | `src/main/index.ts` (window, single instance, tray, login item, notifications, shortcut, permissions, coordinator supervision, IPC handlers, `alma-vault://`, native dialogs), `src/main/render.ts` (SVG to PNG), `src/main/guard.ts`, `src/main/instagram.ts`, `resources/icon.png`, `resources/tray.png` | Only main has Electron windows, tray, shell and dialogs |
| preload | `src/preload/index.ts`, `src/preload/api.d.ts` | The only code that sees both worlds; queues requests until the port arrives |
| renderer | `src/renderer/src/App.tsx`, `main.tsx`, `components/Sidebar.tsx`, `styles.css`, `umbra/` (`tokens.css`, `base.css`, `plain-app.css`, `Backdrop.tsx`, `FocusManager.tsx`, `Icon.tsx`, `useUISound.ts`, `sounds.config.ts`, `AmbienceControls.tsx`), `lib/coordinator.ts`, `lib/state.ts` | UI only; talks to the coordinator through `request` and `onEvent` |

`renderer` imports no `electron`, `node:*` or `shared/audit`; `tests/architecture.test.ts` enforces it.

## 3. Contracts
- `DesktopApi`: `platform`; `coordinator.send / sendAudio / onMessage / onConnected`; `settings.get / update / setApiKey / setCompanySecret / onChanged`; `instagram.status / connect / disconnect`; `onOpenThread`; `onReminder`; `pickFolder`; `openPath`; `defaultVaultPath`. Every `on…` returns an unsubscribe function.
- IPC invoke: `settings:get`, `settings:update`, `settings:setApiKey`, `settings:setCompanySecret`, `instagram:status`, `instagram:connect`, `instagram:disconnect`, `dialog:pickFolder`, `shell:openPath`, `vault:defaultPath`; send: `coordinator:connect`; main to renderer: `coordinator:port`, `coordinator:restarted`, `settings:changed`, `app:openThread`, `app:reminder`.
- Main to coordinator (`ParentToCoordinator`): `init`, `settings`, `client`, `host.result`, `voice.trigger`; coordinator to main (`CoordinatorToParent`): `alwaysAllow`, `host.request`, `notify`, `settings.patch`.
- Renderer API: `request<T>(req)`, `onEvent(listener)`, `onConnected(listener)`; `playUISound(event)`; `UISoundEvent` (12 events); `move(dir)`, `FocusProvider`, `Backdrop({ particles, reduceMotion })`, `Icon` with sizes 20 / 24 / 32 and stroke 1.75.
- `localStorage` keys: `alma.mode`, `alma.company`, `alma.vault.chat`, `umbra.prefs`.

## 4. Data and persistence
Window size, position and tray state are not saved. Settings travel through main's `SettingsStore` (see 006); the renderer keeps only UI preferences in `localStorage` inside the Chromium profile under the user-data folder: last section, selected company, vault chat panel, and `umbra.prefs` (muted, volume 0.7, music, motion). Nothing is written when storage is unavailable; the preferences then last for the session.

## 5. Dependency injection
The shell has no injected seams: it is Electron wiring. Logic that could be unit-tested was kept out of it on purpose (the command guard is a pure function in `src/main/guard.ts`, access and path checks live in the coordinator). The renderer reaches main only through `window.desktop` and the coordinator only through `lib/coordinator.ts`, so a screen can be driven by stubbing those two modules; the repository has no component test harness, so this is checked by typecheck, lint and a manual run.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1–1.7, 2.3, 2.5, 3.1, 5.1, 7.2, 8.1, 8.2, 8.5–8.9, 9.1–9.6, 9.8, 9.9, 9.11, 9.12, 10.1, 10.2, 10.4 | [manual] | second launch, `--hidden`, close to tray, click a toast, Tab through the sidebar with and without a gamepad, reload after switching section |
| AC-1.8, 2.1, 2.2, 2.4, 3.2, 4.1–4.4, 4.6, 5.2–5.6, 6.1–6.4, 7.1, 8.3, 8.4, 9.7, 9.10, 10.3, 10.5 | [gap] | backlog: coordinator exits with code 1 and with 0, untrusted IPC sender, `.exe` through `openPath`, symlink through `alma-vault://`, hotkey already taken |

No AC here has an automated test yet: the main process and the renderer have no test seam beyond the pure guard (covered in 022). New logic added to this shell goes into `src/shared` or the coordinator first so it can be tested.

## 7. Security and privacy impact
No tools. The window runs with context isolation, sandbox, no Node integration and a CSP limiting scripts to the app; only the top frame of the app's own page may use IPC (rejections audited as `ipc.rejected`); permission requests are granted only to the main window for audio capture and clipboard writes; `shell:openPath` refuses executable and script extensions; `alma-vault://` refuses dot-folders and links that leave the vault; the render window blocks all network. The controls themselves and their audit entries are specified in `../022-security-and-privacy/spec.md`; no new file in `docs/security/` is required.

## 8. Rollout
Settings: `background.runInTray` and `background.launchAtLogin` (login item opens with `--hidden`), `voice.enabled` and `voice.hotkey`, and the Sonido y ambiente switches («Fondo en movimiento», «Música de fondo», «Sonidos de interfaz», volume). Defaults: sounds on, music on, motion following the OS `prefers-reduced-motion`, dark theme. First run: one window opens on Chat; with no conversation it shows «Alma», «Nueva conversación» and, if no provider has a key, the hint to load one in Configuración. Nothing sounds until the first click or key press.
