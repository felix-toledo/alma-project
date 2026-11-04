// The ratchet behind AC-7.6 (spec 025): code comments are English, so the comments that read as Spanish per file may
// only go down. It uses the lexer of the hardcoded-text ratchet (which already tells comments from strings and
// regexes) and the same Spanish heuristic: an accented letter or two Spanish stop-words. Heuristic: its false
// positives are part of the baseline.
import { isSpanish, lex } from './i18n'

/** The comment text that may stay as it is: `code`, «quoted UI text» and "quoted text" (examples of what the person says or reads). */
const outsideQuotes = (comment: string): string => comment.replace(/`[^`]*`/g, ' ').replace(/«[^»]*»/g, ' ').replace(/"[^"]*"/g, ' ')

export interface SpanishComment {
  line: number
  text: string
}

export function spanishComments(source: string): SpanishComment[] {
  return lex(source)
    .comments.filter((comment) => isSpanish(outsideQuotes(comment.text)))
    .map((comment) => ({ line: source.slice(0, comment.at).split('\n').length, text: comment.text.trim() }))
}

/** `src/` and `tests/` TypeScript files; the quoted fixtures inside tests are strings, not comments, so they never count. */
export const isCovered = (file: string): boolean => /^(src|tests)\/.+\.tsx?$/.test(file)

export function countSpanishComments(files: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [file, source] of Object.entries(files)) {
    if (!isCovered(file)) continue
    const count = spanishComments(source).length
    if (count > 0) counts[file] = count
  }
  return counts
}

/** One message per file above the baseline (a new Spanish comment) or below it (lower the baseline). */
export function checkCommentsBaseline(actual: Record<string, number>, baseline: Record<string, number>): string[] {
  const problems: string[] = []
  for (const file of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort()) {
    const now = actual[file] ?? 0
    const recorded = baseline[file] ?? 0
    if (now > recorded) problems.push(`${file}: ${now} comments in Spanish, baseline ${recorded}: write the comment in English`)
    if (now < recorded) problems.push(`${file}: ${now} comments in Spanish, baseline ${recorded}: lower the baseline to ${now}`)
  }
  return problems
}

/** Today's counts, one line per file so parallel tasks edit different lines. Only ever lowered. */
export const COMMENTS_BASELINE: Record<string, number> = {}
