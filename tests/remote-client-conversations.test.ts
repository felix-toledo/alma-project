import { describe, expect, it } from 'vitest'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { approvalActions } from '../src/remote-client/lib/chat'
import { approvalsFor, conversationMode, endsView, isApproval, foldWindow, joinPage, listEvent, rowSub, windowEvent, type ListView } from '../src/remote-client/lib/conversations'
import { startScreen } from '../src/remote-client/lib/screen-state'
import type { ThreadRow, ThreadWindow } from '../src/shared/remote/wire'

const row = (id: string, over: Partial<ThreadRow> = {}): ThreadRow => ({ id, title: id, agentId: 'a', agentName: 'Alma', updatedAt: 1, current: false, ...over })
const message = (index: number) => ({ index, role: 'user' as const, text: `m${index}`, at: index })
const win = (over: Partial<ThreadWindow> = {}): ThreadWindow => ({ rev: 2, running: false, ownRun: false, waiting: false, messages: [message(0), message(1)], earlier: false, ...over })

describe('PWA conversation list (028 AC-3.1, AC-3.2, AC-3.10)', () => {
  it('AC-3.2 (028) an empty page is the empty state, and a refusal keeps its reason and operation', () => {
    expect(listEvent({ ok: true, rows: [], more: false })).toEqual({ type: 'empty' })
    expect(listEvent({ ok: false, reason: 'scope-off' })).toEqual({ type: 'failed', reason: 'scope-off', operation: 'threads.list' })
  })

  it('AC-3.1 (028) the next page joins by id and moves the offset by what the PC sent', () => {
    const first = listEvent({ ok: true, rows: [row('t1'), row('t2')], more: true })
    expect(first).toEqual({ type: 'content', data: { rows: [row('t1'), row('t2')], more: true, offset: 2 } })
    const held = (first as { data: ListView }).data
    const joined = joinPage(held, { ok: true, rows: [row('t2', { title: 'renamed' }), row('t3')], more: false })
    expect(joined).toEqual({ view: { rows: [row('t1'), row('t2', { title: 'renamed' }), row('t3')], more: false, offset: 4 } })
    // A failed page leaves the list as it is and says why in words.
    expect(joinPage(held, { ok: false, reason: 'network' })).toEqual({ key: 'remote.pwa.pcUnreachable' })
    expect(joinPage(held, { ok: false, reason: 'rate-limited' })).toEqual({ key: 'remote.pwa.rateLimited' })
  })

  it('AC-3.10 (028) a row says where it came from and when, and the shared one is told apart by the PC, not guessed', () => {
    const now = new Date(2026, 10, 8, 18, 0).getTime()
    const today = row('t1', { channel: 'telegram', updatedAt: new Date(2026, 10, 8, 9, 5).getTime() })
    const older = row('t2', { channel: 'voice', updatedAt: new Date(2026, 9, 2, 9, 5).getTime() })
    expect(rowSub(today, now, 'en')).toMatch(/^Alma · Telegram · .*9:05/)
    expect(rowSub(older, now, 'es')).toMatch(/^Alma · Voz · /)
    expect(rowSub(older, now, 'es')).not.toMatch(/:/)
    // No channel: the agent and the time.
    expect(rowSub(row('t3', { updatedAt: today.updatedAt }), now, 'en')).toMatch(/^Alma · [^·]*9:05/)
    for (const channel of ['telegram', 'whatsapp', 'voice', 'remote'] as const) {
      expect(rowSub(row('x', { channel }), now, 'en')).toBeTruthy()
    }
    expect(en['remote.pwa.channel.voice']).not.toBe(es['remote.pwa.channel.voice'])
  })
})

describe('PWA conversation window (028 AC-3.3, AC-3.5, AC-3.11)', () => {
  it('AC-3.3 (028) a window is content even with no messages, and a refusal keeps its reason', () => {
    expect(windowEvent({ ok: true, window: win({ messages: [] }) })).toEqual({ type: 'content', data: win({ messages: [] }) })
    expect(windowEvent({ ok: false, reason: 'gone' })).toEqual({ type: 'failed', reason: 'gone', operation: 'threads.read' })
  })

  it('AC-3.11 (028) a later window joins what is held; anything else replaces the screen and drops the content', () => {
    const held = foldWindow(startScreen(0), { type: 'content', data: win() }, 'later', 1)
    expect(held).toEqual({ kind: 'content', data: win() })
    const more = foldWindow(held, { type: 'content', data: win({ rev: 3, messages: [message(2), message(1)] }) }, 'later', 2)
    expect(more.kind === 'content' && more.data.messages.map((m) => m.index)).toEqual([0, 1, 2])
    const earlier = foldWindow(more, { type: 'content', data: win({ rev: 3, earlier: false, messages: [message(0)] }) }, 'earlier', 3)
    expect(earlier.kind === 'content' && earlier.data.earlier).toBe(false)
    // AC-3.5: the conversation vanished while it was on screen.
    expect(foldWindow(more, { type: 'failed', reason: 'gone', operation: 'threads.read' }, 'later', 4)).toEqual({ kind: 'error', key: 'remote.pwa.thread.gone', retry: false })
  })

  it('AC-3.5 (028) only a vanished conversation, a switch turned off or a revoked phone replace the view; the rest is a note', () => {
    for (const reason of ['gone', 'scope-off', 'unknown-device'] as const) expect(endsView(reason), reason).toBe(true)
    for (const reason of ['network', 'rate-limited', 'invalid', 'too-large', 'busy', 'run-active', 'write-off', 'not-delivered'] as const) expect(endsView(reason), reason).toBe(false)
  })
})

describe('PWA conversation composer (028 AC-3.6, AC-3.8, AC-3.9, AC-3.18, AC-3.19, AC-1.1)', () => {
  const mode = (over: Partial<Parameters<typeof conversationMode>[0]> = {}) =>
    conversationMode({ running: false, waiting: false, continueOn: true, ownRun: false, ...over })

  it('AC-3.6 (028) an idle conversation with continue on offers the composer and nothing else', () => {
    expect(mode()).toEqual({ notice: null, compose: true, stop: false })
  })

  it('AC-1.1 (028) with continue off there is no composer and the text says it is turned off', () => {
    expect(mode({ continueOn: false })).toEqual({ notice: 'remote.pwa.writeOff', compose: false, stop: false })
  })

  it('AC-3.8 (028) a conversation running for someone else is busy: no composer, no stop', () => {
    expect(mode({ running: true })).toEqual({ notice: 'remote.pwa.thread.busy', compose: false, stop: false })
  })

  it('AC-3.19 (028) a run this phone started says so and can be stopped', () => {
    expect(mode({ running: true, ownRun: true })).toEqual({ notice: 'remote.pwa.run.active', compose: false, stop: true })
  })

  it('AC-3.9 (028) waiting for an approval the phone cannot answer is said, whoever started it, and the phone can stop its own', () => {
    expect(mode({ running: true, waiting: true })).toEqual({ notice: 'remote.pwa.thread.waiting', compose: false, stop: false })
    expect(mode({ running: true, waiting: true, ownRun: true })).toEqual({ notice: 'remote.pwa.thread.waiting', compose: false, stop: true })
  })

  it('AC-3.18 (028) a run that ended offers no stop even if this phone started it', () => {
    expect(mode({ ownRun: true }).stop).toBe(false)
  })
})

describe('PWA conversation approvals (028 AC-3.15, AC-3.16)', () => {
  const card = (id: string, thread?: string) => ({ id, tool: 'write', input: '{}', flagged: false, whole: true, question: 'chan.allowQuestion', ...(thread ? { thread } : {}) })

  it('AC-2.12 (029) a card without the whole flag is junk, so the phone never offers Permitir by default', () => {
    const { whole: _whole, ...unmarked } = card('a1')
    expect(isApproval(unmarked)).toBe(false)
    expect(isApproval({ ...unmarked, whole: 'yes' })).toBe(false)
    expect(isApproval(card('a1'))).toBe(true)
  })

  it('AC-2.9 (029) Permitir shows only when the whole input is on screen; Denegar always shows; a cut one says to use the desktop', () => {
    expect(approvalActions({ whole: true })).toEqual({ allow: true, notice: null })
    expect(approvalActions({ whole: false })).toEqual({ allow: false, notice: 'remote.pwa.approve.seeOnPc' })
    expect(en['remote.pwa.approve.seeOnPc']).toBeTruthy()
    expect(es['remote.pwa.approve.seeOnPc']).toBeTruthy()
  })

  it('AC-3.15 (028) a conversation shows the approvals marked with it, and the shared thread also those with no mark', () => {
    const all = [card('a1', 't1'), card('a2', 't2'), card('a3'), { id: 5 }, null]
    expect(approvalsFor(all, 't1', false).map((a) => a.id)).toEqual(['a1'])
    expect(approvalsFor(all, 't9', true).map((a) => a.id)).toEqual(['a3'])
    expect(approvalsFor(all, 't2', true).map((a) => a.id)).toEqual(['a2', 'a3'])
    expect(approvalsFor([], 't1', true)).toEqual([])
  })
})
