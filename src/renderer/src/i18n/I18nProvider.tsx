import { createContext, useContext, useEffect, useState } from 'react'
import { type Language, resolveLanguage } from '../../../shared/i18n/language'

interface I18n {
  language: Language
  setLanguage(language: Language): void
}

// Before the settings arrive the window follows the system language, as main will.
const initial = (): Language => resolveLanguage(undefined, navigator.languages)

export const I18nContext = createContext<I18n>({ language: 'en', setLanguage: () => {} })

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [language, setLanguage] = useState<Language>(initial)
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  return <I18nContext.Provider value={{ language, setLanguage }}>{children}</I18nContext.Provider>
}

/** The app mirrors `settings.language` here, so every window text re-renders the moment it changes. */
export function useLanguageSync(language: Language | undefined): void {
  const { setLanguage } = useContext(I18nContext)
  useEffect(() => {
    if (language) setLanguage(language)
  }, [language, setLanguage])
}
