---
status: proposed
---

# Remote access: one security layer, the transport is a strategy

Alma is reachable from a person's phone through a remote channel ([spec 026](../../.specify/specs/026-remote-access/spec.md)). All the security lives in one layer in `src/coordinator/channels` (device identity, scopes, step-up, limits, audit); the way the bytes travel is a strategy with one implementation per transport. 026 builds two: Tailscale (through `tailscale serve`) and a local transport that exists only in tests. The Alma-run end-to-end encrypted relay will be a third transport in a later spec (027+) and must not change the layer. Status is `proposed`: the human took these decisions in the spec 026 interview; nothing is in the code yet.

## Decision

- **Transport = strategy, one security layer.** A transport only moves bytes and carries no authority. Being on the tailnet never authenticates; every request needs a valid device. The authorization function takes no transport input.
- **The PWA is served by the PC** over Tailscale Serve HTTPS on the PC's `*.ts.net` name. Alma listens on loopback behind `tailscale serve`; it never binds all interfaces and never uses Funnel. The PWA is built without a hard-coded origin so spec 027 can reuse it.
- **Non-exportable device key.** Each phone holds a non-exportable WebCrypto key in browser storage; the PC holds only what it needs to verify it. A session lasts 1 hour and is renewed silently by signing; a device idle for 15 days pairs again. In 026 every request is authenticated with the device key (a signature per request, or a session credential issued after a signature: the plan decides and amends this ADR).
- **Passkey for step-up only.** A WebAuthn passkey assertion, verified by the PC, is required on every opening or disarming of a sensitive thing, in addition to the approval card. The passkey is not used to log in.
- **Dormant devices.** Turning remote access off keeps paired devices dormant, not forgotten; the native confirmation that turns it on again lists them. The 15-day idle clock keeps running while dormant and an expired device is removed automatically. Every turn-on starts with all scopes off.
- **Alma owns only its own Serve entry.** It picks a free local port and saves it, removes only the Serve entry it created when remote access is turned off or Alma quits, and refuses to overwrite one the person made.
- **End-to-end encryption deferred.** 026 relies on WireGuard and Serve's TLS for confidentiality and on per-request device authentication. A session-key end-to-end layer is designed with the relay (027+).
- **No Alma accounts and no Alma server in 026.** The third parties in the path are Tailscale and, for a content-free push, the browser vendors' push services.

## Why

The human wants Alma's servers never to see content on any path, one set of security rules whatever the path, and an order of work (common layer with a local transport, then Tailscale, then the relay) that validates the layer before any infrastructure exists. Serve HTTPS gives the secure context that service workers, WebCrypto keys, WebAuthn and push need, at the price of the facts below.

## Considered options

Offered in the interview and not chosen (the cost named is the one the interview recorded):

- Security per transport: rejected by the human (decision D1).
- Relay first: the human chose Tailscale first; the relay is a later spec.
- Cloudflare bring-your-own tunnel: not offered in v1 (public login URL; a third party reads the traffic).
- Listening on the Tailscale interface over plain HTTP: browsers treat an IP over HTTP as not a secure context, which blocks service workers, WebCrypto keys, WebAuthn and push (to verify).
- A self-signed TLS certificate: the phone warns and PWA install likely fails.
- An exportable device key; a device-biometric unlock only the phone checks; a PIN; a step-up time window; a fallback for phones without a passkey: not chosen.
- Forgetting paired devices when remote access is turned off: the recommendation was to forget them; the human chose dormant.

## Consequences

- Browser storage and passkeys are bound to an origin. Renaming the PC changes its `*.ts.net` name and every paired phone loses its key and passkey and must pair again (derived from browser behavior). Alma shows a notice in the wizard, detects the changed name and offers to revoke the old phones so they can pair again (spec 026 BR-38, BR-39).
- Tailscale HTTPS certificates are recorded in public Certificate Transparency logs, so the machine's name becomes public; the person must turn on MagicDNS and HTTPS in the Tailscale admin console; turning HTTPS off breaks existing links (Tailscale's "Enabling HTTPS" documentation, to re-check before relying on it).
- Authentication without end-to-end encryption means the transport's encryption is what protects content in 026; the relay cannot reuse that assumption.
- A new unauthenticated surface exists (pairing), reachable by every member of the tailnet; its limits are in spec 026 BR-21.
- A client outside `renderer` (the PWA) needs its own place in the layer rules and its own small dictionary; the plan decides and updates `docs/architecture.md` and `tests/architecture.test.ts`.
- Dormant devices persist across off and on, so the turn-on confirmation is the only moment the person sees which phones return.
- Revisit by: spec 027 (relay and the end-to-end layer), and Tailscale's terms and Serve behavior changing.
