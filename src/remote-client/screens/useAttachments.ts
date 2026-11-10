// The composer's files (spec 031 T52): the flow of chips for one target, plus whether the PC allows files right now.
// Chips and bytes live in memory only and are dropped when the screen is left (BR-19).
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { canSendNow, type Chip } from '../../shared/attach/phone-chips'
import type { StatusView } from '../../shared/remote/wire'
import type { PwaKey } from '../i18n/es'
import { createAttachFlow } from '../lib/attach-flow'
import { shrinkInBrowser } from '../lib/canvas'
import { attachButton } from '../lib/can'
import { useLatest } from '../lib/latest'
import type { Pwa } from '../usePwa'

export interface Attachments {
  chips: Chip[]
  /** The button follows the last status read from the PC; off, it names why. */
  button: { enabled: boolean; reason: PwaKey | null }
  /** False until the PC has answered once: the reason is not shown before that, so it never flashes. */
  known: boolean
  pick(files: File[]): void
  remove(key: string): void
  retry(key: string): void
  readyIds(): string[]
  /** The send button (AC-8.3): never while a chip is preparing or uploading. */
  canSend(text: string, running: boolean): boolean
  /** The answer to a send (AC-4.3, AC-8.7): chips clear, expire or stay. */
  sent(outcome: { ok: true } | { ok: false; reason: string }): void
}

/** `target.id` is the conversation, or none for the Chat tab's thread. */
export function useAttachments(pwa: Pwa, target: { id?: string }): Attachments {
  const latest = useLatest(pwa)
  const id = target.id
  const [status, setStatus] = useState<StatusView | null>(null)

  const flow = useMemo(
    () =>
      createAttachFlow({
        put: (file, signal) => latest.current.attach.put({ id }, file, signal),
        remove: (fileId) => latest.current.attach.remove(fileId),
        shrink: (file) => shrinkInBrowser(file, Date.now())
      }),
    [id, latest]
  )
  useEffect(() => () => flow.dispose(), [flow])
  const chips = useSyncExternalStore(flow.subscribe, flow.get)

  // The next request changes the button without a reload (AC-8.4): read when the screen opens, when the app comes back to the
  // front, and when the PC says the switch is off. A failed read keeps what was last known.
  const readStatus = useCallback(async () => {
    const out = await latest.current.access()
    if (out.ok) setStatus(out.status)
  }, [latest])
  useEffect(() => {
    void readStatus()
    const onVisible = (): void => {
      if (!document.hidden) void readStatus()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [readStatus])
  const refused = chips.some((chip) => chip.reason === 'attach-off')
  useEffect(() => {
    if (refused) void readStatus()
  }, [refused, readStatus])

  return {
    chips,
    button: attachButton(status),
    known: status !== null,
    pick: flow.add,
    remove: flow.remove,
    retry: flow.retry,
    readyIds: flow.readyIds,
    canSend: (text, running) => canSendNow(chips, text, running),
    sent: (outcome) => {
      flow.sent(outcome)
      if (!outcome.ok && outcome.reason === 'attach-off') void readStatus()
    }
  }
}
