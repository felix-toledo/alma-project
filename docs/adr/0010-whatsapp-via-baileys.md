---
status: accepted
---

# WhatsApp goes through Baileys, the unofficial protocol, on the person's own number

Alma links to the person's own WhatsApp number as one more linked device (QR scan, like WhatsApp Web) using `baileys` 6.7.24 (`src/coordinator/channels/whatsapp.ts`). The channel is deliberately narrow: Alma answers only the owner's **self chat** ("Mensajes para mí", "Messages to me"), prefixes its own messages with a robot mark, never initiates, and every `send_whatsapp` to someone else is a `publish` call that asks on every use.

## Why

Design note "integrations-design": the user chose Baileys **over the Meta Cloud API** and accepted the ban risk. The narrow design exists because this is not the official API and WhatsApp may ban numbers that behave oddly ([spec 011](../../.specify/specs/011-whatsapp/spec.md), section 2).

## Considered options

- **Meta Cloud API** (official): rejected by the user in favor of Baileys; the reason beyond that is Rationale not documented.
- Evaluating the official WhatsApp Business API if Alma is ever used with clients: suggested in R-05 of [RIESGOS.md](../security/RIESGOS.md).

## Consequences

- Risk R-05 (accepted): can violate WhatsApp's terms and get the number suspended; updates come outside official channels.
- Baileys pulls `libsignal` from git. That makes pnpm fail with `ERR_PNPM_EXOTIC_SUBDEP` when re-resolving the tree, and blocks the dependency upgrades of R-01 ([ADR 0014](0014-pnpm-as-package-manager.md)).
- The session lives as plain files in `<dataDir>/whatsapp-auth` (a company's: `whatsapp-auth-<companyId>`), not encrypted (R-04).
- `whatsapp_recent` shows received messages, groups included, to the model with no approval; they are untrusted input (prompt injection) and go to the model provider. Received messages are kept in memory only (at most 300).
- No rate limit or contact allow-list on `send_whatsapp`; only the per-message approval guards it.
- Only one pending approval is tracked per chat, and "Siempre" is not offered there.
