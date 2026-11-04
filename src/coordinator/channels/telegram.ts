// Telegram channel: the bot runs inside the coordinator (long polling, no server or open port needed).
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy'
import { audit } from '../../shared/audit'
import { type MessageKey, type ParamsArg, translate } from '../../shared/i18n/messages'
import type { LiveEvent, PendingApproval, Settings, TelegramSettings, TelegramStatus, Thread } from '../../shared/types'
import { approvalButtons, approvalPrompt, approvalToast, describeTelegramError } from './texts'

const TELEGRAM_LIMIT = 4096
const STATUS_EDIT_MS = 1500

export interface TelegramDeps {
  settings(): Settings
  token(): string
  patch(patch: Partial<TelegramSettings>): void
  /** The conversation Telegram talks to; `fresh` starts a new one. */
  conversation(fresh?: boolean): Thread
  /** Runs the agent on the conversation and resolves when it finishes (rejects if one is already running). */
  ask(threadId: string, text: string): Promise<void>
  /** The agent's last answer in the conversation. */
  lastAnswer(threadId: string): string
  /** Turns a voice note into text, or throws if voice isn't set up. */
  transcribe?(audio: ArrayBuffer, mime: string): Promise<string>
  /** Saves a picture the user sent where the agents can look at it; returns its path. */
  saveImage?(bytes: Buffer, name: string): string
  onEvent(listener: (event: LiveEvent) => void): () => void
  respondApproval(approvalId: string, decision: 'allow' | 'deny' | 'always'): void
  onStatus(status: TelegramStatus): void
}

/** Splits text at paragraph or line breaks so every piece fits in one Telegram message. */
export function splitForTelegram(text: string, limit = TELEGRAM_LIMIT): string[] {
  const pieces: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ') + 1)
    const at = cut > limit * 0.5 ? cut : limit
    pieces.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) pieces.push(rest)
  return pieces
}

const normalizeUser = (name: string): string => name.trim().replace(/^@/, '').toLowerCase()

/**
 * Who may talk to the bot: only private chats; the first allowed user binds their chat, and from then on only that
 * chat is accepted (a username can be changed or taken by someone else, a chat id can't).
 */
export function authorizeChat(
  telegram: TelegramSettings,
  chat: { id: number; type: string } | undefined,
  username: string | undefined
): 'ok' | 'bind' | 'denied' {
  if (!chat || chat.type !== 'private') return 'denied'
  if (telegram.chatId !== null) return chat.id === telegram.chatId ? 'ok' : 'denied'
  if (username && telegram.allowedUsers.map(normalizeUser).includes(username.toLowerCase())) return 'bind'
  return 'denied'
}

export class TelegramChannel {
  private bot: Bot | null = null
  private runningToken = ''
  private status: TelegramStatus = { state: 'off' }
  private approvalMessages = new Map<string, { chatId: number; messageId: number; text: string }>()
  private offApprovals: (() => void) | null = null

  constructor(private deps: TelegramDeps) {}

  /** What the code says, in the app language of the moment. */
  private text<K extends MessageKey>(key: K, ...params: ParamsArg<K>): string {
    return translate(this.deps.settings().language, key, ...params)
  }

  currentStatus(): TelegramStatus {
    return this.status
  }

  private setStatus(status: TelegramStatus): void {
    this.status = status
    this.deps.onStatus(status)
  }

  /** Starts, restarts or stops the bot to match settings (call on every settings change). */
  async sync(): Promise<void> {
    const token = this.deps.settings().telegram.enabled ? this.deps.token() : ''
    if (token === this.runningToken) return
    await this.stop()
    this.runningToken = token
    if (!token) return this.setStatus({ state: 'off' })
    await this.start(token)
  }

  private async start(token: string): Promise<void> {
    this.setStatus({ state: 'connecting' })
    const bot = new Bot(token)
    // Without this, any error thrown in a handler stops polling for good (ALMA's bot went silent that way).
    bot.catch((error) => console.error('[telegram]', error.error))
    bot.command('start', (ctx) => this.onStart(ctx))
    bot.command('nuevo', (ctx) => this.onNew(ctx))
    bot.on('message:text', (ctx) => this.onText(ctx, ctx.message.text))
    bot.on(['message:voice', 'message:audio'], (ctx) => this.onVoice(ctx))
    bot.on('message:photo', (ctx) => this.onPhoto(ctx))
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx))
    try {
      await bot.init()
    } catch (error) {
      if (this.runningToken === token) this.setStatus({ state: 'error', error: this.describe(error) })
      return
    }
    if (this.runningToken !== token) return
    this.bot = bot
    this.offApprovals = this.deps.onEvent((event) => this.onEvent(event))
    void bot
      .start({ drop_pending_updates: true, onStart: () => this.setStatus({ state: 'online', username: bot.botInfo.username }) })
      .catch((error) => {
        if (this.bot === bot) this.setStatus({ state: 'error', error: this.describe(error) })
      })
  }

  async stop(): Promise<void> {
    const bot = this.bot
    this.bot = null
    this.offApprovals?.()
    this.offApprovals = null
    this.approvalMessages.clear()
    if (bot?.isRunning()) await bot.stop().catch(() => {})
  }

  /** Delivers a reminder (or any notice) to the bound chat, if there is one. */
  async notify(text: string): Promise<boolean> {
    const chatId = this.deps.settings().telegram.chatId
    if (!this.bot || chatId === null) return false
    for (const piece of splitForTelegram(text)) await this.bot.api.sendMessage(chatId, piece)
    return true
  }

  /** Sends a picture (a camera still) to the bound chat. */
  async notifyPhoto(jpeg: Buffer, caption: string): Promise<boolean> {
    const chatId = this.deps.settings().telegram.chatId
    if (!this.bot || chatId === null) return false
    await this.bot.api.sendPhoto(chatId, new InputFile(jpeg, 'alma.jpg'), { caption: caption.slice(0, 1000) })
    return true
  }

  private check(ctx: Context): boolean {
    const verdict = authorizeChat(this.deps.settings().telegram, ctx.chat, ctx.from?.username)
    if (verdict === 'bind') {
      audit({ action: 'channel.bind', actor: 'remote', target: 'telegram', outcome: 'ok' })
      this.deps.patch({ chatId: ctx.chat!.id })
    }
    // Strangers can write to a bot at will: one line a minute, and only the kind of chat (no names, no text).
    if (verdict === 'denied') audit({ action: 'channel.denied', actor: 'remote', target: 'telegram', outcome: 'denied', detail: { chat: ctx.chat?.type ?? 'unknown' }, throttle: true })
    return verdict !== 'denied'
  }

  private async deny(ctx: Context): Promise<void> {
    if (ctx.chat?.type !== 'private') return
    const who = ctx.from?.username ? `@${ctx.from.username}` : this.text('tg.noUser')
    await ctx.reply(this.text('tg.denied', { who }))
  }

  private async onStart(ctx: Context): Promise<void> {
    if (!this.check(ctx)) return this.deny(ctx)
    await ctx.reply(this.text('tg.start'))
  }

  private async onNew(ctx: Context): Promise<void> {
    if (!this.check(ctx)) return this.deny(ctx)
    this.deps.conversation(true)
    await ctx.reply(this.text('chan.newDone'))
  }

  private async onVoice(ctx: Context): Promise<void> {
    if (!this.check(ctx)) return this.deny(ctx)
    const media = ctx.message?.voice ?? ctx.message?.audio
    if (!media || !this.deps.transcribe) {
      await ctx.reply(this.text('chan.noVoice'))
      return
    }
    try {
      const file = await ctx.getFile()
      const response = await fetch(`https://api.telegram.org/file/bot${this.runningToken}/${file.file_path}`)
      const text = await this.deps.transcribe(await response.arrayBuffer(), media.mime_type ?? 'audio/ogg')
      if (!text.trim()) return void (await ctx.reply(this.text('chan.noAudio')))
      await ctx.reply(`🎙️ «${text.trim()}»`)
      await this.onText(ctx, text)
    } catch (error) {
      await ctx.reply(this.text('chan.audioFailed', { error: this.describe(error) }))
    }
  }

  /** A photo becomes a file in the inbox, and the agent is told where it is (look_at_image reads it). */
  private async onPhoto(ctx: Context): Promise<void> {
    if (!this.check(ctx)) return this.deny(ctx)
    if (!this.deps.saveImage) return void (await ctx.reply(this.text('tg.noPhotos')))
    try {
      const photo = ctx.message!.photo!.at(-1)!
      const file = await ctx.api.getFile(photo.file_id)
      const response = await fetch(`https://api.telegram.org/file/bot${this.runningToken}/${file.file_path}`)
      const path = this.deps.saveImage(Buffer.from(await response.arrayBuffer()), `telegram-${photo.file_unique_id}.jpg`)
      await this.onText(ctx, `[The user sent you an image: ${path}. Look at it with look_at_image.]${ctx.message!.caption ? `
${ctx.message!.caption}` : ''}`)
    } catch (error) {
      await ctx.reply(this.text('tg.photoFailed', { error: this.describe(error) }))
    }
  }

  private async onText(ctx: Context, text: string): Promise<void> {
    if (!this.check(ctx)) return this.deny(ctx)
    const chatId = ctx.chat!.id
    const thread = this.deps.conversation()
    const placeholder = await ctx.reply(this.text('chan.thinking'))
    let lastStatus = ''
    let lastEdit = 0
    const off = this.deps.onEvent((event) => {
      if (event.type !== 'stream.tool' || event.scope.threadId !== thread.id) return
      const status = this.text('chan.thinkingTool', { tool: event.name.replace(/^mcp__/, '').replace(/_/g, ' ') })
      const now = Date.now()
      if (status === lastStatus || now - lastEdit < STATUS_EDIT_MS) return
      lastStatus = status
      lastEdit = now
      void ctx.api.editMessageText(chatId, placeholder.message_id, status).catch(() => {})
    })
    let answer: string
    try {
      await this.deps.ask(thread.id, text)
      answer = this.deps.lastAnswer(thread.id) || this.text('chan.done')
    } catch (error) {
      answer = this.text('chan.failed', { error: this.describe(error) })
    } finally {
      off()
    }
    const [first, ...rest] = splitForTelegram(answer)
    await ctx.api.editMessageText(chatId, placeholder.message_id, first).catch(() => ctx.reply(first))
    for (const piece of rest) await ctx.reply(piece)
  }

  /** Approvals for the Telegram conversation also show up here, with buttons. */
  private onEvent(event: LiveEvent): void {
    const { threadId, chatId } = this.deps.settings().telegram
    if (!this.bot || chatId === null) return
    if (event.type === 'approval.request' && event.approval.threadId === threadId) void this.askApproval(chatId, event.approval)
    if (event.type === 'approval.resolved') {
      const sent = this.approvalMessages.get(event.approvalId)
      if (!sent) return
      this.approvalMessages.delete(event.approvalId)
      void this.bot.api.editMessageText(sent.chatId, sent.messageId, `${sent.text}\n\n${this.text('tg.answered')}`).catch(() => {})
    }
  }

  private async askApproval(chatId: number, approval: PendingApproval): Promise<void> {
    const language = this.deps.settings().language
    const text = approvalPrompt(language, approval)
    const buttons = approvalButtons(language)
    const keyboard = new InlineKeyboard().text(buttons.allow, `ap:${approval.approvalId}:allow`)
    if (approval.allowAlways) keyboard.text(buttons.always, `ap:${approval.approvalId}:always`)
    keyboard.text(buttons.deny, `ap:${approval.approvalId}:deny`)
    const message = await this.bot!.api.sendMessage(chatId, text, { reply_markup: keyboard })
    this.approvalMessages.set(approval.approvalId, { chatId, messageId: message.message_id, text })
  }

  private async onCallback(ctx: Context): Promise<void> {
    const match = /^ap:([\w-]+):(allow|always|deny)$/.exec(ctx.callbackQuery?.data ?? '')
    if (!match || !this.check(ctx)) return void (await ctx.answerCallbackQuery())
    this.deps.respondApproval(match[1], match[2] as 'allow' | 'always' | 'deny')
    await ctx.answerCallbackQuery({ text: approvalToast(this.deps.settings().language, match[2] as 'allow' | 'always' | 'deny') })
  }

  private describe(error: unknown): string {
    return describeTelegramError(this.deps.settings().language, error)
  }
}
