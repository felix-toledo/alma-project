---
status: implemented
---

# 006 — Configuraciones

## 1. Summary
Alma keeps one settings document per computer (`settings.json` in the user-data folder). The main process owns it: it loads it
with defaults and small migrations, seals every secret (API keys, bot token, mailbox passwords, company mailbox passwords) with
the operating system's secure store, and hands the window only a "public" view that says whether a key exists, never its value.
The person edits everything from the **Configuración** dialog (14 tabs). Each change goes window → main (IPC) → disk, and main
pushes the new settings to the coordinator and tells the window to refresh.

## 2. Problem and goal
Alma needs many per-person choices (providers and keys, agents, approvals, channels, voice, house, privacy) that must survive
restarts, must not leak secrets to the page or to disk in clear text, and must reach the process that runs the agents without a
restart. Done means: one place to change each setting, secrets never travel back to the window, and a change is live in the
coordinator right after it is saved.

## 3. Scope
**In:**
- The `Settings` model, its defaults and the list of default agents (`src/shared/types.ts`, `src/shared/defaults.ts`).
- Persistence in `settings.json`, the `ALMA_USER_DATA` override, the one-time migration from the old `MultiAgente` folder, load-time
  migrations, atomic saving (`src/main/index.ts`, `src/main/settings.ts`).
- Secret storage (`safeStorage`), the public view, and the settings IPC channels and change notifications.
- Every tab of the Settings dialog: what control exists, its default and its effect (`src/renderer/src/components/SettingsDialog.tsx`,
  `src/renderer/src/home/HomeSettings.tsx`, `src/renderer/src/umbra/AmbienceControls.tsx`).

**Out (and why):** behavior of the owning modules is only linked.
- Providers, model lists, keys' use: `../005-providers/spec.md`. Agent profiles, delegation: `../003-agents/spec.md`.
- Approval modes and "Siempre permitir" semantics: `../004-approvals/spec.md`. Companies/teams tab: `../007-companies/spec.md`.
- Telegram `../010-telegram/spec.md`, WhatsApp `../011-whatsapp/spec.md`, Instagram `../012-instagram/spec.md`, house
  `../013-house-engine-and-devices/spec.md` and `../014-house-plan-cameras-and-rules/spec.md`, mail `../016-web-and-mail/spec.md`,
  MCP `../017-mcp/spec.md`, routines `../018-routines-and-reminders/spec.md`, voice `../019-voice/spec.md`, images `../020-images/spec.md`.
- Vault folders (`vaults`, `activeVault`) are chosen in the Vault view: `../008-vault/spec.md`. Privacy export/erase: `../022-security-and-privacy/spec.md`.
- Window, tray and the `window.desktop` bridge themselves: `../023-app-shell-and-ui/spec.md`.

## 4. Users and stories
- **US-1** As a person, I want my settings to persist across restarts and survive upgrades of the app, so that I configure Alma once.
- **US-2** As a person, I want my API keys and passwords stored sealed and never shown back, so that nobody reading the disk or the page can take them.
- **US-3** As a person, I want to save a key per provider and see whether it is stored (or taken from an environment variable), so that I know what works.
- **US-4** As a person, I want a setting change to take effect right away in the running agents, voice, channels and house.
- **US-5** As a person, I want to manage agents (profile, model, tools, auto-approved tools, default agent) from the dialog.
- **US-6** As a person, I want the dialog to ask me before a change gives agents more power (new local command, "Permitir todo"), so that a compromised page cannot do it silently.
- **US-7** As a person, I want each channel/module (Telegram, WhatsApp, mail, voice, Instagram, house, MCP, images) to be configurable in its own tab.
- **US-8** As a person, I want general options (default folder, tray, start with Windows, retention, sound/motion) in one place.
- **US-9** As a person coming from the old "MultiAgente" app, I want my conversations, settings and keys carried over once.

## 5. Acceptance criteria

### Model, defaults and persistence (US-1, US-9)
- **AC-1.1** (US-1) Given no `settings.json`, when the store loads, then the defaults apply: 9 default agents, `defaultAgentId` `general`, `approvalMode` `needs-approval`, `background` `{ runInTray: true, launchAtLogin: false }`, `privacy.threadRetentionDays` 0, Telegram enabled with no allowed users, voice and WhatsApp and house off. [gap]
- **AC-1.2** (US-1) The default agent list has unique ids and contains the default agent id. Test: tests/defaults.test.ts › "has unique agent ids and a default agent that exists"
- **AC-1.3** (US-1) Every default agent only lists tools that exist, the Multimedia agent can run commands but never auto-approves `run_command`. Test: tests/defaults.test.ts › "ships a Multimedia agent that can run Remotion and only uses known tools"
- **AC-1.4** (US-1) Vercel AI Gateway has its own agent and its own empty key slot. Test: tests/defaults.test.ts › "ships a Vercel AI Gateway agent with its own key slot"
- **AC-1.5** (US-1) Given a `settings.json` missing newer sections (telegram, voice, email, whatsapp, home, images, instagram, background, privacy, autoReview, routines, companies), when loaded, then each missing section takes its default, and present keys inside a section override the default key by key. [gap]
- **AC-1.6** (US-1) Given a `settings.json` that is unreadable or not valid JSON, when loaded, then the store falls back to full defaults without throwing (the broken file is overwritten on the next save). [gap]
- **AC-1.7** (US-1) Given a saved list of agents that is empty or absent, when loaded, then the default agents are restored. [gap]
- **AC-1.8** (US-1) Given a saved wake word other than `off`, when loaded, then it is forced to `hola_alma`. [gap]
- **AC-1.9** (US-1) Given a file saved before `officeToolsAdded`, when loaded, then agents with `write_file` gain `office_read`, `office_create`, `office_edit`, agents with only `read_file` gain `office_read`, and the flag is set so it runs once. [gap]
- **AC-1.10** (US-1) Given a file saved before `multimediaAdded` and without a `multimedia` agent, when loaded, then the default Multimedia agent is appended once; if the person deletes it later it stays deleted. [gap]
- **AC-1.11** (US-1) Given an agent that can `generate_image` but not `compose_image`, when loaded, then `compose_image` is added to its tools (and to its auto-approved tools if `generate_image` was auto-approved). [gap]
- **AC-1.12** (US-1) Given the image model field holds something shaped like an API key, when the store starts, then the model is blanked and the file rewritten. [gap]
- **AC-1.13** (US-1) When settings are saved, then the file is written to `settings.json.tmp` (owner-only mode 0o600) and renamed over `settings.json`. [gap]
- **AC-1.14** (US-1) Given `ALMA_USER_DATA` is set, when the app starts, then that folder is the user-data folder (settings, conversations, audit trail, Instagram session) and no migration runs. [gap]
- **AC-1.15** (US-9) Given `%APPDATA%\MultiAgente` exists, `ALMA_USER_DATA` is unset and the new user-data folder has no `settings.json`, when the app starts, then the old folder is copied recursively into the new one, skipping `lockfile`, `Singleton*`, `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `Crashpad`; a copy error is logged and startup continues. [gap]
- **AC-1.16** (US-9) Given the new folder already has a `settings.json`, when the app starts, then nothing is copied. [gap]

### Secrets and the public view (US-2, US-3)
- **AC-2.1** (US-2) Given the OS secure store is available, when settings are saved, then every provider key, the Telegram token, the ElevenLabs key, the mailbox password and every company mailbox password are written as `enc:` + base64 of the sealed value; empty secrets are written as an empty string. [gap]
- **AC-2.2** (US-2) Given the secure store is NOT available (or Linux `basic_text`) and `ALMA_ALLOW_PLAINTEXT_SECRETS` is not `1`, when settings are saved, then secrets are written as empty strings (they live only in memory for the session) and one warning is logged. [gap]
- **AC-2.3** (US-2) Given `ALMA_ALLOW_PLAINTEXT_SECRETS=1` and no secure store, when saved, then secrets are written in clear text. [gap]
- **AC-2.4** (US-2) Given a stored secret that cannot be decrypted (other machine/user), when loaded, then it reads as empty (no crash). [gap]
- **AC-2.5** (US-2) Given a secret found unsealed on disk (older version) and a secure store available, when the store starts, then the file is rewritten sealed. [gap]
- **AC-2.6** (US-2) When the window asks for settings, then it receives the public view: no `apiKey`, no `companySecrets`; per provider `hasKey` and `fromEnv`; `companyPasswords` maps company id to a boolean; xAI also carries its `baseUrl`. [gap]
- **AC-2.7** (US-3) `fromEnv` is true when the provider's environment variable is set: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ELEVENLABS_API_KEY`; for `email` it is always false. [gap]
- **AC-2.8** (US-3) Given a provider id that is not one of the nine secret providers, when `settings:setApiKey` is invoked, then it throws "Proveedor desconocido" and nothing is stored. [gap]
- **AC-2.9** (US-3) When a key is saved or cleared, then it is trimmed, saved, pushed to the coordinator and an audit entry `secret.set` / `secret.clear` (target = provider id, never the value) is written. [gap]
- **AC-2.10** (US-2) Given a company id that does not exist, when `settings:setCompanySecret` is invoked, then it throws "Empresa desconocida"; for a known company the password is trimmed, an empty value forgets it, and `secret.set`/`secret.clear` is audited with target `company:<id>`. [gap]
- **AC-2.11** (US-2) The coordinator can ask main to seal or open a text with the secure store (`secret.seal`, `secret.open`) so it can keep its own secrets (house token) sealed. [gap]
- **AC-2.12** (US-2) A text that looks like an xAI/OpenAI/Anthropic-style key (`xai-…` or `sk-…`, 16+ word characters) is recognized as a key. [gap]

### Change flow (US-4, US-6)
- **AC-3.1** (US-4) When the window calls `settings:update` with a partial patch, then main merges it over the current settings (top-level keys replaced whole), saves, pushes the full settings to the coordinator, applies tray/login-item/voice-hotkey, and returns the public view. [gap]
- **AC-3.2** (US-4) A patch to `providers` only honors `providers.xai.baseUrl` (trimmed; empty falls back to `https://api.x.ai/v1`); keys can only be changed through `settings:setApiKey`. [gap]
- **AC-3.3** (US-4) When the coordinator sends `settings.patch` (an agent created a routine, Telegram bound a chat…), then main persists it, pushes settings back and sends `settings:changed` to the window, which re-reads `settings:get`. [gap]
- **AC-3.4** (US-4) When the coordinator sends `alwaysAllow` for a tool not yet listed, then main appends it to `alwaysAllowTools`, audits `always-allow.add`, pushes settings and notifies the window; a tool already listed changes nothing. [gap]
- **AC-3.5** (US-6) Given a patch whose `mcpServers` adds, changes or re-enables a stdio command, when `settings:update` runs, then a native warning dialog «Confirmar cambio de seguridad» lists the programs and the change is applied only if the person picks «Permitir»; «Cancelar» (default) throws "Cambio cancelado." and audits `settings.update` denied. Test: tests/guard.test.ts › "flags new, changed and re-enabled commands only" (covers which commands are flagged, not the dialog).
- **AC-3.6** (US-6) Given a patch that moves `approvalMode` from anything else to `always-allow`, when `settings:update` runs, then the same native dialog asks first («Los agentes van a ejecutar todo sin pedirte aprobación…»); switching away from `always-allow` or between the other modes never asks. [gap]
- **AC-3.7** (US-6) After an accepted update, an audit entry `settings.update` lists the names of the keys that really changed; for `approvalMode` it also records the new value. [gap]
- **AC-3.8** (US-4) Every IPC call that is not from the top frame of the app's own window, on the page it loaded, is rejected with "Origen no autorizado" and audited `ipc.rejected` (throttled). [gap]

### Dialog: Proveedores (US-3)
- **AC-4.1** (US-3) The tab shows one card each for Anthropic, xAI, DeepSeek, Vercel AI Gateway, Meta (Muse) and OpenAI, with a badge «Key guardada» / «Usa <VAR>» / «Sin configurar»; a password input, «Guardar» (disabled when empty) and, when a key exists, «Borrar». [manual] Open Configuración → Proveedores, save and delete a key, and watch the badge.
- **AC-4.2** (US-3) The key input is cleared after saving and the stored value is never shown (placeholder «•••••••• (escribí una nueva para reemplazarla)»). [manual] Save a key and confirm the field is empty and no value is displayed.
- **AC-4.3** (US-3) The xAI card has an editable «URL base» with «Guardar URL» (enabled only when changed). [manual] Edit the URL and watch the button enable.
- **AC-4.4** (US-3) «Probar conexión» lists the provider's models and shows «Conectado · N modelos disponibles» or the error text. [manual] Click it with a valid and an invalid key.
- **AC-4.5** (US-3) The Vercel card shows the hint `npx vercel@latest ai-gateway setup`. [manual] Open the tab.

### Dialog: Agentes (US-5)
- **AC-5.1** (US-5) The list shows non-company agents with provider name and «por defecto» on the default one; «+ Nuevo agente» appends «Nuevo agente» (Claude first model, effort `medium`, tools `read_file`, `list_dir`, `search_files`, no MCP, no delegation) and selects it. [manual] Click the button.
- **AC-5.2** (US-5) The editor has: Nombre, Descripción, Proveedor (changing it resets the model: first Claude model for Anthropic, empty otherwise), Modelo (free text + datalist + refresh button that fetches the list; empty-model hints per provider), Esfuerzo (`low`…`max`), Herramientas (one checkbox per built-in tool plus «Conectores MCP» and «Puede delegar en otros agentes»), «Sin pedir aprobación» checklist, Instrucciones. [manual] Edit each field and save.
- **AC-5.3** (US-5) «Sin pedir aprobación» lists only the agent's non-read-only tools and never `instagram_publish`. [manual] Enable `instagram_publish` for an agent and confirm it is not offered there.
- **AC-5.4** (US-5) «Guardar cambios» and «Descartar» are enabled only when the draft differs from the saved agent. [manual] Change a field and watch both buttons.
- **AC-5.5** (US-5) «Usar por defecto» sets `defaultAgentId`; «Borrar» (after a confirm «¿Borrar el agente …?») is disabled when it is the last agent or the default agent. [manual] Try deleting the default agent.

### Dialog: Aprobaciones (US-6)
- **AC-6.1** (US-6) Four radio choices set `approvalMode`: «Pedir aprobación» (`needs-approval`), «Auto-review», «Permitir todo» (`always-allow`), «Solo lectura» (`blocked`). [manual] Pick each; «Permitir todo» triggers the native confirmation (AC-3.6).
- **AC-6.2** (US-6) The Auto-review card edits the reviewer provider (Anthropic, xAI, DeepSeek, Vercel only), model and the dangerous-actions instructions, saved with «Guardar auto-review». [manual] Edit and save.
- **AC-6.3** (US-6) The «Siempre permitir» card lists `alwaysAllowTools` with «Quitar» per tool, or «Ninguna…» when empty. [manual] Choose «Siempre permitir» in an approval, then remove it here.

### Dialog: MCP (US-7)
- **AC-7.1** (US-7) The tab lists servers with state badge, command/URL, «Activo» checkbox, «Quitar», connected tool names, and «Reconectar». [manual] Add a server and watch the badge.
- **AC-7.2** (US-7) «Agregar Chrome» (shown while no `chrome-devtools` server exists) adds a stdio server `npx -y chrome-devtools-mcp@1.11.0`. [manual] Click it; the native confirmation of AC-3.5 appears.
- **AC-7.3** (US-7) «+ Agregar servidor» takes name (spaces become `-`), type stdio (command, args one per line, env `KEY=value`) or http (URL, headers `Name: value`), and an allow-list of tools (comma/newline separated; empty = all). [manual] Add one of each type.
- **AC-7.4** (US-7) «Importar mcp.json» reads the Claude Desktop/Cursor format into servers, ignoring non-object entries; with no server found it shows «No se encontró ningún servidor.». Test: tests/providers.test.ts › "reads Claude Desktop / Cursor style configs"
- **AC-7.5** (US-7) Invalid JSON in the import box shows the parse error under it and changes nothing. [gap]

### Dialog: Telegram, WhatsApp, Mail, Voz, Imágenes, Instagram, Casa (US-7)
- **AC-8.1** (US-7) Telegram: bot token (saved as secret provider `telegram`), «Bot activo», allowed users list (strips `@`, case-insensitive duplicates ignored), «Desvincular» when `chatId` is set, answering agent. Owner: `../010-telegram/spec.md`. [manual] Walk the tab with a test bot.
- **AC-8.2** (US-7) WhatsApp: «Activar WhatsApp», QR when the state is `qr`, «Desvincular este dispositivo» when online, answering agent. Owner: `../011-whatsapp/spec.md`. [manual] Enable and scan the QR.
- **AC-8.3** (US-7) Mail: address, app password (secret provider `email`, spaces removed), IMAP/SMTP host and port (invalid number falls back to 993 / 465), «Completar según la dirección», «Probar conexión» (disabled without password or hosts). Owner: `../016-web-and-mail/spec.md`. [manual] Fill a Gmail address and test.
- **AC-8.4** (US-7) Leaving the address field with an empty IMAP host fills the servers from the address; unknown domains get `imap.<domain>` / `smtp.<domain>`, no `@` gives nothing. Test: tests/integrations.test.ts › "guesses the mail servers from the address"
- **AC-8.5** (US-7) Voice tab: enable switch, answering agent, microphone, wake word (`hola_alma` or none), sensitivity, hotkey, voice training, «Solo responder a mi voz», strictness slider, transcription engine, voice engine. Owner: `../019-voice/spec.md`. [manual] Walk the tab.
- **AC-8.6** (US-7) Images tab: service (xAI/OpenAI/Meta, each marked «falta la key» when it has none), model (empty = newest), refresh list; saving a model that looks like an API key is blocked with «Eso es una API key, no un modelo…». Owner: `../020-images/spec.md`. [manual] Paste `sk-` plus 20 characters into the model field.
- **AC-8.7** (US-7) Instagram tab: connect/disconnect, «Modo de prueba» (`instagram.testMode`, default on). Owner: `../012-instagram/spec.md`. [manual] Toggle it.
- **AC-8.8** (US-7) Casa tab: enable the domotics, engine mode (managed/external), engine status and actions, answering agent, vision provider/model, connected accounts. Owner: `../013-house-engine-and-devices/spec.md`. [manual] Walk the tab.
- **AC-8.9** (US-7) Equipos tab embeds the teams editor. Owner: `../007-companies/spec.md`. [manual] Open it from Empresas.

### Dialog: General and Sonido y ambiente (US-8)
- **AC-9.1** (US-8) «Carpeta de trabajo por defecto» shows the folder (or «(ninguna)») and «Elegir…» opens a native folder picker; cancelling changes nothing. [manual] Pick and cancel.
- **AC-9.2** (US-8) «Al cerrar la ventana, seguir en la bandeja del sistema» maps to `background.runInTray`; «Abrir al iniciar Windows (minimizada)» to `background.launchAtLogin` (login item with `--hidden`). [manual] Toggle and check the tray icon and Windows startup apps.
- **AC-9.3** (US-8) «Borrar conversaciones sin actividad» offers Nunca, 30, 90, 180 days, Al año (`privacy.threadRetentionDays`); «Exportar mis datos…» and «Borrar mi historial» (confirm; reloads the window after 1.2 s). Owner: `../022-security-and-privacy/spec.md`. [manual] Choose 30 days and check the select.
- **AC-9.4** (US-8) «Sonido y ambiente» has «Sonidos de interfaz», «Música de fondo», «Volumen» (0 to 100 in steps of 5) and «Fondo en movimiento»; these are per-window browser preferences, not part of `settings.json`. Owner: `../023-app-shell-and-ui/spec.md`. [manual] Toggle and reload the app.
- **AC-9.5** (US-8) Esc or a click on the backdrop closes the dialog, with no unsaved-changes prompt; the dialog opens on `providers` unless a caller asks for another tab. [manual] Press Esc.

## 6. Business rules
- **BR-1** Settings live in `settings.json` inside Electron's `userData` folder; `ALMA_USER_DATA` overrides that folder. (src/main/settings.ts, src/main/index.ts)
- **BR-2** The old `%APPDATA%\MultiAgente` profile is copied once, only if `ALMA_USER_DATA` is unset and the new folder has no `settings.json`. (src/main/index.ts)
- **BR-3** `settings.json` is written via a `.tmp` file renamed over the target, mode 0o600. (src/main/settings.ts)
- **BR-4** Secrets are saved only sealed (`enc:` prefix + base64); without a secure store they are not persisted unless `ALMA_ALLOW_PLAINTEXT_SECRETS=1`. (src/main/settings.ts)
- **BR-5** The nine secret slots are `anthropic`, `xai`, `deepseek`, `vercel`, `meta`, `openai`, `telegram`, `elevenlabs`, `email`. (src/shared/types.ts, src/main/index.ts)
- **BR-6** The window never receives a secret: only `hasKey`/`fromEnv`, and `companyPasswords` booleans. (src/main/settings.ts)
- **BR-7** Changing `mcpServers` to start a new/changed/re-enabled stdio command, or moving to `always-allow`, requires a native confirmation in main. (src/main/index.ts, src/main/guard.ts)
- **BR-8** Defaults (src/shared/defaults.ts): `approvalMode` `needs-approval`; `autoReview` Anthropic + `claude-opus-5-5` + built-in instructions; `images` xAI with empty model; `instagram.testMode` true; `background.runInTray` true, `launchAtLogin` false; `privacy.threadRetentionDays` 0; `telegram` enabled, `agentId` `general`, no chat; `voice` off, wake word `hola_alma`, threshold 0.5, hotkey `Control+Alt+Space`, verify speaker true, speaker threshold 0.86, STT `local`/`whisper-base`, TTS `kokoro`/`ef_dora`, ElevenLabs model `eleven_multilingual_v2`; `email` ports 993/465; `whatsapp` off; `home` off, mode `managed`; xAI base URL `https://api.x.ai/v1`.
- **BR-9** Default agents: General, Investigador, Programador, Revisor, Grok, DeepSeek, Vercel AI Gateway, Multimedia, Community Manager; the default model is `claude-opus-5-5`. Grok/DeepSeek/Vercel agents have an empty model (provider picks). (src/shared/defaults.ts)
- **BR-10** One-time load migrations are marked by `officeToolsAdded` and `multimediaAdded`. (src/main/settings.ts)
- **BR-11** A saved wake word other than `off` is rewritten to `hola_alma`. (src/main/settings.ts)
- **BR-12** Only the top frame of the app's own window may call a settings (or any) IPC channel. (src/main/index.ts)
- **BR-13** Settings changes that affect the tray, login item and global voice hotkey are applied at the moment they are pushed. (src/main/index.ts)
- **BR-14** Mail server guessing: gmail/googlemail, outlook/hotmail/live/msn, yahoo, icloud/me/mac have fixed hosts and ports; any other domain gets `imap.<domain>:993` and `smtp.<domain>:465`. (src/shared/defaults.ts)

## 7. Constraints and risks
- Layers: `shared` (types, defaults), `main` (store, safeStorage, dialogs, IPC), `renderer` (dialog), `coordinator` (receives `init` and `settings` messages, sends `settings.patch`/`alwaysAllow`).
- Messages: main→coordinator `init` (with all decrypted `Settings`), `settings` (full document on every change); coordinator→main `settings.patch`, `alwaysAllow`, `host.request` `secret.seal`/`secret.open`; main→window `settings:changed`. IPC: `settings:get`, `settings:update`, `settings:setApiKey`, `settings:setCompanySecret`.
- Security: the coordinator receives decrypted keys in memory; the file on disk holds them sealed with DPAPI (Windows). Audit entries for changes never include a secret. Moving the profile to another machine or Windows user makes sealed keys unreadable (they read as empty).
- Platform: Windows-first (`%APPDATA%`, login item, DPAPI).
