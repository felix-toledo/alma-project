import type { Language } from './language'

export const LOCALE: Record<Language, 'es-AR' | 'en-US'> = { es: 'es-AR', en: 'en-US' }

// h23, not hour12:false: en-US with hour12:false prints midnight as "24:05".
const STYLES = {
  short: { dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' },
  long: { dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' },
  dayTime: { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  longDate: { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  weekday: { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
} satisfies Record<string, Intl.DateTimeFormatOptions>

export function formatDateTime(language: Language, at: Date | number, style: keyof typeof STYLES): string {
  return new Date(at).toLocaleString(LOCALE[language], STYLES[style])
}

export function compareText(language: Language): (a: string, b: string) => number {
  return new Intl.Collator(LOCALE[language], { numeric: true }).compare
}

/** A dollar amount as the dream's cap and costs show it: cents, and down to a hundredth of a cent. */
export function formatUsd(language: Language, usd: number): string {
  return new Intl.NumberFormat(LOCALE[language], { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(usd)
}
