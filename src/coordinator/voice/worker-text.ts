// What the voice worker tells the overlay about model downloads and failures, in the language of the request (spec 025 AC-6.3).
// Pure, so the worker can stay untested while the words are not.
import type { Language } from '../../shared/i18n/language'
import { translate, type MessageKey } from '../../shared/i18n/messages'

type Kind = 'download' | 'downloadPercent' | 'downloadFailed' | 'wakeUnavailable' | 'speakerModel'

export function workerText(language: Language, kind: Kind, params: Record<string, string | number> = {}): string {
  return (translate as (language: Language, key: MessageKey, params?: Record<string, string | number>) => string)(language, `voice.worker.${kind}` as MessageKey, params)
}
