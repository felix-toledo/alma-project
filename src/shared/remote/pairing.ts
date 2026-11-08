// The pure pairing machine (plan 3): the PC and the phone share these transitions and the code.
// No clock, no storage, no transport: the caller passes `now` and holds the state between calls.

import { b64u, canonicalJwk, fingerprint, type PublicJwk } from './crypto'

/** A pairing offer lives 3 minutes from display (AC-4.6). */
export const OFFER_EXPIRES_MS = 180_000
/** Three wrong digits freeze the machine for 5 minutes (AC-4.7). */
export const PAIRING_LOCK_MS = 300_000
/** Wrong digits before the freeze (AC-4.7). */
export const MAX_ATTEMPTS = 3
/** The global pairing window (AC-4.9). */
export const PAIRING_WINDOW_MS = 60_000
/** Pairings per window, all phones together (AC-4.9). */
export const MAX_PAIRINGS_PER_WINDOW = 5

/** The QR material: raw secret bytes plus their text form. */
export interface Offer {
  secret: Uint8Array
  qr: string
}

export interface PairingOffered {
  phase: 'offered'
  pcNonce: string
  secret: Uint8Array
  offer: string
  createdAt: number
  attempts: number
}

export interface PairingAccepted {
  phase: 'accepted'
  pcNonce: string
  secret: Uint8Array
  offer: string
  createdAt: number
  accepted: { deviceKey: PublicJwk; deviceFp: string; deviceName: string }
  attempts: number
  acceptedAt: number
}

export interface PairingLocked {
  phase: 'locked'
  until: number
}

export type PairingState = 'idle' | PairingOffered | PairingAccepted | PairingLocked

export interface PairCodeInput {
  secret: Uint8Array
  phoneKey: PublicJwk
  pcNonce: string
}

/** The wire error vocabulary for the pairing endpoints. */
export type PairingErrorCode = 'expired' | 'busy' | 'locked' | 'rate_limited' | 'invalid' | 'mismatch'

/** A machine refusal, mapping 1:1 to HTTP. */
export type PairingRefusal = 'expired' | 'locked' | 'busy' | 'rate-limited'

/** What `present` reports: live and waiting, or why not. */
export type PresentOutcome = 'pending' | PairingRefusal

/** What `decide` reports on approval or rejection; both consume the offer. */
export type PairingDecision = 'consumed' | 'rejected'

type HmacKeyData = Parameters<typeof crypto.subtle.importKey>[1]
type HmacData = Parameters<typeof crypto.subtle.sign>[2]

/**
 * The 6 digits both screens show (PD-7): HMAC-SHA256 over the canonical phone key and the PC
 * nonce, truncated like an HOTP code. (Plan 3 names cyrb53 in passing; PD-7's HMAC decision wins:
 * the function is async because the MAC needs WebCrypto, and a non-crypto hash must never bind a key.)
 * The '|' keeps key and nonce unambiguous: neither canonical JWK nor base64url contains one.
 */
export async function pairingCode({ secret, phoneKey, pcNonce }: PairCodeInput): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret as HmacKeyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const body = new TextEncoder().encode(`${canonicalJwk(phoneKey)}|${pcNonce}`)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body as HmacData))
  const offset = mac[mac.length - 1] & 0x0f
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(code % 1_000_000).padStart(6, '0')
}

export interface NewOfferInput {
  state: PairingState
  now: number
  random?: (n: number) => Uint8Array
}

export interface NewOfferResult {
  state: PairingState
  offer?: Offer
  refusal?: 'busy' | 'locked'
}

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/**
 * A fresh offer, unless one is already live ('busy') or the machine is frozen ('locked').
 * An expired offer or a lapsed lock is discarded in place: the next offer starts clean.
 */
export function newOffer({ state, now, random = defaultRandom }: NewOfferInput): NewOfferResult {
  if (state !== 'idle' && state.phase === 'locked' && now < state.until) return { state, refusal: 'locked' }
  if (state !== 'idle' && state.phase !== 'locked' && now <= state.createdAt + OFFER_EXPIRES_MS) {
    return { state, refusal: 'busy' }
  }
  const secret = random(32)
  const qr = b64u.encode(secret)
  return {
    state: { phase: 'offered', pcNonce: b64u.encode(random(16)), secret, offer: qr, createdAt: now, attempts: 0 },
    offer: { secret, qr }
  }
}

export interface PresentInput {
  state: PairingState
  now: number
  pcNonce: string
  phoneKey: string
  rate: number
}

export interface PresentResult {
  expiresAt: number
  outcome: PresentOutcome
}

/**
 * The read-only gate every pairing endpoint runs first. The pcNonce proves the poller completed
 * the request step (scanning the QR alone reveals no nonce); the phoneKey fingerprint names the
 * key in flight, or '' when the PC wizard asks without naming one.
 */
export function present({ state, now, pcNonce, phoneKey, rate }: PresentInput): PresentResult {
  if (rate >= MAX_PAIRINGS_PER_WINDOW) return { expiresAt: 0, outcome: 'rate-limited' }
  if (state === 'idle') return { expiresAt: 0, outcome: 'expired' }
  if (state.phase === 'locked') {
    return now < state.until ? { expiresAt: state.until, outcome: 'locked' } : { expiresAt: 0, outcome: 'expired' }
  }
  if (now > state.createdAt + OFFER_EXPIRES_MS) return { expiresAt: 0, outcome: 'expired' }
  const expiresAt = state.createdAt + OFFER_EXPIRES_MS
  if (pcNonce !== state.pcNonce) return { expiresAt, outcome: 'busy' }
  if (state.phase === 'accepted' && phoneKey !== '' && phoneKey !== state.accepted.deviceFp) {
    return { expiresAt, outcome: 'busy' }
  }
  return { expiresAt, outcome: 'pending' }
}

export interface CodeInput {
  state: PairingState
  phoneKey: PublicJwk
  deviceName: string
  now: number
}

export type CodeResult = { state: PairingState; digits: string } | { state: PairingState; error: 'mismatch' }

/**
 * Binds the phone key to a fresh offer and shows the digits, or re-shows them for the bound key.
 * Anything else mismatches: the caller gates expiry and locks through `present` first for the
 * specific refusal. The shape of the key is the schema's job; only non-objects are refused here.
 */
export async function code({ state, phoneKey, deviceName, now }: CodeInput): Promise<CodeResult> {
  if (typeof phoneKey !== 'object' || phoneKey === null) return { state, error: 'mismatch' }
  if (state === 'idle' || state.phase === 'locked') return { state, error: 'mismatch' }
  if (now > state.createdAt + OFFER_EXPIRES_MS) return { state, error: 'mismatch' }
  const deviceFp = await fingerprint(phoneKey)
  if (state.phase === 'accepted') {
    if (deviceFp !== state.accepted.deviceFp) return { state, error: 'mismatch' }
    return { state, digits: await pairingCode({ secret: state.secret, phoneKey, pcNonce: state.pcNonce }) }
  }
  const bound: PairingState = {
    ...state,
    phase: 'accepted',
    accepted: { deviceKey: phoneKey, deviceFp, deviceName },
    acceptedAt: now
  }
  return { state: bound, digits: await pairingCode({ secret: state.secret, phoneKey, pcNonce: state.pcNonce }) }
}

export interface DecideInput {
  state: PairingState
  now: number
  approved: boolean
  digits: string
  attempts?: number
}

export type DecideResult =
  | { state: PairingState; decision: 'consumed'; device: { deviceKey: PublicJwk; deviceName: string } }
  | { state: PairingState; decision: 'rejected' }
  | { state: PairingState; error: PairingErrorCode }

/**
 * The person's answer from the PC. A rejection consumes the offer without comparing digits; an
 * approval recomputes the digits and consumes it on match. The lockout threshold rides along as
 * an input so the policy stays testable without sequences; callers omit it for the spec default.
 */
export async function decide({ state, now, approved, digits, attempts = MAX_ATTEMPTS }: DecideInput): Promise<DecideResult> {
  if (state === 'idle') return { state, error: 'invalid' }
  if (state.phase === 'locked') return { state, error: now < state.until ? 'locked' : 'expired' }
  if (state.phase === 'offered') return { state, error: 'invalid' }
  if (now > state.createdAt + OFFER_EXPIRES_MS) return { state, error: 'expired' }
  if (!approved) return { state: 'idle', decision: 'rejected' }
  const expected = await pairingCode({ secret: state.secret, phoneKey: state.accepted.deviceKey, pcNonce: state.pcNonce })
  if (digits !== expected) {
    const used = state.attempts + 1
    if (used >= attempts) return { state: { phase: 'locked', until: now + PAIRING_LOCK_MS }, error: 'locked' }
    return { state: { ...state, attempts: used }, error: 'mismatch' }
  }
  return {
    state: 'idle',
    decision: 'consumed',
    device: { deviceKey: state.accepted.deviceKey, deviceName: state.accepted.deviceName }
  }
}

/** The pairing machine as one injectable surface (plan 3). */
export const pairingExchanges = { newOffer, present, code, decide }
