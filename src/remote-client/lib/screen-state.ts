import type { PwaKey } from '../i18n/es'
import { outcomeKey, retryOffered, type Failure, type Operation } from './outcome'

/** A fast answer never flashes a skeleton: it shows only once the wait passes this (AC-6.3). */
export const LOADING_THRESHOLD_MS = 300

/** The five states every data screen has (AC-6.3), plus content; `revoked` is the wiped phone. */
export type ScreenState<T> =
  | { kind: 'loading'; since: number }
  | { kind: 'content'; data: T }
  | { kind: 'empty' }
  | { kind: 'error'; key: PwaKey; retry: boolean }
  | { kind: 'scopeOff'; key: PwaKey }
  | { kind: 'unreachable' }
  | { kind: 'revoked' }

export type ScreenEvent<T> =
  | { type: 'start' }
  | { type: 'content'; data: T }
  | { type: 'empty' }
  | { type: 'failed'; reason: Failure; operation: Operation }

export const startScreen = <T>(now: number): ScreenState<T> => ({ kind: 'loading', since: now })

export function showLoading<T>(state: ScreenState<T>, now: number): boolean {
  return state.kind === 'loading' && now - state.since >= LOADING_THRESHOLD_MS
}

/**
 * The one transition. Content is dropped on anything that is not content (AC-1.6, AC-4.2): there is no stale view to fall
 * back to. A revoked phone stays revoked, so a late answer cannot bring content back. The reducer never sees a typed draft
 * (AC-6.4): the caller keeps it.
 */
export function nextScreenState<T>(prev: ScreenState<T>, event: ScreenEvent<T>, now: number): ScreenState<T> {
  if (prev.kind === 'revoked') return prev
  switch (event.type) {
    case 'start':
      return { kind: 'loading', since: now }
    case 'content':
      return { kind: 'content', data: event.data }
    case 'empty':
      return { kind: 'empty' }
    case 'failed': {
      const { reason, operation } = event
      if (reason === 'unknown-device') return { kind: 'revoked' }
      if (reason === 'network') return { kind: 'unreachable' }
      if (reason === 'scope-off' || reason === 'write-off' || reason === 'sensitive-off') return { kind: 'scopeOff', key: outcomeKey(reason, operation) }
      return { kind: 'error', key: outcomeKey(reason, operation), retry: retryOffered(reason) }
    }
  }
}
