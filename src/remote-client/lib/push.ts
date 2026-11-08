import type { FetchLike, FetchResponse } from './session'

export interface PushSubscriptionInput {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/**
 * The browser side of push subscription, injected so this module stays DOM-free:
 * `serviceWorkerRegistration.pushManager.subscribe` with the PC's VAPID key.
 */
export interface PushSubscriber {
  subscribe(options: { applicationServerKey: string; userVisibleOnly: boolean }): Promise<PushSubscriptionInput>
}

export type PushSubscribeOutcome = { ok: true } | { ok: false; reason: 'invalid' | 'network' | 'refused' | 'rate-limited' }

/**
 * Subscribes this phone for approval pushes (AC-11.6): reads the PC's VAPID key,
 * subscribes with the push service, and stores the endpoint sealed on the PC.
 */
export async function subscribePush(deps: { fetch: FetchLike; token: string; subscribe: PushSubscriber['subscribe'] }): Promise<PushSubscribeOutcome> {
  let key: FetchResponse
  try {
    key = await deps.fetch('/api/push/key', { headers: { authorization: `Bearer ${deps.token}` } })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (key.status === 401) return { ok: false, reason: 'refused' }
  if (key.status === 429) return { ok: false, reason: 'rate-limited' }
  if (!key.ok) return { ok: false, reason: 'network' }
  const body = (await key.json().catch(() => null)) as { key?: unknown } | null
  if (!body || typeof body.key !== 'string') return { ok: false, reason: 'network' }
  let subscription: PushSubscriptionInput
  try {
    subscription = await deps.subscribe({ applicationServerKey: body.key, userVisibleOnly: true })
  } catch {
    return { ok: false, reason: 'network' }
  }
  let saved: FetchResponse
  try {
    saved = await deps.fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (saved.ok) return { ok: true }
  if (saved.status === 401) return { ok: false, reason: 'refused' }
  if (saved.status === 429) return { ok: false, reason: 'rate-limited' }
  if (saved.status === 400) return { ok: false, reason: 'invalid' }
  return { ok: false, reason: 'network' }
}
