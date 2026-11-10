import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateImage, listImageModels } from '../src/coordinator/images'
import { ToolError } from '../src/coordinator/tools/types'
import { defaultSettings, META_BASE_URL, OPENAI_BASE_URL } from '../src/shared/defaults'
import type { ImageProviderId, Settings } from '../src/shared/types'

// Independent verification of spec 038, the creation side (AC-2.1, AC-2.2, AC-2.7, BR-4). Written from spec.md only.

interface Seen {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}
let seen: Seen[]
let models: Record<string, string[] | number>
let generate: () => Response
let counter = 0
const ENV = ['XAI_API_KEY', 'OPENAI_API_KEY', 'META_API_KEY']
let envBefore: Record<string, string | undefined>
const signal = new AbortController().signal

beforeEach(() => {
  seen = []
  models = {}
  generate = () => Response.json({ data: [{ b64_json: 'AAAA' }] })
  envBefore = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined })
    if (url.endsWith('/models')) {
      const host = Object.keys(models).find((h) => url.includes(h))
      const entry = host ? models[host] : []
      if (typeof entry === 'number') return new Response('{"error":{"message":"down"}}', { status: entry, headers: { 'content-type': 'application/json' } })
      return Response.json({ object: 'list', data: entry.map((id) => ({ id, object: 'model' })) })
    }
    return generate()
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const k of ENV) {
    if (envBefore[k] === undefined) delete process.env[k]
    else process.env[k] = envBefore[k]
  }
})

function mk(provider: ImageProviderId, model = ''): Settings {
  const s = defaultSettings('en')
  counter++
  s.providers[provider].apiKey = `img-key-${counter}-${provider}`
  s.images = { ...s.images, provider, model }
  return s
}
const listCalls = (): Seen[] => seen.filter((r) => r.url.endsWith('/models'))
const genCalls = (): Seen[] => seen.filter((r) => r.url.endsWith('/images/generations'))
const HOST: Record<ImageProviderId, string> = { xai: 'api.x.ai', openai: 'api.openai.com', meta: 'api.meta.ai' }

describe('AC-2.1 (038 verify) a model set is used as is', () => {
  it('AC-2.1 (038 verify) no listing call, any text accepted, for each service', async () => {
    for (const provider of ['xai', 'openai', 'meta'] as const) {
      seen = []
      const out = await generateImage(mk(provider, 'whatever-model-v9'), 'a cat', '1:1', signal)
      expect(listCalls(), provider).toEqual([])
      expect(genCalls()).toHaveLength(1)
      expect(genCalls()[0].body?.model).toBe('whatever-model-v9')
      expect(out.model).toBe('whatever-model-v9')
      expect(out.bytes.length).toBeGreaterThan(0)
    }
  })
})

describe('AC-2.2 (038 verify) a service only: the newest image model, cached per service + URL + key', () => {
  it('AC-2.2 (038 verify) lists once, picks the newest matching model (numeric-aware), excludes video and edit; second call reuses', async () => {
    models[HOST.xai] = ['grok-4', 'grok-2-image', 'grok-imagine-image', 'grok-imagine-image-edit', 'grok-imagine-video', 'grok-imagine-image-9', 'grok-imagine-image-10']
    const s = mk('xai')
    const a = await generateImage(s, 'x', '1:1', signal)
    const b = await generateImage(s, 'y', '16:9', signal)
    expect(a.model).toBe('grok-imagine-image-10')
    expect(b.model).toBe('grok-imagine-image-10')
    expect(listCalls()).toHaveLength(1)
    expect(genCalls().map((c) => c.body?.model)).toEqual(['grok-imagine-image-10', 'grok-imagine-image-10'])
  })

  it('AC-2.2 (038 verify) OpenAI picks gpt-image*/dall-e* and goes to the fixed OpenAI URL; Meta picks muse-image* at the fixed Meta URL even if the xAI URL was customized', async () => {
    models[HOST.openai] = ['gpt-4o', 'dall-e-3', 'gpt-image-1', 'gpt-image-1-edit', 'dall-e-2']
    models[HOST.meta] = ['muse-spark-1', 'muse-image-1.0', 'muse-image-2.0', 'muse-image-2.0-video']
    const o = mk('openai')
    o.providers.xai.baseUrl = 'https://evil.example/v1'
    expect((await generateImage(o, 'x', '1:1', signal)).model).toBe('gpt-image-1')
    const m = mk('meta')
    m.providers.xai.baseUrl = 'https://evil.example/v1'
    expect((await generateImage(m, 'x', '1:1', signal)).model).toBe('muse-image-2.0')
    expect(seen.every((r) => !r.url.includes('evil.example'))).toBe(true)
    expect(seen.some((r) => r.url.startsWith(OPENAI_BASE_URL))).toBe(true)
    expect(seen.some((r) => r.url.startsWith(META_BASE_URL))).toBe(true)
  })

  it('AC-2.2 (038 verify) xAI uses the configured xAI base URL', async () => {
    const s = mk('xai')
    s.providers.xai.baseUrl = 'https://proxy.example/v1'
    models['proxy.example'] = ['grok-2-image']
    await generateImage(s, 'x', '1:1', signal)
    expect(seen.every((r) => r.url.startsWith('https://proxy.example/v1'))).toBe(true)
  })

  it('AC-2.2 (038 verify) the cache is per service + URL + key: another key lists again, the same one does not', async () => {
    models[HOST.openai] = ['gpt-image-1']
    const s = mk('openai')
    await generateImage(s, 'x', '1:1', signal)
    await generateImage({ ...s }, 'x', '1:1', signal)
    expect(listCalls()).toHaveLength(1)
    const other: Settings = { ...s, providers: { ...s.providers, openai: { apiKey: `${s.providers.openai.apiKey}-2` } } }
    await generateImage(other, 'x', '1:1', signal)
    expect(listCalls()).toHaveLength(2)
  })

  it('AC-2.2 (038 verify) the key in the environment is used when none is stored', async () => {
    models[HOST.meta] = ['muse-image-1.0']
    const s = defaultSettings('en')
    process.env.META_API_KEY = `env-img-${++counter}`
    s.images = { ...s.images, provider: 'meta', model: '' }
    const out = await generateImage(s, 'x', '1:1', signal)
    expect(out.model).toBe('muse-image-1.0')
    expect(seen.length).toBeGreaterThan(0)
  })
})

describe('AC-2.7 (038 verify) the listing fails or has no image model: the fallback ids, unchanged', () => {
  const FALLBACK: Record<ImageProviderId, string> = { xai: 'grok-2-image', openai: 'gpt-image-1', meta: 'muse-image-1.0' }
  for (const provider of ['xai', 'openai', 'meta'] as const) {
    it(`AC-2.7 (038 verify) ${provider}: HTTP 500, 429, 401 and an empty or unrelated list all fall back`, async () => {
      for (const listing of [500, 429, 401, [], ['gpt-4o', 'claude-3'], ['grok-imagine-video', 'dall-e-edit', 'muse-image-video']]) {
        models[HOST[provider]] = listing
        const out = await generateImage(mk(provider), 'x', '1:1', signal)
        expect(out.model, `${provider} ${JSON.stringify(listing)}`).toBe(FALLBACK[provider])
      }
    })
  }

  it('AC-2.7 (038 verify) a list with ONLY video/edit ids falls back and never picks them', async () => {
    models[HOST.xai] = ['grok-imagine-video', 'grok-imagine-image-edit']
    expect((await generateImage(mk('xai'), 'x', '1:1', signal)).model).toBe('grok-2-image')
  })

  it('AC-2.7 (038 verify) offline (fetch rejects) on the listing still creates with the fallback', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/models')) throw new TypeError('fetch failed')
      return Response.json({ data: [{ b64_json: 'AAAA' }] })
    })
    expect((await generateImage(mk('meta'), 'x', '1:1', signal)).model).toBe('muse-image-1.0')
  })

  it('AC-2.7 (038 verify) no key: a tool error naming the service, nothing sent', async () => {
    const s = defaultSettings('en')
    s.images = { ...s.images, provider: 'openai', model: '' }
    await expect(generateImage(s, 'x', '1:1', signal)).rejects.toBeInstanceOf(ToolError)
    expect(seen).toEqual([])
  })
})

describe('AC-1.2 (038 verify) the create suggestions (images.models)', () => {
  it('AC-1.2 (038 verify) only matching ids, sorted alphabetically, video and edit out', async () => {
    models[HOST.xai] = ['grok-imagine-video', 'grok-4', 'grok-imagine-image', 'grok-2-image', 'grok-2-image-edit']
    const s = mk('xai')
    expect(await listImageModels(s)).toEqual(['grok-2-image', 'grok-imagine-image'])
    expect(await listImageModels(s, 'xai')).toEqual(['grok-2-image', 'grok-imagine-image'])
  })

  it('AC-1.2 (038 verify) a failure rejects (shown under the field) and changes nothing; no key is a tool error', async () => {
    models[HOST.meta] = 500
    await expect(listImageModels(mk('meta'))).rejects.toThrow()
    const s = defaultSettings('en')
    await expect(listImageModels(s, 'openai')).rejects.toBeInstanceOf(ToolError)
  })

  it('AC-1.2 (038 verify) can list another service than the saved one (the group changes service before saving)', async () => {
    models[HOST.openai] = ['gpt-image-1', 'gpt-4o']
    const s = mk('meta')
    s.providers.openai.apiKey = `img-other-${counter}`
    expect(await listImageModels(s, 'openai')).toEqual(['gpt-image-1'])
  })
})
