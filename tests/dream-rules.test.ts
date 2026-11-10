// A zone with daylight saving, set before any Date is built, so the DST nights are real.
process.env.TZ = 'America/New_York'

import { describe, expect, it } from 'vitest'
import { hasKey } from '../src/shared/attach/readers'
import { costAt, costOf, PRICES } from '../src/shared/company'
import { defaultSettings } from '../src/shared/defaults'
import type { GreetingState } from '../src/shared/dream/greeting'
import { canUseWake, greetingBody, greetingDue } from '../src/shared/dream/greeting'
import type { EconomyRow } from '../src/shared/dream/model'
import { estimateCallUsd, pickDreamModel, wouldCross } from '../src/shared/dream/model'
import type { DreamSchedule, DreamTrigger } from '../src/shared/dream/schedule'
import { inNightWindow, isDreamDue, NIGHT_WINDOW } from '../src/shared/dream/schedule'
import { acceptDreamPatch, DREAM_CAP, sanitizeDreamSettings } from '../src/shared/dream/settings'
import type { ProviderId } from '../src/shared/types'

describe('dream: settings (spec 033)', () => {
  it('AC-1.1 (033) the default is off with a 0.25 cap', () => {
    expect(sanitizeDreamSettings(undefined)).toEqual({ enabled: false, capUsd: 0.25 })
    expect(sanitizeDreamSettings(null)).toEqual({ enabled: false, capUsd: 0.25 })
    expect(sanitizeDreamSettings('on')).toEqual({ enabled: false, capUsd: 0.25 })
    // Garbage falls back per field.
    expect(sanitizeDreamSettings({ enabled: 'yes', capUsd: 1 })).toEqual({ enabled: false, capUsd: 1 })
    expect(sanitizeDreamSettings({ enabled: true, capUsd: 99 })).toEqual({ enabled: true, capUsd: 0.25 })
    expect(sanitizeDreamSettings({ enabled: true, capUsd: '0.5' })).toEqual({ enabled: true, capUsd: 0.25 })
  })

  it('AC-1.3 (033) cap bounds', () => {
    expect(DREAM_CAP).toEqual({ min: 0.01, max: 5, default: 0.25 })
    const previous = { enabled: true, capUsd: 0.4 }
    expect(acceptDreamPatch(previous, { capUsd: 0.01 })).toEqual({ enabled: true, capUsd: 0.01 })
    expect(acceptDreamPatch(previous, { capUsd: 5 })).toEqual({ enabled: true, capUsd: 5 })
    for (const bad of [0.009, 5.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'abc', '0.5', null]) {
      expect(acceptDreamPatch(previous, { capUsd: bad })).toEqual(previous)
    }
    // The switch only takes a boolean; a missing field keeps the previous value.
    expect(acceptDreamPatch(previous, { enabled: false })).toEqual({ enabled: false, capUsd: 0.4 })
    expect(acceptDreamPatch(previous, { enabled: 'false' })).toEqual(previous)
    expect(acceptDreamPatch(previous, {})).toEqual(previous)
    expect(acceptDreamPatch(previous, 'garbage')).toEqual(previous)
  })
})

const at = (h: number, m = 0, day = 10): Date => new Date(2026, 5, day, h, m)
const due = (now: Date, trigger: DreamTrigger, schedule: DreamSchedule = {}, enabled = true) => isDreamDue({ now, trigger, enabled, schedule })

describe('dream: is a dream due (spec 033)', () => {
  it('AC-2.1 (033) a tick inside the window is due', () => {
    expect(NIGHT_WINDOW).toEqual({ startHour: 2, endHour: 6 })
    expect(due(at(1, 59), 'tick')).toEqual({ due: false, why: 'outside-window' })
    expect(due(at(2, 0), 'tick')).toEqual({ due: true, catchUp: false })
    expect(due(at(5, 59), 'tick')).toEqual({ due: true, catchUp: false })
    expect(due(at(6, 0), 'tick')).toEqual({ due: false, why: 'outside-window' })
    expect(inNightWindow(at(2, 0))).toBe(true)
    expect(inNightWindow(at(6, 0))).toBe(false)
  })

  it('AC-2.2 (033) a start or resume after a missed window is due', () => {
    expect(due(at(9), 'start')).toEqual({ due: true, catchUp: true })
    expect(due(at(23), 'resume')).toEqual({ due: true, catchUp: true })
    // Yesterday's dream does not cover today.
    expect(due(at(9), 'start', { doneDay: '2026-06-09' })).toEqual({ due: true, catchUp: true })
    // At 01:00 the day is still yesterday's: a missed night of yesterday is caught up.
    expect(due(at(1, 0, 11), 'resume', { doneDay: '2026-06-09' })).toEqual({ due: true, catchUp: true })
  })

  it('AC-2.3 (033) a done night is not repeated', () => {
    const schedule = { doneDay: '2026-06-10' }
    expect(due(at(3), 'tick', schedule)).toEqual({ due: false, why: 'done' })
    expect(due(at(9), 'start', schedule)).toEqual({ due: false, why: 'done' })
    expect(due(at(23), 'resume', schedule)).toEqual({ due: false, why: 'done' })
    // 01:30 the next calendar date still belongs to the done day.
    expect(due(at(1, 30, 11), 'start', schedule)).toEqual({ due: false, why: 'done' })
  })

  it('AC-2.8 (033) one retry at the next opportunity, a tick inside the window included', () => {
    const once: DreamSchedule = { attempt: { day: '2026-06-10', failures: 1, spentUsd: 0.05, aborted: false } }
    expect(due(at(10), 'start', once)).toEqual({ due: true, catchUp: true })
    expect(due(at(10), 'resume', once)).toEqual({ due: true, catchUp: true })
    expect(due(at(4), 'tick', once)).toEqual({ due: true, catchUp: true })
    expect(due(at(10), 'tick', once)).toEqual({ due: false, why: 'outside-window' })
    const twice: DreamSchedule = { attempt: { day: '2026-06-10', failures: 2, spentUsd: 0.1, aborted: false } }
    for (const trigger of ['tick', 'start', 'resume'] as const) expect(due(at(4), trigger, twice)).toEqual({ due: false, why: 'retry-spent' })
    const aborted: DreamSchedule = { attempt: { day: '2026-06-10', failures: 0, spentUsd: 0, aborted: true } }
    for (const trigger of ['tick', 'start', 'resume'] as const) expect(due(at(4), trigger, aborted)).toEqual({ due: false, why: 'aborted' })
    // Yesterday's failures and abort do not reach today.
    const yesterday: DreamSchedule = { attempt: { day: '2026-06-09', failures: 2, spentUsd: 0.1, aborted: true } }
    expect(due(at(3), 'tick', yesterday)).toEqual({ due: true, catchUp: false })
  })

  it('AC-2.7 (033) isDreamDue is pure and covers the edges', () => {
    // Switch off wins over everything.
    for (const trigger of ['tick', 'start', 'resume'] as const) expect(due(at(3), trigger, {}, false)).toEqual({ due: false, why: 'off' })
    // A restart reads the same persisted schedule and gives the same answer; the input is not mutated.
    const schedule: DreamSchedule = Object.freeze({ doneDay: '2026-06-09', attempt: Object.freeze({ day: '2026-06-10', failures: 1, spentUsd: 0.02, aborted: false }) })
    expect(due(at(9), 'start', schedule)).toEqual(due(at(9), 'start', schedule))
    // Spring forward 2026-03-08: 02:00 does not exist, 03:00 EDT follows 01:59 EST and is inside the window.
    expect(due(new Date('2026-03-08T06:59:00Z'), 'tick')).toEqual({ due: false, why: 'outside-window' })
    expect(due(new Date('2026-03-08T07:00:00Z'), 'tick')).toEqual({ due: true, catchUp: false })
    // Fall back 2026-11-01: 01:30 happens twice, both outside; 02:00 EST is inside.
    expect(due(new Date('2026-11-01T05:30:00Z'), 'tick')).toEqual({ due: false, why: 'outside-window' })
    expect(due(new Date('2026-11-01T06:30:00Z'), 'tick')).toEqual({ due: false, why: 'outside-window' })
    expect(due(new Date('2026-11-01T07:00:00Z'), 'tick')).toEqual({ due: true, catchUp: false })
    // The night counts once even across the repeated hour.
    expect(due(new Date('2026-11-01T07:30:00Z'), 'tick', { doneDay: '2026-11-01' })).toEqual({ due: false, why: 'done' })
    // A clock moved backwards after a done night never repeats a night.
    expect(due(at(3, 0, 9), 'tick', { doneDay: '2026-06-10' })).toEqual({ due: false, why: 'done' })
    expect(due(at(9, 0, 8), 'start', { doneDay: '2026-06-10' })).toEqual({ due: false, why: 'done' })
  })
})

// An injected table: the shipped rows wait for real list prices (plan §9 B-1).
const TABLE: readonly EconomyRow[] = [
  { provider: 'anthropic', model: 'a-small', input: 1, output: 5, cacheRead: 0.1, checked: '2026-11-09' },
  { provider: 'xai', model: 'x-small', input: 0.5, output: 2, cacheRead: 0.05, checked: '2026-11-09' },
  { provider: 'deepseek', model: 'd-small', input: 0.5, output: 1, cacheRead: 0.05, checked: '2026-11-09' },
  { provider: 'meta', model: 'm-small', input: 0.2, output: 1, cacheRead: 0.02, checked: '2026-11-09' }
]
const keyed = (...providers: ProviderId[]) => (provider: ProviderId) => providers.includes(provider)

describe('dream: model and cost (spec 033)', () => {
  it('AC-4.1 (033) the cheapest keyed economy model', () => {
    expect(pickDreamModel(keyed('anthropic', 'xai', 'meta'), TABLE)?.model).toBe('m-small')
    expect(pickDreamModel(keyed('anthropic', 'xai'), TABLE)?.model).toBe('x-small')
    // The gateway alone has no row: no model.
    expect(pickDreamModel(keyed('vercel'), TABLE)).toBeNull()
    expect(pickDreamModel(keyed(), TABLE)).toBeNull()
    // A tie in input price goes to the table's order.
    expect(pickDreamModel(keyed('deepseek', 'xai'), TABLE)?.provider).toBe('xai')
    // A key from the environment counts, as for vision and attachments.
    const settings = defaultSettings()
    expect(pickDreamModel((p) => hasKey(settings, p, { DEEPSEEK_API_KEY: 'k' }), TABLE)?.provider).toBe('deepseek')
    expect(pickDreamModel((p) => hasKey(settings, p, {}), TABLE)).toBeNull()
  })

  it('AC-1.2 (033) the named model follows the keys', () => {
    const settings = defaultSettings()
    settings.providers.anthropic.apiKey = 'k'
    expect(pickDreamModel((p) => hasKey(settings, p, {}), TABLE)?.provider).toBe('anthropic')
    settings.providers.meta.apiKey = 'k'
    expect(pickDreamModel((p) => hasKey(settings, p, {}), TABLE)?.provider).toBe('meta')
    settings.providers.meta.apiKey = ''
    expect(pickDreamModel((p) => hasKey(settings, p, {}), TABLE)?.provider).toBe('anthropic')
  })

  it('AC-4.3 (033) wouldCross', () => {
    // Exactly at the cap does not cross, with decimal amounts that float sums get wrong.
    expect(wouldCross(0.1, 0.1, 0.05, 0.25)).toBe(false)
    expect(wouldCross(0.1, 0.2, 0, 0.3)).toBe(false)
    expect(wouldCross(0.1, 0.1, 0.06, 0.25)).toBe(true)
    expect(wouldCross(0, 0.26, 0, 0.25)).toBe(true)
    // The reserve counts.
    expect(wouldCross(0, 0.2, 0.1, 0.25)).toBe(true)
    // Tokens are estimated as characters / 4, at the row's list prices.
    const row = TABLE[0]
    expect(estimateCallUsd(row, 4_000_000, 1_000_000)).toBeCloseTo(1 * 1 + 1 * 5)
  })

  it('AC-4.3 (033) costAt is the companies formula: costOf is unchanged for every PRICES row', () => {
    const usage = { inputTokens: 1_200_000, outputTokens: 300_000, cacheReadTokens: 200_000 }
    for (const provider of Object.keys(PRICES) as ProviderId[]) {
      const p = PRICES[provider]
      const expected = (1_000_000 * p.input + 200_000 * p.cacheRead + 300_000 * p.output) / 1_000_000
      expect(costOf(provider, usage)).toBeCloseTo(expected, 10)
      expect(costAt(p, usage)).toBeCloseTo(expected, 10)
    }
    expect(costAt(PRICES.meta, { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(1.25, 10)
  })
})

const written = (day: string, deliveredAt?: number): GreetingState => ({ day, threadId: 'g1', capped: false, ...(deliveredAt ? { deliveredAt } : {}) })

describe('dream: the morning greeting (spec 033)', () => {
  it('AC-7.9 (033) greetingDue', () => {
    const now = at(8)
    expect(greetingDue({ now, enabled: true, greeting: written('2026-06-10'), catchUpRunning: false })).toBe('deliver')
    // Written and a catch-up running: the written one is delivered.
    expect(greetingDue({ now, enabled: true, greeting: written('2026-06-10'), catchUpRunning: true })).toBe('deliver')
    expect(greetingDue({ now, enabled: true, catchUpRunning: true })).toBe('wait')
    expect(greetingDue({ now, enabled: true, greeting: written('2026-06-09'), catchUpRunning: true })).toBe('wait')
    expect(greetingDue({ now, enabled: true, catchUpRunning: false })).toBe('none')
    // Delivered already today: never twice.
    expect(greetingDue({ now, enabled: true, greeting: written('2026-06-10', now.getTime() - 1000), catchUpRunning: false })).toBe('none')
    expect(greetingDue({ now, enabled: true, greeting: written('2026-06-10', now.getTime() - 1000), catchUpRunning: true })).toBe('none')
    // Off: nothing, whatever is written.
    expect(greetingDue({ now, enabled: false, greeting: written('2026-06-10'), catchUpRunning: true })).toBe('none')
  })

  it('AC-7.1 (033) an early wake is not used up', () => {
    const yesterdayDelivered = written('2026-06-09', at(8, 0, 9).getTime())
    // A message at 02:05 and an unlock at 03:00 before the night's dream: nothing to deliver, nothing used up.
    for (const now of [at(2, 5), at(3, 0)]) {
      expect(greetingDue({ now, enabled: true, greeting: yesterdayDelivered, catchUpRunning: false })).toBe('none')
      expect(canUseWake(yesterdayDelivered, now, false)).toBe(false)
    }
    // At 08:00 the night's greeting is written: the next wake delivers it.
    expect(greetingDue({ now: at(8), enabled: true, greeting: written('2026-06-10'), catchUpRunning: false })).toBe('deliver')
    expect(canUseWake(written('2026-06-10'), at(8), false)).toBe(true)
    // A catch-up dream running makes a wake usable: it waits for the dream.
    expect(canUseWake(yesterdayDelivered, at(9), true)).toBe(true)
    expect(canUseWake(written('2026-06-10', at(8).getTime()), at(9), true)).toBe(false)
  })

  it('AC-7.12 (033) an undelivered greeting is dropped at 02:00', () => {
    const undelivered = written('2026-06-10')
    expect(greetingDue({ now: at(1, 59, 11), enabled: true, greeting: undelivered, catchUpRunning: false })).toBe('deliver')
    expect(greetingDue({ now: at(2, 0, 11), enabled: true, greeting: undelivered, catchUpRunning: false })).toBe('none')
    expect(canUseWake(undelivered, at(9, 0, 11), false)).toBe(false)
  })

  it("AC-7.11 (033) a capped dream's greeting says so", () => {
    expect(greetingBody('Buen día. Anoche ordené tus recuerdos.', 'Me detuve en el tope de gasto.')).toBe('Buen día. Anoche ordené tus recuerdos.\n\nMe detuve en el tope de gasto.')
    expect(greetingBody('Buen día.', null)).toBe('Buen día.')
  })
})
