// The PC's end of the end-to-end layer (spec 027 PD-3, PD-4, PD-12): one session per phone handshake, every sealed
// request opened here and only here, then handed to the unchanged channel handler as an ordinary request.
import type { RemoteHandler, RemoteRequest, RemoteResponse } from '../../../shared/remote/api'
import { b64u, type PublicJwk } from '../../../shared/remote/crypto'
import {
  createPcHandshake,
  createReplayWindow,
  openRequest,
  type PcHandshake,
  type ReplayWindow,
  type SealedFrame,
  type SessionKeys,
  sealAnswer,
  sessionExpired
} from '../../../shared/remote/relay-e2e'
import type { RelayFrame } from '../../../shared/remote/relay-frame'
import { REMOTE_RELAY_LIMITS } from '../../../shared/remote/relay-limits'
import { shellAnnouncementMessage } from '../../../shared/remote/relay-shell'
import { type RelayPlain, relayPlainSchema, type RelayShellAnswer, type RelayWireResponse } from '../../../shared/remote/relay-wire'
import { exceedsRequestBytes } from './limits'
import { refusalResponse } from './transport'

export interface RelayHostDeps {
  /** The relay-form address `start()` returns: Host and Origin are stamped from it, never taken from the phone. */
  address: string
  handler: RemoteHandler
  identity: { publicKey: PublicJwk; sign(data: Uint8Array): Promise<Uint8Array> }
  /** Null for an unknown, revoked or idle-expired device. */
  deviceKey(deviceId: string): PublicJwk | null
  random(length: number): Uint8Array
  now(): number
  /** The official shell of this build, announced to phones inside a session; null announces none. */
  shell?(): { version: number; rootHash: string } | null
  /** A phone's third handshake message was refused (unknown, revoked or wrongly signing device). It says no more than that. */
  onHandshakeFailed?(): void
}

interface Session {
  keys: SessionKeys
  window: ReplayWindow
  device: { id: string } | 'anonymous'
  inFlight: Set<AbortController>
  tokens: Set<string>
  /** The bearers of the requests running now: the channel names the device of one while it handles it, and that is when it is carried. */
  asking: Set<{ token: string }>
}

// Handshakes begun and never finished, and live sessions, are bounded so a flood of either cannot grow memory.
const MAX_HANDSHAKES = 32
const MAX_SESSIONS = 256
// The only request headers a phone may set; Host and Origin come from the address.
const ALLOWED_HEADERS = ['authorization', 'content-type', 'accept']

const text = new TextEncoder()

export class RelayHost {
  private readonly handshakes = new Map<string, PcHandshake>()
  private readonly sessions = new Map<string, Session>()
  private readonly tokenDevice = new Map<string, string>()
  private readonly host: string
  private readonly origin: string

  constructor(private readonly deps: RelayHostDeps) {
    const url = new URL(deps.address)
    this.host = url.host.toLowerCase()
    this.origin = url.origin
  }

  /**
   * One frame from the relay. A frame that fails authentication, belongs to no session or has expired never reaches the
   * handler: the answer is `gone` and the session it named is over, so the phone handshakes again.
   */
  async handle(frame: RelayFrame, signal: AbortSignal): Promise<RelayFrame | 'gone'> {
    this.sweep()
    if (frame.t === 'hs1') return this.hs1(frame)
    if (frame.t === 'hs3') return this.hs3(frame)
    if (frame.t === 'q') return this.request(frame, signal)
    return 'gone'
  }

  /** The channel resolved a bearer token to a device: a revocation can now cut the sessions that carried it. */
  track(token: string, deviceId: string): void {
    this.tokenDevice.set(token, deviceId)
    // A request running with this bearer now makes its session carry it, so a revoke cuts even a request that is still held.
    for (const session of this.sessions.values()) for (const asking of session.asking) if (asking.token === token) session.tokens.add(token)
  }

  closeDevice(deviceId: string): void {
    for (const [sid, session] of [...this.sessions]) {
      const own = session.device !== 'anonymous' && session.device.id === deviceId
      if (own || [...session.tokens].some((token) => this.tokenDevice.get(token) === deviceId)) this.end(sid)
    }
  }

  closeAll(): void {
    for (const sid of [...this.sessions.keys()]) this.end(sid)
    this.handshakes.clear()
    this.tokenDevice.clear()
  }

  private async hs1(frame: RelayFrame): Promise<RelayFrame | 'gone'> {
    const handshake = createPcHandshake({
      identity: this.deps.identity,
      deviceKey: this.deps.deviceKey,
      random: this.deps.random,
      now: this.deps.now
    })
    const hs2 = await handshake.start(frame)
    if ('fail' in hs2 || hs2.t !== 'hs2') return 'gone'
    if (this.handshakes.size >= MAX_HANDSHAKES) this.handshakes.delete(this.handshakes.keys().next().value as string)
    this.handshakes.set(hs2.sid, handshake)
    return hs2
  }

  private async hs3(frame: RelayFrame): Promise<RelayFrame | 'gone'> {
    if (frame.t !== 'hs3') return 'gone'
    const handshake = this.handshakes.get(frame.sid)
    this.handshakes.delete(frame.sid)
    const done = await handshake?.finish(frame)
    if (!done?.outcome.ok || !done.hs4) {
      try {
        this.deps.onHandshakeFailed?.()
      } catch {
        // Reporting never changes the answer.
      }
      return 'gone'
    }
    if (this.sessions.size >= MAX_SESSIONS) this.end(this.sessions.keys().next().value as string)
    const { keys, device } = done.outcome
    this.sessions.set(keys.sid, { keys, window: createReplayWindow(), device, inFlight: new Set(), tokens: new Set(), asking: new Set() })
    return done.hs4
  }

  private async request(frame: SealedFrame, signal: AbortSignal): Promise<RelayFrame | 'gone'> {
    const session = this.sessions.get(frame.sid)
    if (!session) return 'gone'
    const plain = await openRequest(session.keys, session.window, frame)
    if (!plain) {
      this.end(frame.sid)
      return 'gone'
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    session.inFlight.add(controller)
    try {
      const wire = await this.run(session, plain, controller.signal)
      // A session ended while this was running (revoked, tampered) answers nothing.
      if (controller.signal.aborted) return 'gone'
      return await this.seal(session, frame.ctr, wire)
    } finally {
      signal.removeEventListener('abort', abort)
      session.inFlight.delete(controller)
    }
  }

  private async run(session: Session, plain: Uint8Array, signal: AbortSignal): Promise<RelayWireResponse | RelayShellAnswer> {
    let message: RelayPlain
    try {
      const parsed = relayPlainSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)))
      if (!parsed.success) return wireOf(refusalResponse('invalid'))
      message = parsed.data
    } catch {
      return wireOf(refusalResponse('invalid'))
    }
    if (message.k === 'ctl') return this.shellAnswer()
    if (message.body !== undefined && exceedsRequestBytes(JSON.stringify(message.body)?.length ?? 0)) return wireOf(refusalResponse('too-large'))
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      if (ALLOWED_HEADERS.includes(name.toLowerCase())) headers[name.toLowerCase()] = value
    }
    headers['host'] = this.host
    headers['origin'] = this.origin
    const bearer = /^Bearer (.+)$/.exec(headers['authorization'] ?? '')?.[1]
    const request: RemoteRequest = {
      method: message.method,
      path: message.path,
      query: new URLSearchParams(message.query ?? ''),
      headers,
      body: message.body,
      remoteAddress: 'relay'
    }
    const asking = { token: bearer ?? '' }
    if (bearer) session.asking.add(asking)
    try {
      return wireOf(await this.deps.handler(request, signal))
    } catch {
      return { k: 'res', status: 500, contentType: 'application/json', cache: 'no-store', json: { error: 'failed' } }
    } finally {
      session.asking.delete(asking)
      if (bearer) this.carry(session, bearer)
    }
  }

  /**
   * A session carries a token only once the channel resolved it to a device (it called `track` while the handler ran), so
   * a stranger's bogus bearers cost no memory. This is the settling after the request: a token tracked after its session ended is not kept.
   */
  private carry(session: Session, token: string): void {
    if (!this.tokenDevice.has(token)) return
    if (this.sessions.get(session.keys.sid) === session) session.tokens.add(token)
    else this.release(token)
  }

  /** Forgets a token's device unless a live session still carries it. */
  private release(token: string): void {
    for (const other of this.sessions.values()) if (other.tokens.has(token)) return
    this.tokenDevice.delete(token)
  }

  private async shellAnswer(): Promise<RelayShellAnswer> {
    const shell = this.deps.shell?.() ?? null
    if (!shell) return { k: 'shell', announcement: null }
    const sig = await this.deps.identity.sign(shellAnnouncementMessage(shell.version, shell.rootHash))
    return { k: 'shell', announcement: { ...shell, sig: b64u.encode(sig) } }
  }

  private async seal(session: Session, ctr: number, wire: RelayWireResponse | RelayShellAnswer): Promise<RelayFrame> {
    const frame = await sealAnswer(session.keys, ctr, text.encode(JSON.stringify(wire)))
    if (JSON.stringify(frame).length <= REMOTE_RELAY_LIMITS.frameBytes) return frame
    // The relay would refuse a frame this large, and the phone would wait for nothing: say it failed. The first
    // ciphertext is never sent, so sealing again with the same key and counter does not reuse a nonce on the wire.
    return sealAnswer(session.keys, ctr, text.encode(JSON.stringify(wireOf({ status: 500, body: { error: 'failed' } }))))
  }

  private end(sid: string): void {
    const session = this.sessions.get(sid)
    if (!session) return
    this.sessions.delete(sid)
    for (const controller of session.inFlight) controller.abort()
    for (const token of session.tokens) this.release(token)
  }

  private sweep(): void {
    for (const [sid, session] of this.sessions) if (sessionExpired(session.keys, this.deps.now())) this.end(sid)
  }
}

/** The channel's answer as it travels inside the sealed frame: status, the two headers that matter, JSON as JSON, bytes as base64url. */
function wireOf(response: RemoteResponse): RelayWireResponse {
  const wire: RelayWireResponse = { k: 'res', status: response.status }
  const type = response.headers?.['content-type']
  const cache = response.headers?.['cache-control']
  if (response.body instanceof Uint8Array) {
    wire.contentType = type ?? 'application/octet-stream'
    wire.bytes = b64u.encode(response.body)
  } else {
    // Only the type the channel set: the phone reads JSON as JSON and adds nothing the channel did not say.
    if (type) wire.contentType = type
    if (response.body !== undefined) wire.json = response.body
  }
  if (cache) wire.cache = cache
  return wire
}
