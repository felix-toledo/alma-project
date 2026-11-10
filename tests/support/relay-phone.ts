// A phone-side client over the fake relay (spec 027 T13): the real phone handshake and the real sealing, over the fake's HTTP.
import type { PublicJwk } from '../../src/shared/remote/crypto'
import { createPhoneHandshake, openAnswer, type PhoneHandshake, sealRequest, type SessionKeys, type Signer } from '../../src/shared/remote/relay-e2e'
import { relayFrameSchema } from '../../src/shared/remote/relay-frame'
import { type FakeRelay, random } from './relay-fake'

export interface PhoneOptions {
  /** Null while pairing. */
  device: (Signer & { id: string }) | null
  /** What the phone checks the PC against: the key stored at pairing, or the fingerprint from the QR. */
  expect: { pcKey?: PublicJwk; fingerprint?: string }
  version?: number
  address?: string
}

export type PhoneReply = { ok: true; plaintext: string } | { ok: false; status: number; error: string }

export class FakePhone {
  keys: SessionKeys | null = null
  private counter = 0

  constructor(
    private readonly relay: FakeRelay,
    private readonly options: PhoneOptions
  ) {}

  /** The two round trips of the handshake. Returns the cause when it fails. */
  async connect(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const handshake: PhoneHandshake = createPhoneHandshake({ device: this.options.device, random, version: this.options.version })
    const first = await this.post(JSON.stringify(await handshake.hs1()))
    if (first.status !== 200) return { ok: false, reason: `relay ${first.status}` }
    const hs3 = await handshake.onHs2(JSON.parse(first.body), this.options.expect)
    if ('fail' in hs3) return { ok: false, reason: hs3.fail }
    const second = await this.post(JSON.stringify(hs3))
    if (second.status !== 200) return { ok: false, reason: `relay ${second.status}` }
    this.keys = await handshake.onHs4(JSON.parse(second.body))
    this.counter = 0
    return this.keys ? { ok: true } : { ok: false, reason: 'hs4' }
  }

  /** One sealed request and its answer. A frame that does not authenticate drops the session, as the real client does. */
  async request(plaintext: string, signal?: AbortSignal): Promise<PhoneReply> {
    if (!this.keys) return { ok: false, status: 0, error: 'no session' }
    const ctr = this.counter++
    const answer = await this.post(JSON.stringify(await sealRequest(this.keys, ctr, new TextEncoder().encode(plaintext))), signal)
    if (answer.status !== 200) return { ok: false, status: answer.status, error: (JSON.parse(answer.body) as { error: string }).error }
    const frame = relayFrameSchema.safeParse(JSON.parse(answer.body))
    const opened = frame.success ? await openAnswer(this.keys, ctr, frame.data) : null
    if (!opened) {
      this.keys = null
      return { ok: false, status: 200, error: 'tamper' }
    }
    return { ok: true, plaintext: new TextDecoder().decode(opened) }
  }

  private post(body: string, signal?: AbortSignal) {
    return this.relay.phoneFetch(body, { address: this.options.address, signal })
  }
}
