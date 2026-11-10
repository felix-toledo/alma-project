# App shell and interface (App shell)

> The frame around every other feature: the Electron main process (window, single instance, tray, notifications, global shortcut, coordinator process), the `window.desktop` bridge, the four-section navigation, and the console-style (PS5-like) look, sounds and focus navigation. Spec: [023 · App shell e interfaz](../../.specify/specs/023-app-shell-and-ui/spec.md). Test status: 0 criteria with a test, 59 without (32 are manual checks, 27 have no check at all). The only automated guard is the layer rule in `tests/architecture.test.ts`.

## What it does

- Opens one window and keeps Alma alive (routines, Telegram, voice) from the system tray when you close it.
- A second launch does not open a second copy: it shows the running window.
- Shows Windows notifications for finished work and approvals; clicking one opens that conversation. Reminders also appear inside Alma, because Windows can drop toasts.
- Registers a global shortcut that starts voice from any app.
- Starts the agent engine (the coordinator) and restarts it by itself if it crashes.
- Locks the page down: it can only talk to main through a typed bridge, only from its own page, and cannot open programs.
- Lets you move between **Chat**, **Vault**, **Empresas** (companies) and **Casa** (house), and returns you to the last one.
- Gives every screen the same console look: dark glass, a slow animated background, soft synthesized sounds and ambient music, a halo on the focused item, arrow-key and gamepad navigation.

Agents do not touch the shell. They reach it only through coordinator messages: `notify` (a notification), `host.request` (trash a vault file, render an SVG to PNG, publish to Instagram, seal or open a secret), `settings.patch` and `alwaysAllow`.

## How to use it

- **Launch twice**: the second launch brings the first window to the front.
- **Close the window**: with «Al cerrar la ventana, seguir en la bandeja del sistema» (keep running in the tray on close) on, Alma hides. Click the tray icon, or use its menu «Abrir Alma» (open) / «Salir» (quit). «Salir» is the real exit. While remote access is on, the tray icon stays even with «run in tray» off, so the server is never invisible; turning remote access off is its kill switch ([remote-access](remote-access.md)).
- **Start with Windows**: «Configuración» → General → «Abrir al iniciar Windows (minimizada)». It starts hidden (`--hidden`), tray and coordinator still start.
- **Move between sections**: the four tabs at the top of the sidebar: «Chat», «Vault», «Empresas», «Casa». «Nueva conversación» (new conversation) shows in Chat only. At the bottom: the MCP count (when servers exist), the voice button (when voice is enabled), «Rutinas (n)» and «Configuración».
- **First run**: with no conversation the screen shows «Alma» and a «Nueva conversación» button, plus «Primero cargá una API key en Configuración» (load an API key first) when no provider has a key.
- **Reminders**: a toast stack with «Cerrar» (close); it stays until you close it. Sound «notification» plays.
- **Keyboard**: arrow keys move focus to the nearest visible control; Esc closes the «Configuración» and «Rutinas» dialogs. Arrows are left alone in text fields and selects; Left/Right are also left alone on the volume slider. Vault view: Ctrl/Cmd+Shift+F search, +N new note, +W close note, +E toggle reading, +L ask Alma about the selection (see [vault-and-knowledge](vault-and-knowledge.md)).
- **Gamepad**: D-pad or left stick moves focus, A clicks, B goes back (but see "Known limits"). Holding repeats after 380 ms, then every 120 ms.
- **Sound and motion**: «Configuración» → «Sonido y ambiente»: «Sonidos de interfaz», «Música de fondo», «Volumen», «Fondo en movimiento» (moving background). Turning motion off freezes animations everywhere.

## How it works

Pieces:

| Area | Files |
|---|---|
| Main process | `src/main/index.ts` (lifecycle, tray, IPC, permissions, `alma-vault` protocol, host requests), `src/main/render.ts` (SVG to PNG), `src/main/guard.ts`, `src/main/instagram.ts` |
| Preload and contract | `src/preload/index.ts`, `src/shared/desktop-api.ts` (`DesktopApi`), message types in `src/shared/types.ts` |
| Renderer shell | `src/renderer/src/App.tsx`, `components/Sidebar.tsx`, `main.tsx` |
| Design system | `src/renderer/src/umbra/*` (`Backdrop`, `FocusManager`, `useUISound`, `Icon`, `AmbienceControls`, `tokens.css`, `base.css`), `styles.css` |

Startup order (`app.whenReady` in `main/index.ts`): app id `com.alma.app` (Windows only shows notifications for apps with an identity) → `SettingsStore` → `initAudit` → `lockDownPermissions` → `registerIpc` → `registerVaultProtocol` → `startCoordinator` → `createWindow` → tray and login item → voice hotkey. Before that, at module load: `ALMA_USER_DATA`, the `MultiAgente` migration, then the single-instance lock.

```
 renderer ──window.desktop──► preload ──ipcRenderer.invoke──► main  (settings, dialogs, openPath, instagram)
    ▲                           │ ipcRenderer.send('coordinator:connect')
    │ MessagePort               ▼
    └───────────── coordinator:port ◄── main creates MessageChannelMain:
                                         port1 → coordinator ('client'), port2 → window
 coordinator (utilityProcess "Alma Coordinator") ──host.request / notify / settings.patch / alwaysAllow──► main
```

Things that are not obvious:

- **The page talks to the coordinator on a direct `MessagePort`**, not through main. The preload queues requests made before the port exists and flushes them in order. A new port closes the old one and notifies connection listeners; the renderer reloads all its state on every connection. Microphone audio sent while there is no port is dropped, not queued.
- **Crash recovery**: when the coordinator exits with a non-zero code and Alma is not quitting, main restarts it (with `init`) and sends `coordinator:restarted`; the preload answers by asking for a new port. An exit with code 0 is **not** restarted. A later `coordinator:connect` starts it again.
- **Notifications** (`notify` in `main/index.ts`): without `always`, skipped when the window is visible and focused. With `always` (reminders, house alerts) the window also gets `app:reminder`, the taskbar flashes if not focused, and the OS toast is shown even when focused. A click shows the window and sends `app:openThread` if the notification carried a thread.
- **Window**: 1280×820 (minimum 860×560), `#05070d`, menu bar auto-hidden, shown on `ready-to-show` unless `--hidden`, `backgroundThrottling: false` (so voice keeps working while hidden).
- **Tray** exists exactly while `background.runInTray` is true; changing the setting creates or destroys it at once (`applyBackgroundSettings`). Login item is set to `process.execPath` with `--hidden` (packaged) or the app folder plus `--hidden` (unpackaged).
- **Voice hotkey**: registered globally when `voice.enabled` and `voice.hotkey` is non-empty; a taken or invalid accelerator is logged to the console, with nothing shown to the person.
- **`alma-vault://file/<path>`** serves files from the active vault to the sandboxed page (images, embedded drawings). See Security.
- **Hidden render window** (`render.ts`): rasterizes an SVG in a window with no network (only `data:` and `about:` URLs), waits a fixed 300 ms for fonts, writes the PNG and always destroys the window. Partition `alma-render`.
- **Persistence of UI state** is in `localStorage` of the Chromium profile (inside the user-data folder): `alma.mode` (`chat`, `vault`, `companies`, `home`), `alma.company`, `alma.vault.chat`, `umbra.prefs`. An unknown or unreadable value falls back to Chat. Window position and size are not saved.
- **Loading**: on start and on every coordinator (re)connection the renderer loads threads, active runs, pending approvals, MCP status, routines, knowledge, Telegram, voice and WhatsApp status. Conversations with a company agent are listed under Empresas, not in Chat.

**Presence signals** (spec 034): main listens to `powerMonitor` (`lock-screen`, `unlock-screen`, `suspend`, `resume`) and reads `getSystemIdleTime()` once a minute. The pure tracker `trackPresence` (`src/main/presence.ts`) measures the absence each event ends, from the last input before the lock or suspend (or before an idle period on an unlocked PC), and main posts a `presence` message per event, plus one `start` per app process. Nothing is kept in main. The coordinator's `PresenceService` (`src/coordinator/presence.ts`) validates the message, applies the pure once-a-day rule `decideWake` (`src/shared/presence.ts`: an absence of 4 hours or more, at most one signal per day starting at 02:00, only when a consumer can use it) and calls `wake()` on the consumers that can, with no detail. It keeps `presence.json` only while a consumer is on; with spec 034 alone the list is empty, so nothing is stored or offered. Spec 033's morning greeting is the first consumer. To try it by hand: `ALMA_PRESENCE_THRESHOLD_MS=60000 pnpm run dev`.

Design system:

- Dark only (`color-scheme: dark`, `#05070d`). Surfaces are translucent blurred glass. Background: a slow light beam and 26 amber bokeh particles (`umbra/Backdrop.tsx`).
- Hover or keyboard focus on a button: light fill, dark text, scale 1.06 and halo; list buttons, tabs and icon buttons get only a soft halo; disabled controls dim to 40 %. In the thread list the neighbors of the focused row dim to 55 %. Pressed scale 0.97; durations 120/200/320/500 ms.
- Sounds: sine tones synthesized at runtime for 12 events (hover, focus-move, select, back, toggle-on, toggle-off, open-modal, close-modal, error, success, notification, page-transition). Any button, `role=button`/`tab` or link plays «hover» on pointer enter and «select» on click. Nothing sounds before the first click or key press. Per-event cooldowns: hover 80 ms, focus-move 60 ms, error/success 200 ms, notification/page-transition 300 ms.
- Music: a generated loop of four chords (12 s each) with pad, bells, bass and air. It plays only while «Música de fondo» is on, sounds are not muted, the window is visible and you have interacted; it fades and follows the volume live.
- Navigation: `FocusManager` picks the nearest control in the arrow direction (distance plus 2.5× lateral deviation). Gamepad: A = button 0, B = button 1, D-pad = buttons 12–15, stick axes at ±0.6.

## Settings and data

| What | Where | Default |
|---|---|---|
| `background.runInTray` | `settings.json` | on |
| `background.launchAtLogin` | `settings.json` | off |
| `voice.enabled`, `voice.hotkey` | `settings.json` | off, `Control+Alt+Space` |
| Sound prefs (muted, volume, music, motion) | `localStorage` key `umbra.prefs` | not muted, volume 0.7, music on, motion on unless the OS asks for reduced motion |
| Section, company, vault chat panel | `localStorage` keys `alma.mode`, `alma.company`, `alma.vault.chat` | Chat |

Without `localStorage` the preferences last for the session only. Details of `settings.json`: [settings](settings.md).

## Limits and rules

- Window 1280×820, minimum 860×560. App id `com.alma.app`. Tray tooltip «Alma».
- Music master level 0.32 scaled by volume/0.7; chord length 12 s.
- Gamepad repeat 380 ms then 120 ms; stick threshold 0.6.
- Render window waits 300 ms before drawing; the requested PNG size is honored.
- Reminder toasts have `role="status"` and `aria-live="assertive"`.
- The IPC allow-list (invoke): `settings:get`, `settings:update`, `settings:setApiKey`, `settings:setCompanySecret`, `instagram:status`, `instagram:connect`, `instagram:disconnect`, `dialog:pickFolder`, `shell:openPath`, `vault:defaultPath`; send: `coordinator:connect`. Main to window: `coordinator:port`, `coordinator:restarted`, `settings:changed`, `app:openThread`, `app:reminder`. Full list: [ipc-messages](../references/ipc-messages.md).
- `window.desktop` exposes only: `platform`; `coordinator.send/sendAudio/onMessage/onConnected`; `settings.get/update/setApiKey/setCompanySecret/onChanged`; `instagram.status/connect/disconnect`; `onOpenThread`; `onReminder`; `pickFolder`; `openPath`; `defaultVaultPath`. Every listener returns an unsubscribe function (confirmed in `src/preload/index.ts`).

## Security and privacy

Checked against `src/main/index.ts`:

- `contextIsolation` on, `nodeIntegration` off, `sandbox` on. CSP in `src/renderer/index.html`: scripts only from `self`; `object-src`, `base-uri` and `form-action` are `none`; images from self, `data:`, `blob:`, `alma-vault:` and `http://127.0.0.1:*`; `connect-src` self and `alma-vault:`. `media-src` also allows `https:` (a gap, see [security](security.md)).
- Links with `http(s)` go to the system browser; other schemes are denied. `will-navigate` and `will-redirect` are blocked unless the URL is the window's own. `<webview>` is blocked.
- IPC gate `isTrusted`: only the top frame of the app's own window, still on the page it loaded. Otherwise «Origen no autorizado» and `ipc.rejected` (throttled). The `coordinator:connect` listener ignores untrusted callers silently, without an audit entry.
- Permissions: only the main window, only audio capture (no video) and `clipboard-sanitized-write`. Everything else is denied.
- `shell:openPath` needs an absolute existing path. Files with an executable or script extension (`exe, bat, cmd, com, msi, ps1, vbs, js, lnk, jar, reg, dll, sh, app, desktop` and more) answer «Alma no abre programas ni scripts.» ("Alma does not open programs or scripts") and audit `shell.openPath` denied. A missing path answers «La ruta no existe.».
- `alma-vault://`: served only inside the active vault, after resolving symlinks, with no dot-prefixed segment; otherwise 404. Responses carry `Access-Control-Allow-Origin: *` because the page reads embedded drawings with `fetch()`.
- `trash` host request: only inside the active vault and never the vault root («Ruta fuera del vault.»); audited as `vault.trash`.
- The renderer cannot import `electron`, `node:*` or `shared/audit` (enforced by `tests/architecture.test.ts`).
- Nothing leaves the machine from the shell itself. It stores no personal data besides UI preferences.

More: [security](security.md).

## How it is tested

No criterion of spec 023 has a dedicated test. `tests/architecture.test.ts` enforces the layer rules (renderer cannot import main, `electron`, `node:*`). The renderer has no component tests; typecheck, lint and a manual run cover it.

By hand: launch the exe twice; start with `--hidden` and look for the tray icon; close the window and use the tray; toggle tray and login item (Windows "Aplicaciones de inicio"); let a routine finish while hidden and click the toast; create a reminder one minute ahead; press the voice hotkey from another app; kill the coordinator process and watch it come back; Tab and arrow through the sidebar; connect a gamepad; toggle «Fondo en movimiento»; click a link in a chat message.

## Known limits

1. The light theme exists in CSS but nothing sets `data-theme`, so the app is always dark. `lib/ambience.ts` and `components/Ambience.tsx` implement a theme toggle and are imported by nothing.
2. Two overlapping ambience implementations (`lib/ambience.ts`, key `ambience`; `umbra/useUISound.ts`, key `umbra.prefs`); only the second is wired. Also unused: the `.backdrop` rules in `styles.css`, `FocusScope`/`useBack`, `SETTINGS_ICONS`, the sound file hook.
3. Esc is handled by each dialog; `umbra:back` is dispatched but nobody listens, so gamepad B does nothing in dialogs.
4. A coordinator exit with code 0 is not restarted and the window shows nothing; you must reopen the app.
5. Reminder toast CSS (`reminder-stack`) lives in `vault/vault.css`.
6. macOS branches (`activate`, `window-all-closed`) exist while the app is Windows-first. Product decision: is macOS wanted?
7. `coordinator:connect` untrusted calls are not audited, unlike invoke channels. See.
8. A taken or invalid voice hotkey fails with a console log only; the person sees nothing. No spec question; confirmed in `applyVoiceHotkey`.
9. Window position and size are not remembered. Rationale not documented.

## See also

[settings](settings.md) · [security](security.md) · [chat](chat.md) · [voice](voice.md) · [routines](routines.md) · [vault-and-knowledge](vault-and-knowledge.md) · [companies](companies.md) · [home](home.md) · [ipc-messages](../references/ipc-messages.md) · [architecture](../architecture.md)
