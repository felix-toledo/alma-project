import * as z from 'zod/v4'
import { loadPicture } from '../vision'
import { pictureRoots } from './home'
import { defineTool, ToolError, toolText } from './types'

/** Only to the user's own bound chat (the one that talks to the bot), never to third parties. */
export const sendTelegramTool = defineTool({
  name: 'send_telegram',
  description:
    "Sends a message to the USER by Telegram, to their own chat with Alma's bot (not to other people). Use it when they ask you to write to them or send something to their phone, or to tell them the result of a long task. With image_path it sends an image (JPG, PNG, WebP) that is in the vault, the working folder or the received images: text becomes the caption. Never send the path as text instead of the image.",
  risk: 'memory',
  standalone: true,
  schema: z.object({ text: z.string().min(1).max(20_000).describe('The message, exactly as they will read it'), image_path: z.string().optional().describe('Path of an image to send as a photo') }),
  async run({ text, image_path }, ctx) {
    if (image_path) {
      if (!ctx.sendTelegramPhoto) throw new ToolError('tool.tg.unavailable')
      const picture = loadPicture(image_path, pictureRoots(ctx))
      const photo = await ctx.sendTelegramPhoto(Buffer.from(picture.data, 'base64'), text).catch((error: Error) => {
        throw new ToolError('tool.home.telegramRejected', { error: error.message })
      })
      if (!photo) throw new ToolError('tool.tg.notConnected')
      return toolText(ctx, 'tool.tg.photoSent')
    }
    if (!ctx.sendTelegram) throw new ToolError('tool.tg.unavailable')
    const sent = await ctx.sendTelegram(text).catch((error: Error) => {
      throw new ToolError('tool.tg.msgRejected', { error: error.message })
    })
    if (!sent) throw new ToolError('tool.tg.notConnected')
    return toolText(ctx, 'tool.tg.msgSent')
  }
})
