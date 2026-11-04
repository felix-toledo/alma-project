import { useContext, useMemo } from 'react'
import type { Language } from '../../../shared/i18n/language'
import { type MessageKey, type ParamsArg, translate } from '../../../shared/i18n/messages'
import { I18nContext } from './I18nProvider'

export type T = <K extends MessageKey>(key: K, ...params: ParamsArg<K>) => string

export function useLanguage(): Language {
  return useContext(I18nContext).language
}

export function useT(): T {
  const language = useLanguage()
  return useMemo<T>(() => (key, ...params) => translate(language, key, ...params), [language])
}
