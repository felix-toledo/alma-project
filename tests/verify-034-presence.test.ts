// A zone whose fall-back hour is 02:00-03:00: the day boundary happens twice (2026-10-25).
process.env.TZ = 'Europe/Madrid'

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type TrackerInput, type TrackerState, trackPresence } from '../src/main/presence'
import { type PresenceConsumer, PresenceService } from '../src/coordinator/presence'
import { exportPersonalData } from '../src/coordinator/privacy'
import { decideWake, PresenceEventSchema, type PresenceState, WAKE_ABSENCE_MS } from '../src/shared/presence'

// Adversarial verification of spec 034. Written from spec.md only.

const HOUR = 3_600_000
const MIN = 60_000
const wake = (now: Date, absenceMs: number | null, state: PresenceState = {}, canUse = true) =>
  decideWake({ event: 'unlock', absenceMs, now, state, canUse, thresholdMs: WAKE_ABSENCE_MS })

describe('verify 034 the wake-signal rule', () => {
  it('verify 034 AC-2.1 AC-2.2 BR-3 exactly 4 hours counts, a millisecond less does not', () => {
    const now = new Date(2026, 10, 10, 8)
    expect(WAKE_ABSENCE_MS).toBe(4 * HOUR)
    expect(wake(now, 4 * HOUR).wake).toBe(true)
    expect(wake(now, 4 * HOUR - 1).wake).toBe(false)
    expect(wake(now, null).wake).toBe(false)
  })

  it('verify 034 AC-2.13 BR-12 a signal no consumer can use leaves the state untouched; a later one that day still counts', () => {
    const now = new Date(2026, 10, 10, 2, 30)
    const early = wake(now, 6 * HOUR, {}, false)
    expect(early).toEqual({ wake: false, state: {} })
    expect(wake(new Date(2026, 10, 10, 8), 5 * HOUR, early.state, true)).toEqual({ wake: true, state: { lastWakeDay: '2026-11-10' } })
  })

  it('verify 034 AC-2.3 AC-2.4 BR-4 at most one a day across the repeated 02:xx of the fall-back night', () => {
    // 01:30 CEST on 2026-10-25 belongs to 2026-10-24: it does not use up the morning.
    const lateNight = wake(new Date('2026-10-24T23:30:00Z'), 5 * HOUR)
    expect(lateNight.state.lastWakeDay).toBe('2026-10-24')
    const first = wake(new Date('2026-10-25T00:30:00Z'), 5 * HOUR, lateNight.state)
    expect(first).toEqual({ wake: true, state: { lastWakeDay: '2026-10-25' } })
    // 02:30 CET, one real hour later, same local reading: same day, no second signal.
    expect(wake(new Date('2026-10-25T01:30:00Z'), 5 * HOUR, first.state).wake).toBe(false)
    expect(wake(new Date(2026, 9, 25, 23, 59), 5 * HOUR, first.state).wake).toBe(false)
    expect(wake(new Date(2026, 9, 26, 2, 0), 5 * HOUR, first.state).wake).toBe(true)
  })

  it('verify 034 AC-1.3 AC-1.7 the schema rejects hostile or extended payloads', () => {
    const bad: unknown[] = [
      { kind: 'unlock', absenceMs: Number.POSITIVE_INFINITY },
      { kind: 'unlock', absenceMs: Number.NaN },
      { kind: 'unlock', absenceMs: -1 },
      { kind: 'unlock', absenceMs: '14400000' },
      { kind: 'unlock' },
      { kind: 'resume', absenceMs: 5, at: 1 },
      { kind: 'start', absenceMs: 5 * HOUR },
      { kind: 'start', atLogin: true },
      { kind: 'active', idleSec: 3 },
      { kind: 'lock', absenceMs: 1 },
      { kind: 'UNLOCK', absenceMs: 1 },
      null,
      [],
      'unlock'
    ]
    for (const value of bad) expect(PresenceEventSchema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    expect(PresenceEventSchema.safeParse({ kind: 'idle-return', absenceMs: 0 }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------

function run(steps: TrackerInput[], state: TrackerState = { locked: false }) {
  const posted: { step: number; event: unknown }[] = []
  steps.forEach((input, step) => {
    const out = trackPresence(state, input)
    state = out.state
    for (const event of out.events) posted.push({ step, event })
  })
  return { posted, state }
}

describe('verify 034 main: measuring the absence', () => {
  const T = new Date(2026, 10, 9, 23, 0).getTime()

  it('verify 034 AC-1.2 BR-3 an automatic lock after 10 idle minutes measures from the last input', () => {
    const { posted } = run([
      { type: 'lock', now: T + 10 * MIN, idleSec: 600 },
      { type: 'unlock', now: T + 4 * HOUR }
    ])
    expect(posted).toEqual([{ step: 1, event: { kind: 'unlock', absenceMs: 4 * HOUR } }])
  })

  it('verify 034 AC-1.2 AC-2.2 a short lunch lock after a night of sleep without resume is measured from the lunch lock, not from the night', () => {
    // Modern Standby: the suspend fires, the resume does not; the morning return is seen by the idle poll.
    const { posted } = run([
      { type: 'poll', now: T, idleSec: 0 },
      { type: 'suspend', now: T + MIN, idleSec: 60 },
      { type: 'poll', now: T + 9 * HOUR, idleSec: 5 },
      { type: 'poll', now: T + 9 * HOUR + MIN, idleSec: 2 },
      { type: 'lock', now: T + 13 * HOUR, idleSec: 0 },
      { type: 'unlock', now: T + 14 * HOUR }
    ])
    const unlock = posted.find((p) => (p.event as { kind: string }).kind === 'unlock')
    expect(unlock?.event).toEqual({ kind: 'unlock', absenceMs: HOUR })
  })

  it('verify 034 AC-2.6 BR-11 an unlock whose lock main never saw has no absence', () => {
    expect(run([{ type: 'unlock', now: T }]).posted).toEqual([{ step: 0, event: { kind: 'unlock', absenceMs: null } }])
  })

  it('verify 034 AC-1.6 AC-2.8 minute polls over a long idle stretch post one return, at the return, with its length', () => {
    const steps: TrackerInput[] = [{ type: 'poll', now: T, idleSec: 0 }]
    // Five hours untouched and unlocked: the idle time grows each minute.
    for (let m = 1; m <= 300; m++) steps.push({ type: 'poll', now: T + m * MIN, idleSec: m * 60 })
    steps.push({ type: 'poll', now: T + 301 * MIN, idleSec: 10 })
    steps.push({ type: 'poll', now: T + 302 * MIN, idleSec: 20 })
    const returns = run(steps).posted.filter((p) => (p.event as { kind: string }).kind === 'idle-return')
    expect(returns).toEqual([{ step: 301, event: { kind: 'idle-return', absenceMs: 301 * MIN - 10_000 } }])
  })
})

// ---------------------------------------------------------------------------

let dir: string
let clock: Date
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alma-verify-presence-'))
  clock = new Date(2026, 10, 10, 8)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const consumer = (on = true, usable = true) => {
  const fake = { on, usable, calls: [] as unknown[][], enabled: () => fake.on, canUse: () => fake.usable, wake: (...args: unknown[]) => void fake.calls.push(args) }
  return fake
}
const presence = (consumers: PresenceConsumer[], logs: string[] = []) =>
  new PresenceService({ file: join(dir, 'presence.json'), now: () => clock, thresholdMs: 4 * HOUR, consumers: () => consumers, log: (l) => void logs.push(l) })

describe('verify 034 coordinator: what is kept and offered', () => {
  it('verify 034 AC-2.11 BR-8 with no consumer on, a burst of events stores nothing; after turning one on, a start is not a signal', () => {
    const fake = consumer(false)
    const service = presence([fake])
    for (const event of [{ kind: 'start' }, { kind: 'active' }, { kind: 'unlock', absenceMs: 9 * HOUR }, { kind: 'idle-return', absenceMs: 5 * HOUR }]) service.receive(event)
    expect(readdirSync(dir)).toEqual([])
    expect(fake.calls).toEqual([])
    fake.on = true
    service.consumersChanged()
    clock = new Date(2026, 10, 10, 9)
    service.receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
  })

  it('verify 034 AC-3.1 AC-3.2 many events keep exactly two fields; the consumer gets no detail', () => {
    const fake = consumer()
    const service = presence([fake])
    for (let i = 0; i < 200; i++) {
      clock = new Date(clock.getTime() + 7 * MIN)
      service.receive(i % 50 === 0 ? { kind: 'unlock', absenceMs: 5 * HOUR } : { kind: 'active' })
    }
    const stored = JSON.parse(readFileSync(join(dir, 'presence.json'), 'utf8'))
    expect(Object.keys(stored).sort()).toEqual(['lastActivityAt', 'lastWakeDay'])
    expect(readdirSync(dir)).toEqual(['presence.json'])
    expect(fake.calls.length).toBeGreaterThan(0)
    for (const call of fake.calls) expect(call).toEqual([])
  })

  it('verify 034 AC-2.7 AC-2.9 a start after a clock moved back (last activity in the future) is not a signal', () => {
    const fake = consumer()
    writeFileSync(join(dir, 'presence.json'), JSON.stringify({ lastActivityAt: new Date(2026, 10, 11, 8).getTime() }))
    presence([fake]).receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
  })

  it('verify 034 AC-2.7 a start judged by the persisted last activity: 4 hours after, yes; then nothing more that day', () => {
    const fake = consumer()
    writeFileSync(join(dir, 'presence.json'), JSON.stringify({ lastActivityAt: clock.getTime() - 4 * HOUR }))
    const service = presence([fake])
    service.receive({ kind: 'start' })
    expect(fake.calls).toHaveLength(1)
    clock = new Date(2026, 10, 10, 20)
    presence([fake]).receive({ kind: 'unlock', absenceMs: 6 * HOUR })
    expect(fake.calls).toHaveLength(1)
  })

  it('verify 034 AC-3.3 BR-9 erase clears the state (a later start is not a signal) and export leaves it out', () => {
    const fake = consumer()
    const service = presence([fake])
    service.receive({ kind: 'active' })
    expect(existsSync(join(dir, 'presence.json'))).toBe(true)
    const out = exportPersonalData(dir, mkdtempSync(join(tmpdir(), 'alma-verify-export-')))
    expect(readdirSync(out)).not.toContain('presence.json')
    rmSync(out, { recursive: true, force: true })
    service.clear()
    expect(existsSync(join(dir, 'presence.json'))).toBe(false)
    clock = new Date(2026, 10, 10, 18)
    service.receive({ kind: 'start' })
    expect(fake.calls).toEqual([])
  })

  it('verify 034 AC-1.3 a malformed message changes nothing and its payload is not logged', () => {
    const fake = consumer()
    const logs: string[] = []
    const service = presence([fake], logs)
    service.receive({ kind: 'unlock', absenceMs: 9 * HOUR, note: 'payload-marker-55' })
    service.receive({ kind: 'start', marker: 'payload-marker-55' })
    expect(readdirSync(dir)).toEqual([])
    expect(fake.calls).toEqual([])
    expect(logs).toHaveLength(2)
    expect(logs.join('\n')).not.toContain('payload-marker-55')
  })
})
