// Alma's built-in image library: palettes, fonts, backgrounds and shapes. Combined by compose() into
// original images when there is no image model (DeepSeek, or no xAI/OpenAI key).
import bebas from '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff2?inline'
import pacifico from '@fontsource/pacifico/files/pacifico-latin-400-normal.woff2?inline'
import caveat from '@fontsource-variable/caveat/files/caveat-latin-wght-normal.woff2?inline'
import fraunces from '@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2?inline'
import outfit from '@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?inline'
import playfair from '@fontsource-variable/playfair-display/files/playfair-display-latin-wght-normal.woff2?inline'
import spaceGrotesk from '@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2?inline'

export type Style = 'minimalista' | 'vibrante' | 'elegante' | 'organico'
export const STYLES: Style[] = ['minimalista', 'vibrante', 'elegante', 'organico']

export interface Palette {
  bg: string
  bg2: string
  ink: string
  accents: string[]
}

const pal = (style: Style, bg: string, bg2: string, ink: string, ...accents: string[]): Palette & { style: Style } => ({
  style,
  bg,
  bg2,
  ink,
  accents
})

export const PALETTES: Record<string, Palette & { style: Style }> = {
  papel: pal('minimalista', '#f5f3ee', '#e7e3da', '#1c1c1c', '#e4572e', '#a8a39a'),
  nieve: pal('minimalista', '#ffffff', '#eef1f5', '#111827', '#2563eb', '#93c5fd'),
  grafito: pal('minimalista', '#18181b', '#27272a', '#fafafa', '#a3e635', '#52525b'),
  niebla: pal('minimalista', '#e8ecef', '#cfd8dc', '#263238', '#ff7043', '#607d8b'),
  neon: pal('vibrante', '#0f0326', '#2b0a5c', '#ffffff', '#ff2e88', '#00f5d4'),
  citrico: pal('vibrante', '#ffd60a', '#ff9f1c', '#1a1a1a', '#ff006e', '#3a86ff'),
  caramelo: pal('vibrante', '#ffc2d1', '#ff8fab', '#2b2d42', '#7209b7', '#ffe066'),
  oceano: pal('vibrante', '#0077b6', '#00b4d8', '#ffffff', '#ffd166', '#ef476f'),
  'noche-dorada': pal('elegante', '#0b0b0f', '#1c1a17', '#f5ecd7', '#c9a227', '#6b5b3e'),
  vino: pal('elegante', '#3b0a1a', '#5c1028', '#f8e9e4', '#d4af37', '#a34a5f'),
  marfil: pal('elegante', '#f7f1e3', '#ede3cc', '#2b2118', '#b08d57', '#7a6a53'),
  esmeralda: pal('elegante', '#06281f', '#0f3d30', '#eef5ef', '#d4b46a', '#2e7d5b'),
  tierra: pal('organico', '#e9dcc9', '#d8c3a5', '#3e2c1c', '#b5651d', '#6b8e23'),
  bosque: pal('organico', '#1f3b2d', '#2d5a3d', '#f1ead8', '#d9a441', '#8fbf7f'),
  arcilla: pal('organico', '#c4643f', '#d97b5b', '#fff4e6', '#2f4858', '#f2c57c'),
  salvia: pal('organico', '#dfe6da', '#c5d1bd', '#2f3e2c', '#7c9a6d', '#c08552')
}

export interface Font {
  family: string
  src: string
  weight: number
  /** Average glyph width in ems, for fitting text without a layout engine. */
  charWidth: number
  uppercase?: boolean
  /** Variable fonts cover every weight; static ones only their own, so the browser must not fake bold. */
  variable?: boolean
}

export const FONTS: Record<string, Font & { style: Style }> = {
  moderna: { family: 'Outfit', variable: true, src: outfit, weight: 700, charWidth: 0.55, style: 'minimalista' },
  geometrica: { family: 'Space Grotesk', variable: true, src: spaceGrotesk, weight: 700, charWidth: 0.62, style: 'minimalista' },
  impacto: { family: 'Bebas Neue', src: bebas, weight: 400, charWidth: 0.44, uppercase: true, style: 'vibrante' },
  pop: { family: 'Pacifico', src: pacifico, weight: 400, charWidth: 0.64, style: 'vibrante' },
  elegante: { family: 'Playfair Display', variable: true, src: playfair, weight: 700, charWidth: 0.58, style: 'elegante' },
  organica: { family: 'Fraunces', variable: true, src: fraunces, weight: 600, charWidth: 0.58, style: 'organico' },
  manuscrita: { family: 'Caveat', variable: true, src: caveat, weight: 700, charWidth: 0.44, style: 'organico' }
}

/** Shared drawing state for one image. */
export interface Canvas {
  w: number
  h: number
  pal: Palette
  rng: () => number
  defs: string[]
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const n = (value: number): string => String(Math.round(value * 10) / 10)

// ---------------------------------------------------------------------------
// Backgrounds

export const BACKGROUNDS = ['solido', 'degradado', 'radial', 'malla', 'puntos', 'cuadricula', 'rayas', 'rayos', 'ondas', 'mitad'] as const
export type Background = (typeof BACKGROUNDS)[number]

export function drawBackground(kind: Background, c: Canvas): string {
  const { w, h, pal, rng } = c
  const base = `<rect width="${w}" height="${h}" fill="${pal.bg}"/>`
  const unit = Math.min(w, h) / 1080
  switch (kind) {
    case 'solido':
      return base
    case 'degradado': {
      const angle = Math.round(rng() * 360)
      c.defs.push(
        `<linearGradient id="bg-grad" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="${pal.bg}"/><stop offset="1" stop-color="${pal.bg2}"/></linearGradient>`
      )
      return `<rect width="${w}" height="${h}" fill="url(#bg-grad)"/>`
    }
    case 'radial':
      c.defs.push(
        `<radialGradient id="bg-grad" cx="${n(0.3 + rng() * 0.4)}" cy="${n(0.25 + rng() * 0.3)}" r=".9"><stop offset="0" stop-color="${pal.bg2}"/><stop offset="1" stop-color="${pal.bg}"/></radialGradient>`
      )
      return `<rect width="${w}" height="${h}" fill="url(#bg-grad)"/>`
    case 'malla': {
      c.defs.push(
        `<filter id="bg-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(Math.min(w, h) * 0.12)}"/></filter>`
      )
      const colors = [pal.bg2, pal.accents[0], pal.accents[1] ?? pal.bg2, pal.bg2]
      const blobs = colors
        .map(
          (color, i) =>
            `<circle cx="${n(w * rng())}" cy="${n(h * rng())}" r="${n(Math.max(w, h) * (0.25 + rng() * 0.2))}" fill="${color}" opacity="${i === 1 || i === 2 ? 0.55 : 0.9}"/>`
        )
        .join('')
      return `${base}<g filter="url(#bg-blur)">${blobs}</g>`
    }
    case 'puntos': {
      const gap = n(36 * unit)
      c.defs.push(
        `<pattern id="bg-pat" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse"><circle cx="${n(18 * unit)}" cy="${n(18 * unit)}" r="${n(3 * unit)}" fill="${pal.ink}" opacity=".14"/></pattern>`
      )
      return `${base}<rect width="${w}" height="${h}" fill="url(#bg-pat)"/>`
    }
    case 'cuadricula': {
      const gap = n(60 * unit)
      c.defs.push(
        `<pattern id="bg-pat" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse"><path d="M${gap} 0H0V${gap}" fill="none" stroke="${pal.ink}" stroke-opacity=".08" stroke-width="${n(2 * unit)}"/></pattern>`
      )
      return `${base}<rect width="${w}" height="${h}" fill="url(#bg-pat)"/>`
    }
    case 'rayas': {
      const gap = n(48 * unit)
      c.defs.push(
        `<pattern id="bg-pat" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="${n(24 * unit)}" height="${gap}" fill="${pal.bg2}"/></pattern>`
      )
      return `${base}<rect width="${w}" height="${h}" fill="url(#bg-pat)"/>`
    }
    case 'rayos': {
      const cx = w * (0.3 + rng() * 0.4)
      const cy = h * (0.3 + rng() * 0.4)
      const r = Math.hypot(w, h)
      const count = 24
      let wedges = ''
      for (let i = 0; i < count; i += 2) {
        const a1 = (i / count) * Math.PI * 2
        const a2 = ((i + 1) / count) * Math.PI * 2
        wedges += `<path d="M${n(cx)} ${n(cy)}L${n(cx + Math.cos(a1) * r)} ${n(cy + Math.sin(a1) * r)}L${n(cx + Math.cos(a2) * r)} ${n(cy + Math.sin(a2) * r)}Z"/>`
      }
      return `${base}<g fill="${pal.bg2}">${wedges}</g>`
    }
    case 'ondas': {
      const colors = [pal.bg2, pal.accents[1] ?? pal.bg2, pal.accents[0]]
      return (
        base +
        colors
          .map((color, i) => {
            const y = h * (0.66 + i * 0.1)
            const a = h * (0.03 + rng() * 0.04)
            return `<path d="M0 ${n(y)}Q${n(w / 8)} ${n(y - a)} ${n(w / 4)} ${n(y)}T${n(w / 2)} ${n(y)}T${n((3 * w) / 4)} ${n(y)}T${w} ${n(y)}V${h}H0Z" fill="${color}" opacity="${i === 0 ? 1 : 0.85}"/>`
          })
          .join('')
      )
    }
    case 'mitad':
      return `${base}<rect width="${n(w * 0.42)}" height="${h}" fill="${pal.accents[0]}"/>`
  }
}

/** Film grain over everything; gives flat vector colors a printed, organic feel. */
export function drawGrain(c: Canvas): string {
  c.defs.push(
    `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>`
  )
  return `<rect width="${c.w}" height="${c.h}" filter="url(#grain)" opacity=".13" style="mix-blend-mode:overlay"/>`
}

// ---------------------------------------------------------------------------
// Shapes. Each draws centered on (0, 0) at size `s`; the caller positions, rotates and fades it.

type ShapeDraw = (s: number, color: string, color2: string, rng: () => number) => string

function blobPath(r: number, rng: () => number): string {
  const count = 7
  const pts = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + (rng() - 0.5) * 0.5
    const radius = r * (0.72 + rng() * 0.32)
    return [Math.cos(a) * radius, Math.sin(a) * radius]
  })
  const at = (i: number): number[] => pts[(i + count) % count]
  let d = `M${n(pts[0][0])} ${n(pts[0][1])}`
  // Catmull-Rom through the points, as cubic Bezier curves: a smooth closed blob.
  for (let i = 0; i < count; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
    d += `C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`
  }
  return d + 'Z'
}

function star(points: number, outer: number, inner: number): string {
  const coords: string[] = []
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
    coords.push(`${n(Math.cos(a) * r)},${n(Math.sin(a) * r)}`)
  }
  return coords.join(' ')
}

/** Icon paths drawn on a 24×24 grid centered at 12,12. */
const icon = (d: string, filled: boolean): ShapeDraw => (s, color) =>
  `<path transform="scale(${(s / 24).toFixed(3)}) translate(-12 -12)" d="${d}" ${
    filled ? `fill="${color}"` : `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`
  }/>`

export const SHAPES: Record<string, ShapeDraw> = {
  circulo: (s, color) => `<circle r="${n(s / 2)}" fill="${color}"/>`,
  anillo: (s, color) => `<circle r="${n(s * 0.46)}" fill="none" stroke="${color}" stroke-width="${n(s * 0.08)}"/>`,
  semicirculo: (s, color) => `<path d="M${n(-s / 2)} 0A${n(s / 2)} ${n(s / 2)} 0 0 1 ${n(s / 2)} 0Z" fill="${color}"/>`,
  blob: (s, color, _c2, rng) => `<path d="${blobPath(s / 2, rng)}" fill="${color}"/>`,
  ondas: (s, color) => {
    const a = s * 0.06
    let lines = ''
    for (let i = 0; i < 4; i++) {
      const y = -s * 0.3 + i * s * 0.2
      lines += `<path d="M${n(-s / 2)} ${n(y)}q${n(s / 8)} ${n(-a)} ${n(s / 4)} 0t${n(s / 4)} 0t${n(s / 4)} 0t${n(s / 4)} 0"/>`
    }
    return `<g fill="none" stroke="${color}" stroke-width="${n(s * 0.035)}" stroke-linecap="round">${lines}</g>`
  },
  puntos: (s, color) => {
    let dots = ''
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) dots += `<circle cx="${n(-s / 2 + (i + 0.5) * (s / 6))}" cy="${n(-s / 2 + (j + 0.5) * (s / 6))}" r="${n(s * 0.025)}"/>`
    return `<g fill="${color}">${dots}</g>`
  },
  lineas: (s, color) => {
    let lines = ''
    for (let i = 0; i < 7; i++) {
      const o = -s / 2 + (i * s) / 6
      lines += `<path d="M${n(o - s * 0.15)} ${n(s / 2)}L${n(o + s * 0.15)} ${n(-s / 2)}"/>`
    }
    return `<g stroke="${color}" stroke-width="${n(s * 0.03)}" stroke-linecap="round">${lines}</g>`
  },
  zigzag: (s, color) => {
    const pts: string[] = []
    for (let i = 0; i <= 8; i++) pts.push(`${n(-s / 2 + (i * s) / 8)},${n(i % 2 ? -s * 0.08 : s * 0.08)}`)
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${n(s * 0.04)}" stroke-linejoin="round" stroke-linecap="round"/>`
  },
  arco: (s, color) =>
    `<path d="M${n(-s * 0.42)} ${n(s * 0.2)}A${n(s * 0.42)} ${n(s * 0.42)} 0 0 1 ${n(s * 0.42)} ${n(s * 0.2)}" fill="none" stroke="${color}" stroke-width="${n(s * 0.12)}" stroke-linecap="round"/>`,
  destello: (s, color) => {
    const r = s / 2
    return `<path d="M0 ${n(-r)}Q0 0 ${n(r)} 0Q0 0 0 ${n(r)}Q0 0 ${n(-r)} 0Q0 0 0 ${n(-r)}Z" fill="${color}"/>`
  },
  estrella: (s, color) => `<polygon points="${star(5, s / 2, s / 4.6)}" fill="${color}"/>`,
  triangulo: (s, color) => `<polygon points="0,${n(-s / 2)} ${n(s * 0.48)},${n(s * 0.36)} ${n(-s * 0.48)},${n(s * 0.36)}" fill="${color}"/>`,
  cruz: (s, color) =>
    `<path d="M0 ${n(-s / 2)}V${n(s / 2)}M${n(-s / 2)} 0H${n(s / 2)}" stroke="${color}" stroke-width="${n(s * 0.18)}" stroke-linecap="round"/>`,
  hoja: (s, color, color2) => {
    const r = s / 2
    return `<path d="M0 ${n(-r)}C${n(r * 0.75)} ${n(-r * 0.45)} ${n(r * 0.75)} ${n(r * 0.45)} 0 ${n(r)}C${n(-r * 0.75)} ${n(r * 0.45)} ${n(-r * 0.75)} ${n(-r * 0.45)} 0 ${n(-r)}Z" fill="${color}"/><path d="M0 ${n(-r * 0.8)}V${n(r)}" stroke="${color2}" stroke-width="${n(s * 0.025)}" opacity=".6"/>`
  },
  sol: (s, color) => {
    let rays = ''
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      rays += `<path d="M${n(Math.cos(a) * s * 0.34)} ${n(Math.sin(a) * s * 0.34)}L${n(Math.cos(a) * s * 0.48)} ${n(Math.sin(a) * s * 0.48)}"/>`
    }
    return `<circle r="${n(s * 0.24)}" fill="${color}"/><g stroke="${color}" stroke-width="${n(s * 0.04)}" stroke-linecap="round">${rays}</g>`
  },
  montanas: (s, color, color2) =>
    `<polygon points="${n(-s / 2)},${n(s * 0.3)} ${n(-s * 0.1)},${n(-s * 0.3)} ${n(s * 0.3)},${n(s * 0.3)}" fill="${color2}"/><polygon points="${n(-s * 0.15)},${n(s * 0.3)} ${n(s * 0.2)},${n(-s * 0.12)} ${n(s / 2)},${n(s * 0.3)}" fill="${color}"/>`,
  confeti: (s, color, color2, rng) => {
    let bits = ''
    for (let i = 0; i < 26; i++) {
      const x = n((rng() - 0.5) * s)
      const y = n((rng() - 0.5) * s)
      const size = s * (0.012 + rng() * 0.018)
      const fill = i % 2 ? color : color2
      bits +=
        i % 3
          ? `<rect x="${x}" y="${y}" width="${n(size * 2.2)}" height="${n(size)}" rx="${n(size / 3)}" fill="${fill}" transform="rotate(${Math.round(rng() * 180)} ${x} ${y})"/>`
          : `<circle cx="${x}" cy="${y}" r="${n(size * 0.7)}" fill="${fill}"/>`
    }
    return bits
  },
  corazon: icon('M12 20.5s-7.6-4.6-9.5-9.3C1 7.6 3.3 4 7 4c2.1 0 3.7 1.1 5 3 1.3-1.9 2.9-3 5-3 3.7 0 6 3.6 4.5 7.2-1.9 4.7-9.5 9.3-9.5 9.3z', true),
  rayo: icon('M13.5 2 4.5 13.5h6.5L10 22l9.5-12H13l.5-8z', true),
  luna: icon('M20 14.6A8.4 8.4 0 1 1 9.4 4a6.8 6.8 0 0 0 10.6 10.6z', true),
  flecha: icon('M4 12h15M13 5.5l6.5 6.5-6.5 6.5', false),
  check: icon('M4.5 12.5l5 5L19.5 7', false),
  burbuja: icon('M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17.5H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z', true)
}

/** A full-canvas thin frame; drawn by compose() instead of as a positioned shape. */
export function drawFrame(c: Canvas, color: string): string {
  const m = Math.min(c.w, c.h) * 0.045
  const u = Math.min(c.w, c.h) / 1080
  return `<rect x="${n(m)}" y="${n(m)}" width="${n(c.w - 2 * m)}" height="${n(c.h - 2 * m)}" fill="none" stroke="${color}" stroke-width="${n(3 * u)}"/><rect x="${n(m + 14 * u)}" y="${n(m + 14 * u)}" width="${n(c.w - 2 * m - 28 * u)}" height="${n(c.h - 2 * m - 28 * u)}" fill="none" stroke="${color}" stroke-width="${n(1.2 * u)}" opacity=".6"/>`
}

// ---------------------------------------------------------------------------
// Color helpers

function rgb(hex: string): number[] {
  let h = hex.slice(1)
  if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Whichever of the candidates reads best on `bg`. */
export function readableOn(bg: string, ...candidates: string[]): string {
  return candidates.reduce((best, c) => (contrast(bg, c) > contrast(bg, best) ? c : best))
}

export const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
