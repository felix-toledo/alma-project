import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import * as z from 'zod/v4'
import { compose, ComposeSchema, libraryGuide, loadLibrary } from '../compose'
import { generateImage, imageMimeType } from '../images'
import { displayPath, resolveInWorkspace } from './paths'
import { defineTool, ToolError } from './types'

const MAX_PREVIEW_BYTES = 12 * 1024 * 1024
const CAPTION_LIMIT = 2200
const HASHTAG_LIMIT = 30

function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'imagen'
  )
}

function timestamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Reads a workspace image as a data URL for previews in the UI. */
export async function imageDataUrl(path: string): Promise<string> {
  if (statSync(path).size > MAX_PREVIEW_BYTES) throw new ToolError('La imagen es demasiado grande para la vista previa.')
  const bytes = await readFile(path)
  const mime = imageMimeType(bytes)
  if (!mime) throw new ToolError('El archivo no es una imagen PNG, JPEG o WebP.')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export const generateImageTool = defineTool({
  name: 'generate_image',
  description:
    'Genera una imagen a partir de una descripción y la guarda en la carpeta imagenes/ de la carpeta de trabajo. Devuelve la ruta del archivo. Usala cuando necesites una imagen original (por ejemplo para un post). Describí sujeto, estilo, luz y encuadre.',
  risk: 'write',
  schema: z.object({
    prompt: z.string().min(10).describe('Descripción detallada de la imagen'),
    aspect_ratio: z.enum(['1:1', '4:5', '16:9', '9:16']).optional().describe('Formato; para Instagram usá 4:5 o 1:1'),
    filename: z.string().optional().describe('Nombre corto para el archivo, sin extensión')
  }),
  async run({ prompt, aspect_ratio = '1:1', filename }, ctx) {
    const { bytes, model } = await generateImage(ctx.settings, prompt, aspect_ratio, ctx.signal).catch((error: Error) => {
      throw new ToolError(`${error.message}
Sin modelo de imágenes podés armar una imagen original con compose_image (biblioteca de Alma).`)
    })
    const mime = imageMimeType(bytes)
    if (!mime) throw new ToolError('El servicio devolvió un archivo que no es una imagen.')
    const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'
    const target = resolveInWorkspace(ctx.workspace, `imagenes/${slugify(filename || prompt)}-${timestamp()}.${ext}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    return `Imagen guardada: ${displayPath(ctx.workspace, target)}\nModelo: ${model} · ${(bytes.length / 1024).toFixed(0)} KB · formato pedido ${aspect_ratio}`
  }
})

export const composeImageTool = defineTool({
  name: 'compose_image',
  description: `Arma una imagen original sin modelo de imágenes, combinando la biblioteca de Alma (plantillas, paletas, fuentes, fondos y formas) con las piezas del usuario en biblioteca/ (logos y SVG o fotos .svg/.png/.jpg, fuentes .ttf/.otf/.woff2, paletas en paletas.json). Guarda un PNG y un SVG editable en imagenes/ y devuelve la ruta. Usala cuando no haya generador de imágenes o para posts con texto (citas, anuncios, promos, listas). Si existe biblioteca/recetas.json, empezá por una receta (recipe): trae plantilla, colores, fuentes y piezas de la marca ya elegidos, y vos completás los textos. Si marca.md define colores o fuentes, pasalos en colors y font. Para otra variante, cambiá la semilla (seed).
${libraryGuide()}`,
  risk: 'write',
  schema: ComposeSchema,
  async run(input, ctx) {
    const library = await loadLibrary(resolveInWorkspace(ctx.workspace, 'biblioteca'))
    const { svg, width, height, summary } = compose(input, library)
    const base = `imagenes/${slugify(input.filename || input.title || input.template || 'alma')}-${timestamp()}`
    const svgPath = resolveInWorkspace(ctx.workspace, `${base}.svg`)
    const pngPath = resolveInWorkspace(ctx.workspace, `${base}.png`)
    await mkdir(dirname(svgPath), { recursive: true })
    await writeFile(svgPath, svg)
    const rendered = await ctx.host.request({ action: 'image.render', svg, width, height, outPath: pngPath })
    if (!rendered.ok) throw new ToolError(`No se pudo pasar la imagen a PNG: ${rendered.message}. El SVG quedó en ${displayPath(ctx.workspace, svgPath)}.`)
    return `Imagen guardada: ${displayPath(ctx.workspace, pngPath)}
SVG editable: ${displayPath(ctx.workspace, svgPath)}
${summary}`
  }
})

const PublishInput = z.object({
  image_path: z.string().describe('Ruta de la imagen dentro de la carpeta de trabajo (PNG o JPEG)'),
  caption: z.string().max(CAPTION_LIMIT).describe('Texto del post, con hashtags')
})

function validatePost(path: string, caption: string): void {
  if (!existsSync(path)) throw new ToolError(`No existe la imagen ${path}.`)
  if (!['.png', '.jpg', '.jpeg'].includes(extname(path).toLowerCase())) {
    throw new ToolError('Instagram necesita una imagen PNG o JPEG.')
  }
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? []
  if (hashtags.length > HASHTAG_LIMIT) throw new ToolError(`Instagram admite hasta ${HASHTAG_LIMIT} hashtags; el texto tiene ${hashtags.length}.`)
}

export const instagramPublishTool = defineTool({
  name: 'instagram_publish',
  description:
    'Publica una imagen con su texto en la cuenta de Instagram del usuario, usando la sesión que el usuario conectó en la app. El usuario ve la imagen y el texto y aprueba o rechaza cada publicación. Usala solo cuando el post esté terminado.',
  risk: 'publish',
  schema: PublishInput,
  async preview({ image_path, caption }, ctx) {
    const path = resolveInWorkspace(ctx.workspace, image_path)
    return {
      imageDataUrl: existsSync(path) ? await imageDataUrl(path).catch(() => undefined) : undefined,
      caption,
      note: ctx.settings.instagram.testMode
        ? 'Modo de prueba activo: se completa todo menos el clic en «Compartir».'
        : undefined
    }
  },
  async run({ image_path, caption }, ctx) {
    const path = resolveInWorkspace(ctx.workspace, image_path)
    validatePost(path, caption)
    const result = await ctx.host.request({
      action: 'instagram.publish',
      imagePath: path,
      caption,
      testMode: ctx.settings.instagram.testMode
    })
    if (!result.ok) throw new ToolError(result.message)
    return result.message
  }
})
