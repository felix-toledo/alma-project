import { REMOTE_LIMITS } from '../../../shared/remote/api'

const MINUTE_MS = 60_000

/** Pure counters with an injected clock: no timers of its own. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly connections = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** 60 requests per minute per device, sliding window (AC-10.2). */
  takeRequest(deviceId: string): boolean {
    return this.take(`req:${deviceId}`, REMOTE_LIMITS.requestsPerMinute)
  }

  /** 5 pairing requests per minute across all phones (AC-4.9). */
  takePairing(): boolean {
    return this.take('pairing', REMOTE_LIMITS.pairingPerMinute)
  }

  /** 2 simultaneous connections per device (AC-10.3). */
  open(deviceId: string): boolean {
    const current = this.connections.get(deviceId) ?? 0
    if (current >= REMOTE_LIMITS.connectionsPerDevice) return false
    this.connections.set(deviceId, current + 1)
    return true
  }

  /** Releasing is idempotent: a connection released twice (or never opened) frees one slot at most. */
  close(deviceId: string): void {
    const current = this.connections.get(deviceId) ?? 0
    if (current <= 1) this.connections.delete(deviceId)
    else this.connections.set(deviceId, current - 1)
  }

  private take(key: string, max: number): boolean {
    const now = this.now()
    const fresh = (this.hits.get(key) ?? []).filter((at) => at > now - MINUTE_MS)
    if (fresh.length >= max) {
      this.hits.set(key, fresh)
      return false
    }
    fresh.push(now)
    this.hits.set(key, fresh)
    return true
  }
}

/** A request body over 1 MB is rejected before processing (AC-10.1). */
export function exceedsRequestBytes(bytes: number): boolean {
  return bytes > REMOTE_LIMITS.requestBytes
}
