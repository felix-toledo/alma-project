import { en } from './en'
import { es } from './es'
import { LOCALE } from './format'
import type { Language } from './language'

export type Message = string | { one: string; other: string }
export type MessageKey = keyof typeof es

const dictionaries: Record<Language, Record<MessageKey, Message>> = { es, en }

type Names<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Names<Rest> : never
type TextOf<M> = M extends string
  ? M
  : M extends { one: infer One extends string; other: infer Other extends string }
    ? One | Other
    : never

// The {name} placeholders found in the es text of a key (es.ts is the source of keys).
export type ParamsOf<K extends MessageKey> = { [P in Names<TextOf<(typeof es)[K]>>]: string | number }
export type ParamsArg<K extends MessageKey> = [keyof ParamsOf<K>] extends [never] ? [] : [params: ParamsOf<K>]

type Params = Record<string, string | number>

export function translate<K extends MessageKey>(language: Language, key: K, ...args: ParamsArg<K>): string {
  const params = (args[0] ?? {}) as Params
  const message = dictionaries[language][key]
  // Only `one` and `other` are written; any other CLDR category (es "many") reads as plural.
  const text =
    typeof message === 'string'
      ? message
      : new Intl.PluralRules(LOCALE[language]).select(Number(params.count)) === 'one'
        ? message.one
        : message.other
  // A param missing at runtime keeps its {placeholder} visible instead of vanishing.
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder
  )
}

/** A `ToolText` read back at run time, where the params cannot be checked against the key. */
export function translateText(language: Language, text: { key: MessageKey; params?: Params }): string {
  return (translate as (language: Language, key: MessageKey, params?: Params) => string)(language, text.key, text.params)
}

/** What a tool card shows: the text in the current language, or the stored text for results written before `i18n` existed. */
export function shownToolText(block: { content: string; i18n?: { key: MessageKey; params?: Params } }, language: Language): string {
  return block.i18n ? translateText(language, block.i18n) : block.content
}

/** For keys built at run time (`toolLabel.${name}`): true only when the dictionaries define it. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(es, key)
}
