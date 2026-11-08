import { en } from './en'
import { es, type PwaKey } from './es'

export type { PwaKey }
export type PwaLanguage = 'es' | 'en'

const dictionaries = { es, en } satisfies Record<PwaLanguage, Record<PwaKey, string>>

export function phoneLanguage(navigatorLanguage: string | undefined): PwaLanguage {
  return navigatorLanguage?.toLowerCase().startsWith('es') ? 'es' : 'en'
}

/** `{name}` placeholders are filled in one pass, so a value is never expanded again; an unknown name stays as written. */
export function translatePwa(language: PwaLanguage, key: PwaKey, params?: Record<string, string>): string {
  const text: string = dictionaries[language][key]
  return params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => Object.hasOwn(params, name) ? params[name] : whole) : text
}
