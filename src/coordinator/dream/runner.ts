// The dream as a fixed pipeline with no tools (spec 033 BR-15): code reads, the model answers JSON validated with Zod,
// code writes. Nothing is applied before the end (BR-24).
import type { AuditEvent } from '../../shared/audit'
import { costAt } from '../../shared/company'
import { applyChanges, type Change, foldBatch, foldedChanges, foldedLines, type Fold, startFold } from '../../shared/dream/apply'
import { BATCH_CHARS, dreamableThreads, hasMaterial, planBatches, type ReadableThread, readRefs, renderTranscript, unreadSlice } from '../../shared/dream/input'
import { type JournalEntry, type JournalTexts, journalSection, renderJournal } from '../../shared/dream/journal'
import { greetingBody } from '../../shared/dream/greeting'
import { type EconomyRow, estimateCallUsd, wouldCross } from '../../shared/dream/model'
import { parseBatch, parseGreeting } from '../../shared/dream/output'
import type { DreamFailure } from '../../shared/dream/schedule'
import { formatUsd } from '../../shared/i18n/format'
import type { Language } from '../../shared/i18n/language'
import { translate } from '../../shared/i18n/messages'
import { namesOf } from '../../shared/i18n/names'
import { localDate } from '../../shared/presence'
import type { KnowledgeBase } from '../knowledge/base'
import { dreamBatchPrompt, dreamSystem, greetingPrompt, greetingSystem } from '../prompts/dream'
import type { Provider } from '../providers/types'

/** Output tokens a batch call is limited to, and estimated at (plan §9 D-3). */
export const BATCH_OUTPUT_TOKENS = 4000
/** Output tokens the greeting call is limited to, and estimated at (plan §9 D-3). */
export const GREETING_OUTPUT_TOKENS = 600
/** The greeting call's input as reserved while reading: room for a full memory file's changes and the titles. */
export const GREETING_INPUT_CHARS = 12_000

export interface DreamDeps {
  startedAt: number
  language: Language
  /** The threads as they are at the start: a thread deleted before it is not there (AC-3.3). */
  threads: readonly ReadableThread[]
  agents: readonly { id: string; companyId?: string }[]
  /** The newest message ts each thread was read up to. */
  cursors: Readonly<Record<string, number>>
  knowledge: Pick<KnowledgeBase, 'memories' | 'applyDreamChanges' | 'writeJournal'>
  provider: Pick<Provider, 'streamTurn'>
  row: EconomyRow
  capUsd: number
  /** What the night already spent (an earlier attempt, AC-4.6). */
  spentUsd: number
  signal: AbortSignal
  /** Identifiers, counts and outcomes only (AC-6.7). */
  audit(event: AuditEvent): void
}

/** `spentUsd`: the night's spend after this run, the earlier attempts included. */
export type DreamResult =
  | { outcome: 'ok' | 'capped'; spentUsd: number; cursors: Record<string, number>; greeting?: { text: string; capped: boolean } }
  | { outcome: 'skipped' }
  | { outcome: 'failed'; reason: DreamFailure; spentUsd: number }

/** The dream.journal.* texts of the app language. */
export function journalTexts(language: Language): JournalTexts {
  return {
    title: (date) => translate(language, 'dream.journal.title', { date }),
    added: translate(language, 'dream.journal.added'),
    replaced: translate(language, 'dream.journal.replaced'),
    removed: translate(language, 'dream.journal.removed'),
    skipped: translate(language, 'dream.journal.skipped'),
    speculative: translate(language, 'dream.journal.speculative'),
    skipReason: {
      changed: translate(language, 'dream.journal.skip.changed'),
      'not-found': translate(language, 'dream.journal.skip.notFound'),
      full: translate(language, 'dream.journal.skip.full')
    },
    capped: (count) => translate(language, 'dream.journal.capped', { count }),
    footer: (provider, model, costUsd) => translate(language, 'dream.journal.footer', { provider, model, cost: formatUsd(language, costUsd) }),
    source: (thread, ts) => translate(language, 'dream.journal.source', { thread, ts })
  }
}

/** The frontmatter of Alma's notes in the app language (ADR 0019): `origen: ia` plus the dream type (AC-5.6). */
function journalFrontmatter(language: Language): Record<string, string> {
  const name = (key: Parameters<typeof namesOf>[0]): string => namesOf(key)[language]
  return { [name('names.originKey')]: name('names.originValue'), [name('names.typeKey')]: name('names.dreamTypeValue') }
}

/** One call, sent with the output limit its estimate assumed, so the estimate bounds what it can cost (AC-4.3). */
async function ask(deps: DreamDeps, system: string, prompt: string, maxOutputTokens: number): Promise<{ text: string | null; usd: number }> {
  const turn = await deps.provider.streamTurn({
    model: deps.row.model,
    effort: 'low',
    system,
    // The dream is offered no tool (BR-15, AC-6.9).
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], ts: deps.startedAt }],
    maxOutputTokens,
    signal: deps.signal,
    onText: () => {},
    onThinking: () => {},
    onToolStart: () => {}
  })
  // The provider cannot bill past the limit it was sent: a usage reporting more is counted at the limit.
  const usd = turn.usage
    ? costAt(deps.row, { ...turn.usage, outputTokens: Math.min(turn.usage.outputTokens, maxOutputTokens) })
    : estimateCallUsd(deps.row, system.length + prompt.length, maxOutputTokens)
  // A refusal or a tool call is invalid output, whatever text came with it (AC-4.4, AC-6.9).
  if (turn.stopReason === 'refusal' || turn.content.some((block) => block.type === 'tool_use')) return { text: null, usd }
  return { text: turn.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''), usd }
}

/**
 * Plan §10 G12: an abort (resume, quit, the switch) is `interrupted`; a network-level error (fetch's TypeError, the
 * SDKs' connection errors that wrap it) is `offline`; anything else the provider did is `provider`.
 */
function failureOf(error: unknown, signal: AbortSignal): DreamFailure {
  if (signal.aborted) return 'interrupted'
  const network = (e: unknown): boolean => e instanceof TypeError || (e instanceof Error && (/Connection/.test(e.constructor.name) || network(e.cause)))
  return network(error) ? 'offline' : 'provider'
}

/** One dream, and its `dream.run` audit entry: outcome, reason and cost, never text (AC-6.7, AC-8.2). */
export async function runDream(deps: DreamDeps): Promise<DreamResult> {
  const result = await dream(deps)
  deps.audit({
    action: 'dream.run',
    actor: 'system',
    target: deps.row.provider,
    outcome: result.outcome === 'failed' ? 'error' : 'ok',
    detail: {
      outcome: result.outcome,
      ...(result.outcome === 'failed' ? { reason: result.reason } : {}),
      ...(result.outcome === 'skipped' ? {} : { costUsd: Number(result.spentUsd.toFixed(6)) })
    }
  })
  return result
}

async function dream(deps: DreamDeps): Promise<DreamResult> {
  const slices = dreamableThreads(deps.threads, deps.agents).flatMap((thread) => unreadSlice(thread, deps.cursors[thread.id], deps.startedAt) ?? [])
  if (!hasMaterial(slices)) return { outcome: 'skipped' }

  const system = dreamSystem(deps.language)
  // Cursors of threads deleted since are dropped.
  const cursors: Record<string, number> = Object.fromEntries(Object.entries(deps.cursors).filter(([id]) => deps.threads.some((t) => t.id === id)))
  const speculative: JournalEntry['speculative'] = []
  const titles: string[] = []
  const batches = planBatches(slices, BATCH_CHARS)
  // The greeting call's estimate stays reserved while reading, so a capped dream can still greet (plan §10 G3).
  const reserve = estimateCallUsd(deps.row, greetingSystem(deps.language).length + GREETING_INPUT_CHARS, GREETING_OUTPUT_TOKENS)
  let spent = deps.spentUsd
  let read = 0
  let greeting: { text: string; capped: boolean } | undefined
  try {
    const snapshot = await deps.knowledge.memories()
    let fold: Fold = startFold(snapshot)
    for (const batch of batches) {
      const prompt = dreamBatchPrompt(foldedLines(fold), renderTranscript(batch))
      if (wouldCross(spent, estimateCallUsd(deps.row, system.length + prompt.length, BATCH_OUTPUT_TOKENS), reserve, deps.capUsd)) break
      const answer = await ask(deps, system, prompt, BATCH_OUTPUT_TOKENS)
      spent += answer.usd
      const output = answer.text === null ? null : parseBatch(answer.text, readRefs(batch))
      if (!output) return { outcome: 'failed', reason: 'provider', spentUsd: spent }
      fold = foldBatch(fold, output)
      speculative.push(...output.speculative)
      for (const slice of batch) {
        cursors[slice.threadId] = Math.max(cursors[slice.threadId] ?? 0, slice.lastTs)
        if (!titles.includes(slice.title)) titles.push(slice.title)
      }
      read++
    }
    // Conversations with a part left unread roll to the next dream (AC-4.3).
    const unread = new Set(batches.slice(read).flatMap((batch) => batch.map((slice) => slice.threadId))).size
    let capped = unread > 0
    // What would change in the file as it is now: the greeting is told only that (AC-7.14), and only that is committed.
    const preview = applyChanges(await deps.knowledge.memories(), snapshot, foldedChanges(fold))
    if (read > 0) {
      const changes = preview.applied.map((c) => (c.kind === 'add' ? c.text : c.kind === 'replace' ? `${c.old} → ${c.text}` : `(removed) ${c.old}`))
      const greetingSys = greetingSystem(deps.language)
      const prompt = greetingPrompt({ changes, titles, hunches: speculative.length })
      if (wouldCross(spent, estimateCallUsd(deps.row, greetingSys.length + prompt.length, GREETING_OUTPUT_TOKENS), 0, deps.capUsd)) capped = true
      else {
        const answer = await ask(deps, greetingSys, prompt, GREETING_OUTPUT_TOKENS)
        spent += answer.usd
        const text = answer.text === null ? null : parseGreeting(answer.text)
        if (text === null) return { outcome: 'failed', reason: 'provider', spentUsd: spent }
        greeting = { text: greetingBody(text, capped ? translate(deps.language, 'dream.greeting.capped') : null), capped }
      }
    }
    if (deps.signal.aborted) return { outcome: 'failed', reason: 'interrupted', spentUsd: spent }

    const texts = journalTexts(deps.language)
    const date = localDate(new Date(deps.startedAt))
    // The commit re-checks the previewed changes against the file at that moment, in the memory writer's turn.
    const applied = await deps.knowledge.applyDreamChanges(snapshot, preview.applied, async (result) => {
      const entry: JournalEntry = {
        date,
        applied: result.applied,
        skipped: [...fold.skipped, ...preview.skipped, ...result.skipped],
        speculative,
        ...(capped ? { capped: { unread } } : {}),
        provider: deps.row.provider,
        model: deps.row.model,
        costUsd: spent
      }
      // The journal write is the commit point: an abort until it starts applies nothing (AC-1.4).
      await deps.knowledge.writeJournal(date, renderJournal(entry, texts, journalFrontmatter(deps.language)), journalSection(entry, texts), deps.signal)
    })
    const count = (kind: Change['kind']): number => applied.applied.filter((c) => c.kind === kind).length
    deps.audit({
      action: 'dream.apply',
      actor: 'system',
      target: 'memory',
      outcome: 'ok',
      detail: { added: count('add'), replaced: count('replace'), removed: count('remove'), skipped: fold.skipped.length + preview.skipped.length + applied.skipped.length }
    })
    // A target the person edited during the greeting call was skipped at the commit: the greeting would name a change not made.
    if (applied.applied.length !== preview.applied.length) greeting = undefined
    return { outcome: capped ? 'capped' : 'ok', spentUsd: spent, cursors, ...(greeting ? { greeting } : {}) }
  } catch (error) {
    return { outcome: 'failed', reason: failureOf(error, deps.signal), spentUsd: spent }
  }
}
