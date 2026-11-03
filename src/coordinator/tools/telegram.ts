import * as z from 'zod/v4'
import { loadPicture } from '../vision'
import { pictureRoots } from './home'
import { defineTool, ToolError } from './types'

/** Only to the user's own bound chat (the one that talks to the bot), never to third parties. */
export const sendTelegramTool = defineTool({
  name: 'send_telegram',
  description:
    'Le manda un mensaje al USUARIO por Telegram, a su propio chat con el bot de Alma (no a otras personas). Usalo cuando te pida que le escribas o le mandes algo al celular, o para avisarle el resultado de una tarea larga. Con image_path manda una imagen (JPG, PNG, WebP) que esté en el vault, la carpeta de trabajo o las imágenes recibidas: text pasa a ser el pie de foto. Nunca mandes la ruta como texto en lugar de la imagen.',
  risk: 'memory',
  standalone: true,
  schema: z.object({ text: z.string().min(1).max(20_000).describe('El mensaje, tal cual lo va a leer'), image_path: z.string().optional().describe('Ruta de una imagen para mandar como foto') }),
  async run({ text, image_path }, ctx) {
    if (image_path) {
      if (!ctx.sendTelegramPhoto) throw new ToolError('Telegram no está disponible desde acá.')
      const picture = loadPicture(image_path, pictureRoots(ctx))
      const photo = await ctx.sendTelegramPhoto(Buffer.from(picture.data, 'base64'), text).catch((error: Error) => {
        throw new ToolError(`Telegram no aceptó la foto: ${error.message}`)
      })
      if (!photo) throw new ToolError('Telegram no está conectado: falta el token del bot en Configuración → Telegram, o el usuario todavía no le escribió al bot para vincular su chat.')
      return 'Foto enviada por Telegram.'
    }
    if (!ctx.sendTelegram) throw new ToolError('Telegram no está disponible desde acá.')
    const sent = await ctx.sendTelegram(text).catch((error: Error) => {
      throw new ToolError(`Telegram no aceptó el mensaje: ${error.message}`)
    })
    if (!sent)
      throw new ToolError('Telegram no está conectado: falta el token del bot en Configuración → Telegram, o el usuario todavía no le escribió al bot para vincular su chat.')
    return 'Mensaje enviado por Telegram.'
  }
})
