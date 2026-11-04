# Security

## How to report a vulnerability

Write to **<security email: to be filled in>** with the subject «Alma: vulnerabilidad», without opening a public issue. Include the steps to reproduce it and the version (`package.json`).

- Acknowledgement of receipt: 2 business days.
- Assessment and plan: 7 days.
- Fix for high or critical severity: 30 days; the rest, in the next version.

## Scope

The desktop application (`src/main`, `src/preload`, `src/coordinator`, `src/renderer`), its tools and its integrations. It does not cover vulnerabilities of the third-party services Alma consumes.

## What is already in place

Map of controls against SOC 2, ISO 27001 and ISO 27701: [docs/security/CONTROLS.md](docs/security/CONTROLS.md). Open risks: [docs/security/RISKS.md](docs/security/RISKS.md). Personal data and providers: [docs/security/PRIVACY.md](docs/security/PRIVACY.md).

## If you think a key leaked

1. Revoke it in the provider's panel (Anthropic, xAI, Meta, etc.) and generate another.
2. In Alma → «Configuración → Proveedores», delete the old key and load the new one.
3. Telegram: regenerate the token with @BotFather. WhatsApp: unlink the device from the phone.
4. Review the audit trail (`%APPDATA%\Alma\audit`) from the date of the leak.
