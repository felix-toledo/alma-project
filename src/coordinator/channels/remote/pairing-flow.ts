// Pairing glue between the pure machine, the store and the host (plan 3, BR-21): the PC-side
// methods behind remote.pair.* and the HTTP handlers for /api/pair/request and /api/pair/status.
// The machine owns the offer; this flow owns the bad-secret strikes (OQ-22), the remembered
// outcome for status polls, and the QR. Audit instrumentation arrives with T26, not here.

import { toDataURL } from 'qrcode'
import { pairPasskeyBody, pairRequestBody, type RemoteRequest, type RemoteResponse } from '../../../shared/remote/api'
import { b64u, fingerprint } from '../../../shared/remote/crypto'
import { bareDnsName } from '../../../shared/remote/tailscale'
import {
  MAX_ATTEMPTS,
  OFFER_EXPIRES_MS,
  PAIRING_LOCK_MS,
  pairingCode,
  pairingExchanges,
  type PairingState
} from '../../../shared/remote/pairing'
import { verifyRegistration } from '../../../shared/remote/webauthn'
import type { DeviceView, PairApproveResult, PairingView, PairStartResult, Settings } from '../../../shared/types'

export type { PairApproveResult, PairStartResult }
import { deviceViews, MAX_DEVICES, type DeviceStore, type RemoteStateStore } from './store'
import { refusalResponse } from './transport'

export interface PairingHost {
  confirm(kind: 'pair' | 'serve' | 'revokeAll', params: Record<string, string>): Promise<boolean>
}

export interface PairingFlowDeps {
  store: DeviceStore
  state: RemoteStateStore
  settings(): Settings
  now(): number
  random(length: number): Uint8Array
  host: PairingHost
  onPairing(view: PairingView | null): void
  onDevices(devices: DeviceView[]): void
}

type Remembered =
  | { status: 'approved'; offer: string; pcNonce: string; deviceId: string }
  | { status: 'rejected' | 'expired' | 'locked'; offer: string; pcNonce: string }

/** The QR payload (PD-7): the secret rides the fragment, which browsers never send to a server. */
export function buildPairingUrl(hostName: string, secret: string, pcFingerprint: string): string {
  return `https://${bareDnsName(hostName)}/#p=${secret}&f=${pcFingerprint}`
}

function ok(body: unknown): RemoteResponse {
  return { status: 200, headers: { 'cache-control': 'no-store' }, body }
}

export class PairingFlow {
  private machine: PairingState = 'idle'
  private strikes = 0
  private flowLockedUntil = 0
  private lastOutcome: Remembered | null = null
  private pendingPasskey: { deviceId: string; challenge: Uint8Array; offer: string; pcNonce: string } | null = null

  constructor(private readonly deps: PairingFlowDeps) {}

  /** Starts one pairing: a fresh offer and its QR, unless something already owns the machine. */
  async start(): Promise<PairStartResult> {
    const now = this.deps.now()
    if (!this.deps.settings().remote.enabled) return { ok: false, reason: 'off' }
    if (now < this.flowLockedUntil) return { ok: false, reason: 'locked' }
    if (this.deps.store.devices().length >= MAX_DEVICES) return { ok: false, reason: 'limit' }
    const hostName = this.deps.state.state.hostName
    if (!hostName) return { ok: false, reason: 'no-host' }
    const created = pairingExchanges.newOffer({ state: this.machine, now, random: (n) => this.deps.random(n) })
    if (!created.offer) return { ok: false, reason: created.refusal ?? 'busy' }
    this.machine = created.state
    this.lastOutcome = null
    this.pendingPasskey = null
    const url = buildPairingUrl(hostName, created.offer.qr, await fingerprint(this.deps.state.state.pcKey.public))
    this.deps.onPairing({ stage: 'offer', qrDataUrl: await toDataURL(url), expiresAt: now + OFFER_EXPIRES_MS })
    return { ok: true }
  }

  /** Abandons whatever is pending; the phone reads the remembered offer as expired. */
  cancel(): { ok: true } {
    const live = this.machine
    if (live !== 'idle' && live.phase !== 'locked') {
      this.lastOutcome = { status: 'expired', offer: live.offer, pcNonce: live.pcNonce }
    } else if (live !== 'idle' && this.lastOutcome) {
      this.lastOutcome = { status: 'expired', offer: this.lastOutcome.offer, pcNonce: this.lastOutcome.pcNonce }
    }
    this.machine = 'idle'
    this.deps.onPairing(null)
    return { ok: true }
  }

  /**
   * Approves the bound request with the PC-typed name: the native dialog shows name and code,
   * and only "Allow" registers the device. The digits are recomputed, never trusted from the caller.
   */
  async approve(name: string): Promise<PairApproveResult> {
    const trimmed = name.trim()
    if (!trimmed) return { ok: false, reason: 'invalid' }
    const live = this.machine
    const now = this.deps.now()
    if (live === 'idle' || live.phase === 'offered') return { ok: false, reason: 'invalid' }
    if (live.phase === 'locked') return { ok: false, reason: now < live.until ? 'locked' : 'expired' }
    if (now > live.createdAt + OFFER_EXPIRES_MS) return { ok: false, reason: 'expired' }
    const digits = await pairingCode({ secret: live.secret, phoneKey: live.accepted.deviceKey, pcNonce: live.pcNonce })
    const allowed = await this.deps.host.confirm('pair', { name: trimmed, code: digits })
    // The name arrives at approval time (BR-21), typed on the PC; the flow completes the bound
    // state with it before the decision consumes the offer. The clock is re-read: the person may
    // have stared at the native dialog past the offer's expiry.
    const decided = await pairingExchanges.decide({
      state: { ...live, accepted: { ...live.accepted, deviceName: trimmed } },
      now: this.deps.now(),
      approved: allowed,
      digits
    })
    if ('error' in decided) {
      this.machine = decided.state
      if (decided.error === 'locked' && decided.state !== 'idle' && decided.state.phase === 'locked') {
        this.lastOutcome = { status: 'locked', offer: live.offer, pcNonce: live.pcNonce }
        this.deps.onPairing({ stage: 'locked', lockedUntil: decided.state.until })
        return { ok: false, reason: 'locked' }
      }
      if (decided.error === 'mismatch') return { ok: false, reason: 'mismatch' }
      if (decided.error === 'expired') return { ok: false, reason: 'expired' }
      return { ok: false, reason: 'invalid' }
    }
    if (decided.decision === 'rejected') {
      this.machine = 'idle'
      this.lastOutcome = { status: 'rejected', offer: live.offer, pcNonce: live.pcNonce }
      this.deps.onPairing(null)
      return { ok: false, reason: 'denied' }
    }
    const added = await this.deps.store.add({ name: trimmed, publicKey: decided.device.deviceKey })
    this.machine = 'idle'
    if (!added) {
      // Unreachable: a single pending offer plus the start gate cannot overflow five devices.
      this.lastOutcome = null
      this.deps.onPairing(null)
      return { ok: false, reason: 'limit' }
    }
    this.lastOutcome = { status: 'approved', offer: live.offer, pcNonce: live.pcNonce, deviceId: added.id }
    this.pendingPasskey = { deviceId: added.id, challenge: this.deps.random(32), offer: live.offer, pcNonce: live.pcNonce }
    this.deps.onDevices(deviceViews(this.deps.store.devices(), !this.deps.settings().remote.enabled))
    this.deps.onPairing(null)
    return { ok: true, deviceId: added.id }
  }

  /** Rejects whatever is pending; the person's no always wins, even over a lock. */
  async reject(): Promise<{ ok: true }> {
    const live = this.machine
    if (live !== 'idle' && live.phase === 'accepted') {
      // Digits go unchecked on rejection: saying no never depends on them.
      const decided = await pairingExchanges.decide({ state: live, now: this.deps.now(), approved: false, digits: '' })
      this.machine = decided.state
      this.lastOutcome = { status: 'rejected', offer: live.offer, pcNonce: live.pcNonce }
    } else if (live !== 'idle') {
      this.machine = 'idle'
      if (live.phase !== 'locked') {
        this.lastOutcome = { status: 'rejected', offer: live.offer, pcNonce: live.pcNonce }
      } else if (this.lastOutcome) {
        this.lastOutcome = { status: 'rejected', offer: this.lastOutcome.offer, pcNonce: this.lastOutcome.pcNonce }
      }
    }
    this.deps.onPairing(null)
    return { ok: true }
  }

  /**
   * The phone presents the scanned secret with its new public key and gets the PC nonce.
   * Re-presenting the bound key replays the same answer: one secret, one ceremony, retries allowed.
   */
  async pairRequest(request: RemoteRequest): Promise<RemoteResponse> {
    const now = this.deps.now()
    if (now < this.flowLockedUntil) return refusalResponse('invalid')
    const body = pairRequestBody.parse(request.body)
    const live = this.machine
    if (live === 'idle' || live.phase === 'locked' || live.offer !== body.secret) {
      this.strike()
      return refusalResponse('invalid')
    }
    if (now > live.createdAt + OFFER_EXPIRES_MS) {
      // Expired answers expired (AC-4.5): guessing a 256-bit offer is hopeless, so telling a
      // holder it lapsed costs nothing and tells the phone to scan a new QR.
      this.strike()
      return refusalResponse('expired')
    }
    const bound = await pairingExchanges.code({ state: live, phoneKey: body.phonePublicKey, deviceName: '', now })
    // A second key knocking on a live offer is busy, not wrong: the offer matched (AC-4.10).
    if ('error' in bound) return refusalResponse('busy')
    this.machine = bound.state
    this.strikes = 0
    this.deps.onPairing({ stage: 'request', code: bound.digits, expiresAt: live.createdAt + OFFER_EXPIRES_MS })
    return ok({ pcNonce: live.pcNonce, expiresAt: live.createdAt + OFFER_EXPIRES_MS })
  }

  /** The phone polls its pairing: live offers answer from the machine, spent ones from memory. */
  async pairStatus(request: RemoteRequest): Promise<RemoteResponse> {
    const live = this.machine
    const offer = request.query.get('offer') ?? ''
    const pcNonce = request.query.get('pcNonce') ?? ''
    if (live !== 'idle' && live.phase !== 'locked' && live.offer === offer) {
      // The pipeline already throttled pairing requests (AC-4.9); the count rides zero here.
      const shown = pairingExchanges.present({ state: live, now: this.deps.now(), pcNonce, phoneKey: request.query.get('fp') ?? '', rate: 0 })
      if (shown.outcome === 'pending') return ok({ status: 'pending', expiresAt: shown.expiresAt })
      if (shown.outcome === 'expired') return ok({ status: 'expired' })
      return refusalResponse('invalid')
    }
    const remembered = this.lastOutcome
    if (remembered && remembered.offer === offer && remembered.pcNonce === pcNonce) {
      if (remembered.status === 'approved') {
        const pending = this.pendingPasskey
        const challenge =
          pending && pending.offer === offer && pending.pcNonce === pcNonce ? { passkeyChallenge: b64u.encode(pending.challenge) } : {}
        return ok({ status: 'approved', deviceId: remembered.deviceId, ...challenge })
      }
      return ok({ status: remembered.status })
    }
    return refusalResponse('invalid')
  }

  /**
   * The phone submits its passkey attestation against the approved pairing's challenge. One
   * challenge registers one passkey; failures keep it for a retry, success consumes it. A phone
   * that never calls stays paired without a passkey (AC-4.13), refused at step-up time (AC-5.21).
   */
  async pairPasskey(request: RemoteRequest): Promise<RemoteResponse> {
    const body = pairPasskeyBody.parse(request.body)
    const pending = this.pendingPasskey
    if (!pending || pending.offer !== body.offer || pending.pcNonce !== body.pcNonce) return refusalResponse('invalid')
    let attestationObject: Uint8Array
    let clientDataJSON: Uint8Array
    try {
      attestationObject = b64u.decode(body.attestationObject)
      clientDataJSON = b64u.decode(body.clientDataJSON)
    } catch {
      return refusalResponse('invalid')
    }
    const hostName = this.deps.state.state.hostName ?? ''
    const verified = await verifyRegistration({
      attestationObject,
      clientDataJSON,
      challenge: pending.challenge,
      origin: `https://${hostName}`,
      rpId: hostName
    })
    if (!verified.ok) return refusalResponse('invalid')
    await this.deps.store.setPasskey(pending.deviceId, {
      credentialId: b64u.encode(verified.credentialId),
      publicKey: verified.publicKey,
      counter: verified.counter
    })
    this.pendingPasskey = null
    return ok({ ok: true })
  }

  /**
   * OQ-22: a wrong, used or expired secret counts; the person's reject never reaches here.
   * The third strike freezes new requests for 5 minutes; a live offer is unaffected.
   */
  private strike(): void {
    this.strikes++
    if (this.strikes < MAX_ATTEMPTS) return
    this.strikes = 0
    this.flowLockedUntil = this.deps.now() + PAIRING_LOCK_MS
    this.deps.onPairing({ stage: 'locked', lockedUntil: this.flowLockedUntil })
  }
}
