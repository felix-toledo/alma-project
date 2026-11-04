// Image generation through OpenAI-compatible image APIs: Meta (default, Muse Image), xAI or OpenAI.
import OpenAI from 'openai'
import { META_BASE_URL, OPENAI_BASE_URL } from '../shared/defaults'
import type { ImageProviderId, Settings } from '../shared/types'
import { ProviderConfigError } from './providers/types'
import { readableErrorsFetch } from './providers/xai'

export type AspectRatio = '1:1' | '4:5' | '16:9' | '9:16'

const FALLBACK_MODEL: Record<ImageProviderId, string> = { xai: 'grok-2-image', openai: 'gpt-image-1', meta: 'muse-image-1.0' }

const IMAGE_MODEL: Record<ImageProviderId, RegExp> = { xai: /image|imagine/, openai: /^(gpt-image|dall-e)/, meta: /^muse-image/ }

/** OpenAI's image models take a fixed set of sizes; Meta takes any WxH; xAI takes the ratio as a prompt hint. */
const OPENAI_SIZES: Record<AspectRatio, '1024x1024' | '1024x1536' | '1536x1024'> = {
  '1:1': '1024x1024',
  '4:5': '1024x1536',
  '9:16': '1024x1536',
  '16:9': '1536x1024'
}

const META_SIZES: Record<AspectRatio, string> = { '1:1': '1024x1024', '4:5': '1024x1280', '9:16': '1024x1792', '16:9': '1792x1024' }

export function imageSize(provider: ImageProviderId, aspect: AspectRatio): string {
  return provider === 'meta' ? META_SIZES[aspect] : OPENAI_SIZES[aspect]
}

const ASPECT_HINT: Record<AspectRatio, string> = {
  '1:1': 'square 1:1 composition',
  '4:5': 'vertical 4:5 portrait composition',
  '9:16': 'tall vertical 9:16 composition',
  '16:9': 'wide horizontal 16:9 composition'
}

export function pickImageModel(provider: ImageProviderId, ids: string[]): string | undefined {
  return ids
    .filter((id) => IMAGE_MODEL[provider].test(id) && !/video|edit/.test(id))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
}

export function imageMimeType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

const pickedModels = new Map<string, Promise<string>>()

const SERVICES: Record<ImageProviderId, { name: string; envVar: string }> = {
  xai: { name: 'xAI', envVar: 'XAI_API_KEY' },
  openai: { name: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  meta: { name: 'Meta', envVar: 'META_API_KEY' }
}

function clientFor(
  settings: Settings,
  provider: ImageProviderId = settings.images.provider
): { client: OpenAI; provider: ImageProviderId; cacheKey: string } {
  const { name, envVar } = SERVICES[provider]
  const apiKey = settings.providers[provider].apiKey || process.env[envVar]
  if (!apiKey) throw new ProviderConfigError(`Para generar imágenes falta la API key de ${name} (Configuración → Proveedores).`)
  const baseURL = provider === 'xai' ? settings.providers.xai.baseUrl : provider === 'meta' ? META_BASE_URL : OPENAI_BASE_URL
  return {
    client: new OpenAI({ apiKey, baseURL, ...(provider === 'openai' ? {} : { fetch: readableErrorsFetch }) }),
    provider,
    cacheKey: `${provider}|${baseURL}|${apiKey}`
  }
}

export async function listImageModels(settings: Settings, provider?: ImageProviderId): Promise<string[]> {
  const { client } = clientFor(settings, provider)
  provider ??= settings.images.provider
  const ids: string[] = []
  for await (const model of client.models.list()) ids.push(model.id)
  return ids.filter((id) => IMAGE_MODEL[provider].test(id)).sort()
}

async function resolveModel(settings: Settings, client: OpenAI, provider: ImageProviderId, cacheKey: string): Promise<string> {
  if (settings.images.model) return settings.images.model
  let picked = pickedModels.get(cacheKey)
  if (!picked) {
    picked = (async () => {
      const ids: string[] = []
      for await (const model of client.models.list()) ids.push(model.id)
      return pickImageModel(provider, ids) ?? FALLBACK_MODEL[provider]
    })().catch(() => FALLBACK_MODEL[provider])
    pickedModels.set(cacheKey, picked)
  }
  return picked
}

export async function generateImage(
  settings: Settings,
  prompt: string,
  aspect: AspectRatio,
  signal: AbortSignal
): Promise<{ bytes: Buffer; model: string }> {
  const { client, provider, cacheKey } = clientFor(settings)
  const model = await resolveModel(settings, client, provider, cacheKey)
  const response = await client.images.generate(
    provider !== 'xai'
      ? { model, prompt, n: 1, size: imageSize(provider, aspect) as '1024x1024' }
      : { model, prompt: `${prompt}\n\n(${ASPECT_HINT[aspect]})`, n: 1, response_format: 'b64_json' },
    { signal }
  )
  const image = response.data?.[0]
  if (image?.b64_json) return { bytes: Buffer.from(image.b64_json, 'base64'), model }
  if (image?.url) {
    const download = await fetch(image.url, { signal })
    if (!download.ok) throw new Error(`No se pudo descargar la imagen generada (HTTP ${download.status}).`)
    return { bytes: Buffer.from(await download.arrayBuffer()), model }
  }
  throw new Error('El servicio de imágenes no devolvió ninguna imagen.')
}
