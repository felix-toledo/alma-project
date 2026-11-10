// WebCrypto wrappers for the relay's end-to-end layer (spec 027 BR-24): ECDH P-256, HKDF-SHA-256, AES-256-GCM.
// Globals only (crypto.subtle): this module also runs on the phone and on the relay.

type Data = Parameters<typeof crypto.subtle.digest>[1]
type HmacKeyData = Parameters<typeof crypto.subtle.importKey>[1]

const SHA_LENGTH = 32
const GCM_TAG_BYTES = 16

export interface EcdhPair {
  /** The raw uncompressed point: 0x04 then x then y, 65 bytes. */
  publicKey: Uint8Array
  /** Non-extractable: an ephemeral key never leaves the process that made it. */
  privateKey: CryptoKey
}

export async function generateEcdh(): Promise<EcdhPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { publicKey, privateKey: pair.privateKey }
}

/** The shared x coordinate (32 bytes), or null when the peer's point is not a valid P-256 point. */
export async function ecdhSecret(privateKey: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array | null> {
  try {
    const peer = await crypto.subtle.importKey('raw', peerPublic as Data, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256))
  } catch {
    return null
  }
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key as HmacKeyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data as Data))
}

/** RFC 5869 extract: WebCrypto's HKDF only offers extract and expand together, so extract is the HMAC it is defined as. */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmac(salt.length ? salt : new Uint8Array(SHA_LENGTH), ikm)
}

/** RFC 5869 expand. */
export async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length < 0 || length > 255 * SHA_LENGTH) throw new RangeError('hkdf length out of range')
  const out = new Uint8Array(length)
  let block: Uint8Array = new Uint8Array()
  for (let i = 1, filled = 0; filled < length; i++) {
    const input = new Uint8Array(block.length + info.length + 1)
    input.set(block)
    input.set(info, block.length)
    input[input.length - 1] = i
    block = await hmac(prk, input)
    out.set(block.subarray(0, length - filled), filled)
    filled += block.length
  }
  return out
}

/** Only a 32-byte key is accepted, so no shorter AES variant can be chosen. */
export async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== SHA_LENGTH) throw new RangeError('aes key must be 32 bytes')
  return crypto.subtle.importKey('raw', raw as Data, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** Ciphertext followed by the 16-byte tag. The caller owns the nonce: it must never repeat under one key. */
export async function aesSeal(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as Data, additionalData: aad as Data, tagLength: GCM_TAG_BYTES * 8 }, key, plaintext as Data)
  return new Uint8Array(sealed)
}

/** The plaintext, or null when the tag does not verify (any tampering, wrong key, nonce or aad). */
export async function aesOpen(key: CryptoKey, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < GCM_TAG_BYTES) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as Data, additionalData: aad as Data, tagLength: GCM_TAG_BYTES * 8 }, key, sealed as Data)
    return new Uint8Array(plain)
  } catch {
    return null
  }
}

/** 4 zero bytes then the counter in 8 big-endian bytes (PD-4). One key per direction and one counter per message keep every nonce unique. */
export function nonceFor(ctr: number): Uint8Array {
  if (!Number.isSafeInteger(ctr) || ctr < 0) throw new RangeError('counter out of range')
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(ctr))
  return nonce
}
