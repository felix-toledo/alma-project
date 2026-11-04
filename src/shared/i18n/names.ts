// Names Alma writes to disk follow the language for NEW files; what exists already wins (spec 025 BR-23, ADR 0019).
import type { Language } from './language'
import { translate, type MessageKey } from './messages'

export type NameKey = Extract<MessageKey, `names.${string}`>

/** The same name in both languages, from the `names.*` entries. */
export const namesOf = (key: NameKey): Record<Language, string> => ({ es: translate('es', key), en: translate('en', key) })

/**
 * Which of the two names to use: the one that exists, the current language's when both do, and the current
 * language's when neither does (the file is then created under it). Nothing is ever renamed.
 */
export function resolveName(language: Language, names: Record<Language, string>, exists: (name: string) => boolean): string {
  const other = language === 'es' ? 'en' : 'es'
  if (exists(names[language])) return names[language]
  return exists(names[other]) ? names[other] : names[language]
}

/** A note Alma wrote, by its frontmatter in either language (`origen: ia` or `origin: ai`). */
export function isOwnNote(frontmatter: Record<string, string>): boolean {
  const key = namesOf('names.originKey')
  const value = namesOf('names.originValue')
  return frontmatter[key.es] === value.es || frontmatter[key.en] === value.en
}

/** The name of a new note or drawing, in the language: `Untitled.md`, `Untitled 2.md`… (a name under the other language does not count as taken). */
export function newFileName(language: Language, kind: 'note' | 'drawing', isTaken: (name: string) => boolean): string {
  const base = namesOf(kind === 'note' ? 'names.untitledNote' : 'names.drawing')[language]
  const ext = kind === 'note' ? '.md' : '.excalidraw'
  let name = `${base}${ext}`
  for (let n = 2; isTaken(name); n++) name = `${base} ${n}${ext}`
  return name
}

/** The note a new, empty vault starts with. */
export const welcomeNoteFile = (language: Language): string => `${namesOf('names.welcomeNote')[language]}.md`
