import { useCallback, useEffect, useState } from 'react'
import { useLatest } from '../lib/latest'
import { nextScreenState, startScreen, type ScreenEvent, type ScreenState } from '../lib/screen-state'

/**
 * Asks the PC again whenever `key` changes (or `reload` is called) and keeps the answer as a screen state. `load` is read through
 * `useLatest` because `usePwa` returns a new object on every poll: depending on it would re-ask the PC at each poll.
 * `refresh` asks again without going back to loading, for a screen that just changed something and wants the new picture.
 */
export function useLoad<T>(load: () => Promise<ScreenEvent<T>>, key: string): { state: ScreenState<T>; reload(): void; refresh(): Promise<void> } {
  const latest = useLatest(load)
  const [state, setState] = useState<ScreenState<T>>(() => startScreen(Date.now()))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    setState((prev) => nextScreenState(prev, { type: 'start' }, Date.now()))
    void latest.current().then((event) => {
      if (alive) setState((prev) => nextScreenState(prev, event, Date.now()))
    })
    return () => {
      alive = false
    }
  }, [key, attempt, latest])
  const refresh = useCallback(async () => {
    const event = await latest.current()
    setState((prev) => nextScreenState(prev, event, Date.now()))
  }, [latest])
  return { state, reload: () => setAttempt((n) => n + 1), refresh }
}
