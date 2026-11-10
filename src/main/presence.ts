// The main side of presence signals (spec 034): turns what powerMonitor reports into presence events. Pure, no electron.
import { absenceBetween, IDLE_POLL_MS, type PresenceEvent } from '../shared/presence'

export interface TrackerState {
  locked: boolean
  /** The last input before the lock or suspend that started the current absence. */
  awaySince?: number
  /** The last input seen by the previous idle poll. */
  lastInputAt?: number
}

export type TrackerInput =
  | { type: 'lock' | 'suspend'; now: number; idleSec: number }
  | { type: 'unlock' | 'resume'; now: number }
  | { type: 'poll'; now: number; idleSec: number }

/** One step: the new state and the events to post. */
export function trackPresence(state: TrackerState, input: TrackerInput): { state: TrackerState; events: PresenceEvent[] } {
  switch (input.type) {
    case 'lock':
    case 'suspend': {
      const since = input.now - input.idleSec * 1000
      // A suspend after the lock belongs to the same absence (the earliest start wins); a lock starts a fresh one, so
      // a suspend whose resume never came cannot stretch it back.
      const awaySince = input.type === 'lock' && !state.locked ? since : (state.awaySince ?? since)
      return { state: { ...state, locked: state.locked || input.type === 'lock', awaySince }, events: [] }
    }
    case 'resume':
    case 'unlock': {
      const events: PresenceEvent[] = [{ kind: input.type, absenceMs: absenceBetween(state.awaySince, input.now) }]
      // A resume behind the lock screen is not the person yet: the unlock that follows measures the same absence.
      if (input.type === 'resume' && state.locked) return { state, events }
      // The absence is reported here, so the next poll measures from now and does not report it twice.
      return { state: { locked: false, lastInputAt: input.now }, events }
    }
    case 'poll': {
      if (state.locked) return { state, events: [] }
      const lastInput = input.now - input.idleSec * 1000
      const gap = absenceBetween(state.lastInputAt, lastInput)
      const events: PresenceEvent[] = []
      // A period without input of at least one poll; shorter gaps are ordinary typing pauses.
      const returned = gap !== null && gap >= IDLE_POLL_MS
      if (returned) events.push({ kind: 'idle-return', absenceMs: gap })
      if (input.idleSec * 1000 < IDLE_POLL_MS) events.push({ kind: 'active' })
      // Never back: an idle time reaching behind an absence already reported must not report it again.
      const lastInputAt = Math.max(lastInput, state.lastInputAt ?? lastInput)
      // A return closes the absence a suspend opened when its resume never came (Modern Standby).
      return { state: returned ? { locked: false, lastInputAt } : { ...state, lastInputAt }, events }
    }
  }
}
