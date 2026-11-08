// The Tailscale watchdog (T33): polls the daemon state, flips the channel on
// outages and recovery, and keeps the key countdown and rename flag current.
import { daysToExpiry, isHostRenamed } from '../../../shared/remote/tailscale'
import type { RemoteChannel } from './channel'

/** AC-8.2: the PC retries by itself on this cadence. */
export const MONITOR_MS = 30_000

export interface TailscaleProbe {
  connected: boolean
  keyExpiry: string | null
  dnsName: string | null
}

export interface TailscaleMonitorDeps {
  read(): Promise<TailscaleProbe>
  now(): number
  store: {
    readonly state: { hostName: string | null }
    update(patch: { hostName?: string | null }): Promise<void>
  }
  channel: Pick<RemoteChannel, 'reportOutage' | 'reportRecovery' | 'reportFacts'>
  notify(): void
}

export class TailscaleMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private seen = false
  private wasConnected = false
  private renamed = false

  constructor(private readonly deps: TailscaleMonitorDeps) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), MONITOR_MS)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * One poll (AC-8.2, 2.10, 2.15): facts every time, outage and recovery only
   * on observed transitions. A fresh monitor never notifies on its first read,
   * so a restarted process cannot double-notify an ongoing outage.
   */
  async poll(): Promise<void> {
    const { connected, keyExpiry, dnsName } = await this.deps.read()
    const days = daysToExpiry(keyExpiry, this.deps.now())
    const recorded = this.deps.store.state.hostName
    if (recorded === null && dnsName !== null) await this.deps.store.update({ hostName: dnsName })
    const changed = isHostRenamed(recorded, dnsName)
    if (changed && dnsName !== null) {
      await this.deps.store.update({ hostName: dnsName })
      this.renamed = true
    }
    this.deps.channel.reportFacts({
      keyExpiresInDays: days !== null && days <= 14 ? Math.max(0, days) : undefined,
      renamed: this.renamed || undefined
    })
    if (!connected && this.wasConnected) {
      this.deps.channel.reportOutage()
      this.deps.notify()
    } else if (connected && !this.wasConnected && this.seen) {
      await this.deps.channel.reportRecovery()
    }
    this.wasConnected = connected
    this.seen = true
  }
}
