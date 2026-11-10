import { idbStorage } from './idb'
import type { PwaKey } from './i18n'
import type { FetchLike } from './lib/session'
import { createRelayClient, type LinkOutcome, type RelayClient } from './relay/client'
import { checkShell, type ShellCheck } from './relay/shell'

/** The one place the page touches the network (AC-2.8): relative URLs against the origin that served this page, never a host. */
const direct: FetchLike = (url, init) => fetch(url, init)

type Link = RelayClient | null

let asked: Promise<Link> | null = null
let known: Link | undefined

/**
 * Which kind of address served this page, asked once: a relay answers `/relay/v1/info`, a PC reached directly does not.
 * The answer picks how every later request travels; nothing above this file knows (BR-9).
 */
function link(): Promise<Link> {
  asked ??= (async () => {
    const response = await direct('/relay/v1/info')
    const info: unknown = response.ok ? await response.json().catch(() => null) : null
    const relay = typeof info === 'object' && info !== null && (info as { relay?: unknown }).relay === true
    known = relay ? createRelayClient({ rawFetch: direct, storage: idbStorage(), random: (length) => crypto.getRandomValues(new Uint8Array(length)), now: Date.now }) : null
    return known
  })().catch((error: unknown) => {
    // Not answering says nothing about the kind of address: ask again next time.
    asked = null
    throw error
  })
  return asked
}

/** The phone's fetch: the PC directly, or sealed through the relay, whichever served this page. */
export const pwaFetch: FetchLike = async (url, init) => {
  const relay = await link()
  return relay ? relay.fetch(url, init) : direct(url, init)
}

const LINK_KEYS = {
  version: 'remote.pwa.relay.version',
  mismatch: 'remote.pwa.relay.mismatch',
  'pair-again': 'remote.pwa.relay.pairAgain',
  unreachable: 'remote.pwa.pcUnreachable',
  down: 'remote.pwa.relay.unreachable',
  full: 'remote.pwa.rateLimited',
  refused: 'remote.pwa.pcUnreachable'
} as const satisfies Record<Exclude<LinkOutcome, { ok: true }>['reason'], PwaKey>

/**
 * Before pairing sends anything: makes sure this is the PC the QR named. Over a direct address the existing hello check
 * does that later and this answers ok at once; over the relay it is the secure handshake against the QR's fingerprint.
 */
export async function connectToPc(fingerprint: string): Promise<{ ok: true } | { ok: false; key: PwaKey }> {
  let relay: Link
  try {
    relay = await link()
  } catch {
    return { ok: false, key: 'remote.pwa.pcUnreachable' }
  }
  if (!relay) return { ok: true }
  const outcome = await relay.connect(fingerprint)
  return outcome.ok ? { ok: true } : { ok: false, key: LINK_KEYS[outcome.reason] }
}

/** What to tell a person who opens the app with no pairing and no code: after a relay address, that this phone must pair again here. */
export async function missingCodeKey(): Promise<PwaKey> {
  try {
    return (await link()) ? 'remote.pwa.relay.pairAgain' : 'remote.pwa.pairing.rescan'
  } catch {
    return 'remote.pwa.pairing.rescan'
  }
}

/** A reason the link is down that the person can act on (update the app, the PC is not the one paired), or null. */
export function linkProblemKey(): PwaKey | null {
  const problem = known?.problem()
  return problem ? LINK_KEYS[problem] : null
}

/** The running shell's version, and over the relay whether the PC announced it. */
export async function checkAppShell(): Promise<ShellCheck> {
  let relay: Link = null
  try {
    relay = await link()
  } catch {
    // Offline: the version is still readable from the cached shell.
  }
  return checkShell({ rawFetch: direct, storage: idbStorage(), client: relay })
}
