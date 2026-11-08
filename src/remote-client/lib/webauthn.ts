import { b64u } from '../../shared/remote/crypto'
import type { FetchLike, FetchResponse } from './session'

/** Raw attestation bytes from the browser's passkey creation. */
export interface PasskeyAttestation {
  attestationObject: Uint8Array
  clientDataJSON: Uint8Array
}

/**
 * The browser side of passkey creation, injected so this module stays DOM-free:
 * `navigator.credentials.create` with ES256 only, `userVerification: 'required'`
 * and attestation `none` (the thin wrapper lives in the Pair screen).
 */
export interface PasskeyCreator {
  create(challenge: Uint8Array, rpId: string, userId: Uint8Array): Promise<PasskeyAttestation | null>
}

export interface EncodedAttestation {
  attestationObject: string
  clientDataJSON: string
}

/**
 * Registers the step-up passkey (AC-4.13): creates it against the PC's challenge
 * and encodes the attestation for `/api/pair/passkey`. A refusal or a phone
 * without passkeys reads as null: the phone stays paired, just unable to open
 * or disarm (AC-5.21).
 */
export async function registerPasskey(deps: {
  create: PasskeyCreator['create']
  challenge: Uint8Array
  rpId: string
  userId: Uint8Array
}): Promise<EncodedAttestation | null> {
  let attestation: PasskeyAttestation | null
  try {
    attestation = await deps.create(deps.challenge, deps.rpId, deps.userId)
  } catch {
    return null
  }
  if (!attestation) return null
  return {
    attestationObject: b64u.encode(attestation.attestationObject),
    clientDataJSON: b64u.encode(attestation.clientDataJSON)
  }
}

export type PasskeySubmitOutcome = { ok: true } | { ok: false; reason: 'invalid' | 'network' }

/** Submits the attestation against the approved pairing's challenge. */
export async function submitPasskey(deps: {
  fetch: FetchLike
  offer: string
  pcNonce: string
  attestationObject: string
  clientDataJSON: string
}): Promise<PasskeySubmitOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/pair/passkey', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offer: deps.offer,
        pcNonce: deps.pcNonce,
        attestationObject: deps.attestationObject,
        clientDataJSON: deps.clientDataJSON
      })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.ok) return { ok: true }
  if (response.status === 400) return { ok: false, reason: 'invalid' }
  return { ok: false, reason: 'network' }
}
