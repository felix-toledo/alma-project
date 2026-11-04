---
status: accepted
---

# Secrets are sealed with Electron safeStorage and never written in clear

API keys and passwords are encrypted with `safeStorage` (DPAPI on Windows) before they reach `settings.json`, stored with an `enc:` prefix (`src/main/settings.ts`). There are nine secret slots (`anthropic`, `xai`, `deepseek`, `vercel`, `meta`, `openai`, `telegram`, `elevenlabs`, `email`) plus each company mailbox password. If no secure store exists, secrets are **not persisted**, unless `ALMA_ALLOW_PLAINTEXT_SECRETS=1`. The renderer receives `PublicSettings`, where keys are replaced by "is one stored". Only `main` can seal and open; the coordinator asks through the host requests `secret.seal` and `secret.open` (used for the house engine's token and password).

## Why

Documented in the constitution (Clause V: secrets only encrypted, never in logs, audit, errors, fixtures or prompts) and in [CONTROLS.md](../security/CONTROLS.md) (encrypted at rest; SOC 2 CC6.1, ISO 27001 A.8.24). Why `safeStorage` over another store: Rationale not documented.

## Considered options

Alternatives: not documented.

## Consequences

- Environment variables with the same names (for example `ANTHROPIC_API_KEY`) are read but never written. Commands the model runs (`run_command`) get an environment with the known provider keys removed (R-03).
- An encrypted value only decrypts for the same OS user and Electron profile. Copying an encrypted key to another profile also needs that profile's `Local State` (design note "companies-design").
- File mode 0600 on `settings.json`, thread and audit files has little meaning on Windows (ACLs); real protection is the user profile folder plus DPAPI.
- Not everything is covered: the WhatsApp session, conversations and the vault are plain on disk (R-04). `redact()` in the audit trail masks only some key formats.
- Code that would execute something new (a new stdio MCP server, the "Permitir todo" mode) needs a native confirmation dialog the page cannot click (`src/main/guard.ts`); the rest of settings changes go through `settings:update` without one.
- `settings.json` written by hand with a BOM is silently ignored and defaults load (design note "home-automation-design").
