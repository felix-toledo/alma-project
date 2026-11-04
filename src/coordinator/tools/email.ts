import { ImapFlow, type SearchObject } from 'imapflow'
import { simpleParser } from 'mailparser'
import { createTransport } from 'nodemailer'
import * as z from 'zod/v4'
import type { Settings } from '../../shared/types'
import { formatDateTime } from '../../shared/i18n/format'
import { translate, translateText } from '../../shared/i18n/messages'
import { defineTool, languageOf, ToolError, toolText, truncateMiddle, type ToolContext } from './types'
import { htmlToText } from './web'

// IMAP to read, SMTP to send, with the mailbox's app password (Gmail, Outlook, Yahoo or any provider).
// ponytail: one IMAP connection per tool call; keep one open (IDLE) if new-mail triggers are ever added.

export function emailConfigured(settings: Settings): boolean {
  const { address, imapHost, smtpHost } = settings.email
  return !!(address && imapHost && smtpHost && settings.providers.email.apiKey)
}

function account(settings: Settings): Settings['email'] & { password: string } {
  if (!emailConfigured(settings)) throw new ToolError('tool.email.notConfigured')
  return { ...settings.email, password: settings.providers.email.apiKey }
}

const isGmail = (host: string): boolean => /(^|\.)gmail\.com$/i.test(host)

function explain(error: unknown): ToolError {
  const message = error instanceof Error ? error.message : String(error)
  const text = (error as { responseText?: string }).responseText ?? message
  if (/auth|credentials|login|password|535|534/i.test(text))
    return new ToolError('tool.email.authRejected', { error: text })
  return new ToolError('tool.email.cannotConnect', { error: text })
}

/** The password never crosses the network in clear: plain ports must upgrade with STARTTLS (no silent fallback), and TLS 1.2 is the floor. */
const TLS = { minVersion: 'TLSv1.2' as const }

async function withMailbox<T>(settings: Settings, folder: string | undefined, work: (client: ImapFlow, folder: string) => Promise<T>): Promise<T> {
  const { address, password, imapHost, imapPort } = account(settings)
  const client = new ImapFlow({ host: imapHost, port: imapPort, secure: imapPort === 993, doSTARTTLS: imapPort !== 993 ? true : undefined, tls: TLS, auth: { user: address, pass: password }, logger: false })
  try {
    await client.connect()
  } catch (error) {
    throw explain(error)
  }
  try {
    // Gmail: search "All Mail" by default (its name is localized, so find it by role), elsewhere the inbox.
    let path = folder || 'INBOX'
    if (!folder && isGmail(imapHost)) path = (await client.list()).find((box) => box.specialUse === '\\All')?.path ?? 'INBOX'
    const lock = await client.getMailboxLock(path).catch(() => {
      throw new ToolError('tool.email.noFolder', { path })
    })
    try {
      return await work(client, path)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

const describeAddress = (list?: { name?: string; address?: string }[]): string =>
  (list ?? []).map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ''))).join(', ')

export const emailSearchTool = defineTool({
  name: 'email_search',
  description:
    'Searches the user\'s mailbox and returns the most recent mails (uid, date, sender, subject, whether read). On Gmail, `query` accepts Gmail search syntax ("from:juan has:attachment newer_than:7d"). Read a whole one with email_read.',
  risk: 'read',
  standalone: true,
  schema: z.object({
    query: z.string().optional().describe('Text to search for (on Gmail, Gmail syntax). Empty = the latest mails'),
    unread_only: z.boolean().optional().describe('Only unread ones'),
    since_days: z.number().int().min(1).max(3650).optional().describe('Only from the last N days'),
    folder: z.string().optional().describe('IMAP folder (default: All Mail on Gmail, INBOX elsewhere)'),
    limit: z.number().int().min(1).max(50).optional().describe('How many (default 15)')
  }),
  async run({ query, unread_only, since_days, folder, limit = 15 }, ctx) {
    return withMailbox(ctx.settings, folder, async (client, path) => {
      const criteria: SearchObject = {}
      if (query && isGmail(ctx.settings.email.imapHost)) criteria.gmraw = query
      else if (query) criteria.or = [{ subject: query }, { from: query }, { body: query }]
      if (unread_only) criteria.seen = false
      if (since_days) criteria.since = new Date(Date.now() - since_days * 86_400_000)
      if (!Object.keys(criteria).length) criteria.all = true
      const uids = (await client.search(criteria, { uid: true })) || []
      if (!uids.length) return toolText(ctx, 'tool.email.noMatches', { path })
      const lines: string[] = []
      for await (const message of client.fetch(uids.slice(-limit), { envelope: true, flags: true, internalDate: true }, { uid: true })) {
        const date = formatDateTime('en', new Date(message.internalDate ?? message.envelope?.date ?? 0), 'short')
        const unread = message.flags?.has('\\Seen') ? '' : ' [unread]'
        lines.push(`uid ${message.uid} · ${date} · ${describeAddress(message.envelope?.from)} · «${message.envelope?.subject ?? '(no subject)'}»${unread}`)
      }
      return toolText(ctx, 'tool.email.list', { path, total: uids.length, shown: lines.length, data: lines.reverse().join('\n') })
    })
  }
})

export const emailReadTool = defineTool({
  name: 'email_read',
  description: 'Reads a whole mail (sender, recipients, date, subject, text and attachment names) by its uid from email_search. Pass the same folder as in the search.',
  risk: 'read',
  standalone: true,
  schema: z.object({
    uid: z.number().int().positive().describe('uid returned by email_search'),
    folder: z.string().optional().describe('The same folder as the search (empty = the default)')
  }),
  async run({ uid, folder }, ctx) {
    return withMailbox(ctx.settings, folder, async (client) => {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
      if (!message || !message.source) throw new ToolError('tool.email.notFound', { uid })
      const mail = await simpleParser(message.source)
      const text = mail.text?.trim() || (mail.html ? htmlToText(mail.html).text : '') || '(no text)'
      const to = (Array.isArray(mail.to) ? mail.to : mail.to ? [mail.to] : []).map((a) => a.text).join(', ')
      const attachments = mail.attachments.map((a) => a.filename ?? 'attachment').join(', ')
      // Cc, Message-ID and attachments only appear when the mail has them, so they are built here and slot into the key.
      const cc = mail.cc ? `\nCc: ${(Array.isArray(mail.cc) ? mail.cc : [mail.cc]).map((a) => a.text).join(', ')}` : ''
      const rest = `${mail.messageId ? `\nMessage-ID: ${mail.messageId}` : ''}${attachments ? `\nAttachments: ${attachments}` : ''}`
      return toolText(ctx, 'tool.email.read', {
        from: mail.from?.text ?? '',
        to,
        cc,
        date: mail.date ? formatDateTime('en', mail.date, 'short') : '',
        subject: mail.subject ?? '(no subject)',
        rest,
        data: truncateMiddle(text, 20_000)
      })
    })
  }
})

export const emailSendTool = defineTool({
  name: 'email_send',
  description:
    'Sends a mail from the user\'s mailbox. The user sees the mail and approves every send. To reply to a mail, pass its Message-ID (from email_read) in in_reply_to and use "Re: …" as the subject.',
  risk: 'publish',
  standalone: true,
  schema: z.object({
    to: z.string().min(3).describe('Recipients, separated by comma'),
    subject: z.string().min(1),
    body: z.string().min(1).describe('Text of the mail (plain text)'),
    cc: z.string().optional(),
    in_reply_to: z.string().optional().describe('Message-ID of the mail being replied to')
  }),
  async preview({ to, cc, subject, body }, ctx) {
    const language = languageOf(ctx)
    const line = (key: 'preview.to' | 'preview.cc' | 'preview.subject', value: string): string => `${translate(language, key)}: ${value}`
    return { note: `${line('preview.to', to)}${cc ? `\n${line('preview.cc', cc)}` : ''}\n${line('preview.subject', subject)}\n\n${body}` }
  },
  async run({ to, cc, subject, body, in_reply_to }, ctx) {
    const transport = smtp(ctx)
    try {
      const sent = await transport.sendMail({
        from: ctx.settings.email.address,
        to,
        cc,
        subject,
        text: body,
        ...(in_reply_to ? { inReplyTo: in_reply_to, references: in_reply_to } : {})
      })
      return toolText(ctx, 'tool.email.sent', { to, id: sent.messageId })
    } catch (error) {
      throw explain(error)
    } finally {
      transport.close()
    }
  }
})

function smtp(ctx: Pick<ToolContext, 'settings'>): ReturnType<typeof createTransport> {
  const { address, password, smtpHost, smtpPort } = account(ctx.settings)
  return createTransport({ host: smtpHost, port: smtpPort, secure: smtpPort === 465, requireTLS: smtpPort !== 465, tls: TLS, auth: { user: address, pass: password } })
}

/** Settings → Mail → "Probar": logs in to both servers without reading or sending anything. */
export async function testEmail(settings: Settings): Promise<string> {
  try {
    await withMailbox(settings, 'INBOX', async () => undefined)
    const transport = smtp({ settings })
    try {
      await transport.verify()
    } catch (error) {
      throw explain(error)
    } finally {
      transport.close()
    }
    return translate(settings.language, 'tool.email.connected', { address: settings.email.address })
  } catch (error) {
    // The person reads this one, so it goes out in their language rather than the model's English.
    throw error instanceof ToolError && error.text ? new Error(translateText(settings.language, error.text)) : error
  }
}

export const emailTools = [emailSearchTool, emailReadTool, emailSendTool]
