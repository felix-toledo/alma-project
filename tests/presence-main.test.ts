import { describe, expect, it } from 'vitest'
import { type TrackerInput, type TrackerState, trackPresence } from '../src/main/presence'
import type { PresenceEvent } from '../src/shared/presence'

const MIN = 60_000
const HOUR = 60 * MIN
const T = Date.UTC(2026, 5, 10, 22, 0)

/** Feeds the inputs in order and returns the events each one posted. */
function run(inputs: TrackerInput[], start: TrackerState = { locked: false }): { state: TrackerState; posted: PresenceEvent[][] } {
  let state = start
  const posted: PresenceEvent[][] = []
  for (const input of inputs) {
    const step = trackPresence(state, input)
    state = step.state
    posted.push(step.events)
  }
  return { state, posted }
}

describe('presence: lock, suspend, resume, unlock (spec 034)', () => {
  it('AC-1.1 (034) resume and unlock post one event with the measured absence', () => {
    expect(run([{ type: 'lock', now: T, idleSec: 0 }, { type: 'unlock', now: T + 5 * HOUR }]).posted).toEqual([
      [],
      [{ kind: 'unlock', absenceMs: 5 * HOUR }]
    ])
    expect(run([{ type: 'suspend', now: T, idleSec: 0 }, { type: 'resume', now: T + 2 * HOUR }]).posted).toEqual([
      [],
      [{ kind: 'resume', absenceMs: 2 * HOUR }]
    ])
    // A resume with no suspend seen, and a second unlock in a row: the start is unknown.
    expect(run([{ type: 'resume', now: T }]).posted).toEqual([[{ kind: 'resume', absenceMs: null }]])
    expect(run([{ type: 'lock', now: T, idleSec: 0 }, { type: 'unlock', now: T + HOUR }, { type: 'unlock', now: T + 2 * HOUR }]).posted[2]).toEqual([
      { kind: 'unlock', absenceMs: null }
    ])
  })

  it('AC-1.2 (034) a lock after a suspend whose resume never came starts a fresh absence', () => {
    const { posted } = run([
      { type: 'suspend', now: T, idleSec: 0 },
      { type: 'lock', now: T + 9 * HOUR, idleSec: 0 },
      { type: 'unlock', now: T + 10 * HOUR }
    ])
    expect(posted[2]).toEqual([{ kind: 'unlock', absenceMs: HOUR }])
  })

  it('AC-1.2 (034) lock and suspend note the last input; resume then unlock share the start', () => {
    // The absence starts at the last input: now minus the idle time at the lock.
    expect(run([{ type: 'lock', now: T, idleSec: 600 }]).state).toMatchObject({ locked: true, awaySince: T - 10 * MIN })
    expect(run([{ type: 'suspend', now: T, idleSec: 0 }]).state).toMatchObject({ awaySince: T })
    // A suspend after the lock keeps the lock's start; the resume keeps it for the unlock.
    const night = run([
      { type: 'lock', now: T, idleSec: 60 },
      { type: 'suspend', now: T + 30 * MIN, idleSec: 1860 },
      { type: 'resume', now: T + 8 * HOUR },
      { type: 'unlock', now: T + 8 * HOUR + MIN }
    ])
    expect(night.posted.slice(2)).toEqual([[{ kind: 'resume', absenceMs: 8 * HOUR + MIN }], [{ kind: 'unlock', absenceMs: 8 * HOUR + 2 * MIN }]])
    expect(night.state.locked).toBe(false)
    expect(night.state.awaySince).toBeUndefined()
    // A resume while unlocked ends the absence: a later unlock has no start.
    const nap = run([{ type: 'suspend', now: T, idleSec: 0 }, { type: 'resume', now: T + HOUR }, { type: 'unlock', now: T + 2 * HOUR }])
    expect(nap.posted[2]).toEqual([{ kind: 'unlock', absenceMs: null }])
  })
})

describe('presence: the idle poll (spec 034)', () => {
  const poll = (now: number, idleSec: number): TrackerInput => ({ type: 'poll', now, idleSec })

  it('AC-1.6 (034) a poll while unlocked detects a return after a period without input', () => {
    // Active: input within the last poll keeps the last known activity.
    expect(run([poll(T, 5)]).posted).toEqual([[{ kind: 'active' }]])
    // Idle keeps growing: the last input does not move, nothing is posted.
    const idle = run([poll(T, 5), poll(T + MIN, 65), poll(T + 2 * MIN, 125), poll(T + 3 * MIN, 185)])
    expect(idle.posted.slice(1)).toEqual([[], [], []])
    // The person touches it: one return with the period without input, and the activity.
    const back = run([poll(T + 4 * MIN, 2)], idle.state)
    expect(back.posted).toEqual([[{ kind: 'idle-return', absenceMs: 4 * MIN + 3_000 }, { kind: 'active' }]])
    // Exactly one poll without input is a return; less is not.
    expect(run([poll(T, 0), poll(T + 2 * MIN, 0)]).posted[1]).toEqual([{ kind: 'idle-return', absenceMs: 2 * MIN }, { kind: 'active' }])
    expect(run([poll(T, 59), poll(T + MIN, 0)]).posted[1]).toEqual([{ kind: 'idle-return', absenceMs: 2 * MIN - 1_000 }, { kind: 'active' }])
    expect(run([poll(T, 0), poll(T + MIN, 1)]).posted[1]).toEqual([{ kind: 'active' }])
    // While locked a poll posts nothing.
    expect(run([{ type: 'lock', now: T, idleSec: 0 }, poll(T + 5 * HOUR, 0)]).posted[1]).toEqual([])
    // A clock moved back between polls is no return.
    expect(run([poll(T, 0), poll(T - HOUR, 0)]).posted[1]).toEqual([{ kind: 'active' }])
  })

  it('AC-2.8 (034) a return to an unlocked PC after 4 hours posts an idle return', () => {
    const polls: TrackerInput[] = [poll(T, 0)]
    for (let m = 1; m <= 4 * 60; m++) polls.push(poll(T + m * MIN, m * 60))
    polls.push(poll(T + 4 * HOUR + 2 * MIN, 30))
    const { posted } = run(polls)
    expect(posted.slice(1, -1).every((events) => events.length === 0)).toBe(true)
    expect(posted.at(-1)).toEqual([{ kind: 'idle-return', absenceMs: 4 * HOUR + 90_000 }, { kind: 'active' }])
  })

  it('AC-2.8 (034) a late poll right after a resume does not post a second return', () => {
    for (const idleAfter of [0, 8 * 3600]) {
      // Whether Windows reports the idle time from before the sleep or not, the absence is the resume's alone.
      const { posted } = run([
        poll(T, 0),
        { type: 'suspend', now: T + MIN, idleSec: 60 },
        { type: 'resume', now: T + 8 * HOUR },
        poll(T + 8 * HOUR + 30_000, idleAfter),
        poll(T + 8 * HOUR + 60_000, 1)
      ])
      expect(posted[2], String(idleAfter)).toEqual([{ kind: 'resume', absenceMs: 8 * HOUR }])
      expect(posted.slice(3).flat().filter((event) => event.kind === 'idle-return'), String(idleAfter)).toEqual([])
    }
  })
})
