// In-house WebAuthn verification (PD-5): `none` attestations and ES256 assertions only, with a
// tiny bounded CBOR reader. No dependency: @simplewebauthn/server would pull CBOR/ASN.1/X.509
// packages for features this spec does not use. Every failure is a code, never a throw.

import { b64u, verifyEs256, type PublicJwk } from './crypto'

/** Attestation objects and authenticator data over this are refused without parsing. */
export const WEBAUTHN_MAX_CBOR = 8192
/** CBOR nesting beyond this is refused; the `none` flow never nests past two. */
export const WEBAUTHN_MAX_DEPTH = 8

export type WebauthnError =
  | 'challenge'
  | 'origin'
  | 'type'
  | 'client-data'
  | 'rp-id'
  | 'flags'
  | 'key'
  | 'cbor'
  | 'format'
  | 'signature'
  | 'counter'

type Cbor = number | Uint8Array | string | Map<string | number, Cbor>
type DigestData = Parameters<typeof crypto.subtle.digest>[1]

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as DigestData))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

interface Reader {
  bytes: Uint8Array
  at: number
}

function readLength(reader: Reader, junior: number): number | null {
  if (junior < 24) return junior
  const need = junior === 24 ? 1 : junior === 25 ? 2 : junior === 26 ? 4 : junior === 27 ? 8 : -1
  if (need < 0 || reader.at + need > reader.bytes.length) return null
  let value = 0
  for (let i = 0; i < need; i++) value = value * 256 + reader.bytes[reader.at + i]
  if (!Number.isSafeInteger(value)) return null
  reader.at += need
  return value
}

function readItem(reader: Reader, depth: number): Cbor | null {
  if (depth > WEBAUTHN_MAX_DEPTH || reader.at >= reader.bytes.length) return null
  const head = reader.bytes[reader.at]
  reader.at++
  const major = head >> 5
  const junior = head & 0x1f
  if (junior === 31) return null
  if (major === 0 || major === 1) {
    const value = readLength(reader, junior)
    if (value === null) return null
    return major === 0 ? value : -1 - value
  }
  if (major === 2 || major === 3) {
    const length = readLength(reader, junior)
    if (length === null || reader.at + length > reader.bytes.length) return null
    const slice = reader.bytes.slice(reader.at, reader.at + length)
    reader.at += length
    if (major === 2) return slice
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice)
    } catch {
      return null
    }
  }
  if (major === 5) {
    const size = readLength(reader, junior)
    if (size === null) return null
    const map = new Map<string | number, Cbor>()
    for (let i = 0; i < size; i++) {
      const key = readItem(reader, depth + 1)
      const value = readItem(reader, depth + 1)
      if (value === null || (typeof key !== 'string' && typeof key !== 'number')) return null
      map.set(key, value)
    }
    return map
  }
  return null
}

/** Decodes one top-level item consuming every byte, or null. Arrays, tags, simple values refused. */
function decodeCbor(bytes: Uint8Array): Cbor | null {
  if (bytes.length > WEBAUTHN_MAX_CBOR) return null
  const reader: Reader = { bytes, at: 0 }
  const item = readItem(reader, 0)
  if (item === null || reader.at !== bytes.length) return null
  return item
}

/**
 * ECDSA signatures travel DER-encoded; subtle verifies raw r||s. Short-form lengths only:
 * P-256 signatures never need more, and anything else here is malformed.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] + 2 !== der.length) return null
  let at = 2
  const readInteger = (): Uint8Array | null => {
    if (der[at] !== 0x02) return null
    const length = der[at + 1]
    if (length < 1 || length > 33 || at + 2 + length > der.length) return null
    let body = der.slice(at + 2, at + 2 + length)
    at += 2 + length
    if (body[0] === 0) {
      if (body.length < 2 || body[1] < 0x80) return null
      body = body.slice(1)
    }
    if (body.length > 32) return null
    const padded = new Uint8Array(32)
    padded.set(body, 32 - body.length)
    return padded
  }
  const r = readInteger()
  const s = readInteger()
  if (!r || !s || at !== der.length) return null
  return Uint8Array.from([...r, ...s])
}

interface ClientData {
  challenge: Uint8Array
  origin: string
}

function parseClientData(bytes: Uint8Array, type: 'webauthn.create' | 'webauthn.get'): ClientData | WebauthnError {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return 'client-data'
  }
  if (typeof json !== 'object' || json === null) return 'client-data'
  const record = json as Record<string, unknown>
  if (record.type !== type) return 'type'
  if (typeof record.origin !== 'string' || typeof record.challenge !== 'string') return 'client-data'
  let challenge: Uint8Array
  try {
    challenge = b64u.decode(record.challenge)
  } catch {
    return 'client-data'
  }
  return { challenge, origin: record.origin }
}

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

interface AuthData {
  rpIdHash: Uint8Array
  flags: number
  counter: number
  rest: Uint8Array
}

function parseAuthData(bytes: Uint8Array): AuthData | null {
  if (bytes.length < 37) return null
  const counter = ((bytes[33] << 24) | (bytes[34] << 16) | (bytes[35] << 8) | bytes[36]) >>> 0
  return { rpIdHash: bytes.slice(0, 32), flags: bytes[32], counter, rest: bytes.slice(37) }
}

function coseToJwk(cose: Uint8Array): PublicJwk | 'cbor' | 'key' {
  const item = decodeCbor(cose)
  if (!(item instanceof Map)) return 'cbor'
  if (item.get(1) !== 2 || item.get(3) !== -7 || item.get(-1) !== 1) return 'key'
  const x = item.get(-2)
  const y = item.get(-3)
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) return 'key'
  return { kty: 'EC', crv: 'P-256', x: b64u.encode(x), y: b64u.encode(y) }
}

export interface RegistrationInput {
  attestationObject: Uint8Array
  clientDataJSON: Uint8Array
  challenge: Uint8Array
  origin: string
  rpId: string
}

export type RegistrationResult =
  | { ok: true; credentialId: Uint8Array; publicKey: PublicJwk; counter: number }
  | { ok: false; error: WebauthnError }

export async function verifyRegistration(input: RegistrationInput): Promise<RegistrationResult> {
  const client = parseClientData(input.clientDataJSON, 'webauthn.create')
  if (typeof client === 'string') return { ok: false, error: client }
  if (client.origin !== input.origin) return { ok: false, error: 'origin' }
  if (!bytesEqual(client.challenge, input.challenge)) return { ok: false, error: 'challenge' }
  const attestation = decodeCbor(input.attestationObject)
  if (!(attestation instanceof Map)) return { ok: false, error: 'cbor' }
  if (attestation.get('fmt') !== 'none') return { ok: false, error: 'format' }
  const statement = attestation.get('attStmt')
  if (!(statement instanceof Map) || statement.size !== 0) return { ok: false, error: 'format' }
  const authBytes = attestation.get('authData')
  if (!(authBytes instanceof Uint8Array)) return { ok: false, error: 'cbor' }
  const auth = parseAuthData(authBytes)
  if (!auth) return { ok: false, error: 'cbor' }
  if (!bytesEqual(auth.rpIdHash, await sha256(new TextEncoder().encode(input.rpId)))) return { ok: false, error: 'rp-id' }
  if ((auth.flags & (FLAG_UP | FLAG_UV)) !== (FLAG_UP | FLAG_UV)) return { ok: false, error: 'flags' }
  if ((auth.flags & FLAG_AT) === 0 || auth.rest.length < 18) return { ok: false, error: 'cbor' }
  const idLength = (auth.rest[16] << 8) | auth.rest[17]
  const credentialId = auth.rest.slice(18, 18 + idLength)
  if (credentialId.length !== idLength) return { ok: false, error: 'cbor' }
  const key = coseToJwk(auth.rest.slice(18 + idLength))
  if (typeof key === 'string') return { ok: false, error: key }
  return { ok: true, credentialId, publicKey: key, counter: auth.counter }
}

export interface AssertionInput {
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  signature: Uint8Array
  challenge: Uint8Array
  origin: string
  rpId: string
  publicKey: PublicJwk
  lastCounter: number
}

export type AssertionResult = { ok: true; counter: number } | { ok: false; error: WebauthnError }

export async function verifyAssertion(input: AssertionInput): Promise<AssertionResult> {
  const client = parseClientData(input.clientDataJSON, 'webauthn.get')
  if (typeof client === 'string') return { ok: false, error: client }
  if (client.origin !== input.origin) return { ok: false, error: 'origin' }
  if (!bytesEqual(client.challenge, input.challenge)) return { ok: false, error: 'challenge' }
  if (input.authenticatorData.length > WEBAUTHN_MAX_CBOR) return { ok: false, error: 'cbor' }
  const auth = parseAuthData(input.authenticatorData)
  if (!auth) return { ok: false, error: 'cbor' }
  if (!bytesEqual(auth.rpIdHash, await sha256(new TextEncoder().encode(input.rpId)))) return { ok: false, error: 'rp-id' }
  if ((auth.flags & (FLAG_UP | FLAG_UV)) !== (FLAG_UP | FLAG_UV)) return { ok: false, error: 'flags' }
  const raw = derToRawSignature(input.signature)
  if (!raw) return { ok: false, error: 'signature' }
  const signed = Uint8Array.from([...input.authenticatorData, ...(await sha256(input.clientDataJSON))])
  if (!(await verifyEs256(input.publicKey, signed, raw))) return { ok: false, error: 'signature' }
  // A moving counter must move; authenticators without one always send zero (WebAuthn §6.1).
  if (input.lastCounter !== 0 && auth.counter <= input.lastCounter) return { ok: false, error: 'counter' }
  return { ok: true, counter: auth.counter }
}
