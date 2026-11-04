import * as z from 'zod/v4'
import { formatDateTime } from '../../shared/i18n/format'
import { translate } from '../../shared/i18n/messages'
import { defineTool, languageOf, ToolError, toolText, type ToolContext } from './types'

function channel(ctx: ToolContext): NonNullable<ToolContext['whatsapp']> {
  if (!ctx.whatsapp) throw new ToolError('tool.wa.off')
  return ctx.whatsapp
}

const fail = (error: unknown): never => {
  throw new ToolError('tool.error', { data: (error as Error).message })
}

export const sendWhatsAppTool = defineTool({
  name: 'send_whatsapp',
  description:
    "Sends a WhatsApp message from the user's number to a contact (a contact name or a number with country code, e.g. 5491112345678). The user sees the message and approves every send. To write to the user themselves it is not needed: just answer normally.",
  risk: 'publish',
  standalone: true,
  schema: z.object({
    to: z.string().min(2).describe('Contact name or number with country code'),
    text: z.string().min(1).max(4000)
  }),
  async preview({ to, text }, ctx) {
    const target = await channel(ctx).resolve(to).catch(() => null)
    return { note: `${translate(languageOf(ctx), 'preview.to')}: ${target ? target.label : to}\n\n${text}` }
  },
  async run({ to, text }, ctx) {
    const whatsapp = channel(ctx)
    const target = await whatsapp.resolve(to).catch(fail)
    await whatsapp.send(target.jid, text).catch(fail)
    return toolText(ctx, 'tool.wa.sent', { label: target.label })
  }
})

export const whatsAppRecentTool = defineTool({
  name: 'whatsapp_recent',
  description:
    "Shows the latest WhatsApp messages that arrived for the user since Alma has been open (not the old history). Filter by name or number to see a person's.",
  risk: 'read',
  standalone: true,
  schema: z.object({
    from: z.string().optional().describe('Name or number of the sender (empty = all)'),
    limit: z.number().int().min(1).max(100).optional().describe('How many (30 by default)')
  }),
  async run({ from, limit }, ctx) {
    const messages = channel(ctx).recentMessages(from, limit)
    if (!messages.length) return from ? toolText(ctx, 'tool.wa.noneFrom', { from }) : toolText(ctx, 'tool.wa.none')
    const lines = messages.map((m) => `${formatDateTime('en', m.at, 'short')} · ${m.from}${m.chat.endsWith('@g.us') ? ' (group)' : ''}: ${m.text}`)
    return toolText(ctx, 'tool.wa.recent', { data: lines.join('\n') })
  }
})

export const whatsAppTools = [sendWhatsAppTool, whatsAppRecentTool]
