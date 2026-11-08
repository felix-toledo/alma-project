import { describe, expect, it } from 'vitest'
import { earlierCursor, listThreads, MAX_HELD_MESSAGES, mergeRows, mergeWindow, readThread, sendThread, stopThread } from '../src/remote-client/lib/threads'
import type { FetchLike, FetchResponse } from '../src/remote-client/lib/session'
import type { ThreadWindow } from '../src/shared/remote/wire'

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

function respond(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function fake(handler: (call: Call) => FetchResponse): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string, init?: Call['init']) => {
    calls.push({ url, init })
    return handler({ url, init })
  }) as FetchLike & { calls: Call[] }
  fetch.calls = calls
  return fetch
}

const down: FetchLike = async () => {
  throw new TypeError('fetch failed')
}

const message = (index: number, text = `m${index}`, role: 'user' | 'assistant' = 'user') => ({ index, role, text, at: 1000 + index })
const windowOf = (over: Partial<ThreadWindow>): ThreadWindow => ({ rev: 0, running: false, ownRun: false, waiting: false, messages: [], earlier: false, ...over })
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => message(from + i))
const bodyOf = (call: Call) => JSON.parse(call.init?.body ?? '')

describe('PWA conversations client (028 AC-3.1, AC-3.3, AC-3.11, AC-3.12)', () => {
  it('AC-3.1 (028) the list page is posted by offset and deduplicates by id when pages are joined', async () => {
    const row = (id: string) => ({ id, title: id, agentId: 'a', agentName: 'Alma', updatedAt: 1, current: false })
    const fetch = fake(() => respond(200, { rows: [row('t1'), { id: 5 }, row('t2')], more: true }))
    const out = await listThreads({ fetch, token: 'tok', offset: 30 })
    expect(out).toEqual({ ok: true, rows: [row('t1'), row('t2')], more: true })
    expect(fetch.calls[0].url).toBe('/api/threads/list')
    expect(bodyOf(fetch.calls[0])).toEqual({ offset: 30 })
    // The list moved between pages: the row that slid into the next page is not shown twice, and the newer copy wins.
    const first = [row('t1'), row('t2')]
    const next = [{ ...row('t2'), title: 'renamed' }, row('t3')]
    expect(mergeRows(first, next).map((r) => r.id)).toEqual(['t1', 't2', 't3'])
    expect(mergeRows(first, next)[1].title).toBe('renamed')
  })

  it('AC-3.3 (028) a window is posted with only the keys asked and parsed with its flags', async () => {
    const body = windowOf({ rev: 31, running: true, ownRun: true, waiting: true, earlier: true, messages: [message(1), message(2, 'hola', 'assistant')] })
    const fetch = fake(() => respond(200, { ...body, messages: [...body.messages, { index: 'x' }, { index: 3, role: 'tool', text: 'z', at: 1 }] }))
    const out = await readThread({ fetch, token: 'tok', id: 't1' })
    expect(out).toEqual({ ok: true, window: body })
    expect(bodyOf(fetch.calls[0])).toEqual({ id: 't1' })
    await readThread({ fetch, token: 'tok', id: 't1', before: 12 })
    expect(bodyOf(fetch.calls[1])).toEqual({ id: 't1', before: 12 })
    await readThread({ fetch, token: 'tok', id: 't1', since: 31, wait: true })
    expect(bodyOf(fetch.calls[2])).toEqual({ id: 't1', since: 31, wait: true })
    expect(fetch.calls.every((call) => call.url === '/api/threads/read')).toBe(true)
  })

  it('AC-3.11 (028) a held read carries the abort signal so hiding the page cancels it', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const fetch: FetchLike = async (_url, init) => {
      seen.push(init?.signal)
      throw new TypeError('aborted')
    }
    const controller = new AbortController()
    expect(await readThread({ fetch, token: 't', id: 't1', since: 3, wait: true, signal: controller.signal })).toEqual({ ok: false, reason: 'network' })
    expect(seen[0]).toBe(controller.signal)
  })

  it('AC-3.12 (028) text passes verbatim: astral characters, CRLF and a 10,000-character line', async () => {
    const text = `\u{1F600} café\r\n${'x'.repeat(10_000)}\r\n`
    const fetch = fake(() => respond(200, windowOf({ rev: 1, messages: [message(0, text)] })))
    const out = await readThread({ fetch, token: 't', id: 't1' })
    expect(out.ok && out.window.messages[0].text).toBe(text)
  })

  it('AC-3.5 (028) a conversation deleted while on screen answers gone, and a 401 is an unknown device', async () => {
    expect(await readThread({ fetch: fake(() => respond(404, { error: 'gone' })), token: 't', id: 't1' })).toEqual({ ok: false, reason: 'gone' })
    expect(await readThread({ fetch: fake(() => respond(401, { error: 'unknown-device' })), token: 't', id: 't1' })).toEqual({ ok: false, reason: 'unknown-device' })
    expect(await listThreads({ fetch: fake(() => respond(403, { error: 'scope-off' })), token: 't', offset: 0 })).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-3.11 (028) mergeWindow appends by index and never shows a message twice', () => {
    const first = windowOf({ rev: 3, earlier: true, messages: range(0, 3) })
    // The follow asks since=rev and gets the new tail; an idle one gets nothing.
    const appended = mergeWindow(first, windowOf({ rev: 5, running: true, messages: range(3, 5) }))
    expect(appended.messages.map((m) => m.index)).toEqual([0, 1, 2, 3, 4])
    expect(appended).toMatchObject({ rev: 5, running: true, earlier: true })
    const idle = mergeWindow(appended, windowOf({ rev: 5, running: false }))
    expect(idle.messages).toHaveLength(5)
    expect(idle.earlier).toBe(true)
    // The same tail twice (a retried poll) adds nothing.
    expect(mergeWindow(appended, windowOf({ rev: 5, messages: range(3, 5) })).messages).toHaveLength(5)
    // A delta never replaces the held messages (the AC-8.7 rule).
    expect(mergeWindow(first, windowOf({ rev: 3 })).messages).toHaveLength(3)
  })

  it('AC-3.11 (028) mergeWindow prepends an earlier page without the 30 cap and takes its earlier flag', () => {
    const held = windowOf({ rev: 80, earlier: true, messages: range(50, 80) })
    const page1 = mergeWindow(held, windowOf({ rev: 80, earlier: true, messages: range(20, 50) }), 'earlier')
    expect(page1.messages.map((m) => m.index)).toEqual(Array.from({ length: 60 }, (_, i) => 20 + i))
    expect(page1.earlier).toBe(true)
    const page2 = mergeWindow(page1, windowOf({ rev: 80, earlier: false, messages: range(0, 20) }), 'earlier')
    expect(page2.messages).toHaveLength(80)
    expect(page2.earlier).toBe(false)
    // An empty earlier page (tool-only messages) says there is nothing more only if the PC says so.
    expect(mergeWindow(held, windowOf({ rev: 80, earlier: false }), 'earlier').earlier).toBe(false)
    expect(mergeWindow(held, windowOf({ rev: 80, earlier: true }), 'earlier').earlier).toBe(true)
  })

  it('AC-3.11 (028) mergeWindow replaces when the rev goes back and bounds the memory it holds', () => {
    const held = windowOf({ rev: 40, messages: range(10, 40) })
    const fresh = windowOf({ rev: 2, messages: range(0, 2) })
    expect(mergeWindow(held, fresh)).toEqual(fresh)
    expect(mergeWindow(null, fresh)).toEqual(fresh)
    // A long live follow trims the oldest and then says there are earlier ones to load.
    const long = mergeWindow(windowOf({ rev: 400, messages: range(100, 400) }), windowOf({ rev: 410, messages: range(400, 410) }))
    expect(long.messages).toHaveLength(MAX_HELD_MESSAGES)
    expect(long.messages.at(-1)?.index).toBe(409)
    expect(long.earlier).toBe(true)
  })

  it('AC-3.3 (028) earlierCursor moves back one page even when the page came back empty', () => {
    expect(earlierCursor(windowOf({ rev: 80, messages: range(50, 80) }))).toBe(50)
    // Asked before=50 and nothing with text came back: the next ask goes 30 further, not 50 again.
    expect(earlierCursor(windowOf({ rev: 80, messages: range(50, 80) }), 50)).toBe(20)
    expect(earlierCursor(windowOf({ rev: 80, messages: range(10, 80) }), 50)).toBe(10)
    expect(earlierCursor(windowOf({ rev: 12, earlier: true }))).toBe(0)
    expect(earlierCursor(windowOf({ rev: 100, earlier: true }))).toBe(70)
  })

  it('AC-3.6 (028) a send posts id and text; busy, run-active and write-off keep their cause, a server fault is not-delivered', async () => {
    const fetch = fake(() => respond(200, { ok: true }))
    expect(await sendThread({ fetch, token: 'tok', id: 't1', text: 'hola\r\n' })).toEqual({ ok: true })
    expect(fetch.calls[0].url).toBe('/api/threads/send')
    expect(bodyOf(fetch.calls[0])).toEqual({ id: 't1', text: 'hola\r\n' })
    const as = async (status: number, body: unknown) => sendThread({ fetch: fake(() => respond(status, body)), token: 't', id: 't1', text: 'x' })
    expect(await as(409, { error: 'busy' })).toEqual({ ok: false, reason: 'busy' })
    expect(await as(409, { error: 'run-active' })).toEqual({ ok: false, reason: 'run-active' })
    expect(await as(403, { error: 'write-off' })).toEqual({ ok: false, reason: 'write-off' })
    expect(await as(404, { error: 'gone' })).toEqual({ ok: false, reason: 'gone' })
    expect(await as(500, { error: 'failed' })).toEqual({ ok: false, reason: 'not-delivered' })
    expect(await sendThread({ fetch: down, token: 't', id: 't1', text: 'x' })).toEqual({ ok: false, reason: 'not-delivered' })
  })

  it('AC-3.18 (028) stop posts the id', async () => {
    const fetch = fake(() => respond(200, { ok: true }))
    expect(await stopThread({ fetch, token: 'tok', id: 't1' })).toEqual({ ok: true })
    expect(fetch.calls[0].url).toBe('/api/threads/stop')
    expect(bodyOf(fetch.calls[0])).toEqual({ id: 't1' })
    expect(await stopThread({ fetch: down, token: 't', id: 't1' })).toEqual({ ok: false, reason: 'network' })
  })
})
