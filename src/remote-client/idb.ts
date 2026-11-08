import type { PwaStorage, StoredDevice, StoredSession } from './lib/storage'

const DB_NAME = 'alma-remote'
const DB_VERSION = 1
const STORE = 'kv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function read<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

async function write(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

/**
 * The phone's storage on IndexedDB (T41): the device key (non-extractable, kept as
 * a CryptoKey the browser holds) and the session. Structured-clone safe.
 */
export function idbStorage(): PwaStorage {
  const db = openDb()
  return {
    loadDevice: async () => read<StoredDevice>(await db, 'device'),
    saveDevice: async (device) => {
      await write(await db, 'device', device)
    },
    loadSession: async () => read<StoredSession>(await db, 'session'),
    saveSession: async (session) => {
      await write(await db, 'session', session)
    },
    clear: async () => {
      const database = await db
      return new Promise((resolve, reject) => {
        const request = database.transaction(STORE, 'readwrite').objectStore(STORE).clear()
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    }
  }
}
