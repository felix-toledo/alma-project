import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../src/shared/defaults'
import { translateText } from '../src/shared/i18n/messages'
import type { ProviderId, Settings } from '../src/shared/types'
import { threadReaders } from '../src/shared/attach/readers'
import type { TurnRequest } from '../src/coordinator/providers/types'

// A fake client per provider: every test decides what the listing returns and sees which provider was asked to look.
const mock = vi.hoisted(() => {
  const providers: Record<string, { listModels: ReturnType<typeof vi.fn>; streamTurn: ReturnType<typeof vi.fn> }> = {}
  for (const id of ['anthropic', 'xai', 'deepseek', 'vercel', 'meta']) providers[id] = { listModels: vi.fn(), streamTurn: vi.fn() }
  return { providers, getProvider: vi.fn() }
})
vi.mock('../src/coordinator/providers', () => ({ getProvider: mock.getProvider }))

const { look, MAX_PICKS, LIST_TIMEOUT_MS } = await import('../src/coordinator/vision')
const { ToolError } = await import('../src/coordinator/tools/types')

const picture = { mediaType: 'image/png', data: 'AAAA' }
const asked = (id: ProviderId): TurnRequest[] => mock.providers[id].streamTurn.mock.calls.map((c) => c[0] as TurnRequest)
const listed = (): number => Object.values(mock.providers).reduce((n, p) => n + p.listModels.mock.calls.length, 0)
const sent = (): number => Object.values(mock.providers).reduce((n, p) => n + p.streamTurn.mock.calls.length, 0)

// The cache is process-wide and keyed by the key: each test gets its own, so nothing leaks between them.
let counter = 0
function settingsWith(vision: Settings['images']['vision'], acknowledged: ProviderId[] = []): Settings {
  const settings = defaultSettings('en')
  counter++
  for (const id of ['anthropic', 'xai', 'deepseek', 'vercel', 'meta'] as const) settings.providers[id].apiKey = `key-${id}-${counter}`
  settings.images.vision = vision
  settings.attachments.noticeAcknowledged = acknowledged
  return settings
}

beforeEach(() => {
  for (const [id, provider] of Object.entries(mock.providers)) {
    provider.listModels = vi.fn(async () => [])
    provider.streamTurn = vi.fn(async (request: TurnRequest) => ({ content: [{ type: 'text', text: `${id}:${request.model}` }], stopReason: 'end_turn', model: request.model }))
  }
  mock.getProvider.mockReset()
  mock.getProvider.mockImplementation((id: string) => mock.providers[id])
})

afterEach(() => vi.useRealTimers())

describe('038 the model that looks, in the coordinator', () => {
  it('AC-2.3 (038) a typed see model is used with no listing call and no capability check', async () => {
    // a provider with no capability rule, never acknowledged, and a model its rule would never accept
    for (const [provider, model] of [['deepseek', 'deepseek-chat'], ['vercel', 'some/odd-id'], ['anthropic', 'text-only-thing'], ['xai', 'grok-3-mini']] as const) {
      const answer = await look(settingsWith({ provider, model }), [picture], 'what is this?')
      expect(answer.text).toBe(`${provider}:${model}`)
      expect(asked(provider).at(-1)?.model).toBe(model)
    }
    expect(listed()).toBe(0)
  })

  it('AC-4.6 (038) held provider receives nothing, the fallback agent\'s provider does', async () => {
    const settings = settingsWith({ provider: 'anthropic', model: '' })
    settings.home.agentId = ''
    settings.agents = settings.agents.map((a) => ({ ...a, provider: 'xai', model: 'grok-agent' }))
    const answer = await look(settings, [picture], 'q')
    expect(answer.text).toBe('xai:grok-agent')
    expect(mock.getProvider.mock.calls.map((c) => c[0])).toEqual(['xai'])
    expect(asked('anthropic')).toHaveLength(0)
    expect(listed()).toBe(0)
  })

  it('AC-4.7 (038) the gate is read at each look', async () => {
    const settings = settingsWith({ provider: 'anthropic', model: '' })
    settings.agents = settings.agents.map((a) => ({ ...a, provider: 'xai', model: 'grok-agent' }))
    mock.providers.anthropic.listModels = vi.fn(async () => ['claude-a-1', 'claude-b-2'])
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-agent')
    // the person acknowledges the provider later, in the same settings object the camera watch holds
    settings.attachments.noticeAcknowledged.push('anthropic')
    expect((await look(settings, [picture], 'q')).text).toBe('anthropic:claude-b-2')
  })

  it('AC-2.4 (038) provider only, acknowledged, with a rule: newest accepted model, cached', async () => {
    const settings = settingsWith({ provider: 'anthropic', model: '' }, ['anthropic'])
    const ids = ['claude-sonnet-4', 'text-embedding-3', 'claude-sonnet-10', 'claude-haiku-9', 'gpt-4o']
    mock.providers.anthropic.listModels = vi.fn(async () => ids)
    expect((await look(settings, [picture], 'q')).text).toBe('anthropic:claude-sonnet-10')
    // a later look reuses the pick with no listing call
    expect((await look(settings, [picture], 'q')).text).toBe('anthropic:claude-sonnet-10')
    expect(mock.providers.anthropic.listModels).toHaveBeenCalledTimes(1)
    // another key is another cache entry; a shuffled list gives the same pick
    const other = settingsWith({ provider: 'anthropic', model: '' }, ['anthropic'])
    mock.providers.anthropic.listModels = vi.fn(async () => [...ids].reverse())
    expect((await look(other, [picture], 'q')).text).toBe('anthropic:claude-sonnet-10')
    expect(mock.providers.anthropic.listModels).toHaveBeenCalledTimes(1)
    expect(mock.getProvider.mock.calls.every((c) => c[0] === 'anthropic')).toBe(true)
  })

  it('AC-2.4 (038) looks at the same time share one listing', async () => {
    const settings = settingsWith({ provider: 'meta', model: '' }, ['meta'])
    mock.providers.meta.listModels = vi.fn(async () => ['muse-image-1.0', 'muse-spark-1', 'muse-spark-2'])
    const answers = await Promise.all([look(settings, [picture], 'q'), look(settings, [picture], 'q'), look(settings, [picture], 'q')])
    expect(answers.map((a) => a.text)).toEqual(Array(3).fill('meta:muse-spark-2'))
    expect(mock.providers.meta.listModels).toHaveBeenCalledTimes(1)
  })

  it('AC-2.5 (038) a listing with no accepted id is a tool error and nothing is sent', async () => {
    const settings = settingsWith({ provider: 'meta', model: '' }, ['meta'])
    mock.providers.meta.listModels = vi.fn(async () => ['muse-image-1.0', 'text-embedding', 'claude-x'])
    const failure = await look(settings, [picture], 'q').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ToolError)
    expect((failure as InstanceType<typeof ToolError>).text).toEqual({ key: 'tool.vision.noModel', params: { provider: 'Meta (Muse)' } })
    expect(sent()).toBe(0)
    // the failure is not cached: a later look lists again
    mock.providers.meta.listModels = vi.fn(async () => ['muse-spark-3'])
    expect((await look(settings, [picture], 'q')).text).toBe('meta:muse-spark-3')
  })

  it('AC-2.5 (038) a provider without a rule is a tool error naming the provider and makes no listing call', async () => {
    for (const [provider, name] of [['deepseek', 'DeepSeek'], ['vercel', 'Vercel AI Gateway']] as const) {
      const failure = await look(settingsWith({ provider, model: '' }, [provider]), [picture], 'q').catch((e: unknown) => e)
      expect(failure).toBeInstanceOf(ToolError)
      expect((failure as InstanceType<typeof ToolError>).text).toEqual({ key: 'tool.vision.noModel', params: { provider: name } })
    }
    expect(listed()).toBe(0)
    expect(sent()).toBe(0)
  })

  it('AC-5.2 (038) the errors are ToolError keys, English for the model, translated for the person', async () => {
    const failure = (await look(settingsWith({ provider: 'deepseek', model: '' }, ['deepseek']), [picture], 'q').catch((e: unknown) => e)) as InstanceType<typeof ToolError>
    expect(failure.message).toBe('There is no DeepSeek model able to see images: pick one in Settings → Images.')
    expect(translateText('en', failure.text)).toBe(failure.message)
    expect(translateText('es', failure.text)).toBe('No hay un modelo de DeepSeek que pueda ver imágenes: elegí uno en Configuración → Imágenes.')
  })
})

describe('038 failures of the listing', () => {
  const failureOf = async (settings: Settings): Promise<InstanceType<typeof ToolError>> => {
    const failure = await look(settings, [picture], 'q').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ToolError)
    return failure as InstanceType<typeof ToolError>
  }

  it('AC-2.6 (038) listing failure or missing key is a tool error and is not cached', async () => {
    const settings = settingsWith({ provider: 'xai', model: '' }, ['xai'])
    // offline, a rejected key, a timeout: each is the provider's own error inside the tool error
    for (const reason of ['fetch failed', '401 invalid API key', 'Request timed out.']) {
      mock.providers.xai.listModels = vi.fn(async () => {
        throw new Error(reason)
      })
      const failure = await failureOf(settings)
      expect(failure.text).toEqual({ key: 'tool.vision.listFailed', params: { provider: 'Grok', error: reason } })
      expect(failure.message).toBe(`Could not list the Grok models: ${reason}`)
    }
    // no key: the client cannot even be built
    mock.getProvider.mockImplementationOnce(() => {
      throw new Error('Grok needs an API key')
    })
    expect((await failureOf(settings)).text.params).toEqual({ provider: 'Grok', error: 'Grok needs an API key' })
    // none of those stayed: the next look asks again, and then the pick stays
    mock.providers.xai.listModels = vi.fn(async () => ['grok-4', 'grok-4-image'])
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-4')
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-4')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(1)
    expect(sent()).toBe(2)
  })

  it('AC-4.5 (038) the key never appears in errors, logs or tool results', async () => {
    const settings = settingsWith({ provider: 'anthropic', model: '' }, ['anthropic'])
    const key = settings.providers.anthropic.apiKey
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    mock.providers.anthropic.listModels = vi.fn(async () => {
      throw new Error(`401 for ${key}: Authorization: Bearer ${key}`)
    })
    const failure = await failureOf(settings)
    mock.providers.anthropic.listModels = vi.fn(async () => ['claude-x-1'])
    const answer = await look(settings, [picture], 'q')
    for (const text of [failure.message, JSON.stringify(failure.text), translateText('es', failure.text), answer.text, ...spies.flatMap((s) => s.mock.calls.map((c) => c.join(' ')))]) {
      expect(text).not.toContain(key)
    }
    expect(failure.message).toContain('401')
    for (const spy of spies) spy.mockRestore()
  })

  it('AC-4.4 (038) notice and look name the same provider for every outcome', async () => {
    const agent = (provider: ProviderId, settings: Settings): Settings => ({ ...settings, agents: settings.agents.map((a) => ({ ...a, provider, model: 'agent-model' })) })
    // [name, settings, arrange, provider the notice names for the pictures, provider that receives them (null = the look fails and sends nothing)]
    const outcomes: [string, Settings, (settings: Settings) => void, ProviderId, ProviderId | null][] = [
      ['typed', agent('xai', settingsWith({ provider: 'deepseek', model: 'deepseek-chat' })), () => {}, 'deepseek', 'deepseek'],
      ['acknowledged provider only', agent('xai', settingsWith({ provider: 'anthropic', model: '' }, ['anthropic'])), () => {
        mock.providers.anthropic.listModels = vi.fn(async () => ['claude-z-1'])
      }, 'anthropic', 'anthropic'],
      ['held', agent('xai', settingsWith({ provider: 'anthropic', model: '' })), () => {}, 'xai', 'xai'],
      ['no rule', agent('xai', settingsWith({ provider: 'vercel', model: '' }, ['vercel'])), () => {}, 'vercel', null],
      ['no accepted id', agent('xai', settingsWith({ provider: 'meta', model: '' }, ['meta'])), () => {
        mock.providers.meta.listModels = vi.fn(async () => ['muse-image-1.0'])
      }, 'meta', null],
      ['listing failure', agent('xai', settingsWith({ provider: 'anthropic', model: '' }, ['anthropic'])), () => {
        mock.providers.anthropic.listModels = vi.fn(async () => {
          throw new Error('offline')
        })
      }, 'anthropic', null]
    ]
    for (const [name, settings, arrange, named, receiver] of outcomes) {
      for (const p of Object.values(mock.providers)) p.streamTurn.mockClear()
      arrange(settings)
      // the notice is built from the settings alone, as `attachments.readers` does
      const notified = threadReaders(settings, { agentId: 'none', model: { provider: 'vercel', model: 'chat' } }, true, process.env)
      expect(notified, name).toEqual([...new Set(['vercel', named])])
      const outcome = await look(settings, [picture], 'q').then(
        () => 'looked',
        (e: unknown) => (e instanceof ToolError ? 'tool error' : 'crash')
      )
      expect(outcome, name).toBe(receiver ? 'looked' : 'tool error')
      // exactly the provider the notice named received the pictures, or nobody did
      const receivers = (['anthropic', 'xai', 'deepseek', 'vercel', 'meta'] as const).filter((id) => asked(id).length)
      expect(receivers, name).toEqual(receiver ? [receiver] : [])
    }
  })
})

describe('038 the pick cache and the listing', () => {
  const xai = (): Settings => settingsWith({ provider: 'xai', model: '' }, ['xai'])

  it('AC-2.4 (038) the same key is the same cache entry, another key another (the entry is keyed by a digest, never the key)', async () => {
    mock.providers.xai.listModels = vi.fn(async () => ['grok-4'])
    const settings = xai()
    await look(settings, [picture], 'q')
    await look({ ...settings, providers: { ...settings.providers, xai: { ...settings.providers.xai } } }, [picture], 'q')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(1)
    await look(xai(), [picture], 'q')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(2)
  })

  it('AC-2.4 (038) the cache is bounded: the oldest pick is evicted first', async () => {
    mock.providers.xai.listModels = vi.fn(async () => ['grok-4'])
    const first = xai()
    await look(first, [picture], 'q')
    const rest = Array.from({ length: MAX_PICKS }, xai)
    for (const settings of rest) await look(settings, [picture], 'q')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(MAX_PICKS + 1)
    // the newest are still cached, the oldest is listed again
    await look(rest[MAX_PICKS - 1], [picture], 'q')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(MAX_PICKS + 1)
    await look(first, [picture], 'q')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(MAX_PICKS + 2)
  })

  it('AC-2.6 (038) a late failure of an old entry does not delete the entry that replaced it', async () => {
    const settings = xai()
    let fail: (error: Error) => void = () => {}
    mock.providers.xai.listModels = vi.fn(() => new Promise<string[]>((_, reject) => (fail = reject)))
    const old = look(settings, [picture], 'q').catch((e: unknown) => e)
    // other picks push the pending one out of the cache
    mock.providers.xai.listModels.mockImplementation(async () => ['grok-4'])
    for (const other of Array.from({ length: MAX_PICKS }, xai)) await look(other, [picture], 'q')
    // the same key again is a new entry, and it resolves
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-4')
    const lists = mock.providers.xai.listModels.mock.calls.length
    fail(new Error('late'))
    expect(await old).toBeInstanceOf(ToolError)
    // the replacement is still cached: no new listing
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-4')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(lists)
  })

  it('AC-2.6 (038) a listing that never answers is a listFailed error after the timeout and is not cached', async () => {
    vi.useFakeTimers()
    const settings = xai()
    mock.providers.xai.listModels = vi.fn(() => new Promise<string[]>(() => {}))
    // two looks at the same time share the one hung listing and fail together
    const both = Promise.all([look(settings, [picture], 'q').catch((e: unknown) => e), look(settings, [picture], 'q').catch((e: unknown) => e)])
    await vi.advanceTimersByTimeAsync(LIST_TIMEOUT_MS - 1)
    expect(sent()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    for (const failure of await both) {
      expect(failure).toBeInstanceOf(ToolError)
      expect((failure as InstanceType<typeof ToolError>).text).toMatchObject({ key: 'tool.vision.listFailed', params: { provider: 'Grok', error: expect.stringMatching(/did not answer/) } })
    }
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(1)
    expect(sent()).toBe(0)
    // the hung promise did not stay in the cache: the next look lists again
    mock.providers.xai.listModels = vi.fn(async () => ['grok-4'])
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-4')
    expect(mock.providers.xai.listModels).toHaveBeenCalledTimes(1)
  })

  it('AC-2.6 (038) a listing that answers in time clears its timer', async () => {
    vi.useFakeTimers()
    mock.providers.xai.listModels = vi.fn(async () => ['grok-4'])
    await look(xai(), [picture], 'q')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('AC-4.7 (038) a settings change while the listing runs: that look finishes with what it started with, the next sees the new settings', async () => {
    const settings = settingsWith({ provider: 'anthropic', model: '' }, ['anthropic'])
    let answer: (ids: string[]) => void = () => {}
    mock.providers.anthropic.listModels = vi.fn(() => new Promise<string[]>((resolve) => (answer = resolve)))
    const running = look(settings, [picture], 'q')
    // the person picks another provider and model while the first look waits for its list
    settings.images.vision = { provider: 'xai', model: 'grok-typed' }
    answer(['claude-x-1'])
    expect((await running).text).toBe('anthropic:claude-x-1')
    expect((await look(settings, [picture], 'q')).text).toBe('xai:grok-typed')
  })
})
