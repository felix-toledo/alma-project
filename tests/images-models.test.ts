import { describe, expect, it } from 'vitest'
import {
  canCreate,
  canSee,
  CREATE_PROVIDERS,
  createCandidates,
  hasSeeRule,
  newestModel,
  pickImageModel,
  pickSeeModel,
  SEE_PROVIDERS,
  SEE_RULES,
  seeCandidates
} from '../src/shared/images/models'
import type { ProviderId } from '../src/shared/types'

const PROVIDERS: ProviderId[] = ['anthropic', 'xai', 'deepseek', 'vercel', 'meta']
const SAMPLE_IDS = ['claude-sonnet-5', 'grok-4', 'muse-spark-1.3', 'gpt-4o', 'deepseek-chat', 'anthropic/claude-sonnet-5', 'whatever']

describe('capability table (spec 038)', () => {
  it('AC-2.10 (038) one rule per provider, none accepts nothing', () => {
    expect(Object.keys(SEE_RULES).sort()).toEqual([...PROVIDERS].sort())
    for (const provider of ['deepseek', 'vercel'] as const) {
      expect(SEE_RULES[provider]).toBe('none')
      for (const id of SAMPLE_IDS) expect(canSee(provider, id), `${provider} ${id}`).toBe(false)
    }
    // anthropic: claude-*
    expect(canSee('anthropic', 'claude-sonnet-5')).toBe(true)
    expect(canSee('anthropic', 'grok-4')).toBe(false)
    expect(canSee('anthropic', 'xclaude-3')).toBe(false)
    // xai: grok-* that pass isChatModel (image/vision/video ids do not)
    expect(canSee('xai', 'grok-4')).toBe(true)
    expect(canSee('xai', 'grok-imagine-image')).toBe(false)
    expect(canSee('xai', 'grok-2-vision-1212')).toBe(false)
    expect(canSee('xai', 'grok-embed-1')).toBe(false)
    expect(canSee('xai', 'claude-sonnet-5')).toBe(false)
    // meta: muse-spark*
    expect(canSee('meta', 'muse-spark-1.3')).toBe(true)
    expect(canSee('meta', 'muse-image-1.0')).toBe(false)
    expect(canSee('meta', 'muse-voice-transcribe-1.0')).toBe(false)
    expect(canSee('meta', 'sam-3.1')).toBe(false)
    // empty id
    for (const provider of PROVIDERS) expect(canSee(provider, '')).toBe(false)
  })

  it('AC-1.5 (038) hasSeeRule is true for Anthropic, xAI, Meta and false for DeepSeek, Vercel', () => {
    expect(PROVIDERS.filter(hasSeeRule).sort()).toEqual(['anthropic', 'meta', 'xai'])
    expect(hasSeeRule('deepseek')).toBe(false)
    expect(hasSeeRule('vercel')).toBe(false)
  })

  it('AC-1.7 (038) provider lists are the ones with a client for the job', () => {
    expect([...CREATE_PROVIDERS]).toEqual(['meta', 'xai', 'openai'])
    expect([...SEE_PROVIDERS]).toEqual(['meta', 'anthropic', 'xai', 'deepseek', 'vercel'])
    expect(SEE_PROVIDERS).not.toContain('openai')
    for (const provider of ['anthropic', 'deepseek', 'vercel']) expect(CREATE_PROVIDERS).not.toContain(provider)
  })
})

describe('creation classification (spec 038, moved from coordinator/images)', () => {
  it('AC-2.8 (038) pickImageModel keeps the results it had', () => {
    expect(pickImageModel('xai', ['grok-4', 'grok-2-image', 'grok-imagine-image', 'grok-imagine-video'])).toBe('grok-imagine-image')
    expect(pickImageModel('openai', ['gpt-4o', 'dall-e-3', 'gpt-image-1', 'gpt-image-1.5'])).toBe('gpt-image-1.5')
    expect(pickImageModel('meta', ['muse-spark-1.3', 'muse-image-1.0', 'sam-3.1'])).toBe('muse-image-1.0')
    expect(pickImageModel('xai', ['grok-4', 'grok-imagine-image-edit'])).toBeUndefined()
    expect(pickImageModel('openai', [])).toBeUndefined()
  })

  it('AC-1.2 (038) canCreate excludes video and edit models for every service', () => {
    expect(canCreate('xai', 'grok-imagine-image')).toBe(true)
    expect(canCreate('xai', 'grok-imagine-video')).toBe(false)
    expect(canCreate('xai', 'grok-imagine-image-edit')).toBe(false)
    expect(canCreate('openai', 'dall-e-3')).toBe(true)
    expect(canCreate('openai', 'gpt-4o')).toBe(false)
    expect(canCreate('meta', 'muse-image-1.0')).toBe(true)
    expect(canCreate('meta', 'muse-spark-1.3')).toBe(false)
  })
})

describe('the pick (spec 038)', () => {
  it('AC-2.8 (038) newestModel is deterministic, numeric-aware and locale-independent', () => {
    expect(newestModel([])).toBeUndefined()
    expect(newestModel(['only'])).toBe('only')
    expect(newestModel(['v2', 'v10', 'v9'])).toBe('v10')
    expect(newestModel(['m-1.5', 'm-1.10', 'm-1.9'])).toBe('m-1.10')
    expect(newestModel(['a', 'b', 'b', 'a'])).toBe('b')
    // fixed 'en' collation: an accented id never outranks 'z' because of the machine's language
    expect(newestModel(['model-z', 'model-ä'])).toBe('model-z')
    // every permutation of the same list gives the same pick, ties included
    const ids = ['claude-a-2', 'claude-a-10', 'claude-b-1', 'claude-b-01', 'claude-a-9']
    const expected = newestModel(ids)
    const permute = (rest: string[], head: string[] = []): string[][] =>
      rest.length ? rest.flatMap((id, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...head, id])) : [head]
    for (const order of permute(ids)) expect(newestModel(order), order.join(',')).toBe(expected)
    expect(expected?.startsWith('claude-b-')).toBe(true)
  })

  it('AC-1.2 (038) the suggestions are in the same numeric-aware order as the pick, so the last suggestion is the pick', () => {
    expect(seeCandidates('xai', ['grok-10', 'grok-9', 'grok-2'])).toEqual(['grok-2', 'grok-9', 'grok-10'])
    expect(seeCandidates('deepseek', ['deepseek-v10', 'deepseek-v9'])).toEqual(['deepseek-v9', 'deepseek-v10'])
    expect(createCandidates('openai', ['gpt-image-10', 'gpt-image-9', 'dall-e-3'])).toEqual(['dall-e-3', 'gpt-image-9', 'gpt-image-10'])
    const ids = ['grok-4', 'grok-10', 'grok-9', 'grok-4.10', 'grok-4.9']
    expect(seeCandidates('xai', ids).at(-1)).toBe(pickSeeModel('xai', ids))
    expect(createCandidates('xai', ['grok-imagine-image-10', 'grok-imagine-image-9']).at(-1)).toBe(pickImageModel('xai', ['grok-imagine-image-10', 'grok-imagine-image-9']))
  })

  it('AC-2.8 (038) pickSeeModel picks the newest id the provider rule accepts', () => {
    expect(pickSeeModel('anthropic', ['claude-a-2', 'gpt-9', 'claude-a-10', 'claude-a-9'])).toBe('claude-a-10')
    expect(pickSeeModel('xai', ['grok-3', 'grok-4', 'grok-imagine-image-9', 'grok-4-vision'])).toBe('grok-4')
    expect(pickSeeModel('meta', ['muse-image-9', 'muse-spark-1.3', 'muse-spark-1.10'])).toBe('muse-spark-1.10')
    expect(pickSeeModel('anthropic', ['grok-4'])).toBeUndefined()
    expect(pickSeeModel('anthropic', [])).toBeUndefined()
    expect(pickSeeModel('deepseek', ['deepseek-chat', 'deepseek-reasoner'])).toBeUndefined()
    expect(pickSeeModel('vercel', ['anthropic/claude-sonnet-5'])).toBeUndefined()
  })
})

describe('suggestions (spec 038)', () => {
  it('AC-1.2 (038) candidates are the classified ids, alphabetical', () => {
    expect(createCandidates('xai', ['grok-4', 'grok-imagine-video', 'grok-imagine-image-edit', 'grok-imagine-image', 'grok-2-image'])).toEqual([
      'grok-2-image',
      'grok-imagine-image'
    ])
    expect(createCandidates('meta', [])).toEqual([])
    expect(createCandidates('openai', ['gpt-4o', 'embed-1'])).toEqual([])
    expect(seeCandidates('anthropic', ['claude-b', 'gpt-4o', 'claude-a'])).toEqual(['claude-a', 'claude-b'])
    expect(seeCandidates('meta', ['muse-spark-2', 'muse-image-1.0', 'muse-spark-1'])).toEqual(['muse-spark-1', 'muse-spark-2'])
    expect(seeCandidates('xai', [])).toEqual([])
  })

  it('AC-1.2 (038) a provider with no rule suggests every chat model it lists', () => {
    expect(seeCandidates('deepseek', ['deepseek-reasoner', 'deepseek-embed-1', 'deepseek-chat'])).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(seeCandidates('vercel', ['openai/gpt-4o', 'openai/text-embedding-3', 'anthropic/claude-sonnet-5'])).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-4o'
    ])
  })
})
