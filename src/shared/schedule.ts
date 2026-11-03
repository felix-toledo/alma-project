import type { Routine } from './types'

const MINUTE = 60_000

function parseTime(time: string): { hours: number; minutes: number } {
  const [h, m] = time.split(':').map(Number)
  return { hours: Number.isFinite(h) ? h : 9, minutes: Number.isFinite(m) ? m : 0 }
}

function slotOn(day: Date, time: string): Date {
  const { hours, minutes } = parseTime(time)
  const slot = new Date(day)
  slot.setHours(hours, minutes, 0, 0)
  return slot
}

/**
 * Whether a routine should run now. A daily routine missed while the app was closed runs once when it
 * opens later the same day; earlier days are not caught up.
 */
export function isDue(routine: Routine, lastRunAt: number | undefined, now: Date): boolean {
  if (!routine.enabled) return false
  const since = lastRunAt ?? routine.createdAt
  const { schedule } = routine
  // A one-off that was missed while the app was closed still fires (late) when it opens.
  // Comparing with `at` (not "never ran") lets an already-fired one-off be rescheduled to a new date.
  if (schedule.kind === 'once') return (lastRunAt === undefined || lastRunAt < schedule.at) && now.getTime() >= schedule.at
  if (schedule.kind === 'interval') return now.getTime() - since >= Math.max(1, schedule.minutes) * MINUTE
  if (schedule.days.length > 0 && !schedule.days.includes(now.getDay())) return false
  const slot = slotOn(now, schedule.time)
  return now >= slot && since < slot.getTime()
}

/** When the routine will run next, for display. Undefined when disabled. */
export function nextRun(routine: Routine, lastRunAt: number | undefined, now: Date): Date | undefined {
  if (!routine.enabled) return undefined
  const since = lastRunAt ?? routine.createdAt
  const { schedule } = routine
  if (schedule.kind === 'once') return lastRunAt === undefined || lastRunAt < schedule.at ? new Date(Math.max(schedule.at, now.getTime())) : undefined
  if (schedule.kind === 'interval') {
    return new Date(Math.max(now.getTime(), since + Math.max(1, schedule.minutes) * MINUTE))
  }
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(now)
    day.setDate(now.getDate() + offset)
    if (schedule.days.length > 0 && !schedule.days.includes(day.getDay())) continue
    const slot = slotOn(day, schedule.time)
    if (offset === 0 && isDue(routine, lastRunAt, now)) return now
    if (slot > now && slot.getTime() > since) return slot
  }
  return undefined
}

const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

export function describeSchedule(routine: Routine): string {
  const { schedule } = routine
  if (schedule.kind === 'once') {
    return `una vez, el ${new Date(schedule.at).toLocaleString('es', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
  }
  if (schedule.kind === 'interval') {
    return schedule.minutes % 60 === 0 ? `cada ${schedule.minutes / 60} h` : `cada ${schedule.minutes} min`
  }
  const days =
    schedule.days.length === 0 || schedule.days.length === 7
      ? 'todos los días'
      : [...schedule.days].sort().map((d) => DAY_NAMES[d]).join(', ')
  return `${days} a las ${schedule.time}`
}
