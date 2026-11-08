import { b64u } from '../../shared/remote/crypto'
import type { StoredSession } from './storage'

/** The slice of fetch the phone uses: JSON over relative URLs, no host anywhere. */
export interface FetchLike {
  (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
  ): Promise<FetchResponse>
}

export interface FetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

/** Renewal starts this long before the hour ends (AC-6.8): silently, by signing again. */
export const RENEW_BEFORE_MS = 5 * 60_000

export function needsRenewal(session: StoredSession | null, now: number): boolean {
  return session === null || now >= session.expiresAt - RENEW_BEFORE_MS
}

/**
 * Callers that arrive while a run is in flight share its result. The PC keeps one
 * nonce per device, so two concurrent renewals would make the first signature fail.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null
  return () => {
    if (!inflight) {
      inflight = run().finally(() => {
        inflight = null
      })
    }
    return inflight
  }
}

export type SessionOutcome = { ok: true; session: StoredSession } | { ok: false; reason: 'refused' | 'network' | 'rate-limited' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Opens (or silently renews) the 1-hour session: challenge, then a signature over
 * the nonce. Failures return a reason instead of throwing; the caller keeps the old
 * session and shows `pcUnreachable`, so the screen stays usable (AC-6.8).
 */
export async function openSession(deps: {
  fetch: FetchLike
  deviceId: string
  sign(bytes: Uint8Array): Promise<Uint8Array>
  now(): number
}): Promise<SessionOutcome> {
  let challenge: FetchResponse
  try {
    challenge = await deps.fetch('/api/session/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deps.deviceId })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (challenge.status === 401) return { ok: false, reason: 'refused' }
  if (challenge.status === 429) return { ok: false, reason: 'rate-limited' }
  if (!challenge.ok) return { ok: false, reason: 'network' }
  const nonce = await challenge.json()
  if (!isRecord(nonce) || typeof nonce.nonce !== 'string') return { ok: false, reason: 'network' }
  let signature: Uint8Array
  try {
    signature = await deps.sign(b64u.decode(nonce.nonce))
  } catch {
    return { ok: false, reason: 'network' }
  }
  let session: FetchResponse
  try {
    session = await deps.fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: deps.deviceId, signature: b64u.encode(signature) })
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (session.status === 401) return { ok: false, reason: 'refused' }
  if (session.status === 429) return { ok: false, reason: 'rate-limited' }
  if (!session.ok) return { ok: false, reason: 'network' }
  const issued = await session.json()
  if (!isRecord(issued) || typeof issued.token !== 'string' || typeof issued.expiresIn !== 'number') {
    return { ok: false, reason: 'network' }
  }
  return { ok: true, session: { token: issued.token, expiresAt: deps.now() + issued.expiresIn * 1000 } }
}
