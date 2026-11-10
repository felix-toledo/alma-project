// The end-to-end layer of the relay (spec 027 PD-3, PD-4): sealed frames and the anti-replay window.
// Pure and browser-safe: it runs on the PC and on the phone, never on the relay.
import * as z from 'zod/v4'
import { b64u, canonicalJwk, fingerprint, type PublicJwk, verifyEs256 } from './crypto'
import { aesKey, aesOpen, aesSeal, ecdhSecret, generateEcdh, hkdfExpand, hkdfExtract, nonceFor } from './relay-crypto'
import { parseRelayFrame, RELAY_PROTOCOL, type RelayFrame } from './relay-frame'

export { nonceFor } from './relay-crypto'

export interface SessionKeys {
  /** The protocol version this session was negotiated at; every frame carries it and it is in the authenticated data. */
  v: number
  sid: string
  c2s: CryptoKey
  s2c: CryptoKey
  expiresAt: number
}

/** The two frame kinds that carry a request or its answer. */
export type SealedFrame = Extract<RelayFrame, { ctr: number }>

export interface ReplayWindow {
  /** True once per counter: a repeat, or a counter older than the window, is false. */
  accept(ctr: number): boolean
}

const WINDOW = 64
const WINDOW_MASK = (1n << BigInt(WINDOW)) - 1n

export function createReplayWindow(): ReplayWindow {
  let highest = -1
  // Bit i is set when counter `highest - i` was seen.
  let seen = 0n
  return {
    accept(ctr) {
      if (!Number.isSafeInteger(ctr) || ctr < 0) return false
      if (ctr > highest) {
        const shift = ctr - highest
        seen = shift >= WINDOW ? 1n : ((seen << BigInt(shift)) | 1n) & WINDOW_MASK
        highest = ctr
        return true
      }
      const age = highest - ctr
      if (age >= WINDOW) return false
      const bit = 1n << BigInt(age)
      if (seen & bit) return false
      seen |= bit
      return true
    }
  }
}

/** The authenticated data of a frame: version, kind, session and counter, so none of them can be changed in flight. */
export function frameAad(v: number, kind: string, sid: string, ctr: number): Uint8Array {
  const head = new TextEncoder().encode(kind + sid)
  const aad = new Uint8Array(1 + head.length + 8)
  aad[0] = v
  aad.set(head, 1)
  new DataView(aad.buffer).setBigUint64(1 + head.length, BigInt(ctr))
  return aad
}

async function seal(key: CryptoKey, keys: SessionKeys, t: 'q' | 'a', ctr: number, plaintext: Uint8Array): Promise<SealedFrame> {
  const sealed = await aesSeal(key, nonceFor(ctr), plaintext, frameAad(keys.v, t, keys.sid, ctr))
  return { v: keys.v, t, sid: keys.sid, ctr, ct: b64u.encode(sealed) }
}

async function open(key: CryptoKey, keys: SessionKeys, t: 'q' | 'a', frame: RelayFrame): Promise<Uint8Array | null> {
  if ((frame.t !== 'q' && frame.t !== 'a') || frame.t !== t || frame.v !== keys.v || frame.sid !== keys.sid || !Number.isSafeInteger(frame.ctr) || frame.ctr < 0) return null
  try {
    return await aesOpen(key, nonceFor(frame.ctr), b64u.decode(frame.ct), frameAad(keys.v, t, keys.sid, frame.ctr))
  } catch {
    return null
  }
}

export function sealRequest(keys: SessionKeys, ctr: number, plaintext: Uint8Array): Promise<SealedFrame> {
  return seal(keys.c2s, keys, 'q', ctr, plaintext)
}

/** Opens first and consumes the counter only for a frame that authenticated, so garbage cannot burn counters. */
export async function openRequest(keys: SessionKeys, window: ReplayWindow, frame: RelayFrame): Promise<Uint8Array | null> {
  const plaintext = await open(keys.c2s, keys, 'q', frame)
  if (!plaintext || frame.t !== 'q' || !window.accept(frame.ctr)) return null
  return plaintext
}

/** `ctr` is the counter of the request this answers. */
export function sealAnswer(keys: SessionKeys, ctr: number, plaintext: Uint8Array): Promise<SealedFrame> {
  return seal(keys.s2c, keys, 'a', ctr, plaintext)
}

export async function openAnswer(keys: SessionKeys, ctr: number, frame: RelayFrame): Promise<Uint8Array | null> {
  if (frame.t !== 'a' || frame.ctr !== ctr) return null
  return open(keys.s2c, keys, 'a', frame)
}

/** A session lives one hour from hs4 (PD-5). The PC refuses frames after it with `gone`. */
export const SESSION_LIFETIME_MS = 3_600_000

export function sessionExpired(keys: SessionKeys, now: number): boolean {
  return now >= keys.expiresAt
}

export type HandshakeFailure = 'version' | 'signature' | 'fingerprint' | 'unknown-device' | 'malformed'
export type HandshakeOutcome =
  | { ok: true; keys: SessionKeys; device: { id: string } | 'anonymous' }
  | { ok: false; reason: HandshakeFailure }

type Hs1 = Extract<RelayFrame, { t: 'hs1' }>
type Hs2 = Extract<RelayFrame, { t: 'hs2' }>

export interface PcHandshake {
  /** Takes the raw frame so a wrong version can be told from a malformed one. */
  start(hs1: unknown): Promise<RelayFrame | { fail: 'version' | 'malformed' }>
  /** One use: the state is gone after the first call, whatever it answers. */
  finish(hs3: unknown): Promise<{ outcome: HandshakeOutcome; hs4?: RelayFrame }>
}

export interface PhoneHandshake {
  hs1(): Promise<RelayFrame>
  /** Authenticates the PC before anything is sent: with the key stored at pairing, or, while pairing, with the key in hs2 only if its fingerprint is the one read from the QR. */
  onHs2(hs2: unknown, expect: { pcKey?: PublicJwk; fingerprint?: string }): Promise<RelayFrame | { fail: 'version' | 'signature' | 'fingerprint' | 'malformed' }>
  onHs4(hs4: unknown): Promise<SessionKeys | null>
}

export interface Signer {
  sign(data: Uint8Array): Promise<Uint8Array>
}

export interface PcHandshakeDeps {
  identity: Signer & { publicKey: PublicJwk }
  /** Null for an unknown, revoked or idle-expired device: the handshake cannot tell them apart. */
  deviceKey(deviceId: string): PublicJwk | null
  random(length: number): Uint8Array
  now(): number
}

export interface PhoneHandshakeDeps {
  /** Null while pairing: the phone has no device key yet and goes in as anonymous. */
  device: (Signer & { id: string }) | null
  random(length: number): Uint8Array
  /** Defaults to the current protocol version. */
  version?: number
}

export interface HandshakeKeys {
  hsC2s: CryptoKey
  hsS2c: CryptoKey
  c2s: CryptoKey
  s2c: CryptoKey
}

const text = new TextEncoder()

/** Length-prefixed fields under a label, so no two different field lists encode alike. */
function encodeParts(label: string, parts: Uint8Array[]): Uint8Array {
  const head = text.encode(label)
  const out = new Uint8Array(head.length + parts.reduce((sum, part) => sum + 4 + part.length, 0))
  out.set(head)
  let at = head.length
  for (const part of parts) {
    new DataView(out.buffer).setUint32(at, part.length)
    out.set(part, at + 4)
    at += 4 + part.length
  }
  return out
}

function fieldsOf(hs1: Hs1, hs2: Hs2): Uint8Array[] {
  return [Uint8Array.of(hs1.v), b64u.decode(hs1.ea), b64u.decode(hs1.na), b64u.decode(hs2.eb), b64u.decode(hs2.nb), b64u.decode(hs2.sid)]
}

/** The signed transcript of hs2: the PC identity signs it and the phone checks it. */
function hs2Message(hs1: Hs1, hs2: Hs2): Uint8Array {
  return encodeParts('alma-hs2', fieldsOf(hs1, hs2))
}

/** th: everything both sides saw, the PC key included. It salts the key schedule and is what a device signs in hs3. */
export async function transcriptHash(hs1: Hs1, hs2: Hs2): Promise<Uint8Array> {
  const message = encodeParts('alma-th', [...fieldsOf(hs1, hs2), text.encode(canonicalJwk(hs2.pc))])
  return new Uint8Array(await crypto.subtle.digest('SHA-256', message as Parameters<typeof crypto.subtle.digest>[1]))
}

export async function deriveKeys(sharedSecret: Uint8Array, th: Uint8Array): Promise<HandshakeKeys> {
  const prk = await hkdfExtract(th, sharedSecret)
  const key = async (label: string): Promise<CryptoKey> => aesKey(await hkdfExpand(prk, text.encode(label), 32))
  return { hsC2s: await key('hs-c2s'), hsS2c: await key('hs-s2c'), c2s: await key('c2s'), s2c: await key('s2c') }
}

const hs3Plain = z.union([z.strictObject({ deviceId: z.string().min(1).max(128), sig: z.string().min(1).max(128) }), z.strictObject({ anonymous: z.literal(true) })])
const hs4Plain = z.strictObject({ ok: z.literal(true), expiresAt: z.number().int().min(0) })

async function sealHandshake(key: CryptoKey, kind: 'hs3' | 'hs4', v: number, sid: string, plain: unknown): Promise<RelayFrame> {
  const sealed = await aesSeal(key, nonceFor(0), text.encode(JSON.stringify(plain)), frameAad(v, kind, sid, 0))
  return { v, t: kind, sid, ct: b64u.encode(sealed) }
}

async function openHandshake<S extends z.ZodType>(key: CryptoKey, frame: Extract<RelayFrame, { t: 'hs3' | 'hs4' }>, schema: S): Promise<z.infer<S> | null> {
  try {
    const plain = await aesOpen(key, nonceFor(0), b64u.decode(frame.ct), frameAad(frame.v, frame.t, frame.sid, 0))
    if (!plain) return null
    const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(plain)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function pointOf(encoded: string): Uint8Array | null {
  try {
    const point = b64u.decode(encoded)
    return point.length === 65 && point[0] === 4 ? point : null
  } catch {
    return null
  }
}

export function createPcHandshake(deps: PcHandshakeDeps): PcHandshake {
  let pending: { v: number; sid: string; th: Uint8Array; keys: HandshakeKeys } | null = null
  return {
    async start(raw) {
      pending = null
      const parsed = parseRelayFrame(raw)
      if (!parsed.ok) return { fail: parsed.reason }
      const hs1 = parsed.frame
      if (hs1.t !== 'hs1') return { fail: 'malformed' }
      const ea = pointOf(hs1.ea)
      if (!ea) return { fail: 'malformed' }
      const ephemeral = await generateEcdh()
      const shared = await ecdhSecret(ephemeral.privateKey, ea)
      if (!shared) return { fail: 'malformed' }
      const key = deps.identity.publicKey
      const hs2: Hs2 = {
        v: hs1.v,
        t: 'hs2',
        sid: b64u.encode(deps.random(16)),
        eb: b64u.encode(ephemeral.publicKey),
        nb: b64u.encode(deps.random(16)),
        pc: { kty: 'EC', crv: 'P-256', x: key.x ?? '', y: key.y ?? '' },
        sig: ''
      }
      hs2.sig = b64u.encode(await deps.identity.sign(hs2Message(hs1, hs2)))
      const th = await transcriptHash(hs1, hs2)
      pending = { v: hs1.v, sid: hs2.sid, th, keys: await deriveKeys(shared, th) }
      return hs2
    },

    async finish(raw) {
      const session = pending
      pending = null
      const refuse = (reason: HandshakeFailure) => ({ outcome: { ok: false, reason } as const })
      if (!session) return refuse('malformed')
      const parsed = parseRelayFrame(raw)
      if (!parsed.ok) return refuse(parsed.reason)
      const hs3 = parsed.frame
      if (hs3.t !== 'hs3' || hs3.sid !== session.sid) return refuse('malformed')
      if (hs3.v !== session.v) return refuse('version')
      const plain = await openHandshake(session.keys.hsC2s, hs3, hs3Plain)
      if (!plain) return refuse('malformed')
      let device: { id: string } | 'anonymous' = 'anonymous'
      if ('deviceId' in plain) {
        // Unknown, revoked, expired and wrongly signed all end the same way.
        const key = deps.deviceKey(plain.deviceId)
        let proven = false
        try {
          proven = key !== null && (await verifyEs256(key, encodeParts('alma-hs3', [session.th]), b64u.decode(plain.sig)))
        } catch {
          proven = false
        }
        if (!proven) return refuse('unknown-device')
        device = { id: plain.deviceId }
      }
      const expiresAt = deps.now() + SESSION_LIFETIME_MS
      const hs4 = await sealHandshake(session.keys.hsS2c, 'hs4', session.v, session.sid, { ok: true, expiresAt })
      const keys: SessionKeys = { v: session.v, sid: session.sid, c2s: session.keys.c2s, s2c: session.keys.s2c, expiresAt }
      return { outcome: { ok: true, keys, device }, hs4 }
    }
  }
}

export function createPhoneHandshake(deps: PhoneHandshakeDeps): PhoneHandshake {
  const v = deps.version ?? RELAY_PROTOCOL.current
  let first: { hs1: Hs1; privateKey: CryptoKey } | null = null
  let awaiting: { sid: string; keys: HandshakeKeys } | null = null
  return {
    async hs1() {
      const ephemeral = await generateEcdh()
      const hs1: Hs1 = { v, t: 'hs1', ea: b64u.encode(ephemeral.publicKey), na: b64u.encode(deps.random(16)) }
      first = { hs1, privateKey: ephemeral.privateKey }
      awaiting = null
      return hs1
    },

    async onHs2(raw, expect) {
      const sent = first
      first = null
      if (!sent) return { fail: 'malformed' }
      const parsed = parseRelayFrame(raw)
      if (!parsed.ok) return { fail: parsed.reason }
      const hs2 = parsed.frame
      if (hs2.t !== 'hs2') return { fail: 'malformed' }
      // A relay that answers at another version than the one asked for is downgrading or confused.
      if (hs2.v !== v) return { fail: 'version' }
      if (expect.pcKey) {
        if (canonicalJwk(hs2.pc) !== canonicalJwk(expect.pcKey)) return { fail: 'signature' }
      } else if (!expect.fingerprint || (await fingerprint(hs2.pc)) !== expect.fingerprint) {
        return { fail: 'fingerprint' }
      }
      let signature: Uint8Array
      let message: Uint8Array
      try {
        signature = b64u.decode(hs2.sig)
        message = hs2Message(sent.hs1, hs2)
      } catch {
        return { fail: 'malformed' }
      }
      if (!(await verifyEs256(hs2.pc, message, signature))) return { fail: 'signature' }
      const eb = pointOf(hs2.eb)
      const shared = eb ? await ecdhSecret(sent.privateKey, eb) : null
      if (!shared) return { fail: 'malformed' }
      const th = await transcriptHash(sent.hs1, hs2)
      const keys = await deriveKeys(shared, th)
      const proof = deps.device
        ? { deviceId: deps.device.id, sig: b64u.encode(await deps.device.sign(encodeParts('alma-hs3', [th]))) }
        : { anonymous: true }
      awaiting = { sid: hs2.sid, keys }
      return sealHandshake(keys.hsC2s, 'hs3', v, hs2.sid, proof)
    },

    async onHs4(raw) {
      const session = awaiting
      awaiting = null
      if (!session) return null
      const parsed = parseRelayFrame(raw)
      if (!parsed.ok || parsed.frame.t !== 'hs4' || parsed.frame.sid !== session.sid || parsed.frame.v !== v) return null
      const plain = await openHandshake(session.keys.hsS2c, parsed.frame, hs4Plain)
      if (!plain) return null
      return { v, sid: session.sid, c2s: session.keys.c2s, s2c: session.keys.s2c, expiresAt: plain.expiresAt }
    }
  }
}
