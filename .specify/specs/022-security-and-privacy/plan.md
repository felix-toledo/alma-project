# 022 — Plan

## 1. Approach
Controls live outside the model and outside the page. The main process owns every secret and the only native confirmation dialog; the renderer never receives a key and cannot confirm its own request. A small shared module writes a hash-chained audit trail that both processes append to. The coordinator enforces what a model-supplied path or URL may reach (workspace confinement, private-host refusal), and also implements the person's data rights (export, erase, retention). Everything else is defaults: a locked-down window, a strict CSP, owner-only channels.

Secrets use the operating system's store (`safeStorage`, DPAPI on Windows) and are not persisted when none exists ([ADR 0013](../../../docs/adr/0013-secrets-with-safestorage.md)); approval behavior is in [ADR 0012](../../../docs/adr/0012-approval-model.md). Rejected: a master password the person types to unlock their keys. It adds a prompt on every start, and routines and channels must keep running while the window is closed, so the app could not unlock itself without storing the password, which is the problem again. Also rejected: logging full tool arguments and messages in the trail for completeness. The trail is meant to be shown to a reviewer; it carries identifiers, argument names and outcomes only.

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | `src/shared/audit.ts` (`initAudit`, `audit`, `verifyAudit`, `redact`), `src/shared/types.ts` (`PublicSettings`, `HostRequest` `secret.seal`/`secret.open`, `Settings.privacy`) | The chain format is one contract for two processes; no Electron or Node-only API beyond `fs`/`crypto` |
| coordinator | `src/coordinator/privacy.ts` (`exportPersonalData`, `erasePersonalFiles`), `src/coordinator/tools/web.ts` (`isPrivateHost`, `fetch_url`), `src/coordinator/tools/paths.ts` (`resolveInWorkspace`), `src/coordinator/tools/shell.ts` (environment scrub), `src/coordinator/mcp.ts` (server environment), `src/coordinator/channels/telegram.ts`, `whatsapp.ts` (owner-only), `src/coordinator/index.ts` (retention, privacy requests, inbox, audit of tool runs) | The agent engine is what reads untrusted content and runs tools |
| main | `src/main/settings.ts` (`SettingsStore`, `encrypt`, `decrypt`), `src/main/guard.ts` (`newCommands`), `src/main/index.ts` (IPC gate, native dialog, `shell:openPath`, `alma-vault://`, window hardening, permissions, vault trash) | Only main has `safeStorage`, dialogs and the OS |
| renderer | `src/renderer/index.html` (CSP), `src/renderer/src/components/Markdown.tsx` (remote images blocked), `src/renderer/src/components/SettingsDialog.tsx` (Privacidad card, retention picker) | Defaults and controls; no logic that decides security |

`tests/architecture.test.ts` already forbids the renderer from importing `electron`, `node:*` or `shared/audit`.

## 3. Contracts
- `AuditEvent { action, actor: 'user' | 'agent' | 'remote' | 'system', target?, outcome: 'ok' | 'denied' | 'error', detail?, throttle? }`; `AuditCheck`; `initAudit(dataDir, who, now?)`, `audit(event, now?)`, `verifyAudit(dataDir)`, `redact(text)`, `AUDIT_RETENTION_MONTHS = 13`.
- Secrets: `encrypt(secret)`, `decrypt(stored)`, `secretsProtected()`; IPC `settings:get`, `settings:update`, `settings:setApiKey(provider, key)`, `settings:setCompanySecret`; host requests `secret.seal` / `secret.open`.
- Guard: `newCommands(before, after): string[]` over `Record<string, McpServerConfig>`.
- Web: `isPrivateHost(hostname)`; `fetch_url` and `web_search` are `read`. Paths: `resolveInWorkspace(workspace, path)`, `displayPath`.
- Privacy: `exportPersonalData(dataDir, targetDir, now?)` returns the new folder; `erasePersonalFiles(inboxDir)`; requests for export, erase and `Settings.privacy.threadRetentionDays`.
- Window: IPC `shell:openPath`, `dialog:pickFolder`; protocol `alma-vault://file/<path>`; host request `trash { path }`.

## 4. Data and persistence
- `<userData>/settings.json`: secrets as `enc:` + base64, written to a temp file with mode 0600 and renamed; a clear secret from an older version is rewritten sealed on first start when a store exists.
- `<userData>/audit/<source>-YYYY-MM.jsonl`, appended with mode 0600; each line is JSON with `prev` = `genesis` or the SHA-256 of the previous line's exact text; files older than 13 months are removed at start.
- Exports: `alma-export-YYYYMMDD-HHMMSS/` in the folder the person picks, with copies of `threads`, `companies`, `audit`, `routines-state.json`, `voice-profile.json`. Erase touches conversations, `<userData>/inbox/` and the voice profile.

## 5. Dependency injection
- `audit` and `initAudit` take the data directory and a `now` date, so tests use temp folders and fixed months to check retention and chaining.
- `newCommands` is pure over two settings maps.
- `fetch_url` calls `lookup` from `node:dns/promises` and the global `fetch`; tests mock the DNS module and stub `fetch` to prove no request is sent to a private address and that each redirect hop is checked.
- `resolveInWorkspace` takes the workspace path as an argument; tests use temp folders.
- Telegram access decisions are a pure function of the chat, the username and the bound chat id; the channel tests build it with fake deps.

## 6. Test strategy
| AC | Test file → name | Adversarial cases |
|---|---|---|
| AC-1.8 | `tests/web.test.ts` → "keeps the provider keys out of commands the model runs" | lower-case variable names |
| AC-2.1–2.2 | `tests/guard.test.ts` → "flags new, changed and re-enabled commands only" | tools filter only, disabled server, http server |
| AC-3.1–3.3 | `tests/audit.test.ts` → "chains entries, survives a restart and detects tampering" | edited, removed and reordered lines |
| AC-3.6–3.7 | `tests/audit.test.ts` → "never writes secrets and can throttle spammable events" | key prefixes, bearer tokens, `password=` pairs |
| AC-3.8 | `tests/audit.test.ts` → "removes trails older than the retention window" | UTC month boundary |
| AC-5.1 | `tests/web.test.ts` → "keeps fetches off this machine and the local network" | `172.32.0.1` is public, `printer.local` is not |
| AC-5.2 | `tests/web.test.ts` → "does not send the request when a public name resolves inside the network" | DNS rebinding to 192.168.x |
| AC-5.3 | `tests/web.test.ts` → "checks every redirect before following it" | redirect to 127.0.0.1 |
| AC-5.4 | `tests/web.test.ts` → "reads a page after a public redirect" | |
| AC-6.1–6.4 | `tests/tools.test.ts` → "resolves relative paths inside the workspace", "rejects paths that escape the workspace", "requires a workspace", "refuses to write outside the workspace" | `..`, absolute path elsewhere, missing folder |
| AC-7.1 | `tests/telegram.test.ts` → "binds the first allowed user in a private chat, case-insensitively and ignoring @", "never accepts groups, even from an allowed user", "once bound, only that chat works, whatever the username" | group chats, renamed user |
| AC-1.1–1.7, 1.9, 1.10, 2.4, 2.5, 3.4, 3.5, 3.9–3.12, 4.1, 4.5–4.7, 5.5–5.7, 6.5–6.7, 7.2, 7.3, 8.1–8.3, 9.1 | [gap] | backlog: undecryptable secret reads empty, no store means nothing on disk, symlinked directory escape, `.exe` refused by `openPath`, retention skips running threads |
| AC-2.3, 4.2–4.4, 9.2 | [manual] | switch to "Permitir todo" and check the dialog comes from the system; click a chat link; ask an agent for `![x](https://example.com/a.png)`; compare the outbound-host table with the code |

## 7. Security and privacy impact
This feature is the controls. Tool classes it relies on: `web_search` and `fetch_url` are `read` (no approval, but private hosts refused); `send_telegram` is `memory`; `look_at_image` is `read` with confined roots. Only a new stdio MCP command and the mode "Permitir todo" get a native confirmation. Secrets are never in the UI, logs, audit, errors or prompts. Third parties and what each receives are listed in BR-9 and `docs/security/PRIVACIDAD.md`; the control mapping is `docs/security/CONTROLES.md` and the open risks `docs/security/RIESGOS.md`. Any new outbound host needs a row in `PRIVACIDAD.md` in the same change.

## 8. Rollout
No flag for secrets, audit, guard, IPC gate or CSP: always on. Retention defaults to 0 ("never"), with 30, 90, 180 and 365 days selectable in Configuración → Privacidad. `ALMA_ALLOW_PLAINTEXT_SECRETS=1` is an explicit escape hatch for machines without a secure store; `ALMA_USER_DATA` redirects the profile for tests. On first run the audit trail starts at `genesis` and records `app.start`.
