import { describe, expect, it } from 'vitest'
import { ApprovalBroker, authorize } from '../src/coordinator/approval'
import { APPROVAL_INPUT_LIMIT, approvalPrompt } from '../src/coordinator/channels/texts'
import { TelegramChannel, type TelegramDeps } from '../src/coordinator/channels/telegram'
import { defaultSettings } from '../src/shared/defaults'
import { translate } from '../src/shared/i18n/messages'
import { approvalsAnswerBody } from '../src/shared/remote/api'
import type { ApprovalView, LiveEvent, PendingApproval, RemoteSettings } from '../src/shared/types'
import type { RemoteResponse } from '../src/shared/remote/api'
import { HOST, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

// Adversarial verification of spec 029 AC-2.3, AC-2.8, AC-2.9, AC-2.12, BR-23 on the broker, Telegram and the phone. Written from spec.md only.

/** An input whose JSON (as the channels cut it) is exactly `total` characters. */
const sized = (total: number): { a: string } => {
  const input = { a: 'x'.repeat(total - 12) }
  expect(JSON.stringify(input, null, 1).length).toBe(total)
  return input
}
const approval = (over: Partial<PendingApproval> = {}): Omit<PendingApproval, 'approvalId'> => ({ threadId: 'tg-thread', toolUseId: 'tu1', toolName: 'create_company', input: { name: 'Acme' }, flagged: false, allowAlways: false, ...over })

describe('AC-2.12 / BR-23 (029 verify) the broker', () => {
  function rig() {
    const events: LiveEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const ask = (over: Partial<PendingApproval> = {}) => {
      const controller = new AbortController()
      const asked = broker.askAnswer(approval(over), controller.signal)
      const id = (events.filter((e) => e.type === 'approval.request').at(-1) as Extract<LiveEvent, { type: 'approval.request' }>).approval.approvalId
      return { asked, id, controller }
    }
    return { broker, ask }
  }

  it.each([['telegram'], ['phone']] as const)('%s cannot allow what it cannot show whole; deny works; the desktop can still allow', async (via) => {
    const { broker, ask } = rig()
    const { asked, id } = ask({ input: sized(APPROVAL_INPUT_LIMIT + 1) })
    broker.respond(id, 'allow', via)
    broker.respond(id, 'always', via)
    expect(broker.pending()).toHaveLength(1)
    broker.respond(id, 'allow', 'desktop')
    await expect(asked).resolves.toEqual({ decision: 'allow', via: 'desktop' })
    expect(broker.pending()).toEqual([])
  })

  it.each([['telegram'], ['phone']] as const)('%s deny of an oversize proposal is never gated', async (via) => {
    const { broker, ask } = rig()
    const { asked, id } = ask({ input: sized(50_000) })
    broker.respond(id, 'deny', via)
    await expect(asked).resolves.toEqual({ decision: 'deny', via })
  })

  it.each([['telegram'], ['phone']] as const)('%s allows a proposal of exactly the limit', async (via) => {
    const { broker, ask } = rig()
    const { asked, id } = ask({ input: sized(APPROVAL_INPUT_LIMIT) })
    broker.respond(id, 'allow', via)
    await expect(asked).resolves.toEqual({ decision: 'allow', via })
  })

  it('edit_company is gated the same way', async () => {
    const { broker, ask } = rig()
    const { asked, id } = ask({ toolName: 'edit_company', input: sized(APPROVAL_INPUT_LIMIT + 1) })
    broker.respond(id, 'allow', 'telegram')
    expect(broker.pending()).toHaveLength(1)
    broker.respond(id, 'deny', 'desktop')
    await expect(asked).resolves.toEqual({ decision: 'deny', via: 'desktop' })
  })

  it('a stopped run settles the pending card as deny whatever the channel', async () => {
    const { broker, ask } = rig()
    const { asked, controller } = ask({ input: sized(5000) })
    controller.abort()
    await expect(asked).resolves.toEqual({ decision: 'deny' })
    expect(broker.pending()).toEqual([])
  })

  it('an answer for a card that is already gone does nothing and does not throw', () => {
    const { broker } = rig()
    expect(() => broker.respond('nope', 'allow', 'telegram')).not.toThrow()
  })

  it('AC-2.3 an "always" tapped on a company card (forged: no such button) is one allow and nothing is remembered', async () => {
    const { broker } = rig()
    const remembered: string[] = []
    const events: LiveEvent[] = []
    const settings = defaultSettings('es')
    const live = new ApprovalBroker((event) => {
      events.push(event)
      if (event.type === 'approval.request') queueMicrotask(() => live.respond(event.approval.approvalId, 'always', 'telegram'))
    })
    const verdict = await authorize({
      settings,
      threadId: 't',
      toolUseId: 'u',
      toolName: 'create_company',
      risk: 'publish',
      input: { name: 'x' },
      workspace: '',
      taskContext: '',
      autoApprove: [],
      signal: new AbortController().signal,
      broker: live,
      setState: () => {},
      rememberAlwaysAllow: (name) => remembered.push(name)
    })
    expect(verdict.allowed).toBe(true)
    expect(remembered).toEqual([])
    expect(broker.pending()).toEqual([])
    const asked = events.find((e) => e.type === 'approval.request') as Extract<LiveEvent, { type: 'approval.request' }>
    expect(asked.approval.allowAlways).toBe(false)
  })
})

describe('AC-2.8 / AC-2.12 (029 verify) Telegram', () => {
  const es = (key: 'tg.allow' | 'tg.deny' | 'tg.always' | 'chan.seeOnDesktop') => translate('es', key)

  function rig(telegram: Partial<{ chatId: number | null; threadId: string | null }> = {}) {
    const sent: { chatId: number; text: string; data: string[] }[] = []
    const settings = { ...defaultSettings('es'), telegram: { enabled: true, allowedUsers: ['@Felix'], agentId: 'general', chatId: 7 as number | null, threadId: 'tg-thread' as string | null, ...telegram } }
    const events: LiveEvent[] = []
    const broker = new ApprovalBroker((event) => events.push(event))
    const answers: string[] = []
    const deps = {
      settings: () => settings,
      patch: () => {},
      respondApproval: (approvalId: string, decision: 'allow' | 'deny' | 'always') => {
        answers.push(`${approvalId}:${decision}`)
        broker.respond(approvalId, decision, 'telegram')
      }
    } as unknown as TelegramDeps
    const channel = new TelegramChannel(deps)
    const inner = channel as unknown as { bot: unknown; onEvent(event: LiveEvent): void; onCallback(ctx: unknown): Promise<void> }
    inner.bot = {
      api: {
        sendMessage: async (chatId: number, text: string, extra?: { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }) => {
          sent.push({ chatId, text, data: (extra?.reply_markup?.inline_keyboard ?? []).flat().map((b) => `${b.text}|${b.callback_data}`) })
          return { message_id: sent.length }
        },
        editMessageText: async () => undefined
      }
    }
    const ask = async (over: Partial<PendingApproval> = {}) => {
      const asked = broker.askAnswer(approval(over), new AbortController().signal)
      const request = events.filter((e): e is Extract<LiveEvent, { type: 'approval.request' }> => e.type === 'approval.request').at(-1)
      if (!request) throw new Error('no approval requested')
      inner.onEvent(request)
      for (let i = 0; i < 5; i++) await Promise.resolve()
      return { asked, id: request.approval.approvalId }
    }
    const press = (data: string, chat: { id: number; type: string } = { id: 7, type: 'private' }, username = 'felix') =>
      inner.onCallback({ callbackQuery: { data }, chat, from: { username }, answerCallbackQuery: async () => undefined })
    return { sent, broker, ask, press, answers }
  }

  it('AC-2.8 the card offers exactly Permitir and Rechazar to the bound chat', async () => {
    const t = rig()
    const { id } = await t.ask()
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0].chatId).toBe(7)
    expect(t.sent[0].data).toEqual([`${es('tg.allow')}|ap:${id}:allow`, `${es('tg.deny')}|ap:${id}:deny`])
    expect(JSON.stringify(t.sent[0].data)).not.toContain(es('tg.always'))
  })

  it('AC-2.8 a tap from another chat, a group with the same id, or a stranger changes nothing', async () => {
    const t = rig()
    const { id } = await t.ask()
    await t.press(`ap:${id}:allow`, { id: 8, type: 'private' })
    await t.press(`ap:${id}:allow`, { id: 7, type: 'group' })
    await t.press(`ap:${id}:allow`, { id: -7, type: 'supergroup' })
    expect(t.answers).toEqual([])
    expect(t.broker.pending()).toHaveLength(1)
  })

  it('AC-2.8 malformed or smuggled callback data answers nothing', async () => {
    const t = rig()
    const { id } = await t.ask()
    for (const data of [`ap:${id}:allow;deny`, `ap:${id}:ALLOW`, `xap:${id}:allow`, `ap::allow`, `ap:${id}:allow\n`, `ap:${id}`, '']) await t.press(data)
    expect(t.answers).toEqual([])
    expect(t.broker.pending()).toHaveLength(1)
  })

  it('AC-2.8 the approvals of any other conversation never reach Telegram, and neither do they when the chat is not bound', async () => {
    const other = rig()
    await other.ask({ threadId: 'desktop-1' })
    await other.ask({ threadId: 'remote' })
    expect(other.sent).toEqual([])
    const unbound = rig({ chatId: null })
    await unbound.ask()
    expect(unbound.sent).toEqual([])
    const noThread = rig({ threadId: null })
    await noThread.ask({ threadId: '' })
    expect(noThread.sent.length).toBeLessThanOrEqual(1)
  })

  it('AC-2.8 a forged Siempre tap on a company card is a single allow and the card is answered once', async () => {
    const t = rig()
    const { asked, id } = await t.ask()
    await t.press(`ap:${id}:always`)
    await expect(asked).resolves.toEqual({ decision: 'always', via: 'telegram' })
    await t.press(`ap:${id}:deny`)
    expect(t.broker.pending()).toEqual([])
  })

  it('AC-2.12 exactly at the limit: Permitir is offered and the whole input is in the text; one more: only Rechazar and no input', async () => {
    const fits = rig()
    await fits.ask({ input: sized(APPROVAL_INPUT_LIMIT) })
    expect(fits.sent[0].data.some((d) => d.includes(':allow'))).toBe(true)
    expect(fits.sent[0].text).toContain(sized(APPROVAL_INPUT_LIMIT).a)
    expect(fits.sent[0].text).not.toContain('…')

    const over = rig()
    const { asked, id } = await over.ask({ input: sized(APPROVAL_INPUT_LIMIT + 1) })
    expect(over.sent[0].data).toEqual([`${es('tg.deny')}|ap:${id}:deny`])
    expect(over.sent[0].text).toContain(es('chan.seeOnDesktop'))
    expect(over.sent[0].text).not.toContain('xxxxxxxxxx')
    await over.press(`ap:${id}:allow`)
    await over.press(`ap:${id}:always`)
    expect(over.broker.pending()).toHaveLength(1)
    over.broker.respond(id, 'allow', 'desktop')
    await expect(asked).resolves.toEqual({ decision: 'allow', via: 'desktop' })
  })

  it('AC-2.12 the same oversize text on a non-company tool keeps the 004 behaviour (cut at 1500 with an ellipsis, Permitir offered)', async () => {
    const t = rig()
    await t.ask({ toolName: 'write_file', input: sized(5000), allowAlways: true })
    expect(t.sent[0].data.some((d) => d.includes(':allow'))).toBe(true)
    expect(t.sent[0].text).toContain('…')
    expect(t.sent[0].text).not.toContain(es('chan.seeOnDesktop'))
  })

  it('AC-2.12 the prompt of an oversize company proposal says to use the desktop for edit_company too, and never prints the cut input', () => {
    for (const toolName of ['create_company', 'edit_company']) {
      const prompt = approvalPrompt('en', { ...approval({ toolName, input: sized(3000) }), approvalId: 'a1' })
      expect(prompt).toContain(translate('en', 'chan.seeOnDesktop'))
      expect(prompt).not.toContain('xxxxxxxxxx')
    }
  })
})

describe('AC-2.9 / AC-2.12 (029 verify) the paired phone', () => {
  type Scopes = RemoteSettings['scopes']
  const ON: Scopes = { chat: true, approve: true, home: false, cameras: false, vault: false, history: false }

  async function served(scopes: Scopes = ON): Promise<{ t: Harness; headers: Record<string, string> }> {
    const t = await testChannel({ remote: { enabled: true, scopes } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    return { t, headers: { ...HOST, authorization: `Bearer ${token}` } }
  }
  const list = (t: Harness, headers: Record<string, string>): Promise<RemoteResponse> => t.transport.request({ method: 'GET', path: '/api/approvals', headers })
  const answer = (t: Harness, headers: Record<string, string>, id: string, decision: string): Promise<RemoteResponse> =>
    t.transport.request({ method: 'POST', path: '/api/approvals/answer', headers: { ...headers, 'content-type': 'application/json' }, body: { id, decision } })
  const views = (res: RemoteResponse): ApprovalView[] => (res.body as { approvals: ApprovalView[] }).approvals

  it('AC-2.9 the phone sees a company card whole only when it fits, and can allow it', async () => {
    const { t, headers } = await served()
    const fits = t.approvals.askApproval(approval({ threadId: 'remote', input: sized(APPROVAL_INPUT_LIMIT) }))
    const [view] = views(await list(t, headers))
    expect(view).toMatchObject({ id: fits.approvalId, tool: 'create_company', whole: true })
    const res = await answer(t, headers, fits.approvalId, 'allow')
    expect(res.status).toBe(200)
    await expect(fits.decision).resolves.toBe('allow')
  })

  it('AC-2.12 an oversize company card is flagged not whole; allow is refused and the card stays pending for the desktop; deny works', async () => {
    const { t, headers } = await served()
    const big = t.approvals.askApproval(approval({ threadId: 'remote', input: sized(APPROVAL_INPUT_LIMIT + 1) }))
    expect(views(await list(t, headers))[0].whole).toBe(false)
    const refused = await answer(t, headers, big.approvalId, 'allow')
    expect(refused.status).not.toBe(200)
    expect(t.approvals.answered).toEqual([])
    expect(t.approvals.broker.pending()).toHaveLength(1)
    t.approvals.broker.respond(big.approvalId, 'allow', 'desktop')
    await expect(big.decision).resolves.toBe('allow')
  })

  it('AC-2.12 deny of an oversize card is accepted from the phone', async () => {
    const { t, headers } = await served()
    const big = t.approvals.askApproval(approval({ threadId: 'remote', input: sized(60_000) }))
    expect((await answer(t, headers, big.approvalId, 'deny')).status).toBe(200)
    await expect(big.decision).resolves.toBe('deny')
  })

  it('AC-2.9 the phone never answers "always": the body is refused and the card stays', async () => {
    expect(approvalsAnswerBody.safeParse({ id: 'a', decision: 'always' }).success).toBe(false)
    const { t, headers } = await served()
    const one = t.approvals.askApproval(approval({ threadId: 'remote' }))
    const res = await answer(t, headers, one.approvalId, 'always')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(t.approvals.answered).toEqual([])
    expect(t.approvals.broker.pending()).toHaveLength(1)
  })

  it('AC-2.9 with the approve scope off the phone sees nothing and cannot answer; the card stays pending', async () => {
    const { t, headers } = await served({ ...ON, approve: false })
    const one = t.approvals.askApproval(approval({ threadId: 'remote' }))
    const listed = await list(t, headers)
    expect(listed.status === 200 ? views(listed) : []).toEqual([])
    const res = await answer(t, headers, one.approvalId, 'allow')
    expect(res.status).not.toBe(200)
    expect(t.approvals.answered).toEqual([])
    expect(t.approvals.broker.pending()).toHaveLength(1)
    t.approvals.broker.respond(one.approvalId, 'deny', 'desktop')
    await expect(one.decision).resolves.toBe('deny')
  })

  it('AC-2.9 turning the approve scope off while a card is pending hides it and refuses the answer', async () => {
    const { t, headers } = await served()
    const one = t.approvals.askApproval(approval({ threadId: 'remote' }))
    expect(views(await list(t, headers))).toHaveLength(1)
    t.setRemote({ scopes: { ...ON, approve: false } })
    const res = await answer(t, headers, one.approvalId, 'allow')
    expect(res.status).not.toBe(200)
    expect(t.approvals.answered).toEqual([])
  })

  it('AC-2.9 a card of a desktop conversation is not listed and not answerable from the phone', async () => {
    const { t, headers } = await served()
    const desktop = t.approvals.askApproval(approval({ threadId: 'desktop-1' }))
    expect(views(await list(t, headers))).toEqual([])
    expect((await answer(t, headers, desktop.approvalId, 'allow')).status).not.toBe(200)
    expect(t.approvals.answered).toEqual([])
  })
})
