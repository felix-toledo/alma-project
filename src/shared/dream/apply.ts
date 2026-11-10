// How the dream's decisions become memory lines (spec 033 BR-3, BR-18, BR-20). Pure: the knowledge base reads and writes.
import type { BatchOutput, Source } from './output'

/** The memory total remember and the dream both keep to (BR-18). */
export const MAX_MEMORY_CHARS = 4000

/** The measure remember enforces: the sum of the memory lines; the header and prose around them do not count (plan §10 G1). */
export function memoryTotal(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length, 0)
}

type Add = { kind: 'add'; text: string; why: string; sources: Source[] }
type Replace = { kind: 'replace'; old: string; text: string; why: string; sources: Source[] }
type Remove = { kind: 'remove'; old: string; why: string; sources: Source[] }
export type Change = Add | Replace | Remove
export type Skipped = { change: Change; reason: 'changed' | 'not-found' | 'full' }

// ---------------------------------------------------------------------------
// Folding batches: a working copy each batch sees, and changes kept relative to the snapshot (an addition, or a
// replacement or removal of a snapshot line), so they can be checked against the file at the end (BR-20).

interface Entry {
  text: string
  /** The change that wrote this line in this dream; none for a snapshot line still untouched. */
  change?: Add | Replace
}

export interface Fold {
  lines: Entry[]
  removed: Remove[]
  skipped: Skipped[]
}

export function startFold(snapshot: readonly string[]): Fold {
  return { lines: snapshot.map((text) => ({ text })), removed: [], skipped: [] }
}

const merge = (a: Source[], b: Source[]): Source[] => [...a, ...b.filter((s) => !a.some((t) => t.thread === s.thread && t.ts === s.ts))]

/** The working copy after one more batch; a target missing from it is `not-found`. */
export function foldBatch(fold: Fold, batch: BatchOutput): Fold {
  const lines = [...fold.lines]
  const removed = [...fold.removed]
  const skipped = [...fold.skipped]
  const at = (old: string): number => lines.findIndex((entry) => entry.text === old)
  for (const item of batch.remove) {
    const index = at(item.old)
    if (index === -1) {
      skipped.push({ change: { kind: 'remove', ...item }, reason: 'not-found' })
      continue
    }
    const { change } = lines[index]
    lines.splice(index, 1)
    // A line added in this dream and then removed never reaches the file.
    if (change?.kind === 'add') continue
    removed.push(change ? { kind: 'remove', old: change.old, why: item.why, sources: merge(change.sources, item.sources) } : { kind: 'remove', ...item })
  }
  for (const item of batch.replace) {
    const index = at(item.old)
    if (index === -1) {
      skipped.push({ change: { kind: 'replace', ...item }, reason: 'not-found' })
      continue
    }
    const { change } = lines[index]
    const next: Add | Replace = change ? { ...change, text: item.text, why: item.why, sources: merge(change.sources, item.sources) } : { kind: 'replace', ...item }
    lines[index] = { text: item.text, change: next }
  }
  for (const item of batch.add) lines.push({ text: item.text, change: { kind: 'add', ...item } })
  return { lines, removed, skipped }
}

export const foldedLines = (fold: Fold): string[] => fold.lines.map((entry) => entry.text)

/** Removals, then replacements, then additions in proposed order: the order they are applied in. */
export function foldedChanges(fold: Fold): Change[] {
  const written = fold.lines.flatMap((entry) => (entry.change ? [entry.change] : []))
  return [...fold.removed, ...written.filter((c) => c.kind === 'replace'), ...written.filter((c) => c.kind === 'add')]
}

// ---------------------------------------------------------------------------

/**
 * The dream's changes applied to the memory lines as they are now (BR-18, BR-20, Q28): a replacement or removal only
 * if its target line is still there unchanged, else `changed`; removals, then replacements, then additions in order
 * while the total stays within the limit (4000, or the file's total when it was over both when read and now); a change
 * that would grow the total past it is `full`. One occurrence per change, so duplicate lines are taken one at a time.
 */
export function applyChanges(current: readonly string[], snapshot: readonly string[], changes: readonly Change[]): { lines: string[]; applied: Change[]; skipped: Skipped[] } {
  // The smaller of the two: a file the person cut down meanwhile is not grown back past 4000.
  const limit = Math.max(MAX_MEMORY_CHARS, Math.min(memoryTotal(snapshot), memoryTotal(current)))
  const lines = [...current]
  const applied: Change[] = []
  const skipped: Skipped[] = []
  let total = memoryTotal(lines)
  const ordered = [...changes.filter((c) => c.kind === 'remove'), ...changes.filter((c) => c.kind === 'replace'), ...changes.filter((c) => c.kind === 'add')]
  for (const change of ordered) {
    const index = change.kind === 'add' ? -1 : lines.indexOf(change.old)
    if (change.kind !== 'add' && index === -1) {
      skipped.push({ change, reason: 'changed' })
      continue
    }
    const delta = change.kind === 'remove' ? -change.old.length : change.text.length - (change.kind === 'replace' ? change.old.length : 0)
    // Shrinking is always allowed, so a file the person grew meanwhile still takes the dream's shortening.
    if (delta > 0 && total + delta > limit) {
      skipped.push({ change, reason: 'full' })
      continue
    }
    if (change.kind === 'remove') lines.splice(index, 1)
    else if (change.kind === 'replace') lines[index] = change.text
    else lines.push(change.text)
    total += delta
    applied.push(change)
  }
  return { lines, applied, skipped }
}
