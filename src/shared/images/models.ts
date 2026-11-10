import { isChatModel } from '../defaults'
import type { ImageProviderId, ProviderId } from '../types'

/** Which model ids of a provider can look at a picture; 'none' = no known id does (unknown means cannot see, never guess). */
export type SeeRule = ((id: string) => boolean) | 'none'

/** One entry per provider (a missing one fails typecheck). Flipping DeepSeek or Vercel to "can see" is a change of that one entry. */
export const SEE_RULES: Record<ProviderId, SeeRule> = {
  anthropic: (id) => id.startsWith('claude-'),
  xai: (id) => id.startsWith('grok-') && isChatModel(id),
  meta: (id) => id.startsWith('muse-spark'),
  deepseek: 'none',
  vercel: 'none'
}

const CREATE_RULES: Record<ImageProviderId, RegExp> = { xai: /image|imagine/, openai: /^(gpt-image|dall-e)/, meta: /^muse-image/ }

/** Providers Alma has an image client for. */
export const CREATE_PROVIDERS: readonly ImageProviderId[] = ['meta', 'xai', 'openai']
/** Providers Alma has a chat client for (the ones that take images), in the order of the agent selects. */
export const SEE_PROVIDERS: readonly ProviderId[] = ['meta', 'anthropic', 'xai', 'deepseek', 'vercel']

export function canCreate(provider: ImageProviderId, id: string): boolean {
  return CREATE_RULES[provider].test(id) && !/video|edit/.test(id)
}

export function canSee(provider: ProviderId, id: string): boolean {
  const rule = SEE_RULES[provider]
  return rule !== 'none' && rule(id)
}

export function hasSeeRule(provider: ProviderId): boolean {
  return SEE_RULES[provider] !== 'none'
}

const collator = new Intl.Collator('en', { numeric: true })

/** Name order: numeric-aware, then by code unit so equal-looking ids never swap places. */
const byName = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)

/**
 * The last id in numeric-aware name order (not a release date: a name that sorts last is not always the newest model). Fixed locale
 * and a code-unit tie-break: the same list always gives the same pick.
 */
export function newestModel(ids: readonly string[]): string | undefined {
  let best: string | undefined
  for (const id of ids) {
    if (best === undefined) best = id
    else {
      const order = collator.compare(id, best)
      if (order > 0 || (order === 0 && id > best)) best = id
    }
  }
  return best
}

export function pickImageModel(provider: ImageProviderId, ids: string[]): string | undefined {
  return newestModel(ids.filter((id) => canCreate(provider, id)))
}

export function pickSeeModel(provider: ProviderId, ids: string[]): string | undefined {
  return newestModel(ids.filter((id) => canSee(provider, id)))
}

export function createCandidates(provider: ImageProviderId, ids: string[]): string[] {
  return ids.filter((id) => canCreate(provider, id)).sort(byName)
}

/** The ids a see provider's rule accepts; with no rule, every chat model it lists so the person can pick one by hand. */
export function seeCandidates(provider: ProviderId, ids: string[]): string[] {
  return ids.filter(hasSeeRule(provider) ? (id) => canSee(provider, id) : isChatModel).sort(byName)
}
