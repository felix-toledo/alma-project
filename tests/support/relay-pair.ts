// The 026 test transport, run over the relay pair (spec 027 T17): requests go through a phone-side end-to-end client,
// the fake relay and the real RelayTransport, and arrive at the unchanged channel handler. Everything LocalTestTransport
// records (starts, stops, closed devices, tracked tokens) is still recorded, so the 026 suites read it as before.
import { RelayTransport } from '../../src/coordinator/channels/remote/relay-transport'
import type { WebSocketCtor } from '../../src/coordinator/channels/remote/relay-connection'
import type { RemoteHandler, RemoteResponse } from '../../src/shared/remote/api'
import { b64u } from '../../src/shared/remote/crypto'
import { relayResponseSchema } from '../../src/shared/remote/relay-wire'
import { FakeRelay, keyPair, random } from './relay-fake'
import { FakePhone } from './relay-phone'
import { LocalTestTransport } from './remote-local-transport'

// Captured now: a suite that installs fake timers must not stall the waits below.
const realImmediate = globalThis.setImmediate

const yieldToIo = (): Promise<void> => new Promise((resolve) => realImmediate(resolve))

export class RelayPairTransport extends LocalTestTransport {
  readonly relay = new FakeRelay({ routingId: 'test', domain: 'invalid' })
  private real: RelayTransport | null = null
  /** The PC's identity for this run, so a test can play the part of a phone that knows it. */
  identity: Awaited<ReturnType<typeof keyPair>> | null = null
  /** How many phone requests reached the channel handler. */
  handlerCalls = 0
  private phone: FakePhone | null = null
  // Requests reach the handler in the order they were made: the in-process transport did, and the 026 suites rely on it
  // (a held poll must be held before the event that wakes it). The next request leaves when the last one has arrived.
  private gate: Promise<void> = Promise.resolve()
  private arrived: (() => void) | null = null

  override async start(handler: RemoteHandler): Promise<{ address: string }> {
    if (this.startError) throw this.startError
    const identity = await keyPair()
    this.identity = identity
    const real = new RelayTransport({
      routingId: this.relay.routingId,
      relayDomain: 'invalid',
      identity,
      // The phone side is one anonymous end-to-end session: who the person is stays the channel's business.
      deviceKey: () => null,
      webSocket: this.relay.webSocket as unknown as WebSocketCtor,
      random,
      now: () => Date.now(),
      schedule: (fn, ms) => this.relay.timers.schedule(fn, ms),
      jitter: () => 0.5,
      onState: () => {}
    })
    const started = await real.start((request, signal) => {
      const arrived = this.arrived
      this.arrived = null
      this.handlerCalls++
      arrived?.()
      return handler(request, signal)
    })
    this.real = real
    this.phone = new FakePhone(this.relay, { device: null, expect: { pcKey: identity.publicKey } })
    this.handler = handler
    this.startedCount++
    return started
  }

  override async stop(): Promise<void> {
    await super.stop()
    await this.real?.stop()
    this.real = null
    this.phone = null
  }

  /** A phone of its own on the same relay, anonymous, that already knows the PC's key. */
  newPhone(): FakePhone {
    if (!this.identity) throw new Error('transport not started')
    return new FakePhone(this.relay, { device: null, expect: { pcKey: this.identity.publicKey } })
  }

  override closeDevice(deviceId: string): void {
    super.closeDevice(deviceId)
    this.real?.closeDevice(deviceId)
  }

  override track(token: string, deviceId: string): void {
    super.track(token, deviceId)
    this.real?.track(token, deviceId)
  }

  override async request(input: Parameters<LocalTestTransport['request']>[0]): Promise<RemoteResponse> {
    if (!this.handler || !this.phone) throw new Error('transport not started')
    for (let i = 0; !this.relay.room.online; i++) {
      if (i > 5000) throw new Error('the relay pair never came online')
      await yieldToIo()
    }
    const before = this.gate
    let open: () => void = () => {}
    this.gate = new Promise<void>((resolve) => {
      open = resolve
    })
    await before
    this.arrived = open
    try {
      return await this.send(input)
    } finally {
      this.arrived = this.arrived === open ? null : this.arrived
      open()
    }
  }

  private async send(input: Parameters<LocalTestTransport['request']>[0]): Promise<RemoteResponse> {
    if (!this.phone) throw new Error('transport not started')
    const plaintext = JSON.stringify({
      k: 'req',
      method: input.method,
      path: input.path,
      ...(input.query ? { query: input.query } : {}),
      headers: input.headers,
      body: input.body
    })
    // A phone whose session is gone (revoked, expired) starts a new one and asks again, once.
    for (let attempt = 0; ; attempt++) {
      if (!this.phone.keys) {
        const connected = await this.phone.connect()
        if (!connected.ok) throw new Error(`relay pair handshake failed: ${connected.reason}`)
      }
      const reply = await this.phone.request(plaintext, input.signal)
      if (reply.ok) return toResponse(JSON.parse(reply.plaintext))
      if (reply.status === 410 && attempt === 0) {
        this.phone.keys = null
        continue
      }
      throw new Error(`relay pair refused the request: ${reply.status} ${reply.error}`)
    }
  }
}

function toResponse(plain: unknown): RemoteResponse {
  const wire = relayResponseSchema.parse(plain)
  const headers: Record<string, string> = {}
  if (wire.contentType) headers['content-type'] = wire.contentType
  if (wire.cache) headers['cache-control'] = wire.cache
  const response: RemoteResponse = { status: wire.status }
  if (Object.keys(headers).length) response.headers = headers
  if (wire.bytes !== undefined) response.body = b64u.decode(wire.bytes)
  else if (wire.json !== undefined) response.body = wire.json
  return response
}
