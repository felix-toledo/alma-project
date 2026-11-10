// Spec 027 PD-11: the relay's own state, outages and test, apart from the channel (which only knows Tailscale's).
import type { AuditEvent } from '../../../shared/audit'
import type { RelayState } from '../../../shared/remote/relay-status'
import type { RelayTestCause, RelayTestResult } from '../../../shared/types'
import { auditRemote } from './audit'

export interface RelayControllerDeps {
  record(entry: AuditEvent): void
  notify(): void
  onChange(state: RelayState | null): void
}

export type { RelayTestCause, RelayTestResult }

export interface RelayProbes {
  internet(): Promise<boolean>
  connect(): Promise<RelayState>
  phone(): Promise<'none' | 'answered' | 'silent'>
}

export class RelayController {
  private state: RelayState | null = null
  private outage = false
  private renamed = false
  private emitted: string | null = null

  constructor(private readonly deps: RelayControllerDeps) {}

  /** The relay is the selected transport (true) or Tailscale is (false): with Tailscale there is no relay state at all. */
  select(selected: boolean): void {
    if (!selected) {
      this.outage = false
      this.state = null
    } else if (!this.state) this.state = { state: 'off' }
    this.emit()
  }

  /** What the connection reports. One notice and one audit entry per outage, however many retries it makes. */
  report(next: RelayState): void {
    if (!this.state) return
    const failed = next.state === 'error'
    if (failed && !this.outage) {
      this.outage = true
      auditRemote(this.deps.record, 'remote.relay.down', 'error')
      this.deps.notify()
    } else if (next.state === 'online' && this.outage) {
      this.outage = false
      auditRemote(this.deps.record, 'remote.relay.up', 'ok')
    } else if (next.state === 'off') this.outage = false
    // A retry in the middle of an outage is still the outage: the person keeps seeing the cause, not a flicker.
    const kept = this.outage && next.state === 'connecting' ? this.state : next
    this.state = { ...kept, ...(this.renamed ? { renamed: true } : {}) }
    this.emit()
  }

  /** The address the phones paired with is not the one this build uses (spec 027 AC-4.8). */
  setRenamed(renamed: boolean): void {
    this.renamed = renamed
    if (!this.state) return
    const { renamed: _before, ...rest } = this.state
    this.state = { ...rest, ...(renamed ? { renamed: true } : {}) }
    this.emit()
  }

  /** A phone's secure connection could not be verified: an audited, throttled failure, and the relay stays as it was. */
  handshakeFailed(): void {
    if (this.state) auditRemote(this.deps.record, 'remote.relay.handshake', 'denied')
  }

  current(): RelayState | null {
    return this.state ? { ...this.state } : null
  }

  private emit(): void {
    const key = JSON.stringify(this.state)
    if (key === this.emitted) return
    this.emitted = key
    this.deps.onChange(this.current())
  }
}

/**
 * The relay check, in order, ending at the first failure with exactly one cause: the PC's internet, then the relay
 * answering and accepting this PC's registration (what connecting settles to), then a paired phone answering a test
 * message if there is one. A step that throws is that step failing.
 */
export async function runRelayTest(probes: RelayProbes): Promise<RelayTestResult> {
  const attempt = async <T>(step: () => Promise<T>): Promise<T | null> => {
    try {
      return await step()
    } catch {
      return null
    }
  }
  if (!(await attempt(probes.internet))) return { ok: false, cause: 'noInternet' }
  const settled = await attempt(probes.connect)
  if (settled?.state !== 'online') return { ok: false, cause: settled?.state === 'error' && settled.failure ? settled.failure : 'relayUnreachable' }
  const phone = await attempt(probes.phone)
  if (phone === null || phone === 'silent') return { ok: false, cause: 'phoneSilent' }
  return { ok: true }
}
