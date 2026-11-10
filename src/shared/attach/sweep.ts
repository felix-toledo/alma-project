import { ATTACH_LIMITS } from './rules'

/** What the sweep needs to know about a stored attachment; `removedAt` is set once its file is gone. */
export interface SweepRecord {
  id: string
  threadId: string
  removedAt?: number
}

const DAY_MS = 86_400_000

/** A file is due when its conversation was last opened 30 days ago or more (BR-7). The clock is injected. */
export function isSweepDue(lastOpenedAt: number, now: number): boolean {
  return now - lastOpenedAt >= ATTACH_LIMITS.sweepDays * DAY_MS
}

/**
 * The attachment ids whose file should be deleted now. It only ever names ids from `records` (AC-6.6). A record whose
 * conversation has no known last-opened time is left alone, and so is one whose conversation is running. A conversation
 * in `gone` was deleted: its files are due at once (G7), so one that could not be erased then is retried at every sweep.
 */
export function planSweep(
  records: readonly SweepRecord[],
  openedAt: Readonly<Record<string, number | undefined>>,
  running: ReadonlySet<string>,
  now: number,
  gone: ReadonlySet<string> = new Set(),
): string[] {
  return records
    .filter((r) => {
      if (r.removedAt !== undefined || running.has(r.threadId)) return false
      const opened = openedAt[r.threadId]
      return gone.has(r.threadId) || (opened !== undefined && isSweepDue(opened, now))
    })
    .map((r) => r.id)
}
