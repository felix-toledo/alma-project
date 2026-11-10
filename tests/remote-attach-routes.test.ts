import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { claimUploads, PENDING_ID_MAX, PHONE_ATTACH, type PhoneAttachmentView } from '../src/shared/attach/phone'
import { refusalResponse } from '../src/coordinator/channels/remote/transport'
import { ROUTES, REMOTE_LIMITS, type Refusal, type RouteSpec } from '../src/shared/remote/api'
import { authorizeRemote } from '../src/shared/remote/authorize'
import { defaultRemote, sanitizeRemote } from '../src/shared/remote/settings'
import { statusView } from '../src/shared/remote/status'
import type { ThreadWindow } from '../src/shared/remote/wire'
import type { RemoteSettings } from '../src/shared/types'
import { HOST, testChannel } from './support/remote-harness'

const routeOf = (path: string): RouteSpec => {
  const found = ROUTES.find((r) => r.path === path)
  if (!found) throw new Error(`no route ${path}`)
  return found
}
const bodyOf = (path: string) => {
  const body = routeOf(path).body
  if (!body) throw new Error(`no body schema for ${path}`)
  return body
}
const bytes64 = (n: number) => Buffer.alloc(n, 7).toString('base64')
const put = (n: number, name = 'a.txt') => ({ name, size: n, base64: bytes64(n) })

describe('the routes of spec 031: contracts', () => {
  it('AC-9.1 (031) the route table snapshot', () => {
    const snapshot = ROUTES.filter((r) => r.files !== undefined).map((r) => [r.method, r.path, r.auth, r.scope, r.continue ?? false, r.files, r.audit])
    expect(snapshot).toEqual([
      ['POST', '/api/chat/send', 'session', 'chat', false, 'with-ids', 'change'],
      ['POST', '/api/threads/send', 'session', 'history', true, 'with-ids', 'open'],
      ['POST', '/api/chat/attach', 'session', 'chat', false, 'always', 'upload'],
      ['POST', '/api/threads/attach', 'session', 'history', true, 'always', 'upload'],
      ['POST', '/api/attachments/remove', 'session', ['chat', 'history'], false, 'always', 'change']
    ])
    // a route with the Files flag always has a body schema, so a new one cannot skip the boundary
    for (const route of ROUTES.filter((r) => r.files !== undefined)) expect(route.body, route.path).toBeDefined()
    // everything else keeps no flag: the new gate cannot reach a route by accident
    expect(ROUTES.filter((r) => r.files === undefined && /attach/i.test(r.path))).toEqual([])
  })

  it('AC-2.3 (031) the put schemas accept exactly the strict shapes', () => {
    const shared = bodyOf('/api/chat/attach')
    const byId = bodyOf('/api/threads/attach')
    const longest = 'n'.repeat(512)
    expect(shared.safeParse(put(1)).success).toBe(true)
    expect(shared.safeParse(put(PHONE_ATTACH.maxFileBytes, longest)).success).toBe(true)
    expect(byId.safeParse({ id: 't1', ...put(5) }).success).toBe(true)
    for (const [label, body] of Object.entries({
      'extra key': { ...put(3), extra: 1 },
      'missing name': { size: 3, base64: bytes64(3) },
      'missing size': { name: 'a.txt', base64: bytes64(3) },
      'missing base64': { name: 'a.txt', size: 3 },
      'size not an integer': { ...put(3), size: 3.5 },
      'size a string': { ...put(3), size: '3' },
      'negative size': { name: 'a.txt', size: -3, base64: bytes64(3) },
      'empty name': put(3, ''),
      'name over 512': put(3, 'n'.repeat(513)),
      'whitespace in the base64': { name: 'a.txt', size: 3, base64: 'AAAA ' },
      'newline in the base64': { name: 'a.txt', size: 6, base64: 'AAAA\nAAAA' },
      'bad padding': { name: 'a.txt', size: 3, base64: 'AAA' },
      'not the alphabet': { name: 'a.txt', size: 3, base64: 'AA*A' },
      'size differs from the decoded length': { name: 'a.txt', size: 4, base64: bytes64(3) }
    })) {
      expect(shared.safeParse(body).success, label).toBe(false)
      expect(byId.safeParse({ id: 't1', ...body }).success, label).toBe(false)
    }
    // the conversation id is required, bounded and the only extra key
    expect(byId.safeParse(put(3)).success).toBe(false)
    expect(byId.safeParse({ id: '', ...put(3) }).success).toBe(false)
    expect(byId.safeParse({ id: 'x'.repeat(65), ...put(3) }).success).toBe(false)
    // the shared-thread put names no conversation (a thread key is refused, never ignored)
    expect(shared.safeParse({ id: 't1', ...put(3) }).success).toBe(false)
    const remove = bodyOf('/api/attachments/remove')
    expect(remove.safeParse({ id: 'abc' }).success).toBe(true)
    expect(remove.safeParse({ id: 'x'.repeat(65) }).success).toBe(false)
    expect(remove.safeParse({ id: 'abc', extra: 1 }).success).toBe(false)
    expect(remove.safeParse({}).success).toBe(false)
    expect(remove.safeParse({ id: 7 }).success).toBe(false)
  })

  it('AC-2.3 (031) a 700 001-byte body still reaches the handler to be refused as too large', () => {
    const body = bodyOf('/api/chat/attach')
    expect(body.safeParse(put(PHONE_ATTACH.maxFileBytes + 1)).success).toBe(true)
  })

  it('AC-2.3 (031) a file clearly over the limit but under the request cap reaches the handler to be refused as too large', () => {
    const body = bodyOf('/api/chat/attach')
    const byId = bodyOf('/api/threads/attach')
    // 750 000 bytes is 1 000 000 base64 characters: over 933 336, under the 1 MB request cap
    expect(body.safeParse(put(750_000)).success).toBe(true)
    expect(byId.safeParse({ id: 't1', ...put(750_000) }).success).toBe(true)
    // a claimed size that differs from the decoded count is still invalid at the boundary
    expect(body.safeParse({ ...put(750_000), size: 750_001 }).success).toBe(false)
  })

  it('AC-4.2 (031) the id bound of the send and remove schemas is the one the claim uses', () => {
    const at = (length: number) => 'x'.repeat(length)
    const chat = bodyOf('/api/chat/send')
    const thread = bodyOf('/api/threads/send')
    const remove = bodyOf('/api/attachments/remove')
    for (const [length, ok] of [[PENDING_ID_MAX, true], [PENDING_ID_MAX + 1, false]] as const) {
      expect(chat.safeParse({ text: 'hi', attachments: [at(length)] }).success, `chat ${length}`).toBe(ok)
      expect(thread.safeParse({ id: 't1', text: 'hi', attachments: [at(length)] }).success, `thread ${length}`).toBe(ok)
      expect(remove.safeParse({ id: at(length) }).success, `remove ${length}`).toBe(ok)
      expect(claimUploads([], { deviceId: 'd', threadId: 't', ids: [at(length)] }, 0)).toEqual({ ok: false })
    }
  })

  it('AC-4.4 (031) chat/new and chat/stop still refuse any key', () => {
    for (const path of ['/api/chat/new', '/api/chat/stop']) {
      const body = bodyOf(path)
      expect(body.safeParse(undefined).success, path).toBe(true)
      expect(body.safeParse({}).success, path).toBe(true)
      for (const key of ['attachments', 'thread', 'id', 'files']) expect(body.safeParse({ [key]: [] }).success, `${path} ${key}`).toBe(false)
    }
  })

  it('AC-4.1 (031) a send body takes an optional id list and a blank text only with at least one id', () => {
    const chat = bodyOf('/api/chat/send')
    const thread = bodyOf('/api/threads/send')
    const both = (extra: Record<string, unknown>) => [chat.safeParse(extra).success, thread.safeParse({ id: 't1', ...extra }).success]
    expect(both({ text: 'hi' })).toEqual([true, true])
    expect(both({ text: 'hi', attachments: ['a'] })).toEqual([true, true])
    expect(both({ text: '', attachments: ['a'] })).toEqual([true, true])
    expect(both({ text: '   \n', attachments: ['a', 'b', 'c', 'd', 'e'] })).toEqual([true, true])
    expect(both({ text: '' })).toEqual([false, false])
    expect(both({ text: '  ', attachments: [] })).toEqual([false, false])
    expect(both({ text: 'hi', attachments: [] })).toEqual([true, true])
    expect(both({ text: 'x'.repeat(REMOTE_LIMITS.chatChars) })).toEqual([true, true])
    expect(both({ text: 'x'.repeat(REMOTE_LIMITS.chatChars + 1) })).toEqual([false, false])
    expect(both({ text: 'x'.repeat(REMOTE_LIMITS.chatChars + 1), attachments: ['a'] })).toEqual([false, false])
    expect(both({ text: 'hi', extra: 1 })).toEqual([false, false])
    expect(both({ text: 'hi', attachments: 'a' })).toEqual([false, false])
    expect(both({ text: 'hi', attachments: [1] })).toEqual([false, false])
    expect(both({ attachments: ['a'] })).toEqual([false, false])
  })

  it('AC-4.2 (031) the id list is bounded per id at 64 characters, not by its length or the business cap (G4)', () => {
    const chat = bodyOf('/api/chat/send')
    // 6 ids, a duplicate or an empty id pass the boundary: the claim answers unavailable for them (AC-4.2)
    expect(chat.safeParse({ text: 'hi', attachments: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(true)
    expect(chat.safeParse({ text: 'hi', attachments: ['a', 'a'] }).success).toBe(true)
    expect(chat.safeParse({ text: 'hi', attachments: [''] }).success).toBe(true)
    expect(chat.safeParse({ text: 'hi', attachments: ['x'.repeat(64)] }).success).toBe(true)
    expect(chat.safeParse({ text: 'hi', attachments: Array.from({ length: 64 }, (_, i) => `i${i}`) }).success).toBe(true)
    expect(chat.safeParse({ text: 'hi', attachments: ['x'.repeat(65)] }).success).toBe(false)
    // a list longer than 64 is the claim's to refuse as unavailable, like any other bad list (the 1 MB cap bounds it)
    expect(chat.safeParse({ text: 'hi', attachments: Array.from({ length: 65 }, (_, i) => `i${i}`) }).success).toBe(true)
  })
})

describe('the refusals of spec 031 (T15)', () => {
  const STATUS = {
    'attach-off': 403,
    'notice-needed': 403,
    'too-many': 409,
    'secret-name': 422,
    'file-type': 415,
    'file-content': 422,
    'file-empty': 422,
    'file-malformed': 422,
    storage: 500
  } as const satisfies Partial<Record<Refusal, number>>

  it('AC-9.1 (031) every new refusal has a status and a byte-identical body', () => {
    for (const [reason, status] of Object.entries(STATUS) as [Refusal, number][]) {
      const response = refusalResponse(reason)
      expect(response.status, reason).toBe(status)
      expect(response.headers, reason).toEqual({ 'cache-control': 'no-store' })
      expect(JSON.stringify(response.body), reason).toBe(JSON.stringify({ error: reason }))
      expect(JSON.stringify(refusalResponse(reason)), reason).toBe(JSON.stringify(response))
    }
  })
})

describe('the Files gate of spec 031 (T13)', () => {
  const device = { deviceId: 'd1' }
  const remote = (scopes: Partial<RemoteSettings['scopes']>, extra: Partial<RemoteSettings> = {}): RemoteSettings => ({
    ...defaultRemote(),
    scopes: { ...defaultRemote().scopes, ...scopes },
    ...extra
  })
  const allOn = remote({ chat: true, history: true }, { continueHistory: true, sendFiles: true })
  const verdict = (path: string, settings: RemoteSettings, carriesFiles?: boolean) => authorizeRemote({ device, remote: settings, route: routeOf(path), carriesFiles })

  it('AC-1.7 (031) put gate: Chat for the shared thread; History, continue and Files for a conversation', () => {
    expect(verdict('/api/chat/attach', allOn)).toEqual({ ok: true })
    expect(verdict('/api/chat/attach', { ...allOn, scopes: { ...allOn.scopes, chat: false } })).toEqual({ ok: false, reason: 'scope-off' })
    expect(verdict('/api/chat/attach', { ...allOn, sendFiles: false })).toEqual({ ok: false, reason: 'attach-off' })
    // the shared thread needs neither History nor the continue sub-switch
    expect(verdict('/api/chat/attach', remote({ chat: true }, { sendFiles: true }))).toEqual({ ok: true })

    expect(verdict('/api/threads/attach', allOn)).toEqual({ ok: true })
    expect(verdict('/api/threads/attach', { ...allOn, scopes: { ...allOn.scopes, history: false } })).toEqual({ ok: false, reason: 'scope-off' })
    expect(verdict('/api/threads/attach', { ...allOn, continueHistory: false })).toEqual({ ok: false, reason: 'write-off' })
    expect(verdict('/api/threads/attach', { ...allOn, sendFiles: false })).toEqual({ ok: false, reason: 'attach-off' })
    // Chat is not what a conversation needs
    expect(verdict('/api/threads/attach', { ...allOn, scopes: { ...allOn.scopes, chat: false } })).toEqual({ ok: true })

    // the order is scope, continue, files: each switch off in turn names its own refusal
    const none = remote({}, { continueHistory: false, sendFiles: false })
    expect(verdict('/api/threads/attach', none)).toEqual({ ok: false, reason: 'scope-off' })
    expect(verdict('/api/threads/attach', remote({ history: true }, { sendFiles: false }))).toEqual({ ok: false, reason: 'write-off' })
    expect(verdict('/api/threads/attach', remote({ history: true }, { continueHistory: true, sendFiles: false }))).toEqual({ ok: false, reason: 'attach-off' })
  })

  it('AC-1.6 (031) sendFiles off refuses a send that carries ids and lets a text-only send through', () => {
    const off = { ...allOn, sendFiles: false }
    for (const path of ['/api/chat/send', '/api/threads/send']) {
      expect(verdict(path, off, true), path).toEqual({ ok: false, reason: 'attach-off' })
      expect(verdict(path, off, false), path).toEqual({ ok: true })
      expect(verdict(path, off), path).toEqual({ ok: true })
      expect(verdict(path, allOn, true), path).toEqual({ ok: true })
    }
    // a send's other switches keep their refusal ahead of the Files one
    expect(verdict('/api/threads/send', { ...off, continueHistory: false }, true)).toEqual({ ok: false, reason: 'write-off' })
    // a route with no Files flag never answers attach-off, whatever the body claims
    expect(verdict('/api/chat/new', off, true)).toEqual({ ok: true })
    expect(verdict('/api/threads/read', off, true)).toEqual({ ok: true })
    // removal needs Chat or History, and Files (G5, pinned in its own test below)
    expect(verdict('/api/attachments/remove', off)).toEqual({ ok: false, reason: 'attach-off' })
    expect(verdict('/api/attachments/remove', remote({ history: true }, { sendFiles: true }))).toEqual({ ok: true })
    expect(verdict('/api/attachments/remove', remote({}, { sendFiles: true }))).toEqual({ ok: false, reason: 'scope-off' })
  })

  it('AC-3.2 (031) the remove route needs the Send files sub-switch and, through it, Chat (G5 resolved on the owner delegation)', () => {
    const route = routeOf('/api/attachments/remove')
    // the same gate as a put: the Files flag is always on, and the scope list is the one of the two put routes together
    expect(route.files).toBe('always')
    expect(route.scope).toEqual(['chat', 'history'])
    // Files off: refused whatever else is on, so a removal never answers 200 while the sub-switch is off
    expect(verdict('/api/attachments/remove', { ...allOn, sendFiles: false })).toEqual({ ok: false, reason: 'attach-off' })
    expect(verdict('/api/attachments/remove', remote({}, { sendFiles: true }))).toEqual({ ok: false, reason: 'scope-off' })
    // a settings document cannot hold Files on without Chat (AC-1.3), so with Chat off the sub-switch reads off and the removal is refused
    const chatOff = sanitizeRemote({ ...allOn, scopes: { ...allOn.scopes, chat: false }, sendFiles: true })
    expect(chatOff.sendFiles).toBe(false)
    expect(verdict('/api/attachments/remove', chatOff)).toEqual({ ok: false, reason: 'attach-off' })
    // Chat on with Files on: allowed, with or without History
    expect(verdict('/api/attachments/remove', remote({ chat: true }, { sendFiles: true }))).toEqual({ ok: true })
    expect(verdict('/api/attachments/remove', allOn)).toEqual({ ok: true })
  })

  it('AC-9.2 (031) authorizeRemote takes no transport input and gives the same verdict for the same inputs', () => {
    expect(authorizeRemote.length).toBe(1)
    for (const path of ['/api/chat/attach', '/api/threads/attach', '/api/attachments/remove']) {
      const input = { device, remote: { ...allOn, sendFiles: false }, route: routeOf(path), carriesFiles: true }
      expect(authorizeRemote(input)).toEqual(authorizeRemote({ ...input }))
    }
    const source = readFileSync(join(__dirname, '../src/shared/remote/authorize.ts'), 'utf8')
    // only types come in: no transport, no I/O
    expect(source.match(/^import .*$/gm)?.every((line) => line.startsWith('import type'))).toBe(true)
  })

  it('AC-1.8 (031) an unknown device is refused first on the new routes', () => {
    const nothing = remote({}, { sendFiles: false })
    for (const path of ['/api/chat/attach', '/api/threads/attach', '/api/attachments/remove', '/api/chat/send', '/api/threads/send']) {
      for (const settings of [nothing, allOn]) {
        expect(authorizeRemote({ device: null, remote: settings, route: routeOf(path), carriesFiles: true }), path).toEqual({ ok: false, reason: 'unknown-device' })
      }
    }
  })
})

describe('the status and the thread wire of spec 031 (T14)', () => {
  it('AC-1.9 (031) status returns sendFiles (only while Chat is on) and no other new key', () => {
    const base: RemoteSettings = { ...defaultRemote(), enabled: true, sensitive: true, continueHistory: true, sendFiles: true, cameras: ['camera.secret'], agentId: 'secret-agent' }
    const chatOn = statusView({ ...base, scopes: { ...base.scopes, chat: true } })
    expect(chatOn.sendFiles).toBe(true)
    expect(Object.keys(chatOn).sort()).toEqual(['continue', 'scopes', 'sendFiles', 'sensitive'])
    // the switch cannot outlive Chat: a stale true with Chat off reads off
    expect(statusView({ ...base, sendFiles: true }).sendFiles).toBe(false)
    expect(statusView({ ...base, scopes: { ...base.scopes, chat: true }, sendFiles: false }).sendFiles).toBe(false)
    expect(statusView(defaultRemote()).sendFiles).toBe(false)
    expect(JSON.stringify(chatOn)).not.toMatch(/secret/)
  })

  it('AC-5.1 (031) a thread window message may carry the phone attachment view and nothing else of an attachment', () => {
    type Message = ThreadWindow['messages'][number]
    expectTypeOf<Message['attachments']>().toEqualTypeOf<PhoneAttachmentView[] | undefined>()
    const plain: Message = { index: 0, role: 'user', text: 'hi', at: 1 }
    const withFiles: Message = { ...plain, attachments: [{ name: 'a.png', kind: 'image', size: 3 }] }
    expect(Object.keys(withFiles.attachments?.[0] ?? {}).sort()).toEqual(['kind', 'name', 'size'])
  })
})

describe('the empty file (spec 031 T16, G3: the PC decides)', () => {
  it('AC-2.3 (031) the boundary schemas take size 0 and an empty base64, so the PC names the reason (AC-2.2)', () => {
    const shared = bodyOf('/api/chat/attach')
    const byId = bodyOf('/api/threads/attach')
    expect(shared.safeParse({ name: 'a.txt', size: 0, base64: '' }).success).toBe(true)
    expect(byId.safeParse({ id: 't1', name: 'a.txt', size: 0, base64: '' }).success).toBe(true)
    // the size and the bytes still have to agree
    expect(shared.safeParse({ name: 'a.txt', size: 0, base64: 'AAAA' }).success).toBe(false)
    expect(shared.safeParse({ name: 'a.txt', size: 1, base64: '' }).success).toBe(false)
    expect(shared.safeParse({ name: 'a.txt', size: -0.5, base64: '' }).success).toBe(false)
  })
})

describe('the pipeline carries the new routes (spec 031 T28)', () => {
  async function served(remote: Partial<RemoteSettings> = {}) {
    const base = defaultRemote()
    const t = await testChannel({
      remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true, sendFiles: true, ...remote }
    })
    await t.channel.sync()
    return t
  }
  const valid = put(4, 'nota.txt')

  it('AC-1.6 (031) with sendFiles off a put is attach-off and nothing is read or stored', async () => {
    const t = await served({ sendFiles: false })
    expect(await t.call('/api/chat/attach', valid)).toEqual(refusalResponse('attach-off'))
    expect(await t.call('/api/threads/attach', { id: 'remote', ...valid })).toEqual(refusalResponse('attach-off'))
    expect(await t.call('/api/attachments/remove', { id: 'att-1' })).toEqual(refusalResponse('attach-off'))
    expect(t.files.puts).toEqual([])
    expect(t.files.removes).toEqual([])
    // a send that carries ids is refused the same way, before anything runs; a text-only send is unaffected
    expect(await t.call('/api/chat/send', { text: 'hola', attachments: ['att-1'] })).toEqual(refusalResponse('attach-off'))
    expect(await t.call('/api/threads/send', { id: 't1', text: 'hola', attachments: ['att-1'] })).toEqual(refusalResponse('attach-off'))
    expect(t.chat.askCalls).toEqual([])
    expect((await t.call('/api/chat/send', { text: 'hola' })).status).toBe(200)
    expect(t.chat.askCalls).toHaveLength(1)
  })

  it('AC-1.7 (031) a put that passes the gate is stored and answers its id, name, kind and size', async () => {
    const t = await served()
    const shared = await t.call('/api/chat/attach', valid)
    expect(shared.status).toBe(200)
    expect(shared.body).toEqual({ ok: true, attachment: { id: 'att-1', name: 'nota.txt', kind: 'text', size: 4 } })
    expect(t.files.puts.map((p) => p.threadId)).toEqual(['remote'])
    expect((await t.call('/api/threads/attach', { id: 'nope', ...valid })).body).toEqual({ error: 'gone' })
    expect(await t.call('/api/attachments/remove', { id: 'att-1' })).toMatchObject({ status: 200, body: { ok: true } })
    expect(t.files.removes).toEqual(['att-1'])
  })

  it('AC-1.8 (031) the same refusal for an unknown device, a junk token and an idle-expired device', async () => {
    const t = await served()
    const { headers } = await t.phone()
    const answers = new Set<string>()
    const ask = async (given: Record<string, string>, path: string, body: unknown) => {
      const response = await t.transport.request({ method: 'POST', path, headers: given, body })
      expect(response.status, path).toBe(401)
      answers.add(JSON.stringify(response.body))
    }
    const bodies: [string, unknown][] = [['/api/chat/attach', valid], ['/api/threads/attach', { id: 'remote', ...valid }], ['/api/attachments/remove', { id: 'att-1' }]]
    for (const [path, body] of bodies) {
      await ask(HOST, path, body)
      await ask({ ...HOST, authorization: 'Bearer junk' }, path, body)
    }
    // idle for more than 15 days
    t.setNow(16 * 24 * 3_600_000)
    for (const [path, body] of bodies) await ask(headers, path, body)
    expect([...answers]).toEqual([JSON.stringify({ error: 'unknown-device' })])
    expect(t.files.puts).toEqual([])
  })

  it('AC-1.8 (031) a revoked device gets the same refusal', async () => {
    const t = await served()
    const { deviceId, headers } = await t.phone()
    await t.channel.revokeDevice(deviceId)
    const response = await t.transport.request({ method: 'POST', path: '/api/chat/attach', headers, body: valid })
    expect(response).toMatchObject({ status: 401, body: { error: 'unknown-device' } })
    expect(t.files.puts).toEqual([])
  })

  it('AC-2.3 (031) malformed bodies are rejected before the handler', async () => {
    const t = await served()
    const bad: Record<string, unknown>[] = [
      { ...valid, extra: 1 },
      { name: 'a.txt', base64: bytes64(3) },
      { name: 'a.txt', size: 3, base64: 'AAAA ' },
      { name: 'a.txt', size: 4, base64: bytes64(3) },
      { name: '', size: 3, base64: bytes64(3) },
      { name: 'a.txt', size: 3, base64: 'x'.repeat(933_340) }
    ]
    for (const body of bad) expect(await t.call('/api/chat/attach', body), JSON.stringify(body).slice(0, 60)).toEqual(refusalResponse('invalid'))
    expect(await t.call('/api/threads/attach', valid)).toEqual(refusalResponse('invalid'))
    expect(await t.call('/api/attachments/remove', {})).toEqual(refusalResponse('invalid'))
    expect(t.files.puts).toEqual([])
    expect(t.files.removes).toEqual([])
  })

  it('AC-2.10 (031) the 61st request in a minute is rate-limited', async () => {
    const t = await served()
    for (let i = 0; i < 60; i++) expect((await t.call('/api/attachments/remove', { id: 'x' })).status, `request ${i}`).toBe(200)
    expect(await t.call('/api/chat/attach', valid)).toEqual(refusalResponse('rate-limited'))
    expect(t.files.puts).toEqual([])
  })

  it('AC-2.10 (031) a put the PC does not finish within 30 seconds answers failed', async () => {
    vi.useFakeTimers()
    try {
      const t = await served()
      const { headers } = await t.phone()
      // the session lookup never answers: the handler hangs
      vi.spyOn(t.store, 'touch').mockImplementation(() => new Promise(() => {}))
      let settled: unknown = null
      void t.transport.request({ method: 'POST', path: '/api/chat/attach', headers, body: valid }).then((response) => {
        settled = response
      })
      await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.timeoutMs - 1)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toMatchObject({ status: 500, body: { error: 'failed' } })
      expect(t.files.puts).toEqual([])
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('AC-2.2 (031) the answer names the reason', async () => {
    const t = await served()
    const reasons: Refusal[] = ['file-type', 'file-content', 'file-empty', 'file-malformed', 'secret-name', 'too-large', 'notice-needed', 'storage', 'invalid']
    for (const reason of reasons) {
      t.files.refuse = reason
      const response = await t.call('/api/chat/attach', valid)
      expect(response, reason).toEqual(refusalResponse(reason))
      expect(response.body).toEqual({ error: reason })
    }
    // nothing refused was kept pending: five puts still fit
    t.files.refuse = null
    for (let i = 0; i < 5; i++) expect((await t.call('/api/chat/attach', put(1, `f${i}.txt`))).status).toBe(200)
  })
})
