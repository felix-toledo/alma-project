import { DEEPSEEK_BASE_URL, META_BASE_URL, VERCEL_BASE_URL } from '../../shared/defaults'
import type { ProviderId, Settings } from '../../shared/types'
import { AnthropicProvider } from './anthropic'
import type { Provider } from './types'
import { DEEPSEEK, META, VERCEL, XaiProvider } from './xai'

const cache = new Map<string, Provider>()

/** Returns a provider client for the current credentials, reusing it while they don't change. */
export function getProvider(id: ProviderId, settings: Settings): Provider {
  const { anthropic, xai, deepseek, vercel, meta } = settings.providers
  const key =
    id === 'anthropic'
      ? `anthropic|${anthropic.apiKey}`
      : id === 'xai'
        ? `xai|${xai.apiKey}|${xai.baseUrl}`
        : id === 'deepseek'
          ? `deepseek|${deepseek.apiKey}`
          : id === 'vercel'
            ? `vercel|${vercel.apiKey}`
            : `meta|${meta.apiKey}`
  let provider = cache.get(key)
  if (!provider) {
    provider =
      id === 'anthropic'
        ? new AnthropicProvider(anthropic.apiKey)
        : id === 'xai'
          ? new XaiProvider(xai.apiKey, xai.baseUrl)
          : id === 'deepseek'
            ? new XaiProvider(deepseek.apiKey, DEEPSEEK_BASE_URL, DEEPSEEK)
            : id === 'vercel'
              ? new XaiProvider(vercel.apiKey, VERCEL_BASE_URL, VERCEL)
              : new XaiProvider(meta.apiKey, META_BASE_URL, META)
    for (const existing of cache.keys()) if (existing.startsWith(`${id}|`)) cache.delete(existing)
    cache.set(key, provider)
  }
  return provider
}
