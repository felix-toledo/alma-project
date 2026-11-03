import { describe, expect, it } from 'vitest'
import { describeSchedule, isDue, nextRun } from '../src/shared/schedule'
import type { Routine } from '../src/shared/types'

const at = (iso: string): Date => new Date(iso)
const routine = (schedule: Routine['schedule'], createdAt = at('2026-10-12T08:00:00').getTime()): Routine => ({
  id: 'r',
  name: 'r',
  agentId: 'general',
  workspace: '',
  prompt: 'x',
  schedule,
  enabled: true,
  createdAt
})

describe('isDue (daily)', () => {
  const daily = routine({ kind: 'daily', time: '10:00', days: [] })

  it('runs once the time has passed, and only once a day', () => {
    expect(isDue(daily, undefined, at('2026-10-15T09:59:00'))).toBe(false)
    expect(isDue(daily, undefined, at('2026-10-15T10:00:00'))).toBe(true)
    expect(isDue(daily, at('2026-10-15T10:00:30').getTime(), at('2026-10-15T18:00:00'))).toBe(false)
    expect(isDue(daily, at('2026-10-15T10:00:30').getTime(), at('2026-10-16T10:01:00'))).toBe(true)
  })

  it('catches up a missed run later the same day but not the next day', () => {
    const last = at('2026-10-14T10:00:00').getTime()
    expect(isDue(daily, last, at('2026-10-15T16:00:00'))).toBe(true)
    expect(isDue(daily, last, at('2026-10-16T08:00:00'))).toBe(false)
  })

  it('does not run on the day it was created after the time', () => {
    const late = routine({ kind: 'daily', time: '10:00', days: [] }, at('2026-10-15T11:00:00').getTime())
    expect(isDue(late, undefined, at('2026-10-15T12:00:00'))).toBe(false)
    expect(isDue(late, undefined, at('2026-10-16T10:00:00'))).toBe(true)
  })

  it('respects the chosen weekdays and the enabled flag', () => {
    const weekdays = routine({ kind: 'daily', time: '10:00', days: [1, 2, 3, 4, 5] })
    expect(isDue(weekdays, undefined, at('2026-10-17T11:00:00'))).toBe(false) // sábado
    expect(isDue(weekdays, undefined, at('2026-10-16T11:00:00'))).toBe(true) // viernes
    expect(isDue({ ...daily, enabled: false }, undefined, at('2026-10-15T11:00:00'))).toBe(false)
  })
})

describe('isDue (interval)', () => {
  it('waits the full interval from creation or the last run', () => {
    const every2h = routine({ kind: 'interval', minutes: 120 }, at('2026-10-15T08:00:00').getTime())
    expect(isDue(every2h, undefined, at('2026-10-15T09:59:00'))).toBe(false)
    expect(isDue(every2h, undefined, at('2026-10-15T10:00:00'))).toBe(true)
    expect(isDue(every2h, at('2026-10-15T10:00:00').getTime(), at('2026-10-15T11:00:00'))).toBe(false)
  })
})

describe('nextRun and describeSchedule', () => {
  it('finds the next allowed day', () => {
    const weekdays = routine({ kind: 'daily', time: '10:00', days: [1, 2, 3, 4, 5] })
    const last = at('2026-10-16T10:00:00').getTime() // viernes
    expect(nextRun(weekdays, last, at('2026-10-16T12:00:00'))).toEqual(at('2026-10-19T10:00:00')) // lunes
    expect(describeSchedule(weekdays)).toBe('lun, mar, mié, jue, vie a las 10:00')
    expect(describeSchedule(routine({ kind: 'interval', minutes: 180 }))).toBe('cada 3 h')
  })
})

describe('isDue (once)', () => {
  const once = routine({ kind: 'once', at: at('2026-10-21T10:00:00').getTime() })

  it('fires once at its time, and late if the app was closed then', () => {
    expect(isDue(once, undefined, at('2026-10-21T09:59:00'))).toBe(false)
    expect(isDue(once, undefined, at('2026-10-22T08:00:00'))).toBe(true)
    expect(isDue(once, at('2026-10-21T10:00:20').getTime(), at('2026-10-21T12:00:00'))).toBe(false)
    expect(nextRun(once, at('2026-10-21T10:00:20').getTime(), at('2026-10-21T12:00:00'))).toBeUndefined()
  })

  it('fires again after being moved to a later date', () => {
    const moved = routine({ kind: 'once', at: at('2026-10-25T10:00:00').getTime() })
    const firedBefore = at('2026-10-21T10:00:20').getTime()
    expect(isDue(moved, firedBefore, at('2026-10-24T10:00:00'))).toBe(false)
    expect(isDue(moved, firedBefore, at('2026-10-25T10:00:00'))).toBe(true)
    expect(describeSchedule(moved)).toMatch(/^una vez, el /)
  })
})
