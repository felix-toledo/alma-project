// Composes original images from Alma's library (templates, palettes, fonts, backgrounds, shapes) plus the
// user's own pieces in biblioteca/. Output is a self-contained SVG; the main process rasterizes it to PNG.
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import * as z from 'zod/v4'
import { ToolError } from '../tools/types'
import {
  BACKGROUNDS,
  contrast,
  drawBackground,
  drawFrame,
  drawGrain,
  FONTS,
  HEX,
  mulberry32,
  PALETTES,
  readableOn,
  SHAPES,
  STYLES,
  type Background,
  type Canvas,
  type Font,
  type Palette,
  type Style
} from './library'

export const ASPECT_SIZES = { '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080], '9:16': [1080, 1920] } as const

type Extra = 'quote' | 'bar' | 'panel' | 'sticker' | 'number' | 'date' | 'cta' | 'list' | 'frame'
type Corner = 'tl' | 'tr' | 'bl' | 'br'

interface ElementSpec {
  type: string
  x?: number
  y?: number
  size?: number
  color?: string
  color2?: string
  rotation?: number
  opacity?: number
}

interface Template {
  description: string
  styles: Style[]
  background: Background
  font: string
  grain?: boolean
  /** Text box as fractions of the canvas: x, y, width, height. */
  box: [number, number, number, number]
  align: 'left' | 'center'
  justify: 'start' | 'center' | 'end'
  /** Share of the box height the title may take. */
  titleShare: number
  /** Largest title size, as a fraction of the short side. */
  titleCap: number
  extras: Extra[]
  logo: Corner
  elements(rng: () => number): ElementSpec[]
}

const ABSTRACT_SHAPES = ['blob', 'circulo', 'anillo', 'semicirculo', 'ondas', 'puntos', 'lineas', 'zigzag', 'arco', 'destello', 'triangulo', 'cruz', 'estrella']
const SHAPE_COLORS = ['acento', 'acento2', 'texto', 'fondo2']

export const TEMPLATES: Record<string, Template> = {
  titular: {
    description: 'título enorme a la izquierda con barra de acento',
    styles: ['vibrante', 'minimalista'],
    background: 'degradado',
    font: 'impacto',
    box: [0.08, 0.12, 0.84, 0.78],
    align: 'left',
    justify: 'end',
    titleShare: 0.72,
    titleCap: 0.2,
    extras: ['bar'],
    logo: 'tr',
    elements: () => [
      { type: 'blob', x: 0.86, y: 0.16, size: 0.6, color: 'acento', opacity: 0.9 },
      { type: 'destello', x: 0.14, y: 0.16, size: 0.1, color: 'acento2' }
    ]
  },
  cita: {
    description: 'frase o cita centrada con comillas grandes; el autor va en subtitle',
    styles: ['elegante', 'minimalista'],
    background: 'radial',
    font: 'elegante',
    box: [0.1, 0.12, 0.8, 0.76],
    align: 'center',
    justify: 'center',
    titleShare: 0.55,
    titleCap: 0.11,
    extras: ['quote'],
    logo: 'tr',
    elements: () => [
      { type: 'anillo', x: 0.9, y: 0.1, size: 0.26, color: 'acento', opacity: 0.35 },
      { type: 'puntos', x: 0.1, y: 0.9, size: 0.18, color: 'acento', opacity: 0.45 }
    ]
  },
  anuncio: {
    description: 'novedad o lanzamiento: etiqueta (badge), título, subtítulo y botón (footer)',
    styles: ['vibrante'],
    background: 'malla',
    font: 'moderna',
    box: [0.1, 0.12, 0.8, 0.76],
    align: 'center',
    justify: 'center',
    titleShare: 0.5,
    titleCap: 0.13,
    extras: ['cta'],
    logo: 'tr',
    elements: () => [
      { type: 'destello', x: 0.16, y: 0.2, size: 0.1, color: 'texto', opacity: 0.8 },
      { type: 'destello', x: 0.86, y: 0.8, size: 0.07, color: 'texto', opacity: 0.6 }
    ]
  },
  promo: {
    description: 'oferta: sticker circular con el precio o descuento (badge) y título grande',
    styles: ['vibrante'],
    background: 'rayos',
    font: 'impacto',
    box: [0.08, 0.42, 0.84, 0.48],
    align: 'left',
    justify: 'end',
    titleShare: 0.7,
    titleCap: 0.17,
    extras: ['sticker'],
    logo: 'tl',
    elements: () => [{ type: 'confeti', x: 0.5, y: 0.5, size: 1, color: 'acento2', opacity: 0.9 }]
  },
  evento: {
    description: 'evento: fecha (badge), nombre (title), detalles (text) y lugar o link (footer)',
    styles: ['minimalista', 'vibrante'],
    background: 'cuadricula',
    font: 'geometrica',
    box: [0.08, 0.12, 0.84, 0.76],
    align: 'left',
    justify: 'center',
    titleShare: 0.42,
    titleCap: 0.12,
    extras: ['date'],
    logo: 'tr',
    elements: () => [
      { type: 'semicirculo', x: 0.88, y: 1, size: 0.55, color: 'acento', opacity: 0.9 },
      { type: 'cruz', x: 0.86, y: 0.22, size: 0.05, color: 'acento2' }
    ]
  },
  lista: {
    description: 'título y una lista de puntos (una línea de text por punto)',
    styles: ['minimalista', 'organico'],
    background: 'solido',
    grain: true,
    font: 'moderna',
    box: [0.1, 0.12, 0.8, 0.76],
    align: 'left',
    justify: 'center',
    titleShare: 0.32,
    titleCap: 0.1,
    extras: ['bar', 'list'],
    logo: 'tr',
    elements: () => [
      { type: 'circulo', x: 0.96, y: 0.04, size: 0.36, color: 'acento', opacity: 0.18 },
      { type: 'check', x: 0.88, y: 0.9, size: 0.12, color: 'acento', opacity: 0.5 }
    ]
  },
  consejo: {
    description: 'tip numerado: número grande (badge, ej. "01"), título y explicación (text)',
    styles: ['minimalista', 'organico'],
    background: 'puntos',
    font: 'geometrica',
    box: [0.1, 0.12, 0.8, 0.76],
    align: 'left',
    justify: 'center',
    titleShare: 0.38,
    titleCap: 0.1,
    extras: ['number'],
    logo: 'tr',
    elements: () => [{ type: 'arco', x: 0.88, y: 0.9, size: 0.36, color: 'acento', opacity: 0.8 }]
  },
  tarjeta: {
    description: 'tarjeta central sobre fondo con ondas y hojas; mensajes cálidos',
    styles: ['organico'],
    background: 'ondas',
    font: 'organica',
    box: [0.12, 0.13, 0.76, 0.5],
    align: 'center',
    justify: 'center',
    titleShare: 0.5,
    titleCap: 0.09,
    extras: ['panel'],
    logo: 'br',
    elements: () => [
      { type: 'hoja', x: 0.1, y: 0.08, size: 0.16, color: 'acento2', rotation: -30 },
      { type: 'hoja', x: 0.92, y: 0.6, size: 0.12, color: 'acento', rotation: 40 }
    ]
  },
  dividida: {
    description: 'bloque de color a la izquierda con un motivo y texto a la derecha',
    styles: ['elegante', 'organico'],
    background: 'mitad',
    font: 'elegante',
    box: [0.5, 0.12, 0.42, 0.76],
    align: 'left',
    justify: 'center',
    titleShare: 0.5,
    titleCap: 0.1,
    extras: ['bar'],
    logo: 'tr',
    elements: () => [{ type: 'sol', x: 0.21, y: 0.5, size: 0.3, color: 'fondo' }]
  },
  marco: {
    description: 'clásica: marco fino doble y texto centrado; premium',
    styles: ['elegante'],
    background: 'radial',
    font: 'elegante',
    box: [0.16, 0.16, 0.68, 0.68],
    align: 'center',
    justify: 'center',
    titleShare: 0.55,
    titleCap: 0.1,
    extras: ['frame'],
    logo: 'br',
    elements: () => [
      { type: 'destello', x: 0.5, y: 0.12, size: 0.05, color: 'acento' },
      { type: 'destello', x: 0.5, y: 0.88, size: 0.05, color: 'acento' }
    ]
  },
  abstracto: {
    description: 'arte abstracto con formas al azar; el texto es opcional',
    styles: STYLES,
    background: 'malla',
    font: 'moderna',
    box: [0.12, 0.3, 0.76, 0.4],
    align: 'center',
    justify: 'center',
    titleShare: 0.7,
    titleCap: 0.12,
    extras: [],
    logo: 'br',
    elements: (rng) =>
      Array.from({ length: 7 }, () => ({
        type: ABSTRACT_SHAPES[Math.floor(rng() * ABSTRACT_SHAPES.length)],
        x: rng(),
        y: rng(),
        size: 0.1 + rng() * 0.4,
        color: SHAPE_COLORS[Math.floor(rng() * SHAPE_COLORS.length)],
        rotation: Math.round(rng() * 360),
        opacity: 0.6 + rng() * 0.4
      }))
  },
  minimal: {
    description: 'mucho aire: un título breve y un solo acento',
    styles: ['minimalista'],
    background: 'solido',
    font: 'moderna',
    box: [0.15, 0.3, 0.7, 0.4],
    align: 'center',
    justify: 'center',
    titleShare: 0.8,
    titleCap: 0.075,
    extras: [],
    logo: 'br',
    elements: () => [{ type: 'circulo', x: 0.5, y: 0.24, size: 0.05, color: 'acento' }]
  }
}

const TEMPLATE_NAMES = Object.keys(TEMPLATES) as [string, ...string[]]

// ---------------------------------------------------------------------------
// Input

const Color = z.string().regex(HEX, 'Color en hex, por ejemplo #ff8800')

const PaletteColors = z.object({
  background: Color,
  background2: Color.optional(),
  text: Color.optional(),
  accents: z.array(Color).max(4).optional()
})

export const ComposeSchema = z.object({
  recipe: z.string().optional().describe('Receta de biblioteca/recetas.json: un combo ya armado; lo que pases además la completa o la cambia'),
  template: z.enum(TEMPLATE_NAMES).optional().describe('Plantilla de diseño (ver la lista en la descripción)'),
  style: z.enum(STYLES).optional().describe('Estética; si no indicás paleta o fuente, se eligen dentro de ella'),
  aspect_ratio: z.enum(['1:1', '4:5', '16:9', '9:16']).optional().describe('Formato; para Instagram usá 4:5 o 1:1'),
  palette: z.string().optional().describe('Nombre de una paleta incluida o de biblioteca/paletas.json'),
  colors: PaletteColors.optional().describe('Colores propios (por ejemplo los de marca.md); reemplazan a palette'),
  background: z.enum(BACKGROUNDS).optional().describe('Fondo; por defecto el de la plantilla'),
  font: z.string().optional().describe('Fuente del título: una incluida o un archivo de biblioteca/ sin extensión'),
  body_font: z.string().optional().describe('Fuente del resto del texto'),
  title: z.string().max(140).optional(),
  subtitle: z.string().max(200).optional(),
  text: z.string().max(600).optional().describe('Cuerpo; en la plantilla lista, una línea por punto'),
  badge: z.string().max(32).optional().describe('Etiqueta corta: "NUEVO", "-30%", "12 NOV", "01"'),
  footer: z.string().max(80).optional().describe('Pie: @usuario, web o llamada a la acción'),
  elements: z
    .array(
      z.object({
        type: z.string().describe('Forma incluida o pieza de biblioteca/ (nombre del archivo sin extensión)'),
        x: z.number().min(-0.5).max(1.5).optional().describe('Centro horizontal, 0 = izquierda, 1 = derecha'),
        y: z.number().min(-0.5).max(1.5).optional().describe('Centro vertical, 0 = arriba, 1 = abajo'),
        size: z.number().min(0.01).max(1.5).optional().describe('Tamaño relativo al lado corto (0.25 por defecto)'),
        color: z.string().optional().describe('acento, acento2, texto, fondo, fondo2 o un hex'),
        color2: z.string().optional().describe('Segundo color (detalles de las piezas que lo usan)'),
        rotation: z.number().optional(),
        opacity: z.number().min(0).max(1).optional()
      })
    )
    .max(30)
    .optional()
    .describe('Formas o piezas extra; se suman a las de la plantilla'),
  decorations: z.boolean().optional().describe('false = sin las formas que trae la plantilla, solo las de elements'),
  photo: z.string().optional().describe('Imagen de biblioteca/ (sin extensión) para usar de fondo'),
  logo: z.boolean().optional().describe('Poner biblioteca/logo.* en una esquina; por defecto sí, si existe'),
  grain: z.boolean().optional().describe('Textura de grano encima'),
  seed: z.number().int().optional().describe('Misma semilla y mismos datos = misma imagen; cambiala para otra variante'),
  svg_overlay: z
    .string()
    .max(20_000)
    .optional()
    .describe(
      'SVG propio (elementos sueltos, sin <svg>) que se dibuja sobre el fondo y debajo del texto. Coordenadas en píxeles: 1080×1080 (1:1), 1080×1350 (4:5), 1920×1080 (16:9), 1080×1920 (9:16)'
    ),
  filename: z.string().optional().describe('Nombre corto para el archivo, sin extensión')
})
export type ComposeInput = z.infer<typeof ComposeSchema>

/** One line per category, for the tool description, so the model knows every name it can use. */
export function libraryGuide(): string {
  const palettes = STYLES.map((style) => `${style}: ${Object.keys(PALETTES).filter((name) => PALETTES[name].style === style).join(', ')}`)
  return [
    `Plantillas: ${TEMPLATE_NAMES.map((name) => `${name} (${TEMPLATES[name].description})`).join('; ')}.`,
    `Paletas — ${palettes.join(' · ')}.`,
    `Fuentes: ${Object.entries(FONTS).map(([name, font]) => `${name} (${font.family})`).join(', ')}.`,
    `Fondos: ${BACKGROUNDS.join(', ')}.`,
    `Formas: ${Object.keys(SHAPES).join(', ')}.`
  ].join('\n')
}

// ---------------------------------------------------------------------------
// The user's own library: biblioteca/ in the workspace

export interface UserLibrary {
  /** SVG and raster pieces as data URLs, by lowercase file name without extension. */
  pieces: Map<string, string>
  /** SVG pieces as sanitized markup, drawn inline so `currentColor` and `var(--acento)` take the element's colors. */
  svgs: Map<string, string>
  fonts: Map<string, Font>
  palettes: Map<string, Palette>
  recipes: Map<string, ComposeInput>
}

const PIECE_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const FONT_TYPES: Record<string, string> = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' }
const MAX_PIECE_BYTES = 8 * 1024 * 1024

export const emptyLibrary = (): UserLibrary => ({ pieces: new Map(), svgs: new Map(), fonts: new Map(), palettes: new Map(), recipes: new Map() })

async function readJson(path: string, label: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new ToolError(`biblioteca/${label} no es JSON válido: ${(error as Error).message}`)
  }
}

function hex6(color: string): string {
  let h = color.slice(1)
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('')
  return `#${h.slice(0, 6).toLowerCase()}`
}

function toPalette(colors: z.infer<typeof PaletteColors>): Palette {
  const bg = hex6(colors.background)
  const ink = colors.text ? hex6(colors.text) : readableOn(bg, '#111111', '#ffffff')
  return {
    bg,
    bg2: hex6(colors.background2 ?? colors.background),
    ink,
    accents: colors.accents?.length ? colors.accents.map(hex6) : [ink]
  }
}

export async function loadLibrary(dir: string): Promise<UserLibrary> {
  const library = emptyLibrary()
  if (!existsSync(dir)) return library
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Symlinks are skipped: they could point outside the workspace.
    if (!entry.isFile()) continue
    const path = join(dir, entry.name)
    const ext = extname(entry.name).toLowerCase()
    const name = basename(entry.name, extname(entry.name)).toLowerCase()
    if (entry.name.toLowerCase() === 'recetas.json') {
      for (const [recipeName, value] of Object.entries(await readJson(path, 'recetas.json'))) {
        const recipe = ComposeSchema.omit({ recipe: true }).safeParse(value)
        if (!recipe.success) {
          throw new ToolError(
            `La receta "${recipeName}" de biblioteca/recetas.json no es válida: ${recipe.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`
          )
        }
        library.recipes.set(recipeName.toLowerCase(), recipe.data)
      }
      continue
    }
    if (entry.name.toLowerCase() === 'paletas.json') {
      for (const [paletteName, value] of Object.entries(await readJson(path, 'paletas.json'))) {
        const colors = PaletteColors.safeParse(value)
        if (!colors.success) {
          throw new ToolError(
            `La paleta "${paletteName}" de biblioteca/paletas.json no es válida. Formato: {"background": "#hex", "background2": "#hex", "text": "#hex", "accents": ["#hex"]}`
          )
        }
        library.palettes.set(paletteName.toLowerCase(), toPalette(colors.data))
      }
      continue
    }
    const mime = PIECE_TYPES[ext] ?? FONT_TYPES[ext]
    if (!mime || (await stat(path)).size > MAX_PIECE_BYTES) continue
    const bytes = await readFile(path)
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
    if (PIECE_TYPES[ext]) library.pieces.set(name, dataUrl)
    // Declared as covering every weight: a variable font renders the title bold, a static one at its own weight.
    else library.fonts.set(name, { family: `u-${name.replace(/[^a-z0-9-]+/g, '-')}`, src: dataUrl, weight: 700, charWidth: 0.6, variable: true })
    if (ext === '.svg') library.svgs.set(name, sanitizeSvg(bytes.toString('utf8').replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/gi, '')))
  }
  return library
}

// ---------------------------------------------------------------------------
// Drawing

const n = (value: number): string => String(Math.round(value * 10) / 10)

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Strips what could run code or reach the network from a model-written SVG fragment. */
export function sanitizeSvg(fragment: string): string {
  return fragment
    .replace(/<script[\s\S]*?(<\/script\s*>|$)/gi, '')
    .replace(/<foreignObject[\s\S]*?(<\/foreignObject\s*>|$)/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*)(["'])(?!\s*(?:#|data:image\/))[^"']*\2/gi, '$1$2#$2')
}

/**
 * Largest font size at which `text` wraps into `width` × `height`, estimated from the font's average glyph width.
 * ponytail: estimate, not real metrics; the browser still wraps exactly, the estimate only guards overflow.
 */
export function fitFontSize(text: string, width: number, height: number, font: Font, max: number, min = 24, lineHeight = 1.08): number {
  const paragraphs = text.split('\n').map((p) => p.split(/\s+/).filter(Boolean))
  for (let size = max; size > min; size *= 0.94) {
    const perLine = width / (size * font.charWidth)
    if (paragraphs.some((words) => words.some((word) => word.length > perLine))) continue
    let lines = 0
    for (const words of paragraphs) {
      let length = 0
      lines++
      for (const word of words) {
        if (length && length + 1 + word.length > perLine) {
          lines++
          length = word.length
        } else length += (length ? 1 : 0) + word.length
      }
    }
    if (lines * size * lineHeight <= height) return Math.floor(size)
  }
  return min
}

interface Resolved {
  canvas: Canvas
  template: Template
  title: Font
  body: Font
}

function colorOf(name: string | undefined, pal: Palette): string {
  if (!name) return pal.accents[0]
  if (HEX.test(name)) return hex6(name)
  const named: Record<string, string> = {
    acento: pal.accents[0],
    acento2: pal.accents[1] ?? pal.accents[0],
    texto: pal.ink,
    fondo: pal.bg,
    fondo2: pal.bg2
  }
  if (named[name.toLowerCase()]) return named[name.toLowerCase()]
  throw new ToolError(`Color desconocido "${name}". Usá un hex (#ff8800) o acento, acento2, texto, fondo, fondo2.`)
}

/** Places a user SVG at size `s`, centered; its `currentColor` becomes `color` and `var(--acento)` becomes `color2`. */
function inlineSvg(svg: string, s: number, color: string, color2: string): string {
  return svg.replace(/<svg\b([^>]*?)(\/?)>/i, (_match, attrs: string, selfClosing: string) => {
    let rest = attrs
    const width = /\swidth\s*=\s*["']?([\d.]+)/i.exec(rest)?.[1]
    const height = /\sheight\s*=\s*["']?([\d.]+)/i.exec(rest)?.[1]
    if (!/viewBox/i.test(rest) && width && height) rest += ` viewBox="0 0 ${width} ${height}"`
    rest = rest.replace(/\s(x|y|width|height|color)\s*=\s*("[^"]*"|'[^']*')/gi, '')
    return `<svg${rest} x="${n(-s / 2)}" y="${n(-s / 2)}" width="${n(s)}" height="${n(s)}" color="${color}" style="--acento:${color2}"${selfClosing}>`
  })
}

function drawElement(spec: ElementSpec, c: Canvas, library: UserLibrary): string {
  const key = spec.type.toLowerCase()
  const side = key === 'confeti' ? Math.max(c.w, c.h) : Math.min(c.w, c.h)
  const s = (spec.size ?? 0.25) * side
  const color = colorOf(spec.color, c.pal)
  const color2 = spec.color2 ? colorOf(spec.color2, c.pal) : color === c.pal.accents[0] ? (c.pal.accents[1] ?? c.pal.ink) : c.pal.accents[0]
  let body: string
  // The user's own pieces win over built-in shapes with the same name.
  // ponytail: ids inside a piece aren't namespaced; the same piece twice repeats them (harmless for identical defs).
  if (library.svgs.has(key)) body = inlineSvg(library.svgs.get(key)!, s, color, color2)
  else if (library.pieces.has(key)) {
    body = `<image href="${library.pieces.get(key)}" x="${n(-s / 2)}" y="${n(-s / 2)}" width="${n(s)}" height="${n(s)}" preserveAspectRatio="xMidYMid meet"/>`
  } else if (SHAPES[key]) body = SHAPES[key](s, color, color2, c.rng)
  else {
    const own = [...library.pieces.keys()]
    throw new ToolError(
      `Elemento desconocido "${spec.type}". Formas: ${Object.keys(SHAPES).join(', ')}.${own.length ? ` Piezas de biblioteca/: ${own.join(', ')}.` : ''}`
    )
  }
  const x = (spec.x ?? c.rng()) * c.w
  const y = (spec.y ?? c.rng()) * c.h
  return `<g transform="translate(${n(x)} ${n(y)}) rotate(${Math.round(spec.rotation ?? 0)})" opacity="${spec.opacity ?? 1}">${body}</g>`
}

function fontFace(font: Font): string {
  return `@font-face{font-family:'${font.family}';src:url(${font.src});font-weight:${font.variable ? '100 900' : font.weight}}`
}

function textBlock(input: ComposeInput, r: Resolved, box: { x: number; y: number; w: number; h: number }): string {
  const { canvas: c, template: t, title, body } = r
  const { pal } = c
  const u = Math.min(c.w, c.h) / 1080
  const has = (extra: Extra): boolean => t.extras.includes(extra)
  const accent = contrast(pal.bg, pal.accents[0]) >= 1.6 ? pal.accents[0] : pal.ink
  const onAccentPalette = readableOn(pal.accents[0], pal.bg, pal.ink)
  const onAccent = contrast(pal.accents[0], onAccentPalette) >= 3 ? onAccentPalette : readableOn(pal.accents[0], '#ffffff', '#111111')
  const pad = has('panel') ? box.w * 0.08 : 0
  const innerW = box.w - pad * 2

  let titleSize = 0
  if (input.title) {
    const others = input.subtitle || input.text || input.badge || input.footer || has('quote')
    const height = (box.h - pad * 2) * (others ? t.titleShare : 0.9)
    titleSize = fitFontSize(input.title, innerW, height, title, Math.min(c.w, c.h) * t.titleCap, 28 * u)
  }

  const parts: string[] = []
  if (has('quote')) parts.push('<div class="q">“</div>')
  if (input.badge && !has('sticker')) parts.push(`<div class="${has('number') ? 'num' : has('date') ? 'date' : 'badge'}">${esc(input.badge)}</div>`)
  if (has('bar') && input.title) parts.push('<div class="bar"></div>')
  if (input.title) parts.push(`<h1>${esc(input.title).replace(/\n/g, '<br/>')}</h1>`)
  if (input.subtitle) parts.push(`<h2>${esc(input.subtitle)}</h2>`)
  if (input.text) {
    const items = input.text.split('\n').map((line) => line.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean)
    parts.push(has('list') ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p>${esc(input.text)}</p>`)
  }
  if (input.footer) parts.push(`<div class="${has('cta') ? 'cta' : 'foot'}">${esc(input.footer)}</div>`)
  if (!parts.length) return ''

  const css = `
.t{box-sizing:border-box;width:100%;height:100%;padding:${n(pad)}px;display:flex;flex-direction:column;gap:${n(22 * u)}px;justify-content:${t.justify === 'center' ? 'center' : `flex-${t.justify}`};align-items:${t.align === 'center' ? 'center' : 'flex-start'};text-align:${t.align};color:${pal.ink};font-family:'${body.family}';text-shadow:${has('panel') ? 'none' : `0 0 ${n(40 * u)}px ${pal.bg}66`}}
.t h1{margin:0;font-family:'${title.family}';font-weight:${title.weight};font-size:${titleSize}px;line-height:1.06;letter-spacing:${title.uppercase ? '.01em' : '-.01em'};text-wrap:balance;overflow-wrap:break-word${title.uppercase ? ';text-transform:uppercase' : ''}}
.t h2{margin:0;font-weight:500;font-size:${n(40 * u)}px;line-height:1.2;opacity:.9;text-wrap:balance}
.t p{margin:0;font-size:${n(32 * u)}px;line-height:1.4;opacity:.85;white-space:pre-line}
.t ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:${n(16 * u)}px;text-align:left}
.t li{display:flex;gap:.6em;align-items:baseline;font-size:${n(34 * u)}px;line-height:1.3}
.t li::before{content:'';flex:none;width:.45em;height:.45em;border-radius:50%;background:${accent};transform:translateY(-.08em)}
.badge{padding:.45em 1.1em;border-radius:999px;background:${pal.accents[0]};color:${onAccent};font-weight:700;font-size:${n(24 * u)}px;letter-spacing:.14em;text-transform:uppercase;text-shadow:none}
.num{font-family:'${title.family}';font-weight:${title.weight};font-size:${n(170 * u)}px;line-height:.9;color:${accent}}
.date{padding:.3em .7em;border-radius:${n(18 * u)}px;background:${pal.accents[0]};color:${onAccent};font-family:'${title.family}';font-weight:${title.weight};font-size:${n(46 * u)}px;line-height:1.1;text-shadow:none}
.bar{flex:none;width:${n(110 * u)}px;height:${n(12 * u)}px;border-radius:${n(6 * u)}px;background:${accent}}
.q{font-family:'${title.family}';font-size:${n(200 * u)}px;line-height:1;height:${n(110 * u)}px;color:${accent}}
.cta{margin-top:${n(12 * u)}px;padding:.7em 1.6em;border-radius:999px;background:${pal.accents[0]};color:${onAccent};font-weight:700;font-size:${n(30 * u)}px;text-shadow:none}
.foot{font-size:${n(28 * u)}px;opacity:.8;letter-spacing:.04em;font-weight:500}`
  return `<style>${css}</style><foreignObject x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" overflow="visible"><div xmlns="http://www.w3.org/1999/xhtml" class="t">${parts.join('')}</div></foreignObject>`
}

function sticker(badge: string, r: Resolved): string {
  const { canvas: c, title } = r
  const radius = Math.min(c.w, c.h) * 0.17
  const u = Math.min(c.w, c.h) / 1080
  const on = readableOn(c.pal.accents[0], c.pal.bg, c.pal.ink, '#ffffff', '#111111')
  const size = fitFontSize(badge, radius * 1.4, radius * 0.9, title, radius * 0.75, 20 * u, 1)
  return `<g transform="translate(${n(c.w * 0.76)} ${n(c.h * 0.2)}) rotate(-12)"><circle r="${n(radius)}" fill="${c.pal.accents[0]}"/><circle r="${n(radius * 0.88)}" fill="none" stroke="${on}" stroke-width="${n(3 * u)}" stroke-dasharray="${n(8 * u)} ${n(10 * u)}" opacity=".6"/><foreignObject x="${n(-radius)}" y="${n(-radius)}" width="${n(radius * 2)}" height="${n(radius * 2)}"><div xmlns="http://www.w3.org/1999/xhtml" style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center;color:${on};font-family:'${title.family}';font-weight:${title.weight};font-size:${size}px;line-height:1">${esc(badge)}</div></foreignObject></g>`
}

function pickFont(name: string | undefined, library: UserLibrary, fallback: string): Font {
  const key = (name ?? fallback).toLowerCase()
  const font = library.fonts.get(key) ?? FONTS[key]
  if (font) return font
  const own = [...library.fonts.keys()]
  throw new ToolError(`Fuente desconocida "${name}". Incluidas: ${Object.keys(FONTS).join(', ')}.${own.length ? ` De biblioteca/: ${own.join(', ')}.` : ''}`)
}

export interface Composition {
  svg: string
  width: number
  height: number
  summary: string
}

/** Fills the input from its recipe; what the caller passes wins, and elements add up. */
function withRecipe(input: ComposeInput, library: UserLibrary): ComposeInput {
  if (!input.recipe) return input
  const recipe = library.recipes.get(input.recipe.toLowerCase())
  if (!recipe) {
    const own = [...library.recipes.keys()]
    throw new ToolError(`Receta desconocida "${input.recipe}". ${own.length ? `En biblioteca/recetas.json: ${own.join(', ')}.` : 'No hay biblioteca/recetas.json.'}`)
  }
  const given = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  return { ...recipe, ...given, elements: [...(recipe.elements ?? []), ...(input.elements ?? [])] }
}

export function compose(raw: ComposeInput, library: UserLibrary = emptyLibrary()): Composition {
  const input = withRecipe(raw, library)
  const seed = input.seed ?? Math.floor(Math.random() * 1_000_000)
  const rng = mulberry32(seed)
  const pick = <T>(items: T[]): T => items[Math.floor(rng() * items.length)]
  const [w, h] = ASPECT_SIZES[input.aspect_ratio ?? '4:5']

  const hasText = !!(input.title || input.subtitle || input.text || input.badge)
  const templateName =
    input.template ??
    (hasText ? pick(TEMPLATE_NAMES.filter((name) => name !== 'abstracto' && (!input.style || TEMPLATES[name].styles.includes(input.style)))) : 'abstracto')
  const template = TEMPLATES[templateName]
  const style = input.style ?? pick(template.styles)

  // Palette: explicit colors, then a named one, then the user's own palettes, then one that fits the style.
  let paletteName: string
  let pal: Palette
  if (input.colors) {
    paletteName = 'propia'
    pal = toPalette(input.colors)
  } else if (input.palette) {
    paletteName = input.palette.toLowerCase()
    const found = library.palettes.get(paletteName) ?? PALETTES[paletteName]
    if (!found) {
      const own = [...library.palettes.keys()]
      throw new ToolError(`Paleta desconocida "${input.palette}". Incluidas: ${Object.keys(PALETTES).join(', ')}.${own.length ? ` De biblioteca/paletas.json: ${own.join(', ')}.` : ''}`)
    }
    pal = found
  } else if (library.palettes.size) {
    paletteName = pick([...library.palettes.keys()])
    pal = library.palettes.get(paletteName)!
  } else {
    paletteName = pick(Object.keys(PALETTES).filter((name) => PALETTES[name].style === style))
    pal = PALETTES[paletteName]
  }
  if (contrast(pal.bg, pal.ink) < 3) pal = { ...pal, ink: readableOn(pal.bg, '#111111', '#ffffff') }

  const defaultFont = input.style ? pick(Object.keys(FONTS).filter((name) => FONTS[name].style === input.style)) : template.font
  const title = pickFont(input.font, library, defaultFont)
  const body = input.body_font
    ? pickFont(input.body_font, library, 'moderna')
    : ['Outfit', 'Space Grotesk'].includes(title.family)
      ? title
      : FONTS.moderna
  const canvas: Canvas = { w, h, pal, rng, defs: [] }
  const resolved: Resolved = { canvas, template, title, body }
  const background = input.background ?? template.background

  const layers: string[] = [drawBackground(background, canvas)]
  if (input.photo) {
    const photo = library.pieces.get(input.photo.toLowerCase())
    if (!photo) throw new ToolError(`No hay una imagen "${input.photo}" en biblioteca/.`)
    layers.push(`<image href="${photo}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/><rect width="${w}" height="${h}" fill="${pal.bg}" opacity=".5"/>`)
  }
  const decorations = input.decorations === false ? [] : template.elements(rng)
  for (const spec of [...decorations, ...(input.elements ?? [])]) layers.push(drawElement(spec, canvas, library))
  if (template.extras.includes('frame')) layers.push(drawFrame(canvas, pal.accents[0]))
  if (input.grain ?? template.grain) layers.push(drawGrain(canvas))
  if (input.svg_overlay) layers.push(`<g>${sanitizeSvg(input.svg_overlay)}</g>`)

  const short = Math.min(w, h)
  const box = { x: template.box[0] * w, y: template.box[1] * h, w: template.box[2] * w, h: template.box[3] * h }
  const logo = input.logo === false ? undefined : library.pieces.get('logo')
  if (logo) {
    const size = short * 0.1
    const margin = short * 0.065
    const x = template.logo.endsWith('l') ? margin : w - margin - size
    const y = template.logo.startsWith('t') ? margin : h - margin - size
    layers.push(`<image href="${logo}" x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" preserveAspectRatio="xMidYMid meet"/>`)
    // Keep the text clear of a logo in a top corner.
    const clear = margin + size + short * 0.02
    if (template.logo.startsWith('t') && box.y < clear) {
      box.h -= clear - box.y
      box.y = clear
    }
  }
  if (template.extras.includes('panel')) {
    layers.push(`<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" rx="${n(36 * (short / 1080))}" fill="${pal.ink}" fill-opacity=".08" stroke="${pal.ink}" stroke-opacity=".22" stroke-width="${n(2 * (short / 1080))}"/>`)
  }
  if (template.extras.includes('sticker') && input.badge) layers.push(sticker(input.badge, resolved))
  layers.push(textBlock(input, resolved, box))

  const faces = [...new Set([title, body])].map(fontFace).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><style>${faces}</style>${canvas.defs.join('')}</defs>${layers.join('')}</svg>`
  const fontName = Object.keys(FONTS).find((name) => FONTS[name] === title) ?? title.family
  return {
    svg,
    width: w,
    height: h,
    summary: `${input.recipe ? `Receta: ${input.recipe} · ` : ''}Plantilla: ${templateName} · paleta: ${paletteName} · fondo: ${input.photo ? `foto ${input.photo}` : background} · fuente: ${fontName} · semilla: ${seed} · ${w}×${h}`
  }
}
