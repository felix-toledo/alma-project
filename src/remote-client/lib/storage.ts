import type { PublicJwk } from '../../shared/remote/crypto'
import type { FetchLike } from './session'

/** What the phone keeps of its pairing: the device id and the non-extractable key. */
export interface StoredDevice {
  deviceId: string
  privateKey: CryptoKey
  publicJwk: PublicJwk
}

export interface StoredSession {
  token: string
  expiresAt: number
}

/**
 * The phone's storage behind an interface (T41): IndexedDB in the app
 * (`../idb.ts`), memory in tests. Push subscriptions join in T46.
 */
export interface PwaStorage {
  loadDevice(): Promise<StoredDevice | null>
  saveDevice(device: StoredDevice): Promise<void>
  loadSession(): Promise<StoredSession | null>
  saveSession(session: StoredSession): Promise<void>
  /** The PC's key, learned and checked when pairing through a channel that does not carry it in the address; null when the PC was reached directly. */
  loadPcKey(): Promise<PublicJwk | null>
  savePcKey(key: PublicJwk): Promise<void>
  clear(): Promise<void>
}

export function memoryStorage(): PwaStorage {
  let device: StoredDevice | null = null
  let session: StoredSession | null = null
  let pcKey: PublicJwk | null = null
  return {
    loadDevice: async () => device,
    saveDevice: async (next) => {
      device = next
    },
    loadSession: async () => session,
    saveSession: async (next) => {
      session = next
    },
    loadPcKey: async () => pcKey,
    savePcKey: async (next) => {
      pcKey = next
    },
    clear: async () => {
      device = null
      session = null
      pcKey = null
    }
  }
}

/** The slice of the Cache API the wipe needs (AC-8.5): every shell cache goes. */
export interface CacheStore {
  keys(): Promise<string[]>
  delete(name: string): Promise<boolean>
}

/**
 * Forgets everything on the phone (AC-5.3, AC-8.5): the key, the session and
 * every cache. The caller tells the PC first when it can (`/api/forget`); the
 * wipe itself never depends on the network.
 */
export async function wipePwa(deps: { storage: PwaStorage; caches: CacheStore }): Promise<void> {
  await deps.storage.clear()
  for (const name of await deps.caches.keys()) await deps.caches.delete(name)
}

/**
 * "Forget this PC" (AC-6.10): tells the PC to drop the device, then wipes the
 * phone. The wipe never depends on the answer: an unreachable PC still loses
 * the phone, and the phone still loses everything.
 */
export async function forgetPc(deps: { fetch: FetchLike; token: string; storage: PwaStorage; caches: CacheStore }): Promise<void> {
  try {
    await deps.fetch('/api/forget', {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}` }
    })
  } catch {
    // Unreachable: the wipe below still runs.
  }
  await wipePwa(deps)
}
