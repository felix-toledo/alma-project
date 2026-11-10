// The phone's end of the relay (spec 027 PD-14): a FetchLike that seals each request into a frame, posts it as an ordinary
// HTTPS request and opens the answer, so no screen and no lib module changes. Wired at one seam, in http.ts.
import type { PublicJwk } from '../../shared/remote/crypto'
import { createPhoneHandshake, openAnswer, SESSION_LIFETIME_MS, type SessionKeys, sealRequest } from '../../shared/remote/relay-e2e'
import { type RelayFrame, relayFrameSchema } from '../../shared/remote/relay-frame'
import type { ShellAnnouncement } from '../../shared/remote/relay-shell'
import { type RelayWireResponse, relayResponseSchema, relayShellAnswerSchema } from '../../shared/remote/relay-wire'
import { signWithDeviceKey } from '../lib/keys'
import { type FetchLike, type FetchResponse, RENEW_BEFORE_MS } from '../lib/session'
import type { PwaStorage } from '../lib/storage'

export type LinkProblem = 'version' | 'mismatch' | 'pair-again'
// `down` is the relay itself not answering; `unreachable` is the relay answering that the PC is not there.
export type LinkOutcome = { ok: true } | { ok: false; reason: LinkProblem | 'down' | 'unreachable' | 'full' | 'refused' }

/** What a caller of the fetch can do nothing about except tell the person: the app needs an update, or this is not the PC. */
export class RelayClientError extends Error {
  constructor(readonly kind: LinkProblem) {
    super(kind)
    this.name = 'RelayClientError'
  }
}

export interface RelayClientDeps {
  /** The one door to the network, given by http.ts. */
  rawFetch: FetchLike
  storage: PwaStorage
  random(length: number): Uint8Array
  now(): number
}

export interface RelayClient {
  fetch: FetchLike
  /** Opens (or reuses) the secure session. While pairing, `fingerprint` is the PC's, read from the QR. */
  connect(fingerprint?: string): Promise<LinkOutcome>
  /** The PC's signed announcement of its shell, asked inside the session. `unavailable` when it could not be asked. */
  announcement(): Promise<ShellAnnouncement | null | 'unavailable'>
  /** The last thing that stopped the link for a reason the person must act on; cleared by the next success. */
  problem(): LinkProblem | null
}

const FRAME_PATH = '/relay/v1/frame'
const SENT_HEADERS = ['authorization', 'content-type', 'accept']
// Requests that change nothing, so asking again after a lost session cannot do anything twice.
const READS = [/^\/api\/session(\/challenge)?$/, /^\/api\/notes\//, /^\/api\/threads\/(list|read)$/, /^\/api\/stepup\/challenge$/]

const text = new TextEncoder()

function repeatable(method: string, path: string): boolean {
  return method === 'GET' || READS.some((pattern) => pattern.test(path))
}

function responseOf(wire: RelayWireResponse): FetchResponse {
  return { ok: wire.status >= 200 && wire.status < 300, status: wire.status, json: async () => wire.json ?? null }
}

const synthetic = (status: number, error: string): FetchResponse => ({ ok: false, status, json: async () => ({ error }) })

export function createRelayClient(deps: RelayClientDeps): RelayClient {
  let keys: SessionKeys | null = null
  // When to renew, on this phone's own clock: the PC's absolute expiry is on another clock and could be off by minutes.
  let renewAt = 0
  let counter = 0
  let expected: string | undefined
  let linking: Promise<LinkOutcome> | null = null
  let problem: LinkProblem | null = null

  const post = async (frame: RelayFrame, signal?: AbortSignal): Promise<{ status: number; body: unknown }> => {
    const response = await deps.rawFetch(FRAME_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame), signal })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  const refusal = (status: number): LinkOutcome => {
    if (status === 426) return { ok: false, reason: 'version' }
    if (status === 429) return { ok: false, reason: 'full' }
    return { ok: false, reason: 'unreachable' }
  }

  async function handshake(): Promise<LinkOutcome> {
    const device = await deps.storage.loadDevice()
    const stored = await deps.storage.loadPcKey()
    // The QR in hand decides while pairing; otherwise the key the phone learned then.
    const expect: { pcKey?: PublicJwk; fingerprint?: string } | null = expected ? { fingerprint: expected } : stored ? { pcKey: stored } : null
    if (!expect) return { ok: false, reason: 'pair-again' }
    const shake = createPhoneHandshake({
      device: device ? { id: device.deviceId, sign: (bytes) => signWithDeviceKey(device.privateKey, bytes) } : null,
      random: deps.random
    })
    let first: { status: number; body: unknown }
    try {
      first = await post(await shake.hs1())
    } catch {
      return { ok: false, reason: 'down' }
    }
    if (first.status !== 200) return refusal(first.status)
    const hs3 = await shake.onHs2(first.body, expect)
    if ('fail' in hs3) return { ok: false, reason: hs3.fail === 'version' ? 'version' : hs3.fail === 'malformed' ? 'unreachable' : 'mismatch' }
    let second: { status: number; body: unknown }
    try {
      second = await post(hs3)
    } catch {
      return { ok: false, reason: 'down' }
    }
    // The PC refuses a device it does not know (revoked, expired, wiped) the same way whatever the reason.
    if (second.status === 410) return { ok: false, reason: 'refused' }
    if (second.status !== 200) return refusal(second.status)
    const opened = await shake.onHs4(second.body)
    if (!opened) return { ok: false, reason: 'unreachable' }
    keys = opened
    counter = 0
    renewAt = deps.now() + SESSION_LIFETIME_MS - RENEW_BEFORE_MS
    if (expected) {
      const answered = relayFrameSchema.safeParse(first.body)
      if (answered.success && answered.data.t === 'hs2') await deps.storage.savePcKey(answered.data.pc)
    }
    return { ok: true }
  }

  const needsLink = (): boolean => keys === null || deps.now() >= renewAt

  async function link(fingerprint?: string): Promise<LinkOutcome> {
    if (fingerprint !== undefined) {
      expected = fingerprint
      keys = null
    }
    if (!needsLink()) return { ok: true }
    // Callers that arrive while a handshake runs share its result: one handshake, not one per request.
    linking ??= handshake()
      .catch((): LinkOutcome => ({ ok: false, reason: 'unreachable' }))
      .finally(() => {
        linking = null
      })
    const outcome = await linking
    if (outcome.ok) problem = null
    else if (outcome.reason === 'version' || outcome.reason === 'mismatch' || outcome.reason === 'pair-again') problem = outcome.reason
    return outcome
  }

  /** Seals one plaintext under the current session; null when the session is gone or the answer did not open. */
  async function exchange(plain: string, signal?: AbortSignal): Promise<{ status: number; plain?: unknown }> {
    const current = keys
    if (!current) return { status: 410 }
    const ctr = counter++
    const sent = await post(await sealRequest(current, ctr, text.encode(plain)), signal)
    if (sent.status !== 200) return { status: sent.status }
    const frame = relayFrameSchema.safeParse(sent.body)
    const opened = frame.success ? await openAnswer(current, ctr, frame.data) : null
    if (!opened) {
      if (keys === current) keys = null
      throw new TypeError('the answer did not verify')
    }
    return { status: 200, plain: JSON.parse(new TextDecoder().decode(opened)) }
  }

  const relayFetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const [path, query] = splitUrl(url)
    const plain = JSON.stringify({
      k: 'req',
      method,
      path,
      ...(query ? { query } : {}),
      headers: pickHeaders(init?.headers),
      ...(init?.body === undefined ? {} : { body: bodyOf(init.body) })
    })
    for (let attempt = 0; ; attempt++) {
      const linked = await link()
      if (!linked.ok) {
        if (linked.reason === 'refused') return synthetic(401, 'unknown-device')
        if (linked.reason === 'full') return synthetic(429, 'rate-limited')
        if (linked.reason === 'unreachable' || linked.reason === 'down') throw new TypeError('the PC cannot be reached')
        throw new RelayClientError(linked.reason)
      }
      const answered = await exchange(plain, init?.signal)
      if (answered.status === 200) return responseOf(relayResponseSchema.parse(answered.plain))
      if (answered.status === 426) {
        problem = 'version'
        throw new RelayClientError('version')
      }
      if (answered.status === 429) return synthetic(429, 'rate-limited')
      if (answered.status === 410) {
        // The PC does not know the session: renew it by itself, and ask again only when asking twice is harmless.
        keys = null
        if (attempt === 0 && repeatable(method, path)) continue
      }
      throw new TypeError('the PC did not answer')
    }
  }

  return {
    fetch: relayFetch,
    connect: (fingerprint) => link(fingerprint),
    announcement: async () => {
      try {
        if (!(await link()).ok) return 'unavailable'
        const answered = await exchange(JSON.stringify({ k: 'ctl', op: 'shell' }))
        if (answered.status !== 200) return 'unavailable'
        const shell = relayShellAnswerSchema.safeParse(answered.plain)
        return shell.success ? shell.data.announcement : 'unavailable'
      } catch {
        return 'unavailable'
      }
    },
    problem: () => problem
  }
}

function splitUrl(url: string): [string, string] {
  const at = url.indexOf('?')
  return at === -1 ? [url, ''] : [url.slice(0, at), url.slice(at + 1)]
}

function pickHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) if (SENT_HEADERS.includes(name.toLowerCase())) picked[name.toLowerCase()] = value
  return picked
}

/** JSON as the object the channel reads, anything else as the text it is: the same reading the PC's own listener does. */
function bodyOf(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}
