import type { AuditEvent } from '../../../shared/audit'
import { REMOTE_LIMITS } from '../../../shared/remote/api'
import { b64u } from '../../../shared/remote/crypto'
import type { DeviceView, RemoteSettings } from '../../../shared/types'
import { auditRemote } from './audit'
import { deviceViews, expiredDevices, type DeviceStore } from './store'

/** The idle sweep runs hourly (T25). */
export const SWEEP_MS = 3_600_000

/** One row of remote-devices.json: names and dates, never key material (AC-9.5). */
export interface DeviceExportRow {
  name: string
  pairedAt: number
  lastSeenAt: number | null
}

export function deviceExportList(devices: { name: string; pairedAt: number; lastSeen: number | null }[]): DeviceExportRow[] {
  return devices.map((device) => ({ name: device.name, pairedAt: device.pairedAt, lastSeenAt: device.lastSeen }))
}

export interface DevicesAdminDeps {
  settings(): { remote: RemoteSettings }
  now(): number
  random(length: number): Uint8Array
  store: DeviceStore
  revokeSessions(deviceId: string): void
  closeConnections(deviceId: string): void
  onDevices(devices: DeviceView[]): void
  confirmRevokeAll(): Promise<boolean>
  /** The device lost its access (revoke, forget, sweep): whatever it had running must stop (spec 028 BR-35). */
  onDeviceGone(deviceId: string): void
  /** The window learns whether the phone answered (T35 wires it to the wizard). */
  onTestResult(deviceId: string, ok: boolean): void
  record(entry: AuditEvent): void
}

interface PendingPing {
  id: string
  at: number
}

/**
 * Device administration (T25): revoke, revoke-all, forget, the idle sweep and the
 * connection test. Revocation is PC-only (AC-6.6): the narrow API only forgets itself.
 * Audit actions are this task's; T26 owns the mapping and may rename them.
 */
export class DevicesAdmin {
  private readonly pings = new Map<string, PendingPing>()

  constructor(private readonly deps: DevicesAdminDeps) {}

  /**
   * Revokes one device (AC-6.2): the record leaves the list, its sessions die and its
   * connections are cut at once, and the revocation is audited; earlier entries stay.
   * Unknown ids are harmless (connections are still cut: nothing of theirs may linger).
   */
  async revoke(deviceId: string): Promise<void> {
    const known = this.deps.store.devices().some((device) => device.id === deviceId)
    await this.deps.store.remove(deviceId)
    this.deps.revokeSessions(deviceId)
    this.deps.closeConnections(deviceId)
    this.deps.onDeviceGone(deviceId)
    if (!known) return
    this.emit()
    auditRemote(this.deps.record, 'remote.device.revoke', 'ok', deviceId, { actor: 'user', target: deviceId })
  }

  /** Revokes every device, but only after the native confirmation (AC-6.5). */
  async revokeAll(): Promise<{ ok: true } | { ok: false }> {
    if (!(await this.deps.confirmRevokeAll())) return { ok: false }
    for (const device of this.deps.store.devices()) await this.revoke(device.id)
    return { ok: true }
  }

  /**
   * Erases every device for privacy.erase (AC-9.4): the person already confirmed,
   * so no second confirmation. Push subscriptions die with their record (they live
   * in it since T46). Returns the count for the erase audit entry (counts only).
   */
  async eraseAll(): Promise<{ devices: number }> {
    const devices = this.deps.store.devices()
    for (const device of devices) await this.revoke(device.id)
    return { devices: devices.length }
  }

  /** "Forget this PC" from the phone itself (AC-6.10): the pipeline audits the change. */
  async forget(deviceId: string): Promise<void> {
    await this.deps.store.remove(deviceId)
    this.deps.revokeSessions(deviceId)
    this.deps.closeConnections(deviceId)
    this.deps.onDeviceGone(deviceId)
    this.emit()
  }

  /**
   * Removes devices idle past 15 days, dormant or not (AC-6.9): the idle clock keeps
   * running while remote access is off, so this also runs at start, not only hourly.
   * Push subscriptions go with the record in T46.
   */
  async sweep(): Promise<void> {
    const expired = expiredDevices(this.deps.store.devices(), this.deps.now())
    if (!expired.length) return
    for (const device of expired) {
      await this.deps.store.remove(device.id)
      this.deps.revokeSessions(device.id)
      this.deps.closeConnections(device.id)
      this.deps.onDeviceGone(device.id)
      auditRemote(this.deps.record, 'remote.device.sweep', 'ok', device.id, { actor: 'system', target: device.id })
    }
    this.emit()
  }

  /**
   * Tests one device (AC-2.5): the ping id travels through the full channel inside
   * /api/state, and the phone answers it through /api/pong within 10 seconds.
   * Unknown devices get no ping.
   */
  test(deviceId: string): string | null {
    if (!this.deps.store.devices().some((device) => device.id === deviceId)) return null
    const id = b64u.encode(this.deps.random(16))
    this.pings.set(deviceId, { id, at: this.deps.now() })
    return id
  }

  /** The pending ping of one device for /api/state, if it is still fresh. */
  statePing(deviceId: string): string | undefined {
    const pending = this.pings.get(deviceId)
    if (!pending) return undefined
    if (this.deps.now() - pending.at >= REMOTE_LIMITS.testWaitMs) {
      this.pings.delete(deviceId)
      return undefined
    }
    return pending.id
  }

  /**
   * Answers a test ping. A late, repeated or foreign id is refused the same way
   * (the PWA shows remote.pwa.phoneSilent); only a fresh match reports success.
   */
  pong(deviceId: string, pingId: string): { ok: true } | { ok: false } {
    const pending = this.pings.get(deviceId)
    if (!pending || pending.id !== pingId || this.deps.now() - pending.at >= REMOTE_LIMITS.testWaitMs) {
      return { ok: false }
    }
    this.pings.delete(deviceId)
    this.deps.onTestResult(deviceId, true)
    return { ok: true }
  }

  /** The current device list for the window's `remote.devices` (T37). */
  list(): DeviceView[] {
    return deviceViews(this.deps.store.devices(), !this.deps.settings().remote.enabled)
  }

  private emit(): void {
    this.deps.onDevices(this.list())
  }
}
