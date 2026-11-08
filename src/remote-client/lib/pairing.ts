import { b64u, fingerprint, verifyEs256, type PublicJwk } from '../../shared/remote/crypto'
import { pairingCode } from '../../shared/remote/pairing'
import type { PwaKey } from '../i18n'
import type { FetchLike, FetchResponse } from './session'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export interface PairFragment {
  secret: string
  fingerprint: string
}

/**
 * Pairing runs only inside the installed app (T51, P-7 option a): a browser tab
 * only shows install instructions and never starts pairing, so the secret stays
 * in the URL for the installed launch. Values are injected for the test; the
 * screen reads them from `matchMedia('(display-mode: standalone)')` and iOS
 * `navigator.standalone`.
 */
export function isInstalledApp(env: { displayModeStandalone: boolean; navigatorStandalone?: boolean }): boolean {
  return env.displayModeStandalone || env.navigatorStandalone === true
}

/**
 * Reads the QR payload from the URL fragment (`#p=<secret>&f=<fingerprint>`).
 * The secret rides the fragment, which browsers never send to a server (PD-7).
 */
export function parsePairFragment(hash: string): PairFragment | null {
  if (!hash.startsWith('#')) return null
  const params = new URLSearchParams(hash.slice(1))
  const secret = params.get('p')
  const fingerprint = params.get('f')
  if (!secret || !fingerprint) return null
  return { secret, fingerprint }
}

export type HelloOutcome = { ok: true } | { ok: false; reason: 'mismatch' | 'network' }

/**
 * The trust check before pairing (AC-4.12): the PC signs a fresh nonce with the key
 * the QR names, and the phone verifies the signature and compares the fingerprint
 * with the QR value. Anything off aborts before the phone sends anything.
 */
export async function checkHello(deps: { fetch: FetchLike; expectedFingerprint: string }): Promise<HelloOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/hello')
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!response.ok) return { ok: false, reason: 'network' }
  const hello = await response.json()
  if (
    !isRecord(hello) ||
    !isRecord(hello.publicKey) ||
    typeof hello.fingerprint !== 'string' ||
    typeof hello.nonce !== 'string' ||
    typeof hello.signature !== 'string'
  ) {
    return { ok: false, reason: 'network' }
  }
  let nonce: Uint8Array
  let signature: Uint8Array
  try {
    nonce = b64u.decode(hello.nonce)
    signature = b64u.decode(hello.signature)
  } catch {
    return { ok: false, reason: 'mismatch' }
  }
  const publicKey = hello.publicKey as PublicJwk
  if (!(await verifyEs256(publicKey, nonce, signature))) return { ok: false, reason: 'mismatch' }
  if ((await fingerprint(publicKey)) !== hello.fingerprint) return { ok: false, reason: 'mismatch' }
  if (hello.fingerprint !== deps.expectedFingerprint) return { ok: false, reason: 'mismatch' }
  return { ok: true }
}

export type PairRequestOutcome =
  | { ok: true; pcNonce: string; expiresAt: number }
  | { ok: false; reason: 'invalid' | 'expired' | 'busy' | 'rate-limited' | 'network' }

/** Sends the one-use secret and the phone's public key; reads the PC nonce back. */
export async function requestPair(deps: { fetch: FetchLike; secret: string; phonePublicKey: PublicJwk }): Promise<PairRequestOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch('/api/pair/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: deps.secret, phonePublicKey: deps.phonePublicKey })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.status === 400) return { ok: false, reason: 'invalid' }
  if (response.status === 410) return { ok: false, reason: 'expired' }
  if (response.status === 409) return { ok: false, reason: 'busy' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  if (!response.ok) return { ok: false, reason: 'network' }
  const accepted = await response.json()
  if (!isRecord(accepted) || typeof accepted.pcNonce !== 'string' || typeof accepted.expiresAt !== 'number') {
    return { ok: false, reason: 'network' }
  }
  return { ok: true, pcNonce: accepted.pcNonce, expiresAt: accepted.expiresAt }
}

/**
 * Text for a failed pair request. An unknown secret means the offer is gone
 * (consumed, or the PC restarted): a stale code to replace, never the wrong PC.
 */
export function pairRequestErrorKey(reason: 'invalid' | 'expired' | 'busy' | 'rate-limited' | 'network'): PwaKey {
  if (reason === 'expired') return 'remote.pwa.pairing.expired'
  if (reason === 'invalid') return 'remote.pwa.pairing.rescan'
  if (reason === 'network') return 'remote.pwa.pcUnreachable'
  return 'remote.pwa.rateLimited'
}

/** The 6 digits both screens show: the same function the PC runs (T14/PD-7). */
export async function deriveCode(deps: { secret: string; phoneKey: PublicJwk; pcNonce: string }): Promise<string> {
  return pairingCode({ secret: b64u.decode(deps.secret), phoneKey: deps.phoneKey, pcNonce: deps.pcNonce })
}

export type PairStatus =
  | { ok: true; status: 'pending'; expiresAt: number }
  | { ok: true; status: 'approved'; deviceId: string; passkeyChallenge?: string }
  | { ok: true; status: 'rejected' | 'expired' | 'locked' }
  | { ok: false; reason: 'invalid' | 'network' }

/** Polls the pairing outcome; the pcNonce proves this phone completed the request step. */
export async function pollPairStatus(deps: { fetch: FetchLike; offer: string; pcNonce: string; fp: string }): Promise<PairStatus> {
  let response: FetchResponse
  try {
    const query = `offer=${encodeURIComponent(deps.offer)}&pcNonce=${encodeURIComponent(deps.pcNonce)}&fp=${encodeURIComponent(deps.fp)}`
    response = await deps.fetch(`/api/pair/status?${query}`)
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (!response.ok) return { ok: false, reason: 'invalid' }
  const status = await response.json()
  if (!isRecord(status) || typeof status.status !== 'string') return { ok: false, reason: 'network' }
  if (status.status === 'pending' && typeof status.expiresAt === 'number') return { ok: true, status: 'pending', expiresAt: status.expiresAt }
  if (status.status === 'approved' && typeof status.deviceId === 'string') {
    return typeof status.passkeyChallenge === 'string'
      ? { ok: true, status: 'approved', deviceId: status.deviceId, passkeyChallenge: status.passkeyChallenge }
      : { ok: true, status: 'approved', deviceId: status.deviceId }
  }
  if (status.status === 'rejected' || status.status === 'expired' || status.status === 'locked') {
    return { ok: true, status: status.status }
  }
  return { ok: false, reason: 'network' }
}
