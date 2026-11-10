import { b64u, signEs256, type PublicJwk } from './crypto'

/** The push services a subscription may point at (PD-15): nothing else is ever called. */
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com']
const PUSH_SUFFIXES = ['.push.apple.com', '.notify.windows.com']

function pushHostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (PUSH_HOSTS.includes(host)) return true
  return PUSH_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Whether a push subscription endpoint may be stored (AC-11.1, SSRF): https only,
 * no credentials, not a private host, and one of the known push services. The
 * private-host check is injected (the coordinator's own).
 */
export function allowedPushEndpoint(endpoint: string, isPrivate: (hostname: string) => boolean): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (isPrivate(url.hostname)) return false
  return pushHostAllowed(url.hostname)
}

/** The VAPID public key in uncompressed point form (b64u): the PushManager key and the JWT `k`. */
export function vapidPublicKey(publicKey: PublicJwk): string {
  if (!publicKey.x || !publicKey.y) throw new Error('vapid key without coordinates')
  const point = new Uint8Array(65)
  point[0] = 4
  point.set(b64u.decode(publicKey.x), 1)
  point.set(b64u.decode(publicKey.y), 33)
  return b64u.encode(point)
}

const encoder = new TextEncoder()

/**
 * The VAPID authorization for one push (PD-15): an ES256 JWT over this endpoint's
 * origin, valid 12 hours. The push itself carries an empty body (AC-11.1).
 */
export async function buildVapid(deps: {
  endpoint: string
  subject: string
  publicKey: PublicJwk
  privateKey: PublicJwk
  now: number
}): Promise<{ authorization: string }> {
  const header = b64u.encode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64u.encode(
    encoder.encode(JSON.stringify({ aud: new URL(deps.endpoint).origin, exp: Math.floor(deps.now / 1000) + 12 * 3600, sub: deps.subject }))
  )
  const signature = b64u.encode(await signEs256(deps.privateKey, encoder.encode(`${header}.${payload}`)))
  return { authorization: `vapid t=${header}.${payload}.${signature}, k=${vapidPublicKey(deps.publicKey)}` }
}

/** The whole plaintext of the greeting push (spec 033 D-1): a fixed code the phone maps to its own text, never content. */
export const GREETING_PUSH_CODE = 'g'

// Derived from the API: this module typechecks without the DOM lib (see crypto.ts).
type Bytes = Parameters<typeof crypto.subtle.digest>[1]
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey }
const RECORD_SIZE = 4096

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as Bytes, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as Bytes, info: info as Bytes }, key, length * 8))
}

/**
 * RFC 8291 Web Push encryption (aes128gcm, one record) to a subscription's `p256dh` and `auth`,
 * WebCrypto only. `salt` and `sender` are fixed only by the RFC vector test; normally both are fresh.
 */
export async function encryptPushPayload(input: {
  p256dh: string
  auth: string
  plaintext: Uint8Array
  salt?: Uint8Array
  sender?: KeyPair
}): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  // One record holds the plaintext, its 0x02 delimiter and the 16-byte tag.
  if (input.plaintext.length + 17 > RECORD_SIZE) throw new Error('push payload larger than one record')
  const receiverPublic = b64u.decode(input.p256dh)
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16))
  // A one-use key: its private half never leaves WebCrypto (the public half is exportable whatever this says).
  const sender = input.sender ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as KeyPair)
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey))
  const receiver = await crypto.subtle.importKey('raw', receiverPublic as Bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiver }, sender.privateKey, 256))
  const ikm = await hkdf(b64u.decode(input.auth), ecdh, concat(encoder.encode('WebPush: info\0'), receiverPublic, senderPublic), 32)
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek as Bytes, 'AES-GCM', false, ['encrypt'])
  // 0x02 marks the last (and only) record.
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as Bytes }, key, concat(input.plaintext, new Uint8Array([2])) as Bytes))
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = senderPublic.length
  return { body: concat(header, senderPublic, record), headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } }
}
