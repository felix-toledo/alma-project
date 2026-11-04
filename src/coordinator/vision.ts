// "Mirá esta imagen": a one-shot question to a model that can see. Used for floor plan photos, camera stills and
// pictures the user sends. Agents never carry images in their conversation; they get the answer as text.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
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

const ENV_KEYS: Record<ProviderId, string> = { anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', vercel: 'AI_GATEWAY_API_KEY', meta: 'META_API_KEY' }

function hasKey(settings: Settings, provider: ProviderId): boolean {
  return !!settings.providers[provider].apiKey || !!process.env[ENV_KEYS[provider]]
}

/**
 * The model that looks: the one chosen for vision; else the model of the agent that runs the house, or the default
 * agent, or any agent whose provider has a key (a person who only set up one provider still gets to look).
 */
export function visionModel(settings: Settings): { provider: ProviderId; model: string } {
  const { visionProvider, visionModel: model, agentId } = settings.home
  if (visionProvider && model) return { provider: visionProvider as ProviderId, model }
  const preferred = [settings.agents.find((a) => a.id === agentId), settings.agents.find((a) => a.id === settings.defaultAgentId), ...settings.agents]
  const agent = preferred.find((a) => a && hasKey(settings, a.provider)) ?? settings.agents[0]
  return { provider: agent.provider, model: agent.model }
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
  const { provider, model } = visionModel(settings)
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

