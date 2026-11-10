import { describe, expect, it } from 'vitest'
import { authorize } from '../src/coordinator/approval'
import { readAttachmentTool } from '../src/coordinator/attachments/read-tool'
import { composeUserMessage } from '../src/coordinator/attachments/service'
import { ChatFlow } from '../src/coordinator/channels/remote/chat'
import { ThreadsFlow } from '../src/coordinator/channels/remote/threads'
import { RunTies } from '../src/coordinator/channels/remote/runs'
import { refusalResponse } from '../src/coordinator/channels/remote/transport'
import { UploadsFlow } from '../src/coordinator/channels/remote/uploads'
import { defaultSettings } from '../src/shared/defaults'
import { defaultRemote } from '../src/shared/remote/settings'
import type { RemoteSettings } from '../src/shared/types'
import { makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

/** The real pending list with nothing pending: the blank-text rule of both sends lives in it. */
const noUploads = () =>
  new UploadsFlow({
    now: () => 0,
    sharedId: () => 'remote',
    reachable: () => undefined,
    isRunning: () => false,
    files: { put: () => ({ ok: false, reason: 'invalid' }), remove: () => {}, readersOwed: () => [] },
    timers: { set: () => 0, clear: () => {} },
    onLeftover: () => {}
  })

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const file = (name = 'a.txt', text = 'hola') => ({ name, size: Buffer.byteLength(text), base64: Buffer.from(text).toString('base64') })

/** Distinct bytes on every call, so two paired devices never share a session token. */
function varying(): (length: number) => Uint8Array {
  let n = 0
  return (length) => new Uint8Array(length).fill(++n % 256)
}

async function served(remote: Partial<RemoteSettings> = {}): Promise<Harness> {
  const base = defaultRemote()
  const t = await testChannel({
    remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true, sendFiles: true, ...remote },
    random: varying()
  })
  await t.channel.sync()
  t.chat.threads.push(makeThread('t1'), makeThread('t2'))
  return t
}

/** Puts one file and returns the id the PC gave it. */
async function put(t: Harness, id?: string, name = 'a.txt'): Promise<string> {
  const response = await t.call(id ? '/api/threads/attach' : '/api/chat/attach', id ? { id, ...file(name) } : file(name))
  expect(response.status, name).toBe(200)
  return (response.body as { attachment: { id: string } }).attachment.id
}

/** A second paired phone, in session. */
async function other(t: Harness): Promise<{ deviceId: string; headers: Record<string, string> }> {
  await t.phone()
  const { deviceId, privateKey } = await pairDevice(t, 'other')
  const token = await openSession(t, deviceId, privateKey)
  return { deviceId, headers: { host: 'test.invalid', authorization: `Bearer ${token}` } }
}

const userMessages = (t: Harness, threadId = 'remote') => t.chat.threads.find((thread) => thread.id === threadId)?.messages.filter((m) => m.role === 'user') ?? []

describe('the Chat tab sends with pending uploads (spec 031 T29)', () => {
  it('AC-4.1 (031) a send with ids calls ask with the ids, commits first, and the uploads stop being pending', async () => {
    const t = await served()
    const ids = [await put(t), await put(t, undefined, 'b.txt')]
    const sent = await t.call('/api/chat/send', { text: 'mirá esto', attachments: ids })
    expect(sent.status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: 'mirá esto', attachments: ids }])
    // the user message is committed by the time the answer is out
    expect(userMessages(t)).toHaveLength(1)
    // no longer pending: no expiry timer, nothing deleted, the slots are free, and the ids cannot be sent twice
    expect(t.timers.active()).toBe(0)
    expect(t.files.removes).toEqual([])
    t.chat.resolveAsk(0, 'listo')
    await settled()
    const again = await t.call('/api/chat/send', { text: 'otra vez', attachments: [ids[0]] })
    expect(again).toEqual(refusalResponse('unavailable'))
    for (let i = 0; i < 5; i++) await put(t, undefined, `n${i}.txt`)
  })

  it('AC-4.1 (031) a send with no ids is as today and a blank text is refused', async () => {
    const t = await served()
    expect((await t.call('/api/chat/send', { text: 'hola' })).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: 'hola' }])
    t.chat.resolveAsk(0, 'ok')
    await settled()
    for (const body of [{ text: '   ' }, { text: '', attachments: [] }]) {
      expect(await t.call('/api/chat/send', body)).toEqual(refusalResponse('invalid'))
    }
    expect(t.chat.askCalls).toHaveLength(1)
  })

  it('AC-4.2 (031) a bad id refuses the whole send as unavailable and leaves the other uploads pending', async () => {
    const t = await served()
    const good = await put(t)
    const onT1 = await put(t, 't1', 'c.txt')
    const second = await other(t)
    const theirs = (await t.transport.request({ method: 'POST', path: '/api/chat/attach', headers: second.headers, body: file('d.txt') })).body as { attachment: { id: string } }
    const six = [good, 'x2', 'x3', 'x4', 'x5', 'x6']
    const causes: Record<string, string[]> = {
      unknown: [good, 'att-999'],
      'another conversation': [good, onT1],
      "another device's": [good, theirs.attachment.id],
      malformed: [good, ''],
      duplicate: [good, good],
      'six ids': six
    }
    for (const [cause, ids] of Object.entries(causes)) {
      const answer = await t.call('/api/chat/send', { text: 'x', attachments: ids })
      expect(answer, cause).toEqual(refusalResponse('unavailable'))
    }
    // nothing ran, nothing was committed, nothing was deleted: the good upload is still claimable
    expect(t.chat.askCalls).toHaveLength(0)
    expect(userMessages(t)).toHaveLength(0)
    expect(t.files.removes).toEqual([])
    expect((await t.call('/api/chat/send', { text: 'x', attachments: [good] })).status).toBe(200)
  })

  it('AC-4.2 (031) an expired upload is unavailable even when its timer never fired', async () => {
    const t = await served()
    const id = await put(t)
    t.setNow(900_000)
    expect(await t.call('/api/chat/send', { text: 'x', attachments: [id] })).toEqual(refusalResponse('unavailable'))
    expect(t.chat.askCalls).toHaveLength(0)
  })

  it('AC-4.3 (031) busy, run-active and a failing ask keep the uploads pending', async () => {
    const t = await served()
    const id = await put(t)
    // a failing ask: 500, the message is not committed, the upload is still pending
    t.chat.throwSync = true
    expect((await t.call('/api/chat/send', { text: 'x', attachments: [id] })).status).toBe(500)
    t.chat.throwSync = false
    expect(userMessages(t)).toHaveLength(0)
    expect(t.timers.active()).toBe(1)
    // run-active: this device already has a run in a conversation
    expect((await t.call('/api/threads/send', { id: 't1', text: 'trabajá' })).status).toBe(200)
    expect(await t.call('/api/chat/send', { text: 'x', attachments: [id] })).toEqual(refusalResponse('run-active'))
    t.chat.resolveAsk(0, 'listo')
    await settled()
    // busy: another device's run holds the Chat tab's thread
    const second = await other(t)
    const own = await t.call('/api/chat/send', { text: 'primero' })
    expect(own.status).toBe(200)
    const busy = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers: second.headers, body: { text: 'x', attachments: [id] } })
    expect(busy.status).toBe(409)
    expect(t.files.removes).toEqual([])
    expect(t.timers.active()).toBe(1)
    // still claimable once the way is clear
    t.chat.resolveAsk(1, 'ok')
    await settled()
    expect((await t.call('/api/chat/send', { text: 'x', attachments: [id] })).status).toBe(200)
  })

  it('AC-4.3 (031) a text over 8000 characters and a switched-off sub-switch keep the uploads pending', async () => {
    const t = await served()
    const id = await put(t)
    expect((await t.call('/api/chat/send', { text: 'x'.repeat(8001), attachments: [id] })).status).toBe(400)
    t.setRemote({ sendFiles: false })
    expect(await t.call('/api/chat/send', { text: 'x', attachments: [id] })).toEqual(refusalResponse('attach-off'))
    expect(t.chat.askCalls).toHaveLength(0)
    expect(t.files.removes).toEqual([])
    t.setRemote({ sendFiles: true })
    expect((await t.call('/api/chat/send', { text: 'x', attachments: [id] })).status).toBe(200)
  })

  it('AC-4.4 (031) an attachment-only message is accepted', async () => {
    const t = await served()
    const id = await put(t)
    expect((await t.call('/api/chat/send', { text: '', attachments: [id] })).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: '', attachments: [id] }])
  })

  it('AC-4.4 (031) a blank text is accepted only when at least one pending upload is bound', async () => {
    const t = await served()
    const id = await put(t)
    for (const attachments of [['att-999'], [''], [id, id]]) {
      expect(await t.call('/api/chat/send', { text: '  ', attachments })).toEqual(refusalResponse('unavailable'))
    }
    expect(t.chat.askCalls).toHaveLength(0)
    expect(userMessages(t)).toHaveLength(0)
  })

  it('AC-4.4 (031) the flow itself never lets a blank text without bound uploads reach ask', () => {
    const asks: string[] = []
    const flow = new ChatFlow({
      conversation: () => makeThread('remote'),
      ask: (_thread, text) => {
        asks.push(text)
        return Promise.resolve()
      },
      cancel: () => {},
      approvals: () => [],
      waiting: () => false,
      ties: new RunTies(),
      uploads: noUploads()
    })
    expect(flow.send('d1', '   ')).toEqual({ error: 'invalid' })
    expect(flow.send('d1', '')).toEqual({ error: 'invalid' })
    expect(asks).toEqual([])
    expect(flow.send('d1', 'hola')).toEqual({ ok: true })
  })

  it('AC-4.4 (031) ask receiving blank text with ids composes a message', () => {
    const lookup = (id: string) =>
      id === 'att-1'
        ? { state: 'present' as const, record: { id: 'att-1', threadId: 'remote', originalName: 'a.txt', kind: 'text' as const, size: 4 } }
        : { state: 'unknown' as const }
    const { message, title } = composeUserMessage({
      text: '',
      ids: ['att-1'],
      threadId: 'remote',
      reader: { lookup } as never,
      language: 'en',
      untitled: 'Untitled',
      now: 7
    })
    expect(message.role).toBe('user')
    expect(message.attachments).toEqual([{ id: 'att-1', name: 'a.txt', kind: 'text', size: 4 }])
    expect(title).toBe('a.txt')
    expect(() => composeUserMessage({ text: '', ids: ['nope'], threadId: 'remote', reader: { lookup } as never, language: 'en', untitled: 'Untitled', now: 7 })).toThrow()
  })
})

describe('a conversation sends with pending uploads (spec 031 T30)', () => {
  const send = (t: Harness, id: string, text: string, attachments?: string[]) => t.call('/api/threads/send', { id, text, ...(attachments ? { attachments } : {}) })

  it('AC-4.1 (031) a send with ids calls ask with the ids, commits first, and the uploads stop being pending', async () => {
    const t = await served()
    const ids = [await put(t, 't1'), await put(t, 't1', 'b.txt')]
    expect((await send(t, 't1', 'mirá esto', ids)).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 't1', text: 'mirá esto', attachments: ids }])
    expect(userMessages(t, 't1')).toHaveLength(1)
    expect(t.timers.active()).toBe(0)
    expect(t.files.removes).toEqual([])
    t.chat.resolveAsk(0, 'listo')
    await settled()
    expect(await send(t, 't1', 'otra vez', [ids[0]])).toEqual(refusalResponse('unavailable'))
  })

  it('AC-4.1 (031) a send with no ids is as today and a blank text is refused', async () => {
    const t = await served()
    expect((await send(t, 't1', 'hola')).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 't1', text: 'hola' }])
    t.chat.resolveAsk(0, 'ok')
    await settled()
    for (const body of [{ id: 't1', text: '  ' }, { id: 't1', text: '', attachments: [] }]) {
      expect(await t.call('/api/threads/send', body)).toEqual(refusalResponse('invalid'))
    }
    expect(t.chat.askCalls).toHaveLength(1)
  })

  it('AC-4.2 (031) a bad id refuses the whole send as unavailable and leaves the other uploads pending', async () => {
    const t = await served()
    const good = await put(t, 't1')
    const onT2 = await put(t, 't2', 'c.txt')
    const second = await other(t)
    const theirs = (await t.transport.request({ method: 'POST', path: '/api/threads/attach', headers: second.headers, body: { id: 't1', ...file('d.txt') } })).body as { attachment: { id: string } }
    const causes: Record<string, string[]> = {
      unknown: [good, 'att-999'],
      'another conversation': [good, onT2],
      "another device's": [good, theirs.attachment.id],
      malformed: [good, ''],
      duplicate: [good, good],
      'six ids': [good, 'x2', 'x3', 'x4', 'x5', 'x6']
    }
    for (const [cause, ids] of Object.entries(causes)) expect(await send(t, 't1', 'x', ids), cause).toEqual(refusalResponse('unavailable'))
    expect(t.chat.askCalls).toHaveLength(0)
    expect(userMessages(t, 't1')).toHaveLength(0)
    expect(t.files.removes).toEqual([])
    expect((await send(t, 't1', 'x', [good])).status).toBe(200)
  })

  it('AC-4.2 (031) an id pending for another conversation is unavailable', async () => {
    const t = await served()
    const id = await put(t, 't2')
    expect(await send(t, 't1', 'x', [id])).toEqual(refusalResponse('unavailable'))
    // not even the Chat tab's thread takes it
    expect(await t.call('/api/chat/send', { text: 'x', attachments: [id] })).toEqual(refusalResponse('unavailable'))
    expect((await send(t, 't2', 'x', [id])).status).toBe(200)
  })

  it('AC-4.3 (031) a failing ask, a busy conversation and one phone-started run per device keep the uploads pending', async () => {
    const t = await served()
    const id = await put(t, 't1')
    // a failing ask: 500, nothing committed, still pending
    t.chat.throwSync = true
    expect((await send(t, 't1', 'x', [id])).status).toBe(500)
    t.chat.throwSync = false
    expect(userMessages(t, 't1')).toHaveLength(0)
    expect(t.timers.active()).toBe(1)
    // busy: a run started on the PC holds the conversation
    t.threads.running.add('t1')
    expect(await send(t, 't1', 'x', [id])).toEqual(refusalResponse('busy'))
    t.threads.running.delete('t1')
    // one phone-started run per device still holds
    expect((await send(t, 't2', 'trabajá')).status).toBe(200)
    expect(await send(t, 't1', 'x', [id])).toEqual(refusalResponse('run-active'))
    expect(t.files.removes).toEqual([])
    expect(t.timers.active()).toBe(1)
    t.chat.resolveAsk(0, 'listo')
    await settled()
    expect((await send(t, 't1', 'x', [id])).status).toBe(200)
  })

  it('AC-4.3 (031) a switched-off sub-switch keeps the uploads pending', async () => {
    const t = await served()
    const id = await put(t, 't1')
    t.setRemote({ sendFiles: false })
    expect(await send(t, 't1', 'x', [id])).toEqual(refusalResponse('attach-off'))
    t.setRemote({ sendFiles: true })
    expect((await send(t, 't1', 'x', [id])).status).toBe(200)
  })

  it('AC-4.4 (031) an attachment-only message is accepted, and a blank text needs bound uploads', async () => {
    const t = await served()
    const id = await put(t, 't1')
    expect(await send(t, 't1', ' ', ['att-999'])).toEqual(refusalResponse('unavailable'))
    expect(t.chat.askCalls).toHaveLength(0)
    expect((await send(t, 't1', '', [id])).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 't1', text: '', attachments: [id] }])
  })

  it("AC-4.1 (031) a send naming the Chat tab's thread by id goes through the same claim", async () => {
    const t = await served()
    const id = await put(t, 'remote')
    expect(await send(t, 'remote', 'x', ['att-999'])).toEqual(refusalResponse('unavailable'))
    expect((await send(t, 'remote', '', [id])).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: '', attachments: [id] }])
    expect(t.timers.active()).toBe(0)
  })

  it('AC-4.5 (031) a send into a Telegram, WhatsApp or voice conversation sends nothing out', async () => {
    const t = await served()
    for (const channel of ['telegram', 'whatsapp', 'voice'] as const) {
      const thread = makeThread(`via-${channel}`)
      thread.channel = channel
      t.chat.threads.push(thread)
      const id = await put(t, thread.id)
      expect((await send(t, thread.id, 'mirá', [id])).status, channel).toBe(200)
      t.chat.resolveAsk(t.chat.pending.length - 1, 'ok')
      await settled()
    }
    // the only outward call the remote module can make is the push post, and it made none; the run entry got the ids
    expect(t.posts).toHaveLength(0)
    expect(t.chat.askCalls.map((call) => call.threadId)).toEqual(['via-telegram', 'via-whatsapp', 'via-voice'])
  })

  it('AC-4.4 (031) the flow itself never lets a blank text without bound uploads reach ask', () => {
    const asks: string[] = []
    const flow = new ThreadsFlow({
      threads: { list: () => [], get: (id) => makeThread(id), isRunning: () => false, markOpened: () => {} },
      settings: () => defaultSettings(),
      sharedId: () => 'remote',
      ties: new RunTies(),
      waiting: () => false,
      now: () => 0,
      ask: (_thread, text) => {
        asks.push(text)
        return Promise.resolve()
      },
      cancel: () => {},
      sendShared: () => ({ ok: true }),
      uploads: noUploads()
    })
    expect(flow.send('d1', 'talk', '  ')).toEqual(refusalResponse('invalid'))
    expect(asks).toEqual([])
    expect(flow.send('d1', 'talk', 'hola')).toMatchObject({ status: 200 })
  })
})

describe('the provider notice is checked again at send (spec 031 T31)', () => {
  it('AC-4.3 (031) a send is notice-needed when the conversation\'s agent changed after the put, in the Chat tab and in a conversation', async () => {
    const t = await served()
    const shared = await put(t)
    const byId = await put(t, 't1')
    // acknowledged at put, not at send: the conversation's provider changed in between
    t.files.owed = ['anthropic']
    expect(await t.call('/api/chat/send', { text: 'x', attachments: [shared] })).toEqual(refusalResponse('notice-needed'))
    expect(await t.call('/api/threads/send', { id: 't1', text: 'x', attachments: [byId] })).toEqual(refusalResponse('notice-needed'))
    // nothing ran, nothing was committed, the uploads are still pending and still not deleted
    expect(t.chat.askCalls).toHaveLength(0)
    expect(userMessages(t)).toHaveLength(0)
    expect(t.files.removes).toEqual([])
    expect(t.timers.active()).toBe(2)
    // a send with no ids owes nothing
    expect((await t.call('/api/chat/send', { text: 'solo texto' })).status).toBe(200)
    t.chat.resolveAsk(0, 'ok')
    await settled()
    // the person accepted the notice on the PC: the same ids go through
    t.files.owed = []
    expect((await t.call('/api/chat/send', { text: 'x', attachments: [shared] })).status).toBe(200)
    expect(t.chat.askCalls.at(-1)).toEqual({ threadId: 'remote', text: 'x', attachments: [shared] })
  })

  it('AC-4.3 (031) a bad id is unavailable before the notice is looked at', async () => {
    const t = await served()
    await put(t)
    t.files.owed = ['anthropic']
    expect(await t.call('/api/chat/send', { text: 'x', attachments: ['att-999'] })).toEqual(refusalResponse('unavailable'))
    expect(await t.call('/api/threads/send', { id: 't1', text: 'x', attachments: ['att-999'] })).toEqual(refusalResponse('unavailable'))
  })
})

describe('approvals are unchanged for a run with attachments (spec 031 T32)', () => {
  it('AC-4.6 (031) read_attachment is read and never asks, in any approval mode', async () => {
    expect(readAttachmentTool.risk).toBe('read')
    const t = await served()
    for (const approvalMode of ['needs-approval', 'auto-review', 'blocked', 'always-allow'] as const) {
      const verdict = await authorize({
        settings: { ...defaultSettings(), approvalMode },
        threadId: 'remote',
        toolUseId: 'tu1',
        toolName: readAttachmentTool.name,
        risk: readAttachmentTool.risk,
        input: { id: 'att-1' },
        workspace: '',
        taskContext: '',
        autoApprove: [],
        signal: new AbortController().signal,
        broker: t.approvals.broker,
        setState: () => {},
        rememberAlwaysAllow: () => {}
      })
      expect(verdict.allowed, approvalMode).toBe(true)
    }
    expect(t.approvals.broker.pending()).toEqual([])
  })

  it('AC-4.6 (031) a phone-started run with attachments keeps one run per device and approvals only for the device that started it', async () => {
    const t = await served({ scopes: { ...defaultRemote().scopes, chat: true, history: true, approve: true } })
    const phone = (await t.phone()).headers
    const tablet = await other(t)
    const id = await put(t, 't1')
    const second = await put(t, 't2')
    expect((await t.call('/api/threads/send', { id: 't1', text: 'mirá', attachments: [id] })).status).toBe(200)
    // one phone-started run per device, with or without attachments
    expect(await t.call('/api/threads/send', { id: 't2', text: '', attachments: [second] })).toEqual(refusalResponse('run-active'))
    // the approval of a tool the run asks for belongs to the device that started the run
    const asked = t.approvals.askApproval({ threadId: 't1', toolUseId: 'tu1', toolName: 'run_command', input: { command: 'ls' }, flagged: false, allowAlways: true })
    const listedFor = async (headers: Record<string, string>) =>
      ((await t.transport.request({ method: 'GET', path: '/api/approvals', headers })).body as { approvals: { id: string }[] }).approvals.map((a) => a.id)
    expect(await listedFor(phone)).toEqual([asked.approvalId])
    expect(await listedFor(tablet.headers)).toEqual([])
    const stranger = await t.transport.request({ method: 'POST', path: '/api/approvals/answer', headers: tablet.headers, body: { id: asked.approvalId, decision: 'allow' } })
    expect(stranger).toMatchObject({ status: 409, body: { error: 'already-answered' } })
    expect(t.approvals.answered).toEqual([])
    expect((await t.call('/api/approvals/answer', { id: asked.approvalId, decision: 'deny' })).status).toBe(200)
  })
})
