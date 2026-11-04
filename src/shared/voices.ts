// Which voices each language offers, and which one it starts with (spec 025 BR-20, plan D7).
import { DEFAULT_VOICES } from './defaults'
import type { Language } from './i18n/language'
import { translate } from './i18n/messages'

export { DEFAULT_VOICES }

export interface KokoroVoice {
  id: string
  label: 'voice.kokoro.ef_dora' | 'voice.kokoro.em_alex' | 'voice.kokoro.em_santa' | 'voice.kokoro.af_heart' | 'voice.kokoro.am_adam'
}

const SPANISH: KokoroVoice[] = [
  { id: 'ef_dora', label: 'voice.kokoro.ef_dora' },
  { id: 'em_alex', label: 'voice.kokoro.em_alex' },
  { id: 'em_santa', label: 'voice.kokoro.em_santa' }
]
const ENGLISH: KokoroVoice[] = [
  { id: 'af_heart', label: 'voice.kokoro.af_heart' },
  { id: 'am_adam', label: 'voice.kokoro.am_adam' }
]

/** The Kokoro voices to pick from: the language's own, plus the one already chosen when it comes from the other list. */
export function kokoroVoices(language: Language, chosen?: string): KokoroVoice[] {
  const own = language === 'en' ? ENGLISH : SPANISH
  const other = (language === 'en' ? SPANISH : ENGLISH).find((v) => v.id === chosen)
  return other ? [...own, other] : own
}

/** The voice to speak with: the one the person chose if Kokoro has it, otherwise the language's default. */
export function resolveKokoroVoice(chosen: string, language: Language): string {
  return [...SPANISH, ...ENGLISH].some((v) => v.id === chosen) ? chosen : DEFAULT_VOICES[language].kokoro
}

/** The three phrases the person reads to train their voice; the first says the wake phrase, which is the same in both languages. */
export const enrollmentPhrases = (language: Language): string[] => [translate(language, 'voice.enroll.1'), translate(language, 'voice.enroll.2'), translate(language, 'voice.enroll.3')]

/** The system voices in the language (`es-ES`, `es_MX`, `en-US`…). */
export function windowsVoices<T extends { lang: string }>(voices: T[], language: Language): T[] {
  return voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(language))
}
