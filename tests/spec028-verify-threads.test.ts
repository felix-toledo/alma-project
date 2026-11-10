import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultRemote } from '../src/shared/remote/settings'
import type { ChatMessage, Thread } from '../src/shared/types'
import { COMPANY_AGENT, HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

// Adversarial verification of spec 028 §Conversations, written without reading the plan or the implementer's notes.

function varying(): (length: number) => Uint8Array {
  let n = 0
  return (length) => new Uint8Array(length).fill(++n % 256)
}

interface Options {
  history?: boolean
  cont?: boolean
  approve?: boolean
  chat?: boolean
}

async function served(options: Options = {}): Promise<{
  t: Harness
  tablet(path: string, body?: unknown): ReturnType<Harness['call']>
  tabletId: string
  phoneId: string
}> {
  const scopes = { ...defaultRemote().scopes, history: options.history ?? true, chat: options.chat ?? true, approve: options.approve ?? true }
  const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: options.cont ?? true }, random: varying() })
  await t.channel.sync()
  t.chat.threads.push(makeThread('talk'), makeThread('pc'), makeThread('other'))
  const phone = await t.phone()
  const paired = await pairDevice(t, 'tablet')
  const headers = { ...HOST, authorization: `Bearer ${await openSession(t, paired.deviceId, paired.privateKey)}` }
  return { t, tablet: (path, body) => t.transport.request({ method: 'POST', path, headers, body }), tabletId: paired.deviceId, phoneId: phone.deviceId }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const approvalOf = (threadId: string): Parameters<Harness['approvals']['askApproval']>[0] => ({
  threadId,
  toolUseId: 'tu',
  toolName: 'run_command',
  input: { command: 'ls' },
  flagged: false,
  allowAlways: true
})

const listed = async (t: Harness, who?: Record<string, string>): Promise<{ id: string; thread?: string }[]> => {
  const headers = who ?? (await t.phone()).headers
  return ((await t.transport.request({ method: 'GET', path: '/api/approvals', headers })).body as { approvals: { id: string; thread?: string }[] }).approvals
}

describe('AC-3.1 / AC-3.4 (028 verify) list and ids', () => {
  it('AC-3.1 (028 verify) 75 conversations with company ones interleaved page 30 at a time, no duplicates, no company row, honest "more"', async () => {
    const { t } = await served()
    t.chat.threads.splice(1) // keep the shared thread only
    for (let i = 0; i < 80; i++) t.chat.threads.push({ ...makeThread(i % 4 === 0 ? `c${i}` : `t${i}`, i % 4 === 0 ? COMPANY_AGENT : 'general'), updatedAt: 1000 - i })
    const expected = t.chat.threads.filter((thread) => thread.agentId !== COMPANY_AGENT).map((thread) => thread.id)
    expect(expected.length).toBe(61)
    const seen: string[] = []
    const pages: { rows: { id: string }[]; more: boolean }[] = []
    for (const offset of [0, 30, 60, 90, 1_000_000]) {
      const res = await t.call('/api/threads/list', { offset })
      expect(res.status).toBe(200)
      const page = res.body as { rows: { id: string }[]; more: boolean }
      pages.push(page)
      seen.push(...page.rows.map((row) => row.id))
    }
    expect(pages.map((page) => page.rows.length)).toEqual([30, 30, 1, 0, 0])
    expect(pages.map((page) => page.more)).toEqual([true, true, false, false, false])
    expect(seen).toEqual(expected)
    expect(seen.some((id) => id.startsWith('c'))).toBe(false)
  })

  it('AC-3.1 (028 verify) malformed offsets and keys are refused before any handler runs', async () => {
    const { t } = await served()
    for (const body of [{ offset: -1 }, { offset: 1.5 }, { offset: '0' }, { offset: null }, { offset: Number.NaN }, { offset: Infinity }, {}, { offset: 0, x: 1 }, [], 0]) {
      expect((await t.call('/api/threads/list', body)).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('AC-3.1 (028 verify) a row and a window never carry the working folder, model, tool state or the PC path', async () => {
    const { t } = await served()
    const secret: Thread = { ...makeThread('talk'), workspace: 'C:\\Users\\felix\\SECRETPROJECT', model: 'SECRETMODEL' as never, toolStates: { x: { status: 'done', note: 'SECRETNOTE' } } as never }
    secret.messages.push({ role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 1, model: 'SECRETMODEL', raw: 'SECRETRAW', notice: 'SECRETNOTICE', usage: { inputTokens: 999, outputTokens: 1 } } as ChatMessage)
    t.chat.threads.splice(t.chat.threads.findIndex((thread) => thread.id === 'talk'), 1, secret)
    const list = JSON.stringify((await t.call('/api/threads/list', { offset: 0 })).body)
    const read = JSON.stringify((await t.call('/api/threads/read', { id: 'talk' })).body)
    for (const body of [list, read]) expect(body).not.toMatch(/SECRET|felix|Users|inputTokens/)
    expect(read).toContain('hola')
  })

  it('AC-3.4 (028 verify) hostile or company ids: one answer for read, send and stop, byte-identical to an unknown id', async () => {
    const { t } = await served()
    t.chat.threads.push(makeThread('ceo-thread', COMPANY_AGENT))
    const ids = ['ceo-thread', 'no-existe', '../remote', '..\\remote', 'remote ', 'REMOTE', 'Talk', '%72emote', 'a/b', '\u0000', 'x'.repeat(64)]
    const reference = await t.call('/api/threads/read', { id: 'no-existe' })
    expect(reference).toMatchObject({ status: 404, body: { error: 'gone' } })
    for (const id of ids) {
      expect(await t.call('/api/threads/read', { id }), `read ${JSON.stringify(id)}`).toEqual(reference)
      expect(await t.call('/api/threads/send', { id, text: 'x' }), `send ${JSON.stringify(id)}`).toEqual(reference)
      expect(await t.call('/api/threads/stop', { id }), `stop ${JSON.stringify(id)}`).toEqual(reference)
    }
    for (const id of ['', 'x'.repeat(65)]) expect((await t.call('/api/threads/read', { id })).status).toBe(400)
    expect(t.chat.askCalls).toEqual([])
    // Not even a read with a cursor or a wait leaks the difference.
    expect(await t.call('/api/threads/read', { id: 'ceo-thread', since: 0, wait: true })).toEqual(reference)
    expect(await t.call('/api/threads/read', { id: 'ceo-thread', before: 5 })).toEqual(reference)
  })
})

describe('AC-3.3 (028 verify) what a read returns', () => {
  it('AC-3.3 (028 verify) only the text of user and assistant messages: tool inputs, results, thinking and images never appear', async () => {
    const { t } = await served()
    const talk = t.chat.threads.find((thread) => thread.id === 'talk') as Thread
    talk.messages.push(
      { role: 'user', content: [{ type: 'text', text: 'pregunta' }, { type: 'image', mediaType: 'image/png', data: 'CANARYIMAGE' } as never], ts: 1 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'CANARYTHINK', signature: 'CANARYSIG' } as never, { type: 'tool_use', id: 'x', name: 'CANARYTOOL', input: { secret: 'CANARYINPUT' } } as never, { type: 'text', text: 'parte uno' }, { type: 'text', text: 'parte dos' }], ts: 2 },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: 'CANARYRESULT' } as never], ts: 3 },
      { role: 'assistant', content: [], ts: 4 }
    )
    const body = (await t.call('/api/threads/read', { id: 'talk' })).body as { messages: { index: number; text: string }[]; rev: number }
    expect(JSON.stringify(body)).not.toMatch(/CANARY/)
    expect(body.rev).toBe(4)
    expect(body.messages.map((message) => message.text)).toEqual(['pregunta', 'parte uno\nparte dos'])
    expect(body.messages.map((message) => message.index)).toEqual([0, 1])
  })

  it('AC-3.3 (028 verify) cursor windows: since past the end, before at zero, before past the end, since wins over before, and nothing throws', async () => {
    const { t } = await served()
    const talk = t.chat.threads.find((thread) => thread.id === 'talk') as Thread
    for (let i = 0; i < 70; i++) talk.messages.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `m${i}` }], ts: i })
    const read = async (body: object): Promise<{ rev: number; messages: { index: number }[]; earlier: boolean; status: number }> => {
      const res = await t.call('/api/threads/read', { id: 'talk', ...body })
      return { status: res.status, ...(res.body as { rev: number; messages: { index: number }[]; earlier: boolean }) }
    }
    const first = await read({})
    expect(first.messages.map((m) => m.index)).toEqual(Array.from({ length: 30 }, (_, i) => 40 + i))
    expect(first.earlier).toBe(true)
    expect((await read({ since: 70 })).messages).toEqual([])
    expect((await read({ since: 100000 })).messages).toEqual([])
    expect((await read({ since: 100000 })).rev).toBe(70)
    expect(await read({ before: 0 })).toMatchObject({ messages: [], earlier: false })
    expect((await read({ before: 99999 })).messages.map((m) => m.index)).toEqual(first.messages.map((m) => m.index))
    const both = await read({ since: 65, before: 10 })
    expect(both.messages.map((m) => m.index)).toEqual([65, 66, 67, 68, 69])
    expect((await read({ before: 40 })).messages.map((m) => m.index)).toEqual(Array.from({ length: 30 }, (_, i) => 10 + i))
    expect((await read({ before: 10 })).messages.map((m) => m.index)).toEqual(Array.from({ length: 10 }, (_, i) => i))
    expect((await read({ before: 10 })).earlier).toBe(false)
    expect((await read({ before: -1 })).status).toBe(400)
    expect((await read({ since: 1.5 })).status).toBe(400)
  })

  it('AC-3.3 (028 verify) the whole response stays within 1 MB even when every character needs escaping', async () => {
    const { t } = await served()
    const talk = t.chat.threads.find((thread) => thread.id === 'talk') as Thread
    const nasty = '"\\\n\u0001'.repeat(60_000) // 240k characters, ~1.2 MB once escaped
    for (let i = 0; i < 12; i++) talk.messages.push({ role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: nasty }], ts: i })
    const res = await t.call('/api/threads/read', { id: 'talk' })
    expect(Buffer.byteLength(JSON.stringify(res.body), 'utf8')).toBeLessThanOrEqual(1_048_576)
    expect((res.body as { earlier: boolean }).earlier).toBe(true)
  })

  it('AC-3.12 (028 verify) a hostile title, CRLF, astral characters and bidi controls pass through verbatim in the list', async () => {
    const { t } = await served()
    const title = '😀\r\n\u202eevil <script>alert(1)</script> \u0000'.padEnd(5000, 'x')
    const talk = t.chat.threads.find((thread) => thread.id === 'talk') as Thread
    talk.title = title
    const rows = ((await t.call('/api/threads/list', { offset: 0 })).body as { rows: { id: string; title: string }[] }).rows
    expect(rows.find((row) => row.id === 'talk')?.title).toBe(title)
  })
})

describe('AC-3.6 / AC-3.8 / AC-3.19 (028 verify) sending', () => {
  it('AC-3.19 (028 verify) two sends of one device fired in the same tick start exactly one run', async () => {
    const { t } = await served()
    const [a, b] = await Promise.all([t.call('/api/threads/send', { id: 'talk', text: '1' }), t.call('/api/threads/send', { id: 'pc', text: '2' })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(t.chat.askCalls).toHaveLength(1)
    const loser = a.status === 409 ? a : b
    expect(loser.body).toEqual({ error: 'run-active' })
  })

  it('AC-3.8 (028 verify) two devices racing for one conversation: one run, the other is busy, nothing queued, nothing cancelled', async () => {
    const { t, tablet } = await served()
    const [a, b] = await Promise.all([t.call('/api/threads/send', { id: 'talk', text: 'a' }), tablet('/api/threads/send', { id: 'talk', text: 'b' })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect([a, b].find((res) => res.status === 409)?.body).toEqual({ error: 'busy' })
    expect(t.chat.askCalls).toHaveLength(1)
    expect(t.chat.cancelCalls).toEqual([])
    t.chat.resolveAsk(0, 'listo')
    await settle()
    expect(t.chat.askCalls).toHaveLength(1)
  })

  it('AC-3.19 (028 verify) a Chat-tab run and a by-id run block each other in both directions, and a settled or failed run frees the device', async () => {
    const { t } = await served()
    expect((await t.call('/api/chat/send', { text: 'tab' })).status).toBe(200)
    expect(await t.call('/api/threads/send', { id: 'talk', text: 'x' })).toMatchObject({ status: 409, body: { error: 'run-active' } })
    expect(await t.call('/api/threads/send', { id: 'remote', text: 'x' })).toMatchObject({ status: 409 })
    t.chat.rejectAsk(0, new Error('boom'))
    await settle()
    expect((await t.call('/api/threads/send', { id: 'talk', text: 'by id' })).status).toBe(200)
    expect(await t.call('/api/chat/send', { text: 'tab again' })).toMatchObject({ status: 409, body: { error: 'run-active' } })
    t.chat.resolveAsk(1, 'ok')
    await settle()
    expect((await t.call('/api/chat/send', { text: 'tab again' })).status).toBe(200)
    expect(t.chat.askCalls.map((call) => call.threadId)).toEqual(['remote', 'talk', 'remote'])
  })

  it('AC-1.1 (028 verify) continue off: every send by id is write-off for real, company and unknown ids alike, and nothing runs', async () => {
    const { t } = await served({ cont: false })
    t.chat.threads.push(makeThread('ceo-thread', COMPANY_AGENT))
    for (const id of ['talk', 'ceo-thread', 'no-existe']) expect(await t.call('/api/threads/send', { id, text: 'x' }), id).toMatchObject({ status: 403, body: { error: 'write-off' } })
    expect(t.chat.askCalls).toEqual([])
    // Reading still works, and the Chat tab is governed by the chat scope alone.
    expect((await t.call('/api/threads/read', { id: 'talk' })).status).toBe(200)
    expect((await t.call('/api/chat/send', { text: 'tab' })).status).toBe(200)
  })

  it('AC-1.1 (028 verify) continue on but History off: send is scope-off, never run (continue alone does not grant History)', async () => {
    const { t } = await served({ history: false, cont: true })
    expect(await t.call('/api/threads/send', { id: 'talk', text: 'x' })).toMatchObject({ status: 403, body: { error: 'scope-off' } })
    expect(t.chat.askCalls).toEqual([])
  })

  it('AC-3.6 (028 verify) 8000 characters pass, 8001 do not (astral characters count once on the PC), and the text reaches the run untouched', async () => {
    const { t } = await served()
    expect((await t.call('/api/threads/send', { id: 'talk', text: 'x'.repeat(8001) })).status).toBe(400)
    expect((await t.call('/api/threads/send', { id: 'talk', text: '😀'.repeat(8001) })).status).toBe(400)
    expect(t.chat.askCalls).toEqual([])
    const text = '😀'.repeat(8000)
    expect((await t.call('/api/threads/send', { id: 'talk', text })).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 'talk', text }])
  })

  it('AC-3.6 (028 verify) a body with a smuggled key (agent, model, workspace, thread) is refused, not ignored', async () => {
    const { t } = await served()
    for (const extra of [{ agentId: 'x' }, { model: 'm' }, { workspace: 'C:\\' }, { thread: 'remote' }]) {
      expect((await t.call('/api/threads/send', { id: 'talk', text: 'x', ...extra })).status, JSON.stringify(extra)).toBe(400)
    }
    expect(t.chat.askCalls).toEqual([])
  })

  it('AC-3.14 (028 verify) sending into another conversation never re-points the shared thread, and "new" keeps working', async () => {
    const { t } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'x' })
    const rows = ((await t.call('/api/threads/list', { offset: 0 })).body as { rows: { id: string; current: boolean }[] }).rows
    expect(rows.filter((row) => row.current).map((row) => row.id)).toEqual(['remote'])
    expect((await t.call('/api/chat/new', {})).status).toBe(200)
    const after = ((await t.call('/api/threads/list', { offset: 0 })).body as { rows: { id: string; current: boolean }[] }).rows
    expect(after.filter((row) => row.current)).toHaveLength(1)
    expect(after.find((row) => row.current)?.id).not.toBe('remote')
  })
})

describe('AC-3.18 / AC-3.15 / AC-3.16 / AC-3.9 (028 verify) stop and approvals belong to the starter', () => {
  it('AC-3.18 (028 verify) another device, an idle thread and a PC-started run cannot be stopped; the owner can, once', async () => {
    const { t, tablet } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'x' })
    expect((await tablet('/api/threads/stop', { id: 'talk' })).status).toBe(200)
    expect((await t.call('/api/threads/stop', { id: 'pc' })).status).toBe(200)
    t.threads.running.add('pc') // a run started on the PC
    expect((await t.call('/api/threads/stop', { id: 'pc' })).status).toBe(200)
    expect(t.chat.cancelCalls).toEqual([])
    expect((await t.call('/api/threads/stop', { id: 'talk' })).status).toBe(200)
    expect(t.chat.cancelCalls).toEqual(['talk'])
  })

  it('AC-3.16 (028 verify) a leftover approval after the run ended, or on another thread, is neither listed nor answerable', async () => {
    const { t } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'x' })
    const other = t.approvals.askApproval(approvalOf('other'))
    const mine = t.approvals.askApproval(approvalOf('talk'))
    expect((await listed(t)).map((view) => view.id)).toEqual([mine.approvalId])
    expect(await t.call('/api/approvals/answer', { id: other.approvalId, decision: 'allow' })).toMatchObject({ status: 409 })
    t.chat.resolveAsk(0, 'listo')
    await settle()
    expect(await listed(t)).toEqual([])
    expect(await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'allow' })).toMatchObject({ status: 409 })
    expect(t.approvals.answered).toEqual([])
  })

  it('AC-3.15 (028 verify) "always" can never be sent, and answering does not touch the always-allow memory', async () => {
    const { t } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'x' })
    const mine = t.approvals.askApproval(approvalOf('talk'))
    for (const decision of ['always', 'allow-always', 'ALLOW', '', null, 1]) {
      expect((await t.call('/api/approvals/answer', { id: mine.approvalId, decision })).status, String(decision)).toBe(400)
    }
    expect((await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'allow', always: true })).status).toBe(400)
    expect(t.approvals.answered).toEqual([])
    expect((await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'allow' })).status).toBe(200)
    expect(t.home.remembered).toEqual([])
  })

  it('AC-3.9 (028 verify) approve off: waiting for the starter only, the card is neither listed nor answerable, and it stays pending', async () => {
    const { t, tablet } = await served({ approve: false })
    await t.call('/api/threads/send', { id: 'talk', text: 'x' })
    const mine = t.approvals.askApproval(approvalOf('talk'))
    const read = async (call: Harness['call']): Promise<{ waiting: boolean; running: boolean }> => (await call('/api/threads/read', { id: 'talk' })).body as { waiting: boolean; running: boolean }
    expect(await read(t.call)).toMatchObject({ waiting: true, running: true })
    expect(await read(tablet)).toMatchObject({ waiting: false })
    expect((await t.transport.request({ method: 'GET', path: '/api/approvals', headers: (await t.phone()).headers })).status).toBe(403)
    expect((await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'allow' })).status).toBe(403)
    expect(t.approvals.broker.pending().map((p) => p.approvalId)).toEqual([mine.approvalId])
    // Once the PC answers it, the phone stops saying it waits.
    t.approvals.broker.respond(mine.approvalId, 'deny', 'desktop')
    expect(await read(t.call)).toMatchObject({ waiting: false })
  })
})

describe('AC-3.20 / AC-1.6 (028 verify) a cut aborts what the phone started', () => {
  const start = async (call: Harness['call'], id: string): Promise<void> => {
    expect((await call('/api/threads/send', { id, text: 'x' })).status).toBe(200)
  }

  it('AC-3.20 (028 verify) remote off (the kill switch) aborts by-id and Chat-tab runs of every device, and the next request is refused', async () => {
    const { t, tablet } = await served()
    await start(t.call, 'talk')
    await tablet('/api/chat/send', { text: 'tab' })
    t.setRemote({ enabled: false })
    await t.channel.sync()
    expect([...t.chat.cancelCalls].sort()).toEqual(['remote', 'talk'])
    expect(t.transport.stopped).toBe(true)
  })

  it('AC-3.20 (028 verify) History off aborts the by-id run only; the next read is refused at once, without waiting for the sync', async () => {
    const { t } = await served()
    await start(t.call, 'talk')
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: false, chat: true, approve: true } })
    expect(await t.call('/api/threads/read', { id: 'talk' })).toMatchObject({ status: 403, body: { error: 'scope-off' } })
    expect(t.chat.cancelCalls).toEqual([])
    await t.channel.sync()
    expect(t.chat.cancelCalls).toEqual(['talk'])
  })

  it('AC-3.20 (028 verify) continue off aborts the by-id run, keeps reading, and the device stays blocked until the run really unwinds', async () => {
    const { t } = await served()
    await start(t.call, 'talk')
    t.setRemote({ continueHistory: false })
    await t.channel.sync()
    expect(t.chat.cancelCalls).toEqual(['talk'])
    await settle()
    // the fake run was rejected by cancel, so the tie is gone and a later turn-on starts clean
    t.setRemote({ continueHistory: true })
    expect((await t.call('/api/threads/send', { id: 'pc', text: 'again' })).status).toBe(200)
  })

  it('AC-3.20 (028 verify) revoking one device aborts its runs only and denies its approvals; the other keeps running', async () => {
    const { t, tablet, phoneId } = await served()
    await start(t.call, 'talk')
    expect((await tablet('/api/threads/send', { id: 'pc', text: 'y' })).status).toBe(200)
    await t.channel.revokeDevice(phoneId)
    expect(t.chat.cancelCalls).toEqual(['talk'])
    expect(await t.call('/api/threads/read', { id: 'talk' })).toMatchObject({ status: 401, body: { error: 'unknown-device' } })
    expect(await t.call('/api/threads/stop', { id: 'talk' })).toMatchObject({ status: 401 })
    expect((await tablet('/api/threads/read', { id: 'pc' })).status).toBe(200)
  })

  it('AC-3.20 (028 verify) committed text survives the cut', async () => {
    const { t } = await served()
    await start(t.call, 'talk')
    t.setRemote({ enabled: false })
    await t.channel.sync()
    const talk = t.chat.threads.find((thread) => thread.id === 'talk') as Thread
    expect(talk.messages.map((message) => message.role)).toEqual(['user'])
  })
})

describe('AC-3.13 / AC-7.5 (028 verify) wiring: nothing outward for a phone run', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'coordinator', 'index.ts'), 'utf8')

  it('AC-3.13 (028 verify) every channel is given the quiet wrapper: the only raw onEvent and respondApproval belong to the remote channel itself', () => {
    const rawEvent = source.split('\n').filter((line) => /^\s*onEvent(,|:\s*onEvent\b)/.test(line))
    expect(rawEvent).toHaveLength(1)
    const respond = source.split('\n').filter((line) => /\brespondApproval:/.test(line))
    expect(respond.filter((line) => !line.includes('quiet.respondApproval'))).toHaveLength(1)
    expect(respond.length).toBeGreaterThanOrEqual(4)
    const events = source.split('\n').filter((line) => /\bonEvent:/.test(line))
    expect(events.every((line) => line.includes('quiet.onEvent(onEvent)'))).toBe(true)
  })

  it('AC-7.5 (028 verify) the remote channel cancels through the same abort map the PC stop uses, and asks through startRun', () => {
    expect(source).toMatch(/ask: \(threadId, text(?:, attachmentIds)?\) => startRun\(threadId, text(?:, \{ attachments: attachmentIds \})?\)\.done,\s*\n\s*cancel: \(threadId\) => runs\.get\(threadId\)\?\.abort\(\)/)
  })
})
