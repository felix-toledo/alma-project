// WebCrypto and globals only (atob/btoa, TextEncoder): this module also runs on the phone (plan 2.1).

/** The public-key members we read; structurally a JsonWebKey (named locally: no node: imports here). */
export interface PublicJwk {
  kty?: string
  crv?: string
  x?: string
  y?: string
  ext?: boolean
  key_ops?: string[]
  alg?: string
  kid?: string
  use?: string
}

/** Base64url with no padding. `decode` throws on malformed input; callers map that to `invalid`. */
export const b64u = {
  encode(bytes: Uint8Array): string {
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  },
  decode(text: string): Uint8Array {
    let padded = text.replaceAll('-', '+').replaceAll('_', '/')
    while (padded.length % 4) padded += '='
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
}

/** The key material in a fixed member order, so reordered or extended JWKs match. */
export function canonicalJwk(publicKey: PublicJwk): string {
  return JSON.stringify({ crv: publicKey.crv, kty: publicKey.kty, x: publicKey.x, y: publicKey.y })
}

/** SHA-256 over the canonical key material. */
export async function fingerprint(publicKey: PublicJwk): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJwk(publicKey)))
  return b64u.encode(new Uint8Array(digest))
}

type VerifySignature = Parameters<typeof crypto.subtle.verify>[2]
type VerifyData = Parameters<typeof crypto.subtle.verify>[3]
type SignData = Parameters<typeof crypto.subtle.sign>[2]

/** An exported JWK carries the usages it was generated with; drop them so any operation can import the material. */
function bareJwk(key: PublicJwk): PublicJwk {
  const { key_ops: _usages, ...bare } = key
  return bare
}

/** ES256 signing with a JWK private key (the PC identity key, the VAPID key). Throws on a bad key. */
export async function signEs256(privateKey: PublicJwk, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('jwk', bareJwk(privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data as SignData))
}

/** ES256 (P-256 + SHA-256) verification. Anything malformed reads as a rejection, never a throw. */
export async function verifyEs256(publicKey: PublicJwk, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', bareJwk(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as VerifySignature, data as VerifyData)
  } catch {
    return false
  }
}
