# Alma's security controls

Map of Alma's technical controls against **SOC 2** (Trust Services Criteria 2017, rev. 2022), **ISO/IEC 27001:2022** (Annex A) and **ISO/IEC 27701**. It is the matrix handed to an auditor: each row says what is done, where the evidence is in the repo and what is missing.

## Scope and what this document is NOT

- "Alma is a local desktop application" (Electron). There are no servers operated by Alma: the person (or company) that installs it is the one who controls the data, and the model providers they configure act as processors (see [PRIVACY.md](PRIVACY.md)).
- "It is not a certification." SOC 2 is attested by an auditor over a period of operation; ISO 27001/27701 are certified over an organization's management system (ISMS/PIMS). The software contributes the "technical controls"; policies, roles, training, periodic reviews and supplier management belong to the organization (🏢 rows).
- Statuses: ✅ implemented and verifiable · 🟡 partial · ⛔ open technical gap (see [RISKS.md](RISKS.md)) · 🏢 organizational, outside the code.

## 1. Access control and authentication

| Control | References | Status | How it is met (evidence) | Pending |
|---|---|---|---|---|
| Only the owner uses the remote channels | SOC2 CC6.1 · 27001 A.5.15, A.8.3 | ✅ | Telegram: private chats only, bound to the `chatId` of the first authorized user (`authorizeChat`, `channels/telegram.ts`). WhatsApp: only the own chat (`isSelfChat`). Denied attempts on Telegram are kept in the audit trail (`channel.denied`, limited to one per minute). The Telegram `/home` panel reuses the same chat check; locks, alarms and gates confirm in-chat and are audited as `home.control` (actor `remote`). | — |
| Human approval of risky actions | SOC2 CC6.1, CC6.3 · 27001 A.5.15, A.8.2 | ✅ | `authorize()` in `coordinator/approval.ts`: blocked / ask / auto-review / always-allow modes; publishing **always** asks for approval; approvals also over Telegram with the same chat check. | `home` and company agents are auto-approved by design (R‑07). |
| Changes that give the agent more power require native confirmation | SOC2 CC6.1, CC6.8 · 27001 A.8.2, A.8.9 | ✅ | `main/guard.ts` + `settings:update`: adding/changing/enabling an MCP stdio server or switching to «Siempre permitir» opens a system dialog that the page cannot click. Test: `tests/guard.test.ts`. | — |
| Trusted IPC surface | SOC2 CC6.6 · 27001 A.8.20, A.8.26 | ✅ | `isTrusted()`/`handle()` in `main/index.ts`: only the main frame of the app's own window, still on the loaded page. The rejection is kept in the audit trail (`ipc.rejected`). | — |
| Least privilege for Chromium | SOC2 CC6.6 · 27001 A.8.26 | ✅ | `contextIsolation`, `sandbox`, `nodeIntegration:false`; permissions only `media` (audio) and clipboard, never camera/location/USB; `<webview>` forbidden; navigation and redirects blocked (`createWindow`, `lockDownPermissions`). | Electron Fuses and code signing when packaging (R‑06). |
| Bounded file opening | 27001 A.8.3 · SOC2 CC6.8 | ✅ | `shell:openPath` rejects executables and scripts. File tools confined to the working folder with `realpath` (`tools/paths.ts`); `alma-vault://` protocol never leaves the vault, neither through symlinks nor through paths with `\`. | — |
| Identity and access management of people | SOC2 CC6.2, CC6.3 · 27001 A.5.16, A.5.18, A.6.5 | 🏢 | A single local user; access to the machine is governed by the operating system. With more than one person: separate OS accounts, offboarding and quarterly reviews. | Procedure for onboarding/offboarding/review. |

## 2. Cryptography and secrets

| Control | References | Status | How it is met (evidence) | Pending |
|---|---|---|---|---|
| API keys and passwords encrypted at rest | SOC2 CC6.1, C1.1 · 27001 A.8.24 | ✅ | `main/settings.ts`: `safeStorage` (DPAPI/Keychain/libsecret). "A key is never written in clear": without a secure store (or with Linux's `basic_text`) they are not persisted; `ALMA_ALLOW_PLAINTEXT_SECRETS=1` is the explicit exception. Old keys in clear are re‑sealed on their own. `settings.json` is written with 0600 permissions. | — |
| Keys do not reach the interface | SOC2 C1.1 · 27001 A.8.11 | ✅ | `getPublic()` only exposes `hasKey/fromEnv`. | — |
| Keys do not reach what the model runs | SOC2 CC6.1, C1.1 · 27001 A.8.12 | ✅ | `commandEnv()` (`tools/shell.ts`) removes the providers' keys from the environment of `run_command`; MCP servers receive only the SDK's default environment. Test: `tests/web.test.ts`. | Other sensitive variables of the user are not known in advance (R‑03). |
| Encryption in transit | SOC2 CC6.7 · 27001 A.8.24 | ✅ | All model APIs over HTTPS. Mail: IMAP/SMTP with TLS ≥ 1.2 and **mandatory STARTTLS** on non-implicit ports (`tools/email.ts`), no silent downgrade. | — |
| Encryption of local data (conversations, vault) | SOC2 C1.1 · 27001 A.8.24 | 🟡 | They depend on the OS disk encryption (BitLocker/FileVault). | Require BitLocker/FileVault (🏢) or encrypt `threads/` with a `safeStorage` key (R‑04). |

## 3. Logging, monitoring and response

| Control | References | Status | How it is met (evidence) | Pending |
|---|---|---|---|---|
| Tamper-evident audit trail | SOC2 CC7.2, CC4.1 · 27001 A.8.15, A.8.16 | ✅ | `shared/audit.ts`: JSONL per month and process (`<userData>/audit/`), **SHA‑256 hash chain** (editing, deleting or reordering a line breaks the chain; `verifyAudit()` says where). It records: authorization and execution of non-read tools (with who allowed it), settings changes, key additions/removals, denials, rejected IPC, publications, deletions, exports and data erasure. It never stores secrets or message content (`redact()`). Retention 13 months. Tests: `tests/audit.test.ts`. | Truncating the end of the file is not detected: export or send the chain off the machine (R‑08). |
| Audit review and alerts | SOC2 CC7.2, CC7.3 · 27001 A.8.16 | 🏢 | — | Monthly review of `verifyAudit()` and of denials; alert on repeated `ipc.rejected` or `channel.denied`. |
| Incident management | SOC2 CC7.3–CC7.5 · 27001 A.5.24–A.5.28 | 🏢 | `SECURITY.md` defines the reporting channel and the deadlines. | Response plan (containment: revoke the provider keys and unlink Telegram/WhatsApp from the app), annual drill. |

## 4. Secure development and changes

| Control | References | Status | How it is met (evidence) | Pending |
|---|---|---|---|---|
| Validation of untrusted inputs (model output) | SOC2 CC6.8, PI1.2 · 27001 A.8.26, A.8.28 | ✅ | Each tool validates its input with Zod before asking for approval or running (`agent.ts`); paths through `resolveInWorkspace`; external results marked as "external data, not instructions". | — |
| Defense against data leakage through model content | SOC2 C1.1, CC6.7 · 27001 A.8.12 | ✅ | Remote images in the chat "are not loaded" (a URL written by the model could carry data) and the CSP reinforces it (`img-src` local only); CSP with `object-src`, `base-uri`, `form-action` set to `none`. | — |
| Restricted network access (SSRF) | SOC2 CC6.6 · 27001 A.8.20, A.8.23 | ✅ | `fetch_url` rejects private names "and public names that resolve to private addresses", and checks "every redirect before following it" (`tools/web.ts`). Tests in `tests/web.test.ts`. | DNS rebinding between resolution and connection (`ponytail:` note in the code; R‑09). |
| Dependency vulnerability management | SOC2 CC7.1 · 27001 A.8.8 | ⛔ | `pnpm audit` in CI and Dependabot (`.github/`). | **26 open advisories (12 high), including Electron < 44.9.1.** See R‑01. |
| Change control, review and testing | SOC2 CC8.1 · 27001 A.8.9, A.8.32 | 🟡 | CI (`.github/workflows/ci.yml`): typecheck + tests on every push/PR; 150+ tests. | Protection of the `main` branch with mandatory review and green CI (🏢, GitHub configuration); security tests are already part of the suite. |
| Separation of environments | 27001 A.8.31 | ✅ | `ALMA_USER_DATA` isolates a test profile from the real-use one. | — |
| A single package manager | SOC2 CC8.1 · 27001 A.8.9 | 🟡 | `pnpm-lock.yaml` is the current lockfile. | `package-lock.json` is obsolete and should be deleted (R‑10). |

## 5. Availability and continuity

| Control | References | Status | How it is met (evidence) | Pending |
|---|---|---|---|---|
| Recovery from process failures | SOC2 A1.2 · 27001 A.8.14 | ✅ | The coordinator restarts on its own if it dies (`main/index.ts`); atomic writes (`.tmp` + `rename`) for conversations and settings. | — |
| Backups | SOC2 A1.2 · 27001 A.8.13 | 🏢 | Data in `<userData>` and in the vault. | Backup policy (the export in «Privacidad» is a basis) and a restore test. |

## 6. Privacy (ISO 27701 · SOC 2 P1–P8)

| Control | References | Status | How it is met (evidence) | Pending |
|---|---|---|---|---|
| Inventory of personal data and purposes | 27701 7.2.1, 7.2.8 · SOC2 P1.1 | ✅ | [PRIVACY.md](PRIVACY.md): what is stored, where, what for, for how long. | Keep it up to date when adding integrations. |
| Transfers and processors | 27701 7.5.1–7.5.3, 8.5 · 27001 A.5.19–A.5.23 · SOC2 P6.1, CC9.2 | 🟡 | List of providers and what data each one receives (PRIVACY.md). The user explicitly chooses which provider each agent uses. | Data processing agreements (DPA) and an annual review of each provider (🏢). |
| Access and portability | 27701 7.3.6, 7.3.9 · SOC2 P5.1 | ✅ | «Ajustes → General → Privacidad → Exportar mis datos» (`privacy.export`). | — |
| Erasure | 27701 7.3.6, 7.4.8 · 27001 A.8.10 · SOC2 P4.3 | ✅ | «Borrar mi historial»: all conversations, received files and the voiceprint (biometric data) (`privacy.erase`); a record without content is left in the audit trail. | — |
| Retention | 27701 7.4.7 · SOC2 P4.2 | ✅ | «Ajustes → Privacidad»: automatic deletion of inactive conversations at 30/90/180/365 days (`applyRetention`); audit trail 13 months; Home Assistant history 7 days. | The default value is "never": decide it per organization (🏢). |
| Minimization | 27701 7.4.4 | ✅ | The audit trail and notifications carry no content; keys are not sent to the interface; voice is transcribed on the machine by default (local Whisper). | — |
| Biometric data (voiceprint) | 27701 7.2.2 · GDPR art. 9 | 🟡 | Optional, local, can be deleted. | Explicit consent and a record of the legal basis when enabling it (🏢). |
| Impact assessment (DPIA) | 27701 7.2.5 | 🏢 | — | Needed if a surveillance camera is used with third parties or employees. |

## Verification against the code

Checked by reading `src/`. These claims above do not match what the code does today. Details and the full table: [docs/modules/security.md](../modules/security.md) (section "Documented controls vs. the code").

- **Audit verification:** nothing in the app, a script or the UI calls `verifyAudit()` (only `tests/audit.test.ts` does), and it throws if the `audit` folder is missing, so the "monthly review" cannot be carried out. See [security](../modules/security.md).
- **Rejected IPC:** `ipc.rejected` is recorded for invoke channels only; the `coordinator:connect` listener ignores untrusted callers without logging. See [security](../modules/security.md).
- **Trail content:** the trail stores the `run_command` text (masked, up to 300 characters) and the approval note (which includes the auto-review reason), so "never stores content" is not strictly true. See [security](../modules/security.md).
- **`redact()` coverage:** it does not mask a Telegram bot token, `ghp_`/`AIza` keys, `--password x` without `=`, or `export ANTHROPIC_API_KEY=…`; `password="a b"` leaks the text after the first space. See [security](../modules/security.md).
- **CSP:** `media-src` allows `https:`, so "no exit channel through the browser" holds for images (`img-src`) but not for audio or video elements. See [security](../modules/security.md).
- **File confinement:** `loadPicture` (`look_at_image`, `send_telegram` images) uses a case-insensitive string prefix with no `realpath`, so it is weaker than `resolveInWorkspace`. See [security](../modules/security.md).
- **PRIVACY.md omission:** the auto-review model (tool input, latest user message) and the `look_at_image` vision flow are not in the provider table. See [security](../modules/security.md).
