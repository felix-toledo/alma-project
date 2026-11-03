# Reference: settings

Every field of the `Settings` model, grouped by section (the order of `Settings` in `src/shared/types.ts`). For each field: path, type, default, where the person changes it, and what it does. Module behavior lives in [docs/modules/configuraciones.md](../modules/configuraciones.md); this page is the lookup table.

- Sources: `src/shared/types.ts` (model), `src/shared/home.ts` (`HomeSettings`), `src/shared/defaults.ts` (`defaultSettings()`), `src/main/settings.ts` (load, migrations, sealing), `src/renderer/src/components/SettingsDialog.tsx` and `src/renderer/src/home/HomeSettings.tsx` (UI).
- Spec: [006 · Configuraciones](../../.specify/specs/006-settings/spec.md).
- "Tab" is the tab of the **Configuración** dialog (UI names are in Spanish and quoted). The dialog has 14 tabs: Proveedores, Agentes, Equipos, Aprobaciones, Telegram, WhatsApp, Mail, Voz, Imágenes, Instagram, Casa, Conectores MCP, General, Sonido y ambiente.
- "sin interfaz" (no interface) means no control in the window edits it: the app or the coordinator writes it.
- **Secret** marks the sealed slots: written to disk as `enc:` + base64 (OS secure store), never sent to the window. See [Secrets](#secrets).

## File, load and save

| What | Value | Source |
|---|---|---|
| File | `settings.json` in the user-data folder (`%APPDATA%\Alma`, or `ALMA_USER_DATA`) | `src/main/settings.ts` `settingsPath()` |
| Load | `JSON.parse` then a shallow merge over `defaultSettings()`, key by key inside `telegram`, `voice`, `email`, `whatsapp`, `home`, `autoReview`, `images`, `instagram`, `background`, `privacy`. No schema validation. A file that cannot be read gives full defaults. | `SettingsStore.load()` |
| Save | Written to `settings.json.tmp` (mode `0o600`), then renamed over `settings.json` | `SettingsStore.save()` |
| Update from the window | `settings:update` with a partial patch: top-level keys are replaced whole (a patch with `privacy` replaces the whole `privacy` object). `providers` in a patch only honors `providers.xai.baseUrl` | `SettingsStore.update()` |
| Reaches the coordinator | After every save, main posts the full decrypted `Settings` (`{ type: 'settings' }`) | `pushSettings()` in `src/main/index.ts` |

Load-time migrations (run on every load, mark themselves done):

| Migration | Effect | Flag |
|---|---|---|
| Office tools | Agents with `write_file` get `office_read`, `office_create`, `office_edit`; agents with only `read_file` get `office_read` | `officeToolsAdded` |
| Multimedia agent | If the file predates it and has no `multimedia` agent, the default one is appended once (stays deleted if the person deletes it later) | `multimediaAdded` |
| `compose_image` | An agent with `generate_image` but not `compose_image` gets it (and the auto-approval if `generate_image` had it) | none (runs every load, idempotent) |
| Wake word | Any `voice.wakeWord` other than `'off'` is rewritten to `'hola_alma'` | none |
| Pasted key | If `images.model` looks like an API key (`xai-…` or `sk-…`), it is blanked and the file rewritten | none |
| Unsealed secret | A secret found in clear on disk is rewritten sealed, if a secure store exists | none |
| Empty agent list | `agents` empty or absent is replaced by the default agents | none |

## Secrets

Nine provider/service slots plus one per company. The coordinator receives them decrypted in memory; the window only gets `hasKey` / `fromEnv` booleans.

| Slot (`SecretProviderId`) | Stored at | Environment variable (read, never written) | Edited in tab |
|---|---|---|---|
| `anthropic` | `providers.anthropic.apiKey` | `ANTHROPIC_API_KEY` | Proveedores |
| `xai` | `providers.xai.apiKey` | `XAI_API_KEY` | Proveedores |
| `deepseek` | `providers.deepseek.apiKey` | `DEEPSEEK_API_KEY` | Proveedores |
| `vercel` | `providers.vercel.apiKey` | `AI_GATEWAY_API_KEY` | Proveedores |
| `meta` | `providers.meta.apiKey` | `META_API_KEY` | Proveedores |
| `openai` | `providers.openai.apiKey` | `OPENAI_API_KEY` | Proveedores |
| `telegram` | `providers.telegram.apiKey` (bot token) | `TELEGRAM_BOT_TOKEN` | Telegram |
| `elevenlabs` | `providers.elevenlabs.apiKey` | `ELEVENLABS_API_KEY` | Voz (shown only when the voice engine is ElevenLabs) |
| `email` | `providers.email.apiKey` (mailbox app password) | none (`fromEnv` is always false) | Mail |
| per company | `companySecrets[companyId]` (company mailbox password) | none | Equipos (`settings:setCompanySecret`) |

Other secrets that are not in `settings.json`: the Home Assistant token and the managed account password (sealed by the coordinator through `secret.seal`, stored in `home/auth.json`, see [datos.md](datos.md)); the Instagram session (browser partition, see [datos.md](datos.md)).

Rules (`src/main/settings.ts`):

- Secure store available: sealed with `safeStorage` (DPAPI on Windows). Empty secret is written as `''`.
- No secure store (or Linux `basic_text`): secrets are **not** written (they live in memory for the session; one console error). `ALMA_ALLOW_PLAINTEXT_SECRETS=1` brings back clear-text storage.
- A sealed value that cannot be decrypted (other Windows user or machine) reads as empty.
- Keys change only through `settings:setApiKey` (known ids only, trimmed) and `settings:setCompanySecret` (known company only). Both write `secret.set` / `secret.clear` to the audit trail without the value.
- Not a secret, but a credential-like value: `providers.xai.baseUrl` (editable, trimmed; empty falls back to the default).

## Top level

| Path | Type | Default | Tab | What it changes |
|---|---|---|---|---|
| `defaultAgentId` | string | `'general'` | Agentes ("Usar por defecto") | Agent used for new chats, routines and channels whose own agent no longer exists |
| `agents` | `AgentProfile[]` | the 9 default agents (below) | Agentes; company agents also in Equipos | The agent roster. Empty/absent on load restores the defaults |
| `approvalMode` | `'needs-approval' \| 'auto-review' \| 'always-allow' \| 'blocked'` | `'needs-approval'` | Aprobaciones | Whether tools ask, are judged by a reviewer model, run freely, or are read-only. Moving to `always-allow` needs a native confirmation dialog ([spec 004](../../.specify/specs/004-approvals/spec.md)) |
| `autoReview` | `{ provider, model, instructions }` | Meta (empty model = Muse Spark), `DEFAULT_REVIEW_INSTRUCTIONS`; saves from before move over once if a Meta key exists ([024](../../.specify/specs/024-voice-control-models-and-meta/spec.md)) | Aprobaciones (card "Auto-review") | Reviewer used in `auto-review` mode. Read by `src/coordinator/approval.ts` |
| `alwaysAllowTools` | string[] | `[]` | Aprobaciones (card "Siempre permitir", remove only) | Tool names that skip approval. Added when the person picks "Siempre permitir" in an approval (`alwaysAllow` message) |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | Conectores MCP | External tool servers. Adding, changing or re-enabling a stdio command needs a native confirmation |
| `defaultWorkspace` | string | `''` | General ("Carpeta de trabajo por defecto") | Working folder given to new chats, routines, channels |
| `images` | `{ provider: 'xai' \| 'openai' \| 'meta'; model }` | `{ provider: 'meta', model: '' }` | Imágenes | Image generation service; empty model = newest one the account lists |
| `instagram` | `{ testMode }` | `{ testMode: true }` | Instagram | Test mode fills the post but never clicks "Compartir" |
| `routines` | `Routine[]` | `[]` | no Settings tab: the "Rutinas" dialog (and agents through the routine tools) | Scheduled tasks and reminders |
| `background` | `{ runInTray, launchAtLogin }` | `{ true, false }` | General | Keep running in the tray when the window closes; open at Windows login (with `--hidden`) |
| `privacy` | `{ threadRetentionDays }` | `{ 0 }` | General ("Borrar conversaciones sin actividad") | Days without activity before a conversation is deleted. UI offers 0 (never), 30, 90, 180, 365 |
| `vaults` | string[] (absolute paths) | `[]` | sin interfaz in the dialog: the Vault view (sidebar) and Equipos add to it | Vault folders the person opened |
| `activeVault` | string | `''` | Vault view | The vault all conversations draw knowledge from; empty = none |
| `companies` | `Company[]` | `[]` | Equipos | Agent companies (below) |
| `companySecrets` | `Record<companyId, string>` | `{}` | Equipos (password field) | **Secret.** Company mailbox passwords. Not in the public view; the window sees `companyPasswords` booleans |
| `officeToolsAdded` | boolean? | absent | sin interfaz | Migration marker |
| `multimediaAdded` | boolean? | absent | sin interfaz | Migration marker |

Embedded sections follow.

## `providers`

See [Secrets](#secrets) for the keys. Only one non-secret field:

| Path | Type | Default | Tab | What it changes |
|---|---|---|---|---|
| `providers.xai.baseUrl` | string | `https://api.x.ai/v1` | Proveedores (xAI card, "URL base" + "Guardar URL") | Endpoint for Grok and xAI images. Other base URLs exist as constants (`DEEPSEEK_BASE_URL`, `VERCEL_BASE_URL`, `META_BASE_URL`, `OPENAI_BASE_URL` in `src/shared/defaults.ts`) with no setting |

## `telegram`

| Path | Type | Default | Tab | What it changes |
|---|---|---|---|---|
| `telegram.enabled` | boolean | `true` | Telegram ("Bot activo") | Starts the bot. With no token nothing starts, so "true by default" is harmless but surprising |
| `telegram.allowedUsers` | string[] | `[]` | Telegram | Usernames (no `@`) allowed to bind the bot before a chat is bound |
| `telegram.agentId` | string | `'general'` | Telegram | Agent that answers Telegram |
| `telegram.chatId` | number \| null | `null` | Telegram ("Desvincular" clears it) | The private chat bound on first contact. Written by the coordinator (`settings.patch`) |
| `telegram.threadId` | string \| null | `null` | sin interfaz | Conversation Telegram messages go to; `/nuevo` starts another. Written by the coordinator |

## `voice`

Owner: [docs/modules/voz.md](../modules/voz.md). All edited in the **Voz** tab. Text inputs here save on every keystroke.

| Path | Type | Default | Tab control | What it changes |
|---|---|---|---|---|
| `voice.enabled` | boolean | `false` | switch "Asistente de voz" | Starts listening (wake word / hotkey). Also registers the global hotkey in main |
| `voice.wakeWord` | `'hola_alma' \| 'off'` | `'hola_alma'` | wake word select | Always-on phrase; `'off'` = only the hotkey. Anything else on disk is forced to `'hola_alma'` |
| `voice.wakeThreshold` | number | `0.5` | "sensibilidad" slider (shown inverted: `1.2 - value`) | Score the wake word model must reach |
| `voice.hotkey` | string (Electron accelerator) | `'Control+Alt+Space'` | text input | Global push-to-talk shortcut; empty = none. Registered only while `voice.enabled` |
| `voice.micDeviceId` | string | `''` | microphone select | `MediaDeviceInfo.deviceId`; empty = system default. Read by the renderer (`VoiceLayer`) |
| `voice.verifySpeaker` | boolean | `true` | checkbox "Solo responder a mi voz" | After the wake word, answer only the enrolled voice (the hotkey always works) |
| `voice.speakerThreshold` | number | `0.86` | strictness slider 0.60 to 0.95 | Minimum similarity to the voice print |
| `voice.stt` | `'local' \| 'openai' \| 'meta'` | `'local'` | radios | Speech-to-text engine. `openai`/`meta` send audio to that service |
| `voice.sttModel` | `'whisper-base' \| 'whisper-small'` | `'whisper-base'` | select (only when `stt` is local) | Local Whisper model |
| `voice.tts` | `'kokoro' \| 'windows' \| 'elevenlabs'` | `'kokoro'` | radios | Text-to-speech engine |
| `voice.kokoroVoice` | string | `'ef_dora'` | select (Kokoro) | Kokoro voice id (`ef_dora`, `em_alex`, `em_santa`) |
| `voice.windowsVoice` | string | `''` | select (Windows) | `SpeechSynthesisVoice.name`; empty = first Spanish voice |
| `voice.elevenVoiceId` | string | `''` | "Elegir" on a voice row (ElevenLabs) | ElevenLabs voice. With no voice or key, Alma falls back to the Windows voice |
| `voice.elevenModel` | `'eleven_multilingual_v2' \| 'eleven_flash_v2_5'` | `'eleven_multilingual_v2'` | select (ElevenLabs) | ElevenLabs model |
| `voice.agentId` | string | `'general'` | agent select | Agent that answers voice requests |
| `voice.sendDelayMs` | number | `1000` | select "Pausa antes de enviar" | Pause between the transcript and the request, during which the ✕ button or Esc cancels it; `0` = none |
| `metaDefaultApplied` | boolean | unset | none | One-time marker: default agents, review and images moved to Meta |
| `voice.threadId` | string \| null | `null` | sin interfaz | Current voice conversation; a new one starts after an hour of silence. Written by the coordinator |

## `email`

Owner: [docs/modules/web-y-correo.md](../modules/web-y-correo.md). Edited in **Mail**; the password is the `email` secret slot. Leaving the address field with an empty IMAP host guesses the servers (`emailServersFor`, `src/shared/defaults.ts`). Each `Company` also has its own `email` object of the same shape.

| Path | Type | Default | What it changes |
|---|---|---|---|
| `email.address` | string | `''` | Mailbox address (user name for IMAP/SMTP) |
| `email.imapHost` | string | `''` | IMAP server (read) |
| `email.imapPort` | number | `993` | IMAP port (an invalid number in the field falls back to 993) |
| `email.smtpHost` | string | `''` | SMTP server (send) |
| `email.smtpPort` | number | `465` | SMTP port (invalid falls back to 465) |

## `whatsapp`

Owner: [docs/modules/whatsapp.md](../modules/whatsapp.md). Edited in **WhatsApp**.

| Path | Type | Default | What it changes |
|---|---|---|---|
| `whatsapp.enabled` | boolean | `false` | "Activar WhatsApp": starts the linked session (QR on first use) |
| `whatsapp.agentId` | string | `'general'` | Agent that answers the person's "Mensajes para mí" chat |
| `whatsapp.threadId` | string \| null | `null` | sin interfaz. Conversation WhatsApp messages go to; `/nuevo` starts another |

## `home`

Owner: [docs/modules/casa.md](../modules/casa.md). Edited in **Casa** (`HomeSettings.tsx`).

| Path | Type | Default | Tab control | What it changes |
|---|---|---|---|---|
| `home.enabled` | boolean | `false` | "Activar la domótica" | Starts the home engine and exposes the home tools |
| `home.mode` | `'managed' \| 'external'` | `'managed'` | radios | `managed`: Alma installs Home Assistant in the hidden WSL2 distro `alma-home`; `external`: connect to one the person already has |
| `home.externalUrl` | string | `''` | URL field (external mode) | Base URL of the external Home Assistant (token sealed in `home/auth.json`, never here) |
| `home.mirrored` | boolean | `false` | none | **Dead setting**, see below |
| `home.agentId` | string | `''` | agent select | Agent that handles judgment rules; empty = the default agent (`launchHomeRule`, `src/coordinator/index.ts`) |
| `home.visionProvider` | string | `''` | provider select | Provider of the model that looks at pictures (plans, cameras); empty = the agent's model. Read by `src/coordinator/vision.ts` |
| `home.visionModel` | string | `''` | model field (shown when a provider is chosen) | Vision model |

## `images`, `instagram`, `background`, `privacy`, `autoReview`

Covered in the top-level table. Fields: `images.provider` (`meta` default), `images.model` (`''`), `instagram.testMode` (`true`), `background.runInTray` (`true`), `background.launchAtLogin` (`false`), `privacy.threadRetentionDays` (`0`), `autoReview.provider`, `autoReview.model`, `autoReview.instructions`. The coordinator applies retention at startup, every 12 hours and whenever settings change (`applyRetention`, `src/coordinator/index.ts`).

## `AgentProfile` (items of `agents`)

| Field | Type | Default for a new agent ("+ Nuevo agente") | What it changes |
|---|---|---|---|
| `id` | string | generated | Identity; threads and settings point to it |
| `name`, `description` | string | "Nuevo agente", empty | Shown to the person and to a delegating agent |
| `systemPrompt` | string | empty | Instructions ("Instrucciones" field) |
| `provider` | `'anthropic' \| 'xai' \| 'deepseek' \| 'vercel' \| 'meta'` | Meta | Changing it resets the model |
| `model` | string | first Claude model | Empty = the provider picks |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | `'medium'` | Reasoning effort |
| `tools` | string[] | `read_file`, `list_dir`, `search_files` | Built-in tool names the agent may use |
| `allowMcp` | boolean | `false` | May use MCP tools |
| `canDelegate` | boolean | `false` | May use `delegate_task` |
| `companyId?` | string | absent | Marks a company member (sees only its company's vault, accounts, org chart). Not editable in Agentes |
| `autoApproveTools?` | string[] | absent | Tools that run without asking whatever the mode; never offered for read-only tools or `instagram_publish`. Publishing always asks |

Default agents (`DEFAULT_AGENTS`, `src/shared/defaults.ts`). The code ships **9**; spec 006 AC-1.1 says 10 but its BR-9 lists these 9, and the code wins.

| id | Provider / model | Effort | Delegates | MCP | Auto-approved |
|---|---|---|---|---|---|
| `general` | meta / auto (Muse Spark) | high | yes | yes | none |
| `investigador` | meta / auto (Muse Spark) | medium | no | no | none (read-only tools) |
| `programador` | meta / auto (Muse Spark) | medium | no | yes | none |
| `revisor` | meta / auto (Muse Spark) | medium | no | no | none (read-only tools) |
| `grok` | xai / `''` | high | yes | yes | none |
| `deepseek` | deepseek / `''` | high | yes | yes | none |
| `vercel` | vercel / `''` | high | yes | yes | none |
| `multimedia` | meta / auto (Muse Spark) | medium | no | no | `generate_image`, `compose_image`, `write_file`, `edit_file` (never `run_command`) |
| `community-manager` | meta / auto (Muse Spark) | medium | no | no | `generate_image`, `compose_image`, `write_file`, `edit_file` (publishing still asks) |

`DEFAULT_CLAUDE_MODEL` is `claude-opus-5-5`; `CLAUDE_MODELS` offered: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`, `claude-opus-5`.

## `McpServerConfig` (values of `mcpServers`)

| Field | Type | Applies to | What it changes |
|---|---|---|---|
| `type` | `'stdio' \| 'http'` | both | Transport |
| `enabled` | boolean | both | "Activo" checkbox |
| `command`, `args?`, `env?`, `cwd?` | string, string[], record, string | stdio | Program to run on this computer. Any new/changed/re-enabled one triggers the native confirmation (`newCommands`, `src/main/guard.ts`) |
| `url`, `headers?` | string, record | http | Remote server. Changes here do **not** trigger the confirmation |
| `tools?` | string[] | both | Allow-list of tool names; empty or missing = all |

## `Routine` (items of `routines`)

| Field | Type | What it changes |
|---|---|---|
| `id`, `name`, `createdAt` | string, string, number | Identity |
| `agentId` | string | Agent that runs it (falls back to the default agent) |
| `workspace` | string | Working folder; empty = `defaultWorkspace` |
| `prompt` | string | Task: what the agent is told. Reminder: the message shown |
| `schedule` | `{ kind: 'daily'; time; days[] }` \| `{ kind: 'interval'; minutes }` \| `{ kind: 'once'; at }` | When it fires (`days`: 0 = Sunday, empty = every day). A `once` that was due while the app was closed fires on start |
| `enabled` | boolean | On/off |
| `action?` | `'task' \| 'reminder'` | Missing = `'task'`. A reminder only notifies (desktop and Telegram), no agent |

Run history is not here: it is in `routines-state.json` ([datos.md](datos.md)).

## `Company` and `CompanyMember` (items of `companies`)

Owner: [docs/modules/empresas.md](../modules/empresas.md).

| Field | Type | What it changes |
|---|---|---|
| `Company.id`, `name`, `color`, `createdAt` | string, string, string, number | Identity and look |
| `mission`, `goals` | string | Read by every member (goals one per line) |
| `vault` | string (absolute folder) | The company's own vault; documents and meeting minutes (`Reuniones/…`) are saved there. Default suggested: `Documents\Alma\Empresas\<name>` |
| `budgetUsd` | number | Monthly cap for the company in USD; `0` = no cap |
| `members` | `CompanyMember[]` | Org chart |
| `email` | `EmailSettings` | Own mailbox; empty address = use the person's. Password in `companySecrets[id]` |
| `whatsapp` | boolean | Own WhatsApp number, linked by QR (answered by the top of the org chart) |
| `CompanyMember.id` | string | Same id as its `AgentProfile` |
| `CompanyMember.title` | string | Position ("Community manager") |
| `CompanyMember.reportsTo` | string \| null | Boss member id; `null` = reports to the person (the board) |
| `CompanyMember.collaborates` | string[] | Peers it may ask for help (`ask_colleague`) |
| `CompanyMember.budgetUsd` | number | Monthly cap for the member; `0` = only the company cap |

## What the window sees: `PublicSettings`

`getPublic()` returns `Settings` without `providers` and `companySecrets`, plus:

- `providers.<slot>`: `{ hasKey, fromEnv }` for each of the nine slots (xAI also `baseUrl`).
- `companyPasswords`: `Record<companyId, boolean>`.

`fromEnv` is true when the environment variable in the Secrets table is set; the card then shows "Usa <VAR>" (uses that variable) instead of "Key guardada" (key saved) or "Sin configurar" (not configured).

## Settings that are not in `settings.json`

| Setting | Where | Notes |
|---|---|---|
| "Sonidos de interfaz", "Música de fondo", "Volumen", "Fondo en movimiento" (tab Sonido y ambiente) | Browser `localStorage`, key `umbra.prefs` | Per window; the coordinator never sees them. Another key `ambience` belongs to unused code |
| View state: `alma.mode`, `alma.company`, `alma.vault.chat`, `alma.vault.tabs:<vault>`, `alma.vault.expanded:<vault>`, `alma.vault.reading`, `alma.home.tab` | Browser `localStorage` | Last selected mode/company/tabs; safe to lose |
| `ALMA_USER_DATA`, `ALMA_ALLOW_PLAINTEXT_SECRETS`, `ALMA_HOME_DISTRO` (default `alma-home`), `ALMA_HOME_DEMO`, `ALMA_INSTAGRAM_URL` | Environment | Read in `src/main/index.ts`, `src/main/settings.ts`, `src/coordinator/home/engine.ts`, `src/main/instagram.ts`. The last three are for tests and development |

## Dead settings

| Setting | Verdict | Evidence |
|---|---|---|
| `home.mirrored` | **Dead.** Defined, defaulted and documented as "WSL mirrored networking", but nothing reads or writes it | A search of `src/` finds it only in `src/shared/home.ts` (type) and `src/shared/defaults.ts` (default); the only other hit is a fixture in `tests/home-live.test.ts`. No control in `HomeSettings.tsx` |

For the other fields I searched `src/` for a reader of each setting group (providers, telegram, voice, email, whatsapp, home, images, instagram, background, privacy, autoReview, routines, vaults, companies) and found one; I did not trace every sub-field of `AgentProfile`, `Routine` and `Company` to its last reader, so a second dead field there is possible. `telegram.chatId`, `telegram.threadId`, `whatsapp.threadId` and `voice.threadId` have no control in the window: the coordinator writes them (`settings.patch`) and reads them back to pick the conversation.

## Known limits

- Settings read from disk and patches from the window are not validated with a schema.
- A patch replacing `companies` does not clean `companySecrets` of deleted companies.
- `home.mirrored` is dead (above).
- Spec 006 AC-1.1 says 10 default agents; the code ships 9.

Written by hand from the code; when you add a row, verify the name in the code
