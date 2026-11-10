import type { ApprovalView, Refusal } from '../../shared/remote/api'
import type { ThreadRow, ThreadWindow } from '../../shared/remote/wire'
import { translatePwa, type PwaLanguage } from '../i18n'
import type { PwaKey } from '../i18n/es'
import { outcomeKey, type Failure } from './outcome'
import { nextScreenState, type ScreenEvent, type ScreenState } from './screen-state'
import { mergeRows, mergeWindow, type ThreadsOutcome, type WindowOutcome } from './threads'

// What the Conversations screens draw, decided here so the screens only render (AC-6.3).

/** The conversations held so far; `offset` is how many rows the PC has sent, which is where the next page starts. */
export interface ListView {
  rows: ThreadRow[]
  more: boolean
  offset: number
}

export function listEvent(outcome: ThreadsOutcome): ScreenEvent<ListView> {
  if (!outcome.ok) return { type: 'failed', reason: outcome.reason, operation: 'threads.list' }
  if (outcome.rows.length === 0) return { type: 'empty' }
  return { type: 'content', data: { rows: mergeRows([], outcome.rows), more: outcome.more, offset: outcome.rows.length } }
}

/** "Load more": the next page joined onto the list. A failure leaves the list as it is and names the reason (AC-6.3). */
export function joinPage(held: ListView, outcome: ThreadsOutcome): { view: ListView } | { key: PwaKey } {
  if (!outcome.ok) return { key: outcomeKey(outcome.reason, 'threads.list') }
  return { view: { rows: mergeRows(held.rows, outcome.rows), more: outcome.more, offset: held.offset + outcome.rows.length } }
}

const CHANNELS: Record<string, PwaKey> = {
  telegram: 'remote.pwa.channel.telegram',
  whatsapp: 'remote.pwa.channel.whatsapp',
  voice: 'remote.pwa.channel.voice',
  remote: 'remote.pwa.channel.remote'
}

/** Which agent answers, where a conversation came from and when it was last touched: the time for today, the day for any other. */
export function rowSub(row: ThreadRow, now: number, language: PwaLanguage): string {
  const at = new Date(row.updatedAt)
  const today = at.toDateString() === new Date(now).toDateString()
  const when = today ? at.toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleDateString(language, { day: 'numeric', month: 'short' })
  const channel = row.channel && Object.hasOwn(CHANNELS, row.channel) ? translatePwa(language, CHANNELS[row.channel]) : null
  return [row.agentName, channel, when].filter(Boolean).join(' · ')
}

export function windowEvent(outcome: WindowOutcome): ScreenEvent<ThreadWindow> {
  if (!outcome.ok) return { type: 'failed', reason: outcome.reason, operation: 'threads.read' }
  return { type: 'content', data: outcome.window }
}

/** A window joins what is held; a conversation with no messages yet is still content (it has a composer). */
export function foldWindow(prev: ScreenState<ThreadWindow>, event: ScreenEvent<ThreadWindow>, how: 'later' | 'earlier', now: number): ScreenState<ThreadWindow> {
  if (event.type === 'content' && prev.kind === 'content') return { kind: 'content', data: mergeWindow(prev.data, event.data, how) }
  return nextScreenState(prev, event, now)
}

/**
 * Of a failed side action (more rows, earlier messages, a send), only these change what the screen is: the conversation is gone,
 * its switch is off, or the phone is revoked. Anything else is said as a line and the view stays, with the typed text in it.
 */
export function endsView(reason: Failure): boolean {
  const ends: readonly Refusal[] = ['gone', 'scope-off', 'unknown-device']
  return (ends as readonly string[]).includes(reason)
}

export interface ConversationMode {
  notice: PwaKey | null
  compose: boolean
  stop: boolean
}

/**
 * What the foot of an open conversation offers. The composer needs continue on and nothing running; a run is either this phone's
 * (it can stop it), or someone else's (busy), and a run held for an approval this phone cannot answer says so (AC-3.9).
 */
export function conversationMode(input: { running: boolean; waiting: boolean; continueOn: boolean; ownRun: boolean }): ConversationMode {
  const { running, waiting, continueOn, ownRun } = input
  const stop = running && ownRun
  if (running) return { notice: waiting ? 'remote.pwa.thread.waiting' : ownRun ? 'remote.pwa.run.active' : 'remote.pwa.thread.busy', compose: false, stop }
  return continueOn ? { notice: null, compose: true, stop } : { notice: 'remote.pwa.writeOff', compose: false, stop }
}

export function isApproval(value: unknown): value is ApprovalView {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.tool === 'string' &&
    typeof row.input === 'string' &&
    typeof row.flagged === 'boolean' &&
    typeof row.whole === 'boolean' &&
    (row.thread === undefined || typeof row.thread === 'string') &&
    (row.question === 'chan.allowQuestion' || row.question === 'chan.flagged')
  )
}

/** The cards of one open conversation: those marked with it, and for the shared thread also those with no mark (AC-3.15). */
export function approvalsFor(all: readonly unknown[], id: string, isShared: boolean): ApprovalView[] {
  return all.filter(isApproval).filter((approval) => approval.thread === id || (isShared && approval.thread === undefined))
}
