# Settings (Configuraciones)

> The single settings document of the machine (`settings.json`), how its secrets are sealed, how a change reaches the running agents, and the 15-tab «Configuración» (Settings) dialog. Spec: [006 · Settings](../../.specify/specs/006-settings/spec.md). Test status: 6 criteria with a test, 62 without (29 of those are manual checks in the interface, 33 have no check at all).

## What it does

- Keeps every per-person choice (providers and keys, agents, approval mode, channels, voice, house, privacy, background behavior) in one file, `settings.json`, that survives restarts and upgrades.
- Seals every secret (API keys, bot token, mailbox passwords, company mailbox passwords) with the operating system's secure store. The window never gets a secret back: it only learns whether one exists.
- Pushes each change to the coordinator (the process that runs the agents) right after saving, so no restart is needed.
- Asks you through a native system dialog before a change that would give agents more power (see [Security and privacy](#security-and-privacy)).
- Carries over the data of the old app name (`MultiAgente`) once.

A person edits settings from the dialog. An agent does not edit settings directly; the coordinator can only ask main for three things: a small `settings.patch` (for example a routine it created or a Telegram chat it bound), an `alwaysAllow` entry after you pick "Siempre permitir" (always allow) in an approval, and sealing or opening a text for its own secrets.

## How to use it

Open the dialog from the sidebar («Configuración»), from the empty state, from a chat's key warning, or on the `teams` / `home` tab from Empresas and Casa. It opens on **Proveedores** unless a caller asks for another tab. Esc or a click on the backdrop closes it; there is no "unsaved changes" prompt.

| Tab (`Tab` id) | What you do there | Owner module |
|---|---|---|
| Proveedores (`providers`) | One card each for Anthropic, xAI, DeepSeek, Vercel AI Gateway, Meta (Muse), OpenAI. Paste a key and press **Guardar**; **Borrar** removes it. Badge: «Key guardada» (key stored) / «Usa <VAR>» (taken from the environment variable) / «Sin configurar» (nothing). xAI also has «URL base». «Probar conexión» (test connection) lists the provider's models. | [providers](providers.md) |
| Agentes (`agents`) | List, create, edit, delete agents; **Usar por defecto** (use as default). | [agents](agents.md) |
| Equipos (`teams`) | Embeds the teams editor. | [companies](companies.md) |
| Aprobaciones (`approvals`) | Four modes: «Pedir aprobación» (`needs-approval`), «Auto-review», «Permitir todo» (`always-allow`), «Solo lectura» (`blocked`); reviewer model and instructions; the «Siempre permitir» list with «Quitar» (remove). | [approvals](approvals.md) |
| «Imágenes» (`images`) | Two cards. Creating: service (Meta / xAI / OpenAI), model, refresh list. Seeing (spec 038): provider («Automático» or one of the five chat providers), model, refresh list, the held / confirm line and button. | [images](images.md) |
| Telegram, WhatsApp, Mail (`email`), Voz (`voice`), Instagram | One tab per channel. | [telegram](telegram.md), [whatsapp](whatsapp.md), [web-and-mail](web-and-mail.md), [voice](voice.md), [instagram](instagram.md) |
| MCP (`mcp`) | Servers, **Agregar Chrome**, **+ Agregar servidor**, **Importar mcp.json**, **Reconectar**. | [mcp](mcp.md) |
| Casa (`home`) | Engine mode, judgment agent, a read-only line with the model that looks at pictures and a button to «Imágenes» (the vision provider and model are no longer chosen here), accounts. | [home](home.md) |
| Acceso remoto (`remote`) | Off-by-default switch, Tailscale wizard, pairing QR, paired phones, the six scopes (chat, approvals, house, cameras, Notes, Conversations) with the sub-switches for locks and alarms and for continuing conversations, the folders excluded from the phone, recent activity. | [remote-access](remote-access.md) |
| General (`general`) | Default working folder, run in tray, launch with Windows, conversation retention, **Exportar mis datos…**, **Borrar mi historial**. | [security](security.md) for privacy |
| Sonido y ambiente (`ambience`) | Interface sounds, background music, volume, moving background. | [app-shell](app-shell.md) |

Steps for the two most common jobs:

1. Save a key: **Proveedores**, type the key, **Guardar**. The field empties and the badge changes to «Key guardada». The value is never shown again (the placeholder says «•••••••• (escribí una nueva para reemplazarla)», "type a new one to replace it").
2. Stop Alma running in the background: **General**, uncheck «Al cerrar la ventana, seguir en la bandeja del sistema» (keep running in the tray when the window closes). The tray icon disappears at once.

Asking Alma in chat does not change settings. The only chat-side effects are the ones above (a routine, a Telegram binding, "always allow").

## How it works

Pieces:

| File | Role |
|---|---|
| `src/shared/types.ts`, `src/shared/defaults.ts` | The `Settings` model, defaults, the nine default agents, `looksLikeApiKey`, mail server guessing. |
| `src/main/settings.ts` | `SettingsStore`: load with defaults and migrations, `getPublic()`, `update()`, `setApiKey()`, `setCompanySecret()`, atomic save; `encrypt`/`decrypt` with `safeStorage`. |
| `src/main/index.ts` | `ALMA_USER_DATA`, the `MultiAgente` migration, IPC handlers, the native confirmation, `pushSettings()`. |
| `src/main/guard.ts` | `newCommands()`: which MCP changes start a program. |
| `src/renderer/src/components/SettingsDialog.tsx`, `home/HomeSettings.tsx`, `umbra/AmbienceControls.tsx` | The dialog. |

Flow of a change:

```
 window (SettingsDialog)
   │  settings:update {patch}        (invoke, only from the app's own top frame)
   ▼
 main/index.ts handle()  ── native confirm? ── "Cambio cancelado." (audited, denied)
   │  settings.update(patch) → settings.json.tmp → rename
   │  pushSettings(): ─► coordinator  {type:'settings', settings}   (full document, decrypted)
   │                    ├► tray / login item (applyBackgroundSettings)
   │                    └► global voice hotkey (applyVoiceHotkey)
   ▼
 returns PublicSettings to the window

 coordinator ── settings.patch / alwaysAllow ──► main ── settings:changed ──► window re-reads settings:get
```

Load order in `SettingsStore.load()`: start from `defaultSettings()`, shallow-merge the stored file, open each secret, then apply migrations. Not obvious points:

- The merge is **per section, key by key** (`telegram`, `voice`, `email`, `whatsapp`, `home`, `autoReview`, `images`, `instagram`, `background`, `privacy`), but every other top-level key is replaced whole. `update()` also replaces top-level keys whole, except `images` (the nested `images.vision` of spec 038 is kept when a patch leaves it out or malforms it, `acceptImagesPatch`) and `home` (a patch loses `visionProvider`/`visionModel`). `images` is not merged but sanitized on load (`sanitizeImagesSettings`): a missing or malformed `vision` loads empty, and a key-looking model in either model field is blanked and the file rewritten.
- Migrations run once, marked by `officeToolsAdded`, `multimediaAdded` and (spec 038, the vision model moved from «Casa» to «Imágenes») `visionMigrated`. A third one (adding `compose_image` to agents that can `generate_image`) has no flag and runs on every load. A saved wake word other than `off` is forced to `hola_alma`.
- A file that cannot be parsed makes the store fall back to full defaults silently; the broken file is overwritten on the next save.
- A secret found unsealed on disk is rewritten sealed, but only when a secure store exists (rewriting without one would blank the keys).
- `getPublic()` strips `providers` and `companySecrets` and replaces them with `hasKey` / `fromEnv` per provider and `companyPasswords` (a map of company id to boolean).

IPC and messages (see [spec 023](../../.specify/specs/023-app-shell-and-ui/spec.md) and [ipc-messages](../references/ipc-messages.md)):

| Direction | Message |
|---|---|
| window → main (invoke) | `settings:get`, `settings:update`, `settings:setApiKey`, `settings:setCompanySecret` |
| main → coordinator | `init` (all decrypted settings), `settings` (full document on every change) |
| coordinator → main | `settings.patch`, `alwaysAllow`, `host.request` `secret.seal` / `secret.open` |
| main → window | `settings:changed` |

## Settings and data

Stored in `settings.json` inside Electron's `userData` folder (`%APPDATA%\Alma`). `ALMA_USER_DATA` points to another folder (also used for conversations, the audit trail and the Instagram session). The full list of keys is in [settings](../references/settings.md); defaults that matter here:

| Setting | Default |
|---|---|
| `approvalMode` | `needs-approval` |
| `defaultAgentId` | `general` (9 shipped agents: General, Investigador, Programador, Revisor, Grok, DeepSeek, Vercel AI Gateway, Multimedia, Community Manager) |
| default model | `claude-opus-5-5`; the Grok, DeepSeek and Vercel agents have an empty model (the provider picks) |
| `autoReview` | Anthropic, `claude-opus-5-5`, built-in instructions |
| `background` | `runInTray: true`, `launchAtLogin: false` |
| `privacy.threadRetentionDays` | `0` (never) |
| `telegram` | enabled, agent `general`, no allowed users, no chat |
| `voice` | off; wake word `hola_alma`, threshold 0.5, hotkey `Control+Alt+Space`, verify speaker on (0.86), STT `local` / `whisper-base`, TTS `kokoro` / `ef_dora`, ElevenLabs model `eleven_multilingual_v2` |
| `email` ports | IMAP 993, SMTP 465 |
| `whatsapp`, `home` | off; house mode `managed` |
| `images` | Meta, empty model; `images.vision` empty («Automático», spec 038) |
| `instagram.testMode` | on |
| xAI base URL | `https://api.x.ai/v1` |

Note: the spec says "10 default agents" in AC-1.1 but names nine in BR-9. `src/shared/defaults.ts` defines nine (`general`, `investigador`, `programador`, `revisor`, `grok`, `deepseek`, `vercel`, `multimedia`, `community-manager`), so the code wins: nine.

Not in `settings.json`: sound, music, volume and motion preferences live in the window's `localStorage` (`umbra.prefs`), and the last section, selected company and vault chat state too. See [app-shell](app-shell.md). Vault folders are chosen in the Vault view, not in this dialog.

Secret slots (nine): `anthropic`, `xai`, `deepseek`, `vercel`, `meta`, `openai`, `telegram`, `elevenlabs`, `email`, plus one mailbox password per company. Environment variables read when no key is stored: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ELEVENLABS_API_KEY` (never for `email`). They are read, never written.

## Limits and rules

- Write is atomic: `settings.json.tmp` (mode 0600) then rename. On Windows the mode has little effect; access is by the user's profile folder.
- Secret on disk: `enc:` + base64 of the sealed value; empty secrets are an empty string.
- A secret that cannot be decrypted (other Windows user or machine) reads as empty. Moving the profile therefore loses the keys.
- `settings:update` merges top-level keys; for `providers` only `providers.xai.baseUrl` is honored (trimmed, empty falls back to the default). Keys change only through `settings:setApiKey`, which accepts nine provider ids and throws «Proveedor desconocido» ("unknown provider") for anything else. `settings:setCompanySecret` throws «Empresa desconocida» for an unknown company.
- Keys and company passwords are trimmed; an empty value clears them.
- Mail: IMAP/SMTP port that is not a number falls back to 993 / 465. Leaving the address field with an empty IMAP host fills servers from the address: fixed hosts for gmail/googlemail, outlook/hotmail/live/msn, yahoo, icloud/me/mac; any other domain gets `imap.<domain>:993` and `smtp.<domain>:465`.
- Migration from `MultiAgente`: only if `ALMA_USER_DATA` is unset, `%APPDATA%\MultiAgente` exists and the new folder has no `settings.json`. Skips `lockfile`, `Singleton*`, `Cache`, `Code Cache`, `GPUCache`, `DawnCache`, `Crashpad`. A copy error is logged and startup continues.
- A text that looks like a key (`xai-…` or `sk-…`, 16+ word characters) typed into the image model field is refused («Eso es una API key, no un modelo…», "that is an API key, not a model") and, if found on load, blanked.
- Moving to `always-allow` or starting a new MCP command needs a native confirmation (below).

## Security and privacy

- Secrets are sealed with `safeStorage` (DPAPI on Windows). Without a secure store, or with Linux `basic_text`, secrets are **not written** (they live in memory for the session, one warning is logged) unless `ALMA_ALLOW_PLAINTEXT_SECRETS=1`, which writes them in clear.
- The coordinator does receive decrypted keys in memory; only the window is kept from them.
- Native confirmation «Confirmar cambio de seguridad» ("Confirm security change"), buttons «Permitir» / «Cancelar» (default Cancelar), before applying a `settings:update` that:
  - adds, changes or re-enables a stdio MCP server command (`newCommands` in `guard.ts`), or
  - moves `approvalMode` to `always-allow` from another mode.
  Cancel throws «Cambio cancelado.» and audits `settings.update` as denied. Switching away from `always-allow`, or any other change, never asks.
- Audit entries written by this module: `settings.update` (names of keys that really changed; for `approvalMode` also the new value), `secret.set` / `secret.clear` (target = provider id or `company:<id>`, never the value), `always-allow.add`. See [security](security.md).
- Every IPC call must come from the top frame of the app's own window on the page it loaded; otherwise «Origen no autorizado» and an `ipc.rejected` audit entry.
- Nothing in settings is sent to a third party by this module. The «Probar conexión» button calls the provider with the key you saved.

## How it is tested

| Criterion | Test |
|---|---|
| AC-1.2 default agents unique ids, default exists | `tests/defaults.test.ts` "has unique agent ids and a default agent that exists" |
| AC-1.3 default agents use known tools; Multimedia never auto-approves `run_command` | `tests/defaults.test.ts` "ships a Multimedia agent…" |
| AC-1.4 Vercel agent and key slot | `tests/defaults.test.ts` "ships a Vercel AI Gateway agent with its own key slot" |
| AC-3.5 which MCP changes are flagged (not the dialog itself) | `tests/guard.test.ts` |
| AC-7.4 `mcp.json` import | `tests/providers.test.ts` "reads Claude Desktop / Cursor style configs" |
| AC-8.4 mail server guessing | `tests/integrations.test.ts` "guesses the mail servers from the address" |

Not covered: `SettingsStore` itself (load, migrations, sealing, atomic save, public view), the IPC handlers, the migration copy. `SettingsStore` imports `electron`, so there is no test double for it. By hand: every tab (the renderer has no component tests). Try: save and delete a key and watch the badge; pick «Permitir todo» and confirm the system dialog appears and Cancel keeps the old mode; toggle tray and login item and check Windows startup apps; paste `sk-` plus 20 characters into the image model field.

## Known limits

1. Settings read from disk are not validated with a schema (`JSON.parse` plus shallow merge), against the Zod rule in [architecture](../architecture.md).
2. `settings:update` accepts any `Partial<PublicSettings>` from the page with no validation. In code `update()` spreads every key except `providers` and `companyPasswords`, so a page could also send `companySecrets`, `alwaysAllowTools` or `autoReview` with no dialog., and for what the dialog should cover.
3. Text inputs in the Mail and Voz tabs call `settings:update` on every keystroke: each keystroke saves the file, pushes settings and may re-register a half-typed global hotkey.
4. Telegram is `enabled` by default (inert without a token). Product decision.
5. Sound and motion preferences are not in `settings.json`, so the coordinator and other devices cannot see them.
6. Replacing `companies` does not clean `companySecrets` of deleted companies.
7. The `MultiAgente` copy also runs on a fresh install on a machine that once had the old app.
8. A corrupt `settings.json` silently resets everything to defaults (including the agent list); no backup is kept. No spec question; found while reading `load()`.
9. Rationale not documented for why the third migration (`compose_image`) has no run-once flag.

## See also

[providers](providers.md) · [agents](agents.md) · [approvals](approvals.md) · [security](security.md) · [app-shell](app-shell.md) · [settings](../references/settings.md) · [data](../references/data.md) · [ipc-messages](../references/ipc-messages.md)
