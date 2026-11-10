// Which model providers read what is attached (spec 030 AC-3.1, spec 031 AC-1.4, AC-2.8). Pure: `main` names them in the
// native dialog and the coordinator checks them on a put, and neither may import the other.
import { effectiveProfile, looksLikeApiKey } from '../defaults'
import { hasSeeRule } from '../images/models'
import { resolveVision } from '../images/vision'
import type { ProviderId, Settings, Thread } from '../types'
import { sanitizeAttachmentSettings } from './settings'

type Env = Readonly<Record<string, string | undefined>>

export const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  vercel: 'AI_GATEWAY_API_KEY',
  meta: 'META_API_KEY',
}

export function hasKey(settings: Settings, provider: ProviderId, env: Env): boolean {
  return !!settings.providers[provider].apiKey || !!env[ENV_KEYS[provider]]
}

/**
 * The model that looks, from settings alone (no listing, so `main` can call it for the native dialog): the chosen see provider once the
 * gate lets it through (spec 038 BR-14), else the model of the agent that runs the house, or the default agent, or any agent whose
 * provider has a key. The model is empty when the person chose a provider only; the coordinator completes it.
 */
export function pickVisionModel(settings: Settings, env: Env): { provider: ProviderId; model: string } {
  const { provider, model } = resolveVision(settings, (p) => hasKey(settings, p, env))
  return { provider, model }
}

/** The providers that would read this conversation's attachments: its answering provider, plus the vision one for pictures, once each. */
export function threadReaders(settings: Settings, thread: Pick<Thread, 'agentId' | 'model'>, images: boolean, env: Env): ProviderId[] {
  const agent = settings.agents.find((a) => a.id === thread.agentId) ?? settings.agents[0]
  const readers: ProviderId[] = [effectiveProfile(agent, thread).provider]
  if (images) readers.push(pickVisionModel(settings, env).provider)
  return [...new Set(readers)]
}

/** The notice list after the person allowed these providers (AC-1.4): the same list as the desktop's, once each, unknown ids dropped. */
export function acknowledgeNotice(current: Settings['attachments'], providers: readonly ProviderId[]): Settings['attachments'] {
  return sanitizeAttachmentSettings({ noticeAcknowledged: [...current.noticeAcknowledged, ...providers] })
}

/**
 * Picking a see provider in the Images tab (AC-4.8). `ask`: the person has not acknowledged that provider, so a confirmation naming it comes first.
 * `needsModel`: the provider has no capability rule (DeepSeek, Vercel), so with no model typed a look would only fail; the confirmation
 * keeps Confirm disabled until one is (owner decision on gap G5). `dialog`: whether to open the confirmation at all, which is `ask` or
 * `needsModel`, so an acknowledged provider with no model is never saved empty. `patch` is the one update to save: the provider, the typed model (empty
 * when changing the provider, AC-1.3) and, when asking, the acknowledgement; "Automatic" ('') clears both and never asks.
 */
export function planSeeProvider(
  settings: Pick<Settings, 'images' | 'attachments'>,
  provider: ProviderId | '',
  model = ''
): { ask: boolean; needsModel: boolean; dialog: boolean; patch: { images: Settings['images']; attachments?: Settings['attachments'] } } {
  if (!provider) return { ask: false, needsModel: false, dialog: false, patch: { images: { ...settings.images, vision: { provider: '', model: '' } } } }
  const typed = model.trim()
  const ask = !settings.attachments.noticeAcknowledged.includes(provider)
  const needsModel = !hasSeeRule(provider) && !typed
  return {
    ask,
    needsModel,
    dialog: ask || needsModel,
    patch: {
      images: { ...settings.images, vision: { provider, model: typed } },
      ...(ask ? { attachments: acknowledgeNotice(settings.attachments, [provider]) } : {})
    }
  }
}

/**
 * Saving the model typed next to a chosen see provider (spec 038 AC-4.8). The save goes through `planSeeProvider` like picking the provider does:
 * 'blocked' when no model can be saved (a provider with no rule and a blank model, or a model that looks like an API key), 'confirm' when the
 * provider is not acknowledged yet (the dialog comes first, so a typed model is never used without it), else 'apply' with the one patch.
 */
export function planSeeModelSave(
  settings: Pick<Settings, 'images' | 'attachments'>,
  provider: ProviderId,
  model: string
): { action: 'blocked' | 'confirm' | 'apply'; patch: ReturnType<typeof planSeeProvider>['patch'] } {
  const plan = planSeeProvider(settings, provider, model)
  const action = plan.needsModel || looksLikeApiKey(model) ? 'blocked' : plan.ask ? 'confirm' : 'apply'
  return { action, patch: plan.patch }
}
