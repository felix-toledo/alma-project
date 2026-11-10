import { allowedPushEndpoint, buildVapid, encryptPushPayload, GREETING_PUSH_CODE, vapidPublicKey } from '../../../shared/remote/push'
import type { Settings } from '../../../shared/types'
import type { RunTies } from './runs'
import type { DeviceStore, RemoteStateStore } from './store'

/** The only outbound call remote access ever makes (AC-9.1): one POST per approval push and per greeting push (033 BR-30). */
export interface PushPost {
  (url: string, headers: Record<string, string>, body: Uint8Array): Promise<{ ok: boolean }>
}

export interface PushFlowDeps {
  store: DeviceStore
  state: RemoteStateStore
  settings(): Settings
  now(): number
  threadId(): string
  /** Who started a conversation's run: its approvals are pushed to that device only (AC-4.7). */
  ties: RunTies
  post: PushPost
  isPrivate(hostname: string): boolean
}

interface SubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * Approval pushes without content (T46/PD-15): the phone is told *that* Alma needs
 * it, never what for. Subscriptions live sealed with the device record and die with
 * it (revoke, erase, unsubscribe); a failed send leaves the approval pending.
 */
export class PushFlow {
  constructor(private readonly deps: PushFlowDeps) {}

  /** The VAPID public key for PushManager.subscribe. */
  key(): string {
    return vapidPublicKey(this.deps.state.state.vapid.public)
  }

  /** Stores one device's subscription after the endpoint checks; invalid stays out. */
  async subscribe(deviceId: string, input: SubscriptionInput): Promise<{ ok: true } | { ok: false; reason: 'invalid' }> {
    if (
      typeof input.endpoint !== 'string' ||
      typeof input.keys?.p256dh !== 'string' ||
      input.keys.p256dh.length === 0 ||
      typeof input.keys?.auth !== 'string' ||
      input.keys.auth.length === 0 ||
      !allowedPushEndpoint(input.endpoint, this.deps.isPrivate)
    ) {
      return { ok: false, reason: 'invalid' }
    }
    await this.deps.store.setPush(deviceId, { endpoint: input.endpoint, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } })
    return { ok: true }
  }

  async unsubscribe(deviceId: string): Promise<void> {
    await this.deps.store.setPush(deviceId, null)
  }

  /**
   * Notifies the devices that can answer an approval (AC-11.2, AC-4.7): every subscribed
   * device for the shared remote thread, only the starter of a by-id run, nothing for any
   * other thread, when the approve scope is off or without a subscription. Each send is an empty body with a VAPID authorization; failures
   * are silent (the approval stays pending, AC-11.5).
   */
  async notify(threadId: string): Promise<void> {
    if (!this.deps.settings().remote.scopes.approve) return
    const owner = threadId === this.deps.threadId() ? null : this.deps.ties.ownerOf(threadId)
    if (threadId !== this.deps.threadId() && !owner) return
    for (const device of this.deps.store.devices()) {
      if (!device.push || (owner && device.id !== owner)) continue
      try {
        const { authorization } = await this.vapid(device.push.endpoint)
        await this.deps.post(device.push.endpoint, { authorization, TTL: '3600' }, new Uint8Array(0))
      } catch {
        // A dead push service must not lose the approval.
      }
    }
  }

  /**
   * The morning greeting (spec 033 BR-30, D-1): with remote access and the History scope on, every subscribed
   * device gets the fixed code encrypted to its own keys, never any text. Failures are silent and not retried (AC-7.6).
   */
  async notifyGreeting(): Promise<void> {
    const remote = this.deps.settings().remote
    if (!remote.enabled || !remote.scopes.history) return
    for (const device of this.deps.store.devices()) {
      if (!device.push) continue
      try {
        const { authorization } = await this.vapid(device.push.endpoint)
        const sealed = await encryptPushPayload({ ...device.push.keys, plaintext: new TextEncoder().encode(GREETING_PUSH_CODE) })
        await this.deps.post(device.push.endpoint, { authorization, TTL: '3600', ...sealed.headers }, sealed.body)
      } catch {
        // The greeting is in its conversation anyway.
      }
    }
  }

  private vapid(endpoint: string): Promise<{ authorization: string }> {
    const { vapid, hostName } = this.deps.state.state
    return buildVapid({ endpoint, subject: `https://${hostName ?? 'alma.local'}`, publicKey: vapid.public, privateKey: vapid.private, now: this.deps.now() })
  }
}
