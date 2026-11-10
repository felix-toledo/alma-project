---
status: accepted
---

# Remote access: one security layer, Tailscale transport, paired phones

Continues [ADR 0020](0020-remote-access-one-security-layer-transport-strategy.md) (the strategy and the single security layer): this one records what was built on it, the Tailscale transport and the installed PWA.

Remote control of Alma from a phone browser ([spec 026](../../.specify/specs/026-remote-access/spec.md)) is one channel with one security layer (`RemoteChannel` in `src/coordinator/channels/remote/`), a transport strategy underneath (Tailscale Serve in production, an in-memory transport in tests), and a phone PWA (`src/remote-client/`) paired by QR + 6-digit code + a native PC confirmation. Everything is off by default: the feature, each of the four scopes (chat, approve, home, cameras), and the Serve itself. The phone reuses the same tools as the desktop (PD-10), so the same approvals, confirmations and audit apply; locks, alarms and gates additionally need a passkey step-up (PD-5, in-house WebAuthn).

Status is `accepted`: the channel, pairing, sessions, step-up, narrow API, PWA, PC tab and wizard are in the code and tested in `tests/remote-*.test.ts`.

## Why

The alternatives were a cloud relay (a server to operate and to trust with the house) and reusing Telegram/WhatsApp as the remote surface (chat-shaped, no house or camera UI, approvals limited to buttons). Tailscale gives an encrypted tailnet with identity per node and no open port on the PC; a PWA gives installable phone screens without an app store. One security layer keeps every check (device, scope, step-up, tailnet identity) in a single reviewable place instead of spread across routes.

## Considered options

- Cloud relay operated by Alma: not chosen; it contradicts the local-first architecture and adds a trusted third party with access to the house. *Revisited by [ADR 0022](0022-alma-e2e-relay.md) (spec 027): an opt-in relay that carries only ciphertext is planned as a third transport. It is not trusted with content, with the honest limit that the operator who serves the app shell could in principle serve a hostile one; Tailscale remains the default and this ADR's decision for it stands.*
- Telegram/WhatsApp as the only remote surface: not chosen; kept as complementary channels, but chat cannot carry house control, camera stills or full approval text.
- WebSocket instead of long-polling (PD-6): not chosen; long-poll (25 s) is enough for approvals and chat state and keeps the server a plain request handler.
- Off-the-shelf WebAuthn library instead of in-house (PD-5): not chosen; the ceremony is small (register once at pairing, assert for step-up) and a dependency here is a supply-chain risk on the authentication path.
- Push with content: not chosen (PD-15); the vendor only learns a wake-up was sent, and when.

## Consequences

- The PC must be on with Alma running; there is no offline queue beyond the cached app shell. Sessions live in memory (PD-1): a restart ends them and the phones refresh silently with their sealed refresh tokens.
- Screens exist twice (desktop renderer + PWA) with separate dictionaries; the contract in `src/shared/remote/api.ts` is the shared source both sides test against.
- The residual risks are explicit and accepted ([R-14](../security/RISKS.md)): a compromised PC confirms its own pairings, a stolen token lasts 1 hour, an unlocked phone approves until revoked.
- Renaming the PC (its Tailscale hostname) invalidates keys and passkeys: every phone pairs again.
- Revisit by: the human Tailscale tasks (S2, ACL hint) and the phone-side manual checks (S1/S3); a second transport (e.g. direct WireGuard) would only add a strategy, not touch the channel.

## Amended by spec 028 (2026-11-08)

[Spec 028](../../.specify/specs/028-remote-vault-and-threads/spec.md) extends this decision without changing its shape (one channel, one security layer, Tailscale transport, paired phones, nothing to an Alma server):

- The scopes grew from four (chat, approve, home, cameras) to six: **Notes** (read-only access to the active vault) and **History** (list and read conversations) are new, each off at every turn-on and each confirmed in a native dialog. History has a **continue conversations** sub-switch (the phone sends into a conversation and stops its own run), also off at every turn-on and confirmed natively. Notes has an **exclusion list** of vault folders, built on the PC: excluding needs no confirmation, removing an exclusion does.
- The narrow API gained eight operations (list a folder, read a note, fetch an image, filter by name, list conversations, read a conversation, send into one by id, stop a run by id); there is still no write, rename, delete or content-search route.
- The phone app now has five destinations: Chat (with a Conversations entry), Notes, Home, Cameras and Settings.
- The consequences above gain two items: vault content and conversation text now also leave the PC to the owner's own paired phone (nothing new is stored on the phone or the PC), and a stolen unlocked phone with History and the sub-switch on can start an agent run in a desktop conversation under the app's normal approval policy ([R-14](../security/RISKS.md)).
