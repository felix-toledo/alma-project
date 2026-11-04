# 006 — Plan

## 1. Approach
Main owns one `Settings` document (`settings.json` in `userData`). A `SettingsStore` loads it with defaults and idempotent migrations, seals every secret with `safeStorage` on save, and exposes two views: the full `Settings` (decrypted, only for the coordinator) and `PublicSettings` (no keys, only `hasKey` / `fromEnv`) for the window. Every change goes window → IPC → main → disk, then main pushes the full document to the coordinator and the window re-reads. Changes that give agents more power ask first through a native dialog the page cannot click.

Rejected: keeping settings in the renderer (`localStorage`) or letting the coordinator write the file. The page must never see a key, and the coordinator has no `electron`, so it cannot use `safeStorage`; both are why [ADR 0013](../../../docs/adr/0013-secrets-with-safestorage.md) puts sealing in main, with `secret.seal` / `secret.open` for the coordinator's own secrets.

## 2. Layers touched
| Layer | Files | Why it lives there |
|---|---|---|
| shared | `src/shared/types.ts` (`Settings`, `PublicSettings`, `SecretProviderId`), `src/shared/defaults.ts` (`defaultSettings`, `DEFAULT_AGENTS`, `emailServersFor`, `looksLikeApiKey`), `src/shared/mcp-import.ts` (`importMcpJson`), `src/shared/desktop-api.ts` | model, defaults and pure helpers used by main and renderer |
| coordinator | `src/coordinator/index.ts` (receives `init` / `settings`, sends `settings.patch`, `alwaysAllow`, `host.request`) | agents read settings; they change them only by message |
| main | `src/main/settings.ts` (`SettingsStore`, `encrypt`, `decrypt`, `secretsProtected`), `src/main/guard.ts` (`newCommands`), `src/main/index.ts` (IPC handlers, legacy profile copy, tray / login item / hotkey), `src/preload/index.ts` | disk, `safeStorage`, native dialogs and origin checks need `electron` |
| renderer | `src/renderer/src/components/SettingsDialog.tsx`, `src/renderer/src/home/HomeSettings.tsx`, `src/renderer/src/umbra/AmbienceControls.tsx` | the 14-tab dialog; sound and motion are per-window preferences |

Layer rules in `docs/architecture.md` hold: main and renderer never import each other; they share only `shared`.

## 3. Contracts
```ts
class SettingsStore { get(): Settings; getPublic(): PublicSettings; update(patch: Partial<PublicSettings>): Settings; setApiKey(provider: SecretProviderId, apiKey: string): Settings; setCompanySecret(companyId: string, secret: string): Settings }
type SecretProviderId = 'anthropic'|'xai'|'deepseek'|'vercel'|'meta'|'openai'|'telegram'|'elevenlabs'|'email'
newCommands(before: Record<string, McpServerConfig>, after: Record<string, McpServerConfig>): string[]
emailServersFor(address: string): Partial<Settings['email']>
importMcpJson(text: string): McpServerConfig[]
```
IPC (window → main): `settings:get`, `settings:update(patch)`, `settings:setApiKey(provider, key)`, `settings:setCompanySecret(companyId, secret)`; main → window `settings:changed`. Coordinator messages: main → coordinator `init`, `settings`; coordinator → main `settings.patch`, `alwaysAllow`, `host.request` `secret.seal` / `secret.open`. Errors: "Proveedor desconocido", "Empresa desconocida", "Cambio cancelado.", "Origen no autorizado". No new tool, so no `ToolRisk`.

## 4. Data and persistence
`<userData>/settings.json`, written to `settings.json.tmp` (mode 0o600) and renamed. Secrets are `enc:` + base64 of the sealed value; empty stays empty; without a secure store they are not written unless `ALMA_ALLOW_PLAINTEXT_SECRETS=1`. `ALMA_USER_DATA` overrides the folder. Load-time migrations are idempotent and marked by `officeToolsAdded` and `multimediaAdded`; missing sections take defaults key by key; a corrupt file falls back to defaults. The old `%APPDATA%\MultiAgente` folder is copied once, before Chromium opens the profile, skipping locks and caches. Sound, music and motion live in the window's `localStorage` (`umbra.prefs`), outside the file.

## 5. Dependency injection
The store reaches `safeStorage` and the file path through small helpers in `src/main/settings.ts`; the guard is a pure function over two server maps; defaults and mail guessing are pure in `shared`. Tests call those pure functions directly (`tests/defaults.test.ts`, `tests/guard.test.ts`, `tests/integrations.test.ts`); the Electron-bound handlers (dialogs, IPC, tray) have no seam and are checked by hand.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.1, 1.5–1.16 | [gap] | corrupt JSON, empty agent list, wake word rewrite, one-time migrations run once, existing new folder |
| AC-1.2 | `tests/defaults.test.ts` → `has unique agent ids and a default agent that exists` | duplicate ids |
| AC-1.3 | `tests/defaults.test.ts` → `ships a Multimedia agent that can run Remotion and only uses known tools` | unknown tool names |
| AC-1.4 | `tests/defaults.test.ts` → `ships a Vercel AI Gateway agent with its own key slot` | |
| AC-2.1–2.12 | [gap] | no secure store, `basic_text`, undecryptable secret, unknown provider id, unknown company |
| AC-3.1–3.4, 3.6–3.8 | [gap] | patch touching `providers`, unlisted vs listed `alwaysAllow`, foreign frame |
| AC-3.5 | `tests/guard.test.ts` → `flags new, changed and re-enabled commands only` (the flag logic; the dialog is [manual]) | unchanged command, disabled server |
| AC-4.1–4.5, 5.1–5.5, 6.1–6.3, 7.1–7.3, 8.1–8.3, 8.5–8.9, 9.1–9.5 | [manual] walk each tab as written in the criterion | delete the default agent, cancel the folder picker, key-shaped image model |
| AC-7.4 | `tests/providers.test.ts` → `reads Claude Desktop / Cursor style configs` | non-object entries |
| AC-7.5 | [gap] | invalid JSON |
| AC-8.4 | `tests/integrations.test.ts` → `guesses the mail servers from the address` | unknown domain, no `@` |

## 7. Security and privacy impact
No new tool. Secrets exist in clear only in main and coordinator memory; the window gets booleans; audit entries (`secret.set`, `secret.clear`, `settings.update`, `always-allow.add`, `ipc.rejected`) never carry a value. A patch that adds or re-enables a stdio MCP command, or moves to `always-allow`, needs a native confirmation, and only the top frame of the app's own window may call IPC. Affected: `docs/security/CONTROLS.md` (secrets at rest, native confirmation, audit rows).

## 8. Rollout
No flag; the file is created on first run with defaults (9 default agents, `needs-approval`, tray on, launch at login off, retention off, Telegram enabled but without token, voice / WhatsApp / house off). A person with a `MultiAgente` profile and no `settings.json` gets it copied on first start. The dialog opens on Proveedores.
