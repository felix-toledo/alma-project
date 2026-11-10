import { describe, expect, it } from 'vitest'
import { PHONE_ATTACH } from '../src/shared/attach/phone'
import { DEVICE_IDLE_MS } from '../src/coordinator/channels/remote/store'
import { errorOf, idOf, OPEN, putBody, bytesOf, rig, SHARED, type Rig } from './support/verify-031'

const CHAT = '/api/chat/attach'
const BY_ID = '/api/threads/attach'
const T1 = 't1'
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function ready(): Promise<Rig> {
  const t = await rig()
  t.addThread(T1)
  return t
}
const put = async (t: Rig, name = 'a.txt', target?: string): Promise<string> => {
  const response = await t.h.call(target ? BY_ID : CHAT, target ? { id: target, ...putBody(name, bytesOf(name)) } : putBody(name, bytesOf(name)))
  expect(response.status).toBe(200)
  return idOf(response)
}
const sendChat = (t: Rig, text: string, attachments?: unknown) => t.h.call('/api/chat/send', attachments === undefined ? { text } : { text, attachments })
const sendThread = (t: Rig, id: string, text: string, attachments?: unknown) => t.h.call('/api/threads/send', attachments === undefined ? { id, text } : { id, text, attachments })

describe('031 verify: pending uploads and cleanup (US-6)', () => {
  it('AC-3.1 (031 verify) the device removing a pending upload deletes its file and record at once, and its expiry timer', async () => {
    const t = await ready()
    const id = await put(t)
    expect(t.onDisk().folders).toEqual([id])
    expect(t.h.timers.active()).toBe(1)
    const answer = await t.h.call('/api/attachments/remove', { id })
    expect(answer.status).toBe(200)
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
    expect(t.h.timers.active()).toBe(0)
    expect(errorOf(await sendChat(t, '', [id]))).toBe('unavailable')
  })

  it('AC-3.1 (031 verify) a pending upload expires exactly 15 minutes after it was put: 14:59.999 is still pending, 15:00 is gone', async () => {
    const early = await ready()
    early.h.setNow(1_000)
    const id = await put(early)
    early.h.setNow(1_000 + PHONE_ATTACH.pendingTtlMs - 1)
    expect((await sendChat(early, '', [id])).status).toBe(200)
    expect(early.h.chat.askCalls.at(-1)?.attachments).toEqual([id])
    expect(early.onDisk().folders).toEqual([id])

    const late = await ready()
    late.h.setNow(1_000)
    const gone = await put(late)
    late.h.setNow(1_000 + PHONE_ATTACH.pendingTtlMs)
    expect(errorOf(await sendChat(late, '', [gone]))).toBe('unavailable')
    expect(late.h.chat.askCalls).toEqual([])
    // swept by the read itself, without the timer having fired
    expect(late.onDisk()).toEqual({ folders: [], records: [] })
  })

  it('AC-3.1 (031 verify) 900 000 ms is exactly 15 minutes', () => {
    expect(PHONE_ATTACH.pendingTtlMs).toBe(15 * 60 * 1000)
  })

  it('AC-3.1 (031 verify) the expiry timer deletes the file when it fires, and a put that arrives later sweeps without it', async () => {
    const t = await ready()
    t.h.setNow(5_000)
    await put(t, 'a.txt')
    await put(t, 'b.txt')
    t.h.setNow(5_000 + PHONE_ATTACH.pendingTtlMs - 1)
    t.h.timers.fireDue()
    expect(t.onDisk().folders).toHaveLength(2)
    t.h.setNow(5_000 + PHONE_ATTACH.pendingTtlMs)
    t.h.timers.fireDue()
    expect(t.onDisk()).toEqual({ folders: [], records: [] })

    const lazy = await ready()
    lazy.h.setNow(0)
    for (let i = 0; i < 5; i++) await put(lazy, `n${i}.txt`)
    lazy.h.setNow(PHONE_ATTACH.pendingTtlMs)
    // a sixth put would be too-many unless the five expired ones are swept first
    expect((await lazy.h.call(CHAT, putBody('new.txt', bytesOf('x')))).status).toBe(200)
    expect(lazy.onDisk().folders).toHaveLength(1)
  })

  it('AC-3.1 (031 verify) revoking a device deletes its pending uploads and leaves another device\'s alone', async () => {
    const t = await ready()
    const mine = await put(t)
    const other = await t.device('other')
    const theirs = idOf(await other.call(CHAT, putBody('o.txt', bytesOf('o'))))
    const me = (await t.h.phone()).deviceId
    await t.h.channel.revokeDevice(me)
    expect(t.onDisk().folders).toEqual([theirs])
    expect(t.removed).toContain(mine)
    expect((await other.call('/api/chat/send', { text: '', attachments: [theirs] })).status).toBe(200)
  })

  it('AC-3.1 (031 verify) the phone forgetting the PC deletes its pending uploads', async () => {
    const t = await ready()
    await put(t)
    await put(t, 'b.txt', T1)
    // the status is not asserted: over the relay the answer to a forget can be lost with the cut connection
    await t.h.call('/api/forget', {})
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
  })

  it('AC-3.1 (031 verify) a device idle past 15 days is swept with its pending uploads; the exact day is not idle', async () => {
    const t = await ready()
    t.h.setNow(1_000)
    const me = (await t.h.phone()).deviceId
    await t.h.store.touch(me)
    await put(t)
    const other = await t.device('other')
    const theirs = idOf(await other.call(CHAT, putBody('o.txt', bytesOf('o'))))
    const otherId = other.deviceId
    t.h.setNow(1_000 + DEVICE_IDLE_MS)
    await t.h.store.touch(otherId)
    await t.h.channel.sweepDevices()
    // exactly 15 days idle is not expired
    expect(t.onDisk().folders).toHaveLength(2)
    t.h.setNow(1_000 + DEVICE_IDLE_MS + 1)
    await t.h.channel.sweepDevices()
    expect(t.onDisk().folders).toEqual([theirs])
  })

  it('AC-3.1 (031 verify) remote access off deletes every device\'s pending uploads', async () => {
    const t = await ready()
    await put(t)
    const other = await t.device('other')
    await other.call(CHAT, putBody('o.txt', bytesOf('o')))
    t.h.setRemote({ enabled: false })
    await t.h.channel.sync()
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
    expect(t.h.timers.active()).toBe(0)
  })

  it('AC-3.1 (031 verify) the tray kill switch (stop) deletes pending uploads', async () => {
    const t = await ready()
    await put(t)
    await put(t, 'b.txt', T1)
    await t.h.channel.stop()
    expect(t.onDisk()).toEqual({ folders: [], records: [] })
  })

  it('AC-3.1 (031 verify) turning the sub-switch off, or Chat off, deletes them; turning either back on does not bring them back', async () => {
    const files = await ready()
    const a = await put(files)
    files.h.setRemote({ sendFiles: false })
    await files.h.channel.sync()
    expect(files.onDisk()).toEqual({ folders: [], records: [] })
    files.h.setRemote({ sendFiles: true })
    await files.h.channel.sync()
    expect(errorOf(await sendChat(files, '', [a]))).toBe('unavailable')

    const chat = await ready()
    const b = await put(chat)
    chat.h.setRemote({ scopes: { ...OPEN, chat: false } })
    await chat.h.channel.sync()
    expect(chat.onDisk()).toEqual({ folders: [], records: [] })
    chat.h.setRemote({ scopes: OPEN })
    await chat.h.channel.sync()
    expect(errorOf(await sendChat(chat, '', [b]))).toBe('unavailable')
  })

  it('AC-3.1 (031 verify) turning History or the continue sub-switch off keeps by-id uploads, because the spec does not list them', async () => {
    const t = await ready()
    const id = await put(t, 'a.txt', T1)
    t.h.setRemote({ scopes: { ...OPEN, history: false } })
    await t.h.channel.sync()
    t.h.setRemote({ scopes: OPEN, continueHistory: false })
    await t.h.channel.sync()
    expect(t.onDisk().folders).toEqual([id])
    t.h.setRemote({ continueHistory: true })
    await t.h.channel.sync()
    expect((await sendThread(t, T1, '', [id])).status).toBe(200)
  })

  it('AC-3.1 (031 verify) New conversation deletes the shared thread\'s uploads, not a conversation\'s', async () => {
    const t = await ready()
    const shared = await put(t)
    const byId = await put(t, 'b.txt', T1)
    expect((await t.h.call('/api/chat/new', {})).status).toBe(200)
    expect(t.onDisk().folders).toEqual([byId])
    expect(t.removed).toEqual([shared])
    expect(errorOf(await sendChat(t, '', [shared]))).toBe('unavailable')
    expect((await sendThread(t, T1, '', [byId])).status).toBe(200)
  })

  it('AC-3.1 (031 verify) an upload to the shared thread made through the by-id route is dropped by New conversation as well', async () => {
    const t = await ready()
    const id = await put(t, 'a.txt', SHARED)
    await t.h.call('/api/chat/new', {})
    expect(t.onDisk().folders).toEqual([])
    expect(errorOf(await sendChat(t, '', [id]))).toBe('unavailable')
  })

  it('AC-3.1 (031 verify) a sent attachment is not deleted by revoke, forget, remote off, Chat off or the sub-switch', async () => {
    const t = await ready()
    const id = await put(t)
    expect((await sendChat(t, '', [id])).status).toBe(200)
    await flush()
    t.h.setRemote({ sendFiles: false })
    await t.h.channel.sync()
    t.h.setRemote({ enabled: false })
    await t.h.channel.sync()
    await t.h.channel.revokeDevice((await t.h.phone()).deviceId)
    expect(t.onDisk().folders).toEqual([id])
    expect(t.store.lookup(id).state).toBe('present')
  })

  it('AC-3.1 (031 verify) a sent attachment is not deleted by a remove naming its id', async () => {
    const t = await ready()
    const id = await put(t)
    await sendChat(t, '', [id])
    expect((await t.h.call('/api/attachments/remove', { id })).status).toBe(200)
    expect(t.onDisk().folders).toEqual([id])
  })

  it('AC-3.2 (031 verify) removing a foreign, sent, unknown or malformed id answers byte-identically to a real removal and deletes nothing else', async () => {
    const t = await ready()
    const other = await t.device('other')
    const foreign = idOf(await other.call(CHAT, putBody('o.txt', bytesOf('o'))))
    const sent = await put(t, 's.txt')
    await sendChat(t, '', [sent])
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    const mine = await put(t, 'm.txt')
    const real = await t.h.call('/api/attachments/remove', { id: mine })
    const probes = [foreign, sent, '00000000-0000-4000-8000-000000000000', '../../x', '', ' ', '*', 'a'.repeat(64), mine]
    for (const id of probes) expect({ id, answer: await t.h.call('/api/attachments/remove', { id }) }).toEqual({ id, answer: real })
    expect(t.onDisk().folders.sort()).toEqual([foreign, sent].sort())
  })

  it('AC-3.2 (031 verify) a non-string id or an extra key is invalid, never a lookup', async () => {
    const t = await ready()
    for (const body of [{ id: 5 }, { id: null }, {}, { id: 'a', extra: 1 }, [], null]) expect(errorOf(await t.h.call('/api/attachments/remove', body))).toBe('invalid')
  })

  it('AC-3.2 (031 verify) the remove is a request like any other: the 61st in a minute is rate-limited', async () => {
    const t = await ready()
    t.h.setNow(50_000)
    for (let i = 0; i < 60; i++) expect((await t.h.call('/api/attachments/remove', { id: 'x' })).status).toBe(200)
    expect(errorOf(await t.h.call('/api/attachments/remove', { id: 'x' }))).toBe('rate-limited')
  })

  it('AC-3.4 (031 verify) erasing the personal files removes pending uploads with the rest of the store, and an export copies no attachment', async () => {
    const { erasePersonalFiles, exportPersonalData } = await import('../src/coordinator/privacy')
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const t = await ready()
    const id = await put(t)
    const data = mkdtempSync(join(tmpdir(), 'alma-v031-data-'))
    mkdirSync(join(data, 'threads'))
    writeFileSync(join(data, 'threads', 'x.json'), '{}')
    // the store lives under the inbox, which is not an exported name
    mkdirSync(join(data, 'inbox'))
    writeFileSync(join(data, 'inbox', 'copy.txt'), 'x')
    const out = exportPersonalData(data, tmpdir(), new Date('2026-01-01T00:00:00Z'))
    expect(readdirSync(out)).not.toContain('inbox')
    expect(readdirSync(out)).not.toContain('attachments')
    erasePersonalFiles(t.inbox)
    expect(existsSync(join(t.inbox, 'attachments'))).toBe(false)
    expect(t.store.lookup(id).state).toBe('unknown')
  })
})

describe('031 verify: sending with attachments (US-1, US-4)', () => {
  it('AC-4.1 (031 verify) an attachment-only message from the Chat tab runs through the same entry with the ids, and the uploads stop being pending', async () => {
    const t = await ready()
    const id = await put(t)
    const answer = await sendChat(t, '', [id])
    expect(answer.status).toBe(200)
    expect(t.h.chat.askCalls).toEqual([{ threadId: SHARED, text: '', attachments: [id] }])
    expect(t.h.timers.active()).toBe(0)
    t.h.chat.resolveAsk(0, 'listo')
    await flush()
    expect(errorOf(await sendChat(t, 'otra vez', [id]))).toBe('unavailable')
  })

  it('AC-4.1 (031 verify) one to five ids with text of 0 to 8000 characters are accepted; the same through a conversation by id', async () => {
    const t = await ready()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await put(t, `c${i}.txt`))
    expect((await sendChat(t, 'a'.repeat(8000), ids)).status).toBe(200)
    expect(t.h.chat.askCalls[0]).toEqual({ threadId: SHARED, text: 'a'.repeat(8000), attachments: ids })
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    const byId = await put(t, 'd.txt', T1)
    expect((await sendThread(t, T1, '', [byId])).status).toBe(200)
    expect(t.h.chat.askCalls[1]).toEqual({ threadId: T1, text: '', attachments: [byId] })
  })

  it('AC-4.1 (031 verify) a blank text is refused unless an id goes with it; whitespace counts as blank; an empty list is no ids', async () => {
    const t = await ready()
    for (const text of ['', ' ', '\n\t ', ' ']) {
      expect(errorOf(await sendChat(t, text))).toBe('invalid')
      expect(errorOf(await sendChat(t, text, []))).toBe('invalid')
      expect(errorOf(await sendThread(t, T1, text))).toBe('invalid')
      expect(errorOf(await sendThread(t, T1, text, []))).toBe('invalid')
    }
    expect(t.h.chat.askCalls).toEqual([])
    const id = await put(t)
    expect((await sendChat(t, '   ', [id])).status).toBe(200)
  })

  it('AC-4.1 (031 verify) with no ids the send is exactly as today: the run gets no attachments argument', async () => {
    const t = await ready()
    expect((await sendChat(t, 'hola')).status).toBe(200)
    expect(t.h.chat.askCalls).toEqual([{ threadId: SHARED, text: 'hola' }])
    expect('attachments' in t.h.chat.askCalls[0]).toBe(false)
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    expect((await sendChat(t, 'hola', [])).status).toBe(200)
    expect('attachments' in t.h.chat.askCalls[1]).toBe(false)
    t.h.chat.resolveAsk(1, 'ok')
    await flush()
    expect((await sendThread(t, T1, 'hola', [])).status).toBe(200)
    expect('attachments' in t.h.chat.askCalls[2]).toBe(false)
  })

  it('AC-4.1 (031 verify) the message is committed before the ids stop being pending, and a conversation send into the shared id works with either route\'s uploads', async () => {
    const t = await ready()
    const viaChat = await put(t, 'a.txt')
    expect((await sendThread(t, SHARED, '', [viaChat])).status).toBe(200)
    expect(t.h.chat.threads[0].messages.at(-1)?.role).toBe('user')
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    const viaId = await put(t, 'b.txt', SHARED)
    expect((await sendChat(t, '', [viaId])).status).toBe(200)
  })

  it('AC-4.2 (031 verify) every cause of a bad id gives the same answer, runs nothing, commits nothing, and leaves the other uploads pending', async () => {
    const t = await ready()
    t.h.setNow(10)
    const other = await t.device('other')
    const foreign = idOf(await other.call(CHAT, putBody('f.txt', bytesOf('f'))))
    const elsewhere = await put(t, 'e.txt', T1)
    const sent = await put(t, 's.txt')
    await sendChat(t, '', [sent])
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    const keep = await put(t, 'k.txt')
    const before = t.h.chat.threads[0].messages.length
    const six = [keep, 'a', 'b', 'c', 'd', 'e']
    const causes: [string, string[]][] = [
      ['unknown', [keep, '00000000-0000-4000-8000-000000000000']],
      ['another device', [keep, foreign]],
      ['another conversation', [keep, elsewhere]],
      ['already sent', [keep, sent]],
      ['malformed', [keep, '../../x']],
      ['empty id', [keep, '']],
      ['a 64-character id', [keep, 'a'.repeat(64)]],
      ['duplicate', [keep, keep]],
      ['more than five', six],
      ['64 ids', Array.from({ length: 64 }, (_, i) => `id${i}`)]
    ]
    const answers = []
    for (const [label, ids] of causes) answers.push({ label, answer: await sendChat(t, 'hola', ids) })
    for (const { label, answer } of answers) {
      expect({ label, error: errorOf(answer) }).toEqual({ label, error: 'unavailable' })
      expect({ label, answer }).toEqual({ label, answer: { ...answers[0].answer } })
    }
    expect(t.h.chat.askCalls).toHaveLength(1)
    expect(t.h.chat.threads[0].messages.length).toBe(before)
    // the other uploads of the device are untouched and the good id still works
    expect(t.onDisk().folders).toEqual(expect.arrayContaining([keep, elsewhere, foreign]))
    expect((await sendChat(t, 'ahora sí', [keep])).status).toBe(200)
  })

  it('AC-4.2 (031 verify) the same through a conversation by id, including the id of the shared thread\'s upload', async () => {
    const t = await ready()
    const shared = await put(t)
    const mine = await put(t, 'm.txt', T1)
    for (const ids of [[shared], [mine, shared], [mine, mine], ['x'], [mine, 'y']]) {
      const answer = await sendThread(t, T1, 'hola', ids)
      expect({ ids, error: errorOf(answer), status: answer.status }).toEqual({ ids, error: 'unavailable', status: 404 })
    }
    expect(t.h.chat.askCalls).toEqual([])
    expect((await sendThread(t, T1, 'hola', [mine])).status).toBe(200)
  })

  it('AC-4.2 (031 verify) 65 ids are more than five as well, and answer unavailable like any other bad list', async () => {
    const t = await ready()
    const answer = await sendChat(t, 'hola', Array.from({ length: 65 }, (_, i) => `id${i}`))
    expect(errorOf(answer)).toBe('unavailable')
  })

  it('AC-4.2 (031 verify) an id list that is not a list of strings is invalid at the boundary and runs nothing', async () => {
    const t = await ready()
    for (const bad of ['abc', 5, {}, [1], [null], [[]], [{ id: 'x' }]]) expect(errorOf(await sendChat(t, 'hola', bad))).toBe('invalid')
    expect(errorOf(await t.h.call('/api/chat/send', { text: 'hola', attachments: ['a'], ids: ['b'] }))).toBe('invalid')
    expect(t.h.chat.askCalls).toEqual([])
  })

  it('AC-4.3 (031 verify) a busy conversation, an active run of the device and a too-long text refuse the send and the uploads stay pending', async () => {
    const t = await ready()
    const id = await put(t, 'a.txt', T1)
    t.h.threads.running.add(T1)
    expect(errorOf(await sendThread(t, T1, 'hola', [id]))).toBe('busy')
    t.h.threads.running.delete(T1)
    expect(errorOf(await sendThread(t, T1, 'a'.repeat(8001), [id]))).toBe('invalid')
    // this device already has a run going in the shared thread
    expect((await sendChat(t, 'corre')).status).toBe(200)
    expect(errorOf(await sendThread(t, T1, 'hola', [id]))).toBe('run-active')
    expect(t.h.chat.askCalls).toHaveLength(1)
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    expect((await sendThread(t, T1, 'hola', [id])).status).toBe(200)
  })

  it('AC-4.3 (031 verify) the shared thread busy case: ids stay pending until expiry', async () => {
    const t = await ready()
    t.h.setNow(100)
    const id = await put(t)
    await t.h.call('/api/chat/send', { text: 'corre' })
    expect(errorOf(await sendChat(t, 'hola', [id]))).toMatch(/busy|run-active/)
    expect(t.onDisk().folders).toEqual([id])
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    expect((await sendChat(t, 'hola', [id])).status).toBe(200)
  })

  it('AC-4.3 (031 verify) the sub-switch turned off between the put and the send refuses the send as attach-off; a text-only send still works', async () => {
    const t = await ready()
    const id = await put(t)
    t.h.setRemote({ sendFiles: false })
    const answer = await sendChat(t, 'hola', [id])
    expect(errorOf(answer)).toBe('attach-off')
    expect(answer.status).toBe(403)
    expect(t.h.chat.askCalls).toEqual([])
    expect((await sendChat(t, 'solo texto')).status).toBe(200)
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    t.h.setRemote({ sendFiles: true })
    expect((await sendChat(t, 'ahora con archivo', [id])).status).toBe(200)
  })

  it('AC-4.3 (031 verify) the notice is checked again at send: a conversation whose model changed is notice-needed and the uploads stay pending', async () => {
    const t = await ready()
    const agent = t.settings().agents[0].provider
    const other = agent === 'anthropic' ? 'xai' : 'anthropic'
    t.acknowledge([agent])
    const thread = t.h.chat.threads.find((x) => x.id === T1)
    const id = await put(t, 'a.txt', T1)
    if (!thread) throw new Error('no thread')
    thread.model = { provider: other, model: 'm' }
    const answer = await sendThread(t, T1, 'hola', [id])
    expect(errorOf(answer)).toBe('notice-needed')
    expect(answer.status).toBe(403)
    expect(t.h.chat.askCalls).toEqual([])
    delete thread.model
    expect((await sendThread(t, T1, 'hola', [id])).status).toBe(200)
  })

  it('AC-4.3 (031 verify) the notice is checked at send for the Chat tab too', async () => {
    const t = await ready()
    const id = await put(t)
    t.acknowledge([])
    expect(errorOf(await sendChat(t, 'hola', [id]))).toBe('notice-needed')
    expect(t.h.chat.askCalls).toEqual([])
    t.acknowledge('all')
    expect((await sendChat(t, 'hola', [id])).status).toBe(200)
  })

  it('AC-4.1 (031 verify) the ids are claimed before the run and bound only once it started: a start that throws leaves them pending', async () => {
    const t = await ready()
    const id = await put(t)
    t.h.chat.throwSync = true
    const answer = await sendChat(t, 'hola', [id])
    expect(answer.status).toBe(500)
    expect(t.h.chat.askCalls).toHaveLength(1)
    t.h.chat.throwSync = false
    expect(t.onDisk().folders).toEqual([id])
    expect((await sendChat(t, 'hola', [id])).status).toBe(200)
    // and the same through a conversation by id
    const byId = await put(t, 'b.txt', T1)
    t.h.chat.resolveAsk(0, 'ok')
    await flush()
    t.h.chat.throwSync = true
    expect((await sendThread(t, T1, 'hola', [byId])).status).toBe(500)
    t.h.chat.throwSync = false
    expect((await sendThread(t, T1, 'hola', [byId])).status).toBe(200)
  })

  it('AC-4.1 (031 verify) a run that fails after the message was committed does not give the uploads back: they belong to the message', async () => {
    const t = await ready()
    const id = await put(t)
    expect((await sendChat(t, 'hola', [id])).status).toBe(200)
    t.h.chat.rejectAsk(0, new Error('model down'))
    await flush()
    expect(errorOf(await sendChat(t, 'otra', [id]))).toBe('unavailable')
    expect(t.onDisk().folders).toEqual([id])
  })

  it('AC-4.4 (031 verify) an attachment-only message never starts a conversation: an unknown or company id is gone and nothing is created', async () => {
    const t = await ready()
    t.addThread('co', 'ceo')
    const id = await put(t)
    const before = t.h.chat.threads.length
    for (const target of ['nope', 'co']) expect(errorOf(await sendThread(t, target, '', [id]))).toBe('gone')
    expect(t.h.chat.threads).toHaveLength(before)
    expect(t.h.chat.askCalls).toEqual([])
  })

  it('AC-4.5 (031 verify) files sent into a Telegram, WhatsApp or voice conversation run there and send nothing out', async () => {
    const t = await ready()
    for (const channel of ['telegram', 'whatsapp', 'voice'] as const) {
      t.addThread(`ch-${channel}`, 'general', { channel })
      const id = await put(t, `${channel}.txt`, `ch-${channel}`)
      expect((await sendThread(t, `ch-${channel}`, '', [id])).status).toBe(200)
      t.h.chat.resolveAsk(t.h.chat.askCalls.length - 1, 'ok')
      await flush()
    }
    expect(t.h.chat.askCalls.map((c) => c.threadId)).toEqual(['ch-telegram', 'ch-whatsapp', 'ch-voice'])
    expect(t.h.posts).toEqual([])
  })

  it('AC-4.2 (031 verify) two devices claiming the same id in the same instant: only the owner\'s send runs', async () => {
    const t = await ready()
    const id = await put(t)
    const other = await t.device('other')
    const [mine, theirs] = await Promise.all([sendChat(t, 'hola', [id]), other.call('/api/chat/send', { text: 'hola', attachments: [id] })])
    expect([mine.status, errorOf(theirs)]).toEqual([200, 'unavailable'])
    expect(t.h.chat.askCalls).toHaveLength(1)
  })
})
