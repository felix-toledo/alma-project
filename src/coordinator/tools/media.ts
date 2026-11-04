import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import * as z from 'zod/v4'
import { compose, ComposeSchema, libraryGuide, libraryPath, loadLibrary } from '../compose'
import { generateImage, imageMimeType } from '../images'
import { displayPath, resolveInWorkspace } from './paths'
import { translate } from '../../shared/i18n/messages'
import { defineTool, languageOf, ToolError, toolText } from './types'

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
  if (statSync(path).size > MAX_PREVIEW_BYTES) throw new ToolError('tool.image.previewTooBig')
  const bytes = await readFile(path)
  const mime = imageMimeType(bytes)
  if (!mime) throw new ToolError('tool.image.notImage')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

export const generateImageTool = defineTool({
  name: 'generate_image',
  description:
    'Generates an image from a description and saves it in the imagenes/ folder of the working folder. Returns the file path. Use it when you need an original image (for example for a post). Describe subject, style, light and framing.',
  risk: 'write',
  schema: z.object({
    prompt: z.string().min(10).describe('Detailed description of the image'),
    aspect_ratio: z.enum(['1:1', '4:5', '16:9', '9:16']).optional().describe('Format; for Instagram use 4:5 or 1:1'),
    filename: z.string().optional().describe('Short name for the file, without extension')
  }),
  async run({ prompt, aspect_ratio = '1:1', filename }, ctx) {
    const { bytes, model } = await generateImage(ctx.settings, prompt, aspect_ratio, ctx.signal).catch((error: Error) => {
      throw new ToolError('tool.image.failed', { error: error.message })
    })
    const mime = imageMimeType(bytes)
    if (!mime) throw new ToolError('tool.image.notAnImage')
    const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'
    const target = resolveInWorkspace(ctx.workspace, `imagenes/${slugify(filename || prompt)}-${timestamp()}.${ext}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
    return toolText(ctx, 'tool.image.saved', { path: displayPath(ctx.workspace, target), model, kb: (bytes.length / 1024).toFixed(0), ratio: aspect_ratio })
  }
})

export const composeImageTool = defineTool({
  name: 'compose_image',
  description: `Builds an original image without an image model, combining Alma's library (templates, palettes, fonts, backgrounds and shapes) with the user's pieces in biblioteca/ (logos and SVG or photos .svg/.png/.jpg, fonts .ttf/.otf/.woff2, palettes in paletas.json). Saves a PNG and an editable SVG in imagenes/ and returns the path. Use it when there is no image generator or for posts with text (quotes, announcements, promos, lists). If biblioteca/recetas.json exists, start from a recipe (recipe): it brings the brand's template, colors, fonts and pieces already chosen, and you fill in the texts. If marca.md defines colors or fonts, pass them in colors and font. For another variant, change the seed (seed).
${libraryGuide()}`,
  risk: 'write',
  schema: ComposeSchema,
  async run(input, ctx) {
    const library = await loadLibrary(libraryPath(ctx.workspace, languageOf(ctx)), languageOf(ctx))
    const { svg, width, height, summary } = compose(input, library)
    const base = `imagenes/${slugify(input.filename || input.title || input.template || 'alma')}-${timestamp()}`
    const svgPath = resolveInWorkspace(ctx.workspace, `${base}.svg`)
    const pngPath = resolveInWorkspace(ctx.workspace, `${base}.png`)
    await mkdir(dirname(svgPath), { recursive: true })
    await writeFile(svgPath, svg)
    const rendered = await ctx.host.request({ action: 'image.render', svg, width, height, outPath: pngPath })
    if (!rendered.ok) throw new ToolError('tool.compose.renderFailed', { error: rendered.message, path: displayPath(ctx.workspace, svgPath) })
    return toolText(ctx, 'tool.compose.saved', { png: displayPath(ctx.workspace, pngPath), svg: displayPath(ctx.workspace, svgPath), data: summary })
  }
})

const PublishInput = z.object({
  image_path: z.string().describe('Path of the image inside the working folder (PNG or JPEG)'),
  caption: z.string().max(CAPTION_LIMIT).describe('Text of the post, with hashtags')
})

function validatePost(path: string, caption: string): void {
  if (!existsSync(path)) throw new ToolError('tool.image.noFile', { path })
  if (!['.png', '.jpg', '.jpeg'].includes(extname(path).toLowerCase())) {
    throw new ToolError('tool.image.instagramFormat')
  }
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? []
  if (hashtags.length > HASHTAG_LIMIT) throw new ToolError('tool.image.hashtags', { max: HASHTAG_LIMIT, count: hashtags.length })
}

export const instagramPublishTool = defineTool({
  name: 'instagram_publish',
  description:
    "Publishes an image with its text to the user's Instagram account, using the session the user connected in the app. The user sees the image and the text and approves or rejects each publication. Use it only when the post is finished.",
  risk: 'publish',
  schema: PublishInput,
  async preview({ image_path, caption }, ctx) {
    const path = resolveInWorkspace(ctx.workspace, image_path)
    return {
      imageDataUrl: existsSync(path) ? await imageDataUrl(path).catch(() => undefined) : undefined,
      caption,
      note: ctx.settings.instagram.testMode
        ? translate(languageOf(ctx), 'preview.instagramTest')
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
    if (!result.ok) throw new ToolError('tool.error', { data: result.message })
    return result.message
  }
})
