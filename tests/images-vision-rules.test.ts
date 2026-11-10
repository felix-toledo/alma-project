import { describe, expect, it } from 'vitest'
import { applyMetaDefault, defaultSettings } from '../src/shared/defaults'
import { en } from '../src/shared/i18n/en'
import { es } from '../src/shared/i18n/es'
import { acceptImagesPatch, migrateLegacyVision, omitLegacyVision, resolveVision, sanitizeImagesSettings } from '../src/shared/images/vision'
import { acknowledgeNotice, pickVisionModel, planSeeModelSave, planSeeProvider, threadReaders } from '../src/shared/attach/readers'
import type { AgentProfile, ProviderId, Settings } from '../src/shared/types'

type Images = Settings['images']

const base = (): Images => defaultSettings().images
const KEY_SHAPED = `xai-${'x'.repeat(20)}`
const SK_SHAPED = `sk-${'y'.repeat(20)}`
const EMPTY = { provider: '', model: '' }

describe('038 defaults', () => {
  it('AC-1.8 (038) defaults carry an empty see choice and applyMetaDefault keeps a chosen one', () => {
    expect(defaultSettings().images.vision).toEqual({ provider: '', model: '' })

    const old = defaultSettings()
    old.images = { provider: 'xai', model: '', vision: { provider: 'anthropic', model: 'claude-x' } }
    const moved = applyMetaDefault(old, true)
    expect(moved.images).toEqual({ provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-x' } })
  })
})

describe('038 loading the images settings', () => {
  it('AC-1.8 (038) a stored images without or with a malformed vision loads with it empty', () => {
    const malformed: unknown[] = [
      undefined,
      'xai',
      [],
      null,
      7,
      { provider: 'nope', model: 'm' }, // unknown provider
      { provider: 'xai', model: 5 }, // non-string model
      { provider: 'xai' }, // no model at all
      { provider: '', model: 'm' }, // a model with no provider
      { provider: 5, model: '' }
    ]
    for (const vision of malformed) {
      const { images, wipedKey } = sanitizeImagesSettings({ provider: 'xai', model: 'grok-imagine-image', vision }, base())
      expect(images, JSON.stringify(vision)).toEqual({ provider: 'xai', model: 'grok-imagine-image', vision: EMPTY })
      expect(wipedKey).toBe(false)
    }
    for (const stored of [undefined, null, 'x', [], 3, {}]) {
      expect(sanitizeImagesSettings(stored, base()), JSON.stringify(stored)).toEqual({ images: base(), wipedKey: false })
    }
  })

  it('AC-1.8 (038) a valid stored vision is kept and the create part falls back field by field', () => {
    const stored = { provider: 'openai', model: 'gpt-image-1', vision: { provider: 'anthropic', model: 'claude-x' } }
    expect(sanitizeImagesSettings(stored, base()).images).toEqual(stored)
    expect(sanitizeImagesSettings({ vision: { provider: 'meta', model: '' } }, base()).images).toEqual({ ...base(), vision: { provider: 'meta', model: '' } })
    // a create service this version has no client for loads as the default one
    expect(sanitizeImagesSettings({ provider: 'anthropic', model: 3 }, base()).images).toEqual(base())
  })

  it('AC-1.4 (038) a key in either model field is blanked on load', () => {
    for (const [model, visionModel, expectedModel, expectedVision] of [
      [KEY_SHAPED, 'claude-x', '', 'claude-x'],
      ['grok-imagine-image', SK_SHAPED, 'grok-imagine-image', ''],
      [KEY_SHAPED, SK_SHAPED, '', '']
    ]) {
      const { images, wipedKey } = sanitizeImagesSettings({ provider: 'xai', model, vision: { provider: 'xai', model: visionModel } }, base())
      expect(images).toEqual({ provider: 'xai', model: expectedModel, vision: { provider: 'xai', model: expectedVision } })
      expect(wipedKey).toBe(true)
    }
    // a pasted key with surrounding space is still a key
    expect(sanitizeImagesSettings({ vision: { provider: 'xai', model: ` ${KEY_SHAPED} ` } }, base()).wipedKey).toBe(true)
    // a model that merely resembles one is not touched
    expect(sanitizeImagesSettings({ vision: { provider: 'xai', model: 'sk-short' } }, base())).toMatchObject({ wipedKey: false })
  })

  it('AC-1.4 (038) a key in the see model is wiped from disk even when its provider is empty, unknown or the whole vision malformed', () => {
    for (const vision of [{ provider: '', model: KEY_SHAPED }, { provider: 'nope', model: SK_SHAPED }, { provider: 5, model: KEY_SHAPED }, { model: ` ${KEY_SHAPED} ` }]) {
      const { images, wipedKey } = sanitizeImagesSettings({ vision }, base())
      expect(wipedKey, JSON.stringify(vision)).toBe(true)
      expect(JSON.stringify(images)).not.toContain('xxxxxxxxxx')
      expect(JSON.stringify(images)).not.toContain('yyyyyyyyyy')
    }
    // the create model is judged the same way whatever the provider next to it holds
    expect(sanitizeImagesSettings({ provider: 'nope', model: KEY_SHAPED }, base()).wipedKey).toBe(true)
  })

  it('AC-1.8 (038) sanitizing does not mutate its inputs', () => {
    const stored = { provider: 'xai', model: KEY_SHAPED, vision: { provider: 'xai', model: SK_SHAPED } }
    const snapshot = JSON.stringify(stored)
    const defaults = base()
    sanitizeImagesSettings(stored, defaults)
    expect(JSON.stringify(stored)).toBe(snapshot)
    expect(defaults).toEqual(base())
  })
})

describe('038 patching the images settings', () => {
  // The two groups' edits as the tab sends them: always the whole object plus the change (AC-1.8).
  const edits: Record<string, (current: Images) => Images> = {
    'create service': (c) => ({ ...c, provider: 'openai', model: '' }),
    'create model': (c) => ({ ...c, model: 'gpt-image-1' }),
    'see provider': (c) => ({ ...c, vision: { provider: 'anthropic', model: '' } }),
    'see model': (c) => ({ ...c, vision: { ...c.vision, model: 'claude-x' } })
  }
  const permute = <T>(rest: T[], head: T[] = []): T[][] => (rest.length ? rest.flatMap((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...head, x])) : [head])
  const run = (names: string[], start: Images): Images => names.reduce((state, name) => acceptImagesPatch(state, edits[name](state)), start)

  it('AC-1.8 (038) any order of edits keeps the other group', () => {
    const start = base()
    const create = ['create service', 'create model']
    const see = ['see provider', 'see model']
    const createAlone = run(create, start)
    const seeAlone = run(see, start)
    expect(createAlone).toEqual({ provider: 'openai', model: 'gpt-image-1', vision: EMPTY })
    expect(seeAlone).toEqual({ provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-x' } })
    let checked = 0
    for (const order of permute(Object.keys(edits))) {
      const finalState = run(order, start)
      const label = order.join(' > ')
      // each group's edits keep their own relative order in `order`, which is how a person edits them
      const inOrder = (group: string[]) => group.every((name, i) => i === 0 || order.indexOf(group[i - 1]) < order.indexOf(name))
      if (inOrder(create) && inOrder(see)) {
        checked++
        expect({ provider: finalState.provider, model: finalState.model }, label).toEqual({ provider: createAlone.provider, model: createAlone.model })
        expect(finalState.vision, label).toEqual(seeAlone.vision)
      }
    }
    expect(checked).toBe(6) // 4! orders, 4!/(2!2!) keep each group's own order
  })

  it('AC-1.8 (038) a patch that omits or malforms vision keeps the current one', () => {
    const current: Images = { provider: 'meta', model: '', vision: { provider: 'xai', model: 'grok-4' } }
    const kept = { provider: 'openai', model: 'gpt-image-1', vision: current.vision }
    for (const vision of [undefined, 'xai', [], null, 3, { provider: 'nope', model: 'm' }, { provider: 'xai', model: 5 }, { provider: '', model: 'm' }]) {
      const patch = vision === undefined ? { provider: 'openai', model: 'gpt-image-1' } : { provider: 'openai', model: 'gpt-image-1', vision }
      expect(acceptImagesPatch(current, patch), JSON.stringify(vision)).toEqual(kept)
    }
    // not an object at all: nothing changes
    for (const patch of [undefined, null, 'x', [], 4]) expect(acceptImagesPatch(current, patch), JSON.stringify(patch)).toEqual(current)
    // a patch may clear the see choice on purpose ("Automatic")
    expect(acceptImagesPatch(current, { ...current, vision: EMPTY }).vision).toEqual(EMPTY)
    // invalid create fields keep their value, valid ones apply
    expect(acceptImagesPatch(current, { provider: 'anthropic', model: 3, vision: current.vision })).toEqual(current)
    expect(acceptImagesPatch(current, { vision: { provider: 'meta', model: '' } })).toEqual({ ...current, vision: { provider: 'meta', model: '' } })
  })

  it('AC-1.8 (038) accepting a patch does not mutate the current settings', () => {
    const current: Images = { provider: 'meta', model: '', vision: { provider: 'xai', model: 'grok-4' } }
    const snapshot = JSON.stringify(current)
    acceptImagesPatch(current, { provider: 'xai', model: 'm', vision: EMPTY })
    expect(JSON.stringify(current)).toBe(snapshot)
  })
})

describe('038 who looks (the acknowledgement gate and the fallback chain)', () => {
  const agent = (id: string, provider: ProviderId, model = `${provider}-model`): AgentProfile => ({ ...defaultSettings().agents[0], id, provider, model })
  // house agent h (deepseek), default agent d (xai), others a (anthropic) and z (vercel)
  const world = (vision: Settings['images']['vision'], noticeAcknowledged: ProviderId[] = []): Settings => {
    const settings = defaultSettings()
    settings.agents = [agent('a', 'anthropic'), agent('d', 'xai'), agent('h', 'deepseek'), agent('z', 'vercel')]
    settings.defaultAgentId = 'd'
    settings.home = { ...settings.home, agentId: 'h' }
    settings.images = { ...settings.images, vision }
    settings.attachments = { noticeAcknowledged }
    return settings
  }
  const keys = (...providers: ProviderId[]) => (provider: ProviderId) => providers.includes(provider)
  const ALL = keys('anthropic', 'xai', 'deepseek', 'vercel', 'meta')

  it('AC-4.6 (038) gate table', () => {
    // '' provider: the fallback chain, whatever the list holds
    expect(resolveVision(world({ provider: '', model: '' }), ALL)).toEqual({ provider: 'deepseek', model: 'deepseek-model', via: 'fallback' })
    expect(resolveVision(world({ provider: '', model: '' }, ['anthropic']), ALL).via).toBe('fallback')
    // a typed model: the pair is used, acknowledged or not
    expect(resolveVision(world({ provider: 'anthropic', model: 'claude-x' }), ALL)).toEqual({ provider: 'anthropic', model: 'claude-x', via: 'chosen' })
    expect(resolveVision(world({ provider: 'anthropic', model: 'claude-x' }, ['anthropic']), ALL)).toEqual({ provider: 'anthropic', model: 'claude-x', via: 'chosen' })
    // provider only, acknowledged: chosen with an empty model for the coordinator to complete
    expect(resolveVision(world({ provider: 'anthropic', model: '' }, ['anthropic']), ALL)).toEqual({ provider: 'anthropic', model: '', via: 'chosen' })
    // provider only, not acknowledged (or only another provider is): the fallback chain, with the held provider reported
    expect(resolveVision(world({ provider: 'anthropic', model: '' }), ALL)).toEqual({ provider: 'deepseek', model: 'deepseek-model', via: 'fallback', held: 'anthropic' })
    expect(resolveVision(world({ provider: 'anthropic', model: '' }, ['xai', 'meta']), ALL)).toMatchObject({ via: 'fallback', held: 'anthropic' })
  })

  it('AC-4.6 (038) a chosen provider is used without asking whether it has a key', () => {
    // the gate decides who receives the picture; a missing key surfaces later as the provider's own error (AC-2.6)
    expect(resolveVision(world({ provider: 'anthropic', model: 'claude-x' }), keys())).toMatchObject({ provider: 'anthropic', via: 'chosen' })
    expect(resolveVision(world({ provider: 'meta', model: '' }, ['meta']), keys())).toMatchObject({ provider: 'meta', via: 'chosen' })
  })

  it('AC-2.9 (038) empty or held see provider uses house, default, any-with-key, first agent', () => {
    const empty = { provider: '', model: '' } as const
    const held = { provider: 'meta', model: '' } as const
    for (const vision of [empty, held]) {
      const label = JSON.stringify(vision)
      // the house agent when its provider has a key
      expect(resolveVision(world(vision), ALL), label).toMatchObject({ provider: 'deepseek', model: 'deepseek-model', via: 'fallback' })
      // house agent without a key: the default agent
      expect(resolveVision(world(vision), keys('xai', 'anthropic')), label).toMatchObject({ provider: 'xai', model: 'xai-model' })
      // neither: any agent whose provider has a key, in list order
      expect(resolveVision(world(vision), keys('vercel', 'anthropic')), label).toMatchObject({ provider: 'anthropic', model: 'anthropic-model' })
      expect(resolveVision(world(vision), keys('vercel')), label).toMatchObject({ provider: 'vercel', model: 'vercel-model' })
      // no key anywhere: the first agent
      expect(resolveVision(world(vision), keys()), label).toMatchObject({ provider: 'anthropic', model: 'anthropic-model' })
    }
    // an unknown house agent id is skipped; no capability check on the fallback agent's model
    const unknownHouse = world(empty)
    unknownHouse.home = { ...unknownHouse.home, agentId: 'gone' }
    expect(resolveVision(unknownHouse, ALL)).toEqual({ provider: 'xai', model: 'xai-model', via: 'fallback' })
    const emptyModel = world(empty)
    emptyModel.agents = emptyModel.agents.map((a) => (a.id === 'h' ? { ...a, model: '' } : a))
    expect(resolveVision(emptyModel, ALL)).toEqual({ provider: 'deepseek', model: '', via: 'fallback' })
  })

  it("AC-1.6 (038) empty see provider resolves to the fallback agent's pair", () => {
    const settings = world({ provider: '', model: '' })
    expect(resolveVision(settings, keys('anthropic'))).toEqual({ provider: 'anthropic', model: 'anthropic-model', via: 'fallback' })
    // an environment key is just another `hasKey` answer
    expect(resolveVision(settings, (p) => p === 'vercel')).toEqual({ provider: 'vercel', model: 'vercel-model', via: 'fallback' })
    expect(resolveVision(settings, keys())).toEqual({ provider: 'anthropic', model: 'anthropic-model', via: 'fallback' })
  })

  it('AC-4.9 (038) held is reported with the provider that is used instead', () => {
    const settings = world({ provider: 'xai', model: '' })
    expect(resolveVision(settings, ALL)).toMatchObject({ held: 'xai', provider: 'deepseek', via: 'fallback' })
    settings.attachments = { noticeAcknowledged: ['xai'] }
    const released = resolveVision(settings, ALL)
    expect(released).toEqual({ provider: 'xai', model: '', via: 'chosen' })
    expect('held' in released).toBe(false)
    // a fallback that is not held carries no `held`
    expect('held' in resolveVision(world({ provider: '', model: '' }), ALL)).toBe(false)
  })

  it('AC-4.7 (038) the gate is read at each call', () => {
    const settings = world({ provider: 'anthropic', model: '' })
    expect(resolveVision(settings, ALL).via).toBe('fallback')
    settings.attachments.noticeAcknowledged.push('anthropic')
    expect(resolveVision(settings, ALL)).toEqual({ provider: 'anthropic', model: '', via: 'chosen' })
    settings.images.vision = { provider: '', model: '' }
    expect(resolveVision(settings, ALL).via).toBe('fallback')
  })

  it('AC-4.6 (038) resolving does not mutate the settings', () => {
    const settings = world({ provider: 'anthropic', model: '' })
    const snapshot = JSON.stringify(settings)
    resolveVision(settings, ALL)
    expect(JSON.stringify(settings)).toBe(snapshot)
  })
})

describe('038 the notice names who looks', () => {
  const agent = (id: string, provider: ProviderId, model = `${provider}-model`): AgentProfile => ({ ...defaultSettings().agents[0], id, provider, model })
  // the conversation's agent `chat` answers on meta; the house agent is on deepseek; only deepseek has a key unless a test says otherwise
  const world = (vision: Images['vision'], noticeAcknowledged: ProviderId[] = []): Settings => {
    const settings = defaultSettings()
    for (const id of ['anthropic', 'xai', 'deepseek', 'vercel', 'meta'] as const) settings.providers[id].apiKey = ''
    settings.providers.deepseek.apiKey = 'k'
    settings.agents = [agent('chat', 'meta'), agent('house', 'deepseek')]
    settings.defaultAgentId = 'chat'
    settings.home = { ...settings.home, agentId: 'house' }
    settings.images = { ...settings.images, vision }
    settings.attachments = { noticeAcknowledged }
    return settings
  }
  const thread = { agentId: 'chat' }

  it('AC-4.1 (038) threadReaders names the provider the looks would use after the gate, with no network', () => {
    // typed pair: named whatever the list holds
    expect(threadReaders(world({ provider: 'anthropic', model: 'claude-x' }), thread, true, {})).toEqual(['meta', 'anthropic'])
    // provider only and acknowledged: named
    expect(threadReaders(world({ provider: 'anthropic', model: '' }, ['anthropic']), thread, true, {})).toEqual(['meta', 'anthropic'])
    // provider only, not acknowledged: the one that is really used is named, not the chosen one
    expect(threadReaders(world({ provider: 'anthropic', model: '' }), thread, true, {})).toEqual(['meta', 'deepseek'])
    // without a picture the see provider never enters
    expect(threadReaders(world({ provider: 'anthropic', model: 'claude-x' }), thread, false, {})).toEqual(['meta'])
    // the environment decides which agent is the fallback, as the keys in settings do
    expect(threadReaders(world({ provider: '', model: '' }), thread, true, { XAI_API_KEY: 'k' })).toEqual(['meta', 'deepseek'])
  })

  it('AC-4.2 (038) empty see provider names the fallback agent\'s provider once', () => {
    expect(threadReaders(world({ provider: '', model: '' }), thread, true, {})).toEqual(['meta', 'deepseek'])
    const sameProvider = world({ provider: '', model: '' })
    sameProvider.providers.deepseek.apiKey = ''
    sameProvider.providers.meta.apiKey = 'k'
    sameProvider.agents = [agent('chat', 'meta'), agent('house', 'meta')]
    expect(threadReaders(sameProvider, thread, true, {})).toEqual(['meta'])
    // a chosen provider equal to the answering one is named once too
    expect(threadReaders(world({ provider: 'meta', model: 'muse-spark-1.3' }), thread, true, {})).toEqual(['meta'])
  })

  it('AC-4.3 (038) a newly chosen unacknowledged provider is owed by the notice', () => {
    const settings = world({ provider: 'anthropic', model: 'claude-x' }, ['meta'])
    const owed = () => threadReaders(settings, thread, true, {}).filter((p) => !settings.attachments.noticeAcknowledged.includes(p))
    expect(owed()).toEqual(['anthropic'])
    settings.attachments = acknowledgeNotice(settings.attachments, ['anthropic'])
    expect(owed()).toEqual([])
    // changing it again to another provider owes that one
    settings.images.vision = { provider: 'xai', model: 'grok-4' }
    expect(owed()).toEqual(['xai'])
  })

  it('AC-4.4 (038) the notice and the look name the same provider for every outcome', () => {
    const env = { META_API_KEY: 'k' }
    const hasKey = (settings: Settings) => (p: ProviderId) => !!settings.providers[p].apiKey || (p === 'meta' && !!env.META_API_KEY)
    const outcomes: Images['vision'][] = [
      { provider: 'xai', model: 'grok-4' }, // typed
      { provider: 'xai', model: '' }, // provider only
      { provider: 'deepseek', model: '' }, // no rule
      { provider: '', model: '' } // automatic
    ]
    for (const vision of outcomes) {
      for (const acknowledged of [[], ['xai', 'deepseek']] as ProviderId[][]) {
        const settings = world(vision, acknowledged)
        const named = threadReaders(settings, thread, true, env)
        const look = resolveVision(settings, hasKey(settings))
        expect(named, `${JSON.stringify(vision)} ${acknowledged}`).toEqual([...new Set(['meta', look.provider])])
        expect(pickVisionModel(settings, env).provider).toBe(look.provider)
      }
    }
  })

  it('AC-2.9 (038) pickVisionModel is a projection of resolveVision: the model may be empty for a provider only', () => {
    expect(pickVisionModel(world({ provider: 'anthropic', model: '' }, ['anthropic']), {})).toEqual({ provider: 'anthropic', model: '' })
    expect(pickVisionModel(world({ provider: 'anthropic', model: '' }), {})).toEqual({ provider: 'deepseek', model: 'deepseek-model' })
    expect(pickVisionModel(world({ provider: 'anthropic', model: 'claude-x' }), {})).toEqual({ provider: 'anthropic', model: 'claude-x' })
    expect(pickVisionModel(world({ provider: '', model: '' }), {})).toEqual({ provider: 'deepseek', model: 'deepseek-model' }) // the house agent has a key
    const noHouseKey = world({ provider: '', model: '' })
    noHouseKey.providers.deepseek.apiKey = ''
    expect(pickVisionModel(noHouseKey, { META_API_KEY: 'k' })).toEqual({ provider: 'meta', model: 'meta-model' }) // the default agent, through the environment
  })
})

describe('038 carrying the old Casa setting over', () => {
  // Settings as an older version saved them: the pair lives in `home`, no marker.
  const legacy = (provider: unknown, model: unknown, over: Partial<Settings> = {}): Settings => {
    const settings = { ...defaultSettings(), ...over }
    settings.home = { ...settings.home, visionProvider: provider, visionModel: model } as Settings['home']
    return settings
  }
  const homeKeys = (settings: Settings) => Object.keys(settings.home)
  const ALL = () => true

  it('AC-3.1 (038) a legacy pair is copied and emptied', () => {
    const before = legacy('anthropic', 'claude-x')
    const { settings, changed } = migrateLegacyVision(before)
    expect(changed).toBe(true)
    expect(settings.images.vision).toEqual({ provider: 'anthropic', model: 'claude-x' })
    expect(settings.visionMigrated).toBe(true)
    expect(homeKeys(settings)).not.toContain('visionProvider')
    expect(homeKeys(settings)).not.toContain('visionModel')
    // nothing else moved
    expect(settings.images).toMatchObject({ provider: before.images.provider, model: before.images.model })
    expect(settings.home.agentId).toBe(before.home.agentId)
    // looks behave as before: the same pair, with no acknowledgement
    expect(resolveVision(settings, ALL)).toEqual({ provider: 'anthropic', model: 'claude-x', via: 'chosen' })
    // the input is not mutated
    expect(before.visionMigrated).toBeUndefined()
    expect(before.images.vision).toEqual(EMPTY)
    expect(homeKeys(before)).toContain('visionProvider')
  })

  it('AC-3.4 (038) a key in the legacy model is reported as wiped whatever the provider, so the store rewrites the file', () => {
    for (const provider of ['xai', '', 'nope', 'openai']) {
      const result = migrateLegacyVision(legacy(provider, KEY_SHAPED))
      expect(result.wipedKey, provider).toBe(true)
      expect(JSON.stringify(result.settings)).not.toContain(KEY_SHAPED)
    }
    // already migrated, but an older build wrote the legacy key back: it is wiped and reported too
    const stale = legacy('xai', SK_SHAPED, { visionMigrated: true })
    expect(migrateLegacyVision(stale).wipedKey).toBe(true)
    // a normal model, or none, reports nothing
    expect(migrateLegacyVision(legacy('xai', 'grok-4')).wipedKey).toBe(false)
    expect(migrateLegacyVision(legacy('xai', '')).wipedKey).toBe(false)
    expect(migrateLegacyVision(defaultSettings()).wipedKey).toBe(false)
  })

  it('AC-3.2 (038) nothing set stays unset', () => {
    for (const [provider, model] of [['', ''], [undefined, undefined], [null, null], [5, 7]]) {
      const { settings } = migrateLegacyVision(legacy(provider, model))
      expect(settings.images.vision, `${provider}/${model}`).toEqual(EMPTY)
      expect(settings.visionMigrated).toBe(true)
      expect(resolveVision(settings, ALL).via).toBe('fallback')
    }
    // a settings object with no `home` at all
    const noHome = { ...defaultSettings() } as Partial<Settings>
    delete noHome.home
    const result = migrateLegacyVision(noHome as Settings)
    expect(result.settings.images.vision).toEqual(EMPTY)
    expect(result.settings.visionMigrated).toBe(true)
    expect('home' in result.settings).toBe(false)
  })

  it('AC-3.3 (038) a legacy provider alone is copied with an empty model and is held', () => {
    const { settings } = migrateLegacyVision(legacy('xai', ''))
    expect(settings.images.vision).toEqual({ provider: 'xai', model: '' })
    expect(resolveVision(settings, ALL)).toMatchObject({ via: 'fallback', held: 'xai' })
    settings.attachments = { noticeAcknowledged: ['xai'] }
    expect(resolveVision(settings, ALL)).toEqual({ provider: 'xai', model: '', via: 'chosen' })
  })

  it('AC-3.4 (038) the marker stops a second run and legacy keys never come back', () => {
    const first = migrateLegacyVision(legacy('anthropic', 'claude-x'))
    const second = migrateLegacyVision(first.settings)
    expect(second.changed).toBe(false)
    expect(second.settings).toBe(first.settings)
    // the person then picks something else in the Images tab; stale legacy keys on disk (an older build wrote them) do not overwrite it
    const chosen: Settings = { ...first.settings, images: { ...first.settings.images, vision: { provider: 'meta', model: 'muse-spark-1.3' } } }
    const stale = { ...chosen, home: { ...chosen.home, visionProvider: 'xai', visionModel: 'grok-4' } } as Settings
    const cleaned = migrateLegacyVision(stale)
    expect(cleaned.changed).toBe(true)
    expect(cleaned.settings.images.vision).toEqual({ provider: 'meta', model: 'muse-spark-1.3' })
    expect(homeKeys(cleaned.settings)).not.toContain('visionProvider')
    expect(homeKeys(cleaned.settings)).not.toContain('visionModel')
    expect(migrateLegacyVision(cleaned.settings).changed).toBe(false)
  })

  it('AC-3.4 (038) a vision already chosen with the marker unset is not overwritten', () => {
    const settings = legacy('xai', 'grok-4')
    settings.images = { ...settings.images, vision: { provider: 'anthropic', model: '' } }
    const result = migrateLegacyVision(settings)
    expect(result.settings.images.vision).toEqual({ provider: 'anthropic', model: '' })
    expect(result.settings.visionMigrated).toBe(true)
    expect(homeKeys(result.settings)).not.toContain('visionProvider')
  })

  it('AC-3.4 (038) odd legacy values: unknown provider dropped, model without provider dropped, a key blanked', () => {
    expect(migrateLegacyVision(legacy('nope', 'm')).settings.images.vision).toEqual(EMPTY)
    expect(migrateLegacyVision(legacy('', 'claude-x')).settings.images.vision).toEqual(EMPTY)
    expect(migrateLegacyVision(legacy('openai', 'gpt-4o')).settings.images.vision).toEqual(EMPTY) // no chat client
    expect(migrateLegacyVision(legacy('xai', KEY_SHAPED)).settings.images.vision).toEqual({ provider: 'xai', model: '' })
    expect(migrateLegacyVision(legacy('', KEY_SHAPED)).settings.images.vision).toEqual(EMPTY)
    // either way the key text is gone from the settings
    expect(JSON.stringify(migrateLegacyVision(legacy('xai', KEY_SHAPED)).settings)).not.toContain(KEY_SHAPED)
  })

  it('AC-4.8 (038) planSeeProvider asks only for an unacknowledged provider and saves provider, empty model and acknowledgement in one patch', () => {
    const current = (noticeAcknowledged: ProviderId[], vision: Images['vision'] = { provider: 'anthropic', model: 'claude-x' }) => ({
      images: { provider: 'openai', model: 'gpt-image-1', vision } as Images,
      attachments: { noticeAcknowledged }
    })

    // unacknowledged: ask, and the one patch carries the provider, an empty model and the acknowledgement
    const asked = planSeeProvider(current(['meta']), 'xai')
    expect(asked.ask).toBe(true)
    expect(asked.patch).toEqual({
      images: { provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: '' } },
      attachments: { noticeAcknowledged: ['meta', 'xai'] }
    })

    // acknowledged: no ask, and the patch has no attachments
    const quiet = planSeeProvider(current(['xai']), 'xai')
    expect(quiet.ask).toBe(false)
    expect(quiet.patch).toEqual({ images: { provider: 'openai', model: 'gpt-image-1', vision: { provider: 'xai', model: '' } } })
    expect('attachments' in quiet.patch).toBe(false)

    // "Automatic" never asks and clears both fields
    for (const acknowledged of [[], ['xai']] as ProviderId[][]) {
      const auto = planSeeProvider(current(acknowledged), '')
      expect(auto.ask).toBe(false)
      expect(auto.needsModel).toBe(false)
      expect(auto.patch).toEqual({ images: { provider: 'openai', model: 'gpt-image-1', vision: EMPTY } })
    }

    // the create group is untouched in every case, and the inputs are not mutated
    const input = current(['meta'])
    const snapshot = JSON.stringify(input)
    expect(planSeeProvider(input, 'deepseek', 'deepseek-vl').patch.images).toMatchObject({ provider: 'openai', model: 'gpt-image-1' })
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('AC-1.3 (038) changing a provider clears the model in the patch', () => {
    const settings = { images: { provider: 'meta', model: '', vision: { provider: 'anthropic', model: 'claude-x' } } as Images, attachments: { noticeAcknowledged: ['anthropic', 'xai'] as ProviderId[] } }
    // another provider: the model leaves with the old provider
    expect(planSeeProvider(settings, 'xai').patch.images.vision).toEqual({ provider: 'xai', model: '' })
    // the same provider picked again: also saved empty (a new pick starts without a model)
    expect(planSeeProvider(settings, 'anthropic').patch.images.vision).toEqual({ provider: 'anthropic', model: '' })
    expect(planSeeProvider(settings, '').patch.images.vision).toEqual(EMPTY)
  })

  it('AC-4.8 (038) a provider with no rule needs a model before it can be confirmed (owner decision on G5)', () => {
    const settings = { images: base(), attachments: { noticeAcknowledged: [] as ProviderId[] } }
    for (const provider of ['deepseek', 'vercel'] as const) {
      const empty = planSeeProvider(settings, provider)
      expect(empty.ask, provider).toBe(true)
      expect(empty.needsModel, provider).toBe(true)
      // whitespace is not a model
      expect(planSeeProvider(settings, provider, '   ').needsModel, provider).toBe(true)
      // typed in the dialog: nothing more is needed, and the same patch saves provider, that model and the acknowledgement
      const typed = planSeeProvider(settings, provider, ' my-model ')
      expect(typed.needsModel, provider).toBe(false)
      expect(typed.patch.images.vision).toEqual({ provider, model: 'my-model' })
      expect(typed.patch.attachments?.noticeAcknowledged).toEqual([provider])
    }
    // providers with a rule find their own model; Automatic needs none
    for (const provider of ['anthropic', 'xai', 'meta', ''] as const) expect(planSeeProvider(settings, provider).needsModel, provider).toBe(false)
  })

  it('AC-4.8 (038) the dialog opens for an unacknowledged provider and, even if acknowledged, for one that still needs a model (G5)', () => {
    const settings = (noticeAcknowledged: ProviderId[]) => ({ images: base(), attachments: { noticeAcknowledged } })
    // [provider, acknowledged, typed model] -> [dialog, Confirm disabled]
    const table: [ProviderId | '', boolean, string, boolean, boolean][] = [
      ['xai', false, '', true, false], // asks, can confirm at once
      ['xai', true, '', false, false], // already acknowledged and finds its own model: saved with no dialog
      ['deepseek', false, '', true, true], // asks and a model is required
      ['deepseek', true, '', true, true], // acknowledged but would be left with no model: dialog opens anyway
      ['vercel', true, '   ', true, true], // blanks are not a model
      ['deepseek', false, 'deepseek-vl', true, false], // typed: confirm enabled
      ['deepseek', true, 'deepseek-vl', false, false], // acknowledged and typed: nothing to ask
      ['', false, '', false, false], // Automatic never opens it
      ['', true, '', false, false]
    ]
    for (const [provider, acknowledged, model, dialog, disabled] of table) {
      const plan = planSeeProvider(settings(acknowledged ? (provider ? [provider] : []) : []), provider, model)
      const label = `${provider || 'auto'} ack=${acknowledged} model=${JSON.stringify(model)}`
      expect(plan.dialog, label).toBe(dialog)
      expect(plan.needsModel, label).toBe(disabled)
    }
    // the acknowledged-but-modelless case saves provider + typed model and adds no acknowledgement
    const done = planSeeProvider(settings(['deepseek']), 'deepseek', 'deepseek-vl')
    expect(done.patch.images.vision).toEqual({ provider: 'deepseek', model: 'deepseek-vl' })
    expect('attachments' in done.patch).toBe(false)
  })

  it('AC-4.8 (038) saving the typed model goes through the same gate as picking the provider (a typed pair is never used before the dialog)', () => {
    const settings = (noticeAcknowledged: ProviderId[]) => ({ images: base(), attachments: { noticeAcknowledged } })
    // held: a provider chosen but not acknowledged, then a model typed and saved -> the dialog, nothing written yet
    for (const provider of ['xai', 'anthropic', 'meta', 'deepseek'] as const) expect(planSeeModelSave(settings([]), provider, 'some-model').action, provider).toBe('confirm')
    // acknowledged: one direct patch with the trimmed model and no acknowledgement
    const direct = planSeeModelSave(settings(['xai']), 'xai', ' grok-4 ')
    expect(direct.action).toBe('apply')
    expect(direct.patch).toEqual({ images: { ...base(), vision: { provider: 'xai', model: 'grok-4' } } })
    // a rule provider cleared back to "find it yourself" is allowed
    expect(planSeeModelSave(settings(['xai']), 'xai', '').action).toBe('apply')
    // no rule and no model is blocked, acknowledged or not, whitespace included
    for (const ack of [[], ['deepseek', 'vercel']] as ProviderId[][]) {
      for (const provider of ['deepseek', 'vercel'] as const) for (const model of ['', '   ']) expect(planSeeModelSave(settings(ack), provider, model).action, `${provider} ${JSON.stringify(model)}`).toBe('blocked')
    }
    // a model that looks like an API key is never saved
    expect(planSeeModelSave(settings(['xai']), 'xai', KEY_SHAPED).action).toBe('blocked')
    expect(planSeeModelSave(settings([]), 'xai', SK_SHAPED).action).toBe('blocked')
  })

  it('AC-3.4 (038) omitLegacyVision strips the two keys from a home patch and nothing else', () => {
    const patch = { enabled: true, visionProvider: 'xai', visionModel: 'grok-4', agentId: 'h' }
    expect(omitLegacyVision(patch)).toEqual({ enabled: true, agentId: 'h' })
    expect(patch).toHaveProperty('visionProvider') // not mutated
    const clean = { enabled: true }
    expect(omitLegacyVision(clean)).toEqual({ enabled: true })
    expect(omitLegacyVision({})).toEqual({})
  })
})

describe('038 texts', () => {
  // Plan section 3: each new key and the placeholders its text is formatted with.
  const NEW_KEYS: Record<string, string[]> = {
    'images.see.title': [],
    'images.see.about': [],
    'images.see.provider': [],
    'images.see.auto': [],
    'images.see.model': [],
    'images.see.fetchModels': [],
    'images.see.autoRule': ['provider'],
    'images.see.autoNone': ['provider'],
    'images.see.using': ['provider', 'model'],
    'images.see.held': ['provider', 'using'],
    'images.see.confirmNow': ['provider'],
    'images.see.confirm.title': ['provider'],
    'images.see.confirm.body': ['provider'],
    'images.see.confirm.accept': [],
    'images.see.confirm.model': [],
    'home.think.visionUsing': ['provider', 'model'],
    'home.think.visionAuto': [],
    'home.think.visionOpen': [],
    'tool.vision.noModel': ['provider'],
    'tool.vision.listFailed': ['provider', 'error']
  }
  const placeholders = (text: unknown): string[] => [...new Set(String(text).match(/\{\w+\}/g) ?? [])].map((p) => p.slice(1, -1)).sort()

  it('AC-5.1 (038) every new key exists in es and en', () => {
    const dictionaries: Record<string, Record<string, unknown>> = { es, en }
    for (const [key, params] of Object.entries(NEW_KEYS)) {
      for (const [language, dictionary] of Object.entries(dictionaries)) {
        const text = dictionary[key]
        expect(typeof text, `${language} ${key}`).toBe('string')
        expect(text, `${language} ${key}`).not.toBe('')
        expect(placeholders(text), `${language} ${key}`).toEqual([...params].sort())
      }
    }
  })
})
