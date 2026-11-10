// An in-memory relay built on the real RelayRoom (spec 027 T13). It has a recording tap and an adversary switch,
// and a fake WebSocket constructor so the PC transport can run against it unchanged.
import { answerFor } from '../../src/relay/answer'
import { type PcSocket, RelayRoom, type RoomDeps } from '../../src/relay/room'
import { b64u, type PublicJwk, signEs256 } from '../../src/shared/remote/crypto'
import { createPcHandshake, createReplayWindow, openRequest, type PcHandshake, sealAnswer, type SessionKeys } from '../../src/shared/remote/relay-e2e'
import { registrationMessage, type RelayFrame, type RelayToPc } from '../../src/shared/remote/relay-frame'

export const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

export interface KeyPair {
  publicKey: PublicJwk
  /** For tests that play an adversary who has stolen the key. */
  privateJwk: PublicJwk
  sign(data: Uint8Array): Promise<Uint8Array>
}

export async function keyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as unknown as PublicJwk
  return { publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, privateJwk, sign: (data) => signEs256(privateJwk, data) }
}

/** A socket the room can talk to, for tests that drive the room directly. */
export class FakePc implements PcSocket {
  sent: string[] = []
  closed: number | null = null
  send(message: string): void {
    this.sent.push(message)
  }
  close(code: number): void {
    this.closed = code
  }
  messages(): RelayToPc[] {
    return this.sent.map((message) => JSON.parse(message) as RelayToPc)
  }
}

/** A clock-free scheduler: timers fire only when the test says so. */
export function manualTimers() {
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  return {
    timers,
    schedule(fn: () => void, ms: number): () => void {
      const timer = { fn, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    fire(): void {
      for (const timer of [...timers]) {
        if (timer.cancelled) continue
        timer.cancelled = true
        timer.fn()
      }
    },
    /** Fires the live timers that were set for exactly `ms`, oldest first. */
    fireMs(ms: number): void {
      for (const timer of [...timers]) {
        if (timer.cancelled || timer.ms !== ms) continue
        timer.cancelled = true
        timer.fn()
      }
    },
    live: () => timers.filter((timer) => !timer.cancelled).length
  }
}

/** The four places a byte can be seen or changed on its way between the two ends. */
export type Hop = 'phoneToRelay' | 'relayToPc' | 'pcToRelay' | 'relayToPhone'

/** Everything the relay forwarded, in order, as text. */
export class Tap {
  records: Array<{ hop: Hop; text: string }> = []

  record(hop: Hop, text: string): void {
    this.records.push({ hop, text })
  }

  of(hop: Hop): string[] {
    return this.records.filter((record) => record.hop === hop).map((record) => record.text)
  }

  bytes(): number {
    return this.records.reduce((sum, record) => sum + new TextEncoder().encode(record.text).length, 0)
  }

  /** The markers that appear in any recorded byte: as written, as base64 at any alignment, as base64url, or as hex. Markers should be at least 8 characters. */
  leaks(markers: string[]): string[] {
    return mentions(this.records.map((record) => record.text).join('\n'), markers)
  }
}

/** The markers found in `text`: as written, as base64 at any alignment, as base64url, or as hex. */
export function mentions(text: string, markers: string[]): string[] {
  return markers.filter((marker) => needles(marker).some((needle) => text.includes(needle)))
}

function needles(marker: string): string[] {
  const bytes = new TextEncoder().encode(marker)
  const found = [marker, [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')]
  for (const skip of [0, 1, 2]) {
    const padded = new Uint8Array(skip + bytes.length)
    padded.set(bytes, skip)
    const standard = btoa(String.fromCharCode(...padded)).replaceAll('=', '')
    // Drop the characters the leading padding bytes touch and the last group, which depend on neighbours.
    const inner = standard.slice([0, 2, 3][skip], -4)
    found.push(inner, inner.replaceAll('+', '-').replaceAll('/', '_'))
  }
  return found.filter((needle) => needle.length >= 6)
}

export interface FakeWebSocket {
  readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void
}
export type FakeWebSocketCtor = new (url: string) => FakeWebSocket

export interface FakeRelayOptions {
  routingId?: string
  domain?: string
  deps?: Partial<RoomDeps>
}

export class FakeRelay {
  readonly routingId: string
  readonly host: string
  readonly origin: string
  readonly room: RelayRoom
  readonly tap = new Tap()
  readonly timers = manualTimers()
  /** The adversary switch: a function per hop that may return changed text, or null to drop the frame. */
  readonly tamper: Partial<Record<Hop, (text: string) => string | null>> = {}
  /** Every URL a PC opened a WebSocket to. */
  readonly urls: string[] = []
  readonly webSocket: FakeWebSocketCtor
  pcAddress = '198.51.100.10'
  /** New PC connections fail before opening (the relay is unreachable). */
  refuseConnections = false
  /** The relay stops answering the PC's `ping` (a silent socket). */
  muteKeepalive = false
  private readonly busy = new Set<Promise<unknown>>()
  private pcEnd: { ws: FakeWebSocketImpl; socket: PcSocket } | null = null

  constructor(options: FakeRelayOptions = {}) {
    this.routingId = options.routingId ?? 'fake-routing-id'
    this.host = `${this.routingId}.${options.domain ?? 'relay.test'}`
    this.origin = `https://${this.host}`
    this.room = new RelayRoom({ routingId: this.routingId, random, schedule: this.timers.schedule, ...options.deps })
    const relay = this
    this.webSocket = class extends FakeWebSocketImpl {
      constructor(url: string) {
        super(relay, url)
      }
    }
  }

  /** The phone's HTTPS request: the body goes through the room and the relay's answer comes back as text. */
  async phoneFetch(body: string, init: { address?: string; signal?: AbortSignal } = {}): Promise<{ status: number; body: string }> {
    const inbound = this.through('phoneToRelay', body)
    if (inbound === null) throw new Error('network: request dropped')
    let raw: unknown = inbound
    try {
      raw = JSON.parse(inbound)
    } catch {
      // Not JSON: the room answers malformed.
    }
    const answer = answerFor(await this.room.forward(raw, { address: init.address ?? '203.0.113.50', bytes: inbound.length, signal: init.signal }))
    const outbound = this.through('relayToPhone', answer.body)
    if (outbound === null) throw new Error('network: response dropped')
    return { status: answer.status, body: outbound }
  }

  /** The adversary sends the last frame seen on a hop again, without going through the tamper switch. */
  async replay(hop: Exclude<Hop, 'relayToPhone'>): Promise<{ status: number; body: string } | undefined> {
    const last = this.tap.of(hop).at(-1)
    if (last === undefined) throw new Error(`nothing recorded on ${hop}`)
    const saved = this.tamper[hop]
    delete this.tamper[hop]
    try {
      if (hop === 'phoneToRelay') return await this.phoneFetch(last)
      if (hop === 'relayToPc') this.pcEnd?.ws.deliver(this.through(hop, last) ?? '')
      else if (this.pcEnd) this.track(this.room.onPcMessage(this.pcEnd.socket, this.through(hop, last) ?? ''))
      await this.idle()
    } finally {
      if (saved) this.tamper[hop] = saved
    }
  }

  /** Waits for everything the PC side has in flight (registration checks, deliveries). */
  async idle(): Promise<void> {
    while (this.busy.size) await Promise.allSettled([...this.busy])
  }

  // Internal, used by the fake WebSocket.
  through(hop: Hop, text: string): string | null {
    const changed = this.tamper[hop] ? this.tamper[hop](text) : text
    if (changed !== null) this.tap.record(hop, changed)
    return changed
  }

  track(promise: Promise<unknown>): void {
    this.busy.add(promise)
    const done = (): void => void this.busy.delete(promise)
    void promise.then(done, done)
  }

  /** Text arriving at the PC straight from the network, as a hostile or confused relay could send it. */
  injectToPc(text: string): void {
    this.pcEnd?.ws.deliver(text)
  }

  /** The relay ends the PC's connection with a code (1006 for a dropped network). */
  closeFromRelay(code = 1006): void {
    if (!this.pcEnd) return
    const { ws, socket } = this.pcEnd
    this.room.onPcClose(socket)
    ws.closedByRelay(code, '')
  }

  attach(ws: FakeWebSocketImpl, url: string): void {
    this.urls.push(url)
    if (this.refuseConnections) {
      this.track(Promise.resolve().then(() => ws.failed()))
      return
    }
    const socket: PcSocket = {
      send: (message) => {
        const out = this.through('relayToPc', message)
        if (out !== null) this.track(Promise.resolve().then(() => ws.deliver(out)))
      },
      close: (code, reason) => ws.closedByRelay(code, reason ?? '')
    }
    this.pcEnd = { ws, socket }
    // Open first, so the challenge the room sends next finds an open socket.
    this.track(Promise.resolve().then(() => ws.opened()))
    this.track(this.room.acceptPc(socket, this.pcAddress))
  }

  fromPc(ws: FakeWebSocketImpl, text: string): void {
    const out = this.through('pcToRelay', text)
    // The platform answers the keepalive itself, without waking the room.
    if (out === 'ping') {
      if (!this.muteKeepalive) this.track(Promise.resolve().then(() => ws.deliver('pong')))
      return
    }
    if (out !== null && this.pcEnd?.ws === ws) this.track(this.room.onPcMessage(this.pcEnd.socket, out))
  }

  pcClosed(ws: FakeWebSocketImpl): void {
    if (this.pcEnd?.ws === ws) this.room.onPcClose(this.pcEnd.socket)
  }
}

class FakeWebSocketImpl implements FakeWebSocket {
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  private readonly listeners = new Map<string, Array<(event: never) => void>>()

  constructor(
    private readonly relay: FakeRelay,
    url: string
  ) {
    relay.attach(this, url)
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.relay.fromPc(this, data)
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.relay.pcClosed(this)
    this.emit('close', { code, reason })
  }

  opened(): void {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.emit('open', {})
  }

  deliver(data: string): void {
    if (this.readyState === 1) this.emit('message', { data })
  }

  failed(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('error', {})
    this.emit('close', { code: 1006, reason: '' })
  }

  closedByRelay(code: number, reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code, reason })
  }

  private emit(type: 'open' | 'message' | 'close' | 'error', event: unknown): void {
    const handler = { open: this.onopen, message: this.onmessage, close: this.onclose, error: this.onerror }[type] as ((event: unknown) => void) | null
    handler?.(event)
    for (const listener of this.listeners.get(type) ?? []) (listener as (event: unknown) => void)(event)
  }
}

export interface EchoPc {
  /** The plaintext requests the PC accepted, in order. */
  received: string[]
  /** Frames that failed authentication (each ends its session). */
  rejected: number
  ready: Promise<void>
  close(): void
}

/** A stand-in PC: registers with the relay, runs the real PC handshake, and answers each request with its text upper-cased. */
export function startEchoPc(relay: FakeRelay, options: { identity: KeyPair; devices?: Map<string, PublicJwk>; now?: () => number }): EchoPc {
  const ws = new relay.webSocket(`wss://${relay.host}/relay/v1/pc`)
  const handshakes = new Map<string, PcHandshake>()
  const sessions = new Map<string, { keys: SessionKeys; window: ReturnType<typeof createReplayWindow> }>()
  const echo: EchoPc = { received: [], rejected: 0, ready: Promise.resolve(), close: () => ws.close() }
  let markReady: () => void = () => {}
  echo.ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const reply = (rid: string, frame: RelayFrame): void => ws.send(JSON.stringify({ k: 'r', rid, frame }))
  const refuse = (rid: string): void => ws.send(JSON.stringify({ k: 'x', rid, refusal: 'gone' }))
  const handle = async (rid: string, frame: RelayFrame): Promise<void> => {
    if (frame.t === 'hs1') {
      const handshake = createPcHandshake({
        identity: { publicKey: options.identity.publicKey, sign: options.identity.sign },
        deviceKey: (id) => options.devices?.get(id) ?? null,
        random,
        now: options.now ?? Date.now
      })
      const hs2 = await handshake.start(frame)
      if ('fail' in hs2 || hs2.t !== 'hs2') return refuse(rid)
      handshakes.set(hs2.sid, handshake)
      return reply(rid, hs2)
    }
    if (frame.t === 'hs3') {
      const handshake = handshakes.get(frame.sid)
      handshakes.delete(frame.sid)
      const done = await handshake?.finish(frame)
      if (!done?.outcome.ok || !done.hs4) return refuse(rid)
      sessions.set(frame.sid, { keys: done.outcome.keys, window: createReplayWindow() })
      return reply(rid, done.hs4)
    }
    if (frame.t !== 'q') return refuse(rid)
    const session = sessions.get(frame.sid)
    const plain = session ? await openRequest(session.keys, session.window, frame) : null
    if (!session || !plain) {
      echo.rejected++
      sessions.delete(frame.sid)
      return refuse(rid)
    }
    const text = new TextDecoder().decode(plain)
    echo.received.push(text)
    reply(rid, await sealAnswer(session.keys, frame.ctr, new TextEncoder().encode(text.toUpperCase())))
  }
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data) as RelayToPc
    if (message.k === 'challenge') {
      void options.identity.sign(registrationMessage(relay.routingId, b64u.decode(message.nonce))).then((sig) => ws.send(JSON.stringify({ k: 'reg', pub: options.identity.publicKey, sig: b64u.encode(sig) })))
    } else if (message.k === 'ready') markReady()
    else if (message.k === 'f') relay.track(handle(message.rid, message.frame))
  }
  return echo
}
