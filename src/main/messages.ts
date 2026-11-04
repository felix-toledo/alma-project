// Text main shows outside the window. Pure on purpose (no electron), so it is tested; the strings live in the dictionaries.
import type { Language } from '../shared/i18n/language'
import { type MessageKey, translate } from '../shared/i18n/messages'

export function trayMenu(language: Language): { open: string; quit: string; tooltip: string } {
  return {
    open: translate(language, 'tray.open'),
    quit: translate(language, 'tray.quit'),
    tooltip: translate(language, 'tray.tooltip')
  }
}

/** The native confirmation for the two changes that give an agent more power than the person gave it. */
export function securityDialog(
  language: Language,
  kind: 'mcp' | 'always-allow',
  programs: string[]
): { title: string; message: string; detail: string; allow: string; cancel: string } {
  return {
    title: translate(language, 'main.security.title'),
    message: translate(language, kind === 'mcp' ? 'main.security.mcp' : 'main.security.alwaysAllow'),
    detail: kind === 'mcp' ? programs.join('\n') : translate(language, 'main.security.alwaysAllowDetail'),
    allow: translate(language, 'main.security.allow'),
    cancel: translate(language, 'main.security.cancel')
  }
}

/** Titles of the Instagram windows the person watches. */
export function instagramTitle(language: Language, kind: 'connect' | 'test' | 'publishing'): string {
  return translate(language, `main.instagram.${kind}`)
}

export type MainError = 'rejected-origin' | 'cancelled' | 'unknown-provider' | 'unknown-company' | 'path-missing' | 'no-programs' | 'invalid-language'

const ERROR_KEYS = {
  'rejected-origin': 'main.error.rejectedOrigin',
  cancelled: 'main.error.cancelled',
  'unknown-provider': 'main.error.unknownProvider',
  'unknown-company': 'main.error.unknownCompany',
  'path-missing': 'main.error.pathMissing',
  'no-programs': 'main.error.noPrograms',
  'invalid-language': 'main.error.invalidLanguage'
} as const satisfies Record<MainError, MessageKey>

/** Text of an error that main throws or returns to the window. */
export function mainError(language: Language, error: MainError): string {
  return translate(language, ERROR_KEYS[error])
}
