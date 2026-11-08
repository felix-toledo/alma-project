// A software WebAuthn authenticator for tests: ES256 credentials, `none` attestations and
// assertions, all through WebCrypto like a real platform authenticator (PD-5). The encodings
// (CBOR, COSE, DER) are minimal on purpose: exactly what the `none` + ES256 flow needs.

import { b64u, type PublicJwk } from '../../src/shared/remote/crypto'

export interface FakeCredential {
  credentialId: Uint8Array
  privateKey: CryptoKey
  publicKey: PublicJwk
}

export async function fakeCredential(): Promise<FakeCredential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as PublicJwk
  return { credentialId: crypto.getRandomValues(new Uint8Array(32)), privateKey: pair.privateKey, publicKey }
}

type CborValue = number | Uint8Array | string | Map<number | string, CborValue>

function encodeLength(major: number, length: number, out: number[]): void {
  if (length < 24) {
    out.push((major << 5) | length)
  } else if (length < 256) {
    out.push((major << 5) | 24, length)
  } else {
    out.push((major << 5) | 25, length >> 8, length & 0xff)
  }
}

/** Minimal definite-length CBOR: small integers, byte and text strings, maps with numeric keys. */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = []
  const encode = (item: CborValue): void => {
    if (typeof item === 'number') {
      if (item >= 0) encodeLength(0, item, out)
      else encodeLength(1, -1 - item, out)
    } else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item)
      encodeLength(3, bytes.length, out)
      for (const byte of bytes) out.push(byte)
    } else if (item instanceof Uint8Array) {
      encodeLength(2, item.length, out)
      for (const byte of item) out.push(byte)
    } else {
      encodeLength(5, item.size, out)
      for (const [key, entry] of item) {
        encode(key)
        encode(entry)
      }
    }
  }
  encode(value)
  return Uint8Array.from(out)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.length
  }
  return whole
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer))
}

/** COSE_Key for an ES256 public key: { 1: EC2, 3: ES256, -1: P-256, -2: x, -3: y }. */
export function coseKey(publicJwk: PublicJwk): Uint8Array {
  return encodeCbor(
    new Map<number | string, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, b64u.decode(publicJwk.x ?? '')],
      [-3, b64u.decode(publicJwk.y ?? '')]
    ])
  )
}

export interface FakeClientInput {
  challenge: Uint8Array
  origin: string
  rpId: string
}

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: Uint8Array, origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge: b64u.encode(challenge), origin, crossOrigin: false }))
}

async function authData(
  rpId: string,
  flags: number,
  counter: number,
  credential?: FakeCredential
): Promise<Uint8Array> {
  const head = concat(
    await sha256(new TextEncoder().encode(rpId)),
    Uint8Array.of(flags),
    Uint8Array.of((counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff)
  )
  if (!credential) return head
  const idLength = Uint8Array.of(credential.credentialId.length >> 8, credential.credentialId.length & 0xff)
  return concat(head, new Uint8Array(16), idLength, credential.credentialId, coseKey(credential.publicKey))
}

function derInteger(raw: Uint8Array): number[] {
  let start = 0
  while (start < raw.length - 1 && raw[start] === 0) start++
  const body = [...raw.slice(start)]
  if (body[0] !== undefined && body[0] >= 0x80) body.unshift(0)
  return [0x02, body.length, ...body]
}

/** ECDSA signatures travel DER-encoded; subtle signs raw, so the fake wraps it like hardware does. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.slice(0, 32)), ...derInteger(raw.slice(32, 64))]
  return Uint8Array.from([0x30, body.length, ...body])
}

export async function fakeAttestation(
  credential: FakeCredential,
  input: FakeClientInput & { counter?: number; flags?: number }
): Promise<{ attestationObject: Uint8Array; clientDataJSON: Uint8Array }> {
  const data = await authData(input.rpId, input.flags ?? 0x45, input.counter ?? 0, credential)
  const attestationObject = encodeCbor(
    new Map<number | string, CborValue>([
      ['fmt', 'none'],
      ['authData', data],
      ['attStmt', new Map<number | string, CborValue>()]
    ])
  )
  return { attestationObject, clientDataJSON: clientData('webauthn.create', input.challenge, input.origin) }
}

export async function fakeAssertion(
  credential: FakeCredential,
  input: FakeClientInput & { counter: number; flags?: number; type?: 'webauthn.create' | 'webauthn.get' }
): Promise<{ authenticatorData: Uint8Array; clientDataJSON: Uint8Array; signature: Uint8Array }> {
  const authenticatorData = await authData(input.rpId, input.flags ?? 0x45, input.counter)
  const clientDataJSON = clientData(input.type ?? 'webauthn.get', input.challenge, input.origin)
  const signed = concat(authenticatorData, await sha256(clientDataJSON))
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, credential.privateKey, signed as unknown as ArrayBuffer))
  return { authenticatorData, clientDataJSON, signature: rawToDer(raw) }
}
