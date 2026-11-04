// The reason a reviewer gives for allowing or flagging an action is free text the model wrote in English (BR-17). The
// person reads it translated: one lazy, cached, low-effort call to the same provider, only under `es`, with one fixed
// English prompt. On any failure the English reason stays (spec 025 plan D6).
import type { Language } from '../shared/i18n/language'
import { REASON_TRANSLATION_SYSTEM } from './prompts/review'
import type { Provider } from './providers/types'

const cache = new Map<string, string>()

export const resetReasonCache = (): void => cache.clear()

export async function reviewerReasonForDisplay(reason: string, language: Language, provider: Provider, model: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
  if (language !== 'es' || !reason.trim()) return reason
  const hit = cache.get(reason)
  if (hit) return hit
  try {
    let streamed = ''
    const turn = await provider.streamTurn({
      model,
      effort: 'low',
      system: REASON_TRANSLATION_SYSTEM,
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: reason }], ts: Date.now() }],
      signal,
      onText: (delta) => (streamed += delta),
      onThinking: () => {},
      onToolStart: () => {}
    })
    const final = turn.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
    const translated = (final || streamed).trim()
    if (!translated) return reason
    cache.set(reason, translated)
    return translated
  } catch {
    return reason
  }
}
