import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PublicJwk } from '../../../shared/remote/crypto'
import { bareDnsName } from '../../../shared/remote/tailscale'
import type { DeviceView } from '../../../shared/types'

export interface DevicePasskey {
  credentialId: string
  publicKey: PublicJwk
  counter: number
}

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface DeviceRecord {
  id: string
  name: string
  pairedAt: number
  lastSeen: number | null
  publicKey: PublicJwk
  passkey: DevicePasskey | null
  push: PushSubscription | null
}

export interface KeyPair {
  public: PublicJwk
  private: PublicJwk
}

export interface RemoteState {
  threadId: string | null
  port: number | null
  hostName: string | null
  pcKey: KeyPair
  vapid: KeyPair
}

export interface SealBox {
  seal(plain: string): Promise<string>
  open(sealed: string): Promise<string>
}

export interface DeviceStoreDeps {
  dir: string
  now: () => number
  sealBox: SealBox
  randomId?: () => string
}

export interface RemoteStateDeps {
  dir: string
  sealBox: SealBox
}

export const DEVICE_IDLE_MS = 15 * 24 * 3_600 * 1_000
export const MAX_DEVICES = 5

/** Window rows for the device list; dormancy is global (remote off), mapped per row. */
export function deviceViews(devices: readonly DeviceRecord[], dormant: boolean): DeviceView[] {
  return devices.map((device) => ({ id: device.id, name: device.name, pairedAt: device.pairedAt, lastSeen: device.lastSeen, dormant }))
}

/** Idle past 15 days from the last use (or pairing, when never used); exactly 15 days is not expired (AC-6.7). */
export function expiredDevices(devices: readonly DeviceRecord[], now: number): DeviceRecord[] {
  return devices.filter((device) => now - (device.lastSeen ?? device.pairedAt) > DEVICE_IDLE_MS)
}

interface StoredDevice {
  id: string
  name: string
  pairedAt: number
  lastSeen: number | null
  publicKey: PublicJwk
  passkey: DevicePasskey | null
  pushSealed: string | null
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.pairedAt === 'number' &&
    (row.lastSeen === null || typeof row.lastSeen === 'number') &&
    typeof row.publicKey === 'object' &&
    row.publicKey !== null &&
    (row.passkey === null || typeof row.passkey === 'object') &&
    (row.pushSealed === null || typeof row.pushSealed === 'string')
  )
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
}

export class DeviceStore {
  private constructor(
    private readonly deps: DeviceStoreDeps,
    private list: DeviceRecord[]
  ) {}

  static async load(deps: DeviceStoreDeps): Promise<DeviceStore> {
    const file = join(deps.dir, 'devices.json')
    if (!existsSync(file)) return new DeviceStore(deps, [])
    try {
      const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(stored)) {
        console.error('[remote] devices file is corrupt; starting with no devices')
        return new DeviceStore(deps, [])
      }
      const list: DeviceRecord[] = []
      for (const row of stored) {
        if (!isStoredDevice(row)) continue
        let push: PushSubscription | null = null
        if (row.pushSealed) {
          try {
            push = JSON.parse(await deps.sealBox.open(row.pushSealed)) as PushSubscription
          } catch {
            console.error('[remote] a push subscription cannot be unsealed; the device keeps working without push')
          }
        }
        list.push({ id: row.id, name: row.name, pairedAt: row.pairedAt, lastSeen: row.lastSeen, publicKey: row.publicKey, passkey: row.passkey, push })
      }
      return new DeviceStore(deps, list)
    } catch {
      console.error('[remote] devices file is corrupt; starting with no devices')
      return new DeviceStore(deps, [])
    }
  }

  devices(): DeviceRecord[] {
    return this.list.map((device) => ({ ...device }))
  }

  /** Null when 5 devices are already stored, or the id is taken (AC-4.11). */
  async add(device: { name: string; publicKey: PublicJwk; id?: string }): Promise<DeviceRecord | null> {
    const id = device.id ?? (this.deps.randomId ?? randomUUID)()
    if (this.list.length >= MAX_DEVICES || this.list.some((known) => known.id === id)) return null
    const record: DeviceRecord = { id, name: device.name, pairedAt: this.deps.now(), lastSeen: null, publicKey: device.publicKey, passkey: null, push: null }
    this.list.push(record)
    await this.save()
    return { ...record }
  }

  async remove(id: string): Promise<void> {
    const before = this.list.length
    this.list = this.list.filter((device) => device.id !== id)
    if (this.list.length !== before) await this.save()
  }

  async touch(id: string): Promise<void> {
    const device = this.list.find((known) => known.id === id)
    if (!device) return
    device.lastSeen = this.deps.now()
    await this.save()
  }

  async setPasskey(id: string, passkey: DevicePasskey | null): Promise<void> {
    const device = this.list.find((known) => known.id === id)
    if (!device) return
    device.passkey = passkey
    await this.save()
  }

  async setPush(id: string, push: PushSubscription | null): Promise<void> {
    const device = this.list.find((known) => known.id === id)
    if (!device) return
    device.push = push
    await this.save()
  }

  private async save(): Promise<void> {
    const stored: StoredDevice[] = []
    for (const device of this.list) {
      stored.push({
        id: device.id,
        name: device.name,
        pairedAt: device.pairedAt,
        lastSeen: device.lastSeen,
        publicKey: device.publicKey,
        passkey: device.passkey,
        pushSealed: device.push ? await this.deps.sealBox.seal(JSON.stringify(device.push)) : null
      })
    }
    writeAtomic(join(this.deps.dir, 'devices.json'), JSON.stringify(stored, null, 2))
  }
}

interface StoredState {
  threadId: string | null
  port: number | null
  hostName: string | null
  pcKey: { public: PublicJwk; privateSealed: string }
  vapid: { public: PublicJwk; privateSealed: string }
}

function isStoredState(value: unknown): value is StoredState {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  const pair = (entry: unknown): boolean => {
    if (typeof entry !== 'object' || entry === null) return false
    const keys = entry as Record<string, unknown>
    return typeof keys.public === 'object' && keys.public !== null && typeof keys.privateSealed === 'string'
  }
  return (
    (row.threadId === null || typeof row.threadId === 'string') &&
    (row.port === null || typeof row.port === 'number') &&
    (row.hostName === null || typeof row.hostName === 'string') &&
    pair(row.pcKey) &&
    pair(row.vapid)
  )
}

async function newPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  return { public: await crypto.subtle.exportKey('jwk', pair.publicKey), private: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

export class RemoteStateStore {
  private constructor(
    private readonly deps: RemoteStateDeps,
    private current: RemoteState
  ) {}

  static async load(deps: RemoteStateDeps): Promise<RemoteStateStore> {
    const fresh = async (): Promise<RemoteStateStore> => {
      const store = new RemoteStateStore(deps, { threadId: null, port: null, hostName: null, pcKey: await newPair(), vapid: await newPair() })
      await store.save()
      return store
    }
    const file = join(deps.dir, 'state.json')
    if (!existsSync(file)) return fresh()
    try {
      const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!isStoredState(stored)) {
        console.error('[remote] state file is corrupt; starting fresh with new keys')
        return fresh()
      }
      const store = new RemoteStateStore(deps, {
        threadId: stored.threadId,
        port: stored.port,
        hostName: stored.hostName === null ? null : bareDnsName(stored.hostName),
        pcKey: { public: stored.pcKey.public, private: JSON.parse(await deps.sealBox.open(stored.pcKey.privateSealed)) as PublicJwk },
        vapid: { public: stored.vapid.public, private: JSON.parse(await deps.sealBox.open(stored.vapid.privateSealed)) as PublicJwk }
      })
      return store
    } catch {
      console.error('[remote] state file is corrupt; starting fresh with new keys')
      return fresh()
    }
  }

  get state(): RemoteState {
    return { ...this.current }
  }

  async update(patch: { threadId?: string | null; port?: number | null; hostName?: string | null }): Promise<void> {
    const next = { ...this.current, ...patch }
    if (next.hostName !== null) next.hostName = bareDnsName(next.hostName)
    this.current = next
    await this.save()
  }

  private async save(): Promise<void> {
    const stored: StoredState = {
      threadId: this.current.threadId,
      port: this.current.port,
      hostName: this.current.hostName,
      pcKey: { public: this.current.pcKey.public, privateSealed: await this.deps.sealBox.seal(JSON.stringify(this.current.pcKey.private)) },
      vapid: { public: this.current.vapid.public, privateSealed: await this.deps.sealBox.seal(JSON.stringify(this.current.vapid.private)) }
    }
    writeAtomic(join(this.deps.dir, 'state.json'), JSON.stringify(stored, null, 2))
  }
}
