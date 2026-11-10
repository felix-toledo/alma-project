import { looksLikeApiKey } from '../defaults'
import type { AgentProfile, ProviderId, Settings, VisionChoice } from '../types'
import { CREATE_PROVIDERS, SEE_PROVIDERS } from './models'

type Images = Settings['images']

const EMPTY: VisionChoice = { provider: '', model: '' }

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined)

const isSeeProvider = (value: unknown): value is ProviderId => SEE_PROVIDERS.some((p) => p === value)
const isCreateProvider = (value: unknown): value is Images['provider'] => CREATE_PROVIDERS.some((p) => p === value)

/** A well-formed see choice, or undefined: an unknown provider, a non-string model or a model with no provider is not one. */
function parseVision(value: unknown): VisionChoice | undefined {
  const provider = field(value, 'provider')
  const model = field(value, 'model')
  if (typeof model !== 'string') return undefined
  if (provider === '') return model === '' ? { provider: '', model: '' } : undefined
  return isSeeProvider(provider) ? { provider, model } : undefined
}

/** `images` as read from disk (older versions lack `vision`, a hand-edited file may malform it): each bad part falls back to its default. */
export function sanitizeImagesSettings(value: unknown, base: Images): { images: Images; wipedKey: boolean } {
  const provider = field(value, 'provider')
  const model = field(value, 'model')
  const rawVision = field(value, 'vision')
  const vision = parseVision(rawVision) ?? EMPTY
  // A key pasted into a model field would be sent as a model name and sit unencrypted on disk. Judged on the raw strings: a vision
  // that fails parsing (empty or unknown provider) is dropped from the result, but its text must still make the file be rewritten.
  const rawSee = field(rawVision, 'model')
  const createKey = typeof model === 'string' && looksLikeApiKey(model)
  const seeKey = typeof rawSee === 'string' && looksLikeApiKey(rawSee)
  return {
    images: {
      provider: isCreateProvider(provider) ? provider : base.provider,
      model: typeof model === 'string' ? (createKey ? '' : model) : base.model,
      vision: seeKey ? { ...vision, model: '' } : { ...vision }
    },
    wipedKey: createKey || seeKey
  }
}

/** A change from the settings screen: `settings:update` replaces top-level keys whole, so a patch that leaves `vision` out or malforms it keeps the current one. */
export function acceptImagesPatch(current: Images, patch: unknown): Images {
  const provider = field(patch, 'provider')
  const model = field(patch, 'model')
  return {
    provider: isCreateProvider(provider) ? provider : current.provider,
    model: typeof model === 'string' ? model : current.model,
    vision: parseVision(field(patch, 'vision')) ?? current.vision
  }
}

/** What `resolveVision` reads; `Settings` and `PublicSettings` both satisfy it, so the renderer can call it. */
export interface VisionInput {
  agents: AgentProfile[]
  defaultAgentId: string
  home: { agentId: string }
  images: { vision: VisionChoice }
  attachments: { noticeAcknowledged: ProviderId[] }
}

export interface VisionTarget {
  provider: ProviderId
  /** '' only when `via` is 'chosen' and the person typed no model: the coordinator completes it. */
  model: string
  via: 'chosen' | 'fallback'
  /** A chosen provider-only value the gate is holding back (AC-4.6, AC-4.9). */
  held?: ProviderId
}

/**
 * Who looks at a picture (BR-7, BR-14). The one function both the looks and the notice use, so the provider the person is told about
 * is the one that receives it. A chosen provider is used when its model is typed, or when it has none and the person acknowledged
 * that provider; otherwise the agent chain runs: the house agent, the default agent, any agent whose provider has a key, the first.
 * Pure: no listing, no capability check on the chain.
 */
export function resolveVision(settings: VisionInput, hasKey: (provider: ProviderId) => boolean): VisionTarget {
  const { provider, model } = settings.images.vision
  if (provider && model) return { provider, model, via: 'chosen' }
  if (provider && settings.attachments.noticeAcknowledged.includes(provider)) return { provider, model: '', via: 'chosen' }
  const preferred = [settings.agents.find((a) => a.id === settings.home.agentId), settings.agents.find((a) => a.id === settings.defaultAgentId), ...settings.agents]
  const agent = preferred.find((a) => a && hasKey(a.provider)) ?? settings.agents[0]
  return { provider: agent.provider, model: agent.model, via: 'fallback', ...(provider ? { held: provider } : {}) }
}

/** The old Casa keys: they stop existing (spec 038 BR-1), so nothing may write them back. */
export function omitLegacyVision<T extends object>(home: T): T {
  const { visionProvider: _provider, visionModel: _model, ...rest } = home as Record<string, unknown>
  return rest as T
}

/**
 * One-time move of `home.visionProvider`/`visionModel` into `images.vision` (AC-3.1 to AC-3.4). It copies only while the marker is unset
 * and the Images tab holds nothing yet; an unknown provider or a model with no provider is dropped, a model that looks like a key is blanked
 * (and reported as `wipedKey`, so it is not left on disk). The legacy keys leave `home` on every call, marker or not, so a stale file never brings them back.
 */
export function migrateLegacyVision(settings: Settings): { settings: Settings; changed: boolean; wipedKey: boolean } {
  const home: Settings['home'] | undefined = settings.home
  const hasLegacy = !!home && ('visionProvider' in home || 'visionModel' in home)
  if (settings.visionMigrated && !hasLegacy) return { settings, changed: false, wipedKey: false }
  const cleaned = home ? { home: omitLegacyVision(home) } : {}
  const provider = field(home, 'visionProvider')
  const model = field(home, 'visionModel')
  // A key typed into the old field leaves the file with the legacy keys, so the store must rewrite it even with no keychain.
  const wipedKey = typeof model === 'string' && looksLikeApiKey(model)
  if (settings.visionMigrated) return { settings: { ...settings, ...cleaned }, changed: true, wipedKey }
  let vision = settings.images.vision
  if (!vision.provider && !vision.model && isSeeProvider(provider)) {
    vision = { provider, model: typeof model === 'string' && !looksLikeApiKey(model) ? model : '' }
  }
  return { settings: { ...settings, ...cleaned, images: { ...settings.images, vision }, visionMigrated: true }, changed: true, wipedKey }
}
