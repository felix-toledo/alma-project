// When the morning greeting is delivered (spec 033 BR-26, BR-27, BR-32). Pure; the text lives in its conversation.
import * as z from 'zod/v4'
import { dayKey } from '../presence'
import { DaySchema } from './schedule'

/** The day's greeting: its conversation, never its text. */
export const GreetingStateSchema = z.object({
  /** The day (dayKey) the greeting belongs to. */
  day: DaySchema,
  threadId: z.string(),
  deliveredAt: z.number().optional(),
  capped: z.boolean()
})
export type GreetingState = z.infer<typeof GreetingStateSchema>

/**
 * deliver: today's greeting is written and not delivered; wait: none is written for today and a catch-up dream is
 * running (BR-26); none otherwise. A greeting of an earlier day is never delivered: the day turns at 02:00 (AC-7.12).
 */
export function greetingDue(input: { now: Date; enabled: boolean; greeting?: GreetingState; catchUpRunning: boolean }): 'deliver' | 'wait' | 'none' {
  const { now, enabled, greeting, catchUpRunning } = input
  if (!enabled) return 'none'
  const today = greeting?.day === dayKey(now) ? greeting : undefined
  if (today) return today.deliveredAt === undefined ? 'deliver' : 'none'
  return catchUpRunning ? 'wait' : 'none'
}

/** Whether a wake signal is of use to the greeting now; an early one is not used up (BR-26, Q32; 034 BR-12). */
export function canUseWake(greeting: GreetingState | undefined, now: Date, catchUpRunning: boolean): boolean {
  return greetingDue({ now, enabled: true, greeting, catchUpRunning }) !== 'none'
}

/** The model's greeting, with the fixed line of a dream stopped at the cap appended (AC-7.11, Q34). */
export function greetingBody(modelText: string, cappedLine: string | null): string {
  return cappedLine ? `${modelText}\n\n${cappedLine}` : modelText
}
