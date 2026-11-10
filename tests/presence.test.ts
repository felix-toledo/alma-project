// A zone with daylight saving, set before any Date is built, so the DST nights are real.
process.env.TZ = 'America/New_York'

import { describe, expect, it } from 'vitest'
import type { WakeInput } from '../src/shared/presence'
import { absenceBetween, dayKey, decideWake, PresenceEventSchema, PresenceStateSchema, presenceThreshold, WAKE_ABSENCE_MS } from '../src/shared/presence'

describe('presence: the day boundary (spec 034)', () => {
  it('AC-2.4 (034) the day starts at 02:00', () => {
    expect(dayKey(new Date(2026, 5, 10, 1, 59))).toBe('2026-06-09')
    expect(dayKey(new Date(2026, 5, 10, 2, 0))).toBe('2026-06-10')
    // A return at 00:30 after an evening away belongs to the previous day.
    expect(dayKey(new Date(2026, 5, 10, 0, 30))).toBe('2026-06-09')
    expect(dayKey(new Date(2027, 0, 1, 0, 30))).toBe('2026-12-31')
    expect(dayKey(new Date(2027, 0, 1, 23, 59))).toBe('2027-01-01')
  })

  it('AC-2.4 (034) the day starts at 02:00 on the daylight-saving nights', () => {
    // Spring forward, 2026-03-08: 01:59 EST is followed by 03:00 EDT.
    expect(dayKey(new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-07')
    expect(dayKey(new Date('2026-03-08T07:00:00Z'))).toBe('2026-03-08')
    // Fall back, 2026-11-01: 01:30 happens twice, both before 02:00.
    expect(dayKey(new Date('2026-11-01T05:30:00Z'))).toBe('2026-10-31')
    expect(dayKey(new Date('2026-11-01T06:30:00Z'))).toBe('2026-10-31')
    expect(dayKey(new Date('2026-11-01T07:00:00Z'))).toBe('2026-11-01')
  })
})

describe('presence: absence and threshold (spec 034)', () => {
  it('AC-2.9 (034) absence is elapsed time', () => {
    const start = Date.UTC(2026, 5, 10, 1, 0)
    expect(absenceBetween(start, start + 5 * 3_600_000)).toBe(5 * 3_600_000)
    expect(absenceBetween(start, start)).toBe(0)
    // 00:00 to 06:00 local across the spring-forward night is 5 hours away, not the 6 the wall clock shows.
    const before = new Date(2026, 2, 8, 0, 0).getTime()
    const after = new Date(2026, 2, 8, 6, 0).getTime()
    expect(absenceBetween(before, after)).toBe(5 * 3_600_000)
    // A start later than the event counts as no absence.
    expect(absenceBetween(start + 1, start)).toBeNull()
  })

  it('AC-2.6 (034) an unknown start has no absence', () => {
    expect(absenceBetween(undefined, Date.UTC(2026, 5, 10))).toBeNull()
  })

  it('AC-2.12 (034) the test threshold only applies unpackaged', () => {
    expect(WAKE_ABSENCE_MS).toBe(4 * 3_600_000)
    expect(presenceThreshold(true, { ALMA_PRESENCE_THRESHOLD_MS: '60000' })).toBe(WAKE_ABSENCE_MS)
    expect(presenceThreshold(false, { ALMA_PRESENCE_THRESHOLD_MS: '60000' })).toBe(60_000)
    expect(presenceThreshold(false, {})).toBe(WAKE_ABSENCE_MS)
    for (const garbage of ['', 'abc', '0', '-5', '1.5', '1e3', ' 60000', 'Infinity']) {
      expect(presenceThreshold(false, { ALMA_PRESENCE_THRESHOLD_MS: garbage }), garbage).toBe(WAKE_ABSENCE_MS)
    }
  })
})

describe('presence: the message schema (spec 034)', () => {
  const ok = (value: unknown): boolean => PresenceEventSchema.safeParse(value).success

  it('AC-1.3 (034) the schema', () => {
    for (const kind of ['unlock', 'resume', 'idle-return']) {
      expect(ok({ kind, absenceMs: 0 }), kind).toBe(true)
      expect(ok({ kind, absenceMs: 5 * 3_600_000 }), kind).toBe(true)
      expect(ok({ kind, absenceMs: null }), kind).toBe(true)
    }
    expect(ok({ kind: 'start' })).toBe(true)
    expect(ok({ kind: 'active' })).toBe(true)

    expect(ok({ kind: 'login', absenceMs: 0 })).toBe(false)
    for (const absenceMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '3600000', undefined]) {
      expect(ok({ kind: 'unlock', absenceMs }), String(absenceMs)).toBe(false)
    }
    expect(ok({ kind: 'resume', absenceMs: 0, at: 123 })).toBe(false)
    expect(ok({ kind: 'active', absenceMs: 0 })).toBe(false)
    expect(ok({ absenceMs: 0 })).toBe(false)
    expect(ok(null)).toBe(false)
    expect(ok('unlock')).toBe(false)
  })

  it('AC-1.7 (034) a start is one message with no launch detail', () => {
    expect(ok({ kind: 'start' })).toBe(true)
    expect(ok({ kind: 'start', how: 'login' })).toBe(false)
    expect(ok({ kind: 'start', absenceMs: 0 })).toBe(false)
  })

  it('AC-3.1 (034) the persisted state holds only the two fields', () => {
    expect(PresenceStateSchema.safeParse({}).success).toBe(true)
    expect(PresenceStateSchema.safeParse({ lastWakeDay: '2026-06-10', lastActivityAt: 1 }).success).toBe(true)
    expect(PresenceStateSchema.safeParse({ lastWakeDay: '2026-06-10', events: [] }).success).toBe(false)
    expect(PresenceStateSchema.safeParse({ lastWakeDay: 'yesterday' }).success).toBe(false)
    expect(PresenceStateSchema.safeParse({ lastActivityAt: -1 }).success).toBe(false)
    expect(PresenceStateSchema.safeParse(null).success).toBe(false)
  })
})

describe('presence: the once-a-day rule (spec 034)', () => {
  const HOUR = 3_600_000
  const morning = new Date(2026, 5, 10, 7, 30)
  const input = (patch: Partial<WakeInput> = {}): WakeInput => ({
    event: 'unlock',
    absenceMs: 5 * HOUR,
    now: morning,
    state: {},
    canUse: true,
    thresholdMs: WAKE_ABSENCE_MS,
    ...patch
  })

  it("AC-2.1 (034) a 4-hour absence gives the day's signal", () => {
    for (const event of ['unlock', 'resume', 'idle-return', 'start'] as const) {
      expect(decideWake(input({ event })), event).toEqual({ wake: true, state: { lastWakeDay: '2026-06-10' } })
    }
    // The last known activity is kept as it was.
    expect(decideWake(input({ state: { lastActivityAt: 42 } })).state).toEqual({ lastWakeDay: '2026-06-10', lastActivityAt: 42 })
  })

  it('AC-2.2 (034) a shorter absence gives none', () => {
    expect(decideWake(input({ absenceMs: 4 * HOUR - 1 }))).toEqual({ wake: false, state: {} })
    expect(decideWake(input({ absenceMs: 30 * 60_000 })).wake).toBe(false)
    expect(decideWake(input({ absenceMs: 4 * HOUR })).wake).toBe(true)
    // The test threshold in force decides, not the constant.
    expect(decideWake(input({ absenceMs: 61_000, thresholdMs: 60_000 })).wake).toBe(true)
  })

  it('AC-2.3 (034) a second qualifying event the same day gives none', () => {
    const first = decideWake(input({ event: 'resume' }))
    expect(first.wake).toBe(true)
    // The resume-then-unlock burst of one return, and a later return the same day.
    expect(decideWake(input({ event: 'unlock', state: first.state }))).toEqual({ wake: false, state: first.state })
    expect(decideWake(input({ event: 'idle-return', state: first.state, now: new Date(2026, 5, 11, 1, 59) })).wake).toBe(false)
    // The next day, after 02:00, a new one.
    expect(decideWake(input({ state: first.state, now: new Date(2026, 5, 11, 2, 0) })).wake).toBe(true)
  })

  it('AC-2.4 (034) a return at 00:30 does not use up the next morning', () => {
    const night = decideWake(input({ now: new Date(2026, 5, 10, 0, 30) }))
    expect(night).toEqual({ wake: true, state: { lastWakeDay: '2026-06-09' } })
    expect(decideWake(input({ state: night.state, now: new Date(2026, 5, 10, 7, 0) })).wake).toBe(true)
  })

  it('AC-2.6 (034) an unlock with an unknown start is not a signal', () => {
    for (const event of ['unlock', 'resume', 'idle-return', 'start'] as const) {
      expect(decideWake(input({ event, absenceMs: null })), event).toEqual({ wake: false, state: {} })
    }
  })

  it('AC-2.7 (034) a start is judged by the last known activity alone', () => {
    const now = morning.getTime()
    const start = (lastActivityAt?: number): boolean => {
      const state = lastActivityAt === undefined ? {} : { lastActivityAt }
      return decideWake(input({ event: 'start', state, absenceMs: absenceBetween(state.lastActivityAt, now) })).wake
    }
    expect(start(now - 4 * HOUR)).toBe(true)
    expect(start(now - 10 * HOUR)).toBe(true)
    // A quick reboot after an update.
    expect(start(now - (3 * HOUR + 59 * 60_000))).toBe(false)
    expect(start(now - 60_000)).toBe(false)
    // The first start after installing, or after a consumer was turned on.
    expect(start(undefined)).toBe(false)
    // An activity in the future (a clock moved back) is no absence.
    expect(start(now + HOUR)).toBe(false)
  })

  it('AC-2.8 (034) an idle return after 4 hours is a signal', () => {
    expect(decideWake(input({ event: 'idle-return', absenceMs: 4 * HOUR })).wake).toBe(true)
    expect(decideWake(input({ event: 'idle-return', absenceMs: 2 * HOUR })).wake).toBe(false)
  })

  it('AC-2.9 (034) a clock moved back to an earlier day gives no second signal', () => {
    const first = decideWake(input())
    expect(decideWake(input({ state: first.state, now: new Date(2026, 5, 9, 9, 0) })).wake).toBe(false)
  })

  it('AC-2.10 (034) decideWake is pure', () => {
    const state = Object.freeze({ lastActivityAt: 7 })
    const frozen = Object.freeze(input({ state }))
    const once = decideWake(frozen)
    expect(decideWake(frozen)).toEqual(once)
    expect(state).toEqual({ lastActivityAt: 7 })
    expect(once.state).not.toBe(state)
    // lastWakeDay changes only with a wake.
    const used = Object.freeze({ lastWakeDay: '2026-06-01' })
    expect(decideWake(input({ state: used, absenceMs: 60_000 })).state).toBe(used)
  })
})

describe('presence: a signal no consumer can use (spec 034)', () => {
  it('AC-2.13 (034) a signal no consumer can use is not used up', () => {
    const base = { event: 'unlock', absenceMs: 6 * 3_600_000, state: {}, thresholdMs: WAKE_ABSENCE_MS } as const
    const early = decideWake({ ...base, now: new Date(2026, 5, 10, 2, 10), canUse: false })
    expect(early).toEqual({ wake: false, state: {} })
    const later = decideWake({ ...base, event: 'idle-return', now: new Date(2026, 5, 10, 7, 0), state: early.state, canUse: true })
    expect(later).toEqual({ wake: true, state: { lastWakeDay: '2026-06-10' } })
  })
})
