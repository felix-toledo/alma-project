# 026 — Plan

<!-- Written once spec.md was `ready` (2026-11-06). Contracts and signatures, never logic. Read spec.md first: this plan cites its ids (BR-n, AC-n.m, OQ-n) and does not restate them. -->

## 1. Approach
One security layer, `RemoteChannel`, lives in `src/coordinator/channels/remote/` and is the only thing that knows devices, scopes, step-up, limits and audit. It is a plain request handler (`RemoteRequest -> RemoteResponse`); a `RemoteTransport` only starts and stops something that feeds it requests. The product ships one transport, `TailscaleTransport` (a `node:http` server on 127.0.0.1 behind `tailscale serve`); the transport used by tests is an in-process one that lives under `tests/support/`, not in `src/`, so a shipped build cannot select it (BR-2, AC-3.7). Pure decisions (route table, authorization, step-up direction, pairing state machine, confirmations required, `tailscale serve` command, WebAuthn verification) live in `src/shared/remote/` and are tested alone (Constitution IV). The phone client is a small React PWA in its own top-level folder `src/remote-client/`, built by its own Vite config and served by the coordinator from `out/remote/` (BR-18). The alternative rejected for the layer question is putting the PWA under `src/renderer/` (it would inherit the desktop CSP, preload and i18n and could import desktop code); see ADR [0020](../../../docs/adr/0020-remote-access-one-security-layer-transport-strategy.md).

### 1.1 Plan-level decisions (the spec left these to the plan)
| # | Decision | Why |
|---|---|---|
| PD-1 | **BR-23: a session credential, not a signature per request.** The device proves its key once (`POST /api/session/challenge`, then `POST /api/session` with an ES256 signature over a single-use nonce) and gets an opaque random bearer token, kept in memory on both sides, valid 1 hour (BR-22) and renewed silently by signing again. Every request carries the token and is checked against the device record, so revocation is immediate (delete the device's tokens and close its sockets, AC-6.2). To be recorded in ADR 0020 as an amendment (task T47). | A signature per request needs canonical request bytes, a nonce store and clock rules for no gain over TLS plus a 1-hour in-memory token; revocation by deleting tokens is simpler and exact. Cost: a stolen token is good for up to 1 hour; the token never reaches storage (BR-32). |
| PD-2 | **Recommended ACL wording is a UI-copy task (T38), not text in this plan.** The key `remote.wizard.acl.hint` already has an initial wording in the spec; the final text, and whether it includes an ACL snippet, is checked against Tailscale's current documentation in spike S2 and approved by the human with the rest of the wizard copy. | The exact policy syntax is third-party and unverified; a wrong snippet would be a false security claim. |
| PD-3 | **After "pick another port" the earlier Serve entry is replaced, not removed first.** `tailscale serve` on the same path replaces the target; Alma recognizes its own entry by the target `http://127.0.0.1:<port saved before>` and refuses any other (AC-2.12, AC-2.13). The confirmation of AC-2.16 shows the one new command. If spike S2 shows that a same-path `serve` does not replace, the confirmation shows both commands (remove the old own entry, then add) and AC-2.16 is read that way. | Honors "Alma changes nothing on its own": a single confirmed command does the whole change. |
| PD-4 | **The PWA sits in `src/remote-client/`** and is a fifth zone for `tests/support/arch.ts` (section 2.1). It may import only itself and `src/shared/remote/`; nothing may import it; `src/shared/remote/` may not import node-only modules. Built with `vite.remote.config.ts` (root `src/remote-client`, `base: './'`, output `out/remote`), typechecked with a new `tsconfig.remote.json`, served by the coordinator from `join(__dirname, '../remote')` (the coordinator bundle is `out/main/coordinator.js`). | Smallest change that keeps the layer rules mechanical. Packaging into the final installer is spec 001's job; this path works unpacked and in `asar` (Electron patches `fs` in utility processes). |
| PD-5 | **WebAuthn verification is in-house and minimal; no new dependency.** Attestation `none` only, ES256 (alg -7) only, `userVerification: 'required'`, one tiny CBOR reader for the attestation object. The browser side uses `navigator.credentials` directly. | R-01 says do not make the dependency tree worse (`@simplewebauthn/server` pulls CBOR/ASN.1/X.509 packages for features this spec does not use). Cost: security-sensitive parsing is ours, so T17 requires adversarial tests and a software authenticator in `tests/support/`. Revisit if attestation formats are ever needed. |
| PD-6 | **API style: JSON over plain HTTP request/response with long-polling; no WebSocket and no SSE.** `GET /api/state?since=<rev>` holds up to 25 seconds (under the 30 s timeout, BR-31) and returns when something changed. | No dependency (`ws`), works unchanged over any future transport (the relay), and one open request per phone leaves the second connection free (BR-31). |
| PD-7 | **Pairing code (the 6 digits both screens show):** `code = HMAC-SHA256(secret, phonePublicKey || pcNonce)` truncated to 6 decimal digits, computed independently on the PC and on the phone, so a substituted key shows different digits (a short-authentication-string design). The QR is `https://<host>.ts.net/#p=<secret>&f=<fingerprint>`; the fingerprint is SHA-256 of the PC identity public key. | Meets BR-21 (secret in the fragment, fingerprint, compare-on-both-screens). Honest limit: the PWA code comes from the same host the fingerprint names, so the fingerprint defends against a mistaken or substituted host name, not against a malicious PC (R-14 notes it). |
| PD-8 | **Host check.** The handler rejects any request whose `Host` is not the PC's recorded `*.ts.net` name (tests: the fixed test host), and any with an `Origin` that is not the same origin. | Loopback is reachable by any local web page; this keeps DNS-rebinding and cross-site calls out, on top of the credential every route needs (AC-3.3). |
| PD-9 | **Where each concern runs.** Settings and every native dialog the settings flow needs: `main` (`settings:update`, pure decisions from `shared`). Device records, pairing, sessions, push, Tailscale CLI calls and the listener: `coordinator`. Dialogs the coordinator needs (pairing approval, `tailscale serve`, revoke all, opening the download or the terms link) are `HostRequest`s answered by `main`; the URL for "open" is chosen by `main` from a fixed id, never sent by the coordinator. Remote-access keys are removed from every `settings.patch` the coordinator sends (AC-1.5). Coordinator-owned state (thread id, port, host name, PC identity key, push keys) is not in `settings.json`; it is in `<dataDir>/remote/` (section 4). | The coordinator cannot write the protected settings (BR-11), yet needs a thread id and a port; its own folder avoids a second settings channel. |
| PD-10 | **Direct tool calls reuse the agent's authorization and trail.** The phone's house control and camera pictures call `authorize()` of `approval.ts` with the real tool name and `ToolRisk` (`home_control`: `home`; `home_secure_control`: `publish`; camera pictures: `write` under the tool name `camera_look`, so the person's "Siempre permitir" rule for that tool applies as AC-5.19 says), then run the tool definition's `run`. The tool entry in the audit trail is the existing one (`actor: 'agent'`, `detail.agent` = the agent chosen for the remote thread, `detail.thread` = the remote thread), written by a helper extracted from `agent.ts` (T22) so both paths share it, plus the `remote` entry of AC-7.1 (AC-7.7), which records the origin. | "As today" (OQ-14): no new actor; the spec 004 AC-9.1 contract is untouched. Accepted by the human (P-6a). |
| PD-11 | **Camera stills are returned straight from `hub.cameraSnapshot` (a `Buffer`) and never written.** A test spies on `fs` while the handler runs (AC-5.11). Reading `hub.ts` shows `cameraSnapshot` returns the bytes of the Home Assistant proxy and does not save them; the only saving paths are `saveStill` in `camera_look` and `camera_photo`, which the phone path does not call. | Verifies "NOT saved to the PC inbox" without a spike. |
| PD-12 | **The phone sees the remote conversation as committed text only: the question, the answer and the pending approvals of that thread.** Never a streaming draft (AC-8.4) and never tool activity: tool-use and tool-result blocks and tool names are stripped, and a message left with no text is omitted. On opening, it loads the **last 30** such messages (P-2); later calls return only messages newer than the cursor. The 1 MB response cap (BR-31) still applies: if the 30 do not fit, the oldest are dropped until they do, and a single message larger than the cap is cut to fit (an implementation detail, no user-visible rule). | Keeps the API narrow (BR-7) and limits how much conversation content leaves the PC at once. |
| PD-13 | **Internet check for the wizard test** is a `HostRequest` `net.online`, answered by `main` with Electron `net.isOnline()` (the OS says a network is up; no traffic is sent, no third-party host is probed). Accepted by the human (P-5). Limit, written in section 7: behind a captive portal or a dead uplink the flag can still say "online", so `noInternet` is raised only when the OS itself reports no network; other failures surface later as `tailscaleDown`. | AC-2.4 asks for "the PC's internet" without naming a probe; a probe means an outbound connection to some host. |
| PD-14 | **QR image:** the coordinator renders the pairing URL to a PNG data URL with the existing `qrcode` dependency (as WhatsApp does) and sends it to the window in the `remote.pairing` event. | No new dependency. |
| PD-15 | **Push without library.** No payload is sent (a zero-length body), so no payload encryption is needed; only the VAPID `Authorization` JWT (ES256 over WebCrypto). The endpoint a phone supplies is checked before use: `https:`, not private (`isPrivateHost` of `tools/web.ts`), host in a short list of known push services (`fcm.googleapis.com`, `*.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`). The service worker shows the fixed text from the PWA dictionary. | BR-27 with the fewest moving parts; the allow-list stops a paired phone from making the PC call arbitrary URLs (SSRF). The list was accepted by the human (P-6b). |
| PD-17 | **The tray icon exists while remote access is on, even when "keep running in the tray" is off (P-1).** The rule in `applyBackgroundSettings` becomes: an icon exists if and only if `background.runInTray || remote.enabled`. With remote on and tray mode off, the icon only offers the existing items (open, quit) plus `tray.remote.off`; closing the window still quits Alma as it does today (BR-33: tray mode is not forced), and quitting removes the icon and stops the channel. When remote access turns off (switch or the tray item) and tray mode is also off, the icon is destroyed at once, exactly as it is today when tray mode is turned off. With tray mode on, the icon is unchanged and the item is shown only while remote is on. | Guarantees the one-click kill switch of AC-1.13 and BR-36 in every configuration without changing what closing the window does. The change to the tray rule is recorded as a spec amendment in T48. |
| PD-16 | **Single-use challenges** for step-up and sessions expire after 60 seconds; the tailscale monitor polls every 30 seconds; the idle-expiry sweep runs at start and hourly. These are implementation parameters with no user-visible rule. | Needed numbers the spec does not state; none changes behavior the person can see. |

## 2. Layers touched
| Layer | Files (new / changed) | Why it lives there |
|---|---|---|
| shared | new `src/shared/remote/{api,authorize,confirmations,crypto,pairing,webauthn,tailscale,push,settings,view}.ts`; changed `types.ts` (`RemoteSettings`, `Settings.remote`, `ThreadChannel` + `'remote'`, requests/events, `HostRequest`/`CoordinatorToParent` additions), `defaults.ts`; new `i18n/{es,en}/remote.ts` + index lines in `i18n/es.ts`, `i18n/en.ts` | pure logic and types used by `main`, `coordinator`, the window and the PWA |
| coordinator | new `src/coordinator/channels/remote/{channel,transport,tailscale-transport,tailscale,store,session,limits,pairing-flow,chat,approvals,home,cameras,push,audit,monitor}.ts`; new `src/coordinator/tool-trail.ts`; changed `agent.ts` (use the trail helper; `CHANNEL_GUIDES.remote`), `index.ts` (wiring, requests, host plumbing), `privacy.ts` (erase/export), `store.ts` only if `ThreadChannel` needs it | everything that does I/O for the feature; `electron` stays out |
| main | changed `index.ts` (`settings:update` dialogs, `settings.patch` strip, host requests, tray item), `messages.ts` (dialog and tray texts), `settings.ts` (merge `remote`) | native dialogs, settings, tray |
| renderer | new `src/renderer/src/remote/{RemoteSettings.tsx,useRemote.ts,remote.css}`; changed `SettingsDialog.tsx` (one tab), `Sidebar.tsx` (remote channel icon), `lib/state.ts` if events need folding | the Remote access tab and wizard |
| remote-client (new zone) | new `src/remote-client/**` (React app, `lib/` pure logic, own `i18n/`, `public/sw.js`, `manifest.webmanifest`), `vite.remote.config.ts`, `tsconfig.remote.json`; `package.json` scripts | the phone PWA |
| tests / docs | new `tests/remote-*.test.ts`, `tests/support/{remote-local-transport,webauthn-fake}.ts`; changed `tests/support/{arch,i18n}.ts`, `tests/architecture.test.ts`; docs in section 7 | gates |

### 2.1 Architecture rules (`tests/support/arch.ts` `RULES`, each with a negative fixture in `tests/architecture.test.ts`)
Existing rules stay. Add:
1. The `shared` rule's forbidden set gains `remote-client` (shared is a leaf).
2. **The phone client sees only itself and the remote contracts:** from `^src/remote-client/`, forbid `^(src/(?!remote-client/|shared/remote/)|node:|electron$)`. (So it cannot import `shared/audit`, `shared/types`, the dictionaries, `main`, `coordinator` or `renderer`; bare package names such as `react` and `lucide-react` pass.)
3. **Nobody imports the phone client:** from `^src/(?!remote-client/)`, forbid `^src/remote-client/`.
4. **The contracts stay browser-safe:** from `^src/shared/remote/`, forbid `^(node:|electron$|src/shared/audit(\.|$))`. (The code there uses the global `crypto.subtle`, present in Node and browsers.)
`readSources` already reads every `.ts`/`.tsx` under `src`, so the new folder is checked without more code. `tests/support/i18n.ts` (hardcoded-text ratchet) must scan `src/remote-client` and exempt only `src/remote-client/i18n/es.ts` by location with a stated reason, like the existing exemptions there.

## 3. Contracts
Signatures only. Zod is `zod/v4`, as in the rest of the code.

```ts
// src/shared/types.ts (additions)
export type RemoteScope = 'chat' | 'approve' | 'home' | 'cameras'
export interface RemoteSettings {
  enabled: boolean
  /** Only 'tailscale' is valid; the test transport is not a setting (AC-3.7). */
  transport: 'tailscale'
  scopes: Record<RemoteScope, boolean>
  /** The locks-and-alarms sub-switch under home automation. */
  sensitive: boolean
  /** Camera entity ids the phone may see (allow-list, persists across turn-ons). */
  cameras: string[]
  /** Agent that answers the remote thread. */
  agentId: string
}
// Settings.remote: RemoteSettings; ThreadChannel gains 'remote'.
export type RemoteFailure = 'noInternet' | 'tailscaleDown' | 'httpsOff' | 'listener' | 'phoneSilent' | 'portTaken' | 'serveBusy'
export interface RemoteStatus { state: 'off' | 'connecting' | 'online' | 'error'; address?: string; failure?: RemoteFailure; detail?: string; keyExpiresInDays?: number; renamed?: boolean }
export interface DeviceView { id: string; name: string; pairedAt: number; lastSeen: number | null; dormant: boolean }
export interface PairingView { stage: 'offer' | 'request' | 'locked'; qrDataUrl?: string; expiresAt?: number; code?: string; lockedUntil?: number }
export interface ActivityRow { at: number; deviceId: string | null; deviceName: string | null; action: string; outcome: 'ok' | 'denied' | 'error' }
// RequestEnvelope methods (window -> coordinator): remote.status | remote.devices | remote.pair.start | remote.pair.cancel
//   | remote.pair.approve {name} | remote.pair.reject | remote.revoke {deviceId} | remote.revokeAll | remote.test {deviceId?}
//   | remote.detect | remote.serve | remote.pickPort | remote.activity
// LiveEvents: remote.status {status} | remote.pairing {pairing: PairingView | null} | remote.devices {devices: DeviceView[]}
// CoordinatorToParent: { type: 'remote.devices'; names: string[] }   // dormant-device names for the turn-on dialog
// HostRequest: { action: 'remote.confirm'; kind: 'pair' | 'serve' | 'revokeAll'; params: Record<string, string> }
//            | { action: 'remote.open'; target: 'tailscale-download' | 'tailscale-terms' } | { action: 'net.online' }
```

```ts
// src/shared/remote/api.ts
export const REMOTE_LIMITS: { requestBytes: 1_048_576; photoBytes: 2_097_152; chatChars: 8000; requestsPerMinute: 60; connectionsPerDevice: 2; timeoutMs: 30_000; testWaitMs: 10_000; pairingPerMinute: 5; approvalInputChars: 1500; longPollMs: 25_000; firstLoadMessages: 30 }
export interface RouteSpec { method: 'GET' | 'POST' | 'DELETE'; path: string; auth: 'none' | 'pairing' | 'session'; scope?: RemoteScope; audit: 'none' | 'change' | 'picture'; body?: z.ZodType; sensitive?: true }
export const ROUTES: readonly RouteSpec[]            // the closed list of BR-7; a snapshot test pins it (AC-3.6)
export interface RemoteRequest { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown; remoteAddress: string }   // the address is for logs only; no function reads it to decide
export interface RemoteResponse { status: number; headers?: Record<string, string>; body?: unknown | Buffer }
export type RemoteHandler = (request: RemoteRequest, signal: AbortSignal) => Promise<RemoteResponse>
export type Refusal = 'unknown-device' | 'scope-off' | 'sensitive-off' | 'step-up-required' | 'camera-not-allowed' | 'rate-limited' | 'invalid' | 'too-large' | 'unknown-route' | 'already-answered' | 'locked' | 'expired' | 'busy' | 'limit'
```

```ts
// src/shared/remote/authorize.ts
export interface DeviceAuth { deviceId: string }
export function authorizeRemote(input: { device: DeviceAuth | null; remote: RemoteSettings; route: RouteSpec; cameraId?: string }): { ok: true } | { ok: false; reason: Refusal }
export type SecureAction = 'lock' | 'unlock' | 'open' | 'close' | 'arm_home' | 'arm_away' | 'disarm' | 'trigger'   // the enum of home_secure_control
export function stepUpRequired(action: SecureAction): boolean          // unlock, open, disarm only (AC-5.20)
```

```ts
// src/shared/remote/confirmations.ts
export type RemoteConfirmation = { kind: 'enable'; dormant: string[] } | { kind: 'scope'; scope: RemoteScope } | { kind: 'sensitive' } | { kind: 'camera'; cameraId: string }
export function planRemoteChange(before: RemoteSettings, after: RemoteSettings, dormantNames: string[]): { confirmations: RemoteConfirmation[]; next: RemoteSettings }   // `next` has all scopes off on a turn-on (AC-1.12)
export function runConfirmations(list: RemoteConfirmation[], ask: (c: RemoteConfirmation) => boolean): 'ok' | 'denied'
export function stripRemotePatch<T extends object>(patch: T): Omit<T, 'remote'>   // AC-1.5
```

```ts
// src/shared/remote/crypto.ts  (WebCrypto only)
export const b64u: { encode(bytes: Uint8Array): string; decode(text: string): Uint8Array }
export function fingerprint(publicKey: JsonWebKey): Promise<string>
export function verifyEs256(publicKey: JsonWebKey, data: Uint8Array, signature: Uint8Array): Promise<boolean>
// src/shared/remote/pairing.ts
export interface PairingState { /* offer, pending request, bad-secret count, lockedUntil; immutable */ }
export function newOffer(now: number, random: () => Uint8Array): { state: PairingState; secret: string }
export function present(state: PairingState, secret: string, phonePublicKey: JsonWebKey, now: number, random: () => Uint8Array): { state: PairingState; result: 'pending' | 'expired' | 'locked' | 'busy' | 'rate-limited'; pcNonce?: string }
export function pairingCode(secret: string, phonePublicKey: JsonWebKey, pcNonce: string): Promise<string>   // 6 digits
export function decide(state: PairingState, approved: boolean): PairingState
// src/shared/remote/webauthn.ts
export function parseRegistration(response: { clientDataJSON: string; attestationObject: string }, expected: { challenge: string; origin: string; rpId: string }): { ok: true; credentialId: string; publicKey: JsonWebKey } | { ok: false; reason: string }
export function verifyAssertion(response: { clientDataJSON: string; authenticatorData: string; signature: string }, expected: { challenge: string; origin: string; rpId: string; publicKey: JsonWebKey; lastCounter: number }): Promise<{ ok: true; counter: number } | { ok: false; reason: string }>
// src/shared/remote/tailscale.ts
export type TailscaleState = { kind: 'missing' } | { kind: 'disconnected' } | { kind: 'connected'; dnsName: string; keyExpiry: number | null; magicDns: boolean }
export function parseStatus(json: unknown): TailscaleState
export function serveCommand(port: number): { file: 'tailscale'; args: string[]; display: string }   // always `serve`, never `funnel`
export type ServeOwner = 'none' | 'mine' | 'other'
export function serveOwner(status: unknown, myPort: number | null): ServeOwner
export function daysToExpiry(keyExpiry: number | null, now: number): number | null
// src/shared/remote/push.ts
export function buildVapid(endpoint: string, subject: string, publicKey: JsonWebKey, privateKey: JsonWebKey, now: number): Promise<{ authorization: string }>
export function allowedPushEndpoint(endpoint: string): boolean
// src/shared/remote/view.ts  (PC tab logic)
export function wizardStep(input: { tailscale: TailscaleState; status: RemoteStatus; devices: number }): 'tailscale' | 'download' | 'https' | 'serve' | 'test' | 'pair' | 'ready'
export function failureKey(failure: RemoteFailure): MessageKey
```

```ts
// src/coordinator/channels/remote/transport.ts
export interface RemoteTransport {
  readonly id: 'tailscale' | 'test'
  start(handler: RemoteHandler): Promise<{ address: string }>   // rejects with a RemoteFailure-carrying error
  stop(): Promise<void>
  /** Connections of one device, so revocation can cut them at once. */
  closeDevice(deviceId: string): void
}
// src/coordinator/channels/remote/channel.ts
export interface RemoteDeps {
  settings(): Settings
  now(): number
  random(length: number): Uint8Array
  store: DeviceStore
  transport(): RemoteTransport                      // production: TailscaleTransport; tests: the local one
  onStatus(status: RemoteStatus): void
  onPairing(view: PairingView | null): void
  onDevices(devices: DeviceView[]): void
  host: { confirm(kind: 'pair' | 'serve' | 'revokeAll', params: Record<string, string>): Promise<boolean> }
  conversation(fresh?: boolean): Thread               // the remote thread (its id lives in <dataDir>/remote/state.json)
  ask(threadId: string, text: string): Promise<void>
  cancel(threadId: string): void
  onEvent(listener: (event: LiveEvent) => void): () => void
  respondApproval(approvalId: string, decision: 'allow' | 'deny'): void   // 'always' cannot be expressed
  pendingApprovals(): PendingApproval[]
  direct: DirectTools                                 // house control and camera stills through authorize() (T23, T24)
  record(entry: AuditEvent): void                     // production: audit() of src/shared/audit.ts
  notify(title: string, body: string): void
}
export class RemoteChannel { constructor(deps: RemoteDeps); sync(): Promise<void>; handle: RemoteHandler; stop(): Promise<void>; currentStatus(): RemoteStatus /* + the methods behind the window requests */ }
```

Narrow API routes (the `ROUTES` table; `auth`, scope and audit class in brackets). All JSON; limits of `REMOTE_LIMITS` apply to all.
- `GET /api/hello` [none]: PC public key, fingerprint, a nonce and a signature over it.
- `POST /api/pair/request` [pairing; audit change]: secret, phone public key; returns the PC nonce. `GET /api/pair/status` [pairing]: pending/approved/rejected/expired/locked. `POST /api/pair/passkey` [pairing; audit change]: the registration response (AC-4.13).
- `POST /api/session/challenge` [none], `POST /api/session` [none]: PD-1.
- `GET /api/state?since=` [session; chat or approve]: without `since`, the last `REMOTE_LIMITS.firstLoadMessages` (30) committed messages of the remote thread; with it, only messages newer than the cursor. Response shape: `{ rev: number; running: boolean; messages: { index: number; role: 'user' | 'assistant'; text: string; at: number }[]; approvals: ApprovalView[]; ping?: string }`. Text only: no tool names, tool results or tool cards (PD-12). `ApprovalView` carries only what the Telegram surface shows.
- `POST /api/chat/send` [chat; change], `POST /api/chat/new` [chat; change], `POST /api/chat/stop` [chat; change].
- `GET /api/approvals` [approve], `POST /api/approvals/answer` [approve; change]: decision is `allow` or `deny` only.
- `GET /api/home/things` [home], `POST /api/stepup/challenge` [home; sensitive], `POST /api/home/control` [home; change; sensitive actions carry the assertion].
- `GET /api/cameras` [cameras], `GET /api/cameras/still?id=` [cameras; picture].
- `GET /api/push/key` [session], `POST /api/push/subscribe` [session], `DELETE /api/push` [session].
- `POST /api/pong` [session] (answer to a test ping), `POST /api/forget` [session; change] (AC-6.10), `GET /api/status` [session].
- Static: `GET /`, `/assets/*`, `/sw.js`, `/manifest.webmanifest` [none; files from `out/remote`, path-traversal checked].

## 4. Data and persistence
| What | Where | Notes |
|---|---|---|
| `settings.remote` (`RemoteSettings`) | `settings.json` via `main/settings.ts` | merged over the default like the other sections (`remote: { ...base.remote, ...sanitizeRemote(stored.remote) }`); default: off, all scopes off, `sensitive` false, no cameras, `agentId` the default agent; unknown `transport` values are dropped to `'tailscale'`. No secret here. Settings from older versions simply lack the section. |
| Devices | `<dataDir>/remote/devices.json`, atomic `.tmp` + rename, mode 0600 | per device: `id`, `name`, `pairedAt`, `lastSeen`, `publicKey` (JWK), `passkey` (credential id, public JWK, counter) or null, `push` (subscription, sealed). Public keys are not secrets; the push subscription is sealed with `secret.seal`. Revoking deletes the record (no tombstone: refusal is uniform, BR-22). |
| Coordinator state | `<dataDir>/remote/state.json` | `threadId` of the remote thread, `port`, `hostName` (the `*.ts.net` name devices were paired under, for rename detection), `pcKey` (identity key pair; private part sealed), `vapid` (key pair; private part sealed). |
| Sessions, pairing offer, step-up challenges, rate counters | memory only | lost on restart; the phone signs again silently (PD-1). |
| Audit | `<dataDir>/audit/coordinator-*.jsonl` | `actor: 'remote'` entries and the `system` entry for idle expiry; `main-*.jsonl` carries the settings and dialog denials. |
| PWA files | `out/remote/` (build output) | not user data. |
| Privacy | `privacy.ts` | erase: revoke all devices, delete `devices.json` and push subscriptions (`state.json` keys are kept, they are not personal data); export: a `remote-devices.json` with names and dates only (AC-9.5). |

Migration: none; nothing existed before. Files written by the previous version are untouched.

## 5. Dependency injection
- `RemoteChannel` gets everything through `RemoteDeps` (section 3). Tests fake `settings`, `now`, `random`, `host.confirm`, `conversation`/`ask`, the approval functions, the audit sink and the transport.
- `TailscaleController` gets `exec(file, args)`, `confirm`, `openExternal(target)`, `online()`, `pickPort()`, `store` and `now`. Tests give it recorded outputs from spike S2.
- `TailscaleTransport` gets the port, the assets directory and `fs`/`http` factories; its loopback test uses real `node:http` on an ephemeral 127.0.0.1 port.
- `DirectTools` (home control, camera stills) gets the `HomeService`, `authorize`, a `ToolContext` factory and the audit helper; tests fake the hub (the pattern of `tests/home.test.ts`).
- The PWA's `lib/` takes `storage`, `fetch` and `clock` as arguments; `crypto.subtle` is the global.
- `main`: the dialog functions take `showBox(options) => number` so the decisions around them are tested without Electron.

## 6. Test strategy
Every AC has a row. `[manual]` ones are checked by hand after implementation (section in `tasks.md`, T49). "Fake" means a double from `tests/support/`. New helpers: `remote-local-transport.ts` (in-process `RemoteTransport` that calls the handler with chosen headers and `remoteAddress`) and `webauthn-fake.ts` (a software authenticator that makes registrations and assertions).

| AC | Test file → name | Adversarial cases |
|---|---|---|
| 1.1 | `tests/remote-settings.test.ts` → `AC-1.1 a fresh install has remote access off and starts nothing` | settings with no `remote`; `remote: null`; a malformed section |
| 1.2 | `remote-settings` → `AC-1.2 turning on asks one confirmation that names the dormant devices` and `tests/remote-main.test.ts` → `AC-1.2 the dialog has the title, the text and Cancel as the default` | no dormant devices; already on; the patch changes other keys only |
| 1.3 | [manual] | |
| 1.4 | `remote-settings` → `AC-1.4 a cancelled confirmation changes nothing and reports the cancellation` | cancel on the second of two confirmations |
| 1.5 | `remote-settings` → `AC-1.5 a settings patch from the coordinator never carries remote keys` | nested key; `remote` alone; unrelated keys kept |
| 1.6 | `tests/remote-tools.test.ts` → `AC-1.6 no tool reads or changes remote access` | scans the registry of every configuration (company, no workspace, home on/off) and MCP names |
| 1.7 | `tests/remote-channel.test.ts` → `AC-1.7 turning remote off stops the listener, cuts connections and keeps devices dormant` | off while a long-poll is held; off twice |
| 1.8 | `remote-channel` → `AC-1.8 a restart starts the channel again without a confirmation, and nothing starts when it was off` | |
| 1.9 | `remote-settings` → `AC-1.9 turning a scope on asks, turning it off does not` | all four scopes; two scopes at once |
| 1.10 | `remote-settings` → `AC-1.10 locks and alarms ask when turned on` | turning off; on while home scope off |
| 1.11 | `remote-settings` → `AC-1.11 dormant device names are listed in the turn-on dialog` | 0, 1, 5 names; names with odd characters |
| 1.12 | `remote-settings` → `AC-1.12 every turn-on starts with all scopes and locks off and keeps the camera list` | first time and later times |
| 1.13 | `remote-main` → `AC-1.13 the tray offers turning remote off only while it is on` and `AC-1.13 the tray icon exists while remote is on even with tray mode off, and is gone when both are off` | all four combinations of `runInTray` × `remote.enabled` |
| 1.14 | [manual] | |
| 2.1 | `tests/remote-tailscale.test.ts` → `AC-2.1 detection maps not installed, disconnected and connected` | garbage JSON; empty output; binary missing; signed out and offline give the same state |
| 2.2 | `remote-tailscale` → `AC-2.2 the download opens only after the person allows` | cancel opens nothing; the URL is the constant |
| 2.3 | `remote-tailscale` → `AC-2.3 the wizard never installs Tailscale` | records every `exec` call; none is an installer or package manager |
| 2.4 | `remote-tailscale` → `AC-2.4 the connection test names exactly one cause, in order` | every check failing alone; two failing (first wins); the first check is the injected OS "network up" answer, with no network call (a spy asserts no `fetch`/`net` use) |
| 2.5 | `tests/remote-devices.test.ts` → `AC-2.5 a test message to a device is answered or times out at 10 seconds` | late answer; wrong ping id |
| 2.6 | `remote-channel` → `AC-2.6 status changes are emitted and readable` | |
| 2.7, 2.9, 2.14 | [manual] | |
| 2.8 | `remote-tailscale` → `AC-2.8 the serve command is confirmed before it runs and is never funnel` | property test over ports; cancel runs nothing |
| 2.10 | `remote-tailscale` → `AC-2.10 the key-expiry warning shows under 14 days only` | no expiry reported; expired; exactly 14 |
| 2.11 | `remote-tailscale` → `AC-2.11 a free port is picked once and reused, and a taken one is an error` | port taken at second start; no change on its own |
| 2.12 | `remote-tailscale` → `AC-2.12 only Alma's own serve entry is removed` | another person's entry on the same path stays |
| 2.13 | `remote-tailscale` → `AC-2.13 a serve entry the person made is never overwritten` | same path, other target |
| 2.15 | `remote-tailscale` → `AC-2.15 a changed machine name raises the rename warning` | same name in other case; first run (no saved name) |
| 2.16 | `remote-tailscale` → `AC-2.16 picking another port changes the command and asks again` | |
| 3.1 | `remote-channel` → `AC-3.1 every operation but pairing and hello refuses a request without credentials` | against the local transport and against the loopback HTTP handler of T32 |
| 3.2 | `tests/remote-authorize.test.ts` → `AC-3.2 the verdict is the same whatever carries the request` | table over scopes and routes; the function type takes no transport |
| 3.3 | `remote-channel` → `AC-3.3 an address inside the tailnet with no credential is refused` | wrong `Host`, foreign `Origin`, `remoteAddress` spoofed in headers |
| 3.4 | `remote-tailscale` → `AC-3.4 the listener binds loopback only` | negative fixture: 0.0.0.0 and :: rejected |
| 3.5 | `remote-channel` → `AC-3.5 Tailscale or Serve unavailable means no serving and a concrete cause` | |
| 3.6 | `remote-authorize` → `AC-3.6 the route table is the closed list` and `remote-channel` → `AC-3.6 unknown routes are refused` | `/api/settings`, `/api/vault`, path tricks, wrong method |
| 3.7 | `remote-settings` → `AC-3.7 settings cannot name the test transport` and `tests/remote-tools.test.ts` → `AC-3.7 no source under src/ implements the test transport` | |
| 3.8 | `tests/remote-client-build.test.ts` → `AC-3.8 the built PWA has no hard-coded host` | scans every emitted file |
| 4.1 | `tests/remote-pairing.test.ts` → `AC-4.1 an offer carries address, one-use secret and fingerprint and expires in 3 minutes` | remote off |
| 4.2 | `remote-pairing` → `AC-4.2 a valid secret makes a pending request, not a device` | |
| 4.3 | `tests/remote-devices.test.ts` → `AC-4.3 approving after the native confirmation creates the device and burns the secret` | native cancel |
| 4.4 | `remote-devices` → `AC-4.4 rejecting or cancelling creates nothing` | |
| 4.5 | `remote-pairing` → `AC-4.5 a used, rejected or old secret is refused` | exactly 3 minutes; clock skew |
| 4.6 | `remote-pairing` → `AC-4.6 three bad secrets lock for 5 minutes, a reject does not count` | unlock after 5 minutes; lock whatever the next secret |
| 4.7 | `remote-pairing` → `AC-4.7 a photographed QR still needs the person's approval` | |
| 4.8 | [manual] | |
| 4.9 | `remote-pairing` → `AC-4.9 more than 5 pairing requests a minute are refused` | across different phones |
| 4.10 | `remote-pairing` → `AC-4.10 a second request while one is pending is refused` | |
| 4.11 | `remote-devices` → `AC-4.11 the sixth device is refused, dormant ones count` | |
| 4.12 | `tests/remote-client.test.ts` → `AC-4.12 a PC key that does not match the fingerprint aborts pairing` | altered key; altered fingerprint |
| 4.13 | `remote-devices` → `AC-4.13 a passkey is registered during pairing and a phone without one still pairs` | bad attestation; wrong rpId; non-ES256 |
| 5.1 | `remote-authorize` → `AC-5.1 an enabled scope runs and a disabled one is refused` | every scope × every route |
| 5.2 | `remote-channel` → `AC-5.2 a scope change applies on the next request, also on an open connection` | |
| 5.3 | `remote-channel` → `AC-5.3 never paired, revoked, deleted and idle-expired keys get the same refusal` | byte-identical bodies |
| 5.4 | `remote-channel` → `AC-5.4 malformed or oversized requests are rejected before any handler` | wrong types, extra keys, 1 MB + 1 |
| 5.5 | `tests/remote-chat.test.ts` → `AC-5.5 a message runs the chosen agent on the remote thread and the answer returns` and `AC-5.5 opening loads the last 30 messages as text only` | 8000 and 8001 chars, run already in progress, run fails, PC unreachable; 31 messages give the newest 30; tool-use/result blocks and tool names never appear in the serialized response; a tool-only message is omitted; the 1 MB cap drops the oldest |
| 5.6 | `tests/remote-approvals.test.ts` → `AC-5.6 only approvals of the remote thread are listed and answerable` | approval of another thread answered by id |
| 5.7 | `remote-approvals` → `AC-5.7 an approval already answered elsewhere is ignored` | unknown id; twice |
| 5.8 | `remote-approvals` → `AC-5.8 always is not expressible and publish is a one-time allow` | body with `always` rejected by the schema |
| 5.9 | `remote-approvals` → `AC-5.9 with the approve scope off approvals are hidden and stay pending` | |
| 5.10 | `tests/remote-home.test.ts` → `AC-5.10 house control uses the tool's own function and risk` | sensitive thing through everyday control; house off; disconnected |
| 5.11 | `remote-home` → `AC-5.11 a camera still is returned and nothing is written to disk` | spy on `fs`; camera fails |
| 5.12 | `remote-home` → `AC-5.12 locks and alarms are refused while the sub-switch is off` | siren, gate, garage, door cover |
| 5.13 | `remote-home` → `AC-5.13 opening or disarming needs a valid step-up and then the approval` | wrong challenge, replayed assertion, other action's assertion, expired challenge |
| 5.14 | `remote-home` → `AC-5.14 a cancelled or failed step-up runs nothing` | |
| 5.15 | [manual] | |
| 5.16 | `remote-chat` → `AC-5.16 stopping a run aborts it and denies its pending approvals` | nothing running |
| 5.17 | `remote-chat` → `AC-5.17 operations naming another thread are refused` | desktop, company, an earlier remote thread |
| 5.18 | `remote-home` → `AC-5.18 read-only mode blocks house control from the phone` | |
| 5.19 | `remote-home` → `AC-5.19 a camera picture is authorized as a write call named camera_look` | each approval mode; "Siempre" rule present |
| 5.20 | `remote-authorize` → `AC-5.20 only unlock, open and disarm need a step-up` | all eight actions |
| 5.21 | `remote-home` → `AC-5.21 a phone with no passkey cannot open or disarm` | |
| 5.22 | `remote-home` → `AC-5.22 only allow-listed cameras are served` | empty list; id not in the house; id of a non-camera |
| 5.23 | `remote-home` → `AC-5.23 a still over 2 MB is refused` | exactly 2 MB; 2 MB + 1 |
| 5.24 | `remote-chat` → `AC-5.24 a new conversation replaces the remote thread` | old thread stays; old approvals hidden |
| 5.25 | `remote-approvals` → `AC-5.25 approvals of a replaced remote thread are not shown` | |
| 6.1, 6.4 | [manual] | |
| 6.2 | `remote-devices` → `AC-6.2 revoking cuts connections, deletes the record and keeps the audit` | open long-poll; revoke twice |
| 6.3 | `remote-devices` → `AC-6.3 a revoked device returns only through a full pairing` | |
| 6.5 | `remote-devices` → `AC-6.5 revoke all asks natively and revokes every device` | cancel |
| 6.6 | `remote-authorize` → `AC-6.6 no route acts on another device` | `/api/forget` with another id |
| 6.7 | `remote-devices` → `AC-6.7 a key idle for over 15 days is refused` | exactly 15 days |
| 6.8 | `remote-channel` → `AC-6.8 a session lasts an hour and renews by signing` | expired token; replayed nonce; wrong signature |
| 6.9 | `remote-devices` → `AC-6.9 idle devices are removed automatically, dormant included, with a system audit entry` | |
| 6.10 | `remote-devices` → `AC-6.10 forgetting removes the device when reachable` | unreachable PC |
| 7.1 | `tests/remote-audit.test.ts` → `AC-7.1 each changing or picture operation is audited with actor remote and the device id` | reads are not |
| 7.2 | `remote-audit` → `AC-7.2 known secrets never reach the trail` | pairing secret, code, keys, assertion, subscription fed through every operation |
| 7.3 | `remote-audit` → `AC-7.3 pairing, approval, rejection, revocation and revoke all are audited with the right actor` | |
| 7.4 | `remote-audit` → `AC-7.4 a failing audit sink never interrupts an operation` | |
| 7.5 | `remote-audit` → `AC-7.5 failures are audited, throttled, with no names` | 100 failures in a minute make one line |
| 7.6 | [manual] and `remote-audit` → `AC-7.6 the activity reader returns remote entries only` | corrupt line; deleted device shows its id |
| 7.7 | `remote-home` → `AC-7.7 a phone tool call leaves the tool entry and the remote entry` | denied call |
| 8.1 | `remote-client.test.ts` → `AC-8.1 an unreachable PC shows the message, retries and keeps the typed text` | |
| 8.2 | `remote-tailscale` → `AC-8.2 an outage sets the error status, notifies once and recovers` | flapping; two outages |
| 8.3 | `remote-approvals` → `AC-8.3 after a restart an old approval id is refused as unknown` | |
| 8.4 | `remote-chat` → `AC-8.4 reconnecting returns the committed state, not a draft` | |
| 8.5 | [manual] and `remote-client.test.ts` → `AC-8.5 a refusal of the key wipes key, subscription and shell` | |
| 8.6 | [manual] and `remote-devices` → `AC-6.10 …` | |
| 9.1 | `remote-channel` → `AC-9.1 no outbound connection to an Alma host` and `tests/remote-push.test.ts` → `AC-9.1 the only outbound traffic is the push` | spies `fetch`, `http`, `net` |
| 9.2 | [manual] | |
| 9.3 | `tests/remote-i18n.test.ts` → `AC-9.3 the PWA dictionaries match`, plus the existing parity and ratchet gates and a key-list test in `remote-settings` | |
| 9.4 | `tests/remote-privacy.test.ts` → `AC-9.4 erase revokes all devices and deletes their records` | |
| 9.5 | `remote-privacy` → `AC-9.5 export lists devices without key material` | |
| 10.1 to 10.4 | `tests/remote-limits.test.ts` → one per id | boundary values; two devices do not share counters |
| 11.1 | `tests/remote-push.test.ts` → `AC-11.1 one content-free push when an approval of the remote thread becomes pending` | body empty; endpoint not allowed; private host |
| 11.2 | `remote-push` → `AC-11.2 no push when nothing is pending, the scope is off or there is no subscription` | |
| 11.3 | `remote-push` → `AC-11.3 push keys and subscriptions are sealed and never logged` | |
| 11.4 | `remote-push` → `AC-11.4 revoking or erasing deletes the subscription` | |
| 11.5 | `remote-push` → `AC-11.5 a failing push leaves the approval pending` | |
| 11.6 | [manual] | |

Pure logic extracted from UI goes to `src/shared/remote/view.ts` and is tested in `tests/remote-view.test.ts` (wizard step, failure-to-key mapping, dormant marking, activity row text). The renderer and the PWA screens are covered by typecheck, lint and the manual list.

## 7. Security and privacy impact
- **ToolRisk:** no new tool (BR-11). The channel reuses `home_control` (`home`), `home_secure_control` (`publish`) and the camera path (`write`, authorized as `camera_look`); see PD-10. Test AC-1.6 pins "no remote-access tool".
- **New attack surface (R-14):** a loopback HTTP listener behind Tailscale Serve; an unauthenticated pairing path reachable by every tailnet member (limits BR-21, 5 per minute, lockout); bearer sessions; a passkey verifier written by us (PD-5); a push sender that makes outbound calls to endpoints a paired phone supplies (PD-15); static file serving (traversal tested). Mitigations are in the tasks: Host and Origin check (PD-8), uniform refusals, rate limits, `Cache-Control: no-store` on the API, a strict CSP on the PWA (`default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, no inline script), no cookies.
- **Secrets:** pairing secret and code, session tokens, the PC identity private key, the VAPID private key and push subscriptions. Memory only for the first three; sealed with `safeStorage` (`secret.seal`) on disk for the rest; never in audit, logs, errors, fixtures or prompts (BR-15, AC-7.2 scan).
- **Third parties:** Tailscale (control plane and relay: sees devices and where they connect from, not content) and the browser vendors' push services (see that a content-free notification was sent and when). No Alma-operated server (BR-3, AC-9.1).
- **Stored personal data:** device records (name, public key, dates), push subscriptions, a PC identity key; nothing on the phone but the key and the app shell (BR-32). Covered by erase and export (AC-9.4, AC-9.5).
- **Limit of the "no internet" check (PD-13, P-5):** it reads the operating system's "a network is up" flag and sends no traffic. Behind a captive portal, or with a network that is up but has no route out, the wizard test will not say `noInternet`; the failure shows later as the Tailscale cause. Document it in `docs/modules/remote-access.md` (T47) and keep it in the manual walk (T49).
- **Honest limits to write down in R-14:** the fingerprint check (PD-7); a stolen unlocked phone can chat, approve `write`/`exec`/`publish` one at a time, and read allowed camera pictures until it is revoked (opening and disarming still need the passkey); a token stolen from the phone's memory is good for 1 hour; iOS may evict browser storage (spike S1).
- **Risk of the pairing handoff (P-7, option a):** pairing depends on the browser carrying the `#p=` fragment into the installed app when the manifest has no `start_url`. This is verified today on an iPad (iPadOS 27) and an Android phone (Chrome 156) but it is browser behavior, not a standard guarantee; a future iOS or Chrome release could break it. If it breaks, pairing cannot complete and the person sees the pairing fail. The fallback is a short code typed in the installed app; it is NOT built in 026 and is recorded here as a known risk (write it into R-14 in T47). The spike is repeated on each major iOS and Chrome release and in the manual walk (T49).
- **Docs for the same PR (task T47):** `docs/security/RISKS.md` (R-14), `CONTROLS.md` (remote-channel authentication, per-device keys, step-up, remote audit, kill switch, the updated "only the owner uses the remote channels" row), `PRIVACY.md` (data row, Tailscale and push-service provider rows, the public certificate name, the audit note), `docs/modules/` (a new `remote-access.md`, updates to `settings.md`, `approvals.md`, `home.md`, `security.md`, `app-shell.md`), `docs/architecture.md` (the fifth zone and rules), `docs/context.md` (the `remote` channel thread), the specs of spec section 7.1, and the ADR 0020 amendment.

## 8. Rollout
- **Prerequisites before any task that touches the house or a listener:** T0 (R-02 fix) merged. **Before a release that contains this feature:** T0b (R-01) merged (OQ-16). R-06 stays as BR-10: off by default until spec 001 delivers signing and Fuses.
- **Flag and default:** `settings.remote.enabled`, default false, all scopes and the locks switch off. Turning it on needs the native confirmation of AC-1.2. Nothing listens and no PWA files are served while it is off.
- **Turn off:** the switch in the tab, or the tray item (AC-1.13); both cut every connection (AC-1.7). The tray icon is shown whenever remote access is on, even with tray mode off (PD-17).
- **First run:** the "Remote access" tab says `remote.offByDefault.hint` and offers the wizard; no phone can pair until the person finishes the Tailscale steps and starts a pairing.
- **Build and dev:** `pnpm run build` builds the app and the PWA; `pnpm run build:remote` builds only the PWA (`out/remote`). In `pnpm run dev` the person runs `build:remote` once; without it the PC answers the PWA path with a short "PWA not built" page, never a blank.
- **Verification before `implemented`:** all `[manual]` ACs on a real Android phone and a real iPhone with Tailscale, once the spikes are green (T49).

## 9. Spike results and Open Questions for the human
### 9.1 Spikes (facts the spec marked "to verify"; each has a stop condition in `tasks.md`)
| Spike | Question | Stop condition |
|---|---|---|
| S1 | On a real Android phone and a real iPhone, over `tailscale serve` HTTPS: does a non-exportable WebCrypto ES256 key persist in IndexedDB across reloads and days; does a service worker register; do WebAuthn `create` and `get` work with `rpId` = the `*.ts.net` name (in a tab and as an installed PWA); how does iOS treat storage of a tab versus an installed PWA (it can evict script-written storage after days of non-use in Safari)? | Any of key persistence, service worker or WebAuthn failing on either platform: stop the PWA tasks (T40 onward) and the passkey tasks, write the result into ADR 0020, ask the human. A storage-eviction finding is OQ P-3, not a failure. |
| S2 | On a real Windows PC with Tailscale: the exact `tailscale status --json` fields (BackendState, Self.DNSName, Self.KeyExpiry, Health, MagicDNS/HTTPS flags), where `tailscale.exe` lives and whether `PATH` has it, `tailscale serve` syntax for the installed version, whether `serve status --json` lets Alma tell its own entry from another, whether a same-path `serve` replaces (PD-3), what failure text appears when HTTPS certificates are off, and how long the first certificate takes. | No machine-readable way to tell Alma's entry from the person's: AC-2.12 and AC-2.13 cannot be met; stop T31 and ask the human. |
| S3 | Does an empty-payload push with a VAPID header reach Android Chrome and an iOS PWA installed to the home screen and fire the service worker? | iOS rejects or drops empty pushes: stop T46, ask the human (OQ P-4 lists the options). |
| S4 (not a spike) | `cameraSnapshot` keeps nothing on the PC. | Settled by reading `hub.ts` and by the test of AC-5.11; no hardware needed. |

Spike results are appended here (section 9.3) and, when they change a decision, to ADR 0020.

### 9.2 Open Questions for the human (not answered by the planner)
Unchecked items do not stop the tasks that do not depend on them; each names what it blocks.
- [x] P-1 **Kill switch without a tray.** Answered: the tray icon is shown while remote access is on, even if "keep running in the tray" is off, so the kill switch of AC-1.13 always exists. Written as PD-17 and in T34; the tray rule change is a spec amendment in T48.
- [x] P-2 **How much does the phone load on opening?** Answered: the last 30 messages of the remote thread, showing only the question, the answer and the approvals, never tool activity; the 1 MB response cap still applies. Written as PD-12, the `/api/state` shape in section 3, the test row of AC-5.5 and T20.
- [x] P-3 **iOS in a browser tab.** Closed as moot by P-7 option (a): pairing happens only inside the installed app, so the eviction of a tab's storage no longer matters. Original question: Only if S1 finds that iOS evicts the key of a PWA kept in a Safari tab: should the PWA refuse to pair outside "installed to the home screen" on iOS, or pair and accept re-pairing, with a warning? Blocks T42's iOS branch only. **Reframed by S1 (section 9.3):** on iOS the installed app's storage is separate from the tab's, so what matters is where pairing happens, which is the new question P-7. P-3 stays unticked only for what S1 did not measure: whether iOS evicts a tab's script-written storage after days of non-use. That is moot if the human answers P-7 with pairing inside the installed app (option a), and then P-3 can be closed as moot.
- [x] P-4 **If S3 fails on iOS.** Answered by S3: it did not fail. A zero-length VAPID push reached the iPad home-screen app (permission granted, 3 of 3 arrived), so options (a) to (c) are not needed and T46 is not blocked. Evidence: section 9.3, S3. Consequence: on iOS `Notification` does not exist in a Safari or Chrome tab, so push is available only after installing to the home screen.
- [x] P-5 **What "no internet" means in the wizard test.** Answered: the operating system's "a network is up" flag; no probe to a third-party host. The captive-portal limitation is written in section 7 (PD-13, T30, T47).
- [x] P-6 **Two plan assumptions.** Accepted as written: (a) the tool entry of a phone-initiated call keeps `actor: 'agent'` with the remote thread's agent in `detail.agent`, and the separate `remote` entry records the origin (PD-10); (b) the push-service allow-list of PD-15 (FCM, Apple, Mozilla, Windows notifications).

- [x] P-7 **Pairing flow vs. installed app storage.** **Answered by the human: option (a), pair inside the installed app.** The tab at the QR link shows only "install first" instructions and does not start pairing; the manifest has no `start_url`; the installed app consumes the fragment once and wipes it; pairing proceeds only in standalone display mode. Recorded as task T51 (spec amendments in T51/T48: AC-4.1, AC-4.8, AC-4.12 amended, AC-4.14 to AC-4.17 added; BR-18, BR-21, BR-23 and BR-32 amended); the fallback if the fragment carry-over ever breaks (a short code typed in the installed app) is a known risk in section 7, not built. Original question: Evidence (spikes S1 and the pairing handoff test, section 9.3): on iOS the installed app's storage is separate from the browser tab's (a key made in a Safari tab was null in the home-screen app); Android is not confirmed. A manifest without `start_url` carries the `#fragment` into the installed app on iPad and Android; a manifest with a fixed `start_url` loses it. The current `src/remote-client/public/manifest.webmanifest` has `"start_url": "."` and `src/remote-client/screens/Pair.tsx` pairs as soon as the page loads, in the tab. So after "Add to Home Screen" the device key and the secret are not in the installed app, and the person would have to start pairing again. Which pairing flow do we want? (a) **Recommended:** pair inside the installed app: the tab only shows "install first" instructions, the manifest has no `start_url` so the fragment survives, the app reads the secret once and wipes it. (b) Keep pairing in the tab and make the installed app pair again with a typed short code. (c) A different approach the human proposes. Blocks T51 and the pairing ACs 4.x of the PWA (T42); changes user-facing flow, so it is the human's decision.

All plan questions are now answered (P-3 moot, P-4 by S3, P-7 option a).

### 9.3 Results of the spikes
Spikes run on 2026-11-07. Devices: Pixel 8a (Chrome 156, Android), iPad (iPadOS 27, Safari and Chrome), all over Tailscale Serve HTTPS with a MagicDNS certificate; PC with Tailscale 1.104.5 on Windows. S1 and S3 had no impact on ADR 0020 decisions so far; the ADR is not edited here (another ADR numbered 0020 exists and the human will resolve it).

**S1 — keys, service worker, WebAuthn (partly measured)**
- Non-exportable WebCrypto ECDSA P-256 key: created, export refused, signs. Android Chrome, iPad Safari and iPad Chrome. PASS.
- The key survives a reload in the installed app on Android (age 0.1 h) and `storage.persisted()` is true there.
- Service worker registers on both platforms. PASS.
- WebAuthn (ES256, attestation `none`, user verification required): `create` and `get` OK on both, UV flag true. Android: BE=false (device-bound). iPad: BE=true, BS=true, so the passkey is synced through iCloud Keychain and not tied to one device. This matters for the threat model of the lock and alarm step-up (BR-24).
- On iOS the installed app's storage is separate from the browser tab's (a key made in a Safari tab was null in the home-screen app). Android: not confirmed (an early Brave/Chrome mix-up muddied the result).
- Stop condition of S1 did not fire (key, service worker and WebAuthn passed on both platforms).
- Pairing handoff (the QR opens a tab, the installed app has its own storage): a static manifest WITHOUT `start_url` carries the `#secret` into the installed app (iPad PASS, Android PASS); a JS-generated blob manifest with `start_url = location.href` also passes but is needlessly complex; a static manifest with a fixed `start_url` LOSES the fragment (control, as expected). The human chose pairing inside the installed app (P-7 option a), so the app must read the secret once, wipe it with `history.replaceState`, and ignore it on later launches (the secret is single use and expired by then). Re-check on each major iOS and Chrome release; the fallback if it ever breaks is a short code typed in the installed app.
- Finding against the current code: the manifest has `start_url: "."` and `Pair.tsx` pairs on load in the tab. See P-7.

**S2 — Tailscale CLI on Windows (partly captured)**
Sanitized fixtures in `tests/fixtures/tailscale/`: `status-running`, `status-stopped`, `serve-empty`, `serve-alma`, `serve-alma-other-port`, `serve-with-foreign-path`, `serve-with-foreign-port`.
- Binary: `C:\Program Files\Tailscale\tailscale.exe`. That folder is in the machine `PATH`, but a process started before the install does not have it, so Alma must fall back to the absolute path and not rely on `PATH` alone.
- Serve: `tailscale serve --bg <port>` (the port number means `http://127.0.0.1:<port>`), HTTPS on 443 by default. Other forms: `--https=<port>`, `--set-path <path>`, `serve reset`, `serve --https=443 off`.
- PD-3 holds: `serve --bg 8444` over an existing `/ -> 8443` replaces the target (exit 0, no error); one command is enough.
- The stop condition of S2 did NOT fire. `serve status --json` is `{}` when empty. Alma's entry is `Web["<name>:443"].Handlers["/"].Proxy == "http://127.0.0.1:<port>"` plus `TCP.443.HTTPS`. A foreign entry is distinguishable by host:port, path and Proxy target (another path `Handlers["/other"]`, or another port `TCP["8444"]` and `Web["<name>:8444"]`). AC-2.12 and AC-2.13 can be met.
- Removal (verified 2026-11-07 on the live tailnet, after S2): `tailscale serve --https=443 --set-path / off` removes one path and leaves the rest intact (exit 0; a scratch path was added and removed with the Alma entry untouched). Without `--set-path`, `off` disables the whole proxy, so Alma always passes it; `serve reset` and `serve clear` (services only) are never used.
- `status --json` fields seen: `BackendState` (`Running`, `Stopped`), `Health` (array; `[]` when fine, `["Tailscale is stopped."]` when down), `Self.DNSName` (trailing dot), `Self.KeyExpiry` (ISO), `Self.Online`, `CertDomains` (non-empty when HTTPS is on), `CurrentTailnet.MagicDNSEnabled`, and `"https"` in `Self.Capabilities`. Peers are in `Peer`, keyed by node key.
- While Stopped, `serve status --json` still shows the saved config; `tailscale up` returned it to Running in about 1 s without a new login.
- `tailscale cert <name>` returns at once (the certificate was already cached by Serve) and WRITES the `.crt` and `.key` into the current directory. Alma must never call it (Serve provisions the certificate itself). If that ever changes, pass explicit `--cert-file` and `--key-file` in a private folder.

**S3 — empty push (zero-length body, VAPID)**
- Android Chrome: PASS (`fcm.googleapis.com`, HTTP 201, service worker received `dataBytes` 0).
- iPad home-screen app: PASS (permission granted, 3 of 3 arrived). `Notification` does not exist in a Safari or Chrome tab on iOS: the person must install first. P-4 is answered.
- Stop condition of S3 did not fire.

**Still NOT measured**
- Persistence of the installed app after 3 days (and 7 days on iOS): open it after that time and read the state. S1 stays open until then.
- Whether iOS evicts the storage of a tab that is not installed (moot after P-7 option a).
- Android: whether the installed app's storage is separate from the tab's (not confirmed).
- S2 states not captured: Tailscale not installed (absence of the binary), `NeedsLogin` (logged out), key near expiry, the exact failure text when HTTPS certificates are off, and the first-certificate wait (it was cached here). Tests for these must use hand-written fakes marked as such (T29 to T33).
