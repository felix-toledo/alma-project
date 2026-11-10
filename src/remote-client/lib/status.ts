import type { StatusView } from '../../shared/remote/wire'
import { getJson, isRecord, type Failed } from './request'
import type { ScreenEvent } from './screen-state'
import type { FetchLike } from './session'

export type StatusOutcome = { ok: true; status: StatusView } | Failed

const SCOPES = ['chat', 'approve', 'home', 'cameras', 'vault', 'history'] as const

/** Which switches are on (AC-6.7). Only the known booleans are kept, so nothing else the PC might add is held on the phone. */
export async function fetchStatus(deps: { fetch: FetchLike; token: string }): Promise<StatusOutcome> {
  const reply = await getJson({ ...deps, path: '/api/status' })
  if (!reply.ok) return reply
  const { scopes, sensitive, sendFiles, landing } = reply.body
  if (!isRecord(scopes) || typeof sensitive !== 'boolean' || typeof reply.body.continue !== 'boolean') return { ok: false, reason: 'network' }
  if (SCOPES.some((name) => typeof scopes[name] !== 'boolean')) return { ok: false, reason: 'network' }
  const picked = Object.fromEntries(SCOPES.map((name) => [name, scopes[name]])) as StatusView['scopes']
  // A PC that predates Send files omits the key; a non-boolean is dropped too, so both read as off (031 AC-1.9).
  // The greeting's conversation (spec 033 BR-29): an id as the threads routes accept it, or nothing.
  const lands = typeof landing === 'string' && landing.length > 0 && landing.length <= 64
  return {
    ok: true,
    status: { scopes: picked, sensitive, continue: reply.body.continue, ...(typeof sendFiles === 'boolean' ? { sendFiles } : {}), ...(lands ? { landing } : {}) }
  }
}

/** The status as a screen state, so Settings has the same loading, unreachable and revoked states as every other screen. */
export function statusEvent(outcome: StatusOutcome): ScreenEvent<StatusView> {
  return outcome.ok ? { type: 'content', data: outcome.status } : { type: 'failed', reason: outcome.reason, operation: 'status' }
}
