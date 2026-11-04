export type Language = 'es' | 'en'

export function parseLanguage(value: unknown): Language | undefined {
  return value === 'es' || value === 'en' ? value : undefined
}

// Only the first preferred locale counts (plan D2). A saved value of es/en wins; anything else is treated as absent.
export function resolveLanguage(explicit: unknown, systemLocales: readonly string[]): Language {
  const saved = parseLanguage(explicit)
  if (saved) return saved
  const primary = (systemLocales[0] ?? '').toLowerCase().split('-')[0]
  return primary === 'es' ? 'es' : 'en'
}
