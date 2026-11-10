// Presence signals (spec 034): when the person is back at the PC.
import * as z from 'zod/v4'

/** The day starts at the start of 033's night window (BR-4). */
export const DAY_START_HOUR = 2

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar date (YYYY-MM-DD) of `at`. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** The local date (YYYY-MM-DD) of the day `now` belongs to; the day starts at 02:00 local (BR-4). */
export function dayKey(now: Date): string {
  // Noon of the date, so a daylight-saving midnight cannot shift it.
  return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < DAY_START_HOUR ? 1 : 0), 12))
}

/** An absence counts from 4 hours (BR-3); a constant, not a setting (AC-2.12). */
export const WAKE_ABSENCE_MS = 4 * 3_600_000
/** How often main reads the system idle time (BR-2). */
export const IDLE_POLL_MS = 60_000

/** The threshold in force: WAKE_ABSENCE_MS, or ALMA_PRESENCE_THRESHOLD_MS when the app is not packaged (AC-2.12). */
export function presenceThreshold(packaged: boolean, env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.ALMA_PRESENCE_THRESHOLD_MS
  return !packaged && raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : WAKE_ABSENCE_MS
}

/** Elapsed ms between two epoch readings; null when the start is unknown or later than the end (AC-2.6, AC-2.9). */
export function absenceBetween(start: number | undefined, end: number): number | null {
  return start === undefined || start > end ? null : end - start
}

/** What main tells the coordinator (AC-1.3). Strict, and a `start` carries nothing about how Alma started (AC-1.7). */
export const PresenceEventSchema = z.discriminatedUnion('kind', [
  // null: the start of the absence was never seen (BR-11).
  z.strictObject({ kind: z.enum(['unlock', 'resume', 'idle-return']), absenceMs: z.number().min(0).nullable() }),
  z.strictObject({ kind: z.literal('start') }),
  // Input seen in the last poll: keeps the last known activity.
  z.strictObject({ kind: z.literal('active') })
])
export type PresenceEvent = z.infer<typeof PresenceEventSchema>

/** The only persisted presence fields (AC-3.1). */
export const PresenceStateSchema = z.strictObject({
  lastWakeDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lastActivityAt: z.number().min(0).optional()
})
export type PresenceState = z.infer<typeof PresenceStateSchema>

export interface WakeInput {
  event: Exclude<PresenceEvent['kind'], 'active'>
  /** For a `start`, the caller passes absenceBetween(state.lastActivityAt, now). */
  absenceMs: number | null
  now: Date
  state: PresenceState
  /** Some consumer that is on can use a signal now (BR-12). */
  canUse: boolean
  thresholdMs: number
}

/** BR-2, BR-3, BR-4, BR-11, BR-12. Pure; `state.lastWakeDay` changes only when `wake` is true. */
export function decideWake(input: WakeInput): { wake: boolean; state: PresenceState } {
  const { absenceMs, now, state, canUse, thresholdMs } = input
  const day = dayKey(now)
  // `>=` in string order: a clock moved back to an earlier day does not give that day a second signal.
  const used = state.lastWakeDay !== undefined && state.lastWakeDay >= day
  if (absenceMs === null || absenceMs < thresholdMs || used || !canUse) return { wake: false, state }
  return { wake: true, state: { ...state, lastWakeDay: day } }
}
