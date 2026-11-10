// The composer behind the chips (spec 031 T52): what happens to each picked file, one at a time, in memory only (BR-19).
// The rules are the shared ones (planPhoneFile, chipsReduce); this only orders the requests and acts on the effects.
import { planPhoneFile } from '../../shared/attach/phone'
import { chipsReduce, type Chip, type ChipEvent, type PhoneChipReason } from '../../shared/attach/phone-chips'
import { createSerial } from '../../shared/attach/serial'
import { bytesToBase64, chipsAfterSend, type PutOutcome } from './attach'

// The phone's own refusals use the names the PC would answer with, so a chip reads the same whoever refused.
const PLAN_REFUSAL = { 'too-big': 'too-large', type: 'file-type', 'too-many': 'too-many' } as const satisfies Record<string, PhoneChipReason>

export interface AttachFlowDeps {
  put(file: { name: string; size: number; base64: string }, signal: AbortSignal): Promise<PutOutcome>
  /** Best effort: the PC deletes a pending upload of this phone and answers the same whatever the id was. */
  remove(id: string): Promise<unknown>
  /** A picture over the limit, re-encoded to fit; null when it cannot be made to fit. */
  shrink(file: File): Promise<File | null>
}

export interface AttachFlow {
  /** The same array until the next change, so a view can subscribe to it. */
  get(): Chip[]
  subscribe(listener: () => void): () => void
  add(files: File[]): void
  remove(key: string): void
  /** A failed chip's file goes again, as a new chip at the end. */
  retry(key: string): void
  /** The answer to a send: accepted clears the chips, `unavailable` expires them, any other failure keeps them (AC-4.3, AC-8.7). */
  sent(outcome: { ok: true } | { ok: false; reason: string }): void
  readyIds(): string[]
  /** Leaving the screen: abort what is uploading and delete what is ready. */
  dispose(): void
}

export function createAttachFlow(deps: AttachFlowDeps): AttachFlow {
  let chips: Chip[] = []
  let counter = 0
  // The picked files wait here until they are ready (a retry needs them); the bytes themselves are never kept.
  const files = new Map<string, File>()
  const controllers = new Map<string, AbortController>()
  const listeners = new Set<() => void>()
  const serial = createSerial()
  const quiet = (): void => undefined

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const apply = (event: ChipEvent): void => {
    const out = chipsReduce(chips, event)
    chips = out.chips
    for (const effect of out.effects) {
      if (effect.type === 'abort') controllers.get(effect.key)?.abort()
      else void deps.remove(effect.id).catch(quiet)
    }
    notify()
  }
  const gone = (key: string): boolean => !chips.some((chip) => chip.key === key)

  async function upload(key: string, shrink: boolean): Promise<void> {
    const picked = files.get(key)
    if (!picked || gone(key)) return
    let payload: { name: string; size: number; base64: string }
    try {
      const source = shrink ? await deps.shrink(picked) : picked
      if (!source) {
        if (!gone(key)) apply({ type: 'failed', key, reason: 'too-large' })
        return
      }
      const bytes = new Uint8Array(await source.arrayBuffer())
      // The real byte count, not the file's claim: the PC checks them against each other.
      payload = { name: source.name, size: bytes.length, base64: bytesToBase64(bytes) }
    } catch {
      if (!gone(key)) apply({ type: 'failed', key, reason: 'unreadable' })
      return
    }
    if (gone(key)) return
    apply({ type: 'prepared', key })
    const controller = new AbortController()
    controllers.set(key, controller)
    const out = await deps.put(payload, controller.signal).catch((): PutOutcome => ({ ok: false, reason: 'network' }))
    controllers.delete(key)
    if (gone(key)) {
      // Removed while the request was in flight: if the PC stored it anyway, delete it now (expiry is the backstop).
      if (out.ok) void deps.remove(out.attachment.id).catch(quiet)
      return
    }
    if (out.ok) {
      files.delete(key)
      apply({ type: 'uploaded', key, id: out.attachment.id })
    } else {
      const reason: PhoneChipReason = out.reason === 'not-delivered' ? 'network' : out.reason
      apply({ type: 'failed', key, reason })
    }
  }

  const flow: AttachFlow = {
    get: () => chips,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    add(picked) {
      for (const file of picked) {
        const key = `chip-${++counter}`
        // A failed chip frees its slot, so the count is of the chips that hold or will hold a pending upload.
        const held = chips.filter((chip) => chip.state !== 'failed').length
        const plan = planPhoneFile(file, held)
        apply({ type: 'added', key, name: file.name })
        if (plan.action === 'refuse') {
          apply({ type: 'failed', key, reason: PLAN_REFUSAL[plan.reason] })
          continue
        }
        files.set(key, file)
        void serial(() => upload(key, plan.action === 'shrink'))
      }
    },
    remove(key) {
      files.delete(key)
      apply({ type: 'remove', key })
    },
    retry(key) {
      const file = files.get(key)
      if (!file || chips.find((chip) => chip.key === key)?.state !== 'failed') return
      flow.remove(key)
      flow.add([file])
    },
    sent(outcome) {
      chips = chipsAfterSend(chips, outcome)
      if (outcome.ok) files.clear()
      notify()
    },
    readyIds: () => chips.flatMap((chip) => (chip.state === 'ready' && chip.id ? [chip.id] : [])),
    dispose() {
      for (const chip of [...chips]) flow.remove(chip.key)
    }
  }
  return flow
}
