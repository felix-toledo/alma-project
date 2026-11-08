import type { CamerasOutcome, PwaCamera } from './cameras'
import { groupByRoom, type RoomGroup, type ThingsOutcome } from './home'
import type { ScreenEvent } from './screen-state'

/** The house and the cameras answer in their own words (`refused`, `house-off`); here they become the shared screen states. */
export type HouseView<T> = { kind: 'ready'; data: T } | { kind: 'off'; note?: string }

type Failed = Extract<ThingsOutcome | CamerasOutcome, { ok: false }>

function failure<T>(outcome: Failed, operation: 'home' | 'cameras'): ScreenEvent<HouseView<T>> {
  // A house that is off is a state with the PC's own sentence (why it is off), not an error and not a retry.
  if (outcome.reason === 'house-off') return { type: 'content', data: { kind: 'off', note: outcome.note } }
  return { type: 'failed', reason: outcome.reason === 'refused' ? 'unknown-device' : outcome.reason, operation }
}

export function homeEvent(outcome: ThingsOutcome): ScreenEvent<HouseView<RoomGroup[]>> {
  if (!outcome.ok) return failure(outcome, 'home')
  if (outcome.things.length === 0) return { type: 'empty' }
  return { type: 'content', data: { kind: 'ready', data: groupByRoom(outcome.things, outcome.areas) } }
}

export function camerasEvent(outcome: CamerasOutcome): ScreenEvent<HouseView<PwaCamera[]>> {
  if (!outcome.ok) return failure(outcome, 'cameras')
  if (outcome.cameras.length === 0) return { type: 'empty' }
  return { type: 'content', data: { kind: 'ready', data: outcome.cameras } }
}
