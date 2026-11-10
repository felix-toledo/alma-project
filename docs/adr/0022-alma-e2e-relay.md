---
status: proposed
---

# Remote access: an Alma-run relay as a third transport, with an end-to-end layer

A paired phone can reach Alma through a relay that the project maintainer operates, as a third transport for the remote channel ([spec 027](../../.specify/specs/027-alma-e2e-relay/spec.md)), chosen instead of Tailscale and never together with it. The relay forwards sealed frames and keeps nothing; every request and answer is encrypted end to end between the phone and the PC by a session built in the relay transport pair, so the security layer of [ADR 0020](0020-remote-access-one-security-layer-transport-strategy.md) is not touched. Status is `proposed`: the decision, the plan and the code are written and tested in the repository (the relay transport, the end-to-end layer, the phone client and the relay server with its Cloudflare adapter), but nothing is deployed and the platform facts (spikes V2, V3, V5, V8, V9) and the real-phone walks are still to be verified by the maintainer; it becomes `accepted` when they are.

## Decision

- **A transport, not a new layer.** `RelayTransport` implements `RemoteTransport`. The channel, `authorize()`, the route table and the Zod schemas of `src/shared/remote/api.ts` do not change; a source scan with a negative fixture and the 026 suites re-run over the relay pair prove it. The end-to-end layer belongs to the relay pair; the Tailscale path does not use it.
- **One transport at a time, opt-in.** A selector chooses Tailscale (the default) or the relay. No composite and no automatic fallback. Choosing the relay has its own switch and native confirmation, kept across turn-ons; every scope still starts off.
- **The relay sees ciphertext and keeps nothing.** Cloudflare Workers with one Durable Object per routing id, WebSocket Hibernation for the PC's outbound socket, Workers Static Assets for the shell. No accounts: the routing id is 128 random bits and the PC registers it by signing a challenge with its identity key. It buffers nothing, logs no address, id or payload, writes to no storage, and has no outbound feature. Limits and quotas are tunable defaults, with a pause switch.
- **WebCrypto only, no new dependency.** Ephemeral ECDH on P-256, HKDF-SHA-256, AES-256-GCM with counter nonces, ES256. Ephemeral keys on both sides (forward secrecy), the PC's signature over the transcript checked by the phone against the fingerprint in the QR, the device's signature after pairing, a 64-wide replay window, one hour per session, any tampering ends the session.
- **One origin per PC.** `https://<routing id>.<relay domain>` under a wildcard certificate; device keys and passkeys are bound to it; a changed relay domain is handled like a PC rename; a phone paired over Tailscale pairs again.
- **Operator.** The maintainer, personally, on voluntary donations, no paid tier. Provisional exit rule (the maintainer confirms): the relay ends if the monthly cost exceeds a stated ceiling for 3 consecutive months or the maintainer can no longer run it, with 60 days of notice and a final app release that reports the relay as gone and leaves Tailscale untouched.
- **A sixth architecture zone**, `src/relay/`, importing only itself and the frame contract in `src/shared/remote/`, excluded from the installer.

## Why

Tailscale asks for an account, an app on both devices, HTTPS in an admin console and a public certificate name; that excludes many people. A relay removes all of that, and ADR 0021 rejected a cloud relay only because it "adds a trusted third party with access to the house". Sealing the traffic end to end between the phone and the PC removes the need to trust the relay with content, and a transport that carries ciphertext is exactly the swappable piece ADR 0020 designed for.

## Considered options

- **No relay (stay on Tailscale only):** the safest and the cheapest, and the option ADR 0021 took. Kept as the default and as the fallback the person can always select.
- **A Node server on a VPS:** needs a `ws` dependency, patching and an always-on machine for a service that must keep nothing. Not chosen.
- **Both transports at once, or an automatic fallback:** the channel derives its expected host from one address, so two hosts need a channel change, and an automatic fallback sends traffic to a third party without a decision by the person. Not chosen.
- **Mixing the pairing secret into the key derivation and covering the transcript with the 6 digits:** the digits are computed by the channel from inputs it generates, so this needs a channel change. Replaced by checking the PC's signed transcript against the QR fingerprint, which the relay never carries. If the literal behavior is wanted later it is an additive hook in the pairing flow and an amendment of the constraint that the channel stays unchanged.
- **Shell served only by the PC over Tailscale, then the relay from that same origin:** the strict alternative for the shell problem below; not chosen because a relay-only person would still need Tailscale once.
- **A routing id bound to the PC's key with a stored record:** keeps a record for 30 days; contradicts "nothing kept". Not chosen (provisional).

## Consequences

- **The honest limit of the claim.** A web app cannot prove its own code. The relay serves the PWA shell, so an operator who deliberately serves a hostile shell or service worker to one person can read that person's traffic, at the first install, at any service-worker update and at any fresh load (a cleared site; iOS may evict browser storage). End-to-end encryption protects against a passive operator, a leaked relay, a network observer and a hosting account that only copies traffic; it does not protect against that operator. The planned gate (the PC announces the official shell hash, signed by its identity key, and the app refuses a version it did not announce) and the published hash catch a stale, wrong or partly tampered deployment and make a lie comparable; they do not stop a deliberate swap of the service worker, which the origin can always replace. ADR 0021's objection is therefore answered only to this extent; here the operator is the maintainer personally and the code is open, a mitigation by trust and not a technical one.
- **Known residuals, accepted and in R-14.** A stranger who learns a routing id can lock pairing for 5 minutes (no access); an observer on the phone's network path sees the routing id in DNS and TLS; after a relay restart the first valid claimant of an id wins until the real PC registers again (a denial of service; one-line mitigation: the id commits to the PC's public key); sizes, timing and online state are visible to the relay and there is no padding.
- A new third party (the maintainer as operator, Cloudflare as host) appears in `docs/security/PRIVACY.md`; Cloudflare's own logs are outside the relay's code and are minimized and disclosed.
- Lock-in to Cloudflare Workers and Durable Objects for the relay; the logic is platform-free (`RelayRoom`) and the adapter is thin, so a move is a rewrite of the adapter, not of the protocol. Facts the plan relies on (hibernation, message and billing limits, free-plan SQLite requirement, wildcard certificate behavior) are to be re-verified before the first deploy.
- Runtime outages of the relay cannot use the channel's `reportOutage`, which is Tailscale-specific; the relay state is overlaid on the status at the composition root. A generic `reportOutage(cause)` on the channel would be cleaner and is a channel change left out on purpose.
- Revisit by: the deploy and the real-device walks (spec 027 tasks H2 and H3), Cloudflare's terms and limits changing, a browser dropping a primitive, and the human's confirmation of the provisional answers (routing-id binding, exit rule) and of the plan-stage corrections.
