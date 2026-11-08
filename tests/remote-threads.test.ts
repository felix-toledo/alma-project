import { describe, expect, it, vi } from 'vitest'
import { threadPage } from '../src/coordinator/channels/remote/thread-view'
import { defaultSettings } from '../src/shared/defaults'
import { defaultRemote } from '../src/shared/remote/settings'
import type { ChatMessage, LiveEvent } from '../src/shared/types'
import { COMPANY_AGENT, HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

/** Distinct bytes on every call, so two paired devices never share a session token. */
function varying(): (length: number) => Uint8Array {
  let n = 0
  return (length) => new Uint8Array(length).fill(++n % 256)
}

async function served(options: { history?: boolean; cont?: boolean } = {}): Promise<Harness> {
  const scopes = { ...defaultRemote().scopes, history: options.history ?? true }
  const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: options.cont ?? false }, random: varying() })
  await t.channel.sync()
  return t
}

/** Threads as the store lists them: newest first, the shared remote thread first of all. */
function seedThreads(t: Harness, count: number): string[] {
  const shared = t.chat.threads[0]
  if (shared) shared.updatedAt = count + 1
  for (let i = 0; i < count; i++) t.chat.threads.push({ ...makeThread(`t${i}`), title: `Thread ${i}`, updatedAt: count - i })
  return t.chat.threads.map((thread) => thread.id)
}

interface Row {
  id: string
  title: string
  current: boolean
}

const text = (role: 'user' | 'assistant', value: string, ts = 1): ChatMessage => ({ role, content: [{ type: 'text', text: value }], ts })
const bare = (kept: unknown): unknown => ({ messages: kept })

describe('thread view (spec 028 T24)', () => {
  it('AC-3.3 (028) the first page is the last 30 messages with absolute indexes', () => {
    const raw = Array.from({ length: 31 }, (_, i) => text('user', `m${i}`, 1000 + i))
    const page = threadPage(raw, {}, bare)
    expect(page.rev).toBe(31)
    expect(page.messages).toHaveLength(30)
    expect(page.messages[0]).toEqual({ index: 1, role: 'user', text: 'm1', at: 1001 })
    expect(page.messages.at(-1)).toMatchObject({ index: 30, text: 'm30' })
    expect(page.earlier).toBe(true)
  })

  it('AC-3.3 (028) before loads the 30 earlier messages and says when there are no more', () => {
    const raw = Array.from({ length: 75 }, (_, i) => text('assistant', `m${i}`))
    const page = threadPage(raw, { before: 45 }, bare)
    expect(page.messages.map((m) => m.index)).toEqual(Array.from({ length: 30 }, (_, i) => 15 + i))
    expect(page.earlier).toBe(true)
    const last = threadPage(raw, { before: 15 }, bare)
    expect(last.messages.map((m) => m.index)).toEqual(Array.from({ length: 15 }, (_, i) => i))
    expect(last.earlier).toBe(false)
  })

  it('AC-3.3 (028) since returns what is committed after that index and never an earlier flag', () => {
    const raw = Array.from({ length: 5 }, (_, i) => text('user', `m${i}`))
    const page = threadPage(raw, { since: 3 }, bare)
    expect(page.messages.map((m) => m.index)).toEqual([3, 4])
    expect(page.earlier).toBe(false)
  })

  it('AC-3.3 (028) tool and thinking blocks never appear and a message with no text is left out', () => {
    const raw: ChatMessage[] = [
      text('user', 'hola'),
      { role: 'assistant', content: [{ type: 'thinking', text: 'secret plan' } as never, { type: 'tool_use', id: 't', name: 'exec', input: { cmd: 'rm' } } as never], ts: 2 },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'out' } as never], ts: 3 },
      { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' } as never, { type: 'text', text: 'listo' }, { type: 'text', text: 'chau' }], ts: 4 }
    ]
    const page = threadPage(raw, {}, bare)
    expect(page.messages).toEqual([
      { index: 0, role: 'user', text: 'hola', at: 1 },
      { index: 3, role: 'assistant', text: 'listo\nchau', at: 4 }
    ])
    expect(JSON.stringify(page)).not.toMatch(/secret plan|exec|rm|out/)
  })

  it('AC-3.3 (028) the 1 MB fit drops the oldest first, keeps the envelope in the budget and flags earlier', () => {
    const big = 'x'.repeat(400_000)
    const raw = [text('user', big), text('assistant', big), text('user', big), text('assistant', 'last')]
    const page = threadPage(raw, {}, bare)
    expect(Buffer.byteLength(JSON.stringify(bare(page.messages)))).toBeLessThanOrEqual(1_048_576)
    expect(page.messages.at(-1)?.text).toBe('last')
    expect(page.messages[0]?.index).toBeGreaterThan(0)
    expect(page.earlier).toBe(true)
  })

  it('AC-3.3 (028) a lone message over the budget is cut to fit', () => {
    const page = threadPage([text('user', 'y'.repeat(2_000_000))], {}, bare)
    expect(page.messages).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(bare(page.messages)))).toBeLessThanOrEqual(1_048_576)
  })
})

describe('threads: list (spec 028 T26)', () => {
  it('AC-3.1 (028) first 30 then the next 30, company threads never listed', async () => {
    const t = await served()
    const ids = seedThreads(t, 60)
    t.chat.threads.push({ ...makeThread('company-1', COMPANY_AGENT), updatedAt: 99 })
    const first = (await t.call('/api/threads/list', { offset: 0 })).body as { rows: Row[]; more: boolean }
    expect(first.rows.map((row) => row.id)).toEqual(ids.slice(0, 30))
    expect(first.more).toBe(true)
    const second = (await t.call('/api/threads/list', { offset: 30 })).body as { rows: Row[]; more: boolean }
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(30, 60))
    expect(second.more).toBe(true)
    const last = (await t.call('/api/threads/list', { offset: 60 })).body as { rows: Row[]; more: boolean }
    expect(last.rows.map((row) => row.id)).toEqual(ids.slice(60))
    expect(last.more).toBe(false)
    expect(JSON.stringify([first, second, last])).not.toContain('company-1')
  })

  it('AC-3.1 (028) a row carries title, agent, channel and last update and nothing else', async () => {
    const t = await served()
    t.chat.threads.push({ ...makeThread('tg-1'), title: 'Desde Telegram', channel: 'telegram', updatedAt: 7 })
    const rows = ((await t.call('/api/threads/list', { offset: 0 })).body as { rows: unknown[] }).rows
    const agentName = defaultSettings().agents[0]?.name
    expect(agentName).toBeTruthy()
    expect(rows).toContainEqual({ id: 'tg-1', title: 'Desde Telegram', agentId: 'general', agentName, channel: 'telegram', updatedAt: 7, current: false })
  })

  it('AC-3.2 (028) no conversations is an empty page', async () => {
    const t = await served()
    t.chat.threads.length = 0
    expect((await t.call('/api/threads/list', { offset: 0 })).body).toEqual({ rows: [], more: false })
  })

  it('AC-3.10 (028) the shared thread is marked current and "New conversation" moves the mark', async () => {
    const t = await served()
    t.chat.threads.push({ ...makeThread('other'), updatedAt: 1 })
    const marked = async (): Promise<string[]> => ((await t.call('/api/threads/list', { offset: 0 })).body as { rows: Row[] }).rows.filter((row) => row.current).map((row) => row.id)
    expect(await marked()).toEqual(['remote'])
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: true, chat: true } })
    expect((await t.call('/api/chat/new', {})).status).toBe(200)
    expect(await marked()).toEqual(['remote-2'])
  })

  it('AC-1.1 (028) History off refuses the list', async () => {
    const t = await served({ history: false })
    expect(await t.call('/api/threads/list', { offset: 0 })).toMatchObject({ status: 403, body: { error: 'scope-off' } })
  })
})

describe('threads: read (spec 028 T27)', () => {
  it('AC-3.3 (028) read returns the last 30 text messages, running, waiting and earlier', async () => {
    const t = await served()
    const thread = makeThread('big')
    for (let i = 0; i < 40; i++) thread.messages.push(text(i % 2 ? 'assistant' : 'user', `m${i}`, 100 + i))
    t.chat.threads.push(thread)
    t.threads.running.add('big')
    const body = (await t.call('/api/threads/read', { id: 'big' })).body as { rev: number; running: boolean; waiting: boolean; earlier: boolean; messages: { index: number }[] }
    expect(body).toMatchObject({ rev: 40, running: true, waiting: false, earlier: true })
    expect(body.messages.map((m) => m.index)).toEqual(Array.from({ length: 30 }, (_, i) => 10 + i))
    const before = (await t.call('/api/threads/read', { id: 'big', before: 10 })).body as { earlier: boolean; messages: { index: number }[] }
    expect(before.messages.map((m) => m.index)).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect(before.earlier).toBe(false)
  })

  it('AC-3.4 (028) an unknown id and a company id give byte-identical answers', async () => {
    const t = await served()
    t.chat.threads.push(makeThread('c1', COMPANY_AGENT))
    const unknown = await t.call('/api/threads/read', { id: 'nope' })
    const company = await t.call('/api/threads/read', { id: 'c1' })
    expect(JSON.stringify(company)).toBe(JSON.stringify(unknown))
    expect(unknown).toMatchObject({ status: 404, body: { error: 'gone' } })
  })

  it('AC-3.5 (028) a thread deleted while open answers gone on the next read', async () => {
    const t = await served()
    t.chat.threads.push(makeThread('doomed'))
    expect((await t.call('/api/threads/read', { id: 'doomed' })).status).toBe(200)
    t.chat.threads.splice(t.chat.threads.findIndex((thread) => thread.id === 'doomed'), 1)
    expect(await t.call('/api/threads/read', { id: 'doomed' })).toMatchObject({ status: 404, body: { error: 'gone' } })
  })

  it('AC-3.12 (028) astral characters, CRLF and a 10,000-character line pass verbatim', async () => {
    const t = await served()
    const thread = makeThread('odd')
    const long = 'z'.repeat(10_000)
    thread.messages.push(text('user', 'hola 😀 𝒳\r\nsegunda línea\r\n'), text('assistant', long))
    t.chat.threads.push(thread)
    const body = (await t.call('/api/threads/read', { id: 'odd' })).body as { messages: { text: string }[] }
    expect(body.messages.map((m) => m.text)).toEqual(['hola 😀 𝒳\r\nsegunda línea\r\n', long])
  })

  it('AC-1.1 (028) History off reads nothing', async () => {
    const t = await served({ history: false })
    t.chat.threads.push(makeThread('x'))
    expect(await t.call('/api/threads/read', { id: 'x' })).toMatchObject({ status: 403, body: { error: 'scope-off' } })
  })
})

async function otherPhone(t: Harness): Promise<(path: string, body?: unknown) => ReturnType<Harness['call']>> {
  const { deviceId, privateKey } = await pairDevice(t, 'tablet')
  const token = await openSession(t, deviceId, privateKey)
  return (path, body) => t.transport.request({ method: 'POST', path, headers: { ...HOST, authorization: `Bearer ${token}` }, body })
}

const settle = async (t: Harness, index = 0): Promise<void> => {
  await t.chat.pending[index]?.promise.catch(() => undefined)
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('threads: send (spec 028 T28)', () => {
  it('AC-3.6 (028) the user message is committed first, the answer is committed, and the phone reads both', async () => {
    const t = await served({ cont: true })
    t.chat.threads.push(makeThread('talk'))
    expect(await t.call('/api/threads/send', { id: 'talk', text: 'hola' })).toMatchObject({ status: 200, body: { ok: true } })
    expect(t.chat.askCalls).toEqual([{ threadId: 'talk', text: 'hola' }])
    const during = (await t.call('/api/threads/read', { id: 'talk' })).body as { running: boolean; messages: { role: string }[] }
    expect(during).toMatchObject({ running: true, messages: [{ role: 'user' }] })
    t.chat.resolveAsk(0, 'listo')
    await settle(t)
    const after = (await t.call('/api/threads/read', { id: 'talk' })).body as { running: boolean; messages: { role: string; text: string }[] }
    expect(after.running).toBe(false)
    expect(after.messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:hola', 'assistant:listo'])
  })

  it('AC-3.6 (028) a failed run is failed, the user message stays and the device is free again', async () => {
    const t = await served({ cont: true })
    t.chat.threads.push(makeThread('talk'))
    t.chat.throwSync = true
    expect(await t.call('/api/threads/send', { id: 'talk', text: 'hola' })).toMatchObject({ status: 500, body: { error: 'failed' } })
    t.chat.throwSync = false
    await t.call('/api/threads/send', { id: 'talk', text: 'otra vez' })
    t.chat.rejectAsk(0, new Error('boom'))
    await settle(t)
    const after = (await t.call('/api/threads/read', { id: 'talk' })).body as { running: boolean; messages: { text: string }[] }
    expect(after.running).toBe(false)
    expect(after.messages.map((m) => m.text)).toEqual(['otra vez'])
    expect((await t.call('/api/threads/send', { id: 'talk', text: 'ahora sí' })).status).toBe(200)
  })

  it('AC-3.6 (028) 8000 characters pass and 8001 are refused before anything runs', async () => {
    const t = await served({ cont: true })
    t.chat.threads.push(makeThread('talk'))
    expect((await t.call('/api/threads/send', { id: 'talk', text: 'x'.repeat(8001) })).status).toBe(400)
    expect(t.chat.askCalls).toHaveLength(0)
    expect((await t.call('/api/threads/send', { id: 'talk', text: 'x'.repeat(8000) })).status).toBe(200)
  })

  it('AC-3.8 (028) a thread running on the PC or for another phone is busy and ask is not called', async () => {
    const t = await served({ cont: true })
    t.chat.threads.push(makeThread('pc'), makeThread('mine'))
    t.threads.running.add('pc')
    expect(await t.call('/api/threads/send', { id: 'pc', text: 'hola' })).toMatchObject({ status: 409, body: { error: 'busy' } })
    expect(t.chat.askCalls).toHaveLength(0)
    const tablet = await otherPhone(t)
    await tablet('/api/threads/send', { id: 'mine', text: 'de la tablet' })
    expect(await t.call('/api/threads/send', { id: 'mine', text: 'del celu' })).toMatchObject({ status: 409, body: { error: 'busy' } })
    expect(t.chat.askCalls).toEqual([{ threadId: 'mine', text: 'de la tablet' }])
  })

  it('AC-3.14 (028) a by-id send to the shared id behaves as the Chat tab, and busy when the PC runs there', async () => {
    const t = await served({ cont: true })
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: true, chat: true } })
    expect(await t.call('/api/threads/send', { id: 'remote', text: 'por id' })).toMatchObject({ status: 200 })
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: 'por id' }])
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers: (await t.phone()).headers })
    expect(state.body).toMatchObject({ running: true })
    expect(await t.call('/api/chat/send', { text: 'otra' })).toMatchObject({ status: 409, body: { error: 'busy' } })
    t.chat.resolveAsk(0, 'ok')
    await settle(t)
    t.threads.running.add('remote')
    expect(await t.call('/api/threads/send', { id: 'remote', text: 'x' })).toMatchObject({ status: 409, body: { error: 'busy' } })
    expect(await t.call('/api/chat/send', { text: 'Chat tab as 026' })).toMatchObject({ status: 200 })
  })

  it('AC-3.14 (028) sending into another id never re-points the shared thread', async () => {
    const t = await served({ cont: true })
    t.chat.threads.push(makeThread('other'))
    await t.call('/api/threads/send', { id: 'other', text: 'hola' })
    t.chat.resolveAsk(0, 'ok')
    await settle(t)
    const rows = ((await t.call('/api/threads/list', { offset: 0 })).body as { rows: Row[] }).rows
    expect(rows.filter((row) => row.current).map((row) => row.id)).toEqual(['remote'])
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: true, chat: true } })
    await t.call('/api/chat/send', { text: 'al chat' })
    expect(t.chat.askCalls.at(-1)).toEqual({ threadId: 'remote', text: 'al chat' })
  })

  it('AC-1.1 (028) continue off refuses with write-off and nothing runs', async () => {
    const t = await served({ cont: false })
    t.chat.threads.push(makeThread('talk'))
    expect(await t.call('/api/threads/send', { id: 'talk', text: 'hola' })).toMatchObject({ status: 403, body: { error: 'write-off' } })
    expect(t.chat.askCalls).toHaveLength(0)
  })

  it('AC-3.7 (028) a company id and an unknown id are gone and nothing runs', async () => {
    const t = await served({ cont: true })
    t.chat.threads.push(makeThread('c1', COMPANY_AGENT))
    const company = await t.call('/api/threads/send', { id: 'c1', text: 'hola' })
    const unknown = await t.call('/api/threads/send', { id: 'nope', text: 'hola' })
    expect(JSON.stringify(company)).toBe(JSON.stringify(unknown))
    expect(unknown).toMatchObject({ status: 404, body: { error: 'gone' } })
    expect(t.chat.askCalls).toHaveLength(0)
  })

  it('AC-3.19 (028) a Chat-tab run blocks a by-id send and the reverse', async () => {
    const t = await served({ cont: true })
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: true, chat: true } })
    t.chat.threads.push(makeThread('a'), makeThread('b'))
    await t.call('/api/chat/send', { text: 'en el chat' })
    expect(await t.call('/api/threads/send', { id: 'a', text: 'x' })).toMatchObject({ status: 409, body: { error: 'run-active' } })
    t.chat.resolveAsk(0, 'ok')
    await settle(t)
    expect((await t.call('/api/threads/send', { id: 'a', text: 'x' })).status).toBe(200)
    expect(await t.call('/api/chat/send', { text: 'otra' })).toMatchObject({ status: 409, body: { error: 'run-active' } })
    expect(await t.call('/api/threads/send', { id: 'b', text: 'y' })).toMatchObject({ status: 409, body: { error: 'run-active' } })
    expect(t.chat.askCalls.map((c) => c.threadId)).toEqual(['remote', 'a'])
  })
})

describe('threads: live follow (spec 028 T30)', () => {
  interface Win {
    rev: number
    running: boolean
    messages: { index: number; text: string }[]
  }
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  /** Starts a held read at the thread's current rev and tells whether it has answered yet. */
  async function hold(t: Harness, id: string): Promise<{ answer: Promise<Win>; settled: () => boolean }> {
    const rev = ((await t.call('/api/threads/read', { id })).body as Win).rev
    let done = false
    const answer = t.call('/api/threads/read', { id, since: rev, wait: true }).then((res) => {
      done = true
      return res.body as Win
    })
    await drain()
    return { answer, settled: () => done }
  }
  async function followed(): Promise<Harness> {
    const t = await served({ cont: true })
    const thread = makeThread('talk')
    thread.messages.push(text('user', 'antes'))
    t.chat.threads.push(thread)
    return t
  }
  const message = (threadId: string, value: string): LiveEvent => ({ type: 'message', scope: { threadId }, message: text('assistant', value) })

  it('AC-3.11 (028) a held read wakes on a committed message and shows only commits', async () => {
    const t = await followed()
    const held = await hold(t, 'talk')
    expect(held.settled()).toBe(false)
    t.chat.threads.find((thread) => thread.id === 'talk')?.messages.push(text('assistant', 'respuesta'))
    t.emit(message('talk', 'respuesta'))
    const win = await held.answer
    expect(win.messages).toEqual([{ index: 1, role: 'assistant', text: 'respuesta', at: 1 }])
    expect(win.rev).toBe(2)
  })

  it('AC-3.11 (028) a held read wakes when the run starts and when it ends', async () => {
    const t = await followed()
    const started = await hold(t, 'talk')
    t.threads.running.add('talk')
    t.emit({ type: 'run.started', threadId: 'talk' })
    expect(await started.answer).toMatchObject({ running: true, messages: [] })
    const ended = await hold(t, 'talk')
    t.threads.running.delete('talk')
    t.emit({ type: 'run.finished', threadId: 'talk' })
    expect(await ended.answer).toMatchObject({ running: false, messages: [] })
  })

  it('AC-3.11 (028) an unrelated event leaves the read held', async () => {
    const t = await followed()
    const held = await hold(t, 'talk')
    t.emit({ type: 'run.started', threadId: 'elsewhere' })
    await drain()
    expect(held.settled()).toBe(false)
    await t.channel.stop()
    await held.answer
  })

  it('AC-3.11 (028) a held read is released when the channel stops', async () => {
    const t = await followed()
    const held = await hold(t, 'talk')
    await t.channel.stop()
    expect(await held.answer).toMatchObject({ rev: 1, messages: [] })
  })

  it('AC-3.11 (028) a held read answers with the current state after 25 seconds', async () => {
    const t = await followed()
    vi.useFakeTimers()
    try {
      const held = await hold(t, 'talk')
      await vi.advanceTimersByTimeAsync(24_999)
      expect(held.settled()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await held.answer).toMatchObject({ rev: 1, messages: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-3.11 (028) a read without wait, or behind the cursor, answers at once', async () => {
    const t = await followed()
    expect(((await t.call('/api/threads/read', { id: 'talk', since: 1 })).body as Win).rev).toBe(1)
    const behind = (await t.call('/api/threads/read', { id: 'talk', since: 0, wait: true })).body as Win
    expect(behind.messages.map((m) => m.text)).toEqual(['antes'])
  })

  it('AC-3.5 (028) a held read of a thread that is deleted answers gone', async () => {
    const t = await followed()
    const rev = 1
    const answer = t.call('/api/threads/read', { id: 'talk', since: rev, wait: true })
    await drain()
    t.chat.threads.splice(t.chat.threads.findIndex((thread) => thread.id === 'talk'), 1)
    t.emit({ type: 'message', scope: { threadId: 'talk' }, message: text('user', 'x') })
    expect(await answer).toMatchObject({ status: 404, body: { error: 'gone' } })
  })
})
