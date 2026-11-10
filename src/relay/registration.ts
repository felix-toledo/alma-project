import { b64u, fingerprint, type PublicJwk, verifyEs256 } from '../shared/remote/crypto'
import { registrationMessage } from '../shared/remote/relay-frame'

export type Registration = { ok: true; keyHash: string } | { ok: false }
/** What to do with a PC that proved a key while the room holds `current` (the hash of the live PC's key, or null). */
export type Claim = 'accept' | 'replace' | 'refuse'

export function newChallenge(random: (length: number) => Uint8Array): Uint8Array {
  return random(32)
}

/** The PC proves it holds the key it announces by signing the challenge for this routing id. The relay learns the key's hash and nothing else. */
export async function checkRegistration(routingId: string, nonce: Uint8Array, pub: PublicJwk, sig: string): Promise<Registration> {
  try {
    if (!(await verifyEs256(pub, registrationMessage(routingId, nonce), b64u.decode(sig)))) return { ok: false }
    return { ok: true, keyHash: await fingerprint(pub) }
  } catch {
    return { ok: false }
  }
}

export function claim(current: string | null, incoming: string): Claim {
  if (current === null) return 'accept'
  return current === incoming ? 'replace' : 'refuse'
}
