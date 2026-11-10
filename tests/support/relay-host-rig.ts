// The PC side of the relay talked to in-process (spec 027 T15): a RelayHost over a spy handler, and a phone that runs the
// real handshake and sealing against it. No relay and no sockets: frames go straight into `host.handle`.
import { RelayHost } from '../../src/coordinator/channels/remote/relay-host'
import type { RemoteHandler, RemoteRequest, RemoteResponse } from '../../src/shared/remote/api'
import type { PublicJwk } from '../../src/shared/remote/crypto'
import { createPhoneHandshake, openAnswer, type SessionKeys, type Signer, sealRequest } from '../../src/shared/remote/relay-e2e'
import { type RelayFrame, relayFrameSchema } from '../../src/shared/remote/relay-frame'
import { type RelayShellAnswer, type RelayWireResponse, relayResponseSchema, relayShellAnswerSchema } from '../../src/shared/remote/relay-wire'
import { type KeyPair, keyPair, random } from './relay-fake'

export const ADDRESS = 'https://abc123.relay.test'

export interface PhoneRequest {
  method: string
  path: string
  query?: string
  headers?: Record<string, string>
  body?: unknown
}

export class HostPhone {
  keys: SessionKeys | null = null
  ctr = 0
  /** Every frame that crossed, as the relay would have seen it. */
  readonly wire: string[] = []

  constructor(
    readonly host: RelayHost,
    private readonly options: { device: (Signer & { id: string }) | null; expect: { pcKey?: PublicJwk; fingerprint?: string }; version?: number }
  ) {}

  async submit(frame: RelayFrame, signal: AbortSignal = new AbortController().signal): Promise<RelayFrame | 'gone'> {
    this.wire.push(JSON.stringify(frame))
    const answer = await this.host.handle(JSON.parse(JSON.stringify(frame)), signal)
    if (answer !== 'gone') this.wire.push(JSON.stringify(answer))
    return answer
  }

  async connect(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const handshake = createPhoneHandshake({ device: this.options.device, random, version: this.options.version })
    const hs2 = await this.submit(await handshake.hs1())
    if (hs2 === 'gone') return { ok: false, reason: 'hs1 refused' }
    const hs3 = await handshake.onHs2(hs2, this.options.expect)
    if ('fail' in hs3) return { ok: false, reason: hs3.fail }
    const hs4 = await this.submit(hs3)
    if (hs4 === 'gone') return { ok: false, reason: 'hs3 refused' }
    this.keys = await handshake.onHs4(hs4)
    this.ctr = 0
    return this.keys ? { ok: true } : { ok: false, reason: 'hs4' }
  }

  /** Seals any plaintext as the next request and returns the opened answer plaintext, or 'gone'. */
  async ask(plain: unknown, signal?: AbortSignal): Promise<unknown | 'gone'> {
    if (!this.keys) throw new Error('not connected')
    const ctr = this.ctr++
    const answer = await this.submit(await sealRequest(this.keys, ctr, new TextEncoder().encode(typeof plain === 'string' ? plain : JSON.stringify(plain))), signal)
    if (answer === 'gone') return 'gone'
    const frame = relayFrameSchema.parse(answer)
    const opened = await openAnswer(this.keys, ctr, frame)
    if (!opened) throw new Error('answer did not open')
    return JSON.parse(new TextDecoder().decode(opened))
  }

  /** An API call as the browser would make it. Throws when the session is gone. */
  async call(request: PhoneRequest): Promise<RelayWireResponse> {
    const answer = await this.ask({ k: 'req', ...request })
    if (answer === 'gone') throw new Error('gone')
    return relayResponseSchema.parse(answer)
  }

  async shell(): Promise<RelayShellAnswer> {
    const answer = await this.ask({ k: 'ctl', op: 'shell' })
    if (answer === 'gone') throw new Error('gone')
    return relayShellAnswerSchema.parse(answer)
  }
}

export interface HostRig {
  host: RelayHost
  identity: KeyPair
  device: KeyPair
  devices: Map<string, PublicJwk>
  clock: { t: number }
  /** The requests the handler received. */
  calls: RemoteRequest[]
  phone(options?: { device?: { id: string; sign: Signer['sign'] } | null; version?: number }): HostPhone
}

export async function hostRig(
  options: { handler?: RemoteHandler; shell?: () => { version: number; rootHash: string } | null; address?: string; onHandshakeFailed?: () => void } = {}
): Promise<HostRig> {
  const identity = await keyPair()
  const device = await keyPair()
  const devices = new Map<string, PublicJwk>([['dev-1', device.publicKey]])
  const clock = { t: 1_700_000_000_000 }
  const calls: RemoteRequest[] = []
  const handler: RemoteHandler =
    options.handler ??
    (async (): Promise<RemoteResponse> => ({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { ok: true } }))
  const host = new RelayHost({
    address: options.address ?? ADDRESS,
    handler: (request, signal) => {
      calls.push(request)
      return handler(request, signal)
    },
    identity: { publicKey: identity.publicKey, sign: identity.sign },
    deviceKey: (id) => devices.get(id) ?? null,
    random,
    now: () => clock.t,
    shell: options.shell,
    onHandshakeFailed: options.onHandshakeFailed
  })
  const rig: HostRig = {
    host,
    identity,
    device,
    devices,
    clock,
    calls,
    phone: (phoneOptions = {}) =>
      new HostPhone(host, {
        device: phoneOptions.device === undefined ? { id: 'dev-1', sign: device.sign } : phoneOptions.device,
        expect: { pcKey: identity.publicKey },
        version: phoneOptions.version
      })
  }
  return rig
}
