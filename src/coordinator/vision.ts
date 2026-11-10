// "Mirá esta imagen": a one-shot question to a model that can see. Used for floor plan photos, camera stills and
// pictures the user sends. Agents never carry images in their conversation; they get the answer as text.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { ENV_KEYS, hasKey } from '../shared/attach/readers'
import { DEEPSEEK_BASE_URL, META_BASE_URL, PROVIDER_NAMES, VERCEL_BASE_URL } from '../shared/defaults'
import { hasSeeRule, pickSeeModel } from '../shared/images/models'
import { resolveVision } from '../shared/images/vision'
import type { ProviderId, Settings, Usage } from '../shared/types'
import { VISION_SYSTEM } from './prompts/vision'
import { getProvider } from './providers'
import { ToolError } from './tools/types'

export interface Picture {
  mediaType: string
  /** base64 without the data: prefix */
  data: string
  /** Pixels, when the header could be read. */
  width?: number
  height?: number
}

/** Width and height from the file header (PNG, JPEG, GIF, WebP); null when it isn't one of those. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  if (bytes.length > 10 && bytes.toString('latin1', 0, 3) === 'GIF') return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes.length > 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const kind = bytes.toString('latin1', 12, 16)
    if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
    if (kind === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const bits = bytes.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) }
      i += 2 + bytes.readUInt16BE(i + 2)
    }
  }
  return null
}

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }
const MAX_BYTES = 8 * 1024 * 1024

/**
 * The model that looks. Who it is comes from `resolveVision` (the gate of spec 038 BR-14, read at every look, so camera watches
 * obey it too); a chosen provider with no model is completed here. Keys are read from the process environment.
 */
export async function visionModel(settings: Settings): Promise<{ provider: ProviderId; model: string }> {
  const { provider, model, via } = resolveVision(settings, (p) => hasKey(settings, p, process.env))
  if (model || via === 'fallback') return { provider, model }
  if (!hasSeeRule(provider)) throw new ToolError('tool.vision.noModel', { provider: PROVIDER_NAMES[provider] })
  return { provider, model: await pickedSeeModel(settings, provider) }
}

const BASE_URLS: Record<ProviderId, (settings: Settings) => string> = {
  anthropic: () => '',
  xai: (settings) => settings.providers.xai.baseUrl,
  deepseek: () => DEEPSEEK_BASE_URL,
  vercel: () => VERCEL_BASE_URL,
  meta: () => META_BASE_URL
}

export const MAX_PICKS = 32
export const LIST_TIMEOUT_MS = 15_000
/** Joins the `error` slot of tool.vision.listFailed, where a provider's own (English) error text goes too. */
const TIMED_OUT = 'the provider did not answer in time'

/** Picks of the models that see, per provider + URL + a digest of the key, for the life of the process; a failure is never kept (BR-12). Oldest out past MAX_PICKS. */
const picks = new Map<string, Promise<string>>()

/** The work, or a rejection if it takes longer than `ms`; the timer never outlives the race. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

function pickedSeeModel(settings: Settings, provider: ProviderId): Promise<string> {
  const key = settings.providers[provider].apiKey || process.env[ENV_KEYS[provider]] || ''
  const cacheKey = `${provider}|${BASE_URLS[provider](settings)}|${createHash('sha256').update(key).digest('hex').slice(0, 16)}`
  let pick = picks.get(cacheKey)
  if (!pick) {
    const name = PROVIDER_NAMES[provider]
    const entry = (async () => {
      let ids: string[]
      try {
        ids = await withTimeout(getProvider(provider, settings).listModels(), LIST_TIMEOUT_MS)
      } catch (error) {
        // The provider's own words, minus the key if it echoed it back (AC-4.5).
        const text = error instanceof Error ? error.message : String(error)
        throw new ToolError('tool.vision.listFailed', { provider: name, error: key ? text.replaceAll(key, '***') : text })
      }
      const model = pickSeeModel(provider, ids)
      if (!model) throw new ToolError('tool.vision.noModel', { provider: name })
      return model
    })()
    pick = entry
    picks.set(cacheKey, entry)
    if (picks.size > MAX_PICKS) picks.delete(picks.keys().next().value as string)
    entry.catch(() => picks.get(cacheKey) === entry && picks.delete(cacheKey))
  }
  return pick
}

export function loadPicture(path: string, roots: string[]): Picture {
  const full = isAbsolute(path) ? resolve(path) : resolve(roots[0] ?? '.', path)
  if (!roots.some((root) => full.toLowerCase().startsWith(resolve(root).toLowerCase()))) throw new ToolError('tool.vision.outside')
  const mediaType = TYPES[extname(full).toLowerCase()]
  if (!mediaType) throw new ToolError('tool.vision.format')
  if (!existsSync(full)) throw new ToolError('tool.vision.noFile', { path })
  if (statSync(full).size > MAX_BYTES) throw new ToolError('tool.vision.tooBig')
  const bytes = readFileSync(full)
  return { mediaType, data: bytes.toString('base64'), ...imageSize(bytes) }
}

export async function look(settings: Settings, pictures: Picture[], question: string, signal: AbortSignal = new AbortController().signal): Promise<{ text: string; usage?: Usage }> {
  const { provider, model } = await visionModel(settings)
  let text = ''
  const turn = await getProvider(provider, settings).streamTurn({
    model,
    effort: 'low',
    system: VISION_SYSTEM,
    tools: [],
    messages: [{ role: 'user', content: [...pictures.map((p) => ({ type: 'image' as const, mediaType: p.mediaType, data: p.data })), { type: 'text', text: question }], ts: Date.now() }],
    signal,
    onText: (delta) => (text += delta),
    onThinking: () => {},
    onToolStart: () => {}
  })
  const final = turn.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
  return { text: (final || text).trim(), usage: turn.usage }
}

