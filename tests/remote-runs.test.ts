import { describe, expect, it, vi } from 'vitest'
import { ChatFlow } from '../src/coordinator/channels/remote/chat'
import { quietForPhoneRuns } from '../src/coordinator/channels/remote/quiet'
import { RunTies } from '../src/coordinator/channels/remote/runs'
import { ThreadsFlow } from '../src/coordinator/channels/remote/threads'
import { defaultSettings } from '../src/shared/defaults'
import type { ApprovalMode, LiveEvent } from '../src/shared/types'
import { defaultRemote } from '../src/shared/remote/settings'
import { readSources } from './support/arch'
import { COMPANY_AGENT, HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

/** Distinct bytes on every call, so two paired devices never share a session token. */
function varying(): (length: number) => Uint8Array {
  let n = 0
  return (length) => new Uint8Array(length).fill(++n % 256)
}

async function otherPhone(t: Harness): Promise<(path: string, body?: unknown) => ReturnType<Harness['call']>> {
  const { deviceId, privateKey } = await pairDevice(t, 'tablet')
  const token = await openSession(t, deviceId, privateKey)
  return (path, body) => t.transport.request({ method: 'POST', path, headers: { ...HOST, authorization: `Bearer ${token}` }, body })
}

describe('run ties (spec 028 T25)', () => {
  it('AC-3.19 (028) a second start for the same device is run-active, another device is not blocked', () => {
    const ties = new RunTies()
    expect(ties.start('d1', 'a')).toEqual({ ok: true })
    expect(ties.start('d1', 'b')).toEqual({ error: 'run-active' })
    expect(ties.start('d2', 'b')).toEqual({ ok: true })
    expect(ties.activeFor('d1')).toBe('a')
    expect(ties.ownerOf('b')).toBe('d2')
    expect(ties.ownerOf('nope')).toBeNull()
    expect(ties.activeFor('nope')).toBeNull()
  })

  it('AC-3.19 (028) ending the run frees the device', () => {
    const ties = new RunTies()
    ties.start('d1', 'a')
    ties.end('d1', 'a')
    expect(ties.activeFor('d1')).toBeNull()
    expect(ties.start('d1', 'b')).toEqual({ ok: true })
  })

  it('AC-3.20 (028) abortWhere cancels exactly the matching ties and returns the count', () => {
    const ties = new RunTies()
    ties.start('d1', 'shared', true)
    ties.start('d2', 'x')
    ties.start('d3', 'y')
    const cancelled: string[] = []
    const count = ties.abortWhere((tie) => !tie.shared && tie.deviceId !== 'd3', (threadId) => cancelled.push(threadId))
    expect(count).toBe(1)
    expect(cancelled).toEqual(['x'])
    expect(ties.abortWhere(() => false, () => cancelled.push('never'))).toBe(0)
    expect(cancelled).toEqual(['x'])
  })

  it('AC-3.20 (028) end is idempotent and only ends the tie it names', () => {
    const ties = new RunTies()
    ties.start('d1', 'a')
    ties.end('d1', 'other')
    expect(ties.activeFor('d1')).toBe('a')
    ties.end('d1', 'a')
    ties.end('d1', 'a')
    ties.end('ghost', 'a')
    expect(ties.activeFor('d1')).toBeNull()
  })
})

describe('Chat tab and run ties (spec 028 T31)', () => {
  function chatFlow(ties: RunTies, options: { throwSync?: boolean } = {}): { chat: ChatFlow; asks: { resolve(): void; reject(): void }[]; calls: string[] } {
    const thread = makeThread('remote')
    const asks: { resolve(): void; reject(): void }[] = []
    const calls: string[] = []
    const chat = new ChatFlow({
      conversation: () => thread,
      ask: (threadId, text) => {
        calls.push(`${threadId}:${text}`)
        if (options.throwSync) throw new Error('ask failed')
        return new Promise<void>((resolve, reject) => asks.push({ resolve, reject: () => reject(new Error('boom')) }))
      },
      cancel: () => {},
      approvals: () => [],
      waiting: () => false,
      ties
    })
    return { chat, asks, calls }
  }
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  it('AC-3.19 (028) a Chat-tab run is tied to its device until it settles, ok or failed', async () => {
    const ties = new RunTies()
    const { chat, asks } = chatFlow(ties)
    expect(chat.send('d1', 'hola')).toEqual({ ok: true })
    expect(ties.activeFor('d1')).toBe('remote')
    expect(ties.ownerOf('remote')).toBe('d1')
    asks[0]?.resolve()
    await tick()
    expect(ties.activeFor('d1')).toBeNull()
    chat.send('d1', 'otra')
    asks[1]?.reject()
    await tick()
    expect(ties.activeFor('d1')).toBeNull()
  })

  it('AC-3.19 (028) a device with a run elsewhere is run-active in the Chat tab and nothing runs', () => {
    const ties = new RunTies()
    ties.start('d1', 'some-other-thread')
    const { chat, calls } = chatFlow(ties)
    expect(chat.send('d1', 'hola')).toEqual({ error: 'run-active' })
    expect(calls).toEqual([])
  })

  it('AC-3.19 (028) the Chat tab keeps its 026 answers: busy while its own run goes, failed when the start throws', () => {
    const ties = new RunTies()
    const running = chatFlow(ties)
    running.chat.send('d1', 'uno')
    expect(running.chat.send('d2', 'dos')).toEqual({ error: 'busy' })
    expect(running.chat.send('d1', 'tres')).toEqual({ error: 'busy' })
    const failing = chatFlow(new RunTies(), { throwSync: true })
    expect(failing.chat.send('d1', 'x')).toEqual({ error: 'failed' })
    const freed = new RunTies()
    const again = chatFlow(freed, { throwSync: true })
    again.chat.send('d1', 'x')
    expect(freed.activeFor('d1')).toBeNull()
  })
})

describe('waiting for an approval the phone may not answer (spec 028 T28)', () => {
  const pendingApproval = (threadId: string): Parameters<Harness['approvals']['askApproval']>[0] => ({
    threadId,
    toolUseId: 'tu1',
    toolName: 'run_command',
    input: { command: 'ls' },
    flagged: false,
    allowAlways: true
  })

  async function served(approve: boolean): Promise<Harness> {
    const scopes = { ...defaultRemote().scopes, history: true, chat: true, approve }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true } })
    await t.channel.sync()
    t.chat.threads.push(makeThread('talk'))
    return t
  }
  const waiting = async (t: Harness, id: string): Promise<unknown> => ((await t.call('/api/threads/read', { id })).body as { waiting: boolean }).waiting

  it('AC-3.9 (028) approve off shows waiting for the run this device started, and the approval stays pending for the broker', async () => {
    const t = await served(false)
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    expect(await waiting(t, 'talk')).toBe(false)
    t.approvals.askApproval(pendingApproval('talk'))
    expect(await waiting(t, 'talk')).toBe(true)
    expect(t.approvals.broker.pending()).toHaveLength(1)
    expect(t.approvals.answered).toEqual([])
    expect((await t.transport.request({ method: 'GET', path: '/api/approvals', headers: (await t.phone()).headers })).status).toBe(403)
  })

  it('AC-3.9 (028) approve on never shows waiting: the phone answers instead', async () => {
    const t = await served(true)
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    t.approvals.askApproval(pendingApproval('talk'))
    expect(await waiting(t, 'talk')).toBe(false)
  })

  it('AC-3.9 (028) a run the device did not start is never waiting for it, nor is a thread with nothing pending', async () => {
    const t = await served(false)
    t.approvals.askApproval(pendingApproval('talk'))
    expect(await waiting(t, 'talk')).toBe(false)
    t.chat.threads.push(makeThread('quiet'))
    await t.call('/api/threads/send', { id: 'quiet', text: 'hola' })
    expect(await waiting(t, 'quiet')).toBe(false)
  })

  it('AC-3.9 (028) the shared thread run waits too when approve is off (decision Q2)', async () => {
    const t = await served(false)
    await t.call('/api/chat/send', { text: 'hola' })
    t.approvals.askApproval(pendingApproval('remote'))
    expect(await waiting(t, 'remote')).toBe(true)
  })
})

describe('stopping a run the phone started (spec 028 T29)', () => {
  async function served(): Promise<Harness> {
    const scopes = { ...defaultRemote().scopes, history: true, chat: true }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true }, random: varying() })
    await t.channel.sync()
    t.chat.threads.push(makeThread('talk'))
    return t
  }

  it('AC-3.18 (028) stop aborts the run through cancel and denies its approvals', async () => {
    const t = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    expect(await t.call('/api/threads/stop', { id: 'talk' })).toMatchObject({ status: 200, body: { ok: true } })
    expect(t.chat.cancelCalls).toEqual(['talk'])
    expect(t.chat.approvals.every((approval) => approval.denied)).toBe(true)
    await t.chat.pending[0]?.promise.catch(() => undefined)
    const read = (await t.call('/api/threads/read', { id: 'talk' })).body as { running: boolean }
    expect(read.running).toBe(false)
  })

  it('AC-3.18 (028) stop of a run the device did not start changes nothing', async () => {
    const t = await served()
    const tablet = await otherPhone(t)
    await tablet('/api/threads/send', { id: 'talk', text: 'de la tablet' })
    t.chat.threads.push(makeThread('pc'))
    t.threads.running.add('pc')
    expect(await t.call('/api/threads/stop', { id: 'talk' })).toMatchObject({ status: 200 })
    expect(await t.call('/api/threads/stop', { id: 'pc' })).toMatchObject({ status: 200 })
    expect(await t.call('/api/threads/stop', { id: 'quiet' })).toMatchObject({ status: 404, body: { error: 'gone' } })
    expect(t.chat.cancelCalls).toEqual([])
    expect(t.chat.approvals.some((approval) => approval.denied)).toBe(false)
    expect(t.threads.isRunning('talk')).toBe(true)
  })

  it('AC-3.18 (028) a run the device started in the shared thread through the Chat tab is stopped by id too', async () => {
    const t = await served()
    await t.call('/api/chat/send', { text: 'hola' })
    await t.call('/api/threads/stop', { id: 'remote' })
    expect(t.chat.cancelCalls).toEqual(['remote'])
  })

  it('AC-3.18 (028) the window says whether the running run is this device\'s own, so a reopened conversation can show stop', async () => {
    const t = await served()
    const tablet = await otherPhone(t)
    const own = async (call: typeof t.call, id: string): Promise<unknown> => ((await call('/api/threads/read', { id })).body as { ownRun: boolean }).ownRun
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    expect(await own(t.call, 'talk')).toBe(true)
    expect(await own(tablet, 'talk')).toBe(false)
    t.chat.threads.push(makeThread('pc'))
    t.threads.running.add('pc')
    expect(await own(t.call, 'pc')).toBe(false)
    t.chat.threads.push(makeThread('idle'))
    expect(await own(t.call, 'idle')).toBe(false)
  })

  it('AC-3.7 (028) a company id cannot be stopped and answers like an unknown one', async () => {
    const t = await served()
    t.chat.threads.push(makeThread('c1', COMPANY_AGENT))
    expect(JSON.stringify(await t.call('/api/threads/stop', { id: 'c1' }))).toBe(JSON.stringify(await t.call('/api/threads/stop', { id: 'nope' })))
    expect(t.chat.cancelCalls).toEqual([])
  })
})

describe('approvals and pushes of the runs a phone started (spec 028 T32, T33)', () => {
  const approvalOf = (threadId: string, overrides: Record<string, unknown> = {}): Parameters<Harness['approvals']['askApproval']>[0] => ({
    threadId,
    toolUseId: 'tu1',
    toolName: 'run_command',
    input: { command: 'ls' },
    flagged: false,
    allowAlways: true,
    ...overrides
  })
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }

  async function served(approve = true): Promise<{
    t: Harness
    phone: Record<string, string>
    tablet: Record<string, string>
    tabletPost(path: string, body?: unknown): ReturnType<Harness['call']>
  }> {
    const scopes = { ...defaultRemote().scopes, history: true, chat: true, approve }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true }, random: varying() })
    await t.channel.sync()
    t.chat.threads.push(makeThread('talk'), makeThread('pc'))
    const phone = (await t.phone()).headers
    const paired = await pairDevice(t, 'tablet')
    const tablet = { ...HOST, authorization: `Bearer ${await openSession(t, paired.deviceId, paired.privateKey)}` }
    return { t, phone, tablet, tabletPost: (path, body) => t.transport.request({ method: 'POST', path, headers: tablet, body }) }
  }
  const listed = async (t: Harness, headers: Record<string, string>): Promise<{ id: string; input: string; thread?: string }[]> =>
    ((await t.transport.request({ method: 'GET', path: '/api/approvals', headers })).body as { approvals: { id: string; input: string; thread?: string }[] }).approvals

  it('AC-3.15 (028) a device sees and answers the approvals of its own by-id run, marked with the conversation', async () => {
    const { t, phone } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    const mine = t.approvals.askApproval(approvalOf('talk'))
    expect(await listed(t, phone)).toEqual([expect.objectContaining({ id: mine.approvalId, thread: 'talk' })])
    expect(await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'allow' })).toMatchObject({ status: 200 })
    await expect(mine.decision).resolves.toBe('allow')
    expect(await listed(t, phone)).toEqual([])
  })

  it('AC-3.15 (028) each answer is valid once, "always" does not exist and the input is cut at 1500', async () => {
    const { t, phone } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    const mine = t.approvals.askApproval(approvalOf('talk', { input: { command: 'x'.repeat(3000) } }))
    expect((await listed(t, phone))[0]?.input.length).toBe(1501)
    expect(await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'always' })).toMatchObject({ status: 400 })
    expect(t.approvals.answered).toEqual([])
    expect(await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'deny' })).toMatchObject({ status: 200 })
    expect(await t.call('/api/approvals/answer', { id: mine.approvalId, decision: 'allow' })).toMatchObject({ status: 409, body: { error: 'already-answered' } })
    expect(t.approvals.answered).toEqual([{ approvalId: mine.approvalId, decision: 'deny' }])
    await expect(mine.decision).resolves.toBe('deny')
  })

  it('AC-3.16 (028) PC-started, unowned and other-phone runs are invisible and answer already-answered', async () => {
    const { t, phone, tabletPost } = await served()
    await tabletPost('/api/threads/send', { id: 'talk', text: 'de la tablet' })
    const theirs = t.approvals.askApproval(approvalOf('talk'))
    const pc = t.approvals.askApproval(approvalOf('pc'))
    expect(await listed(t, phone)).toEqual([])
    for (const asked of [theirs, pc]) {
      expect(await t.call('/api/approvals/answer', { id: asked.approvalId, decision: 'allow' })).toMatchObject({ status: 409, body: { error: 'already-answered' } })
    }
    expect(t.approvals.answered).toEqual([])
    expect(t.approvals.broker.pending()).toHaveLength(2)
  })

  it('AC-3.16 (028) in the shared thread every device keeps the 026 rule', async () => {
    const { t, phone, tabletPost } = await served()
    await tabletPost('/api/chat/send', { text: 'de la tablet' })
    const shared = t.approvals.askApproval(approvalOf('remote'))
    const [view] = await listed(t, phone)
    expect(view).toMatchObject({ id: shared.approvalId })
    expect(view).not.toHaveProperty('thread')
    expect(await t.call('/api/approvals/answer', { id: shared.approvalId, decision: 'allow' })).toMatchObject({ status: 200 })
  })

  it('AC-3.15 (028) /api/state carries the device\'s own approvals and a held poll wakes only the owner', async () => {
    const { t, phone, tablet } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    const poll = (headers: Record<string, string>): ReturnType<Harness['call']> => t.transport.request({ method: 'GET', path: '/api/state', query: 'since=0', headers })
    const mine = poll(phone)
    const theirs = poll(tablet)
    await drain()
    const woke: string[] = []
    void mine.then(() => woke.push('phone'))
    void theirs.then(() => woke.push('tablet'))
    const asked = t.approvals.askApproval(approvalOf('talk'))
    await drain()
    expect(woke).toEqual(['phone'])
    expect(((await mine).body as { approvals: { id: string }[] }).approvals.map((view) => view.id)).toEqual([asked.approvalId])
    await t.channel.stop()
    expect(((await theirs).body as { approvals: unknown[] }).approvals).toEqual([])
  })

  it('AC-3.9 (028) /api/state says waiting while approve is off and the run is stuck on an approval', async () => {
    const { t, phone } = await served(false)
    await t.call('/api/chat/send', { text: 'hola' })
    t.approvals.askApproval(approvalOf('remote'))
    const state = (await t.transport.request({ method: 'GET', path: '/api/state', headers: phone })).body as { waiting: boolean; approvals: unknown[] }
    expect(state.waiting).toBe(true)
    expect(state.approvals).toEqual([])
  })

  const subscription = (id: string): { endpoint: string; keys: { p256dh: string; auth: string } } => ({
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` }
  })
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('AC-4.7 (028) only the owner is pushed for a by-id run, everyone subscribed for the shared thread, nobody for the rest', async () => {
    const { t, tabletPost } = await served()
    await t.call('/api/push/subscribe', subscription('phone'))
    await tabletPost('/api/push/subscribe', subscription('tablet'))
    const sent = (): string[] => t.posts.map((post) => post.url.split('/').pop() ?? '').sort()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    t.approvals.askApproval(approvalOf('talk'))
    await settle()
    expect(sent()).toEqual(['phone'])
    t.approvals.askApproval(approvalOf('pc'))
    await settle()
    expect(sent()).toEqual(['phone'])
    t.approvals.askApproval(approvalOf('remote'))
    await settle()
    expect(sent()).toEqual(['phone', 'phone', 'tablet'])
  })

  it('AC-4.7 (028) nothing is pushed for a by-id run while the approve scope is off', async () => {
    const { t } = await served(false)
    await t.call('/api/push/subscribe', subscription('phone'))
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    t.approvals.askApproval(approvalOf('talk'))
    await settle()
    expect(t.posts).toEqual([])
  })

  it('AC-4.3 (028) the push body is empty and carries no title, tool or conversation', async () => {
    const { t } = await served()
    await t.call('/api/push/subscribe', subscription('phone'))
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    t.approvals.askApproval(approvalOf('talk', { toolName: 'secret_tool', input: { command: 'rm -rf' } }))
    await settle()
    expect(t.posts).toHaveLength(1)
    expect(t.posts[0]?.body.length).toBe(0)
    expect(Object.keys(t.posts[0]?.headers ?? {}).sort()).toEqual(['TTL', 'authorization'])
    const seen = JSON.stringify(t.posts[0]?.headers) + (t.posts[0]?.url ?? '')
    for (const secret of ['secret_tool', 'rm -rf', 'talk', 'hola']) expect(seen).not.toContain(secret)
  })
})

describe('runs are aborted when access is cut (spec 028 T34)', () => {
  async function served(): Promise<{
    t: Harness
    phoneId: string
    tabletId: string
    tabletPost(path: string, body?: unknown): ReturnType<Harness['call']>
  }> {
    const scopes = { ...defaultRemote().scopes, history: true, chat: true, approve: true }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true }, random: varying() })
    await t.channel.sync()
    t.chat.threads.push(makeThread('talk'), makeThread('other'))
    const { deviceId: phoneId } = await t.phone()
    const paired = await pairDevice(t, 'tablet')
    const headers = { ...HOST, authorization: `Bearer ${await openSession(t, paired.deviceId, paired.privateKey)}` }
    return { t, phoneId, tabletId: paired.deviceId, tabletPost: (path, body) => t.transport.request({ method: 'POST', path, headers, body }) }
  }
  /** The phone runs in 'talk' and the tablet in 'other', both by id. */
  async function bothRunning(): Promise<Awaited<ReturnType<typeof served>>> {
    const rig = await served()
    await rig.t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    await rig.tabletPost('/api/threads/send', { id: 'other', text: 'chau' })
    return rig
  }
  const sorted = (t: Harness): string[] => [...t.chat.cancelCalls].sort()

  it('AC-3.20 (028) remote off aborts every phone-started run, shared thread included, and keeps what was committed', async () => {
    const { t, tabletPost } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    await tabletPost('/api/chat/send', { text: 'chau' })
    t.setRemote({ enabled: false })
    await t.channel.sync()
    expect(sorted(t)).toEqual(['remote', 'talk'])
    expect(t.chat.approvals.every((approval) => approval.denied)).toBe(true)
    expect(t.chat.threads.find((thread) => thread.id === 'talk')?.messages).toHaveLength(1)
  })

  it('AC-3.20 (028) a sync that changes nothing aborts nothing', async () => {
    const { t } = await bothRunning()
    await t.channel.sync()
    expect(t.chat.cancelCalls).toEqual([])
  })

  it('AC-3.20 (028) revoking a device aborts only its own runs', async () => {
    const { t, phoneId } = await bothRunning()
    await t.channel.revokeDevice(phoneId)
    expect(t.chat.cancelCalls).toEqual(['talk'])
  })

  it('AC-3.20 (028) revoking the other device aborts the other run', async () => {
    const { t, tabletId } = await bothRunning()
    await t.channel.revokeDevice(tabletId)
    expect(t.chat.cancelCalls).toEqual(['other'])
  })

  it('AC-3.20 (028) forgetting the PC from the phone aborts its runs', async () => {
    const { t } = await bothRunning()
    await t.call('/api/forget')
    expect(t.chat.cancelCalls).toEqual(['talk'])
  })

  it('AC-3.20 (028) the idle sweep aborts the runs of the devices it removes', async () => {
    const { t, tabletPost } = await served()
    await tabletPost('/api/threads/send', { id: 'other', text: 'chau' })
    t.setNow(16 * 24 * 3_600_000)
    await t.channel.sweepDevices()
    expect(t.chat.cancelCalls).toEqual(['other'])
  })

  it('AC-3.20 (028) History off aborts the by-id runs, the shared-thread run survives', async () => {
    const { t, tabletPost } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    await tabletPost('/api/chat/send', { text: 'chau' })
    t.setRemote({ scopes: { ...defaultRemote().scopes, chat: true, approve: true, history: false } })
    await t.channel.sync()
    expect(t.chat.cancelCalls).toEqual(['talk'])
  })

  it('AC-3.20 (028) continue off aborts the by-id runs, the shared-thread run survives', async () => {
    const { t, tabletPost } = await served()
    await t.call('/api/threads/send', { id: 'talk', text: 'hola' })
    await tabletPost('/api/chat/send', { text: 'chau' })
    t.setRemote({ continueHistory: false })
    await t.channel.sync()
    expect(t.chat.cancelCalls).toEqual(['talk'])
  })
})

describe('a run continued from the phone stays quiet in the other channels (spec 028 T35)', () => {
  type Kind = 'telegram' | 'whatsapp' | 'voice'

  /** A stand-in for a channel bound to a thread: it reacts like Telegram, WhatsApp and the voice assistant do (prompt on approval.request, speech on the stream, the answer back through respondApproval). */
  function fakeChannel(t: Harness, threadId: string): { sent: string[]; answer(approvalId: string): void; resolved: string[] } {
    const sent: string[] = []
    const resolved: string[] = []
    const listeners = new Set<(event: LiveEvent) => void>()
    const quiet = quietForPhoneRuns((id) => t.channel.startedByPhone(id), () => t.approvals.broker.pending())
    const onEvent = quiet.onEvent((listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const respond = quiet.respondApproval((approvalId, decision) => {
      resolved.push(approvalId)
      t.approvals.broker.respond(approvalId, decision)
    })
    onEvent((event) => {
      if (event.type === 'approval.request' && event.approval.threadId === threadId) sent.push(`prompt:${event.approval.toolName}`)
      if (event.type === 'stream.text' && event.scope.threadId === threadId) sent.push(`speech:${event.text}`)
    })
    const feed = (event: LiveEvent): void => listeners.forEach((listener) => listener(event))
    const askApproval = t.approvals.askApproval
    t.approvals.askApproval = (input) => {
      const asked = askApproval(input)
      const request = t.approvals.events.find((event) => event.type === 'approval.request' && event.approval.approvalId === asked.approvalId)
      if (request) feed(request)
      return asked
    }
    t.emit = ((original) => (event: LiveEvent) => {
      original(event)
      feed(event)
    })(t.emit)
    return { sent, resolved, answer: (approvalId) => respond(approvalId, 'allow') }
  }

  async function served(thread: string): Promise<Harness> {
    const scopes = { ...defaultRemote().scopes, history: true, chat: true, approve: true }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true } })
    await t.channel.sync()
    t.chat.threads.push(makeThread(thread))
    return t
  }
  const input = (threadId: string): Parameters<Harness['approvals']['askApproval']>[0] => ({
    threadId,
    toolUseId: 'tu1',
    toolName: 'run_command',
    input: { command: 'ls' },
    flagged: false,
    allowAlways: true
  })

  for (const kind of ['telegram', 'whatsapp', 'voice'] as Kind[]) {
    it(`AC-3.13 (028) a run continued from the phone sends nothing to the ${kind} channel, and an answer from there does not resolve it`, async () => {
      const t = await served(kind)
      const channel = fakeChannel(t, kind)
      await t.call('/api/threads/send', { id: kind, text: 'hola' })
      const mine = t.approvals.askApproval(input(kind))
      t.emit({ type: 'stream.text', scope: { threadId: kind }, text: 'secreto' })
      channel.answer(mine.approvalId)
      expect(channel.sent).toEqual([])
      expect(channel.resolved).toEqual([])
      expect(t.approvals.broker.pending().map((pending) => pending.approvalId)).toEqual([mine.approvalId])
      expect(t.posts).toEqual([])
    })

    it(`AC-3.13 (028) a run started in the ${kind} channel itself still prompts there and can be answered there`, async () => {
      const t = await served(kind)
      const channel = fakeChannel(t, kind)
      const theirs = t.approvals.askApproval(input(kind))
      t.emit({ type: 'stream.text', scope: { threadId: kind }, text: 'hola' })
      expect(channel.sent).toEqual(['prompt:run_command', 'speech:hola'])
      channel.answer(theirs.approvalId)
      await expect(theirs.decision).resolves.toBe('allow')
    })
  }
})

describe('a run the phone starts goes through the one run path (spec 028 T40)', () => {
  const REMOTE_DIR = 'src/coordinator/channels/remote'
  const ENTRY = /\bdeps\.(ask|cancel)\(/g
  /** Where the channel calls the run entries it was given, as `file: ask|cancel` per call site. */
  const entryCalls = (files: Record<string, string>): string[] =>
    Object.entries(files).flatMap(([file, source]) => [...source.matchAll(ENTRY)].map((match) => `${file.split('/').at(-1)}: ${match[1]}`))
  const remoteSources = (): Record<string, string> => {
    const all = readSources(process.cwd())
    return Object.fromEntries(Object.entries(all).filter(([file]) => file.startsWith(`${REMOTE_DIR}/`)))
  }

  async function served(mode: ApprovalMode): Promise<Harness> {
    const scopes = { ...defaultRemote().scopes, history: true, chat: true, approve: true }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true } })
    t.setApprovalMode(mode)
    await t.channel.sync()
    t.chat.threads.push(makeThread('talk'))
    return t
  }

  it('AC-3.17 (028) a by-id run uses only deps.ask and the settings approval mode', async () => {
    for (const mode of ['needs-approval', 'auto-review', 'always-allow', 'blocked'] as const) {
      const t = await served(mode)
      expect((await t.call('/api/threads/send', { id: 'talk', text: 'hola' })).status).toBe(200)
      // The run is asked as the PC asks it: the thread and the text, nothing the phone adds, whatever the mode.
      expect(t.chat.askCalls).toEqual([{ threadId: 'talk', text: 'hola' }])
      expect(t.chat.cancelCalls).toEqual([])
    }
    const ask = vi.fn(() => Promise.resolve())
    const flow = new ThreadsFlow({
      threads: { list: () => [], get: (id) => makeThread(id), isRunning: () => false },
      settings: () => defaultSettings(),
      sharedId: () => 'remote',
      ties: new RunTies(),
      waiting: () => false,
      ask,
      cancel: vi.fn(),
      sendShared: () => ({ ok: true })
    })
    expect(flow.send('d1', 'talk', 'hola')).toMatchObject({ status: 200 })
    expect(ask.mock.calls).toEqual([['talk', 'hola']])
  })

  it('AC-7.5 (028) the harness ask and cancel are the only run entries', () => {
    expect(entryCalls(remoteSources()).sort()).toEqual(['chat.ts: ask', 'chat.ts: cancel', 'channel.ts: cancel', 'threads.ts: ask', 'threads.ts: cancel'].sort())
    // No second path: the remote channel knows neither the agent runner nor an approval mode.
    const joined = Object.values(remoteSources()).join('\n')
    expect(joined).not.toMatch(/\b(approvalMode|alwaysAllowTools|runAgent|startRun)\b/)
  })

  it('AC-7.5 (028) a second run path in the remote modules would be seen', () => {
    expect(entryCalls({ 'a/threads.ts': 'deps.ask(a, b)\ndeps.ask(c, d)' })).toEqual(['threads.ts: ask', 'threads.ts: ask'])
  })
})
