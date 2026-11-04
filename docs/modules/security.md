# Security and privacy (Seguridad y privacidad)

> The software controls that keep Alma from doing more than you allowed and from leaking what it holds: sealed secrets, a native confirmation for risky settings, a hash-chained audit trail, a locked-down window, private-network blocking in web tools, file confinement, owner-only channels, and your rights over your data. Spec: [022 · Seguridad y privacidad](../../.specify/specs/022-security-and-privacy/spec.md). Compliance prose lives in [CONTROLS](../security/CONTROLS.md), [RISKS](../security/RISKS.md), [PRIVACY](../security/PRIVACY.md) and [SECURITY.md](../../SECURITY.md). Test status: 18 criteria with a test, 38 without (5 are manual checks, 33 have no check at all).

## What it does

For the person:

- API keys and passwords are stored sealed by Windows and never shown back to the window, to commands agents run, or to logs.
- A system dialog (the page cannot click it) asks before Alma starts a new program (an MCP server) or stops asking for approvals.
- A record of what agents did, who allowed it and what you changed in settings, that shows if someone edited it.
- Web tools refuse your computer and local network. File tools stay inside the working folder.
- Only you can talk to Alma through Telegram and WhatsApp.
- You can export your data, erase your history, and have old conversations deleted automatically.

For an agent, these are limits, not tools: it cannot reach the local network with `fetch_url`, cannot read keys from the environment of `run_command`, cannot leave the working folder, and its non-read actions are written to the audit trail.

## How to use it

1. **Export**: «Configuración → General → Exportar mis datos…». Pick a folder; Alma creates `alma-export-YYYYMMDD-HHMMSS` there.
2. **Erase**: **Borrar mi historial** (erase my history). Confirm «No se puede deshacer. Tu vault, tus claves y tus canales no se tocan.» (cannot be undone; vault, keys and channels are untouched).
3. **Retention**: «Borrar conversaciones sin actividad» (delete idle conversations): «Nunca» (never), 30, 90, 180 or «Al año» (365) days. Default never.
4. **Confirmation dialog**: when you pick «Permitir todo» (allow all) or add an MCP stdio server, a system dialog «Confirmar cambio de seguridad» appears. «Cancelar» is the default.
5. **Read the trail**: files in `%APPDATA%\Alma\audit\*.jsonl` (one JSON per line). There is no screen for it. Verifying the chain from the app is not possible today (see the table below).
6. **Leaked key**: see [SECURITY.md](../../SECURITY.md): revoke at the provider, replace in «Configuración → Proveedores», regenerate the Telegram token, unlink WhatsApp, review the trail from the leak date.

## How it works

| Control | Where |
|---|---|
| Secret sealing (`safeStorage`), public view | `src/main/settings.ts` (see [settings](settings.md)) |
| Native confirmation | `src/main/guard.ts` (`newCommands`), `settings:update` in `src/main/index.ts` |
| Audit trail | `src/shared/audit.ts` (`initAudit`, `audit`, `redact`, `verifyAudit`); callers in `main/index.ts`, `coordinator/agent.ts`, `coordinator/channels/telegram.ts`, `coordinator/index.ts` |
| Window, IPC, permissions, `shell:openPath`, `alma-vault://` | `src/main/index.ts`, `src/renderer/index.html` (CSP) |
| Remote image blocking | `src/renderer/src/components/Markdown.tsx` |
| Private hosts and redirects | `src/coordinator/tools/web.ts` |
| File confinement | `src/coordinator/tools/paths.ts` (`resolveInWorkspace`) |
| Command environment | `src/coordinator/tools/shell.ts` (`commandEnv`) |
| Export, erase, retention | `src/coordinator/privacy.ts`, `applyRetention` in `src/coordinator/index.ts` |
| Owner-only channels | `src/coordinator/channels/telegram.ts`, `whatsapp.ts` |

The audit trail:

```
 audit({action, actor, target?, outcome, detail?, throttle?})
   │  detail strings → redact() → cut at 300 chars
   ▼
 {"ts","src","action","actor","target","outcome","detail","prev"}   prev = "genesis" or SHA-256 of the previous line's exact text
   ▼
 <userData>/audit/<main|coordinator>-YYYY-MM.jsonl   (append, mode 0600)
```

Each process (main and coordinator) keeps its own chain across its monthly files. At startup `initAudit` continues the chain from the newest file's last line and removes files older than 13 months by UTC month; the chain then restarts at the oldest kept line. A failure to open or write goes to the console and never stops the app. Before `initAudit`, `audit()` does nothing. Events marked `throttle` are dropped if the same action and target happened in the last 60 seconds.

Actions recorded (verified with `grep audit(` in `src/`): `tool.authorize` (denied) and `tool.run` (ok or error) for non-read tools with risk, thread, agent, the decision note, argument names and, for `run_command`, the command text; `settings.update`; `secret.set`, `secret.clear`; `always-allow.add`; `instagram.publish`, `instagram.connect`, `instagram.disconnect`; `vault.trash`; `shell.openPath` (denied); `ipc.rejected`; `channel.bind`, `channel.denied` (Telegram only, chat kind only); `privacy.export`, `privacy.erase`, `privacy.retention`; `app.start`. Reads are not recorded. WhatsApp denials are not recorded.

## Settings and data

| What | Setting / place | Default |
|---|---|---|
| Retention of conversations | `privacy.threadRetentionDays` | 0 (never); options 30, 90, 180, 365 |
| Plaintext secrets escape hatch | environment variable `ALMA_ALLOW_PLAINTEXT_SECRETS=1` | not set |
| Separate profile | environment variable `ALMA_USER_DATA` | not set |
| Settings and secrets | `<userData>/settings.json`, sealed `enc:` values, mode 0600 | |
| Audit trail | `<userData>/audit/<source>-YYYY-MM.jsonl` | 13 months |
| Conversations, received files, voice profile | `<userData>/threads/`, `inbox/`, `voice-profile.json` | |
| Routines state, companies | `routines-state.json`, `companies/` | |

File mode 0600 has little effect on Windows, where access is by ACL. The practical protection is the per-user profile folder and DPAPI.

## Limits and rules

- `fetch_url`: `http(s)` only, 5 redirects, 20 s timeout, 60 000 characters maximum output (`max_chars` default 15 000). Each redirect is checked before it is followed. A public name that resolves to a private address is refused with no request sent.
- Private hosts: `localhost`, `*.localhost`, `*.local`, `*.internal`, and IPs in 127/8, 10/8, 0/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, `::1`, `::`, `fc*`/`fd*`/`fe80*`, `::ffff:*`. `web_search` and `fetch_url` are `read` tools: they never ask for approval.
- `commandEnv` removes `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `AI_GATEWAY_API_KEY`, `META_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `TELEGRAM_BOT_TOKEN` (case-insensitive) and adds `CI=1`, `NO_COLOR=1`.
- Audit: 13 months, 60 s throttle, 300 characters per detail string.
- `redact()` masks: `xai`/`sk`/`LLM` followed by `-` or `|` and 16+ word characters; `Bearer <token>`; `password|passwd|pass|token|secret|api_key|api-key` followed by `=` or `:` and a value.
- Retention check runs at startup, every 12 hours and when settings change; it spares running conversations.
- Export copies `threads`, `companies`, `audit`, `routines-state.json`, `voice-profile.json`. Not exported: keys, sessions, the vault, received images. Erase removes all conversations, empties and recreates the received-files folder, and forgets the voice profile.
- Telegram: private chats only; the first allowed user writing binds the chat id (case-insensitive, `@` ignored). WhatsApp: only the person's own chat.

## Security and privacy

What asks first: new or changed stdio MCP commands, and moving to «Permitir todo». Nothing else in settings goes through the dialog.

What leaves the machine (BR-9 of the spec, outbound hosts checked against the code):

| To | What | When |
|---|---|---|
| Anthropic, `api.x.ai`, `api.deepseek.com`, `api.meta.ai`, `ai-gateway.vercel.sh` | Every message, tool result and image of an agent using that provider | Agent runs |
| The auto-review provider (may differ from the agent's) | Tool name and input (cut at 8000 characters), your latest message (cut at 4000), the review instructions, the working folder | Each review in «Auto-review» mode. Confirmed in `src/coordinator/approval.ts` (lines 83–84; the boss review at 124–126 also sends the boss's instructions) |
| The vision provider | The pictures | House cameras, `look_at_image` (`src/coordinator/vision.ts`) |
| `api.openai.com`, Meta, `api.elevenlabs.io` | Audio for transcription; text to read aloud; image prompts | Only if STT/TTS/images are set to those. Defaults are local (`stt: local`, `tts: kokoro`) |
| `html.duckduckgo.com` and any public site | Every `web_search` query, your IP, and any URL the model chose | `web_search`, `fetch_url` |
| `api.telegram.org`, WhatsApp, Instagram, your IMAP/SMTP server | Messages, photos, bot token in file-download URLs, posts (after approval), credentials and mail | Channels enabled |
| `huggingface.co` | One-time model downloads, no personal data | First use |
| MCP servers you add | Whatever the tools send them | Tool calls |

Nothing is sent to servers run by Alma: there are none.

## Documented controls vs. the code

Each row takes a control claimed in [CONTROLS](../security/CONTROLS.md), [RISKS](../security/RISKS.md) or [PRIVACY](../security/PRIVACY.md) and says what the code does. Checked by reading `src/` (and running the `redact` patterns in Node). Not verified here: advisory counts (R-01), "150+ tests", GitHub branch protection.

| Control claimed (document) | What the code does | Verdict |
|---|---|---|
| Tamper-evident audit chain with SHA-256; `verifyAudit()` says where it breaks (CONTROLS §3) | `audit.ts` chains each line to the SHA-256 of the previous line as claimed. `tests/audit.test.ts` proves it detects edits, removals and reordering. | Match |
| "Monthly review of `verifyAudit()`" (CONTROLS §3, marked organizational) | `verifyAudit` is called only from `tests/audit.test.ts`. No UI, script, menu or CLI calls it. It also throws (`readdirSync`) if `<userData>/audit` does not exist. A reviewer has no way to run the check. | Mismatch |
| Rejected IPC is logged: "The rejection is kept in the audit trail (`ipc.rejected`)" (CONTROLS §1) | `handle()` audits `ipc.rejected` for the 10 invoke channels. The `ipcMain.on('coordinator:connect')` listener returns silently when untrusted. | Partial mismatch |
| Trail "never stores … message content" (CONTROLS §3, PRIVACY §1 and §4) | `agent.ts` stores `command` (the `run_command` text, masked, cut at 300 characters) and `decision` (the approval note, which for auto-review includes the reviewer's reason). Message text itself is not stored. | Partial mismatch |
| Trail "never stores secrets … (`redact()`)" (CONTROLS §3) | Tested in Node: `sk-ant-…` keys and `password=x` pairs are masked. Not masked: a Telegram bot token inside a URL (`/bot123456789:AAH…`), `ghp_…` GitHub tokens, `AIza…` keys, `--password hunter2` (space, no `=`), `export ANTHROPIC_API_KEY=abc` (no word boundary before `api`, so `_API_KEY` is missed), and `password="a b"` leaks everything after the first space. | Mismatch |
| Remote images never load; CSP reinforces it, "no exit channel through the browser" (CONTROLS §4, RISKS R-11) | `Markdown.tsx` blocks remote `<img>` and `img-src` is local only. But the CSP `media-src` is `'self' blob: data: https:`, so an `<audio>`/`<video>` with an `https:` source would load. No component in the renderer was checked for producing such an element. | Partial mismatch |
| `object-src`, `base-uri`, `form-action` set to `none` (CONTROLS §4) | Same strings in `src/renderer/index.html`. | Match |
| File tools confined to the working folder "with `realpath`" (CONTROLS §1) | `resolveInWorkspace` canonicalizes the closest existing ancestor (tests in `tests/tools.test.ts`). But `loadPicture` (`look_at_image`, `send_telegram` with an image) checks allowed folders with a case-insensitive string prefix and no `realpath`: root `C:\work` also admits `C:\work-secrets`, and a symlink inside is followed. | Partial mismatch |
| Native confirmation for new MCP stdio command and for «Siempre permitir» (CONTROLS §1, R-07, R-12) | `guard.ts` + `settings:update`, default button «Cancelar». Covers only those two changes. | Match (narrow) |
| Secrets sealed, never in clear; old clear keys resealed; not persisted without a store (CONTROLS §2) | `settings.ts` `encrypt`/`decrypt`/`open`, `ALMA_ALLOW_PLAINTEXT_SECRETS` escape hatch, rewrite on start only when sealing is possible. | Match |
| Keys never reach the UI (CONTROLS §2) | `getPublic()` returns `hasKey`/`fromEnv`/`baseUrl` and boolean company passwords. | Match |
| Keys removed from the environment of `run_command` (CONTROLS §2) | `commandEnv` removes 8 names; `tests/web.test.ts`. MCP environment not re-checked here. | Match |
| `shell:openPath` rejects executables and scripts (CONTROLS §1) | `EXECUTABLE` regex plus audit `shell.openPath` denied. | Match |
| Minimal Chromium privileges; navigation, redirects, `<webview>` blocked (CONTROLS §1) | `createWindow`, `lockDownPermissions` in `main/index.ts`. | Match |
| Telegram owner-only, denials audited at most once a minute (CONTROLS §1) | `authorizeChat`, `channel.denied` with `throttle: true`, chat kind only. WhatsApp has no audit entries for denials (the row only claims Telegram). | Match |
| SSRF: private names, names resolving to private IPs, every redirect checked (CONTROLS §4) | `tools/web.ts`, `tests/web.test.ts`. DNS rebinding is left open (R-09), as stated. | Match |
| Mail with TLS ≥ 1.2 and mandatory STARTTLS (CONTROLS §2) | `email.ts`: `minVersion: 'TLSv1.2'`, `doSTARTTLS` on non-993, `requireTLS` on non-465. | Match |
| `pnpm audit` in CI and Dependabot (CONTROLS §4) | `ci.yml` runs `pnpm audit --audit-level=high`; `.github/dependabot.yml` exists. | Match |
| Home Assistant listens on `0.0.0.0`, 7 days of history (RISKS R-02, CONTROLS §6) | `engine.ts`: `server_host: 0.0.0.0`, `purge_keep_days: 7`. | Match (the risk is real and open) |
| Export, erase, retention (CONTROLS §6, PRIVACY §3) | `privacy.ts` and `applyRetention`, every 12 h. | Match |
| Model providers receive data "when an agent uses that provider" (PRIVACY §2) | Also true for the auto-review model (tool input, your latest message) and for the vision model (pictures). PRIVACY §1 mentions the camera-vision flow in the cameras row only; the provider table in §2 lists neither auto-review nor `look_at_image`, and no part of the document says that auto-review sends tool input and your latest message. | Mismatch (omission) |

## How it is tested

| Criteria | Test file |
|---|---|
| Audit chain, restart, tamper detection, redaction of known patterns, throttle, retention of 13 months | `tests/audit.test.ts` |
| Which MCP changes are flagged | `tests/guard.test.ts` |
| `commandEnv`, private hosts, DNS-to-private, redirects | `tests/web.test.ts` |
| Workspace path confinement | `tests/tools.test.ts` |
| Telegram owner-only binding | `tests/telegram.test.ts` |

Not covered: the native dialog, the IPC gate, permissions, the CSP, `shell:openPath`, `alma-vault://`, the trash request, secret sealing, export, erase, retention, `loadPicture`, WhatsApp self-chat, the audit calls made by the agent loop. By hand: switch the mode in Aprobaciones and check that the dialog is a system one; ask an agent to answer with `![x](https://example.com/a.png)` and see «[imagen remota bloqueada…]»; click a link in chat; read the outbound-host table against `grep` when an integration is added.

## Known limits

Ordered by priority:

1. The audit chain cannot be verified by a person (`verifyAudit` is dead code outside tests; throws without an `audit` folder).
2. `redact()` misses common secret formats, and `run_command` text is stored.
3. `fetch_url` is a `read` tool, so data the model puts in a URL leaves with no approval.
4. `loadPicture` uses a weaker path check than `resolveInWorkspace`.
5. `media-src` allows `https:`.
6. The native confirmation does not cover `alwaysAllowTools`, per-agent `autoApproveTools`, auto-review instructions, Telegram on, or an http MCP server.
7. PRIVACY omits the auto-review and `look_at_image` data flows.
8. `coordinator:connect` rejections are not audited.
9. `send_telegram` is `memory` risk and can send any allowed image to your Telegram without asking.
10. `saveInboxImage` sanitizes names with `/[^w.-]+/g` (a literal `w`), turning most letters of received file names into `_` (`src/coordinator/index.ts:352`). Probably a typo for `\w`; confinement is not weakened.
11. Home Assistant on `0.0.0.0` is still open (R-02).
12. «Borrar mi historial» leaves the audit trail, company task data, routines state and the vault. Confirm it is intended.
13. 33 of 56 criteria have no test, including all secret-sealing and privacy-rights behavior. Dependency vulnerabilities and signing are tracked in [spec 001](../../.specify/specs/001-release-packaging/spec.md).

## See also

[settings](settings.md) · [approvals](approvals.md) · [app-shell](app-shell.md) · [files-and-commands](files-and-commands.md) · [web-and-mail](web-and-mail.md) · [mcp](mcp.md) · [telegram](telegram.md) · [whatsapp](whatsapp.md) · [vault-and-knowledge](vault-and-knowledge.md) · [limits](../references/limits.md) · [data](../references/data.md) · [CONTROLS](../security/CONTROLS.md) · [RISKS](../security/RISKS.md) · [PRIVACY](../security/PRIVACY.md)
