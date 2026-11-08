import { FAILURES, type Failure } from './outcome'
import type { FetchLike } from './session'

export type Failed = { ok: false; reason: Failure }
export type Reply = { ok: true; body: Record<string, unknown> } | Failed

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const REASONS: ReadonlySet<string> = new Set(FAILURES.filter((reason) => reason !== 'network' && reason !== 'not-delivered'))
const BY_STATUS: Record<number, Failure> = { 401: 'unknown-device', 403: 'scope-off', 413: 'too-large', 429: 'rate-limited' }

/**
 * One authenticated JSON POST. A refusal is read from the body's `error` (the PC names the cause, byte-identical for every
 * transport), with the status as the fallback; anything else that is not a JSON object is the PC not answering.
 */
export function postJson(deps: { fetch: FetchLike; token: string; path: string; body: unknown; signal?: AbortSignal }): Promise<Reply> {
  return call(deps.fetch, deps.path, {
    method: 'POST',
    headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(deps.body),
    signal: deps.signal
  })
}

/** The same reading for an authenticated GET. */
export function getJson(deps: { fetch: FetchLike; token: string; path: string; signal?: AbortSignal }): Promise<Reply> {
  return call(deps.fetch, deps.path, { headers: { authorization: `Bearer ${deps.token}` }, signal: deps.signal })
}

async function call(fetch: FetchLike, path: string, init: Parameters<FetchLike>[1]): Promise<Reply> {
  let status: number
  let ok: boolean
  let body: unknown
  try {
    const response = await fetch(path, init)
    status = response.status
    ok = response.ok
    body = await response.json().catch(() => null)
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (ok) return isRecord(body) ? { ok: true, body } : { ok: false, reason: 'network' }
  const named = isRecord(body) && typeof body.error === 'string' && REASONS.has(body.error) ? (body.error as Failure) : undefined
  return { ok: false, reason: named ?? BY_STATUS[status] ?? 'network' }
}
