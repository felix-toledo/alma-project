import { REMOTE_LIMITS } from '../../shared/remote/limits'
import type { PwaKey } from '../i18n/es'
import { outcomeKey, type Failure } from './outcome'
import { postJson } from './request'
import type { FetchLike, FetchResponse } from './session'

type BaseChatReason = 'refused' | 'not-delivered' | 'network' | 'rate-limited' | 'scope-off' | 'too-long'
/** A send that carries files also reads the PC's named refusal (031 AC-4.1), so it may be any failure. */
export type ChatReason = BaseChatReason | Failure
export type ChatOutcome = { ok: true } | { ok: false; reason: ChatReason }
export type AnswerOutcome = { ok: true } | { ok: false; reason: ChatReason | 'already-answered' }

export type ChatValidation = { ok: true } | { ok: false; reason: 'empty' | 'too-long' }

/** The input refuses blank and over-8000 texts (AC-5.5); a blank text is fine with at least one ready file (031 AC-4.1). The screen disables send. */
export function validateChatInput(text: string, files: number = 0): ChatValidation {
  if (text.trim().length === 0 && files < 1) return { ok: false, reason: 'empty' }
  // Code points, the way the server counts: UTF-16 units would refuse emoji texts the server accepts.
  if ([...text].length > REMOTE_LIMITS.chatChars) return { ok: false, reason: 'too-long' }
  return { ok: true }
}

async function post(deps: { fetch: FetchLike; token: string; path: string; body: unknown }): Promise<FetchResponse | null> {
  try {
    return await deps.fetch(deps.path, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(deps.body)
    })
  } catch {
    return null
  }
}

/**
 * Sends one chat message. A run already in progress (409 busy) and a failed run
 * (500) both read as not-delivered: the message was not accepted, the typed text
 * stays in the input, and the poll shows the running state.
 */
export async function sendChat(deps: { fetch: FetchLike; token: string; text: string; attachments?: string[] }): Promise<ChatOutcome> {
  if (deps.attachments?.length) {
    // With files the PC's own error name decides: a 403 can be the files switch, not the scope (031 AC-4.1).
    const reply = await postJson({ fetch: deps.fetch, token: deps.token, path: '/api/chat/send', body: { text: deps.text, attachments: deps.attachments } })
    if (reply.ok) return { ok: true }
    return { ok: false, reason: reply.reason === 'unknown-device' ? 'refused' : reply.reason === 'network' ? 'not-delivered' : reply.reason }
  }
  const response = await post({ ...deps, path: '/api/chat/send', body: { text: deps.text } })
  if (!response) return { ok: false, reason: 'not-delivered' }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 413) return { ok: false, reason: 'too-long' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  return { ok: false, reason: 'not-delivered' }
}

/** Answers one approval with allow or deny only, never "always" (BR-12). */
export async function answerApproval(deps: {
  fetch: FetchLike
  token: string
  id: string
  decision: 'allow' | 'deny'
}): Promise<AnswerOutcome> {
  const response = await post({ ...deps, path: '/api/approvals/answer', body: { id: deps.id, decision: deps.decision } })
  if (!response) return { ok: false, reason: 'network' }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 409) return { ok: false, reason: 'already-answered' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  return { ok: false, reason: 'network' }
}

/** Starts a fresh remote thread; the old one is kept, just no longer served. */
export async function newChat(deps: { fetch: FetchLike; token: string }): Promise<ChatOutcome> {
  const response = await post({ ...deps, path: '/api/chat/new', body: {} })
  if (!response) return { ok: false, reason: 'network' }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  return { ok: false, reason: 'network' }
}

/** Stops the running turn and denies its pending approvals (AC-5.16). */
export async function stopChat(deps: { fetch: FetchLike; token: string }): Promise<ChatOutcome> {
  const response = await post({ ...deps, path: '/api/chat/stop', body: {} })
  if (!response) return { ok: false, reason: 'network' }
  if (response.ok) return { ok: true }
  if (response.status === 401) return { ok: false, reason: 'refused' }
  if (response.status === 403) return { ok: false, reason: 'scope-off' }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  return { ok: false, reason: 'network' }
}

const OUTCOME_KEYS: Record<BaseChatReason | 'already-answered', PwaKey> = {
  refused: 'remote.pwa.revoked',
  'not-delivered': 'remote.pwa.notDelivered',
  network: 'remote.pwa.pcUnreachable',
  'rate-limited': 'remote.pwa.rateLimited',
  'scope-off': 'remote.pwa.scopeOff',
  'too-long': 'remote.pwa.tooLong',
  'already-answered': 'remote.pwa.alreadyAnswered'
}

/** What the screen shows for a chat or answer outcome. */
export function chatOutcomeKey(reason: ChatReason | 'already-answered'): PwaKey {
  return Object.hasOwn(OUTCOME_KEYS, reason) ? OUTCOME_KEYS[reason as keyof typeof OUTCOME_KEYS] : outcomeKey(reason as Failure, 'chat')
}

/** The loose line a failed send shows. None for `unavailable`: the chips say which files expired, by name (031 AC-8.7). */
export function chatNoteKey(reason: ChatReason | 'already-answered'): PwaKey | null {
  return reason === 'unavailable' ? null : chatOutcomeKey(reason)
}

const QUESTION_KEYS = {
  'chan.allowQuestion': 'remote.pwa.approve.question',
  'chan.flagged': 'remote.pwa.approve.flagged'
} as const satisfies Record<string, PwaKey>

/** Deny always shows; Permitir only when the whole input fits on the phone, else it points at the desktop (spec 029 BR-23). */
export function approvalActions(approval: { whole: boolean }): { allow: boolean; notice: PwaKey | null } {
  return approval.whole ? { allow: true, notice: null } : { allow: false, notice: 'remote.pwa.approve.seeOnPc' }
}

/** The PC names the approval question by its own key; the PWA carries equivalent wording. */
export function approvalQuestionKey(question: 'chan.allowQuestion' | 'chan.flagged'): PwaKey {
  return QUESTION_KEYS[question]
}
