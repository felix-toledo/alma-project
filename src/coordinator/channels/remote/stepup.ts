// Step-up for opening and disarming (BR-24): the phone gets a challenge bound to the device,
// thing and action, answers with a passkey assertion over it, and each success runs exactly one
// action. No time window, no fallback, no reuse: failures burn the challenge like successes do.

import type { DeviceAuth } from '../../../shared/remote/authorize'
import { stepupChallengeBody, type RemoteRequest, type RemoteResponse } from '../../../shared/remote/api'
import { b64u } from '../../../shared/remote/crypto'
import { verifyAssertion } from '../../../shared/remote/webauthn'
import { CHALLENGE_MS } from './session'
import type { DeviceStore, RemoteStateStore } from './store'
import { refusalResponse } from './transport'

const NO_STEP_UP = new Set(['lock', 'close', 'arm_home', 'arm_away', 'trigger', 'silence', 'stop', 'set-position'])

/**
 * Whether the action opens or disarms (AC-5.20). Unknown actions fail closed: whatever the
 * schema let through that is not on the no-step-up list is treated as opening or disarming.
 */
export function needsStepUp(action: string): boolean {
  return !NO_STEP_UP.has(action)
}

export interface StepUpDeps {
  store: DeviceStore
  state: RemoteStateStore
  now(): number
  random(length: number): Uint8Array
}

export interface StepUpAssertion {
  authenticatorData: string
  clientDataJSON: string
  signature: string
}

interface Pending {
  deviceId: string
  thing: string
  action: string
  issuedAt: number
}

export class StepUpFlow {
  private readonly challenges = new Map<string, Pending>()

  constructor(private readonly deps: StepUpDeps) {}

  /** Issues a challenge for one action, or refuses when the device cannot step up. */
  issue(deviceId: string, thing: string, action: string): { challenge: string } | { error: 'no-passkey' | 'not-needed' } {
    const device = this.deps.store.devices().find((known) => known.id === deviceId)
    if (!device?.passkey) return { error: 'no-passkey' }
    if (!needsStepUp(action)) return { error: 'not-needed' }
    this.prune()
    const challenge = b64u.encode(this.deps.random(32))
    this.challenges.set(challenge, { deviceId, thing, action, issuedAt: this.deps.now() })
    return { challenge }
  }

  /** Verifies one assertion against its challenge; every attempt consumes it, pass or fail. */
  async verify(deviceId: string, thing: string, action: string, assertion: StepUpAssertion): Promise<{ ok: true } | { ok: false }> {
    this.prune()
    const presented = StepUpFlow.presentedChallenge(assertion.clientDataJSON)
    if (!presented) return { ok: false }
    const pending = this.challenges.get(presented)
    this.challenges.delete(presented)
    if (!pending || pending.deviceId !== deviceId || pending.thing !== thing || pending.action !== action) {
      return { ok: false }
    }
    const device = this.deps.store.devices().find((known) => known.id === deviceId)
    if (!device?.passkey) return { ok: false }
    let authenticatorData: Uint8Array
    let clientDataJSON: Uint8Array
    let signature: Uint8Array
    let challenge: Uint8Array
    try {
      authenticatorData = b64u.decode(assertion.authenticatorData)
      clientDataJSON = b64u.decode(assertion.clientDataJSON)
      signature = b64u.decode(assertion.signature)
      challenge = b64u.decode(presented)
    } catch {
      return { ok: false }
    }
    const hostName = this.deps.state.state.hostName ?? ''
    const verified = await verifyAssertion({
      authenticatorData,
      clientDataJSON,
      signature,
      challenge,
      origin: `https://${hostName}`,
      rpId: hostName,
      publicKey: device.passkey.publicKey,
      lastCounter: device.passkey.counter
    })
    if (!verified.ok) return { ok: false }
    await this.deps.store.setPasskey(deviceId, { ...device.passkey, counter: verified.counter })
    return { ok: true }
  }

  /** The handler behind POST /api/stepup/challenge: session, home scope and sub-switch first. */
  async stepupChallenge(request: RemoteRequest, device: DeviceAuth | null): Promise<RemoteResponse> {
    if (!device) return refusalResponse('unknown-device')
    const body = stepupChallengeBody.parse(request.body)
    const issued = this.issue(device.deviceId, body.thing, body.action)
    if (!('challenge' in issued)) return refusalResponse('invalid')
    return { status: 200, headers: { 'cache-control': 'no-store' }, body: { challenge: issued.challenge } }
  }

  private prune(): void {
    const now = this.deps.now()
    for (const [challenge, pending] of this.challenges) {
      if (now - pending.issuedAt > CHALLENGE_MS) this.challenges.delete(challenge)
    }
  }

  private static presentedChallenge(clientDataJSON: string): string | null {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(b64u.decode(clientDataJSON))) as { challenge?: unknown }
      return typeof parsed.challenge === 'string' ? parsed.challenge : null
    } catch {
      return null
    }
  }
}
