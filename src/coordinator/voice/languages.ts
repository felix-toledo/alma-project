// What the voice models are told about the app language (spec 025 BR-20). Pure, so both languages are tested without audio.
import type { Language } from '../../shared/i18n/language'

/** The espeak-ng voice that pronounces what Kokoro says: Latin American Spanish or US English. */
export const phonemizerVoice = (language: Language): 'es-419' | 'en-us' => (language === 'en' ? 'en-us' : 'es-419')

/** The language each speech-to-text engine is asked to hear: Whisper by name, OpenAI by code, Meta by the word its `languageBias` takes. */
export function sttLanguage(language: Language): { whisper: 'spanish' | 'english'; openai: 'es' | 'en'; meta: 'Spanish' | 'English' } {
  return language === 'en' ? { whisper: 'english', openai: 'en', meta: 'English' } : { whisper: 'spanish', openai: 'es', meta: 'Spanish' }
}
