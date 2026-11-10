import { en } from './en'
import { es, type PwaKey } from './es'

export type { PwaKey }
export type PwaLanguage = 'es' | 'en'

const dictionaries = { es, en } satisfies Record<PwaLanguage, Record<PwaKey, string>>

export function phoneLanguage(navigatorLanguage: string | undefined): PwaLanguage {
  return navigatorLanguage?.toLowerCase().startsWith('es') ? 'es' : 'en'
}

/** What a text that names a file says when it is shown with no file to name: never a literal `{name}`. */
const NO_FILE: Record<PwaLanguage, string> = { es: 'el archivo', en: 'the file' }

/** `{name}` placeholders are filled in one pass, so a value is never expanded again; an unknown name stays as written, except `{name}`. */
export function translatePwa(language: PwaLanguage, key: PwaKey, params?: Record<string, string>): string {
  const text: string = dictionaries[language][key]
  const values = params ?? {}
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? values[name] : name === 'name' ? NO_FILE[language] : whole))
}
