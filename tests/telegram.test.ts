import { describe, expect, it } from 'vitest'
import { ApprovalBroker } from '../src/coordinator/approval'
import { authorizeChat, splitForTelegram, TelegramChannel, type TelegramDeps } from '../src/coordinator/channels/telegram'
import { defaultSettings } from '../src/shared/defaults'
import { translate } from '../src/shared/i18n/messages'
import type { LiveEvent, PendingApproval, TelegramSettings } from '../src/shared/types'

const config = (over: Partial<TelegramSettings> = {}): TelegramSettings => ({
  enabled: true,
  allowedUsers: ['@Felix'],
  agentId: 'general',
  chatId: null,
  threadId: null,
  ...over
})

describe('authorizeChat', () => {
  it('binds the first allowed user in a private chat, case-insensitively and ignoring @', () => {
    expect(authorizeChat(config(), { id: 7, type: 'private' }, 'felix')).toBe('bind')
    expect(authorizeChat(config(), { id: 7, type: 'private' }, 'otro')).toBe('denied')
    expect(authorizeChat(config(), { id: 7, type: 'private' }, undefined)).toBe('denied')
  })

  it('never accepts groups, even from an allowed user', () => {
    expect(authorizeChat(config(), { id: -100, type: 'group' }, 'felix')).toBe('denied')
    expect(authorizeChat(config({ chatId: -100 }), { id: -100, type: 'supergroup' }, 'felix')).toBe('denied')
  })

  it('once bound, only that chat works, whatever the username', () => {
    const bound = config({ chatId: 7 })
    expect(authorizeChat(bound, { id: 7, type: 'private' }, 'nuevo_nombre')).toBe('ok')
    expect(authorizeChat(bound, { id: 8, type: 'private' }, 'felix')).toBe('denied')
  })
})

describe('splitForTelegram', () => {
  it('keeps short text whole and splits long text at line breaks under the limit', () => {
    expect(splitForTelegram('hola')).toEqual(['hola'])
    const long = Array.from({ length: 50 }, (_, i) => `Línea ${i} ${'x'.repeat(90)}`).join('\n')
    const pieces = splitForTelegram(long, 1000)
    expect(pieces.length).toBeGreaterThan(4)
    expect(pieces.every((p) => p.length <= 1000)).toBe(true)
    expect(pieces.join('\n')).toBe(long)
  })
})

interface Sent {
  chatId: number
  text: string
  buttons: { text: string; data: string }[]
}

/** A channel with a fake bot (no network): approvals reach `sent`, and answers go to a real broker as index.ts wires them. */
function approvalRig() {
  const sent: Sent[] = []
  const settings = { ...defaultSettings('es'), telegram: config({ chatId: 7, threadId: 'tg-thread' }) }
  const events: LiveEvent[] = []
  const broker = new ApprovalBroker((event) => events.push(event))
  const deps = {
    settings: () => settings,
    respondApproval: (approvalId: string, decision: 'allow' | 'deny' | 'always') => broker.respond(approvalId, decision, 'telegram')
  } as unknown as TelegramDeps
  const channel = new TelegramChannel(deps)
  const bot = {
    api: {
      sendMessage: async (chatId: number, text: string, extra?: { reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] } }) => {
        const rows = extra?.reply_markup?.inline_keyboard ?? []
        sent.push({ chatId, text, buttons: rows.flat().map((b) => ({ text: b.text, data: b.callback_data })) })
        return { message_id: sent.length }
      },
      editMessageText: async () => undefined
    }
  }
  const inner = channel as unknown as { bot: unknown; onEvent(event: LiveEvent): void; onCallback(ctx: unknown): Promise<void> }
  inner.bot = bot
  const ask = async (overrides: Partial<PendingApproval>) => {
    const controller = new AbortController()
    const asked = broker.askAnswer(
      { threadId: 'tg-thread', toolUseId: 'tu1', toolName: 'create_company', input: { name: 'Acme' }, flagged: false, allowAlways: false, ...overrides },
      controller.signal
    )
    const request = events.filter((event): event is Extract<LiveEvent, { type: 'approval.request' }> => event.type === 'approval.request').at(-1)
    if (!request) throw new Error('no approval requested')
    inner.onEvent(request)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    return { asked, approvalId: request.approval.approvalId }
  }
  const press = async (data: string, chat = { id: 7, type: 'private' }) => {
    const toasts: unknown[] = []
    await inner.onCallback({ callbackQuery: { data }, chat, from: { username: 'felix' }, answerCallbackQuery: async (arg: unknown) => void toasts.push(arg) })
    return toasts
  }
  const first = (): Sent => {
    const message = sent[0]
    if (!message) throw new Error('nothing sent')
    return message
  }
  return { sent, broker, ask, press, first }
}

describe('photos on Telegram (spec 030)', () => {
  it('AC-8.1 (030) Telegram photos still land as telegram-<id>.jpg', async () => {
    const saved: { name: string; bytes: number }[] = []
    const told: string[] = []
    const settings = { ...defaultSettings('es'), telegram: config({ chatId: 7, threadId: 'tg-thread' }) }
    const deps = {
      settings: () => settings,
      saveImage: (bytes: Buffer, name: string) => {
        saved.push({ name, bytes: bytes.length })
        return `C:\\inbox\\1abc-${name}`
      }
    } as unknown as TelegramDeps
    const channel = new TelegramChannel(deps)
    const inner = channel as unknown as { onPhoto(ctx: unknown): Promise<void>; onText(ctx: unknown, text: string): Promise<void> }
    inner.onText = async (_ctx, text) => void told.push(text)
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch
    try {
      await inner.onPhoto({
        chat: { id: 7, type: 'private' },
        from: { username: 'felix' },
        message: { photo: [{ file_id: 'small', file_unique_id: 'u-small' }, { file_id: 'big', file_unique_id: 'AQADxyz' }], caption: 'look' },
        api: { getFile: async () => ({ file_path: 'photos/1.jpg' }) },
        reply: async () => undefined
      })
    } finally {
      globalThis.fetch = realFetch
    }
    // the biggest size goes to the inbox under its Telegram name, not through the attachments store
    expect(saved).toEqual([{ name: 'telegram-AQADxyz.jpg', bytes: 3 }])
    expect(told).toHaveLength(1)
    expect(told[0]).toContain('C:\\inbox\\1abc-telegram-AQADxyz.jpg')
    expect(told[0]).toContain('look_at_image')
  })
})

describe('approvals on Telegram (spec 029)', () => {
  const es = (key: 'tg.allow' | 'tg.deny' | 'chan.seeOnDesktop') => translate('es', key)

  it('AC-2.8 (029) company tools ask only the bound chat, with Permitir and Rechazar and no Siempre, and create on Permitir', async () => {
    const t = approvalRig()
    const { asked, approvalId } = await t.ask({})
    expect(t.sent).toHaveLength(1)
    expect(t.first().chatId).toBe(7)
    expect(t.first().buttons).toEqual([
      { text: es('tg.allow'), data: `ap:${approvalId}:allow` },
      { text: es('tg.deny'), data: `ap:${approvalId}:deny` }
    ])
    // A conversation that is not the Telegram one never reaches the chat.
    await t.ask({ threadId: 'desktop-1' })
    expect(t.sent).toHaveLength(1)
    // A stranger's tap changes nothing.
    await t.press(`ap:${approvalId}:allow`, { id: 8, type: 'private' })
    expect(t.broker.pending().map((a) => a.approvalId)).toContain(approvalId)
    await t.press(`ap:${approvalId}:allow`)
    await expect(asked).resolves.toEqual({ decision: 'allow', via: 'telegram' })
  })

  it('AC-2.12 (029) telegram offers no Permitir when the proposal does not fit', async () => {
    const t = approvalRig()
    const long = { name: 'x'.repeat(2000) }
    const { asked, approvalId } = await t.ask({ input: long })
    expect(t.first().buttons).toEqual([{ text: es('tg.deny'), data: `ap:${approvalId}:deny` }])
    expect(t.first().text).toContain(es('chan.seeOnDesktop'))
    expect(t.first().text).not.toContain('xxxxx')
    // A stale or forged Permitir tap does not answer it: the desktop card still can.
    await t.press(`ap:${approvalId}:allow`)
    expect(t.broker.pending()).toHaveLength(1)
    await t.press(`ap:${approvalId}:deny`)
    await expect(asked).resolves.toEqual({ decision: 'deny', via: 'telegram' })
  })

  it('AC-2.12 (029) other tools keep the 1500-character cut and their buttons', async () => {
    const t = approvalRig()
    const { approvalId } = await t.ask({ toolName: 'write_file', input: { content: 'x'.repeat(3000) }, allowAlways: true })
    expect(t.first().buttons.map((b) => b.data)).toEqual([`ap:${approvalId}:allow`, `ap:${approvalId}:always`, `ap:${approvalId}:deny`])
    expect(t.first().text).toContain('…')
    expect(t.first().text).not.toContain(es('chan.seeOnDesktop'))
  })
})
