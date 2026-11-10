// The dream journal note (spec 033 BR-3, BR-5, BR-33): what changed, why, and where it came from. Pure Markdown.
import type { Change, Skipped } from './apply'
import type { EconomyProvider } from './model'
import type { Source } from './output'

export interface JournalEntry {
  /** The local YYYY-MM-DD the dream ran (BR-33). */
  date: string
  applied: Change[]
  skipped: Skipped[]
  speculative: { text: string; sources: Source[] }[]
  /** Set when the cap stopped the dream (AC-4.3). */
  capped?: { unread: number }
  provider: EconomyProvider
  model: string
  costUsd: number
}

/** The dream.journal.* texts of the app language, resolved by the caller (placeholders and plurals stay in `translate`). */
export interface JournalTexts {
  title(date: string): string
  added: string
  replaced: string
  removed: string
  skipped: string
  speculative: string
  skipReason: Record<Skipped['reason'], string>
  capped(unread: number): string
  footer(provider: string, model: string, costUsd: number): string
  source(thread: string, ts: number): string
}

// Model-written text stays on its bullet line.
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

const what = (change: Change): string => (change.kind === 'add' ? change.text : change.kind === 'remove' ? change.old : `${change.old} → ${change.text}`)

function list(heading: string, items: readonly string[]): string[] {
  return items.length ? [`### ${heading}`, ...items, ''] : []
}

/** One night's section, appended as is when the file already exists (AC-5.7). */
export function journalSection(entry: JournalEntry, texts: JournalTexts): string {
  const cite = (sources: readonly Source[]): string => sources.map((s) => texts.source(s.thread, s.ts)).join(', ')
  const item = (change: Change, note: string): string => `- ${what(change)} — ${oneLine(note)} · ${cite(change.sources)}`
  const of = (kind: Change['kind']): string[] => entry.applied.filter((c) => c.kind === kind).map((c) => item(c, c.why))
  return [
    `## ${texts.title(entry.date)}`,
    '',
    ...(entry.capped ? [texts.capped(entry.capped.unread), ''] : []),
    ...list(texts.added, of('add')),
    ...list(texts.replaced, of('replace')),
    ...list(texts.removed, of('remove')),
    ...list(texts.skipped, entry.skipped.map((s) => item(s.change, texts.skipReason[s.reason]))),
    ...list(texts.speculative, entry.speculative.map((s) => `- ${oneLine(s.text)} · ${cite(s.sources)}`)),
    `_${texts.footer(entry.provider, entry.model, entry.costUsd)}_`,
    ''
  ].join('\n')
}

/** A new journal file: the frontmatter Alma's notes carry (AC-5.6), then the night's section. */
export function renderJournal(entry: JournalEntry, texts: JournalTexts, frontmatter: Record<string, string>): string {
  const data = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`)
  return ['---', ...data, '---', journalSection(entry, texts)].join('\n')
}
