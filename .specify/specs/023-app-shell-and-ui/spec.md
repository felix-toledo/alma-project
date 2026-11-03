---
status: implemented
---

# 023 — App shell e interfaz

## 1. Summary
The frame that holds every other feature: the Electron main process (one window, one instance, system tray, native notifications, the
voice shortcut, the coordinator utility process and the message port to it), the preload bridge `window.desktop` with every IPC
channel, the renderer's navigation between four sections (Chat, Vault, Empresas, Casa), and the console-style (PS5-like) design
system: dark glass surfaces, an animated ambient background, synthesized interface sounds and ambient music, keyboard and gamepad
focus navigation, the focus halo, reminder toasts and modal dialogs.

## 2. Problem and goal
Alma must keep running (routines, Telegram, voice) when its window is closed, start with Windows if asked, never let the page reach
disk or network, and still feel like one calm, game-console-like app. Done means: closing the window hides it to the tray, a second
launch just shows the running app, a notification click opens the right conversation, a crashed coordinator comes back by itself,
and every screen shares the same look, sounds and focus behavior with options to mute or freeze them.

## 3. Scope
**In:**
- Main-process lifecycle: window, single instance, tray, login item, notifications, global shortcut, permissions, coordinator start/restart, the `alma-vault` protocol, native dialogs, the host requests main serves (`src/main/index.ts`, `src/main/render.ts`).
- Preload and `DesktopApi` (`src/preload/index.ts`, `src/shared/desktop-api.ts`), the IPC channels and their security gate.
- Renderer shell: `App.tsx`, `Sidebar.tsx`, section switching, dialogs hosting, reminder toasts, empty state.
- Design system: `src/renderer/src/umbra/*`, `src/renderer/src/styles.css`, `src/renderer/src/main.tsx`, `src/renderer/src/lib/ambience.ts`, `src/renderer/src/components/Ambience.tsx`.

**Out (and why):**
- Chat messages, composer, tool cards: `../002-chat/spec.md`. Each section's own screens: Vault `../008-vault/spec.md`, Empresas `../007-companies/spec.md`, Casa `../013-house-engine-and-devices/spec.md` and `../014-house-plan-cameras-and-rules/spec.md`.
- The settings document, secrets and the Settings dialog tabs: `../006-settings/spec.md`. Rutinas dialog: `../018-routines-and-reminders/spec.md`. Voice overlay and microphone: `../019-voice/spec.md`.
- Instagram browser session and publishing: `../012-instagram/spec.md`. Audit trail and the privacy controls: `../022-security-and-privacy/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want Alma to open one window and, if I launch it again, show that window instead of a second copy.
- **US-2** As a person, I want to close the window and keep Alma (routines, channels, voice) running from the system tray.
- **US-3** As a person, I want OS notifications for finished work and approvals, and clicking one to open that conversation.
- **US-4** As a person, I want reminders to also appear inside Alma, since Windows can drop toasts.
- **US-5** As a person, I want a global shortcut that starts voice from any app.
- **US-6** As a person, I want the agent engine to restart by itself if it crashes, without losing my window.
- **US-7** As the maintainer, I want the page sandboxed: it can only talk to main through a typed bridge, from its own page, and cannot open programs.
- **US-8** As a person, I want to move between Chat, Vault, Empresas and Casa and return to the last section after a restart.
- **US-9** As a person, I want the interface to feel like a console: calm background, glass, halo on the focused item, soft sounds and music, that I can mute or freeze.
- **US-10** As a person, I want to drive the app with arrow keys or a gamepad, and Esc/B to go back.

## 5. Acceptance criteria

### Window, instance, tray (US-1, US-2)
- **AC-1.1** (US-1) Given Alma is starting, when it holds the single-instance lock, then it opens one window 1280×820 (minimum 860×560), title «Alma», dark background `#05070d`, menu bar auto-hidden, shown when ready. [manual] Launch Alma and check size and that the window appears only when painted.
- **AC-1.2** (US-1) Given Alma is already running, when a second copy is launched, then the second process exits and the running window is shown, restored if minimized, and focused. [manual] Launch the exe twice.
- **AC-1.3** (US-1) Given Alma was started with `--hidden` (the login item), when the window is ready, then it is not shown; the tray icon and the coordinator still start. [manual] Start with `--hidden` and look for the tray icon.
- **AC-1.4** (US-2) Given `background.runInTray` is true, when the window is closed, then it is hidden, not destroyed, and Alma keeps running; the tray icon (tooltip «Alma») has a menu «Abrir Alma» / «Salir» (the `es` values; the menu and tooltip follow `language`, so changing it relabels the tray at once) and a click on the icon shows the window. [manual] Close the window, click the tray icon, then use «Salir».
- **AC-1.5** (US-2) Given `runInTray` is false, when the last window closes, then the app quits and the tray icon is removed; changing the setting at runtime creates or destroys the tray immediately. [manual] Toggle the setting and close the window.
- **AC-1.6** (US-2) «Salir» in the tray menu, or any quit, kills the coordinator process and unregisters global shortcuts. [manual] Quit from the tray and check that no Alma process remains.
- **AC-1.7** (US-2) Given `background.launchAtLogin` changes, when settings are pushed, then Windows' login item is set to the app path with `--hidden` (packaged) or the app folder plus `--hidden` (unpackaged). [manual] Toggle it and look in Windows «Aplicaciones de inicio».
- **AC-1.8** (US-1) On macOS-style activation (`activate`) the window is shown or recreated; closing all windows does not quit on macOS. [gap]

### Notifications and reminders (US-3, US-4)
- **AC-2.1** (US-3) Given the coordinator sends `notify` without `always`, when the window is visible and focused, then no OS notification is shown. [gap]
- **AC-2.2** (US-3) Given `notify` without `always` and the window hidden, minimized or unfocused, when notifications are supported, then an OS notification with the title, body and Alma icon is shown. [gap]
- **AC-2.3** (US-3) When the person clicks the notification, then the window is shown/focused and, if the notification carried a thread, the renderer receives `app:openThread` and opens that conversation. [manual] Let a routine finish while the window is hidden, click the toast.
- **AC-2.4** (US-4) Given `notify` with `always` (reminders, house alerts), when the window exists, then it also receives `app:reminder` {title, body}, and the taskbar icon flashes if the window is not focused; the OS toast is shown even when the window is focused. [gap]
- **AC-2.5** (US-4) When the renderer receives a reminder, then it plays the «notification» sound and adds a toast to a stack (`role="status"`, `aria-live="assertive"`) that stays until closed with its «Cerrar» button. [manual] Create a reminder one minute ahead and leave the window open.

### Global shortcut (US-5)
- **AC-3.1** (US-5) Given `voice.enabled` and a non-empty `voice.hotkey`, when settings are pushed, then that accelerator is registered globally and pressing it sends `voice.trigger` to the coordinator; changing or disabling it unregisters the previous one. [manual] Enable voice and press `Control+Alt+Space` from another app.
- **AC-3.2** (US-5) Given the accelerator is taken by another app or is invalid, when registering, then main logs the problem and no shortcut is held (no error shown to the person). [gap]

### Coordinator process and port (US-6)
- **AC-4.1** (US-6) On start, main forks `coordinator.js` as a utility process named «Alma Coordinator» and sends it `init` with the user-data folder and the full settings. [gap]
- **AC-4.2** (US-6) Given the coordinator exits with a non-zero code while Alma is not quitting, when it exits, then main logs it, starts a new coordinator (with `init`) and sends `coordinator:restarted` to the window, which asks for a new port. [gap]
- **AC-4.3** (US-6) Given the coordinator exits with code 0 or Alma is quitting, then it is not restarted; a later `coordinator:connect` from the window starts it again. [gap]
- **AC-4.4** (US-6) When a trusted window sends `coordinator:connect`, then main creates a `MessageChannelMain`, gives one end to the coordinator (`client`) and the other to the window as `coordinator:port`; an untrusted sender is ignored. [gap]
- **AC-4.5** (US-6) The preload queues requests made before the port arrives and flushes them in order when it does; a new port closes the previous one and notifies connection listeners; the renderer reloads all its state on every connection. [gap]
- **AC-4.6** (US-6) Microphone audio sent while there is no port is dropped, not queued. [gap]

### Security of the shell (US-7)
- **AC-5.1** (US-7) The window runs with `contextIsolation` on, `nodeIntegration` off, `sandbox` on, and a CSP limiting scripts to the app itself. [manual] Inspect `webPreferences` and the `<meta>` CSP in `src/renderer/index.html`.
- **AC-5.2** (US-7) Links with `http(s)` that the page tries to open go to the system browser; other schemes are denied; the window cannot navigate or redirect away from its own page; `<webview>` is blocked. [gap]
- **AC-5.3** (US-7) Only the top frame of the app's own window, still on the page it loaded, may use `ipcMain.handle` channels; anything else gets "Origen no autorizado" and an `ipc.rejected` audit entry. [gap]
- **AC-5.4** (US-7) Permission requests are granted only to the main window and only for audio capture (no video) and sanitized clipboard writes; everything else (camera, location, USB…) is denied. [gap]
- **AC-5.5** (US-7) `shell:openPath` requires an absolute existing path; for a file whose extension is executable or scriptable (`exe, bat, cmd, com, msi, ps1, vbs, js, lnk, jar, reg, dll, sh, app, desktop`…) it refuses with «Alma no abre programas ni scripts.» and audits `shell.openPath` denied; a missing path returns «La ruta no existe.»; otherwise the OS opens it and the result string is returned. [gap]
- **AC-5.6** (US-7) `alma-vault://file/<relative path>` serves a file only when it is inside the active vault (after resolving symlinks), no path segment starts with a dot, and a vault is active; otherwise 404; allowed responses carry `Access-Control-Allow-Origin: *`. Owner of vault behavior: `../008-vault/spec.md`. [gap]

### Host requests main serves for the coordinator (US-7)
- **AC-6.1** (US-7) `host.request` `trash` moves a file to the system trash only if it is inside the active vault and not the vault root; otherwise it replies «Ruta fuera del vault.». [gap]
- **AC-6.2** (US-7) `host.request` `image.render` rasterizes an SVG to a PNG of the requested size in a hidden window with no network (only `data:` and `about:` URLs), waits 300 ms for fonts, writes the file and replies with its path; an invalid SVG replies «el SVG no es válido…»; the hidden window is always destroyed. [gap]
- **AC-6.3** (US-7) `host.request` `instagram.publish`, `secret.seal`, `secret.open` are served by main; a rejected handler replies `ok: false` with the error message. See `../012-instagram/spec.md` and `../006-settings/spec.md`. [gap]
- **AC-6.4** (US-7) The Instagram connect/disconnect IPC calls are audited (`instagram.connect`, `instagram.disconnect`). [gap]

### Preload API (US-7)
- **AC-7.1** (US-7) The page sees only `window.desktop` with: `platform`; `coordinator.send/sendAudio/onMessage/onConnected`; `settings.get/update/setApiKey/setCompanySecret/onChanged`; `instagram.status/connect/disconnect`; `onOpenThread`; `onReminder`; `pickFolder`; `openPath`; `defaultVaultPath`. Every listener registration returns an unsubscribe function. [gap]
- **AC-7.2** (US-7) `dialog:pickFolder` opens a native folder dialog (create-folder allowed) and returns the path or `null` when cancelled; `vault:defaultPath` returns `Documents\Alma\Vault`. [manual] Use «Elegir…» in General and cancel.

### Navigation in the renderer (US-8)
- **AC-8.1** (US-8) The sidebar has the brand, four tabs «Chat», «Vault», «Empresas», «Casa», a «Nueva conversación» button (Chat only), the section's list, and at the bottom the MCP count (when servers exist), the voice button (when voice is enabled), «Rutinas (n)» and «Configuración». [manual] Click through each tab.
- **AC-8.2** (US-8) The last section (`alma.mode`), selected company (`alma.company`) and whether the vault chat panel is open (`alma.vault.chat`) are remembered in `localStorage`; an unknown or unreadable value falls back to Chat. [manual] Switch to Casa, reload, and check Casa opens.
- **AC-8.3** (US-8) On start and on every coordinator (re)connection, the renderer loads threads, active runs, pending approvals, MCP status, routines, knowledge, Telegram, voice and WhatsApp status; at first load it opens the first non-company conversation if any. [gap]
- **AC-8.4** (US-8) Conversations with a company agent are listed under Empresas, not in the Chat list. [gap]
- **AC-8.5** (US-8) With no conversation open in Chat, the screen shows «Alma» with a «Nueva conversación» button, and, if no provider has a key or environment key, the hint «Primero cargá una API key en Configuración». [manual] Start with a clean profile.
- **AC-8.6** (US-8) The Vault section without an active vault shows the welcome with «create» and «open folder» actions; creating uses `Documents\Alma\Vault`. [manual] See `../008-vault/spec.md`.
- **AC-8.7** (US-8) When a notification or "Abrir nota" asks to open a conversation or a note, the renderer switches to the right section and opens it. [manual] Click a notification; use «Abrir nota» in a tool card.
- **AC-8.8** (US-8) The Settings dialog opens from the sidebar, from the empty state, from a chat's key warning, and on the `teams` or `home` tab from Empresas and Casa; the Rutinas dialog from the sidebar; both close with Esc. [manual] Open each entry point.
- **AC-8.9** (US-8) Keyboard shortcuts inside the Vault view: Ctrl/Cmd+Shift+F search, +N new note, +W close note, +E toggle reading, +L ask Alma about the selection. [manual] See `../008-vault/spec.md`.

### Design system (US-9)
- **AC-9.1** (US-9) The app is dark by default (`color-scheme: dark`, background `#05070d`); surfaces (sidebar, header, composer, modal, cards, tool cards) are translucent blurred glass over the background. [manual] Look at the app against the background.
- **AC-9.2** (US-9) An animated background sits behind the app: a slow light beam and 26 amber bokeh particles with random size, speed, and drift. [manual] Watch it for a minute.
- **AC-9.3** (US-9) «Fondo en movimiento» off (Settings → Sonido y ambiente) pauses animations and transitions app-wide (`html[data-motion="reduced"]`); the default follows the OS `prefers-reduced-motion`; with that OS preference animations are shortened to 0.01 ms regardless. [manual] Toggle the switch and watch the background and hover transitions stop.
- **AC-9.4** (US-9) Hovering or keyboard-focusing a button lights it (light fill, dark text), scales it 1.06 and draws the halo; list buttons, tabs and icon buttons get only a soft halo; disabled controls are dimmed to 40 % and show a not-allowed cursor. [manual] Hover and Tab through the sidebar.
- **AC-9.5** (US-9) In the thread list, the neighbors of the focused row dim to 55 %. [manual] Focus a conversation and look at the others.
- **AC-9.6** (US-9) Interface sounds are synthesized (sine tones) for 12 events: hover, focus-move, select, back, toggle-on, toggle-off, open-modal, close-modal, error, success, notification, page-transition. Any button, role button/tab or link plays «hover» on pointer enter and «select» on click. Nothing sounds before the first click or key press. [manual] Click once, then hover buttons.
- **AC-9.7** (US-9) Same-event sounds respect a per-event cooldown (hover 80 ms, focus-move 60 ms, error/success 200 ms, notification/page-transition 300 ms, others 0); muted prefs play nothing. [gap]
- **AC-9.8** (US-9) Ambient music is a generated loop of four chords (12 s each) with pad, bells, bass and air; it plays only while «Música de fondo» is on, «Sonidos de interfaz» is not muted, the window is visible and the user has interacted, fades in/out, and follows the volume slider live. [manual] Toggle music and minimize the window.
- **AC-9.9** (US-9) Sound preferences (muted, volume 0.7, music on, motion) persist in `localStorage` key `umbra.prefs`; without storage they last for the session. [manual] Change the volume and reload.
- **AC-9.10** (US-9) A light theme exists in CSS (`:root[data-theme='light']`) but no running screen sets `data-theme`, so the app is always dark. [gap]
- **AC-9.11** (US-9) Modals (Configuración, Rutinas) are centered glass panels over a dimmed blurred backdrop; in Configuración a click on the backdrop closes it, and Esc closes both. [manual] Open Configuración and click outside; open Rutinas and press Esc.
- **AC-9.12** (US-9) Icons come from one wrapper with fixed sizes (sm 20, md 24, lg 32) and stroke 1.75. [manual] Visual check.

### Keyboard and gamepad navigation (US-10)
- **AC-10.1** (US-10) Arrow keys move focus to the nearest visible control in that direction (distance plus 2.5× lateral deviation), scroll it into view and play «focus-move»; with nothing focused the first control gets focus. [manual] Press arrows from the sidebar.
- **AC-10.2** (US-10) Arrow keys are left alone inside text inputs, textareas and selects; Left/Right are also left alone inside elements marked `data-consumes-lr` (the volume slider). [manual] Type in the composer and use arrows; drag the volume with Left/Right.
- **AC-10.3** (US-10) Esc dispatches the `umbra:back` event to the window. [gap]
- **AC-10.4** (US-10) A connected gamepad drives the same navigation: D-pad or left stick (threshold 0.6) moves focus, A clicks the focused control, B dispatches `umbra:back`; holding repeats after 380 ms then every 120 ms. [manual] Connect a controller and navigate.
- **AC-10.5** (US-10) `FocusScope` with `trap` confines navigation to its group and returns focus to the opener on close; it is available but no current screen uses it, so arrow navigation works over the whole page. [gap]

## 6. Business rules
- **BR-1** Only one Alma instance runs; a second launch exits and shows the first window. (src/main/index.ts)
- **BR-2** With `background.runInTray` true, closing the window hides it; the app quits only through «Salir» or an explicit quit; with it false, closing the last window quits (not on macOS). (src/main/index.ts)
- **BR-3** The tray exists exactly while `runInTray` is true. Tray menu: «Abrir Alma», «Salir» in `es`, the dictionary's English values in `en`. (src/main/index.ts)
- **BR-4** Window: 1280×820, minimum 860×560, `#05070d`, `contextIsolation` true, `nodeIntegration` false, `sandbox` true, `backgroundThrottling` false (voice keeps working hidden). (src/main/index.ts)
- **BR-5** AppUserModelId is `com.alma.app` (Windows only shows notifications for apps with identity). (src/main/index.ts)
- **BR-6** Non-`always` notifications are skipped when the window is visible and focused; `always` ones also go in-app and flash the taskbar. (src/main/index.ts)
- **BR-7** A coordinator exit with a non-zero code outside quitting restarts it; exit 0 does not. (src/main/index.ts)
- **BR-8** Chromium permissions: only the main window, only audio capture and sanitized clipboard write. (src/main/index.ts)
- **BR-9** Executable/script file extensions are never opened by `shell:openPath`. (src/main/index.ts)
- **BR-10** IPC channels (renderer→main, invoke): `settings:get`, `settings:update`, `settings:setApiKey`, `settings:setCompanySecret`, `instagram:status`, `instagram:connect`, `instagram:disconnect`, `dialog:pickFolder`, `shell:openPath`, `vault:defaultPath`; (renderer→main, send) `coordinator:connect`. Main→renderer: `coordinator:port`, `coordinator:restarted`, `settings:changed`, `app:openThread`, `app:reminder`. (src/main/index.ts, src/preload/index.ts)
- **BR-11** Main→coordinator (parentPort): `init`, `settings`, `client` (with a port), `host.result`, `voice.trigger`. Coordinator→main: `alwaysAllow`, `host.request`, `notify`, `settings.patch`. (src/shared/types.ts)
- **BR-12** Sound defaults: not muted, volume 0.7, music on, motion on unless OS asks for reduced motion; music master level 0.32 scaled by volume/0.7; chord length 12 s. (src/renderer/src/umbra/useUISound.ts)
- **BR-13** Gamepad: A = button 0 (click), B = button 1 (back), D-pad = buttons 12–15, stick axes 0/1 at ±0.6; repeat delay 380 ms then 120 ms. (src/renderer/src/umbra/FocusManager.tsx)
- **BR-14** The focus scale is 1.06 and pressed scale 0.97; durations 120/200/320/500 ms. (src/renderer/src/umbra/tokens.css, base.css)
- **BR-15** Sections are `chat`, `vault`, `companies`, `home`; local keys `alma.mode`, `alma.company`, `alma.vault.chat`, `umbra.prefs`. (src/renderer/src/App.tsx, umbra/useUISound.ts)
- **BR-16** The hidden render window uses partition `alma-render` and cancels every request that is not `data:` or `about:`. (src/main/render.ts)
- **BR-17** The app is styled with the `console-ui` and `umbra-ui` conventions. Interface text comes from the `es`/`en` dictionaries and follows the `language` setting live (`../025-i18n-es-en/spec.md`); the Spanish is rioplatense as before and the English is US English. Spanish text quoted in this spec is the `es` value of a dictionary key. (docs/architecture.md)

## 7. Constraints and risks
- Layers: `main` (`src/main/index.ts`, `render.ts`, `guard.ts`, `instagram.ts`), `preload` (`src/preload/index.ts`, `api.d.ts`), `shared` (`desktop-api.ts`, `types.ts`), `renderer` (`App.tsx`, `main.tsx`, `components/Sidebar.tsx`, `umbra/*`, `styles.css`, `lib/*`). The renderer has no component tests; its logic is covered only by typecheck, lint and manual runs.
- Persistence: window/tray state is not saved; UI preferences are in the Chromium profile's `localStorage` under the user-data folder.
- Security: CSP in `src/renderer/index.html`; `alma-vault` privileged scheme; permissions lock-down; renderer cannot import `electron`, `node:*` or `shared/audit` (enforced by `tests/architecture.test.ts`).
- Platform: Windows first (tray, AppUserModelId, login item, flash frame); `resources/icon.png`, `resources/tray.png`.
- Not wired into the running app: `lib/ambience.ts`, `components/Ambience.tsx`, `FocusScope`/`useBack`, `SETTINGS_ICONS`.
