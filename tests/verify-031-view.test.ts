import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/coordinator/attachments/store'
import { threadPage } from '../src/coordinator/channels/remote/thread-view'
import { ThreadStore } from '../src/coordinator/store'
import { phoneAttachmentViews } from '../src/shared/attach/phone'
import { REMOTE_LIMITS } from '../src/shared/remote/api'
import type { AuditEvent } from '../src/shared/audit'
import type { ChatMessage } from '../src/shared/types'
import { errorOf, idOf, OPEN, putBody, bytesOf, rig, type Rig } from './support/verify-031'
import { makeJpeg } from './support/verify-030'

const CHAT = '/api/chat/attach'
const BY_ID = '/api/threads/attach'
const T1 = 't1'
const DAY = 86_400_000
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

const say = (role: 'user' | 'assistant', text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content: text ? [{ type: 'text', text }] : [], ts: 1, ...extra })
const HOSTILE = {
  id: 'ID-MARKER',
  name: 'NAME-MARKER.txt',
  kind: 'text',
  size: 123,
  storedName: 'STORED-MARKER',
  path: 'PATH-MARKER',
  threadId: 'THREAD-MARKER',
  originalName: 'ORIGINAL-MARKER',
  removed: true,
  removedAt: 99,
  thumbnail: 'THUMB-MARKER',
  base64: 'B64-MARKER'
}
const withHostile = (...extra: Partial<ChatMessage>[]): ChatMessage => ({ ...say('user', 'hola'), attachments: [HOSTILE as never], ...Object.assign({}, ...extra) })

async function ready(): Promise<Rig> {
  const t = await rig()
  t.addThread(T1)
  return t
}
const read = async (t: Rig, body: object) => t.h.call('/api/threads/read', body)
async function state(t: Rig, query = ''): Promise<{ status: number; body: { messages: { attachments?: unknown[]; text: string; index: number }[]; rev: number } }> {
  const { headers } = await t.h.phone()
  return (await t.h.transport.request({ method: 'GET', path: '/api/state', query, headers })) as never
}

describe('031 verify: what the phone sees (US-5)', () => {
  it('AC-5.2 (031 verify) the projection keeps name, kind and size and nothing else, whatever fields the stored attachment has', () => {
    const views = phoneAttachmentViews([HOSTILE as never])
    expect(views).toEqual([{ name: 'NAME-MARKER.txt', kind: 'text', size: 123 }])
    expect(Object.keys(views[0]).sort()).toEqual(['kind', 'name', 'size'])
    expect(phoneAttachmentViews(undefined)).toEqual([])
    expect(phoneAttachmentViews([])).toEqual([])
  })

  it('AC-5.2 (031 verify) a serialised page carries the name and no other field of the attachment', () => {
    const page = threadPage([withHostile()], {}, (kept) => ({ rev: 1, messages: kept }))
    const json = JSON.stringify(page)
    expect(json).toContain('NAME-MARKER.txt')
    for (const marker of ['ID-MARKER', 'STORED-MARKER', 'PATH-MARKER', 'THREAD-MARKER', 'ORIGINAL-MARKER', 'THUMB-MARKER', 'B64-MARKER', 'removed']) expect(json).not.toContain(marker)
    expect(Object.keys(page.messages[0].attachments?.[0] ?? {}).sort()).toEqual(['kind', 'name', 'size'])
  })

  it('AC-5.2 (031 verify) the message itself still carries text only: tool calls, results and thinking never leave', () => {
    const message: ChatMessage = {
      role: 'assistant',
      ts: 1,
      content: [
        { type: 'text', text: 'visible' },
        { type: 'tool_use', id: 'TOOL-MARKER', name: 'exec', input: { cmd: 'SECRET-MARKER' } } as never,
        { type: 'thinking', thinking: 'THINK-MARKER' } as never
      ]
    }
    const json = JSON.stringify(threadPage([message], {}, (kept) => kept))
    expect(json).toContain('visible')
    for (const marker of ['TOOL-MARKER', 'SECRET-MARKER', 'THINK-MARKER']) expect(json).not.toContain(marker)
  })

  it('AC-5.3 (031 verify) a message with attachments and no text is listed with an empty text; with neither it is left out', () => {
    const only = say('user', '', { attachments: [HOSTILE as never] })
    const neither = say('user', '')
    const emptyList = say('user', '', { attachments: [] })
    const toolOnly: ChatMessage = { role: 'assistant', ts: 1, content: [{ type: 'tool_use', id: 'x', name: 'exec', input: {} } as never] }
    const page = threadPage([neither, only, emptyList, toolOnly, say('assistant', 'ok')], {}, (kept) => kept)
    expect(page.messages.map((m) => m.index)).toEqual([1, 4])
    expect(page.messages[0]).toMatchObject({ index: 1, role: 'user', text: '', attachments: [{ name: 'NAME-MARKER.txt', kind: 'text', size: 123 }] })
    expect('attachments' in page.messages[1]).toBe(false)
  })

  it('AC-5.3 (031 verify) an attachment-only message keeps its place in the live delta and counts for "earlier"', () => {
    const only = say('user', '', { attachments: [HOSTILE as never] })
    const thread = [only, ...Array.from({ length: 30 }, (_, i) => say('assistant', `m${i}`))]
    const first = threadPage(thread, {}, (kept) => kept)
    expect(first.messages).toHaveLength(30)
    expect(first.earlier).toBe(true)
    const noneEarlier = threadPage([say('user', ''), ...thread.slice(1)], {}, (kept) => kept)
    expect(noneEarlier.earlier).toBe(false)
    const delta = threadPage(thread, { since: 0 }, (kept) => kept)
    expect(delta.messages[0].index).toBe(0)
  })

  it('AC-5.3 (031 verify) both read paths list it: the Chat tab state and a conversation read', async () => {
    const t = await ready()
    t.h.chat.threads[0].messages.push(say('user', '', { attachments: [HOSTILE as never] }))
    t.h.chat.threads.find((x) => x.id === T1)?.messages.push(say('user', '', { attachments: [HOSTILE as never] }))
    const chat = await state(t)
    expect(chat.body.messages).toHaveLength(1)
    expect(chat.body.messages[0].text).toBe('')
    const byId = await read(t, { id: T1 })
    expect((byId.body as { messages: unknown[] }).messages).toHaveLength(1)
    for (const body of [chat.body, byId.body]) for (const marker of ['ID-MARKER', 'PATH-MARKER', 'STORED-MARKER']) expect(JSON.stringify(body)).not.toContain(marker)
  })

  it('AC-5.4 (031 verify) the attachment lists count toward the 1 MB cap: a page that fits without them is cut when they are added', () => {
    const fat = (extra: boolean): ChatMessage[] =>
      Array.from({ length: 8 }, (_, i) => ({
        ...say(i % 2 ? 'assistant' : 'user', 'x'.repeat(129_000)),
        ...(extra ? { attachments: Array.from({ length: 5 }, (_, n) => ({ id: `i${n}`, name: `${'n'.repeat(500)}${n}.txt`, kind: 'text' as const, size: 5 })) } : {})
      }))
    const without = threadPage(fat(false), {}, (kept) => ({ rev: 8, messages: kept }))
    expect(without.messages).toHaveLength(8)
    expect(bytes({ rev: 8, messages: without.messages })).toBeLessThanOrEqual(REMOTE_LIMITS.requestBytes)
    const withFiles = threadPage(fat(true), {}, (kept) => ({ rev: 8, messages: kept }))
    expect(withFiles.messages.length).toBeLessThan(8)
    expect(bytes({ rev: 8, messages: withFiles.messages })).toBeLessThanOrEqual(REMOTE_LIMITS.requestBytes)
    // the newest are kept on a first load
    expect(withFiles.messages.at(-1)?.index).toBe(7)
    expect(withFiles.earlier).toBe(true)
  })

  it('AC-5.4 (031 verify) the live delta keeps the oldest and hands back a cursor past what it sent, with attachments counted', () => {
    const msgs: ChatMessage[] = Array.from({ length: 8 }, (_, i) => ({
      ...say('assistant', 'x'.repeat(129_000)),
      attachments: Array.from({ length: 5 }, (_, n) => ({ id: `i${n}`, name: `${'n'.repeat(500)}${n}.txt`, kind: 'text' as const, size: 5 }))
      , ts: i
    }))
    const page = threadPage(msgs, { since: 0 }, (kept) => ({ rev: 8, messages: kept }))
    expect(page.messages.length).toBeLessThan(8)
    expect(page.rev).toBe(page.messages.length)
    expect(bytes({ rev: 8, messages: page.messages })).toBeLessThanOrEqual(REMOTE_LIMITS.requestBytes)
  })

  it('AC-5.4 (031 verify) through the channel a read with many heavy attachment messages never exceeds the response cap', async () => {
    const t = await ready()
    const thread = t.h.chat.threads.find((x) => x.id === T1)
    for (let i = 0; i < 8; i++) thread?.messages.push(say('user', 'x'.repeat(129_000), { attachments: Array.from({ length: 5 }, (_, n) => ({ id: `i${n}`, name: `${'n'.repeat(500)}${n}.txt`, kind: 'text' as const, size: 5 })) }))
    const answer = await read(t, { id: T1 })
    expect(answer.status).toBe(200)
    expect(bytes(answer.body)).toBeLessThanOrEqual(REMOTE_LIMITS.requestBytes)
  })

  it('AC-5.5 (031 verify) a swept or deleted attachment is shown exactly as before, and the view never asks the store', async () => {
    const t = await ready()
    const id = idOf(await t.h.call(BY_ID, { id: T1, ...putBody('nota.txt', bytesOf('hola')) }))
    t.h.chat.threads.find((x) => x.id === T1)?.messages.push(say('user', 'mirá', { attachments: [{ id, name: 'nota.txt', kind: 'text', size: 4 }] }))
    const before = await read(t, { id: T1 })
    t.store.remove(id)
    expect(t.store.lookup(id).state).toBe('unknown')
    const lookups = vi.spyOn(t.store, 'lookup')
    const after = await read(t, { id: T1 })
    expect(after.body).toEqual(before.body)
    expect(lookups).not.toHaveBeenCalled()
    expect((after.body as { messages: { attachments: unknown[] }[] }).messages[0].attachments).toEqual([{ name: 'nota.txt', kind: 'text', size: 4 }])
  })

  it('AC-5.6 (031 verify) a message sent from the desktop, Telegram or a routine shows its attachments when History reads that conversation', async () => {
    const t = await ready()
    t.addThread('tg', 'general', { channel: 'telegram' })
    t.h.chat.threads.find((x) => x.id === 'tg')?.messages.push(say('user', 'foto', { attachments: [HOSTILE as never] }))
    const answer = await read(t, { id: 'tg' })
    expect((answer.body as { messages: { attachments: unknown[] }[] }).messages[0].attachments).toEqual([{ name: 'NAME-MARKER.txt', kind: 'text', size: 123 }])
    t.h.setRemote({ scopes: { ...OPEN, history: false } })
    expect(errorOf(await read(t, { id: 'tg' }))).toBe('scope-off')
  })

  it('AC-5.6 (031 verify) with Chat off the state poll shows no messages at all, attachments included', async () => {
    const t = await ready()
    t.h.chat.threads[0].messages.push(withHostile())
    t.h.setRemote({ scopes: { ...OPEN, chat: false, approve: true } })
    const answer = await state(t)
    expect(answer.body.messages).toEqual([])
  })

  it('AC-5.1 (031 verify) a message without attachments carries no attachments key at all', async () => {
    const t = await ready()
    t.h.chat.threads[0].messages.push(say('user', 'hola'))
    const answer = await state(t)
    expect('attachments' in answer.body.messages[0]).toBe(false)
  })
})

describe('031 verify: opening a conversation on the phone (US-7)', () => {
  it('AC-6.1 (031 verify) the first plain read of a reachable conversation marks it opened now; the shared thread by id too', async () => {
    const t = await ready()
    t.h.setNow(5_000)
    await read(t, { id: T1 })
    expect(t.h.threads.opened).toEqual([{ id: T1, at: 5_000 }])
    t.h.setNow(6_000)
    await read(t, { id: 'remote' })
    expect(t.h.threads.opened.at(-1)).toEqual({ id: 'remote', at: 6_000 })
  })

  it('AC-6.2 (031 verify) a read with since or before, in any form, does not mark it', async () => {
    const t = await ready()
    for (const body of [{ id: T1, since: 0 }, { id: T1, since: 3 }, { id: T1, before: 0 }, { id: T1, before: 5 }, { id: T1, since: 0, before: 5 }]) await read(t, body)
    expect(t.h.threads.opened).toEqual([])
  })

  it('AC-6.2 (031 verify) a held repeat (wait with since) does not mark it', async () => {
    const t = await ready()
    const controller = new AbortController()
    const { headers } = await t.h.phone()
    const held = t.h.transport.request({ method: 'POST', path: '/api/threads/read', headers, body: { id: T1, since: 0, wait: true }, signal: controller.signal })
    await flush()
    controller.abort()
    await held
    expect(t.h.threads.opened).toEqual([])
  })

  it('AC-6.2 (031 verify) a company conversation, an unknown id, a listing and a refused read never mark anything', async () => {
    const t = await ready()
    t.addThread('co', 'ceo')
    await read(t, { id: 'co' })
    await read(t, { id: 'nope' })
    await read(t, { id: '../../x' })
    await t.h.call('/api/threads/list', { offset: 0 })
    t.h.setRemote({ scopes: { ...OPEN, history: false } })
    await read(t, { id: T1 })
    expect(t.h.threads.opened).toEqual([])
    t.h.setRemote({ scopes: OPEN })
    const unknown = await t.device('stranger')
    const { headers } = await t.h.phone()
    await t.h.transport.request({ method: 'POST', path: '/api/threads/read', headers: { ...headers, authorization: 'Bearer nope' }, body: { id: T1 } })
    void unknown
    expect(t.h.threads.opened).toEqual([])
  })

  it('AC-6.4 (031 verify) the Chat tab\'s state poll, with or without a cursor, does not mark the shared thread', async () => {
    const t = await ready()
    t.h.chat.threads[0].messages.push(say('user', 'hola'))
    await state(t)
    // a cursor behind the thread answers at once instead of being held
    await state(t, 'since=0')
    expect(t.h.threads.opened).toEqual([])
  })

  it('AC-6.1 (031 verify) a read that changes nothing else: the thread\'s messages and updatedAt are as they were', async () => {
    const t = await ready()
    const thread = t.h.chat.threads.find((x) => x.id === T1)
    if (!thread) throw new Error('no thread')
    thread.updatedAt = 777
    thread.messages.push(say('user', 'hola'))
    await read(t, { id: T1 })
    expect(thread.updatedAt).toBe(777)
    expect(thread.messages).toHaveLength(1)
  })

  it('AC-6.1 (031 verify) the real store\'s markOpened leaves updatedAt and the list order alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-v031-threads-'))
    const store = new ThreadStore(dir)
    try {
      const a = store.create('general', '')
      const b = store.create('general', '')
      a.updatedAt = 100
      b.updatedAt = 200
      const order = store.list().map((s) => s.id)
      store.markOpened(a.id, 99_999)
      expect(store.get(a.id).lastOpenedAt).toBe(99_999)
      expect(store.get(a.id).updatedAt).toBe(100)
      expect(store.list().map((s) => s.id)).toEqual(order)
      store.markOpened('no-such-thread', 1)
    } finally {
      for (const s of store.list()) store.delete(s.id)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('AC-6.3 (031 verify) a conversation opened on the phone restarts its attachments\' 30 days; one never opened is swept; a deleted file stays deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-v031-clock-'))
    const t = await ready()
    let clock = 0
    const threads = new ThreadStore(join(dir, 'data'))
    const opened = threads.create('general', '')
    const unopened = threads.create('general', '')
    const files = new AttachmentStore(join(dir, 'inbox'), { now: () => clock })
    t.h.threads.get = (id) => (threads.list().some((s) => s.id === id) ? threads.get(id) : undefined)
    t.h.threads.markOpened = (id, at) => threads.markOpened(id, at)
    try {
      const make = (threadId: string) => {
        const result = files.store({ threadId, name: 'a.txt', size: 2, base64: Buffer.from('hi').toString('base64') })
        if (!result.ok) throw new Error('store failed')
        return result.attachment.id
      }
      const keptId = make(opened.id)
      const lostId = make(unopened.id)
      threads.markOpened(opened.id, 0)
      threads.markOpened(unopened.id, 0)
      t.h.setNow(29 * DAY)
      await read(t, { id: opened.id })
      expect(threads.get(opened.id).lastOpenedAt).toBe(29 * DAY)
      clock = 31 * DAY
      const sweep = () => files.sweep((id) => threads.get(id).lastOpenedAt, new Set())
      expect(sweep()).toEqual({ removed: 1, failed: 0 })
      expect(files.lookup(keptId).state).toBe('present')
      expect(files.lookup(lostId).state).toBe('removed')
      // reading the conversation again does not bring a deleted file back
      t.h.setNow(32 * DAY)
      await read(t, { id: unopened.id })
      expect(files.lookup(lostId).state).toBe('removed')
      // and the clock the read set runs out 30 days later
      clock = 60 * DAY
      sweep()
      expect(files.lookup(keptId).state).toBe('removed')
    } finally {
      for (const s of threads.list()) threads.delete(s.id)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('031 verify: audit and privacy (US-8)', () => {
  const MARKS = { name: 'NAMEMARK', text: 'TEXTMARK', content: 'CONTENTMARK' }
  async function audited() {
    const records: AuditEvent[] = []
    const t = await rig({ record: (entry) => records.push(entry) })
    t.addThread(T1)
    return { t, records }
  }
  const puts = (records: AuditEvent[]) => records.filter((r) => r.action === 'remote.attachments.put')

  it('AC-7.1 (031 verify) a stored put writes exactly one remote entry with the device, the outcome, and the kind and size as numbers', async () => {
    const { t, records } = await audited()
    const data = bytesOf(MARKS.content)
    await t.h.call(CHAT, putBody(`${MARKS.name}.txt`, data))
    const device = (await t.h.phone()).deviceId
    expect(puts(records)).toEqual([{ action: 'remote.attachments.put', actor: 'remote', outcome: 'ok', detail: { deviceId: device, kind: 'text', size: data.length } }])
    expect(typeof puts(records)[0].detail?.size).toBe('number')
  })

  it('AC-7.1 (031 verify) a picture is audited as its stored size (after the metadata strip)', async () => {
    const { t, records } = await audited()
    const photo = makeJpeg()
    const answer = await t.h.call(CHAT, putBody('p.jpg', photo))
    expect(puts(records)[0].detail).toMatchObject({ kind: 'image', size: (answer.body as { attachment: { size: number } }).attachment.size })
  })

  it('AC-7.1 (031 verify) each put that reaches the PC and is refused writes one entry with no kind and size', async () => {
    const { t, records } = await audited()
    const device = (await t.h.phone()).deviceId
    const refusals: [string, ReturnType<typeof putBody>][] = [
      ['file-type', putBody('x.exe', bytesOf('x'))],
      ['file-content', putBody('x.png', bytesOf('not png'))],
      ['secret-name', putBody('.env', bytesOf('A=1'))],
      ['too-large', putBody('big.txt', new Uint8Array(700_001).fill(97))]
    ]
    for (const [, body] of refusals) await t.h.call(CHAT, body)
    expect(puts(records)).toHaveLength(refusals.length)
    for (const entry of puts(records)) expect(entry).toEqual({ action: 'remote.attachments.put', actor: 'remote', outcome: 'denied', detail: { deviceId: device }, throttle: true })
  })

  it('AC-7.1 (031 verify) a busy, gone, too-many or notice-needed put each writes one entry; a storage failure is an error entry', async () => {
    const { t, records } = await audited()
    t.h.threads.running.add(T1)
    await t.h.call(BY_ID, { id: T1, ...putBody('a.txt', bytesOf('x')) })
    await t.h.call(BY_ID, { id: 'nope', ...putBody('a.txt', bytesOf('x')) })
    expect(puts(records).map((r) => r.outcome)).toEqual(['denied', 'denied'])
    t.acknowledge([])
    await t.h.call(CHAT, putBody('a.txt', bytesOf('x')))
    expect(puts(records)).toHaveLength(3)
    const failing = await rig({ io: { writeFileSync: (() => { throw new Error('disk full') }) as never } })
    const seen: AuditEvent[] = []
    const failingAudited = await rig({ io: { writeFileSync: (() => { throw new Error('disk full') }) as never }, record: (e) => seen.push(e) })
    void failing
    await failingAudited.h.call(CHAT, putBody('a.txt', bytesOf('x')))
    expect(puts(seen)).toEqual([expect.objectContaining({ outcome: 'error' })])
    expect(puts(seen)[0].detail).toEqual({ deviceId: (await failingAudited.h.phone()).deviceId })
  })

  it('AC-7.1 (031 verify) a request refused at the boundary (bad schema) never reached the PC and writes nothing', async () => {
    const { t, records } = await audited()
    await t.h.call(CHAT, { name: 'a.txt', size: 99, base64: 'AAAA' })
    expect(puts(records)).toEqual([])
  })

  it('AC-7.1 (031 verify) a remove is audited as a change with the device only', async () => {
    const { t, records } = await audited()
    const id = idOf(await t.h.call(CHAT, putBody('a.txt', bytesOf('x'))))
    await t.h.call('/api/attachments/remove', { id })
    const removes = records.filter((r) => r.action === 'remote.attachments.remove')
    expect(removes).toEqual([{ action: 'remote.attachments.remove', actor: 'remote', outcome: 'ok', detail: { deviceId: (await t.h.phone()).deviceId } }])
  })

  it('AC-7.1 (031 verify) a send that carries attachments adds only the count; a text-only send adds nothing', async () => {
    const { t, records } = await audited()
    const device = (await t.h.phone()).deviceId
    const a = idOf(await t.h.call(CHAT, putBody('a.txt', bytesOf('x'))))
    const b = idOf(await t.h.call(CHAT, putBody('b.txt', bytesOf('y'))))
    await t.h.call('/api/chat/send', { text: 'hola', attachments: [a, b] })
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    const c = idOf(await t.h.call(BY_ID, { id: T1, ...putBody('c.txt', bytesOf('z')) }))
    await t.h.call('/api/threads/send', { id: T1, text: 'hola', attachments: [c] })
    t.h.chat.resolveAsk(1, 'ok')
    await flush()
    await t.h.call('/api/chat/send', { text: 'solo texto' })
    const sends = records.filter((r) => r.action === 'remote.chat.send' || r.action === 'remote.threads.send')
    expect(sends).toEqual([
      { action: 'remote.chat.send', actor: 'remote', outcome: 'ok', detail: { deviceId: device, attachments: 2 } },
      { action: 'remote.threads.send', actor: 'remote', target: T1, outcome: 'ok', detail: { deviceId: device, attachments: 1 } },
      { action: 'remote.chat.send', actor: 'remote', outcome: 'ok', detail: { deviceId: device } }
    ])
  })

  it('AC-7.2 (031 verify) no entry or log line of any new operation carries a name, id, text, content or base64', async () => {
    const logs: string[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' '))))
    try {
      const { t, records } = await audited()
      const content = bytesOf(MARKS.content)
      const body = putBody(`${MARKS.name}.txt`, content)
      const stored = await t.h.call(CHAT, body)
      const id = idOf(stored)
      await t.h.call(BY_ID, { id: T1, ...putBody(`${MARKS.name}2.txt`, content) })
      await t.h.call(CHAT, putBody(`${MARKS.name}.exe`, content))
      await t.h.call(CHAT, putBody(`${MARKS.name}.pem`, content))
      await t.h.call(CHAT, putBody(`${MARKS.name}.png`, content))
      await t.h.call(BY_ID, { id: 'nope', ...putBody(`${MARKS.name}3.txt`, content) })
      await t.h.call('/api/chat/send', { text: MARKS.text, attachments: [id, `${MARKS.name}-bad-id`] })
      await t.h.call('/api/chat/send', { text: MARKS.text, attachments: [id] })
      t.h.chat.resolveAsk(0, 'ok')
      await flush()
      await t.h.call('/api/threads/send', { id: T1, text: MARKS.text, attachments: [`${MARKS.name}-id2`] })
      await t.h.call('/api/attachments/remove', { id })
      await t.h.call('/api/attachments/remove', { id: `${MARKS.name}-id3` })
      t.h.setRemote({ sendFiles: false })
      await t.h.call(CHAT, body)
      await t.h.call('/api/chat/send', { text: MARKS.text, attachments: [id] })
      const everything = JSON.stringify(records) + logs.join('\n')
      for (const secret of [MARKS.name, MARKS.text, MARKS.content, id, body.base64, Buffer.from(MARKS.content).toString('base64'), 'authorization', 'Bearer']) expect(everything).not.toContain(secret)
      expect(records.length).toBeGreaterThan(5)
      for (const entry of records) for (const value of Object.values(entry.detail ?? {})) expect(['number', 'string']).toContain(typeof value)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('AC-7.2 (031 verify) the remote.attachments entries of a phone upload carry no attachment id; the own spec 030 entries of the store keep their id, kind and size', async () => {
    const { attachmentLog } = await import('../src/coordinator/attachments/service')
    const trail: AuditEvent[] = []
    const t = await rig({ log: attachmentLog((entry) => trail.push(entry)), record: (entry) => trail.push(entry) })
    const id = idOf(await t.h.call(CHAT, putBody(`${MARKS.name}.txt`, bytesOf(MARKS.content))))
    await t.h.call('/api/attachments/remove', { id })
    const own = trail.filter((entry) => entry.action.startsWith('attachment.'))
    expect(own.length).toBeGreaterThan(0)
    // the store's own entries (spec 030) keep the id and, for a store, the kind and size; only remote.attachments.* hide the id (spec 031 AC-7.2)
    expect(own.find((entry) => entry.action === 'attachment.store')?.detail).toMatchObject({ id, kind: 'text', size: bytesOf(MARKS.content).length })
    const remote = trail.filter((entry) => entry.action.startsWith('remote.attachments.'))
    expect(remote.length).toBeGreaterThan(0)
    expect(JSON.stringify(remote)).not.toContain(id)
  })

  it('AC-7.2 (031 verify) the audit mapping drops any detail that is not a number or a file kind, even if a caller passes one', async () => {
    const { auditRemote } = await import('../src/coordinator/channels/remote/audit')
    const seen: AuditEvent[] = []
    auditRemote((e) => seen.push(e), 'remote.attachments.put', 'ok', 'dev', { detail: { size: 5, kind: 'text', name: 'NAMEMARK', id: 'ID-1', evil: 'application/x-evil', nan: Number.NaN, inf: Number.POSITIVE_INFINITY } as never })
    expect(seen[0].detail).toEqual({ size: 5, kind: 'text', deviceId: 'dev' })
  })

  it('AC-7.3 (031 verify) a sub-switch, scope or authentication refusal on a new operation is a throttled denied entry without names', async () => {
    const { t, records } = await audited()
    const device = (await t.h.phone()).deviceId
    t.h.setRemote({ sendFiles: false })
    await t.h.call(CHAT, putBody('a.txt', bytesOf('x')))
    await t.h.call('/api/attachments/remove', { id: 'x' })
    await t.h.call('/api/chat/send', { text: 'hola', attachments: ['x'] })
    t.h.setRemote({ sendFiles: true, scopes: { ...OPEN, chat: false } })
    await t.h.call(CHAT, putBody('a.txt', bytesOf('x')))
    t.h.setRemote({ scopes: OPEN, continueHistory: false })
    await t.h.call(BY_ID, { id: T1, ...putBody('a.txt', bytesOf('x')) })
    t.h.setRemote({ continueHistory: true })
    const { headers } = await t.h.phone()
    await t.h.transport.request({ method: 'POST', path: CHAT, headers: { ...headers, authorization: 'Bearer wrong' }, body: putBody('a.txt', bytesOf('x')) })
    expect(records.length).toBe(6)
    for (const entry of records) expect(entry).toMatchObject({ actor: 'remote', outcome: 'denied', throttle: true })
    expect(records.slice(0, 5).map((r) => r.detail)).toEqual(Array(5).fill({ deviceId: device }))
    expect(records[5].detail).toBeUndefined()
    expect(records.map((r) => r.action)).toEqual([
      'remote.attachments.put', 'remote.attachments.remove', 'remote.chat.send', 'remote.attachments.put', 'remote.attachments.put', 'remote.attachments.put'
    ])
  })

  it('AC-7.3 (031 verify) a trail that cannot be written never interrupts a put, a remove or a send', async () => {
    const throwing = await rig({ record: () => { throw new Error('disk full') } })
    throwing.addThread(T1)
    const stored = await throwing.h.call(CHAT, putBody('a.txt', bytesOf('x')))
    expect(stored.status).toBe(200)
    expect(throwing.onDisk().folders).toHaveLength(1)
    expect((await throwing.h.call('/api/chat/send', { text: 'hola', attachments: [idOf(stored)] })).status).toBe(200)
    expect((await throwing.h.call('/api/attachments/remove', { id: 'x' })).status).toBe(200)
    throwing.h.setRemote({ sendFiles: false })
    expect(errorOf(await throwing.h.call(CHAT, putBody('a.txt', bytesOf('x'))))).toBe('attach-off')
  })

  it('AC-7.4 (031 verify) every response of the new routes, ok or refused, is no-store', async () => {
    const t = await ready()
    const other = await t.device('other')
    const good = putBody('a.txt', bytesOf('x'))
    const answers = [
      await t.h.call(CHAT, good),
      await t.h.call(CHAT, putBody('x.exe', bytesOf('x'))),
      await t.h.call(CHAT, putBody('.env', bytesOf('x'))),
      await t.h.call(CHAT, { ...good, extra: 1 }),
      await t.h.call(CHAT, { name: 'a.txt', size: 1, base64: 'A'.repeat(1_100_000) }),
      await t.h.call(BY_ID, { id: 'nope', ...good }),
      await t.h.call(BY_ID, { id: T1, ...good }),
      await t.h.call('/api/attachments/remove', { id: 'x' }),
      await t.h.call('/api/attachments/remove', {}),
      await t.h.call('/api/chat/send', { text: 'hola', attachments: ['nope'] }),
      await t.h.call('/api/chat/send', { text: 'hola', attachments: [] }),
      await t.h.call('/api/threads/send', { id: T1, text: 'hola', attachments: ['nope'] }),
      await t.h.call('/api/threads/send', { id: 'nope', text: 'hola', attachments: ['nope'] }),
      await other.call(CHAT, good)
    ]
    t.acknowledge([])
    answers.push(await t.h.call(CHAT, good))
    t.h.setRemote({ sendFiles: false })
    answers.push(await t.h.call(CHAT, good), await t.h.call('/api/attachments/remove', { id: 'x' }), await t.h.call('/api/chat/send', { text: 'h', attachments: ['x'] }))
    t.h.setRemote({ sendFiles: true, scopes: { ...OPEN, chat: false } })
    answers.push(await t.h.call(CHAT, good))
    const { headers } = await t.h.phone()
    answers.push(await t.h.transport.request({ method: 'POST', path: CHAT, headers: { ...headers, authorization: 'Bearer nope' }, body: good }))
    answers.push(await t.h.transport.request({ method: 'POST', path: '/api/chat/attach/extra', headers, body: good }))
    answers.push(await t.h.transport.request({ method: 'GET', path: CHAT, headers }))
    answers.push(await t.h.transport.request({ method: 'DELETE', path: '/api/attachments/remove', headers, body: {} }))
    for (const answer of answers) expect(answer.headers?.['cache-control']).toBe('no-store')
    expect(answers.length).toBeGreaterThan(15)
  })

  it('AC-7.4 (031 verify) the phone keeps no chip, file or attachment list in storage and the service worker leaves /api alone', async () => {
    const { readFileSync } = await import('node:fs')
    const root = join(__dirname, '..', 'src', 'remote-client')
    for (const file of ['lib/attach.ts', 'lib/attach-flow.ts', 'lib/shrink.ts', 'lib/canvas.ts', 'screens/useAttachments.ts', 'screens/AttachBar.tsx', 'screens/FileLines.tsx']) {
      const source = readFileSync(join(root, file), 'utf8')
      expect({ file, uses: /localStorage|sessionStorage|indexedDB|\bcaches\b|from '\.\.?\/(lib\/)?(storage|idb)'/.test(source) }).toEqual({ file, uses: false })
    }
    expect(readFileSync(join(root, 'public/sw.js'), 'utf8')).toMatch(/startsWith\('\/api\/'\)/)
  })

  it('AC-7.5 (031 verify) a put and a send reach no host: no fetch, no push post, nothing outbound from the channel', async () => {
    const t = await ready()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const id = idOf(await t.h.call(CHAT, putBody('a.txt', bytesOf('x'))))
    await t.h.call('/api/chat/send', { text: 'hola', attachments: [id] })
    await t.h.call('/api/attachments/remove', { id })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(t.h.posts).toEqual([])
    fetchSpy.mockRestore()
  })
})
