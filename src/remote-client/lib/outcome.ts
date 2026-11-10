import type { PhoneChipReason } from '../../shared/attach/phone-chips'
import type { Refusal } from '../../shared/remote/api'
import type { PwaKey } from '../i18n/es'

/** What the phone can ask for; each failure reads differently per operation (a 413 is a note, a picture or a message). */
export type Operation =
  | 'notes.list'
  | 'notes.find'
  | 'notes.read'
  | 'notes.image'
  | 'threads.list'
  | 'threads.read'
  | 'threads.send'
  | 'threads.stop'
  | 'chat'
  | 'home'
  | 'cameras'
  | 'status'
  | 'attach'

/** `network` is the PC not answering (or answering nonsense); `not-delivered` is a send the PC did not take. */
export type Failure = Refusal | 'network' | 'not-delivered'

export const OPERATIONS: readonly Operation[] = [
  'notes.list', 'notes.find', 'notes.read', 'notes.image', 'threads.list', 'threads.read', 'threads.send', 'threads.stop', 'chat', 'home', 'cameras', 'status', 'attach'
]

// An exhaustive Record: a new Refusal without a text is a type error here (AC-6.3).
const BASE: Record<Failure, PwaKey> = {
  'unknown-device': 'remote.pwa.revoked',
  'scope-off': 'remote.pwa.scopeOff',
  'sensitive-off': 'remote.pwa.sensitiveOff',
  'step-up-required': 'remote.pwa.stepUp.failed',
  'camera-not-allowed': 'remote.pwa.cameraOff',
  'rate-limited': 'remote.pwa.rateLimited',
  invalid: 'remote.pwa.error.invalid',
  'too-large': 'remote.pwa.error.invalid',
  'unknown-route': 'remote.pwa.error.invalid',
  'already-answered': 'remote.pwa.alreadyAnswered',
  locked: 'remote.pwa.rateLimited',
  expired: 'remote.pwa.pairing.expired',
  busy: 'remote.pwa.thread.busy',
  limit: 'remote.pwa.pairing.rejected',
  'write-off': 'remote.pwa.writeOff',
  unavailable: 'remote.pwa.error.invalid',
  gone: 'remote.pwa.error.invalid',
  unsupported: 'remote.pwa.error.invalid',
  'run-active': 'remote.pwa.run.active',
  'attach-off': 'remote.pwa.attach.off',
  'notice-needed': 'remote.pwa.attach.noticeNeeded',
  'too-many': 'remote.pwa.attach.tooMany',
  'secret-name': 'remote.pwa.attach.secret',
  'file-type': 'remote.pwa.attach.type',
  'file-content': 'remote.pwa.attach.content',
  'file-empty': 'remote.pwa.attach.empty',
  'file-malformed': 'remote.pwa.attach.malformed',
  storage: 'remote.pwa.attach.storage',
  network: 'remote.pwa.pcUnreachable',
  'not-delivered': 'remote.pwa.notDelivered'
}

export const FAILURES = Object.keys(BASE) as Failure[]

const NOTES = ['notes.list', 'notes.find', 'notes.read', 'notes.image'] as const
const THREADS = ['threads.list', 'threads.read', 'threads.send', 'threads.stop'] as const
const forAll = (operations: readonly Operation[], key: PwaKey): Partial<Record<Operation, PwaKey>> =>
  Object.fromEntries(operations.map((operation) => [operation, key]))

// Where the same failure reads differently by what was asked.
const BY_OPERATION: { [reason in Failure]?: Partial<Record<Operation, PwaKey>> } = {
  'too-large': {
    'notes.read': 'remote.pwa.noteTooBig',
    'notes.image': 'remote.pwa.photoTooBig',
    cameras: 'remote.pwa.photoTooBig',
    chat: 'remote.pwa.tooLong',
    'threads.send': 'remote.pwa.tooLong',
    attach: 'remote.pwa.attach.tooBig'
  },
  // On a send, `unavailable` is a file id the PC no longer holds (031 AC-4.2): the chip is told to be attached again.
  unavailable: { ...forAll(NOTES, 'remote.pwa.note.unavailable'), ...forAll(['attach', 'chat', 'threads.send'], 'remote.pwa.attach.expired') },
  gone: { ...forAll(THREADS, 'remote.pwa.thread.gone'), 'notes.read': 'remote.pwa.note.gone', attach: 'remote.pwa.thread.gone' },
  unsupported: forAll(NOTES, 'remote.pwa.file.unsupported'),
  busy: { chat: 'remote.pwa.notDelivered', attach: 'remote.pwa.attach.busy' }
}

/** The one dictionary key a failed operation shows (AC-6.3); every outcome has a concrete text, never a generic error. */
export function outcomeKey(reason: Failure, operation: Operation): PwaKey {
  return BY_OPERATION[reason]?.[operation] ?? BASE[reason]
}

/** The loose line a failed side action shows; none for a send refused as `unavailable`, where the chips already say which file expired (031 AC-8.7). */
export function noteKeyFor(reason: Failure, operation: Operation): PwaKey | null {
  return reason === 'unavailable' && operation === 'threads.send' ? null : outcomeKey(reason, operation)
}

/**
 * Retry is offered only where trying again can help (AC-6.6): the PC not answering. Not for a switch that is off, a revoked
 * phone, something too big or a rate limit (which names the wait); a failed load reaches the screen as `network`.
 */
export function retryOffered(reason: Failure): boolean {
  return reason === 'network'
}

/** The one dictionary key a chip shows for its reason (031 AC-8.5); the text names the file with `{name}`. `unreadable` is the only reason the PC never sends. */
export function attachOutcomeKey(reason: PhoneChipReason): PwaKey {
  return reason === 'unreadable' ? 'remote.pwa.attach.failed' : outcomeKey(reason, 'attach')
}

/** Retry on a chip (031 AC-8.5): the PC not answering or an upload that failed; never for a type, size, secret name, switch off or notice. */
export function attachRetryOffered(reason: PhoneChipReason): boolean {
  return reason === 'network' || reason === 'unreadable'
}
