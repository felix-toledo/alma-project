import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/coordinator/attachments/store'
import { countsAsOpened } from '../src/coordinator/attachments/service'
import { RunTies } from '../src/coordinator/channels/remote/runs'
import { ThreadsFlow } from '../src/coordinator/channels/remote/threads'
import { ThreadStore } from '../src/coordinator/store'
import { defaultSettings } from '../src/shared/defaults'
import { threadPage } from '../src/coordinator/channels/remote/thread-view'
import type { MessageAttachment } from '../src/shared/attach/compose'
import { REMOTE_LIMITS } from '../src/shared/remote/api'
import { defaultRemote } from '../src/shared/remote/settings'
import type { ChatMessage } from '../src/shared/types'
import { makeThread, testChannel, type Harness } from './support/remote-harness'

const ID_MARKER = 'MARKER-ATTACHMENT-ID-0001'
const STORED_MARKER = 'MARKER-STORED-NAME-0002.bin'
const PATH_MARKER = 'C:\\MARKER-PATH-0003'

/** A stored attachment as spec 030 keeps it, plus fields a record or an older build might carry. */
const attachment = (name: string, over: Record<string, unknown> = {}): MessageAttachment =>
  ({ id: ID_MARKER, name, kind: 'text', size: 12, storedName: STORED_MARKER, path: PATH_MARKER, removed: true, removedAt: 5, ...over }) as MessageAttachment

const message = (role: 'user' | 'assistant', text: string, attachments?: MessageAttachment[], ts = 1): ChatMessage => ({
  role,
  content: text ? [{ type: 'text', text }] : [],
  ts,
  ...(attachments ? { attachments } : {})
})

async function served(): Promise<Harness> {
  const base = defaultRemote()
  const t = await testChannel({ remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true } })
  await t.channel.sync()
  return t
}

const state = async (t: Harness, query = '') => {
  const { headers } = await t.phone()
  return t.transport.request({ method: 'GET', path: '/api/state', query, headers })
}
const read = (t: Harness, id: string, extra: Record<string, unknown> = {}) => t.call('/api/threads/read', { id, ...extra })
const messagesOf = (response: { body?: unknown }) => (response.body as { messages: unknown[] }).messages

describe('the phone sees what was attached by name only (spec 031 T33)', () => {
  it('AC-5.2 (031) marker strings in id, stored name and path never reach the phone', async () => {
    const t = await served()
    t.chat.seed([message('user', 'mirá', [attachment('informe.txt')]), message('assistant', 'listo')])
    t.chat.threads.push(makeThread('t1'))
    t.chat.threads[1]?.messages.push(message('user', 'otra', [attachment('b.txt')]))
    for (const response of [await state(t), await read(t, 'remote'), await read(t, 't1')]) {
      expect(response.status).toBe(200)
      const wire = JSON.stringify(response.body)
      for (const marker of [ID_MARKER, STORED_MARKER, PATH_MARKER, 'removedAt', '"removed"', 'storedName']) expect(wire, marker).not.toContain(marker)
    }
  })

  it('AC-5.1 (031) the phone sees name, kind and size only, and the Chat tab and a conversation agree', async () => {
    const t = await served()
    t.chat.seed([message('user', 'mirá', [attachment('a.txt'), attachment('foto.png', { kind: 'image', size: 99 })]), message('assistant', 'listo')])
    const tab = messagesOf(await state(t))
    const byId = messagesOf(await read(t, 'remote'))
    expect(byId).toEqual(tab)
    expect(byId[0]).toEqual({
      index: 0,
      role: 'user',
      text: 'mirá',
      at: 1,
      attachments: [
        { name: 'a.txt', kind: 'text', size: 12 },
        { name: 'foto.png', kind: 'image', size: 99 }
      ]
    })
    // a message without attachments keeps today's shape: no key at all
    expect(byId[1]).not.toHaveProperty('attachments')
  })

  it('AC-5.3 (031) an attachment-only message is listed with empty text; a message with neither is left out', async () => {
    const t = await served()
    t.chat.seed([message('user', '', [attachment('solo.txt')]), message('assistant', ''), message('user', '', []), message('assistant', 'ok')])
    for (const response of [await state(t), await read(t, 'remote')]) {
      expect(messagesOf(response)).toEqual([
        { index: 0, role: 'user', text: '', at: 1, attachments: [{ name: 'solo.txt', kind: 'text', size: 12 }] },
        { index: 3, role: 'assistant', text: 'ok', at: 1 }
      ])
    }
  })

  it('AC-5.3 (031) earlier counts attachment-only messages', () => {
    const envelope = (kept: unknown[]) => ({ messages: kept })
    // the window shows the newest 30; before it there is one message with attachments only and one with nothing
    const thread = [message('user', '', [attachment('primero.txt')]), message('assistant', ''), ...Array.from({ length: REMOTE_LIMITS.firstLoadMessages }, (_, i) => message('assistant', `m${i}`))]
    const first = threadPage(thread, {}, envelope)
    expect(first.messages[0]?.index).toBe(2)
    expect(first.earlier).toBe(true)
    // without the attachments there is nothing earlier to load
    thread[0] = message('user', '')
    expect(threadPage(thread, {}, envelope).earlier).toBe(false)
  })

  it('AC-5.4 (031) attachment lists count toward the 1 MB cap and a delta cut keeps the cursor rule', () => {
    const longName = 'n'.repeat(512)
    const five = Array.from({ length: 5 }, (_, i) => attachment(`${i}${longName}`))
    const raw = Array.from({ length: 100 }, (_, i) => message(i % 2 ? 'assistant' : 'user', 'x'.repeat(40_000), five, i))
    const envelope = (kept: unknown[]) => ({ rev: raw.length, running: false, messages: kept })
    const size = (page: { messages: unknown[] }) => Buffer.byteLength(JSON.stringify(envelope(page.messages)), 'utf8')
    // a first load keeps the newest 30 that fit
    const first = threadPage(raw, {}, envelope)
    expect(size(first)).toBeLessThanOrEqual(REMOTE_LIMITS.requestBytes)
    expect(first.messages.length).toBeLessThan(REMOTE_LIMITS.firstLoadMessages)
    expect(first.messages.at(-1)?.index).toBe(99)
    // the lists are what makes the difference: the same text alone would let more messages in
    const bare = raw.map((m) => ({ ...m, attachments: undefined }))
    expect(threadPage(bare, {}, envelope).messages.length).toBeGreaterThan(first.messages.length)
    // a delta from 0 is cut at the cap; following its cursor retrieves every message once, each page within the cap
    const seen: number[] = []
    let cursor = 0
    for (let guard = 0; guard < 200 && cursor < raw.length; guard++) {
      const page = threadPage(raw, { since: cursor }, envelope)
      expect(size(page)).toBeLessThanOrEqual(REMOTE_LIMITS.requestBytes)
      expect(page.messages.length).toBeGreaterThan(0)
      seen.push(...page.messages.map((m) => m.index))
      cursor = page.rev
    }
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i))
  })

  it('AC-5.5 (031) a swept attachment still shows its name, kind and size and nothing about the file', async () => {
    const t = await served()
    t.chat.seed([message('user', 'viejo', [attachment('barrido.txt', { removedAt: 123, removed: true })])])
    const [shown] = messagesOf(await read(t, 'remote')) as { attachments: Record<string, unknown>[] }[]
    expect(shown?.attachments).toEqual([{ name: 'barrido.txt', kind: 'text', size: 12 }])
  })

  it('AC-5.6 (031) attachments of messages from the desktop, Telegram or a routine show the same way', async () => {
    const t = await served()
    for (const channel of ['telegram', 'whatsapp', 'voice', undefined] as const) {
      const thread = makeThread(`via-${channel ?? 'desktop'}`)
      if (channel) thread.channel = channel
      thread.messages.push(message('user', 'desde otro lado', [attachment('doc.pdf', { kind: 'pdf', size: 3000 })]))
      t.chat.threads.push(thread)
      const [shown] = messagesOf(await read(t, thread.id))
      expect(shown, String(channel)).toEqual({ index: 0, role: 'user', text: 'desde otro lado', at: 1, attachments: [{ name: 'doc.pdf', kind: 'pdf', size: 3000 }] })
    }
  })
})

describe('opening a conversation on the phone (spec 031 T34)', () => {
  it('AC-6.1 (031) the first read of a conversation by id sets lastOpenedAt through markOpened and nothing else', async () => {
    const t = await served()
    t.chat.threads.push(makeThread('t1'))
    t.setNow(5_000)
    expect((await read(t, 't1')).status).toBe(200)
    expect(t.threads.opened).toEqual([{ id: 't1', at: 5_000 }])
    // updatedAt and the order of the list are not touched by the read
    expect(t.chat.threads.find((thread) => thread.id === 't1')?.updatedAt).toBe(0)
    // G9 (provisional): a Refresh, or opening it again, is again a read with no cursor, so it counts again
    t.setNow(9_000)
    await read(t, 't1')
    expect(t.threads.opened).toEqual([
      { id: 't1', at: 5_000 },
      { id: 't1', at: 9_000 }
    ])
  })

  it('AC-6.2 (031) a read with since or before, a read that answers gone and a listing do not set it', async () => {
    const t = await served()
    t.chat.threads.push(makeThread('t1'), makeThread('co', 'ceo'))
    await read(t, 't1', { since: 0 })
    await read(t, 't1', { before: 0 })
    expect((await read(t, 'co')).status).toBe(404)
    expect((await read(t, 'nope')).status).toBe(404)
    expect((await t.call('/api/threads/list', { offset: 0 })).status).toBe(200)
    expect(t.threads.opened).toEqual([])
  })

  it('AC-6.4 (031) the Chat tab\'s state poll does not set it, and a send into it counts through the run entry', async () => {
    const t = await served()
    await state(t)
    await state(t, 'since=0')
    expect(t.threads.opened).toEqual([])
    // the run entry marks a message the person sends from any channel (spec 030 AC-6.7); the phone's ask passes no `unattended`
    expect((await t.call('/api/chat/send', { text: 'hola' })).status).toBe(200)
    expect(countsAsOpened({})).toBe(true)
  })

  it('AC-6.3 (031) the 30 days restart and a deleted file stays deleted', () => {
    const day = 86_400_000
    const dir = mkdtempSync(join(tmpdir(), 'alma-phone-open-'))
    vi.useFakeTimers()
    try {
      let clock = 0
      const threads = new ThreadStore(dir, () => 'en')
      const attachments = new AttachmentStore(dir, { now: () => clock })
      const thread = threads.create('general', '/ws')
      threads.markOpened(thread.id, 0)
      const put = (name: string) => {
        const result = attachments.store({ threadId: thread.id, name, size: 1, base64: Buffer.from('a').toString('base64') })
        if (!result.ok) throw new Error(result.reason)
        return result.attachment.id
      }
      const keep = put('keep.txt')
      const gone = put('gone.txt')
      const flow = new ThreadsFlow({
        threads: { list: () => [], get: (id) => threads.get(id), isRunning: () => false, markOpened: (id, at) => threads.markOpened(id, at) },
        settings: () => defaultSettings(),
        sharedId: () => 'remote',
        ties: new RunTies(),
        waiting: () => false,
        now: () => clock,
        ask: () => Promise.resolve(),
        cancel: () => {},
        sendShared: () => ({ ok: true }),
        uploads: { claimForSend: () => ({ ok: true, ids: undefined }), bound: () => {} }
      })
      const sweepAt = (at: number) => {
        clock = at
        return attachments.sweep((id) => threads.get(id)?.lastOpenedAt, new Set()).removed
      }
      // opened on the phone on day 29: the 30 days start again from there
      clock = 29 * day
      void flow.read('d1', thread.id)
      expect(threads.get(thread.id).lastOpenedAt).toBe(29 * day)
      expect(sweepAt(30 * day)).toBe(0)
      // a file that was deleted does not come back by opening the conversation
      attachments.remove(gone)
      clock = 40 * day
      void flow.read('d1', thread.id)
      expect(attachments.lookup(gone)).toEqual({ state: 'unknown' })
      expect(sweepAt(69 * day)).toBe(0)
      expect(attachments.lookup(keep).state).toBe('present')
      expect(sweepAt(70 * day)).toBe(1)
      threads.flushAll()
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
