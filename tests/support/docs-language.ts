// The ratchet behind AC-7.1 (spec 025): documentation is English, so the lines of Spanish prose per Markdown file may
// only go down. A line counts when it reads as Spanish once the text that is allowed to stay in the language of its
// screen is taken out: «quoted UI text», `code spans` and link targets. Same heuristic as the hardcoded-text ratchet.
import { isSpanish } from './i18n'

/** The prose of a line, without what may stay as it is. */
export function prose(line: string): string {
  return line
    .replace(/«[^»]*»/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/https?:\/\/\S+/g, ' ')
}

/** The lines of a Markdown file that read as Spanish (1-based numbers, for the message). */
export function spanishLines(markdown: string): number[] {
  const found: number[] = []
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (isSpanish(prose(line))) found.push(index + 1)
  })
  return found
}

/** Markdown files covered: `docs/`, the README, CLAUDE.md and SECURITY.md. */
export const isCovered = (file: string): boolean => /^docs\/.+\.md$/.test(file) || ['README.md', 'CLAUDE.md', 'SECURITY.md'].includes(file)

export function countSpanishLines(files: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [file, text] of Object.entries(files)) {
    if (!isCovered(file)) continue
    const count = spanishLines(text).length
    if (count > 0) counts[file] = count
  }
  return counts
}

/** One message per file above the baseline (new Spanish) or below it (lower the baseline). */
export function checkDocsBaseline(actual: Record<string, number>, baseline: Record<string, number>): string[] {
  const problems: string[] = []
  for (const file of [...new Set([...Object.keys(actual), ...Object.keys(baseline)])].sort()) {
    const now = actual[file] ?? 0
    const recorded = baseline[file] ?? 0
    if (now > recorded) problems.push(`${file}: ${now} lines of Spanish, baseline ${recorded}: write the new text in English`)
    if (now < recorded) problems.push(`${file}: ${now} lines of Spanish, baseline ${recorded}: lower the baseline to ${now}`)
  }
  return problems
}

/** Today's counts, one line per file so parallel tasks edit different lines. Only ever lowered. */
export const DOCS_BASELINE: Record<string, number> = {}
