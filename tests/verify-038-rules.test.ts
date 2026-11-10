import { describe, expect, it } from 'vitest'
import { hasKey, ENV_KEYS, pickVisionModel, planSeeProvider, threadReaders, acknowledgeNotice } from '../src/shared/attach/readers'
import { defaultSettings, isChatModel, PROVIDER_NAMES } from '../src/shared/defaults'
import {
  CREATE_PROVIDERS,
  canCreate,
  canSee,
  createCandidates,
  hasSeeRule,
  newestModel,
  pickImageModel,
  pickSeeModel,
  SEE_PROVIDERS,
  SEE_RULES,
  seeCandidates
} from '../src/shared/images/models'
import { acceptImagesPatch, migrateLegacyVision, omitLegacyVision, resolveVision, sanitizeImagesSettings } from '../src/shared/images/vision'
import type { ImageProviderId, ProviderId, Settings, VisionChoice } from '../src/shared/types'

// Independent verification of spec 038, pure logic. Written from spec.md only.

const PROVIDERS = Object.keys(PROVIDER_NAMES) as ProviderId[]

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))
}

const withVision = (vision: VisionChoice, acked: ProviderId[] = [], over: Partial<Settings> = {}): Settings => {
  const s = defaultSettings('en')
  return { ...s, images: { ...s.images, vision }, attachments: { noticeAcknowledged: acked }, ...over }
}

describe('AC-2.10 (038 verify) the capability table', () => {
  it('AC-2.10 (038 verify) has exactly one entry per chat provider and the see list is the same set', () => {
    expect(Object.keys(SEE_RULES).sort()).toEqual([...PROVIDERS].sort())
    expect([...SEE_PROVIDERS].sort()).toEqual([...PROVIDERS].sort())
    expect(PROVIDERS).toHaveLength(5)
  })

  it('AC-2.10 (038 verify) DeepSeek and Vercel are "none" and accept nothing, whatever the id', () => {
    for (const provider of ['deepseek', 'vercel'] as const) {
      expect(SEE_RULES[provider]).toBe('none')
      expect(hasSeeRule(provider)).toBe(false)
      for (const id of ['claude-opus-4', 'grok-4', 'muse-spark', 'deepseek-chat', 'gpt-4o', 'anthropic/claude-sonnet-4', '', ' ', 'vision', 'deepseek-vl']) {
        expect(canSee(provider, id), `${provider} ${id}`).toBe(false)
      }
      expect(pickSeeModel(provider, ['claude-opus-4', 'grok-4', 'deepseek-chat'])).toBeUndefined()
    }
  })

  it('AC-2.10 (038 verify) Anthropic accepts claude-* only, near-misses are out', () => {
    for (const id of ['claude-opus-4-1', 'claude-sonnet-4-5-20250929', 'claude-3-haiku', 'claude-x']) expect(canSee('anthropic', id), id).toBe(true)
    for (const id of ['claude', 'claude4', 'claude_opus', ' claude-3', 'xclaude-3', 'anthropic.claude-3', 'anthropic/claude-3', 'clod-3', '', 'grok-4', 'muse-spark']) {
      expect(canSee('anthropic', id), JSON.stringify(id)).toBe(false)
    }
  })

  it('AC-2.10 (038 verify) xAI accepts grok-* chat models only; image, vision, video, voice and malformed ids are out', () => {
    for (const id of ['grok-4', 'grok-3-mini', 'grok-code-fast-1', 'grok-4-fast-reasoning', 'grok-4.1']) expect(canSee('xai', id), id).toBe(true)
    for (const id of ['grok-vision-x', 'grok-2-vision-1212', 'grok-2-image', 'grok-imagine-image', 'grok-imagine-video', 'grok-voice', 'grok-4-multi-agent', 'grok', 'grokk-4', ' grok-4', 'xgrok-4', '', 'claude-3', 'muse-spark']) {
      expect(canSee('xai', id), JSON.stringify(id)).toBe(false)
    }
    // "grok-* that pass isChatModel" is exactly the rule
    for (const id of ['grok-4', 'grok-embed-1', 'grok-tts', 'grok-realtime', 'grok-sam-1', 'grok-transcribe']) expect(canSee('xai', id)).toBe(id.startsWith('grok-') && isChatModel(id))
  })

  it('AC-2.10 (038 verify) Meta accepts muse-spark* only; muse-image and look-alikes are out', () => {
    for (const id of ['muse-spark', 'muse-spark-1.0', 'muse-spark-2', 'muse-sparkle']) expect(canSee('meta', id), id).toBe(true)
    for (const id of ['muse-image-1.0', 'muse-spar', 'muse_spark', 'muse', 'spark', ' muse-spark', 'muse-', 'xmuse-spark', '', 'claude-3', 'grok-4']) {
      expect(canSee('meta', id), JSON.stringify(id)).toBe(false)
    }
  })

  it('AC-2.10 (038 verify) one provider never accepts another provider rule', () => {
    expect(canSee('xai', 'claude-3')).toBe(false)
    expect(canSee('anthropic', 'grok-4')).toBe(false)
    expect(canSee('meta', 'grok-4')).toBe(false)
    expect(canSee('anthropic', 'muse-spark')).toBe(false)
  })

  it('AC-2.10 (038 verify) flipping a provider from none is a change of its one entry (canSee reads only SEE_RULES)', () => {
    const original = SEE_RULES.deepseek
    try {
      SEE_RULES.deepseek = (id) => id.startsWith('deepseek-vl')
      expect(canSee('deepseek', 'deepseek-vl2')).toBe(true)
      expect(canSee('deepseek', 'deepseek-chat')).toBe(false)
      expect(hasSeeRule('deepseek')).toBe(true)
      expect(pickSeeModel('deepseek', ['deepseek-chat', 'deepseek-vl2'])).toBe('deepseek-vl2')
      expect(canSee('vercel', 'deepseek-vl2')).toBe(false)
    } finally {
      SEE_RULES.deepseek = original
    }
    expect(canSee('deepseek', 'deepseek-vl2')).toBe(false)
  })
})

describe('AC-2.8 (038 verify) the pick', () => {
  it('AC-2.8 (038 verify) is numeric-aware: 9 < 10, 4.9 < 4.10, 2 < 11 in the middle', () => {
    expect(newestModel(['grok-9', 'grok-10'])).toBe('grok-10')
    expect(newestModel(['grok-10', 'grok-9'])).toBe('grok-10')
    expect(newestModel(['grok-4.9', 'grok-4.10', 'grok-4.1'])).toBe('grok-4.10')
    expect(newestModel(['m-2-x', 'm-11-x', 'm-3-x'])).toBe('m-11-x')
    expect(newestModel(['grok-3', 'grok-10', 'grok-100', 'grok-99'])).toBe('grok-100')
  })

  it('AC-2.8 (038 verify) empty list and a single id', () => {
    expect(newestModel([])).toBeUndefined()
    expect(newestModel(['only'])).toBe('only')
    expect(newestModel(['dup', 'dup', 'dup'])).toBe('dup')
    expect(pickSeeModel('anthropic', [])).toBeUndefined()
    expect(pickImageModel('xai', [])).toBeUndefined()
  })

  it('AC-2.8 (038 verify) the same list in every order gives the same pick, ties included', () => {
    const lists = [
      ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet', 'claude-sonnet-4-5-20250929'],
      ['grok-04', 'grok-4', 'grok-004', 'Grok-4', 'grok-4.0'],
      ['a', 'A', 'b', 'B', 'a1', 'a01', 'a001']
    ]
    for (const list of lists) {
      const picks = new Set(permutations(list).map((p) => newestModel(p)))
      expect(picks.size, list.join(',')).toBe(1)
    }
  })

  it('AC-2.8 (038 verify) does not touch the list it is given', () => {
    const ids = Object.freeze(['grok-4', 'grok-10', 'grok-9']) as unknown as string[]
    expect(() => pickSeeModel('xai', ids)).not.toThrow()
    expect(() => seeCandidates('xai', ids)).not.toThrow()
    expect(() => createCandidates('xai', ids)).not.toThrow()
    expect(ids).toEqual(['grok-4', 'grok-10', 'grok-9'])
  })

  it('AC-2.4 (038 verify) only ids the rule accepts compete: a newer non-vision id never wins', () => {
    expect(pickSeeModel('xai', ['grok-4', 'grok-5-image', 'grok-5-imagine', 'grok-6-vision', 'grok-3'])).toBe('grok-4')
    expect(pickSeeModel('meta', ['muse-image-9', 'muse-spark-1', 'muse-spark-2'])).toBe('muse-spark-2')
    expect(pickSeeModel('anthropic', ['gpt-9', 'claude-3'])).toBe('claude-3')
  })

  it('AC-2.5 (038 verify) only rejected ids gives no pick for every provider', () => {
    const rejected = ['gpt-4o', 'text-embedding-3', 'whisper-1', 'grok-imagine-image', 'muse-image-1', '']
    for (const provider of PROVIDERS) expect(pickSeeModel(provider, rejected), provider).toBeUndefined()
  })

  it('BR-5 (038 verify) across families it is id order: for Anthropic the family that sorts last', () => {
    expect(pickSeeModel('anthropic', ['claude-opus-4-1', 'claude-haiku-4-5', 'claude-sonnet-4-5'])).toBe('claude-sonnet-4-5')
    expect(pickSeeModel('anthropic', ['claude-sonnet-3-7', 'claude-opus-4-1'])).toBe('claude-sonnet-3-7')
  })
})

describe('AC-1.2 (038 verify) suggestions', () => {
  it('AC-1.2 (038 verify) see suggestions with a rule: only accepted ids, sorted, no duplicates introduced', () => {
    expect(seeCandidates('anthropic', ['claude-b', 'gpt-1', 'claude-a', 'grok-4'])).toEqual(['claude-a', 'claude-b'])
    expect(seeCandidates('xai', ['grok-4', 'grok-2-image', 'grok-3', 'grok-vision-x'])).toEqual(['grok-3', 'grok-4'])
    expect(seeCandidates('meta', ['muse-spark-2', 'muse-image-1', 'muse-spark-1'])).toEqual(['muse-spark-1', 'muse-spark-2'])
    expect(seeCandidates('anthropic', [])).toEqual([])
  })

  it('AC-1.2 (038 verify) see suggestions without a rule: every id that passes isChatModel, sorted', () => {
    const ids = ['deepseek-reasoner', 'deepseek-chat', 'text-embedding-3', 'deepseek-image', 'gpt-4o', 'claude-3', 'tts-1']
    for (const provider of ['deepseek', 'vercel'] as const) {
      expect(seeCandidates(provider, ids)).toEqual(['claude-3', 'deepseek-chat', 'deepseek-reasoner', 'gpt-4o'])
    }
  })

  it('AC-1.2 (038 verify) create suggestions: matching ids only, video and edit excluded, sorted', () => {
    expect(createCandidates('xai', ['grok-2-image', 'grok-imagine-video', 'grok-imagine-image', 'grok-imagine-image-edit', 'grok-4', 'grok-2-image-edit'])).toEqual(['grok-2-image', 'grok-imagine-image'])
    expect(createCandidates('openai', ['gpt-image-1', 'dall-e-3', 'gpt-4o', 'gpt-image-1-edit', 'dall-e-2-edit', 'my-gpt-image'])).toEqual(['dall-e-3', 'gpt-image-1'])
    expect(createCandidates('meta', ['muse-image-1.0', 'muse-spark', 'muse-image-video', 'xmuse-image-1'])).toEqual(['muse-image-1.0'])
  })
})

describe('AC-2.7 / BR-4 (038 verify) the creation classification', () => {
  const cases: [ImageProviderId, string, boolean][] = [
    ['xai', 'grok-2-image', true],
    ['xai', 'grok-imagine-image', true],
    ['xai', 'grok-imagine-video', false],
    ['xai', 'grok-imagine-image-edit', false],
    ['xai', 'grok-4', false],
    ['openai', 'gpt-image-1', true],
    ['openai', 'gpt-image-1-mini', true],
    ['openai', 'dall-e-3', true],
    ['openai', 'dall-e-3-edit', false],
    ['openai', 'gpt-4o-image', false],
    ['openai', 'GPT-IMAGE-1', false],
    ['meta', 'muse-image-1.0', true],
    ['meta', 'muse-image-edit-1', false],
    ['meta', 'muse-spark', false],
    ['meta', 'x-muse-image', false]
  ]
  for (const [provider, id, expected] of cases) {
    it(`AC-2.2 (038 verify) ${provider} ${id} -> ${expected}`, () => {
      expect(canCreate(provider, id)).toBe(expected)
    })
  }

  it('AC-1.7 (038 verify) the provider lists: create = Meta, xAI, OpenAI; see = the five chat providers', () => {
    expect([...CREATE_PROVIDERS].sort()).toEqual(['meta', 'openai', 'xai'])
    expect([...SEE_PROVIDERS].sort()).toEqual(['anthropic', 'deepseek', 'meta', 'vercel', 'xai'])
    expect(SEE_PROVIDERS).not.toContain('openai')
    expect(CREATE_PROVIDERS).not.toContain('anthropic')
    expect(CREATE_PROVIDERS).not.toContain('deepseek')
    expect(CREATE_PROVIDERS).not.toContain('vercel')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The gate (BR-14, AC-4.6, AC-4.7, AC-2.9), against an oracle written from the spec text and the pre-change chain.
// ---------------------------------------------------------------------------------------------------------------------

const KEY_SETS: ProviderId[][] = [[], ['meta'], ['xai'], ['deepseek'], ['anthropic'], ['vercel', 'deepseek'], PROVIDERS]

function chain(s: Settings, keyed: (p: ProviderId) => boolean): { provider: ProviderId; model: string } {
  const house = s.agents.find((a) => a.id === s.home.agentId)
  const dflt = s.agents.find((a) => a.id === s.defaultAgentId)
  for (const a of [house, dflt, ...s.agents]) if (a && keyed(a.provider)) return { provider: a.provider, model: a.model }
  return { provider: s.agents[0].provider, model: s.agents[0].model }
}

describe('BR-14 (038 verify) the acknowledgement gate, every combination', () => {
  it('AC-4.6 (038 verify) provider x model x acknowledged x keys x house agent, against the oracle', () => {
    let cases = 0
    for (const provider of ['', ...PROVIDERS] as (ProviderId | '')[]) {
      for (const model of ['', 'some-model']) {
        for (const acked of [false, true]) {
          for (const keys of KEY_SETS) {
            for (const houseAgent of ['', 'grok', 'nope']) {
              const base = withVision({ provider, model }, acked && provider ? [provider] : [])
              const s: Settings = { ...base, home: { ...base.home, agentId: houseAgent } }
              const keyed = (p: ProviderId): boolean => keys.includes(p)
              const got = resolveVision(s, keyed)
              const label = JSON.stringify({ provider, model, acked, keys, houseAgent })
              if (provider && model) expect(got, label).toEqual({ provider, model, via: 'chosen' })
              else if (provider && acked) expect(got, label).toEqual({ provider, model: '', via: 'chosen' })
              else {
                const expected = chain(s, keyed)
                expect({ provider: got.provider, model: got.model, via: got.via }, label).toEqual({ ...expected, via: 'fallback' })
                expect(got.held, label).toBe(provider || undefined)
              }
              cases++
            }
          }
        }
      }
    }
    expect(cases).toBe(6 * 2 * 2 * 7 * 3)
  })

  it('AC-4.6 (038 verify) acknowledging OTHER providers never opens the gate for this one', () => {
    const others = PROVIDERS.filter((p) => p !== 'xai')
    const got = resolveVision(withVision({ provider: 'xai', model: '' }, others), (p) => p === 'xai')
    expect(got.via).toBe('fallback')
    expect(got.held).toBe('xai')
  })

  it('AC-4.6 (038 verify) a held provider is not even the answer when it is the only one with a key', () => {
    const got = resolveVision(withVision({ provider: 'deepseek', model: '' }, []), (p) => p === 'deepseek')
    expect(got.via).toBe('fallback')
    // the chain may still land on deepseek by its own rules (an agent of that provider), but it is the agent's model then
    const dsAgent = defaultSettings('en').agents.find((a) => a.provider === 'deepseek')
    expect(got.provider).toBe(dsAgent?.provider)
    expect(got.model).toBe(dsAgent?.model)
  })

  it('AC-4.6 (038 verify) a whitespace-only model counts as typed by the gate (what the UI saves is trimmed, see planSeeProvider)', () => {
    // documents the pure function on a hand-edited value: "   " is truthy
    const got = resolveVision(withVision({ provider: 'deepseek', model: '   ' }, []), () => true)
    expect(got.via).toBe('chosen')
  })

  it('AC-4.7 (038 verify) the gate is read at each call: acknowledging later flips the very next resolution, no restart', () => {
    const s = withVision({ provider: 'xai', model: '' }, [])
    expect(resolveVision(s, () => true).via).toBe('fallback')
    const later: Settings = { ...s, attachments: acknowledgeNotice(s.attachments, ['xai']) }
    expect(resolveVision(later, () => true)).toMatchObject({ provider: 'xai', model: '', via: 'chosen' })
    // and back
    expect(resolveVision(s, () => true).via).toBe('fallback')
  })

  it('AC-2.9 (038 verify) the empty see provider keeps the pre-change chain, with no capability check', () => {
    const s = defaultSettings('en')
    s.home = { ...s.home, agentId: 'deepseek' }
    expect(resolveVision(s, () => true)).toMatchObject({ provider: 'deepseek', via: 'fallback' })
    s.home = { ...s.home, agentId: '' }
    s.defaultAgentId = 'grok'
    expect(resolveVision(s, () => true)).toMatchObject({ provider: 'xai', via: 'fallback' })
    // house agent without key -> default agent
    s.home = { ...s.home, agentId: 'deepseek' }
    expect(resolveVision(s, (p) => p !== 'deepseek')).toMatchObject({ provider: 'xai' })
    // nobody has a key -> first agent
    expect(resolveVision(s, () => false)).toMatchObject({ provider: s.agents[0].provider, model: s.agents[0].model })
  })

  it('AC-2.9 (038 verify) an agent with an empty model is used as is (model empty, provider of the agent)', () => {
    const s = defaultSettings('en')
    const empty = s.agents.find((a) => a.model === '')
    expect(empty).toBeDefined()
    s.home = { ...s.home, agentId: empty?.id ?? '' }
    expect(resolveVision(s, () => true)).toMatchObject({ provider: empty?.provider, model: '', via: 'fallback' })
  })

  it('AC-2.9 (038 verify) env keys count as keys (readers.hasKey), and the settings key wins nothing over the env', () => {
    const s = defaultSettings('en')
    expect(hasKey(s, 'xai', {})).toBe(false)
    expect(hasKey(s, 'xai', { XAI_API_KEY: 'x' })).toBe(true)
    expect(hasKey(s, 'xai', { XAI_API_KEY: '' })).toBe(false)
    expect(hasKey(s, 'vercel', { AI_GATEWAY_API_KEY: 'v' })).toBe(true)
    for (const p of PROVIDERS) expect(hasKey(s, p, { [ENV_KEYS[p]]: 'k' }), p).toBe(true)
    s.providers.anthropic.apiKey = 'sk-ant'
    expect(hasKey(s, 'anthropic', {})).toBe(true)
  })

  it('AC-2.9 (038 verify) fallback is byte-identical to the pre-change function for settings with no see provider', () => {
    for (const keys of KEY_SETS) {
      for (const houseAgent of ['', 'grok', 'deepseek', 'general', 'x']) {
        const s = defaultSettings('en')
        s.home = { ...s.home, agentId: houseAgent }
        for (const p of PROVIDERS) s.providers[p].apiKey = keys.includes(p) ? 'k' : ''
        expect(pickVisionModel(s, {})).toEqual(chain(s, (p) => keys.includes(p)))
      }
    }
  })
})

describe('AC-4.1 / AC-4.2 / AC-4.4 (038 verify) the notice names who the look would use', () => {
  it('AC-4.4 (038 verify) pickVisionModel, threadReaders and resolveVision agree for every combination', () => {
    for (const provider of ['', ...PROVIDERS] as (ProviderId | '')[]) {
      for (const model of ['', 'm']) {
        for (const acked of [false, true]) {
          for (const keys of KEY_SETS) {
            const s = withVision({ provider, model }, acked && provider ? [provider] : [])
            for (const p of PROVIDERS) s.providers[p].apiKey = ''
            const env: Record<string, string> = {}
            for (const p of keys) env[ENV_KEYS[p]] = 'k'
            const target = resolveVision(s, (p) => hasKey(s, p, env))
            const picked = pickVisionModel(s, env)
            expect(picked).toEqual({ provider: target.provider, model: target.model })
            const thread = { agentId: s.defaultAgentId, model: undefined }
            const readers = threadReaders(s, thread, true, env)
            expect(readers).toContain(target.provider)
            expect(new Set(readers).size).toBe(readers.length)
            // pictures off: the vision provider is not named at all unless it is the answering one
            expect(threadReaders(s, thread, false, env)).toHaveLength(1)
          }
        }
      }
    }
  })

  it('AC-4.2 (038 verify) the answering provider and the see provider are named once; different ones, both', () => {
    const s = withVision({ provider: 'meta', model: 'm' }, [])
    const general = s.agents.find((a) => a.id === 'general')
    expect(general?.provider).toBe('meta')
    expect(threadReaders(s, { agentId: 'general', model: undefined }, true, {})).toEqual(['meta'])
    const x = withVision({ provider: 'xai', model: 'grok-4' }, [])
    expect(threadReaders(x, { agentId: 'general', model: undefined }, true, {})).toEqual(['meta', 'xai'])
    // a thread model chosen in the header replaces the answering provider
    expect(threadReaders(x, { agentId: 'general', model: { provider: 'xai', model: 'grok-4' } }, true, {})).toEqual(['xai'])
  })

  it('AC-4.3 (038 verify) the notice for a newly chosen unacknowledged provider is the one named (held -> fallback provider, not the held one)', () => {
    const s = withVision({ provider: 'deepseek', model: '' }, [])
    const readers = threadReaders(s, { agentId: 'general', model: undefined }, true, { META_API_KEY: 'k' })
    expect(readers).not.toContain('deepseek')
  })

  it('AC-4.1 (038 verify) is decided from settings alone: synchronous, no promise', () => {
    const s = withVision({ provider: 'anthropic', model: '' }, ['anthropic'])
    const r = pickVisionModel(s, {})
    expect(r).toEqual({ provider: 'anthropic', model: '' })
    expect(r).not.toBeInstanceOf(Promise)
  })

  it('AC-4.1 (038 verify) an unknown thread agent falls back to the first agent without throwing', () => {
    const s = withVision({ provider: '', model: '' })
    expect(() => threadReaders(s, { agentId: 'ghost', model: undefined }, true, {})).not.toThrow()
  })
})

describe('AC-4.8 (038 verify) planSeeProvider', () => {
  const plan = (provider: ProviderId | '', model = '', acked: ProviderId[] = [], vision: VisionChoice = { provider: '', model: '' }) => {
    const s = withVision(vision, acked)
    return { s, ...planSeeProvider(s, provider, model) }
  }

  it('AC-4.8 (038 verify) "Automatic" never asks and clears both fields, nothing else', () => {
    const r = plan('', 'whatever', [], { provider: 'xai', model: 'grok-4' })
    expect(r).toMatchObject({ ask: false, needsModel: false, dialog: false })
    expect(r.patch.images.vision).toEqual({ provider: '', model: '' })
    expect(r.patch.attachments).toBeUndefined()
    expect(r.patch.images.provider).toBe(r.s.images.provider)
    expect(r.patch.images.model).toBe(r.s.images.model)
  })

  it('AC-4.8 (038 verify) unacknowledged provider with a rule: ask, one patch with provider, empty model and the acknowledgement together', () => {
    for (const provider of ['anthropic', 'xai', 'meta'] as const) {
      const r = plan(provider)
      expect(r).toMatchObject({ ask: true, needsModel: false, dialog: true })
      expect(r.patch.images.vision).toEqual({ provider, model: '' })
      expect(r.patch.attachments?.noticeAcknowledged).toContain(provider)
    }
  })

  it('AC-4.8 (038 verify) acknowledged provider with a rule saves with no confirmation and does not rewrite the list', () => {
    const r = plan('xai', '', ['xai'])
    expect(r).toMatchObject({ ask: false, needsModel: false, dialog: false })
    expect(r.patch.attachments).toBeUndefined()
    expect(r.patch.images.vision).toEqual({ provider: 'xai', model: '' })
  })

  it('AC-4.8 (038 verify) DeepSeek and Vercel table: ack x model (blank, whitespace, typed)', () => {
    for (const provider of ['deepseek', 'vercel'] as const) {
      for (const acked of [false, true]) {
        for (const [model, typed] of [['', ''], ['   ', ''], ['\t\n', ''], ['ds-chat', 'ds-chat'], ['  ds-chat  ', 'ds-chat']] as const) {
          const r = plan(provider, model, acked ? [provider] : [])
          const label = `${provider} acked=${acked} model=${JSON.stringify(model)}`
          expect(r.ask, label).toBe(!acked)
          expect(r.needsModel, label).toBe(typed === '')
          expect(r.dialog, label).toBe(!acked || typed === '')
          expect(r.patch.images.vision, label).toEqual({ provider, model: typed })
          expect(!!r.patch.attachments, label).toBe(!acked)
        }
      }
    }
  })

  it('AC-4.8 (038 verify) a provider with a rule never needs a model, blank or not', () => {
    for (const model of ['', '  ']) expect(plan('anthropic', model, ['anthropic']).needsModel).toBe(false)
  })

  it('AC-4.8 (038 verify) the patch keeps the create group and every other acknowledged provider', () => {
    const s = withVision({ provider: 'anthropic', model: 'claude-x' }, ['anthropic', 'meta'])
    s.images = { ...s.images, provider: 'openai', model: 'gpt-image-1' }
    const r = planSeeProvider(s, 'xai')
    expect(r.patch.images.provider).toBe('openai')
    expect(r.patch.images.model).toBe('gpt-image-1')
    expect(r.patch.images.vision).toEqual({ provider: 'xai', model: '' })
    expect(new Set(r.patch.attachments?.noticeAcknowledged)).toEqual(new Set(['anthropic', 'meta', 'xai']))
  })

  it('AC-4.8 (038 verify) acknowledging twice does not duplicate (idempotent list)', () => {
    const a = acknowledgeNotice({ noticeAcknowledged: ['xai'] }, ['xai', 'xai', 'meta'])
    expect(a.noticeAcknowledged.filter((p) => p === 'xai')).toHaveLength(1)
    const b = acknowledgeNotice(a, ['xai', 'meta'])
    expect(b.noticeAcknowledged.sort()).toEqual(a.noticeAcknowledged.sort())
    // an unknown id is dropped
    expect(acknowledgeNotice({ noticeAcknowledged: [] }, ['openai' as ProviderId, 'ghost' as ProviderId]).noticeAcknowledged).toEqual([])
  })

  it('AC-4.8 (038 verify) cancel = nothing changes: planning does not mutate the settings it is given', () => {
    const s = withVision({ provider: 'anthropic', model: 'claude-x' }, ['anthropic'])
    const before = structuredClone(s)
    planSeeProvider(s, 'xai')
    planSeeProvider(s, '')
    expect(s).toEqual(before)
  })

  it('AC-1.3 (038 verify) a key-shaped model typed in the confirmation is not special-cased by the plan (the UI disables Save, AC-1.4); it is trimmed', () => {
    const r = plan('deepseek', ' sk-abcdefghijklmnopqrstuvwxyz ', ['deepseek'])
    expect(r.patch.images.vision.model).toBe('sk-abcdefghijklmnopqrstuvwxyz')
  })
})

describe('AC-1.8 / AC-1.4 / AC-3.x (038 verify) sanitizing, patching and migrating', () => {
  const base = defaultSettings('en').images

  it('AC-1.8 (038 verify) a stored images that lacks or malforms the see part loads with the see part empty', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'x',
      5,
      [],
      { provider: 'xai' },
      { provider: 'xai', vision: null },
      { provider: 'xai', vision: 'anthropic' },
      { provider: 'xai', vision: [] },
      { provider: 'xai', vision: {} },
      { provider: 'xai', vision: { provider: 'anthropic' } },
      { provider: 'xai', vision: { provider: 'anthropic', model: 5 } },
      { provider: 'xai', vision: { provider: 'anthropic', model: null } },
      { provider: 'xai', vision: { provider: 'openai', model: 'gpt-4o' } },
      { provider: 'xai', vision: { provider: 'ghost', model: 'm' } },
      { provider: 'xai', vision: { provider: '', model: 'orphan' } },
      { provider: 'xai', vision: { provider: 7, model: 'm' } }
    ]
    for (const stored of bad) {
      const { images } = sanitizeImagesSettings(stored, base)
      expect(images.vision, JSON.stringify(stored)).toEqual({ provider: '', model: '' })
    }
  })

  it('AC-1.8 (038 verify) a hostile images value never throws and keeps the create group sane', () => {
    for (const stored of [undefined, null, 'x', 5, [], { provider: 'ghost', model: 4 }, { provider: ['xai'], model: {} }]) {
      const { images } = sanitizeImagesSettings(stored, base)
      expect(['meta', 'xai', 'openai']).toContain(images.provider)
      expect(typeof images.model).toBe('string')
    }
    expect(sanitizeImagesSettings({ provider: 'xai', model: 'grok-2-image', vision: { provider: 'meta', model: 'muse-spark' } }, base).images).toEqual({
      provider: 'xai',
      model: 'grok-2-image',
      vision: { provider: 'meta', model: 'muse-spark' }
    })
  })

  it('AC-1.4 (038 verify) a key in either model field is wiped on load, the other group is untouched, and it is reported', () => {
    const k = 'xai-abcdefghijklmnopqrstuvwxyz0123'
    const s = 'sk-ant-abcdefghijklmnopqrstuvwxyz'
    const both = sanitizeImagesSettings({ provider: 'openai', model: k, vision: { provider: 'anthropic', model: s } }, base)
    expect(both).toEqual({ images: { provider: 'openai', model: '', vision: { provider: 'anthropic', model: '' } }, wipedKey: true })
    const create = sanitizeImagesSettings({ provider: 'openai', model: k, vision: { provider: 'xai', model: 'grok-4' } }, base)
    expect(create.images).toEqual({ provider: 'openai', model: '', vision: { provider: 'xai', model: 'grok-4' } })
    const see = sanitizeImagesSettings({ provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: k } }, base)
    expect(see.images).toEqual({ provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: '' } })
    expect(see.wipedKey).toBe(true)
    // padded keys too
    expect(sanitizeImagesSettings({ vision: { provider: 'xai', model: `  ${k}\n` } }, base).images.vision.model).toBe('')
    // nothing to wipe
    expect(sanitizeImagesSettings({ model: 'grok-2-image' }, base).wipedKey).toBe(false)
  })

  it('AC-1.4 (038 verify) short or ordinary ids are not mistaken for keys', () => {
    for (const model of ['grok-4', 'sk-short', 'xai-short', 'claude-sonnet-4-5-20250929', 'gpt-image-1']) {
      expect(sanitizeImagesSettings({ vision: { provider: 'xai', model } }, base).images.vision.model, model).toBe(model)
    }
  })

  it('AC-1.8 (038 verify) acceptImagesPatch: omitting or malforming vision keeps the current one; every ordering of create and see patches keeps the other group', () => {
    const current = { provider: 'xai', model: 'grok-2-image', vision: { provider: 'anthropic', model: 'claude-x' } } as const
    expect(acceptImagesPatch(current, { provider: 'openai', model: 'gpt-image-1' })).toEqual({ ...current, provider: 'openai', model: 'gpt-image-1' })
    for (const vision of [undefined, null, 'x', [], {}, { provider: 'ghost', model: 'm' }, { provider: 'xai' }, { provider: 'xai', model: 1 }, { provider: 'openai', model: 'm' }, { provider: '', model: 'orphan' }]) {
      expect(acceptImagesPatch(current, { provider: 'meta', model: '', vision }).vision, JSON.stringify(vision)).toEqual(current.vision)
    }
    // create patch with only the see part, then see patch with only the create part
    expect(acceptImagesPatch(current, { vision: { provider: 'xai', model: 'grok-4' } })).toEqual({ ...current, vision: { provider: 'xai', model: 'grok-4' } })
    expect(acceptImagesPatch(current, 'garbage')).toEqual(current)
    expect(acceptImagesPatch(current, null)).toEqual(current)
    expect(acceptImagesPatch(current, undefined)).toEqual(current)
    const a = { provider: 'meta', model: '' }
    const b = { provider: 'deepseek', model: 'm' }
    const afterAB = acceptImagesPatch(acceptImagesPatch(current, a), { vision: b })
    const afterBA = acceptImagesPatch(acceptImagesPatch(current, { vision: b }), a)
    expect(afterAB).toEqual(afterBA)
    expect(afterAB).toEqual({ provider: 'meta', model: '', vision: b })
  })

  it('AC-3.1 (038 verify) a complete legacy pair moves into images.vision and leaves Casa; nothing else changes', () => {
    const s = defaultSettings('en')
    const legacy = { ...s, home: { ...s.home, visionProvider: 'xai', visionModel: 'grok-4' } } as unknown as Settings
    const r = migrateLegacyVision(legacy)
    expect(r.changed).toBe(true)
    expect(r.settings.images.vision).toEqual({ provider: 'xai', model: 'grok-4' })
    expect(r.settings.home).not.toHaveProperty('visionProvider')
    expect(r.settings.home).not.toHaveProperty('visionModel')
    expect(r.settings.visionMigrated).toBe(true)
    expect(r.settings.images.provider).toBe(s.images.provider)
    expect(r.settings.attachments.noticeAcknowledged).toEqual([])
    // behaves exactly as before: the pair works with the gate closed
    expect(resolveVision(r.settings, () => true)).toEqual({ provider: 'xai', model: 'grok-4', via: 'chosen' })
  })

  it('AC-3.2 (038 verify) no vision values: Automatic, and the marker still gets set once', () => {
    const r = migrateLegacyVision(defaultSettings('en'))
    expect(r.settings.images.vision).toEqual({ provider: '', model: '' })
    expect(r.settings.visionMigrated).toBe(true)
    for (const legacyHome of [{ visionProvider: '', visionModel: '' }, { visionProvider: '' }, { visionModel: '' }]) {
      const s = defaultSettings('en')
      const m = migrateLegacyVision({ ...s, home: { ...s.home, ...legacyHome } } as unknown as Settings)
      expect(m.settings.images.vision).toEqual({ provider: '', model: '' })
    }
  })

  it('AC-3.3 (038 verify) a legacy provider alone is carried with an empty model and stays held until acknowledged', () => {
    const s = defaultSettings('en')
    const r = migrateLegacyVision({ ...s, home: { ...s.home, visionProvider: 'anthropic' } } as unknown as Settings)
    expect(r.settings.images.vision).toEqual({ provider: 'anthropic', model: '' })
    const got = resolveVision(r.settings, () => true)
    expect(got.via).toBe('fallback')
    expect(got.held).toBe('anthropic')
    // acknowledged later: now used
    const later: Settings = { ...r.settings, attachments: { noticeAcknowledged: ['anthropic'] } }
    expect(resolveVision(later, () => true)).toMatchObject({ provider: 'anthropic', via: 'chosen' })
  })

  it('AC-3.1 (038 verify) unknown provider, openai, non-string provider/model and a key-shaped model are dropped or blanked, never carried raw', () => {
    const s = defaultSettings('en')
    const run = (home: Record<string, unknown>) => migrateLegacyVision({ ...s, home: { ...s.home, ...home } } as unknown as Settings).settings.images.vision
    expect(run({ visionProvider: 'ghost', visionModel: 'm' })).toEqual({ provider: '', model: '' })
    expect(run({ visionProvider: 'openai', visionModel: 'gpt-4o' })).toEqual({ provider: '', model: '' })
    expect(run({ visionProvider: 5, visionModel: 'm' })).toEqual({ provider: '', model: '' })
    expect(run({ visionProvider: null, visionModel: 'm' })).toEqual({ provider: '', model: '' })
    expect(run({ visionProvider: ['xai'], visionModel: 'm' })).toEqual({ provider: '', model: '' })
    expect(run({ visionModel: 'orphan' })).toEqual({ provider: '', model: '' })
    expect(run({ visionProvider: 'xai', visionModel: 7 })).toEqual({ provider: 'xai', model: '' })
    expect(run({ visionProvider: 'xai', visionModel: { a: 1 } })).toEqual({ provider: 'xai', model: '' })
    expect(run({ visionProvider: 'xai', visionModel: 'xai-abcdefghijklmnopqrstuvwxyz0123' })).toEqual({ provider: 'xai', model: '' })
    expect(run({ visionProvider: 'deepseek', visionModel: 'sk-abcdefghijklmnopqrstuvwxyz' })).toEqual({ provider: 'deepseek', model: '' })
  })

  it('AC-3.4 (038 verify) a second run does not overwrite what the person chose in Images, with or without the marker', () => {
    const s = defaultSettings('en')
    const chosen = { ...s, images: { ...s.images, vision: { provider: 'meta', model: 'muse-spark' } }, home: { ...s.home, visionProvider: 'xai', visionModel: 'grok-4' } } as unknown as Settings
    // marker unset but Images already holds a value: Images wins
    expect(migrateLegacyVision(chosen).settings.images.vision).toEqual({ provider: 'meta', model: 'muse-spark' })
    // marker set: edited old Casa values (by any path) are only stripped
    const marked: Settings = { ...chosen, visionMigrated: true }
    const r = migrateLegacyVision(marked)
    expect(r.settings.images.vision).toEqual({ provider: 'meta', model: 'muse-spark' })
    expect(r.settings.home).not.toHaveProperty('visionProvider')
    expect(r.settings.home).not.toHaveProperty('visionModel')
    // the person cleared Images to Automatic after the migration: the stale Casa pair must NOT come back
    const cleared = { ...s, visionMigrated: true, home: { ...s.home, visionProvider: 'xai', visionModel: 'grok-4' } } as unknown as Settings
    expect(migrateLegacyVision(cleared).settings.images.vision).toEqual({ provider: '', model: '' })
  })

  it('AC-3.4 (038 verify) idempotent: running again on the result changes nothing', () => {
    const s = defaultSettings('en')
    const once = migrateLegacyVision({ ...s, home: { ...s.home, visionProvider: 'xai', visionModel: 'grok-4' } } as unknown as Settings).settings
    const twice = migrateLegacyVision(once)
    expect(twice.changed).toBe(false)
    expect(twice.settings).toBe(once)
    expect(migrateLegacyVision(migrateLegacyVision(defaultSettings('en')).settings).changed).toBe(false)
  })

  it('AC-3.4 (038 verify) the legacy keys are stripped on every call even with the marker set, and the input is not mutated', () => {
    const s = defaultSettings('en')
    const input = { ...s, visionMigrated: true, home: { ...s.home, visionProvider: 'xai', visionModel: 'grok-4' } } as unknown as Settings
    const snapshot = structuredClone(input)
    const r = migrateLegacyVision(input)
    expect(r.changed).toBe(true)
    expect(Object.keys(r.settings.home)).not.toContain('visionProvider')
    expect(input).toEqual(snapshot)
    expect(omitLegacyVision({ a: 1, visionProvider: 'x', visionModel: 'y' })).toEqual({ a: 1 })
    expect(omitLegacyVision({ a: 1 })).toEqual({ a: 1 })
  })

  it('AC-3.2 (038 verify) migration never acknowledges a provider and never invents the marker on already-migrated settings', () => {
    const s = defaultSettings('en')
    const r = migrateLegacyVision({ ...s, home: { ...s.home, visionProvider: 'anthropic', visionModel: 'claude-x' } } as unknown as Settings)
    expect(r.settings.attachments.noticeAcknowledged).toEqual([])
    const done = migrateLegacyVision({ ...s, visionMigrated: true })
    expect(done.changed).toBe(false)
  })
})
