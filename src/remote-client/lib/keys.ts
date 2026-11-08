import type { PublicJwk } from '../../shared/remote/crypto'

export interface DeviceKey {
  publicJwk: PublicJwk
  privateKey: CryptoKey
}

/**
 * The phone's own key (BR-22): P-256, generated non-extractable so the private
 * half never leaves the browser's storage, signing only.
 */
export async function generateDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as PublicJwk
  return { publicJwk, privateKey: pair.privateKey }
}

/** Signs raw bytes (a session nonce) with the non-extractable private key. */
export async function signWithDeviceKey(privateKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes as unknown as ArrayBuffer)
  return new Uint8Array(signature)
}
