import { REMOTE_LIMITS } from '../../shared/remote/limits'
import type { ThreadRow, ThreadWindow } from '../../shared/remote/wire'
import { isRecord, postJson, type Failed } from './request'
import type { FetchLike } from './session'

// Held in memory only; every screen visit asks the PC again (BR-26).
type Deps = { fetch: FetchLike; token: string }
const network: Failed = { ok: false, reason: 'network' }

type WindowMessage = ThreadWindow['messages'][number]

const isRow = (value: unknown): value is ThreadRow =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.title === 'string' &&
  typeof value.agentId === 'string' &&
  typeof value.agentName === 'string' &&
  typeof value.updatedAt === 'number' &&
  typeof value.current === 'boolean'

const isMessage = (value: unknown): value is WindowMessage =>
  isRecord(value) &&
  typeof value.index === 'number' &&
  (value.role === 'user' || value.role === 'assistant') &&
  typeof value.text === 'string' &&
  typeof value.at === 'number'

export type ThreadsOutcome = { ok: true; rows: ThreadRow[]; more: boolean } | Failed

/** One page of the list, 30 a page by offset (AC-3.1). */
export async function listThreads(deps: Deps & { offset: number }): Promise<ThreadsOutcome> {
  const reply = await postJson({ ...deps, path: '/api/threads/list', body: { offset: deps.offset } })
  if (!reply.ok) return reply
  const { rows, more } = reply.body
  return Array.isArray(rows) && typeof more === 'boolean' ? { ok: true, rows: rows.filter(isRow), more } : network
}

/** Joins a list page onto what is shown: a conversation that slid between pages appears once, with its newest copy. */
export function mergeRows(held: ThreadRow[], page: ThreadRow[]): ThreadRow[] {
  const byId = new Map(held.map((row) => [row.id, row]))
  for (const row of page) byId.set(row.id, row)
  return [...byId.values()]
}

export type WindowOutcome = { ok: true; window: ThreadWindow } | Failed

/**
 * A window of one conversation: the last 30, `before` an index for earlier ones, or `since` an index for what came after;
 * with `wait` the PC holds the answer until something changes, and `signal` cancels that wait (hiding the page).
 */
export async function readThread(deps: Deps & { id: string; before?: number; since?: number; wait?: boolean; signal?: AbortSignal }): Promise<WindowOutcome> {
  const { id, before, since, wait, ...rest } = deps
  const reply = await postJson({ ...rest, path: '/api/threads/read', body: { id, before, since, wait } })
  if (!reply.ok) return reply
  const { rev, running, ownRun, waiting, earlier, messages } = reply.body
  if (typeof rev !== 'number' || typeof running !== 'boolean' || typeof ownRun !== 'boolean' || typeof waiting !== 'boolean' || typeof earlier !== 'boolean' || !Array.isArray(messages)) return network
  return { ok: true, window: { rev, running, ownRun, waiting, earlier, messages: messages.filter(isMessage) } }
}

/** Most messages kept while following live; older ones go and `earlier` says there are more to load. */
export const MAX_HELD_MESSAGES = 300

/**
 * Joins a window onto what is held. Messages are matched by index, so a retried or overlapping answer adds nothing twice and a
 * delta never replaces the conversation (the rule `mergeState` follows for the Chat tab). An `earlier` page is prepended with
 * no cap and brings its own `earlier` flag; a later one keeps the flag, and a rev that went back means another conversation.
 */
export function mergeWindow(prev: ThreadWindow | null, next: ThreadWindow, how: 'later' | 'earlier' = 'later'): ThreadWindow {
  if (!prev || next.rev < prev.rev) return next
  const byIndex = new Map(prev.messages.map((message) => [message.index, message]))
  for (const message of next.messages) byIndex.set(message.index, message)
  let messages = [...byIndex.values()].sort((a, b) => a.index - b.index)
  let earlier = how === 'earlier' ? next.earlier : prev.earlier
  if (how === 'later' && messages.length > MAX_HELD_MESSAGES) {
    messages = messages.slice(-MAX_HELD_MESSAGES)
    earlier = true
  }
  return { ...next, messages, earlier }
}

/**
 * The `before` for the next "load earlier": the first index held. A page made only of tool messages comes back empty with
 * `earlier` still true, so when nothing new was held (`asked` is where the last ask stood) it moves back a page instead.
 */
export function earlierCursor(window: ThreadWindow, asked: number = window.rev): number {
  const first = window.messages[0]?.index
  return first !== undefined && first < asked ? first : Math.max(0, asked - REMOTE_LIMITS.firstLoadMessages)
}

export type ThreadActionOutcome = { ok: true } | Failed

/** A message into a conversation. Anything but a named refusal reads as not delivered, and the typed text stays in the input. */
export async function sendThread(deps: Deps & { id: string; text: string }): Promise<ThreadActionOutcome> {
  const reply = await postJson({ ...deps, path: '/api/threads/send', body: { id: deps.id, text: deps.text } })
  if (reply.ok) return { ok: true }
  return reply.reason === 'network' ? { ok: false, reason: 'not-delivered' } : reply
}

/** Stops the run this phone started in that conversation. */
export async function stopThread(deps: Deps & { id: string }): Promise<ThreadActionOutcome> {
  const reply = await postJson({ ...deps, path: '/api/threads/stop', body: { id: deps.id } })
  return reply.ok ? { ok: true } : reply
}
