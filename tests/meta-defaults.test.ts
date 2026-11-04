import { describe, expect, it } from 'vitest'
import { imageSize } from '../src/coordinator/images'
import { applyMetaDefault, DEFAULT_AGENTS, defaultSettings, effectiveProfile, isChatModel } from '../src/shared/defaults'
import type { Thread } from '../src/shared/types'

const thread = (model?: Thread['model']): Pick<Thread, 'model'> => ({ model })

describe('Meta by default (spec 024)', () => {
  it('AC-5.1 fresh settings point every default agent, the review and the images at Meta', () => {
    const settings = defaultSettings()
    const own = ['grok', 'deepseek', 'vercel']
    for (const agent of DEFAULT_AGENTS.filter((a) => !own.includes(a.id))) expect(agent.provider, agent.id).toBe('meta')
    for (const [id, provider] of Object.entries({ grok: 'xai', deepseek: 'deepseek', vercel: 'vercel' })) expect(DEFAULT_AGENTS.find((a) => a.id === id)?.provider).toBe(provider)
    expect(settings.autoReview.provider).toBe('meta')
    expect(settings.images.provider).toBe('meta')
    expect(settings.voice.sendDelayMs).toBe(1000)
  })

  it('AC-5.2 moves untouched Anthropic defaults to Meta once, and only with a Meta key', () => {
    const old = defaultSettings()
    old.agents = old.agents.map((a) => (a.provider === 'meta' ? { ...a, provider: 'anthropic', model: 'claude-opus-5-5' } : a))
    old.agents.find((a) => a.id === 'revisor')!.provider = 'xai' // the person chose this one
    old.autoReview = { ...old.autoReview, provider: 'anthropic', model: 'claude-opus-5-5' }
    old.images = { provider: 'xai', model: '' }

    expect(applyMetaDefault(old, false)).toBe(old)

    const moved = applyMetaDefault(old, true)
    expect(moved.metaDefaultApplied).toBe(true)
    expect(moved.agents.find((a) => a.id === 'general')).toMatchObject({ provider: 'meta', model: '' })
    expect(moved.agents.find((a) => a.id === 'revisor')?.provider).toBe('xai')
    expect(moved.autoReview).toMatchObject({ provider: 'meta', model: '' })
    expect(moved.images.provider).toBe('meta')
    // Only once: a second pass (after the person switched back) changes nothing.
    expect(applyMetaDefault({ ...moved, images: { provider: 'xai', model: '' } }, true).images.provider).toBe('xai')
  })

  it('AC-5.2 keeps an image model the person chose and agents of a company', () => {
    const old = defaultSettings()
    old.images = { provider: 'xai', model: 'grok-imagine-image' }
    old.agents = [...old.agents, { ...old.agents[0], id: 'ana', companyId: 'c1', provider: 'anthropic', model: 'claude-opus-5-5' }]
    const moved = applyMetaDefault(old, true)
    expect(moved.images).toEqual({ provider: 'xai', model: 'grok-imagine-image' })
    expect(moved.agents.find((a) => a.id === 'ana')?.provider).toBe('anthropic')
  })

  it('AC-5.3 Meta image sizes follow the aspect ratio as WxH', () => {
    expect(imageSize('meta', '1:1')).toBe('1024x1024')
    expect(imageSize('meta', '4:5')).toBe('1024x1280')
    expect(imageSize('meta', '9:16')).toBe('1024x1792')
    expect(imageSize('meta', '16:9')).toBe('1792x1024')
    expect(imageSize('openai', '9:16')).toBe('1024x1536')
  })
})

describe('model per conversation (spec 024)', () => {
  const profile = DEFAULT_AGENTS.find((a) => a.id === 'general')!

  it('AC-3.1 an override replaces provider and model only; none leaves the profile as is', () => {
    expect(effectiveProfile(profile, thread())).toBe(profile)
    const swapped = effectiveProfile(profile, thread({ provider: 'xai', model: 'grok-4' }))
    expect(swapped).toMatchObject({ provider: 'xai', model: 'grok-4', tools: profile.tools, systemPrompt: profile.systemPrompt })
    expect(profile.provider).toBe('meta')
  })

  it('AC-3.2 leaves non-chat models out of the header choices', () => {
    const ids = ['muse-spark-1.3', 'muse-image-1.0', 'muse-voice-transcribe-1.0', 'sam-3', 'grok-4', 'grok-imagine-image', 'text-embedding-3', 'gpt-4o-tts']
    expect(ids.filter(isChatModel)).toEqual(['muse-spark-1.3', 'grok-4'])
  })
})
