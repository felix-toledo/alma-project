// The phone's live session (T43): device, token renewal, the poll loop, chat actions.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { b64u } from '../shared/remote/crypto'
import type { PwaKey } from './i18n/es'
import { pwaFetch } from './http'
import { idbStorage } from './idb'
import { answerApproval, chatOutcomeKey, newChat, sendChat, stopChat, type AnswerOutcome, type ChatOutcome } from './lib/chat'
import { fetchCameras, fetchStill, type CamerasOutcome, type StillOutcome } from './lib/cameras'
import { controlThing, fetchThings, type ControlOutcome, type ThingsOutcome } from './lib/home'
import { signWithDeviceKey } from './lib/keys'
import { fetchImage, findNotes, listFolder, readNote, type FindOutcome, type FolderOutcome, type ImageOutcome, type ReadOutcome } from './lib/notes'
import { listThreads, readThread, sendThread, stopThread, type ThreadActionOutcome, type ThreadsOutcome, type WindowOutcome } from './lib/threads'
import { fetchStatus, type StatusOutcome } from './lib/status'
import { backoffMs, clearOwnNote, mergeState, nextSince, pollOnce, pong, type PwaState } from './lib/poll'
import { needsRenewal, openSession, singleFlight } from './lib/session'
import { requestStepUp, type StepUpChallengeOutcome } from './lib/stepup'
import { subscribePush } from './lib/push'
import { forgetPc, wipePwa, type PwaStorage } from './lib/storage'

export type PwaStatus = 'loading' | 'unpaired' | 'ready' | 'refused' | 'unreachable'

export interface Pwa {
  status: PwaStatus
  deviceId: string | null
  state: PwaState | null
  note: PwaKey | null
  clearNote(): void
  paired(): void
  send(text: string): Promise<boolean>
  answer(id: string, decision: 'allow' | 'deny'): Promise<void>
  newConversation(): Promise<void>
  stop(): Promise<void>
  things(): Promise<ThingsOutcome>
  control(thing: string, action: string, assertion?: { authenticatorData: string; clientDataJSON: string; signature: string }): Promise<ControlOutcome>
  stepUpChallenge(thing: string, action: string): Promise<StepUpChallengeOutcome>
  cameras(): Promise<CamerasOutcome>
  still(entityId: string): Promise<StillOutcome>
  /** Notes and conversations are read from the PC at each call and kept nowhere (BR-26). */
  notes: {
    list(folder: string): Promise<FolderOutcome>
    find(query: string): Promise<FindOutcome>
    read(path: string): Promise<ReadOutcome>
    image(target: string, from: string): Promise<ImageOutcome>
  }
  threads: {
    list(offset: number): Promise<ThreadsOutcome>
    read(id: string, options?: { before?: number; since?: number; wait?: boolean; signal?: AbortSignal }): Promise<WindowOutcome>
    send(id: string, text: string): Promise<ThreadActionOutcome>
    stop(id: string): Promise<ThreadActionOutcome>
  }
  /** Which switches are on (`status` above is the phone's own session state). */
  access(): Promise<StatusOutcome>
  forget(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type Wipable = { ok: boolean; reason?: string }

async function wipeAll(storage: PwaStorage): Promise<void> {
  await wipePwa({ storage, caches })
}

export function usePwa(): Pwa {
  const [status, setStatus] = useState<PwaStatus>('loading')
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [state, setState] = useState<PwaState | null>(null)
  const [note, setNote] = useState<PwaKey | null>(null)
  const [generation, setGeneration] = useState(0)
  const runId = useRef(0)

  const wipe = useCallback(async () => {
    await wipeAll(idbStorage())
    setDeviceId(null)
    setState(null)
    setStatus('refused')
  }, [])

  const failOutcome = useCallback(
    async (outcome: ChatOutcome | AnswerOutcome): Promise<boolean> => {
      // The token was ensured fresh before the call, so a 401 means the key itself
      // is refused (revoked, deleted or idle-expired): wipe (AC-5.3).
      if (outcome.ok) {
        setNote(null)
        return true
      }
      if (outcome.reason === 'refused') await wipe()
      else setNote(chatOutcomeKey(outcome.reason))
      return false
    },
    [wipe]
  )

  // A fresh token for every call: renewal first, so a 401 after it always means the
  // key itself is refused (an expired token is renewed, never mistaken for a revoke).
  // Single flight: the PC keeps one nonce per device, so a second concurrent renewal
  // would be refused and wrongly wipe the key.
  const ensureToken = useMemo(
    () =>
      singleFlight(async (): Promise<string | null> => {
        const storage = idbStorage()
        const stored = await storage.loadSession()
        if (stored && !needsRenewal(stored, Date.now())) return stored.token
        const device = await storage.loadDevice()
        if (!device) return null
        const opened = await openSession({
          fetch: pwaFetch,
          deviceId: device.deviceId,
          sign: (bytes) => signWithDeviceKey(device.privateKey, bytes),
          now: () => Date.now()
        })
        if (!opened.ok) {
          if (opened.reason === 'refused') {
            // Another tab may have renewed first: only a refusal with no fresh session behind it is a revoke.
            const other = await storage.loadSession()
            if (other && !needsRenewal(other, Date.now())) return other.token
            await wipe()
          } else setStatus((s) => (s === 'ready' ? s : 'unreachable'))
          return stored?.token ?? null
        }
        await storage.saveSession(opened.session)
        return opened.session.token
      }),
    [wipe]
  )

  useEffect(() => {
    const run = ++runId.current
    const alive = (): boolean => runId.current === run
    let visible = !document.hidden
    let aborter = new AbortController()
    const onVisibility = (): void => {
      visible = !document.hidden
      // Hiding the page aborts the long poll at once (AC-8.1); showing resumes.
      if (document.hidden) aborter.abort()
    }
    document.addEventListener('visibilitychange', onVisibility)

    void (async () => {
      const storage = idbStorage()
      const device = await storage.loadDevice()
      if (!alive()) return
      if (!device) {
        setStatus('unpaired')
        return
      }
      setDeviceId(device.deviceId)
      setStatus('ready')
      // Push needs no tap when the permission is already granted (AC-11.6): without
      // it the subscription waits, and the poll loop covers approvals meanwhile.
      if ('serviceWorker' in navigator && 'PushManager' in window && Notification.permission === 'granted') {
        void (async () => {
          try {
            const registration = await navigator.serviceWorker.ready
            const token = await ensureToken()
            if (!token || !alive()) return
            await subscribePush({
              fetch: pwaFetch,
              token,
              subscribe: async (options) => {
                const subscription = await registration.pushManager.subscribe(options)
                const p256dh = subscription.getKey('p256dh')
                const auth = subscription.getKey('auth')
                if (!p256dh || !auth) throw new Error('push keys missing')
                return { endpoint: subscription.endpoint, keys: { p256dh: b64u.encode(new Uint8Array(p256dh)), auth: b64u.encode(new Uint8Array(auth)) } }
              }
            })
          } catch {
            // Push stays off; the poll covers approvals.
          }
        })()
      }
      let since: number | null = null
      let current: PwaState | null = null
      let failures = 0
      let ponged: string | null = null
      let pollNote: PwaKey | null = null
      for (;;) {
        if (!alive()) return
        if (!visible) {
          await sleep(1000)
          continue
        }
        const token = await ensureToken()
        if (!alive()) return
        if (!token) {
          failures++
          await sleep(backoffMs(failures))
          continue
        }
        aborter = new AbortController()
        const polled = await pollOnce({ fetch: pwaFetch, token, since, signal: aborter.signal })
        if (!alive()) return
        if (!polled.ok) {
          if (polled.reason === 'refused') {
            await wipe()
            return
          }
          failures++
          pollNote = polled.reason === 'rate-limited' ? 'remote.pwa.rateLimited' : 'remote.pwa.pcUnreachable'
          setNote(pollNote)
          await sleep(backoffMs(failures))
          continue
        }
        failures = 0
        if (pollNote) {
          const mine = pollNote
          setNote((current) => clearOwnNote(current, mine))
          pollNote = null
        }
        const merged = mergeState(current, polled.state)
        since = nextSince(current, polled.state)
        current = merged
        setState(merged)
        if (polled.state.ping && polled.state.ping !== ponged) {
          ponged = polled.state.ping
          void pong({ fetch: pwaFetch, token, ping: polled.state.ping })
        }
      }
    })()
    return () => {
      runId.current++
      aborter.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [wipe, generation, ensureToken])

  const act = useCallback(
    async (call: (token: string) => Promise<ChatOutcome | AnswerOutcome>): Promise<boolean> => {
      const token = await ensureToken()
      if (!token) {
        setNote('remote.pwa.pcUnreachable')
        return false
      }
      return failOutcome(await call(token))
    },
    [failOutcome, ensureToken]
  )

  const guarded = useCallback(
    async <T extends Wipable>(call: (token: string) => Promise<T>, network: () => T): Promise<T> => {
      const token = await ensureToken()
      if (!token) return network()
      const outcome = await call(token)
      // `refused` is the older libs' word for a rejected key, `unknown-device` the newer ones': both wipe (026 AC-5.3).
      if (!outcome.ok && (outcome.reason === 'refused' || outcome.reason === 'unknown-device')) await wipe()
      return outcome
    },
    [ensureToken, wipe]
  )

  return {
    status,
    deviceId,
    state,
    note,
    clearNote: () => setNote(null),
    paired: () => {
      setStatus('loading')
      setGeneration((g) => g + 1)
    },
    send: async (text) => act((token) => sendChat({ fetch: pwaFetch, token, text })),
    answer: async (id, decision) => {
      await act((token) => answerApproval({ fetch: pwaFetch, token, id, decision }))
    },
    newConversation: async () => {
      await act((token) => newChat({ fetch: pwaFetch, token }))
    },
    stop: async () => {
      await act((token) => stopChat({ fetch: pwaFetch, token }))
    },
    things: async () =>
      guarded<ThingsOutcome>((token) => fetchThings({ fetch: pwaFetch, token }), () => ({ ok: false, reason: 'network' })),
    control: async (thing, action, assertion) =>
      guarded<ControlOutcome>((token) => controlThing({ fetch: pwaFetch, token, thing, action, assertion }), () => ({ ok: false, reason: 'network' })),
    stepUpChallenge: async (thing, action) =>
      guarded<StepUpChallengeOutcome>((token) => requestStepUp({ fetch: pwaFetch, token, thing, action }), () => ({ ok: false, reason: 'network' })),
    cameras: async () =>
      guarded<CamerasOutcome>((token) => fetchCameras({ fetch: pwaFetch, token }), () => ({ ok: false, reason: 'network' })),
    still: async (entityId) =>
      guarded<StillOutcome>((token) => fetchStill({ fetch: pwaFetch, token, entityId }), () => ({ ok: false, reason: 'network' })),
    notes: {
      list: async (folder) => guarded<FolderOutcome>((token) => listFolder({ fetch: pwaFetch, token, folder }), () => ({ ok: false, reason: 'network' })),
      find: async (query) => guarded<FindOutcome>((token) => findNotes({ fetch: pwaFetch, token, query }), () => ({ ok: false, reason: 'network' })),
      read: async (path) => guarded<ReadOutcome>((token) => readNote({ fetch: pwaFetch, token, path }), () => ({ ok: false, reason: 'network' })),
      image: async (target, from) =>
        guarded<ImageOutcome>((token) => fetchImage({ fetch: pwaFetch, token, target, from }), () => ({ ok: false, reason: 'network' }))
    },
    threads: {
      list: async (offset) => guarded<ThreadsOutcome>((token) => listThreads({ fetch: pwaFetch, token, offset }), () => ({ ok: false, reason: 'network' })),
      read: async (id, options) =>
        guarded<WindowOutcome>((token) => readThread({ fetch: pwaFetch, token, id, ...options }), () => ({ ok: false, reason: 'network' })),
      send: async (id, text) =>
        guarded<ThreadActionOutcome>((token) => sendThread({ fetch: pwaFetch, token, id, text }), () => ({ ok: false, reason: 'not-delivered' })),
      stop: async (id) => guarded<ThreadActionOutcome>((token) => stopThread({ fetch: pwaFetch, token, id }), () => ({ ok: false, reason: 'network' }))
    },
    access: async () => guarded<StatusOutcome>((token) => fetchStatus({ fetch: pwaFetch, token }), () => ({ ok: false, reason: 'network' })),
    forget: async () => {
      const storage = idbStorage()
      const stored = await storage.loadSession()
      await forgetPc({ fetch: pwaFetch, token: stored?.token ?? '', storage, caches })
      setDeviceId(null)
      setState(null)
      setStatus('unpaired')
    }
  }
}
