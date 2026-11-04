// WhatsApp channel: Alma linked to the user's own number as a device (like WhatsApp Web, via Baileys). The user talks to
// her in "Mensajes para mí"; she can message contacts only through send_whatsapp, which the user approves every time.
// Not an official API: WhatsApp may ban numbers it sees misbehaving, so nothing here sends unprompted or in bulk.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, jidNormalizedUser, useMultiFileAuthState, type WAMessage } from 'baileys'
import { toDataURL } from 'qrcode'
import type { LiveEvent, Settings, Thread, WhatsAppSettings, WhatsAppStatus } from '../../shared/types'
import { type MessageKey, type ParamsArg, translate } from '../../shared/i18n/messages'
import { parseYesNo } from '../../shared/i18n/vocab'
import { ToolError } from '../tools/types'
import { splitForTelegram } from './telegram'
import { approvalPrompt } from './texts'

/** Alma's messages in the self chat start with this, so they're easy to tell apart (and never answered). */
const MARK = '🤖 '
const RECENT_LIMIT = 300
/** Messages older than this when they arrive are history being synced, not something to answer. */
const STALE_MS = 2 * 60_000

export interface WhatsAppDeps {
  settings(): Settings
  dataDir: string
  /** Where the linked session lives (one per number: the user's, and each company's). */
  authDir?: string
  /** On/off and the conversation it talks to; defaults to the user's WhatsApp settings. */
  config?(): { enabled: boolean; threadId: string | null }
  patch(patch: Partial<WhatsAppSettings>): void
  conversation(fresh?: boolean): Thread
  ask(threadId: string, text: string): Promise<void>
  lastAnswer(threadId: string): string
  transcribe?(audio: ArrayBuffer, mime: string): Promise<string>
  onEvent(listener: (event: LiveEvent) => void): () => void
  respondApproval(approvalId: string, decision: 'allow' | 'deny'): void
  onStatus(status: WhatsAppStatus): void
}

export interface RecentMessage {
  chat: string
  from: string
  text: string
  at: number
}

const silent = {
  level: 'silent',
  child: () => silent,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

type Socket = ReturnType<typeof makeWASocket>

function textOf(message: WAMessage): string {
  const m = message.message
  return (m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? m?.videoMessage?.caption ?? '').trim()
}

/** "+54 9 11 1234-5678" → "5491112345678". */
export function phoneDigits(text: string): string {
  return text.replace(/\D/g, '')
}

export class WhatsAppChannel {
  private socket: Socket | null = null
  private running = false
  private status: WhatsAppStatus = { state: 'off' }
  private sent = new Set<string>()
  private names = new Map<string, string>()
  private recent: RecentMessage[] = []
  private pendingApproval: string | null = null
  private offEvents: (() => void) | null = null
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(private deps: WhatsAppDeps) {}

  /** What the code says, in the app language of the moment. */
  private text<K extends MessageKey>(key: K, ...params: ParamsArg<K>): string {
    return translate(this.deps.settings().language, key, ...params)
  }

  currentStatus(): WhatsAppStatus {
    return this.status
  }

  private setStatus(status: WhatsAppStatus): void {
    this.status = status
    this.deps.onStatus(status)
  }

  private get authDir(): string {
    return this.deps.authDir ?? join(this.deps.dataDir, 'whatsapp-auth')
  }

  private config(): { enabled: boolean; threadId: string | null } {
    return this.deps.config?.() ?? this.deps.settings().whatsapp
  }

  async sync(): Promise<void> {
    const enabled = this.config().enabled
    if (enabled === this.running) return
    this.running = enabled
    if (enabled) await this.start()
    else this.stop()
  }

  private async start(): Promise<void> {
    this.setStatus({ state: 'connecting' })
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
      const version = await fetchLatestBaileysVersion()
        .then((v) => v.version)
        .catch(() => undefined)
      if (!this.running) return
      const socket = makeWASocket({ auth: state, version, logger: silent, browser: Browsers.windows('Chrome'), syncFullHistory: false, markOnlineOnConnect: false })
      this.socket = socket
      socket.ev.on('creds.update', saveCreds)
      socket.ev.on('connection.update', (update) => void this.onConnection(socket, update))
      socket.ev.on('messages.upsert', ({ messages }) => {
        for (const message of messages) void this.onMessage(socket, message)
      })
      socket.ev.on('contacts.upsert', (contacts) => contacts.forEach((c) => this.learnName(c.id, c.name ?? c.notify)))
      socket.ev.on('contacts.update', (contacts) => contacts.forEach((c) => c.id && this.learnName(c.id, c.name ?? c.notify)))
      socket.ev.on('messaging-history.set', ({ contacts }) => contacts.forEach((c) => this.learnName(c.id, c.name ?? c.notify)))
      this.offEvents ??= this.deps.onEvent((event) => this.onEvent(event))
    } catch (error) {
      this.setStatus({ state: 'error', error: (error as Error).message })
    }
  }

  private stop(): void {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.offEvents?.()
    this.offEvents = null
    this.socket?.end(undefined)
    this.socket = null
    this.setStatus({ state: 'off' })
  }

  /** Unlinks Alma from the phone and shows a fresh QR. */
  async logout(): Promise<void> {
    await this.socket?.logout().catch(() => {})
    this.socket = null
    await rm(this.authDir, { recursive: true, force: true })
    if (this.running) await this.start()
  }

  private async onConnection(socket: Socket, update: { connection?: string; qr?: string; lastDisconnect?: { error?: Error } }): Promise<void> {
    if (socket !== this.socket) return
    if (update.qr) this.setStatus({ state: 'qr', qr: await toDataURL(update.qr, { margin: 1, width: 280 }) })
    if (update.connection === 'open') this.setStatus({ state: 'online', number: socket.user?.id.split(':')[0].split('@')[0] })
    if (update.connection === 'close') {
      this.socket = null
      const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: forget the session so the next start shows a QR.
        await rm(this.authDir, { recursive: true, force: true })
        this.setStatus({ state: 'error', error: this.text('wa.unlinked') })
      }
      if (this.running) this.retry = setTimeout(() => void this.start(), code === DisconnectReason.restartRequired ? 0 : 3000)
    }
  }

  private learnName(jid: string, name?: string | null): void {
    if (name) this.names.set(jidNormalizedUser(jid), name)
  }

  private isSelfChat(socket: Socket, jid: string): boolean {
    const me = socket.user
    if (!me) return false
    const chat = jidNormalizedUser(jid)
    return chat === jidNormalizedUser(me.id) || (!!me.lid && chat === jidNormalizedUser(me.lid))
  }

  private async onMessage(socket: Socket, message: WAMessage): Promise<void> {
    const jid = message.key.remoteJid
    if (!jid || !message.message || jid === 'status@broadcast') return
    const at = Number(message.messageTimestamp ?? 0) * 1000
    if (at && Date.now() - at > STALE_MS) return
    if (!message.key.fromMe) {
      // Someone else wrote to the user: remember it (since Alma started) so the agent can be asked about it.
      const text = textOf(message)
      if (!text) return
      this.learnName(message.key.participant ?? jid, message.pushName)
      this.recent.push({ chat: jid, from: message.pushName || this.names.get(jidNormalizedUser(message.key.participant ?? jid)) || jid.split('@')[0], text, at: at || Date.now() })
      if (this.recent.length > RECENT_LIMIT) this.recent.shift()
      return
    }
    if (!this.isSelfChat(socket, jid) || this.sent.has(message.key.id ?? '')) return
    let text = textOf(message)
    if (text.startsWith(MARK.trim())) return
    if (!text && message.message.audioMessage) {
      if (!this.deps.transcribe) return void this.reply(jid, this.text('chan.noVoice'))
      try {
        const audio = (await downloadMediaMessage(message, 'buffer', {})) as Buffer
        text = (await this.deps.transcribe(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer, message.message.audioMessage.mimetype ?? 'audio/ogg')).trim()
        if (!text) return void this.reply(jid, this.text('chan.noAudio'))
        await this.reply(jid, `🎙️ «${text}»`)
      } catch (error) {
        return void this.reply(jid, this.text('chan.audioFailed', { error: (error as Error).message }))
      }
    }
    if (!text) return
    if (this.pendingApproval) {
      const answer = parseYesNo(text)
      if (answer) {
        this.deps.respondApproval(this.pendingApproval, answer === 'yes' ? 'allow' : 'deny')
        this.pendingApproval = null
        return
      }
    }
    if (/^\/nuevo\b/i.test(text)) {
      this.deps.conversation(true)
      return void this.reply(jid, this.text('chan.newDone'))
    }
    const thread = this.deps.conversation()
    let answer: string
    try {
      await this.deps.ask(thread.id, text)
      answer = this.deps.lastAnswer(thread.id) || this.text('chan.done')
    } catch (error) {
      answer = this.text('chan.failed', { error: (error as Error).message })
    }
    await this.reply(jid, answer)
  }

  private async reply(jid: string, text: string): Promise<void> {
    if (!this.socket) return
    for (const piece of splitForTelegram(text, 4000)) {
      const sent = await this.socket.sendMessage(jid, { text: MARK + piece })
      if (sent?.key.id) this.sent.add(sent.key.id)
    }
  }

  /** Approvals for the WhatsApp conversation are asked in the self chat ("sí" / "no"); they also show in the app. */
  private onEvent(event: LiveEvent): void {
    const socket = this.socket
    if (!socket?.user) return
    if (event.type === 'approval.request' && event.approval.threadId === this.config().threadId) {
      this.pendingApproval = event.approval.approvalId
      void this.reply(jidNormalizedUser(socket.user.id), approvalPrompt(this.deps.settings().language, event.approval, { askYesNo: true }))
    }
    if (event.type === 'approval.resolved' && event.approvalId === this.pendingApproval) this.pendingApproval = null
  }

  // ---------------------------------------------------------------------------
  // For the agent's tools

  /** `to`: a phone number with country code, or a contact name WhatsApp told us about. */
  async resolve(to: string): Promise<{ jid: string; label: string }> {
    const socket = this.requireSocket()
    const digits = phoneDigits(to)
    if (digits.length >= 8 && !/[a-záéíóúñ]/i.test(to)) {
      const [found] = (await socket.onWhatsApp(digits)) ?? []
      if (!found?.exists) throw new ToolError('tool.wa.noNumber', { number: digits })
      return { jid: found.jid, label: this.names.get(jidNormalizedUser(found.jid)) ?? `+${digits}` }
    }
    const wanted = to.trim().toLowerCase()
    const matches = [...this.names].filter(([, name]) => name.toLowerCase().includes(wanted))
    if (matches.length === 1) return { jid: matches[0][0], label: matches[0][1] }
    if (matches.length > 1) throw new ToolError('tool.wa.several', { to, names: matches.slice(0, 8).map(([, n]) => n).join(', ') })
    throw new ToolError('tool.wa.unknown', { to })
  }

  async send(jid: string, text: string): Promise<void> {
    const sent = await this.requireSocket().sendMessage(jid, { text })
    if (sent?.key.id) this.sent.add(sent.key.id)
  }

  recentMessages(from?: string, limit = 30): RecentMessage[] {
    const wanted = from?.trim().toLowerCase() ?? ''
    const digits = phoneDigits(wanted)
    const list = wanted ? this.recent.filter((m) => m.from.toLowerCase().includes(wanted) || (digits.length >= 6 && m.chat.includes(digits))) : this.recent
    return list.slice(-limit)
  }

  private requireSocket(): Socket {
    if (!this.socket || this.status.state !== 'online') throw new ToolError('tool.wa.notConnected')
    return this.socket
  }
}
