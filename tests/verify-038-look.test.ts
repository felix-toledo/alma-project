import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { look, visionModel, type Picture } from '../src/coordinator/vision'
import { VISION_SYSTEM } from '../src/coordinator/prompts/vision'
import { ToolError, shownError } from '../src/coordinator/tools/types'
import { pickVisionModel, threadReaders } from '../src/shared/attach/readers'
import { defaultSettings, PROVIDER_NAMES, XAI_BASE_URL } from '../src/shared/defaults'
import type { Language } from '../src/shared/i18n/language'
import { pickSeeModel } from '../src/shared/images/models'
import type { ProviderId, Settings, VisionChoice } from '../src/shared/types'
import type { TurnRequest } from '../src/coordinator/providers/types'

// Independent verification of spec 038 at the coordinator (the look path, with a fake provider). Written from spec.md only.

type Lister = string[] | Error | (() => Promise<string[]>)
const rig = vi.hoisted(() => ({ fake: undefined as undefined | ((id: ProviderId, settings: Settings) => unknown) }))
vi.mock('../src/coordinator/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/coordinator/providers')>()
  return { ...actual, getProvider: (id: ProviderId, settings: Settings) => (rig.fake ? rig.fake(id, settings) : actual.getProvider(id, settings)) }
})

const PROVIDERS = Object.keys(PROVIDER_NAMES) as ProviderId[]
const ENV = ['META_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'AI_GATEWAY_API_KEY']
const pic: Picture = { mediaType: 'image/png', data: 'AAAA' }

interface Turn {
  provider: ProviderId
  request: TurnRequest
}
let lists: Partial<Record<ProviderId, Lister>>
let listed: ProviderId[]
let turns: Turn[]
let turnError: Error | undefined
let envBefore: Record<string, string | undefined>
let counter = 0

beforeEach(() => {
  lists = {}
  listed = []
  turns = []
  turnError = undefined
  envBefore = Object.fromEntries(ENV.map((k) => [k, process.env[k]]))
  for (const k of ENV) delete process.env[k]
  rig.fake = (id) => ({
    id,
    listModels: async () => {
      listed.push(id)
      const lister = lists[id] ?? []
      if (lister instanceof Error) throw lister
      return typeof lister === 'function' ? lister() : [...lister]
    },
    streamTurn: async (request: TurnRequest) => {
      turns.push({ provider: id, request })
      if (turnError) throw turnError
      return { content: [{ type: 'text', text: ` seen by ${id} ` }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    review: async () => ({ verdict: 'allow', reason: '' })
  })
})
afterEach(() => {
  rig.fake = undefined
  for (const k of ENV) {
    if (envBefore[k] === undefined) delete process.env[k]
    else process.env[k] = envBefore[k]
  }
})

/** Settings with a fresh, unique key for each listed provider so the process-wide pick cache never leaks between tests. */
function mk(vision: VisionChoice, over: { acked?: ProviderId[]; keys?: ProviderId[]; language?: Language; house?: string } = {}): Settings {
  const s = defaultSettings(over.language ?? 'en')
  counter++
  for (const p of over.keys ?? PROVIDERS) s.providers[p].apiKey = `key-${counter}-${p}-0123456789abcdef`
  s.images = { ...s.images, vision }
  s.attachments = { noticeAcknowledged: over.acked ?? [] }
  s.home = { ...s.home, agentId: over.house ?? '' }
  return s
}

const errorOf = async (promise: Promise<unknown>): Promise<ToolError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError)
    return error as ToolError
  }
  throw new Error('expected the look to fail')
}

describe('AC-2.3 (038 verify) a typed model: used as is', () => {
  it('AC-2.3 (038 verify) every provider, any model text: no listing call, no capability check, that provider and model get the picture', async () => {
    for (const provider of PROVIDERS) {
      for (const model of ['definitely-not-a-vision-model', 'gpt-4o', 'deepseek-chat', 'text-embedding-3', 'CLAUDE', 'x']) {
        listed = []
        turns = []
        const out = await look(mk({ provider, model }), [pic], 'what?')
        expect(listed, `${provider} ${model}`).toEqual([])
        expect(turns).toHaveLength(1)
        expect(turns[0].provider).toBe(provider)
        expect(turns[0].request.model).toBe(model)
        expect(out.text).toBe(`seen by ${provider}`)
      }
    }
  })

  it('AC-2.3 (038 verify) works while the provider cannot be listed at all (offline) and without acknowledgement', async () => {
    lists.xai = new Error('offline')
    const out = await look(mk({ provider: 'xai', model: 'grok-4' }, { acked: [] }), [pic], 'q')
    expect(out.text).toContain('xai')
    expect(listed).toEqual([])
  })

  it('BR-8 (038 verify) a look is one low-effort turn, no tools, the fixed English prompt, the images then the question', async () => {
    await look(mk({ provider: 'anthropic', model: 'claude-x' }), [pic, { mediaType: 'image/jpeg', data: 'BBBB' }], 'the question')
    const request = turns[0].request
    expect(request.effort).toBe('low')
    expect(request.tools).toEqual([])
    expect(request.system).toBe(VISION_SYSTEM)
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0].role).toBe('user')
    expect(request.messages[0].content).toEqual([
      { type: 'image', mediaType: 'image/png', data: 'AAAA' },
      { type: 'image', mediaType: 'image/jpeg', data: 'BBBB' },
      { type: 'text', text: 'the question' }
    ])
  })

  it('BR-8 (038 verify) the abort signal reaches the provider turn', async () => {
    const controller = new AbortController()
    await look(mk({ provider: 'anthropic', model: 'claude-x' }), [pic], 'q', controller.signal)
    expect(turns[0].request.signal).toBe(controller.signal)
  })

  it('BR-8 (038 verify) a provider error during the turn surfaces as is and nothing is sent to a second provider', async () => {
    turnError = new Error('429 rate limited')
    await expect(look(mk({ provider: 'xai', model: 'grok-4' }), [pic], 'q')).rejects.toThrow('429 rate limited')
    expect(turns.map((t) => t.provider)).toEqual(['xai'])
  })
})

describe('AC-2.4 (038 verify) a provider only, acknowledged: listed once and cached', () => {
  it('AC-2.4 (038 verify) lists, picks with BR-5 over only accepted ids, and a later look reuses it with no listing call', async () => {
    lists.anthropic = ['gpt-9', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', 'text-embedding-3']
    const s = mk({ provider: 'anthropic', model: '' }, { acked: ['anthropic'] })
    await look(s, [pic], 'q')
    expect(listed).toEqual(['anthropic'])
    expect(turns[0].request.model).toBe(pickSeeModel('anthropic', lists.anthropic as string[]))
    expect(turns[0].request.model).toBe('claude-sonnet-4-5')
    await look(s, [pic], 'q')
    await look({ ...s }, [pic], 'q')
    expect(listed).toEqual(['anthropic'])
    expect(turns.map((t) => t.request.model)).toEqual(['claude-sonnet-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5'])
  })

  it('AC-2.4 (038 verify) every provider with a rule: xAI and Meta pick their own id family', async () => {
    lists.xai = ['grok-2-image', 'grok-4', 'grok-10', 'grok-9', 'grok-vision-x']
    lists.meta = ['muse-image-9', 'muse-spark-2', 'muse-spark-10']
    await look(mk({ provider: 'xai', model: '' }, { acked: ['xai'] }), [pic], 'q')
    await look(mk({ provider: 'meta', model: '' }, { acked: ['meta'] }), [pic], 'q')
    expect(turns.map((t) => [t.provider, t.request.model])).toEqual([
      ['xai', 'grok-10'],
      ['meta', 'muse-spark-10']
    ])
  })

  it('AC-2.4 (038 verify) the cache is per provider + URL + key: another key, another xAI URL or another provider list again; the same triple does not', async () => {
    lists.xai = ['grok-4']
    const base = mk({ provider: 'xai', model: '' }, { acked: ['xai'] })
    await look(base, [pic], 'q')
    await look(base, [pic], 'q')
    expect(listed).toEqual(['xai'])
    const otherKey: Settings = { ...base, providers: { ...base.providers, xai: { ...base.providers.xai, apiKey: `${base.providers.xai.apiKey}-new` } } }
    await look(otherKey, [pic], 'q')
    expect(listed).toEqual(['xai', 'xai'])
    const otherUrl: Settings = { ...base, providers: { ...base.providers, xai: { ...base.providers.xai, baseUrl: `${XAI_BASE_URL}/alt` } } }
    await look(otherUrl, [pic], 'q')
    expect(listed).toEqual(['xai', 'xai', 'xai'])
    await look(otherUrl, [pic], 'q')
    await look(otherKey, [pic], 'q')
    expect(listed).toEqual(['xai', 'xai', 'xai'])
  })

  it('AC-2.4 (038 verify) a key that only exists in the environment is a key; changing it re-lists', async () => {
    lists.meta = ['muse-spark-1']
    const s = mk({ provider: 'meta', model: '' }, { acked: ['meta'], keys: [] })
    process.env.META_API_KEY = `env-${counter}-a`
    await look(s, [pic], 'q')
    await look(s, [pic], 'q')
    expect(listed).toEqual(['meta'])
    process.env.META_API_KEY = `env-${counter}-b`
    await look(s, [pic], 'q')
    expect(listed).toEqual(['meta', 'meta'])
  })

  it('AC-2.4 (038 verify) concurrent looks share one listing', async () => {
    let release: (ids: string[]) => void = () => {}
    lists.xai = () => new Promise<string[]>((resolve) => (release = resolve))
    const s = mk({ provider: 'xai', model: '' }, { acked: ['xai'] })
    const all = Promise.all([look(s, [pic], 'a'), look(s, [pic], 'b'), look(s, [pic], 'c'), look({ ...s }, [pic], 'd')])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listed).toEqual(['xai'])
    release(['grok-3', 'grok-4'])
    const results = await all
    expect(results).toHaveLength(4)
    expect(listed).toEqual(['xai'])
    expect(new Set(turns.map((t) => t.request.model))).toEqual(new Set(['grok-4']))
  })

  it('AC-2.4 (038 verify) a huge listing is fine (10 000 ids)', async () => {
    lists.anthropic = Array.from({ length: 10_000 }, (_, i) => `claude-model-${i}`)
    await look(mk({ provider: 'anthropic', model: '' }, { acked: ['anthropic'] }), [pic], 'q')
    expect(turns[0].request.model).toBe('claude-model-9999')
  })
})

describe('AC-2.5 (038 verify) no model can be found', () => {
  it('AC-2.5 (038 verify) a provider without a rule: error naming it, no listing call, nothing sent', async () => {
    for (const provider of ['deepseek', 'vercel'] as const) {
      lists[provider] = ['claude-3', 'grok-4']
      const error = await errorOf(look(mk({ provider, model: '' }, { acked: [provider] }), [pic], 'q'))
      expect(error.text.key).toBe('tool.vision.noModel')
      expect(error.message).toContain(PROVIDER_NAMES[provider])
      expect(error.message).toContain('Settings → Images')
      expect(shownError(error, 'es')).toContain(PROVIDER_NAMES[provider])
      expect(shownError(error, 'es')).toContain('Configuración → Imágenes')
    }
    expect(listed).toEqual([])
    expect(turns).toEqual([])
  })

  it('AC-2.5 (038 verify) a provider with a rule whose listing has no accepted id (or is empty): the same error, nothing sent, nothing cached', async () => {
    const s = mk({ provider: 'meta', model: '' }, { acked: ['meta'] })
    for (const ids of [[], ['muse-image-1.0', 'gpt-4o'], ['']]) {
      lists.meta = ids
      const error = await errorOf(look(s, [pic], 'q'))
      expect(error.text.key).toBe('tool.vision.noModel')
      expect(error.message).toContain(PROVIDER_NAMES.meta)
    }
    expect(listed).toEqual(['meta', 'meta', 'meta'])
    expect(turns).toEqual([])
    // a model appears: the failure was not cached
    lists.meta = ['muse-spark-1']
    await look(s, [pic], 'q')
    expect(turns.map((t) => t.provider)).toEqual(['meta'])
  })

  it('AC-5.2 (038 verify) the message is translated for the person and English for the model', async () => {
    const error = await errorOf(look(mk({ provider: 'deepseek', model: '' }, { acked: ['deepseek'], language: 'es' }), [pic], 'q'))
    expect(error.message).toMatch(/pick one in Settings → Images/)
    expect(error.message).not.toMatch(/elegí|Configuración/)
    expect(shownError(error, 'es')).toMatch(/elegí uno en Configuración → Imágenes/)
    expect(shownError(error, 'en')).toBe(error.message)
  })
})

describe('AC-2.6 (038 verify) the listing fails', () => {
  it('AC-2.6 (038 verify) offline, rejected key, timeout, HTTP error, non-Error throws: a listFailed tool error with the provider error, nothing sent, nothing cached', async () => {
    const failures: [unknown, string][] = [
      [new Error('getaddrinfo ENOTFOUND api.x.ai'), 'ENOTFOUND'],
      [new Error('401 Incorrect API key provided'), '401'],
      [new Error('Request timed out.'), 'timed out'],
      [new Error('503 upstream unavailable'), '503'],
      ['plain string failure', 'plain string failure'],
      [{ toString: () => 'object failure' }, 'object failure']
    ]
    for (const [failure, text] of failures) {
      const s = mk({ provider: 'xai', model: '' }, { acked: ['xai'] })
      lists.xai = () => Promise.reject(failure)
      const error = await errorOf(look(s, [pic], 'q'))
      expect(error.text.key).toBe('tool.vision.listFailed')
      expect(error.message).toContain(PROVIDER_NAMES.xai)
      expect(error.message).toContain(text)
      expect(turns).toEqual([])
      // retry succeeds: the failure was not kept
      lists.xai = ['grok-4']
      await look(s, [pic], 'q')
      expect(turns.at(-1)?.request.model).toBe('grok-4')
      turns = []
    }
  })

  it('AC-2.6 (038 verify) failing twice lists twice (not cached), and a later success is then cached', async () => {
    const s = mk({ provider: 'anthropic', model: '' }, { acked: ['anthropic'] })
    lists.anthropic = new Error('boom')
    await errorOf(look(s, [pic], 'q'))
    await errorOf(look(s, [pic], 'q'))
    expect(listed).toHaveLength(2)
    lists.anthropic = ['claude-x-1']
    await look(s, [pic], 'q')
    await look(s, [pic], 'q')
    expect(listed).toHaveLength(3)
  })

  it('AC-2.6 (038 verify) concurrent looks on a failing listing all fail with the same error and the next one retries', async () => {
    const s = mk({ provider: 'xai', model: '' }, { acked: ['xai'] })
    lists.xai = () => new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('slow boom')), 10))
    const results = await Promise.allSettled([look(s, [pic], 'a'), look(s, [pic], 'b'), look(s, [pic], 'c')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(listed).toEqual(['xai'])
    expect(turns).toEqual([])
    lists.xai = ['grok-4']
    await look(s, [pic], 'q')
    expect(listed).toEqual(['xai', 'xai'])
  })

  it('AC-2.6 (038 verify) no key at all (real provider client): the error carries the provider words and points to Providers, in the app language; nothing is sent', async () => {
    rig.fake = undefined
    for (const [language, hint] of [['en', 'Settings → Providers'], ['es', 'Configuración → Proveedores']] as const) {
      const s = mk({ provider: 'xai', model: '' }, { acked: ['xai'], keys: [], language })
      const error = await errorOf(look(s, [pic], 'q'))
      expect(error.text.key).toBe('tool.vision.listFailed')
      expect(shownError(error, language)).toContain(hint)
      expect(shownError(error, language)).toContain('XAI_API_KEY')
    }
  })

  it('AC-2.6 (038 verify) no key for Anthropic and the other providers, real clients: always a tool error, never a crash', async () => {
    rig.fake = undefined
    for (const provider of ['anthropic', 'meta'] as const) {
      const s = mk({ provider, model: '' }, { acked: [provider], keys: [] })
      const error = await errorOf(look(s, [pic], 'q'))
      expect(error.text.key).toBe('tool.vision.listFailed')
    }
  })
})

describe('AC-4.5 (038 verify) no key in anything the person or the model reads', () => {
  it('AC-4.5 (038 verify) a provider that echoes the key back in its listing error is redacted, in both languages, key from settings or env', async () => {
    const s = mk({ provider: 'xai', model: '' }, { acked: ['xai'] })
    const key = s.providers.xai.apiKey
    lists.xai = new Error(`401 Incorrect API key provided: ${key}. Also ${key} again`)
    const error = await errorOf(look(s, [pic], 'q'))
    for (const text of [error.message, shownError(error, 'en'), shownError(error, 'es'), JSON.stringify(error.text), String(error.stack?.split('\n')[0])]) {
      expect(text).not.toContain(key)
    }
    expect(error.message).toContain('***')
    // env key
    const e = mk({ provider: 'meta', model: '' }, { acked: ['meta'], keys: [] })
    process.env.META_API_KEY = `sk-envkey-${counter}-abcdefghijklmnop`
    lists.meta = new Error(`bad key ${process.env.META_API_KEY}`)
    const envError = await errorOf(look(e, [pic], 'q'))
    expect(envError.message).not.toContain(process.env.META_API_KEY)
    expect(JSON.stringify(envError.text)).not.toContain(process.env.META_API_KEY)
  })

  it('AC-4.5 (038 verify) no-model errors carry names and ids only', async () => {
    const s = mk({ provider: 'anthropic', model: '' }, { acked: ['anthropic'] })
    lists.anthropic = ['gpt-4o']
    const error = await errorOf(look(s, [pic], 'q'))
    for (const p of PROVIDERS) expect(error.message).not.toContain(s.providers[p].apiKey)
  })
})

describe('AC-4.6 / AC-4.7 (038 verify) the gate at the look', () => {
  it('AC-4.6 (038 verify) a provider only, not acknowledged: the fallback agent looks, the held provider is never listed nor sent anything', async () => {
    for (const provider of PROVIDERS) {
      listed = []
      turns = []
      const s = mk({ provider, model: '' }, { acked: [], keys: ['meta'] })
      await look(s, [pic], 'q')
      expect(listed, provider).toEqual([])
      expect(turns).toHaveLength(1)
      const fallback = pickVisionModel(s, {})
      expect(turns[0].provider).toBe(fallback.provider)
      expect(turns[0].request.model).toBe(fallback.model)
      expect(turns.some((t) => t.provider === provider && provider !== fallback.provider)).toBe(false)
    }
  })

  it('AC-4.6 (038 verify) acknowledged: the see provider; typed model: the see provider whatever the list holds', async () => {
    lists.anthropic = ['claude-opus-4-1']
    await look(mk({ provider: 'anthropic', model: '' }, { acked: ['anthropic'] }), [pic], 'q')
    expect(turns.at(-1)).toMatchObject({ provider: 'anthropic' })
    await look(mk({ provider: 'deepseek', model: 'my-model' }, { acked: [] }), [pic], 'q')
    expect(turns.at(-1)?.provider).toBe('deepseek')
    expect(turns.at(-1)?.request.model).toBe('my-model')
  })

  it('AC-4.7 (038 verify) a watch looping on one process: the gate is read at each look and flips with no restart, in both directions', async () => {
    lists.xai = ['grok-4']
    const closed = mk({ provider: 'xai', model: '' }, { acked: [], keys: ['xai', 'meta'] })
    const opened: Settings = { ...closed, attachments: { noticeAcknowledged: ['xai'] } }
    const seen: ProviderId[] = []
    for (const s of [closed, closed, opened, opened, closed]) {
      await look(s, [pic], 'watch')
      seen.push(turns.at(-1)?.provider as ProviderId)
    }
    const held = pickVisionModel(closed, {}).provider
    expect(seen).toEqual([held, held, 'xai', 'xai', held])
    expect(held).not.toBe('xai')
  })

  it('AC-2.9 (038 verify) the fallback path is unchanged: no listing, no capability check, the agent model as is (empty model stays empty)', async () => {
    const s = mk({ provider: '', model: '' }, { keys: ['deepseek'], house: 'deepseek' })
    const agent = s.agents.find((a) => a.id === 'deepseek')
    await look(s, [pic], 'q')
    expect(listed).toEqual([])
    expect(turns[0].provider).toBe('deepseek')
    expect(turns[0].request.model).toBe(agent?.model)
    const noKeys = mk({ provider: '', model: '' }, { keys: [] })
    await look(noKeys, [pic], 'q')
    expect(turns.at(-1)?.provider).toBe(noKeys.agents[0].provider)
  })

  it('AC-2.9 (038 verify) an orphan model with no provider (hand-edited) does not become a see choice', async () => {
    const s = mk({ provider: '', model: 'orphan' }, { keys: ['meta'] })
    await look(s, [pic], 'q')
    expect(listed).toEqual([])
    expect(turns[0].request.model).not.toBe('orphan')
  })
})

describe('AC-4.4 (038 verify) the notice and the look name the same provider, in every case', () => {
  it('AC-4.4 (038 verify) provider x model x acknowledged x keys x house agent x listing outcome: same provider; failures send nothing anywhere', async () => {
    const outcomes: [string, Lister][] = [
      ['ok', ['claude-sonnet-4-5', 'grok-4', 'muse-spark-1']],
      ['empty', []],
      ['offline', new Error('offline')]
    ]
    const KEYS: ProviderId[][] = [[], ['meta'], ['xai'], ['deepseek'], PROVIDERS]
    let cases = 0
    for (const provider of ['', ...PROVIDERS] as (ProviderId | '')[]) {
      for (const model of ['', 'typed']) {
        for (const acked of [false, true]) {
          for (const keys of KEYS) {
            for (const house of ['', 'grok']) {
              for (const [name, outcome] of outcomes) {
                const s = mk({ provider, model }, { acked: acked && provider ? [provider] : [], keys, house })
                for (const p of PROVIDERS) lists[p] = outcome
                listed = []
                turns = []
                const label = JSON.stringify({ provider, model, acked, keys, house, name })
                const noticed = pickVisionModel(s, {})
                const readers = threadReaders(s, { agentId: 'general', model: undefined }, true, {})
                expect(readers, label).toContain(noticed.provider)
                try {
                  await look(s, [pic], 'q')
                  expect(turns, label).toHaveLength(1)
                  expect(turns[0].provider, label).toBe(noticed.provider)
                  if (noticed.model) expect(turns[0].request.model, label).toBe(noticed.model)
                } catch (error) {
                  expect(error, label).toBeInstanceOf(ToolError)
                  // a failed look: no picture left for any provider; only the noticed one may have been asked for a list
                  expect(turns, label).toEqual([])
                  expect(new Set(listed), label).toSatisfy((set: Set<ProviderId>) => [...set].every((p) => p === noticed.provider))
                  expect((error as ToolError).message, label).toContain(PROVIDER_NAMES[noticed.provider])
                }
                cases++
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(6 * 2 * 2 * 5 * 2 * 3)
  })

  it('AC-4.4 (038 verify) visionModel directly: the provider it returns is the noticed one', async () => {
    lists.anthropic = ['claude-opus-4-1']
    const s = mk({ provider: 'anthropic', model: '' }, { acked: ['anthropic'], keys: ['anthropic'] })
    expect((await visionModel(s)).provider).toBe(pickVisionModel(s, {}).provider)
    expect((await visionModel(s)).model).toBe('claude-opus-4-1')
  })
})
