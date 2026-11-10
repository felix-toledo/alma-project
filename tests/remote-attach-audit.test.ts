import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { auditRemote, ROUTE_OPS } from '../src/coordinator/channels/remote/audit'
import type { AuditEvent } from '../src/shared/audit'
import { ALLOWED_EXTENSIONS } from '../src/shared/attach/rules'
import { refusalResponse } from '../src/coordinator/channels/remote/transport'
import { ROUTES } from '../src/shared/remote/api'
import { defaultRemote } from '../src/shared/remote/settings'
import type { RemoteSettings } from '../src/shared/types'
import { HOST, makeThread, testChannel, type Harness } from './support/remote-harness'

const NAME_MARKER = 'MARKER-FILE-NAME.png'
const ID_MARKER = 'MARKER-ATTACHMENT-ID-0000'
const BASE64_MARKER = 'TUFSS0VSLUJBU0U2NA=='

describe('the audit mapping of spec 031 (T20)', () => {
  it('AC-7.2 (031) every kind of file the 030 rules know is kept in a detail', () => {
    const kinds = [...new Set(Object.values(ALLOWED_EXTENSIONS))]
    expect(kinds.length).toBeGreaterThan(0)
    for (const kind of kinds) {
      const record = vi.fn()
      auditRemote(record, 'remote.attachments.put', 'ok', 'dev1', { detail: { kind } })
      expect(record.mock.calls[0][0].detail).toEqual({ kind, deviceId: 'dev1' })
    }
  })

  it('AC-7.1 (031) the new routes have operations', () => {
    expect(ROUTE_OPS['/api/chat/attach']).toBe('remote.attachments.put')
    expect(ROUTE_OPS['/api/threads/attach']).toBe('remote.attachments.put')
    expect(ROUTE_OPS['/api/attachments/remove']).toBe('remote.attachments.remove')
    // no route is left without an operation of its own (a missing one would be audited under its path)
    for (const route of ROUTES) expect(ROUTE_OPS[route.path], route.path).toMatch(/^remote\./)
  })

  it('AC-7.2 (031) auditRemote takes numbers and kinds as detail and drops anything else', () => {
    const entries: AuditEvent[] = []
    const record = (entry: AuditEvent) => void entries.push(entry)
    auditRemote(record, 'remote.attachments.put', 'ok', 'dev1', { detail: { kind: 'image', size: 700_000, attachments: 2 } })
    expect(entries[0]).toEqual({ action: 'remote.attachments.put', actor: 'remote', outcome: 'ok', detail: { deviceId: 'dev1', kind: 'image', size: 700_000, attachments: 2 } })

    // by type a string that is not a kind does not compile; at run time it is dropped all the same
    const hostile = {
      name: NAME_MARKER,
      id: ID_MARKER,
      base64: BASE64_MARKER,
      text: 'hello',
      kind: NAME_MARKER,
      deviceId: 'someone-else',
      size: Number.NaN,
      list: [1],
      nested: { a: 1 },
      flag: true,
      good: 3,
      pdf: 'pdf',
    }
    // @ts-expect-error a detail value is a number or a kind of file
    auditRemote(record, 'remote.attachments.put', 'denied', 'dev1', { detail: hostile })
    expect(entries[1].detail).toEqual({ deviceId: 'dev1', good: 3, pdf: 'pdf' })
    const text = JSON.stringify(entries)
    for (const marker of [NAME_MARKER, ID_MARKER, BASE64_MARKER, 'hello', 'someone-else']) expect(text).not.toContain(marker)
    expect(entries[1]).toMatchObject({ outcome: 'denied', throttle: true })

    // no detail, no device: as before
    auditRemote(record, 'remote.attachments.remove', 'ok')
    expect(entries[2]).toEqual({ action: 'remote.attachments.remove', actor: 'remote', outcome: 'ok' })
    // a sink that throws never breaks the operation (026 AC-7.4)
    expect(() =>
      auditRemote(
        () => {
          throw new Error('disk full')
        },
        'remote.attachments.put',
        'ok',
        'dev1',
        { detail: { size: 1 } },
      ),
    ).not.toThrow()
  })
})

const MARKER_TEXT = 'MARKER-MESSAGE-TEXT-0004'

describe('the audit of uploads and sends (spec 031 T37)', () => {
  const file = (name = 'a.txt', text = 'hola') => ({ name, size: Buffer.byteLength(text), base64: Buffer.from(text).toString('base64') })
  async function served(remote: Partial<RemoteSettings> = {}, overrides: { record?: (entry: AuditEvent) => void } = {}): Promise<Harness> {
    const base = defaultRemote()
    const t = await testChannel({ remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true, sendFiles: true, ...remote }, ...overrides })
    await t.channel.sync()
    t.chat.threads.push(makeThread('t1'))
    return t
  }
  const idOf = (response: { body?: unknown }) => (response.body as { attachment: { id: string } }).attachment.id
  const entries = (t: Harness, action: string) => t.records.filter((entry) => entry.action === action)

  it('AC-7.1 (031) one remote.attachments.put entry per put, with kind and size when stored', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    await t.call('/api/chat/attach', file('a.txt', 'hola'))
    await t.call('/api/threads/attach', { id: 't1', ...file('foto.png', 'png!') })
    expect(entries(t, 'remote.attachments.put')).toEqual([
      { action: 'remote.attachments.put', actor: 'remote', outcome: 'ok', detail: { deviceId, kind: 'text', size: 4 } },
      { action: 'remote.attachments.put', actor: 'remote', outcome: 'ok', detail: { deviceId, kind: 'image', size: 4 } }
    ])
  })

  it('AC-7.1 (031) a refused put is denied and throttled with no kind and no size; a storage failure is an error', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    t.files.refuse = 'file-type'
    expect((await t.call('/api/chat/attach', file())).status).toBe(415)
    t.files.refuse = 'storage'
    expect((await t.call('/api/chat/attach', file())).status).toBe(500)
    t.files.refuse = null
    t.threads.running.add('t1')
    expect((await t.call('/api/threads/attach', { id: 't1', ...file() })).status).toBe(409)
    expect(entries(t, 'remote.attachments.put')).toEqual([
      { action: 'remote.attachments.put', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true },
      { action: 'remote.attachments.put', actor: 'remote', outcome: 'error', detail: { deviceId } },
      { action: 'remote.attachments.put', actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true }
    ])
  })

  it('AC-7.1 (031) a remove is audited as a change, without the id', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    const id = idOf(await t.call('/api/chat/attach', file()))
    await t.call('/api/attachments/remove', { id })
    await t.call('/api/attachments/remove', { id: 'MARKER-NOT-MINE' })
    expect(entries(t, 'remote.attachments.remove')).toEqual([
      { action: 'remote.attachments.remove', actor: 'remote', outcome: 'ok', detail: { deviceId } },
      { action: 'remote.attachments.remove', actor: 'remote', outcome: 'ok', detail: { deviceId } }
    ])
  })

  it('AC-7.1 (031) a send that carries attachments adds the count to its detail; a text-only send does not', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    const shared = [idOf(await t.call('/api/chat/attach', file('a.txt'))), idOf(await t.call('/api/chat/attach', file('b.txt')))]
    const byId = idOf(await t.call('/api/threads/attach', { id: 't1', ...file('c.txt') }))
    expect((await t.call('/api/chat/send', { text: 'hola', attachments: shared })).status).toBe(200)
    expect((await t.call('/api/threads/send', { id: 't1', text: 'hola', attachments: [byId] })).status).toBe(409)
    t.chat.resolveAsk(0, 'ok')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await t.call('/api/threads/send', { id: 't1', text: 'hola', attachments: [byId] })).status).toBe(200)
    expect(entries(t, 'remote.chat.send')).toEqual([{ action: 'remote.chat.send', actor: 'remote', outcome: 'ok', detail: { deviceId, attachments: 2 } }])
    expect(entries(t, 'remote.threads.send').at(-1)).toEqual({ action: 'remote.threads.send', actor: 'remote', target: 't1', outcome: 'ok', detail: { deviceId, attachments: 1 } })
    t.chat.resolveAsk(1, 'ok')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await t.call('/api/chat/send', { text: 'solo texto' })
    expect(entries(t, 'remote.chat.send').at(-1)).toEqual({ action: 'remote.chat.send', actor: 'remote', outcome: 'ok', detail: { deviceId } })
  })

  it('AC-7.2 (031) markers in the name, the text, the base64 and the id never reach any entry or console line', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    try {
      const t = await served()
      const content = BASE64_MARKER
      const stored = await t.call('/api/chat/attach', { name: NAME_MARKER, size: Buffer.byteLength(content), base64: Buffer.from(content).toString('base64') })
      const id = idOf(stored)
      await t.call('/api/threads/attach', { id: 't1', name: NAME_MARKER, size: 2, base64: Buffer.from('hi').toString('base64') })
      t.files.refuse = 'secret-name'
      await t.call('/api/chat/attach', { name: NAME_MARKER, size: 2, base64: Buffer.from('hi').toString('base64') })
      t.files.refuse = null
      await t.call('/api/attachments/remove', { id: ID_MARKER })
      await t.call('/api/chat/send', { text: MARKER_TEXT, attachments: [ID_MARKER] })
      await t.call('/api/threads/send', { id: 't1', text: MARKER_TEXT, attachments: [ID_MARKER] })
      await t.call('/api/chat/send', { text: MARKER_TEXT, attachments: [id] })
      const everything = JSON.stringify(t.records) + logs.map((spy) => JSON.stringify(spy.mock.calls)).join('')
      for (const marker of [NAME_MARKER, MARKER_TEXT, ID_MARKER, BASE64_MARKER, Buffer.from(content).toString('base64'), id]) expect(everything, marker).not.toContain(marker)
      expect(t.records.length).toBeGreaterThan(5)
    } finally {
      for (const spy of logs) spy.mockRestore()
    }
  })

  it('AC-7.3 (031) a scope, sub-switch or authentication refusal on a new route is denied and throttled, without names', async () => {
    const t = await served({ sendFiles: false })
    const { deviceId } = await t.phone()
    expect(await t.call('/api/chat/attach', file(NAME_MARKER))).toEqual(refusalResponse('attach-off'))
    expect(await t.call('/api/threads/attach', { id: 't1', ...file(NAME_MARKER) })).toEqual(refusalResponse('attach-off'))
    expect(await t.call('/api/attachments/remove', { id: ID_MARKER })).toEqual(refusalResponse('attach-off'))
    expect(await t.call('/api/chat/send', { text: 'x', attachments: [ID_MARKER] })).toEqual(refusalResponse('attach-off'))
    // a text-only send is not affected and writes no denial
    expect((await t.call('/api/chat/send', { text: 'solo texto' })).status).toBe(200)
    t.setRemote({ sendFiles: true, scopes: { ...defaultRemote().scopes, chat: false, history: true } })
    expect(await t.call('/api/chat/attach', file())).toEqual(refusalResponse('scope-off'))
    t.setRemote({ continueHistory: false, scopes: { ...defaultRemote().scopes, chat: true, history: true } })
    expect(await t.call('/api/threads/attach', { id: 't1', ...file() })).toEqual(refusalResponse('write-off'))
    const denied = t.records.filter((entry) => entry.outcome === 'denied')
    expect(denied.map((entry) => entry.action)).toEqual([
      'remote.attachments.put',
      'remote.attachments.put',
      'remote.attachments.remove',
      'remote.chat.send',
      'remote.attachments.put',
      'remote.attachments.put'
    ])
    for (const entry of denied) expect(entry).toEqual({ action: entry.action, actor: 'remote', outcome: 'denied', detail: { deviceId }, throttle: true })
    // an unknown device is refused first and the entry names no device
    const stranger = await t.transport.request({ method: 'POST', path: '/api/chat/attach', headers: HOST, body: file() })
    expect(stranger.status).toBe(401)
    expect(t.records.at(-1)).toEqual({ action: 'remote.attachments.put', actor: 'remote', outcome: 'denied', throttle: true })
    expect(JSON.stringify(t.records)).not.toContain(NAME_MARKER)
  })

  it('AC-7.3 (031) a trail that throws does not interrupt the operation', async () => {
    const t = await served(
      {},
      {
        record: () => {
          throw new Error('disk full')
        }
      }
    )
    const put = await t.call('/api/chat/attach', file())
    expect(put.status).toBe(200)
    expect((await t.call('/api/chat/send', { text: 'x', attachments: [idOf(put)] })).status).toBe(200)
    expect((await t.call('/api/attachments/remove', { id: 'nope' })).status).toBe(200)
  })
})

describe('no-store and the service worker (spec 031 T38)', () => {
  const file = (name = 'a.txt', text = 'hola') => ({ name, size: Buffer.byteLength(text), base64: Buffer.from(text).toString('base64') })
  const idOf = (response: { body?: unknown }) => (response.body as { attachment: { id: string } }).attachment.id

  it('AC-7.4 (031) every new response, refusals included, carries cache-control no-store', async () => {
    const base = defaultRemote()
    const t = await testChannel({ remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true, sendFiles: true } })
    await t.channel.sync()
    t.chat.threads.push(makeThread('t1'), makeThread('co', 'ceo'))
    const answers: [string, Awaited<ReturnType<Harness['call']>>][] = []
    const call = async (label: string, path: string, body: unknown) => answers.push([label, await t.call(path, body)])
    await call('stored put', '/api/chat/attach', file())
    await call('stored put by id', '/api/threads/attach', { id: 't1', ...file() })
    await call('malformed body', '/api/chat/attach', { name: 'a.txt' })
    await call('gone', '/api/threads/attach', { id: 'co', ...file() })
    t.files.refuse = 'file-type'
    await call('file refusal', '/api/chat/attach', file())
    t.files.refuse = 'storage'
    await call('storage', '/api/chat/attach', file())
    t.files.refuse = null
    await call('remove', '/api/attachments/remove', { id: 'att-1' })
    await call('remove, not mine', '/api/attachments/remove', { id: 'nope' })
    await call('unavailable', '/api/chat/send', { text: 'x', attachments: ['nope'] })
    await call('send', '/api/chat/send', { text: 'x', attachments: [idOf(answers[1]?.[1] ?? { body: undefined })] })
    await call('invalid send', '/api/chat/send', { text: '' })
    t.setRemote({ sendFiles: false })
    await call('attach-off', '/api/chat/attach', file())
    await call('attach-off send', '/api/threads/send', { id: 't1', text: 'x', attachments: ['nope'] })
    t.setRemote({ sendFiles: true, scopes: { ...base.scopes, chat: false, history: true } })
    await call('scope-off', '/api/chat/attach', file())
    const stranger = await t.transport.request({ method: 'POST', path: '/api/chat/attach', headers: HOST, body: file() })
    answers.push(['unknown device', stranger])
    expect(answers.length).toBeGreaterThan(12)
    for (const [label, response] of answers) expect(response.headers?.['cache-control'], label).toBe('no-store')
  })

  it('AC-7.4 (031) the service worker never caches /api, the new paths included', async () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'public', 'sw.js'), 'utf8')
    const puts: string[] = []
    const listeners: Record<string, (event: never) => void> = {}
    const cache = { addAll: async () => undefined, put: async (request: { url: string }) => void puts.push(request.url) }
    const caches = { open: async () => cache, match: async () => null, keys: async () => [], delete: async () => true }
    const self = { addEventListener: (type: string, fn: (event: never) => void) => void (listeners[type] = fn), skipWaiting: () => undefined, clients: { claim: async () => undefined } }
    new Function('self', 'caches', 'fetch', 'navigator', source)(self, caches, async () => ({ ok: true, clone: () => ({}) }), { language: 'en-US' })
    for (const path of ['/api/chat/attach', '/api/threads/attach', '/api/attachments/remove', '/api/chat/send', '/api/threads/send', '/api/threads/read']) {
      for (const method of ['GET', 'POST']) {
        let answered = false
        await listeners['fetch']?.({ request: { url: `https://pc.ts.net${path}`, method }, respondWith: () => void (answered = true), waitUntil: () => undefined } as never)
        expect(answered, `${method} ${path}`).toBe(false)
      }
    }
    expect(puts).toEqual([])
  })
})
