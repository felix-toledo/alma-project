// When a dream is due (spec 033 BR-11, BR-13, BR-24). Pure; material is checked by the caller afterwards (BR-22).
import * as z from 'zod/v4'
import { DAY_START_HOUR, dayKey } from '../presence'

/** Local hours, fixed in v1 (BR-11): from 02:00 up to, not including, 06:00. The day starts with it (034 BR-4). */
export const NIGHT_WINDOW = { startHour: DAY_START_HOUR, endHour: 6 } as const

export type DreamTrigger = 'tick' | 'start' | 'resume'
export const DREAM_FAILURES = ['no-key', 'no-vault', 'read-only', 'offline', 'provider', 'interrupted'] as const
export const DreamFailureSchema = z.enum(DREAM_FAILURES)
export type DreamFailure = z.infer<typeof DreamFailureSchema>

export const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const DreamScheduleSchema = z.object({
  /** The last day counted as dreamt: done, capped, or skipped for no material (BR-13, BR-22). */
  doneDay: DaySchema.optional(),
  /** Today's attempts: failures, the night's spend so far (AC-4.6), and whether the switch aborted one (BR-24). */
  attempt: z.object({ day: DaySchema, failures: z.number().int().min(0), spentUsd: z.number().min(0), aborted: z.boolean() }).optional()
})
export type DreamSchedule = z.infer<typeof DreamScheduleSchema>

export interface DueInput {
  now: Date
  trigger: DreamTrigger
  enabled: boolean
  schedule: DreamSchedule
}

export type DueAnswer =
  | { due: true; catchUp: boolean }
  | { due: false; why: 'off' | 'done' | 'outside-window' | 'retry-spent' | 'aborted' }

export function inNightWindow(now: Date): boolean {
  const hour = now.getHours()
  return hour >= NIGHT_WINDOW.startHour && hour < NIGHT_WINDOW.endHour
}

/** AC-2.1, AC-2.2, AC-2.3, AC-2.7, AC-2.8. */
export function isDreamDue(input: DueInput): DueAnswer {
  const { now, trigger, enabled, schedule } = input
  if (!enabled) return { due: false, why: 'off' }
  const day = dayKey(now)
  // `>=` in string order: a clock moved back to an earlier day does not dream that night again.
  if (schedule.doneDay !== undefined && schedule.doneDay >= day) return { due: false, why: 'done' }
  const attempt = schedule.attempt?.day === day ? schedule.attempt : undefined
  if (attempt?.aborted) return { due: false, why: 'aborted' }
  const failures = attempt?.failures ?? 0
  if (failures >= 2) return { due: false, why: 'retry-spent' }
  if (trigger === 'tick' && !inNightWindow(now)) return { due: false, why: 'outside-window' }
  // Anything but a first attempt by a tick in the window is a catch-up, which a wake signal waits for (BR-26).
  return { due: true, catchUp: trigger !== 'tick' || failures > 0 }
}
