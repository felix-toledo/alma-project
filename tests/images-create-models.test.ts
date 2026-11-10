import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import type { ImageProviderId, Settings } from '../src/shared/types'

// Characterization (written against the code as it was, before `coordinator/images.ts` took its patterns from `shared/images/models`):
// AC-2.1, AC-2.2 and AC-2.7 held already; AC-1.2 is the one that was red (video and edit ids were suggested).
// A fake OpenAI client stands in for the three services: it records the key and URL each one was built with, and every listing and generation.
const fake = vi.hoisted(() => ({
  ids: [] as string[],
  failure: undefined as Error | undefined,
  clients: [] as { apiKey: string; baseURL: string }[],
  listings: [] as { apiKey: string; baseURL: string }[],
  generated: [] as { apiKey: string; baseURL: string; model: string }[]
}))
vi.mock('openai', () => ({
  default: class {
    models: { list: () => AsyncGenerator<{ id: string }> }
    images: { generate: (request: { model: string }) => Promise<{ data: { b64_json: string }[] }> }
    constructor(private readonly options: { apiKey: string; baseURL: string }) {
      fake.clients.push(options)
      this.models = {
        list: async function* () {
          fake.listings.push(options)
          if (fake.failure) throw fake.failure
          for (const id of fake.ids) yield { id }
        }
      }
      this.images = {
        generate: async (request) => {
          fake.generated.push({ ...options, model: request.model })
          return { data: [{ b64_json: Buffer.from('png').toString('base64') }] }
        }
      }
    }
  }
}))

const { generateImage, listImageModels } = await import('../src/coordinator/images')

const signal = new AbortController().signal
// The pick cache is process-wide and keyed by the key: each test builds its own, so nothing leaks between them.
let counter = 0
function settingsFor(provider: ImageProviderId, model = ''): Settings {
  const settings = defaultSettings('en')
  counter++
  for (const id of ['xai', 'openai', 'meta'] as const) settings.providers[id].apiKey = `key-${id}-${counter}`
  settings.images = { ...settings.images, provider, model }
  return settings
}
const lastModel = (): string | undefined => fake.generated.at(-1)?.model

beforeEach(() => {
  fake.ids = []
  fake.failure = undefined
  fake.clients.length = 0
  fake.listings.length = 0
  fake.generated.length = 0
})

describe('038 creating pictures: the model', () => {
  it('AC-2.1 (038) a typed create model is used with no listing call', async () => {
    for (const provider of ['xai', 'openai', 'meta'] as const) {
      fake.ids = ['should-not-be-asked']
      await generateImage(settingsFor(provider, 'my-own-model'), 'a cup', '1:1', signal)
      expect(lastModel()).toBe('my-own-model')
    }
    expect(fake.listings).toHaveLength(0)
  })

  it('AC-2.2 (038) provider only lists once and caches per service+URL+key', async () => {
    const settings = settingsFor('xai')
    fake.ids = ['grok-4', 'grok-imagine-image', 'grok-imagine-video', 'grok-2-image-edit']
    await generateImage(settings, 'a cup', '1:1', signal)
    await generateImage(settings, 'a cup', '1:1', signal)
    expect(lastModel()).toBe('grok-imagine-image')
    expect(fake.listings).toHaveLength(1)
    // another key is another entry
    const other = structuredClone(settings)
    other.providers.xai.apiKey = 'another-key'
    fake.ids = ['grok-imagine-image-2']
    await generateImage(other, 'a cup', '1:1', signal)
    expect(lastModel()).toBe('grok-imagine-image-2')
    expect(fake.listings).toHaveLength(2)
    // so is another URL
    const moved = structuredClone(settings)
    moved.providers.xai.baseUrl = 'http://127.0.0.1:1/v1'
    await generateImage(moved, 'a cup', '1:1', signal)
    expect(fake.listings).toHaveLength(3)
    // and another service
    fake.ids = ['gpt-4o', 'gpt-image-1', 'gpt-image-1.5']
    await generateImage(settingsFor('openai'), 'a cup', '1:1', signal)
    expect(lastModel()).toBe('gpt-image-1.5')
    expect(fake.listings).toHaveLength(4)
  })

  it('AC-2.7 (038) listing failure or no image model uses the fallback id', async () => {
    const fallback: Record<ImageProviderId, string> = { xai: 'grok-2-image', openai: 'gpt-image-1', meta: 'muse-image-1.0' }
    for (const provider of ['xai', 'openai', 'meta'] as const) {
      fake.failure = new Error('offline')
      await generateImage(settingsFor(provider), 'a cup', '1:1', signal)
      expect(lastModel(), `${provider} offline`).toBe(fallback[provider])
      fake.failure = undefined
      fake.ids = ['gpt-4o', 'grok-4', 'muse-spark-1', 'grok-imagine-video']
      await generateImage(settingsFor(provider), 'a cup', '1:1', signal)
      expect(lastModel(), `${provider} no image model`).toBe(fallback[provider])
    }
  })

  it('AC-1.2 (038) images.models lists create candidates and a listing error is raised', async () => {
    fake.ids = ['grok-imagine-image', 'grok-4', 'grok-imagine-video', 'grok-imagine-image-edit', 'grok-2-image']
    expect(await listImageModels(settingsFor('xai'))).toEqual(['grok-2-image', 'grok-imagine-image'])
    fake.ids = ['gpt-image-1', 'dall-e-3', 'gpt-4o']
    expect(await listImageModels(settingsFor('xai'), 'openai')).toEqual(['dall-e-3', 'gpt-image-1'])
    fake.ids = []
    expect(await listImageModels(settingsFor('meta'))).toEqual([])
    fake.failure = new Error('401 rejected')
    await expect(listImageModels(settingsFor('meta'))).rejects.toThrow('401 rejected')
  })
})
