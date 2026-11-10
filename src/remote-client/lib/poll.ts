import type { PhoneAttachmentView } from '../../shared/attach/phone'
import { REMOTE_LIMITS } from '../../shared/remote/limits'
import type { PwaKey } from '../i18n/es'
import { readAttachmentViews } from './attach'
import type { FetchLike, FetchResponse } from './session'

/** One committed chat message as the narrow API serves it (PD-12): text, and the names of its attachments (031 BR-10). */
export interface PwaMessage {
  index: number
  role: string
  text: string
  at: number
  /** Name, kind and size only (031 BR-10); never an id. */
  attachments?: PhoneAttachmentView[]
}

export interface PwaState {
  /** The shared thread; a different one than before is a new conversation whatever its rev. */
  threadId?: string
  rev: number
  running: boolean
  messages: PwaMessage[]
  approvals: unknown[]
  ping?: string
}

export type PollReason = 'refused' | 'network' | 'rate-limited'
export type PollOutcome = { ok: true; state: PwaState } | { ok: false; reason: PollReason }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMessage(value: unknown): value is PwaMessage {
  return (
    isRecord(value) && typeof value.index === 'number' && typeof value.role === 'string' && typeof value.text === 'string' && typeof value.at === 'number'
  )
}

/** The fields the screen renders; anything else on the wire stays off the render model. */
function readMessage(message: PwaMessage): PwaMessage {
  const attachments = readAttachmentViews(message.attachments)
  return { index: message.index, role: message.role, text: message.text, at: message.at, ...(attachments ? { attachments } : {}) }
}

/**
 * One long-poll round (AC-8.1): a single GET, never queued behind another; the
 * caller's signal aborts it (hiding the page). A key refusal (`unknown-device`,
 * revoked, deleted or idle-expired alike, AC-5.3) reports `refused` so the caller
 * wipes; anything else unreachable reports `network` and backs off.
 */
export async function pollOnce(deps: { fetch: FetchLike; token: string; since: number | null; signal: AbortSignal }): Promise<PollOutcome> {
  let response: FetchResponse
  try {
    response = await deps.fetch(deps.since === null ? '/api/state' : `/api/state?since=${deps.since}`, {
      headers: { authorization: `Bearer ${deps.token}` },
      signal: deps.signal
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  if (!response.ok) return { ok: false, reason: 'network' }
  const state = await response.json()
  if (!isRecord(state) || typeof state.rev !== 'number' || typeof state.running !== 'boolean') {
    return { ok: false, reason: 'network' }
  }
  const messages = Array.isArray(state.messages) ? state.messages.filter(isMessage).map(readMessage) : []
  const approvals = Array.isArray(state.approvals) ? state.approvals : []
  return {
    ok: true,
    state: {
      ...(typeof state.threadId === 'string' ? { threadId: state.threadId } : {}),
      rev: state.rev,
      running: state.running,
      messages,
      approvals,
      ...(typeof state.ping === 'string' ? { ping: state.ping } : {})
    }
  }
}

/**
 * A poll with `since` answers only the messages after it (an idle one answers none),
 * so the screen keeps what it has and appends by index (AC-8.7). Everything else comes
 * from the newest poll. A rev that went back, or another thread id, means a new conversation: drop the old one.
 */
export function mergeState(prev: PwaState | null, next: PwaState): PwaState {
  if (!prev || next.rev < prev.rev || next.threadId !== prev.threadId) return next
  const known = new Set(prev.messages.map((message) => message.index))
  const messages = [...prev.messages, ...next.messages.filter((message) => !known.has(message.index))]
  return { ...next, messages: messages.slice(-REMOTE_LIMITS.firstLoadMessages) }
}

/** The cursor for the next poll: null refetches the window after a new conversation. */
export function nextSince(prev: PwaState | null, next: PwaState): number | null {
  return prev && (next.rev < prev.rev || next.threadId !== prev.threadId) ? null : next.rev
}

/**
 * Answers the PC's connection-test ping (AC-2.5). Fire and forget: a failure is
 * silent, the PC's 10-second wait simply times out.
 */
export async function pong(deps: { fetch: FetchLike; token: string; ping: string }): Promise<void> {
  try {
    await deps.fetch('/api/pong', {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ping: deps.ping })
    })
  } catch {
    // The PC times out; nothing to show.
  }
}

/** Backoff between poll rounds: 1 s doubling to a 30 s ceiling (AC-8.1). */
export function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), 30_000)
}

const REASON_KEYS: Record<PollReason, PwaKey> = {
  refused: 'remote.pwa.revoked',
  network: 'remote.pwa.pcUnreachable',
  'rate-limited': 'remote.pwa.rateLimited'
}

/** What the screen shows for a poll outcome. */
export function refusalKey(reason: PollReason): PwaKey {
  return REASON_KEYS[reason]
}

/** The note after a poll recovers: the one that poll set goes away, any other note (an action's) stays. */
export function clearOwnNote<T extends string>(current: T | null, mine: T | null): T | null {
  return mine !== null && current === mine ? null : current
}
