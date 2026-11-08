import { useCallback, useEffect, useState } from 'react'
import type { ThreadWindow } from '../../shared/remote/wire'
import type { PwaKey } from '../i18n/es'
import { endsView, foldWindow, windowEvent } from '../lib/conversations'
import { useLatest } from '../lib/latest'
import { outcomeKey, type Failure, type Operation } from '../lib/outcome'
import { backoffMs } from '../lib/poll'
import { nextScreenState, startScreen, type ScreenEvent, type ScreenState } from '../lib/screen-state'
import { earlierCursor } from '../lib/threads'
import type { Pwa } from '../usePwa'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Held answers that come straight back must not become a hot loop: the PC allows 60 requests a minute. */
const MIN_ROUND_MS = 500

export interface Conversation {
  state: ScreenState<ThreadWindow>
  /** Continue is on at the PC (read when the conversation opens and on refresh, and cleared by a refusal). */
  continueOn: boolean
  /** One line about the last side action (earlier messages, send, stop) that did not go through. */
  note: PwaKey | null
  busy: boolean
  reload(): void
  refresh(): Promise<void>
  loadEarlier(): Promise<void>
  send(text: string): Promise<boolean>
  stop(): Promise<void>
}

/**
 * One open conversation: the last 30 messages, earlier pages on request and, when `live`, the held read that follows what is
 * committed. Nothing is stored: leaving the screen drops it all (BR-26). `pwa` is read through `useLatest` so a new object at
 * each poll never re-asks the PC.
 */
export function useConversation(pwa: Pwa, id: string, live: boolean): Conversation {
  const latest = useLatest(pwa)
  const [state, setState] = useState<ScreenState<ThreadWindow>>(() => startScreen(Date.now()))
  const held = useLatest(state)
  const [continueOn, setContinueOn] = useState(false)
  const [note, setNote] = useState<PwaKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Where the last "load earlier" asked, so a page of only tool messages moves further back instead of asking the same again.
  const [asked, setAsked] = useState<number | undefined>(undefined)

  const apply = useCallback((event: ScreenEvent<ThreadWindow>, how: 'later' | 'earlier' = 'later') => {
    setState((prev) => foldWindow(prev, event, how, Date.now()))
  }, [])

  const readAccess = useCallback(async () => {
    const access = await latest.current.access()
    setContinueOn(access.ok && access.status.scopes.history && access.status.continue)
  }, [latest])

  useEffect(() => {
    let alive = true
    setState(startScreen(Date.now()))
    setNote(null)
    setAsked(undefined)
    void Promise.all([latest.current.threads.read(id), readAccess()]).then(([out]) => {
      if (alive) setState((prev) => nextScreenState(prev, windowEvent(out), Date.now()))
    })
    return () => {
      alive = false
    }
  }, [id, attempt, latest, readAccess])

  const following = live && state.kind === 'content'
  useEffect(() => {
    if (!following) return
    let alive = true
    let controller = new AbortController()
    const onVisibility = (): void => {
      // A hidden page cancels the held read at once; showing it again resumes (as the Chat tab's poll does).
      if (document.hidden) controller.abort()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void (async () => {
      let failures = 0
      while (alive) {
        const current = held.current
        if (document.hidden || current.kind !== 'content') {
          await sleep(1000)
          continue
        }
        controller = new AbortController()
        const started = Date.now()
        const out = await latest.current.threads.read(id, { since: current.data.rev, wait: true, signal: controller.signal })
        if (!alive) return
        if (out.ok) {
          failures = 0
          setNote(null)
          apply(windowEvent(out))
        } else if (controller.signal.aborted) {
          continue
        } else if (endsView(out.reason)) {
          apply(windowEvent(out))
          return
        } else {
          failures++
          setNote(outcomeKey(out.reason, 'threads.read'))
          await sleep(backoffMs(failures))
          continue
        }
        const spent = Date.now() - started
        if (spent < MIN_ROUND_MS) await sleep(MIN_ROUND_MS - spent)
      }
    })()
    return () => {
      alive = false
      controller.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [following, id, latest, held, apply])

  /** A side action that failed: a conversation that is gone or a switch that is off replaces the view, the rest is one line. */
  const fail = useCallback(
    (reason: Failure, operation: Operation) => {
      if (endsView(reason)) apply({ type: 'failed', reason, operation })
      else setNote(outcomeKey(reason, operation))
    },
    [apply]
  )

  const refresh = useCallback(async () => {
    setBusy(true)
    const [out] = await Promise.all([latest.current.threads.read(id), readAccess()])
    setBusy(false)
    if (out.ok) setNote(null)
    apply(windowEvent(out))
  }, [id, latest, readAccess, apply])

  const loadEarlier = useCallback(async () => {
    const current = held.current
    if (current.kind !== 'content') return
    const before = earlierCursor(current.data, asked)
    setAsked(before)
    setBusy(true)
    const out = await latest.current.threads.read(id, { before })
    setBusy(false)
    if (out.ok) {
      setNote(null)
      apply(windowEvent(out), 'earlier')
    } else fail(out.reason, 'threads.read')
  }, [id, asked, latest, held, apply, fail])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      setBusy(true)
      const out = await latest.current.threads.send(id, text)
      if (out.ok) {
        setNote(null)
        await refresh()
        return true
      }
      setBusy(false)
      if (out.reason === 'write-off') setContinueOn(false)
      else fail(out.reason, 'threads.send')
      // A busy or already-running answer means the window on screen is out of date.
      if (out.reason === 'busy' || out.reason === 'run-active') await refresh()
      return false
    },
    [id, latest, refresh, fail]
  )

  const stop = useCallback(async () => {
    setBusy(true)
    const out = await latest.current.threads.stop(id)
    if (!out.ok) fail(out.reason, 'threads.stop')
    await refresh()
  }, [id, latest, refresh, fail])

  return { state, continueOn, note, busy, reload: () => setAttempt((n) => n + 1), refresh, loadEarlier, send, stop }
}
