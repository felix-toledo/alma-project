import { describe, expect, it } from 'vitest'
import { b64u, fingerprint, type PublicJwk, signEs256 } from '../src/shared/remote/crypto'
import {
  type PcToRelay,
  parseRelayFrame,
  pcToRelaySchema,
  RELAY_PROTOCOL,
  type RelayFrame,
  type RelayToPc,
  registrationMessage,
  relayFrameSchema,
  relayToPcSchema
} from '../src/shared/remote/relay-frame'
import { aesKey, aesOpen, aesSeal, ecdhSecret, generateEcdh, hkdfExpand, hkdfExtract, nonceFor } from '../src/shared/remote/relay-crypto'
import {
  createPcHandshake,
  createPhoneHandshake,
  createReplayWindow,
  deriveKeys,
  frameAad,
  type HandshakeOutcome,
  openAnswer,
  openRequest,
  type SealedFrame,
  type SessionKeys,
  SESSION_LIFETIME_MS,
  sealAnswer,
  sealRequest,
  sessionExpired,
  transcriptHash
} from '../src/shared/remote/relay-e2e'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { random } from './support/relay-fake'
import { hostRig } from './support/relay-host-rig'
import { FakePhone } from './support/relay-phone'
import { onThePair, served } from './support/relay-served'
import { makeThread } from './support/remote-harness'

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const text = (bytes: number): string => b64u.encode(new Uint8Array(bytes).fill(7))
const v = RELAY_PROTOCOL.current
const jwk = { kty: 'EC', crv: 'P-256', x: text(32), y: text(32) }

const frames: RelayFrame[] = [
  { v, t: 'hs1', ea: text(65), na: text(16) },
  { v, t: 'hs2', sid: text(16), eb: text(65), nb: text(16), pc: jwk, sig: text(64) },
  { v, t: 'hs3', sid: text(16), ct: text(60) },
  { v, t: 'hs4', sid: text(16), ct: text(40) },
  { v, t: 'q', sid: text(16), ctr: 0, ct: text(100) },
  { v, t: 'a', sid: text(16), ctr: 41, ct: text(100) }
]

describe('frame schema (spec 027 T3)', () => {
  it('AC-3.7 a good frame of each type parses, with the current and the previous version', () => {
    for (const frame of frames) {
      expect(relayFrameSchema.safeParse(frame).success, frame.t).toBe(true)
      expect(relayFrameSchema.safeParse({ ...frame, v: RELAY_PROTOCOL.previous }).success, `${frame.t} previous`).toBe(true)
    }
  })

  it('AC-3.7 any other version is rejected, whatever its shape', () => {
    for (const bad of [2, 99, -1, 1.5, '1', null, undefined]) {
      for (const frame of frames) expect(relayFrameSchema.safeParse({ ...frame, v: bad }).success, `${frame.t} ${String(bad)}`).toBe(false)
    }
  })

  it('frame schema rejects anything that is not exactly a frame', () => {
    expect(relayFrameSchema.safeParse(null).success).toBe(false)
    expect(relayFrameSchema.safeParse('hs1').success).toBe(false)
    expect(relayFrameSchema.safeParse([]).success).toBe(false)
    expect(relayFrameSchema.safeParse({ v, t: 'hs9', ea: text(65), na: text(16) }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ v, t: 'q', sid: text(16), ct: text(100) }).success).toBe(false)
    for (const frame of frames) {
      for (const key of Object.keys(frame)) {
        if (key === 'v' || key === 't') continue
        const { [key]: _dropped, ...rest } = frame as unknown as Record<string, unknown>
        expect(relayFrameSchema.safeParse(rest).success, `${frame.t} without ${key}`).toBe(false)
      }
    }
  })

  it('frame schema rejects members it does not know, including a private key in the PC key', () => {
    for (const frame of frames) expect(relayFrameSchema.safeParse({ ...frame, extra: 1 }).success, frame.t).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[1], pc: { ...jwk, d: text(32) } }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[1], pc: { ...jwk, crv: 'P-384' } }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[1], pc: { ...jwk, kty: 'RSA' } }).success).toBe(false)
  })

  it('frame schema accepts base64url only and bounds the counter', () => {
    for (const bad of ['a+b', 'a/b', 'abc=', 'a b', 'a\nb', '', 'é']) {
      expect(relayFrameSchema.safeParse({ ...frames[4], ct: bad }).success, JSON.stringify(bad)).toBe(false)
      expect(relayFrameSchema.safeParse({ ...frames[0], ea: bad }).success, `ea ${JSON.stringify(bad)}`).toBe(false)
    }
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '3']) {
      expect(relayFrameSchema.safeParse({ ...frames[4], ctr: bad }).success, String(bad)).toBe(false)
    }
    expect(relayFrameSchema.safeParse({ ...frames[4], ctr: Number.MAX_SAFE_INTEGER }).success).toBe(true)
  })

  it('frame schema bounds every field by length, with the sealed text at the frame cap', () => {
    const long = 'A'.repeat(REMOTE_RELAY_LIMITS.frameBytes + 1)
    expect(relayFrameSchema.safeParse({ ...frames[4], ct: long }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[2], ct: long }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[4], ct: 'A'.repeat(REMOTE_RELAY_LIMITS.frameBytes) }).success).toBe(true)
    expect(relayFrameSchema.safeParse({ ...frames[0], ea: 'A'.repeat(1000) }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[0], na: 'A'.repeat(1000) }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[1], sig: 'A'.repeat(1000) }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[4], sid: 'A'.repeat(1000) }).success).toBe(false)
    expect(relayFrameSchema.safeParse({ ...frames[1], pc: { ...jwk, x: 'A'.repeat(1000) } }).success).toBe(false)
  })

  it('frame schema parses each PC and relay message and rejects unknown ones', () => {
    const toRelay: PcToRelay[] = [
      { k: 'reg', pub: jwk, sig: text(64) },
      { k: 'r', rid: text(12), frame: frames[4] },
      { k: 'x', rid: text(12), refusal: 'gone' }
    ]
    const toPc: RelayToPc[] = [
      { k: 'challenge', nonce: text(32) },
      { k: 'ready' },
      { k: 'f', rid: text(12), frame: frames[4] },
      { k: 'abort', rid: text(12) }
    ]
    for (const message of toRelay) expect(pcToRelaySchema.safeParse(message).success, message.k).toBe(true)
    for (const message of toPc) expect(relayToPcSchema.safeParse(message).success, message.k).toBe(true)
    for (const message of toRelay) expect(pcToRelaySchema.safeParse({ ...message, extra: 1 }).success, `to relay ${message.k} extra`).toBe(false)
    for (const message of toPc) expect(relayToPcSchema.safeParse({ ...message, extra: 1 }).success, `to pc ${message.k} extra`).toBe(false)
    expect(pcToRelaySchema.safeParse({ k: 'f', rid: text(12), frame: frames[4] }).success).toBe(false)
    // The PC can refuse a request only as `gone` (the session is unknown to it); every other refusal belongs to the relay.
    for (const refusal of ['offline', 'full', 'timeout', 'version', 'malformed', '', undefined]) {
      expect(pcToRelaySchema.safeParse({ k: 'x', rid: text(12), refusal }).success, String(refusal)).toBe(false)
    }
    expect(pcToRelaySchema.safeParse({ k: 'x', refusal: 'gone' }).success).toBe(false)
    expect(relayToPcSchema.safeParse({ k: 'reg', pub: jwk, sig: text(64) }).success).toBe(false)
    expect(pcToRelaySchema.safeParse({ k: 'r', rid: text(12), frame: { ...frames[4], v: 7 } }).success).toBe(false)
    expect(relayToPcSchema.safeParse({ k: 'abort', rid: '' }).success).toBe(false)
    expect(relayToPcSchema.safeParse({ k: 'f', rid: text(12), frame: { ...frames[4], extra: 1 } }).success).toBe(false)
  })

  it('AC-5.2 the registration message binds the label, the routing id and the nonce unambiguously', () => {
    const nonce = new Uint8Array(32).fill(3)
    const message = registrationMessage('abc', nonce)
    expect(new TextDecoder().decode(message)).toContain('alma-relay-reg')
    expect(message).toEqual(registrationMessage('abc', nonce))
    expect(message).not.toEqual(registrationMessage('abd', nonce))
    expect(message).not.toEqual(registrationMessage('abc', new Uint8Array(32).fill(4)))
    // Moving a byte between the id and the nonce must not give the same message.
    expect(registrationMessage('abc', new Uint8Array([100, ...nonce.subarray(1)]))).not.toEqual(registrationMessage('abcd', nonce.subarray(1)))
  })
})

describe('crypto wrappers (spec 027 T4)', () => {
  const ecdhPrivate = async (d: string, x: string, y: string): Promise<CryptoKey> =>
    crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', d: b64u.encode(hex(d)), x: b64u.encode(hex(x)), y: b64u.encode(hex(y)) },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    )
  const point = (x: string, y: string): Uint8Array => hex(`04${x}${y}`)

  // RFC 5903 section 8.1 (256-bit random ECP group).
  const I = { d: 'C88F01F510D9AC3F70A292DAA2316DE544E9AAB8AFE84049C62A9C57862D1433', x: 'DAD0B65394221CF9B051E1FECA5787D098DFE637FC90B9EF945D0C3772581180', y: '5271A0461CDB8252D61F1C456FA3E59AB1F45B33ACCF5F58389E0577B8990BB3' }
  const R = { d: 'C6EF9C5D78AE012A011164ACB397CE2088685D8F06BF9BE0B283AB46476BEE53', x: 'D12DFB5289C8D4F81208B70270398C342296970A0BCCB74C736FC7554494BF63', y: '56FBF3CA366CC23E8157854C13C58D6AAC23F046ADA30F8353E74F33039872AB' }
  const SHARED = 'D6840F6B42F6EDAFD13116E0E12565202FEF8E9ECE7DCE03812464D04B9442DE'

  it('AC-3.8 ECDH P-256 matches the RFC 5903 vector in both directions', async () => {
    expect(toHex(await ecdhSecret(await ecdhPrivate(I.d, I.x, I.y), point(R.x, R.y)) ?? new Uint8Array())).toBe(SHARED.toLowerCase())
    expect(toHex(await ecdhSecret(await ecdhPrivate(R.d, R.x, R.y), point(I.x, I.y)) ?? new Uint8Array())).toBe(SHARED.toLowerCase())
  })

  it('AC-3.8 fresh ephemeral pairs export a raw 65-byte point, agree with each other and never reuse a key', async () => {
    const a = await generateEcdh()
    const b = await generateEcdh()
    const c = await generateEcdh()
    expect(a.publicKey).toHaveLength(65)
    expect(a.publicKey[0]).toBe(4)
    expect(a.publicKey).not.toEqual(b.publicKey)
    const ab = await ecdhSecret(a.privateKey, b.publicKey)
    expect(ab).toHaveLength(32)
    expect(ab).toEqual(await ecdhSecret(b.privateKey, a.publicKey))
    expect(ab).not.toEqual(await ecdhSecret(a.privateKey, c.publicKey))
    await expect(crypto.subtle.exportKey('jwk', a.privateKey)).rejects.toThrow()
  })

  it('AC-3.8 a peer point that is not on the curve, is too short or is the wrong format yields no secret', async () => {
    const a = await generateEcdh()
    const off = a.publicKey.slice()
    off[64] ^= 1
    expect(await ecdhSecret(a.privateKey, off)).toBeNull()
    expect(await ecdhSecret(a.privateKey, a.publicKey.slice(0, 64))).toBeNull()
    expect(await ecdhSecret(a.privateKey, new Uint8Array())).toBeNull()
    expect(await ecdhSecret(a.privateKey, new Uint8Array(65))).toBeNull()
  })

  it('AC-3.8 HKDF-SHA-256 extract and expand match RFC 5869 test case 1', async () => {
    const prk = await hkdfExtract(hex('000102030405060708090a0b0c'), hex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'))
    expect(toHex(prk)).toBe('077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5')
    const okm = await hkdfExpand(prk, hex('f0f1f2f3f4f5f6f7f8f9'), 42)
    expect(toHex(okm)).toBe('3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865')
    expect(await hkdfExpand(prk, hex('f0f1f2f3f4f5f6f7f8f9'), 10)).toEqual(okm.slice(0, 10))
    expect(await hkdfExpand(prk, hex('f0f1f2f3f4f5f6f7f8fa'), 42)).not.toEqual(okm)
  })

  it('AC-3.8 HKDF refuses a length beyond 255 blocks instead of looping or wrapping', async () => {
    const prk = await hkdfExtract(new Uint8Array(), new Uint8Array(32))
    await expect(hkdfExpand(prk, new Uint8Array(), 255 * 32 + 1)).rejects.toThrow()
    expect(await hkdfExpand(prk, new Uint8Array(), 255 * 32)).toHaveLength(255 * 32)
  })

  // NIST GCM test case 16 (AES-256, 96-bit IV, with AAD).
  const key = hex('feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308')
  const iv = hex('cafebabefacedbaddecaf888')
  const aad = hex('feedfacedeadbeeffeedfacedeadbeefabaddad2')
  const plain = hex(
    'd9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39'
  )
  const sealedHex =
    '522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662' +
    '76fc6ece0f4e1768cddf8853bb2d551b'

  it('AC-3.8 AES-256-GCM seals to the NIST vector and opens it back', async () => {
    const k = await aesKey(key)
    const sealed = await aesSeal(k, iv, plain, aad)
    expect(toHex(sealed)).toBe(sealedHex)
    expect(await aesOpen(k, iv, sealed, aad)).toEqual(plain)
  })

  it('AC-3.8 a flipped bit anywhere in the ciphertext or tag, a wrong aad, nonce or key fails open', async () => {
    const k = await aesKey(key)
    const sealed = await aesSeal(k, iv, plain, aad)
    for (let i = 0; i < sealed.length; i++) {
      const bad = sealed.slice()
      bad[i] ^= 0x01
      expect(await aesOpen(k, iv, bad, aad), `byte ${i}`).toBeNull()
    }
    expect(await aesOpen(k, iv, sealed.slice(0, -1), aad)).toBeNull()
    expect(await aesOpen(k, iv, sealed.slice(0, 8), aad)).toBeNull()
    expect(await aesOpen(k, iv, new Uint8Array(), aad)).toBeNull()
    expect(await aesOpen(k, iv, sealed, new Uint8Array([...aad, 0]))).toBeNull()
    expect(await aesOpen(k, nonceFor(7), sealed, aad)).toBeNull()
    expect(await aesOpen(await aesKey(new Uint8Array(32)), iv, sealed, aad)).toBeNull()
  })

  it('AC-3.8 an AES key must be 32 bytes: no shorter AES variant is ever picked', async () => {
    await expect(aesKey(new Uint8Array(16))).rejects.toThrow()
    await expect(aesKey(new Uint8Array(24))).rejects.toThrow()
  })

  it('AC-3.8 the nonce is 4 zero bytes then the counter in 8 big-endian bytes, and no two counters share one', () => {
    expect(toHex(nonceFor(0))).toBe('000000000000000000000000')
    expect(toHex(nonceFor(1))).toBe('000000000000000000000001')
    expect(toHex(nonceFor(256))).toBe('000000000000000000000100')
    expect(toHex(nonceFor(2 ** 32))).toBe('000000000000000100000000')
    expect(toHex(nonceFor(Number.MAX_SAFE_INTEGER))).toBe('00000000001fffffffffffff')
    expect(nonceFor(0)).not.toEqual(nonceFor(1))
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(() => nonceFor(bad), String(bad)).toThrow(RangeError)
  })
})

describe('sealed frames (spec 027 T5)', () => {
  const randomKey = (): Promise<CryptoKey> => aesKey(crypto.getRandomValues(new Uint8Array(32)))
  const newKeys = async (v: number = RELAY_PROTOCOL.current): Promise<SessionKeys> => ({
    v,
    sid: b64u.encode(crypto.getRandomValues(new Uint8Array(16))),
    c2s: await randomKey(),
    s2c: await randomKey(),
    expiresAt: Date.now() + 3_600_000
  })
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
  const flipBit = (frame: SealedFrame, offset: number): SealedFrame => {
    const ct = b64u.decode(frame.ct)
    ct[offset] ^= 0x01
    return { ...frame, ct: b64u.encode(ct) }
  }

  it('AC-3.2 a request and its answer round-trip and the frames are valid wire frames with no plaintext in them', async () => {
    const keys = await newKeys()
    const request = await sealRequest(keys, 0, bytes('MARKER-REQUEST'))
    const answer = await sealAnswer(keys, 0, bytes('MARKER-ANSWER'))
    expect(relayFrameSchema.safeParse(request).success).toBe(true)
    expect(relayFrameSchema.safeParse(answer).success).toBe(true)
    expect(JSON.stringify([request, answer])).not.toContain('MARKER')
    expect(await openRequest(keys, createReplayWindow(), request)).toEqual(bytes('MARKER-REQUEST'))
    expect(await openAnswer(keys, 0, answer)).toEqual(bytes('MARKER-ANSWER'))
    expect(request).toMatchObject({ v: keys.v, t: 'q', sid: keys.sid, ctr: 0 })
    expect(answer).toMatchObject({ v: keys.v, t: 'a', sid: keys.sid, ctr: 0 })
  })

  it('AC-3.2 any tampering is rejected (the caller ends the session): a flipped bit at every byte offset, truncation, a swapped direction, a foreign session', async () => {
    const keys = await newKeys()
    const request = await sealRequest(keys, 3, bytes('a request of some length'))
    const answer = await sealAnswer(keys, 3, bytes('an answer of some length'))
    const window = createReplayWindow()
    const size = b64u.decode(request.ct).length
    for (let offset = 0; offset < size; offset++) {
      expect(await openRequest(keys, window, flipBit(request, offset)), `request byte ${offset}`).toBeNull()
      expect(await openAnswer(keys, 3, flipBit(answer, offset % b64u.decode(answer.ct).length)), `answer byte ${offset}`).toBeNull()
    }
    for (let length = 0; length < size; length++) {
      const cut = { ...request, ct: b64u.encode(b64u.decode(request.ct).slice(0, length)) }
      expect(await openRequest(keys, window, cut), `cut to ${length}`).toBeNull()
    }
    expect(await openRequest(keys, window, { ...request, ct: '***' })).toBeNull()
    expect(await openRequest(keys, window, { ...request, t: 'a' })).toBeNull()
    expect(await openRequest(keys, window, { ...answer, t: 'q' })).toBeNull()
    expect(await openAnswer(keys, 3, { ...request, t: 'a' })).toBeNull()
    expect(await openAnswer(keys, 3, { ...answer, t: 'q' })).toBeNull()
    expect(await openRequest(keys, window, answer)).toBeNull()
    expect(await openAnswer(keys, 3, request)).toBeNull()
    expect(await openRequest(keys, window, { ...request, sid: b64u.encode(new Uint8Array(16)) })).toBeNull()
    expect(await openRequest(keys, window, { ...request, ctr: 4 })).toBeNull()
    expect(await openRequest(keys, window, { ...request, v: RELAY_PROTOCOL.previous })).toBeNull()
    expect(await openRequest(await newKeys(), window, request)).toBeNull()
    // None of that burned the counter: the genuine frame still opens once.
    expect(await openRequest(keys, window, request)).toEqual(bytes('a request of some length'))
  })

  it('AC-3.2 a counter beyond the safe range is rejected on open and refused on seal, never wrapped', async () => {
    const keys = await newKeys()
    const request = await sealRequest(keys, 1, bytes('x'))
    expect(await openRequest(keys, createReplayWindow(), { ...request, ctr: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(await openRequest(keys, createReplayWindow(), { ...request, ctr: -1 })).toBeNull()
    expect(await openAnswer(keys, Number.NaN, await sealAnswer(keys, 1, bytes('x')))).toBeNull()
    await expect(sealRequest(keys, Number.MAX_SAFE_INTEGER + 1, bytes('x'))).rejects.toThrow(RangeError)
    await expect(sealAnswer(keys, -1, bytes('x'))).rejects.toThrow(RangeError)
  })

  it('AC-3.3 a replayed or reordered frame is rejected and nothing runs twice', async () => {
    const keys = await newKeys()
    const window = createReplayWindow()
    let ran = 0
    const run = async (ctr: number): Promise<boolean> => {
      const opened = await openRequest(keys, window, await sealRequest(keys, ctr, bytes(`c${ctr}`)))
      if (opened) ran++
      return opened !== null
    }
    expect(await run(0)).toBe(true)
    expect(await run(0)).toBe(false)
    // Two parallel requests the network reordered still pass once each.
    expect(await run(5)).toBe(true)
    expect(await run(4)).toBe(true)
    expect(await run(4)).toBe(false)
    expect(await run(5)).toBe(false)
    expect(ran).toBe(3)
    // A stored frame sent again later is a replay too.
    const stored = await sealRequest(keys, 9, bytes('stored'))
    expect(await openRequest(keys, window, stored)).not.toBeNull()
    expect(await openRequest(keys, window, stored)).toBeNull()
  })

  it('AC-3.3 the replay window is 64 wide: older counters are refused, the oldest inside is not', () => {
    const window = createReplayWindow()
    expect(window.accept(100)).toBe(true)
    expect(window.accept(100)).toBe(false)
    expect(window.accept(36)).toBe(false)
    expect(window.accept(37)).toBe(true)
    expect(window.accept(37)).toBe(false)
    expect(window.accept(99)).toBe(true)
    expect(window.accept(99)).toBe(false)
    expect(window.accept(500)).toBe(true)
    expect(window.accept(100)).toBe(false)
    expect(window.accept(437)).toBe(true)
    expect(window.accept(436)).toBe(false)
    expect(window.accept(-1)).toBe(false)
    expect(window.accept(1.5)).toBe(false)
    expect(window.accept(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
    expect(window.accept(Number.NaN)).toBe(false)
    const fresh = createReplayWindow()
    for (let ctr = 0; ctr < 200; ctr++) expect(fresh.accept(ctr), String(ctr)).toBe(true)
    for (let ctr = 0; ctr < 200; ctr++) expect(fresh.accept(ctr), `again ${ctr}`).toBe(false)
  })

  it('AC-3.3 an answer opens only against the counter of its own request', async () => {
    const keys = await newKeys()
    const three = await sealAnswer(keys, 3, bytes('three'))
    const four = await sealAnswer(keys, 4, bytes('four'))
    expect(await openAnswer(keys, 3, three)).toEqual(bytes('three'))
    expect(await openAnswer(keys, 4, three)).toBeNull()
    expect(await openAnswer(keys, 4, { ...three, ctr: 4 })).toBeNull()
    expect(await openAnswer(keys, 3, { ...four, ctr: 3 })).toBeNull()
    expect(await openAnswer(keys, 4, four)).toEqual(bytes('four'))
  })

  it('AC-3.7 a session negotiated at the previous version seals and opens at that version only', async () => {
    const keys = await newKeys(RELAY_PROTOCOL.previous)
    const request = await sealRequest(keys, 0, bytes('old'))
    expect(request.v).toBe(RELAY_PROTOCOL.previous)
    expect(await openRequest(keys, createReplayWindow(), request)).toEqual(bytes('old'))
    expect(await openRequest(keys, createReplayWindow(), { ...request, v: RELAY_PROTOCOL.current })).toBeNull()
  })
})

describe('handshake (spec 027 T6)', () => {
  interface Signing {
    publicKey: PublicJwk
    privateJwk: PublicJwk
    sign(data: Uint8Array): Promise<Uint8Array>
  }
  const signingPair = async (): Promise<Signing> => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as unknown as PublicJwk
    return { publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, privateJwk, sign: (data) => signEs256(privateJwk, data) }
  }
  const random = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

  const world = async () => {
    const identity = await signingPair()
    const device = await signingPair()
    const known = new Map<string, PublicJwk>([['dev-1', device.publicKey]])
    const clock = { t: 1_700_000_000_000 }
    const pc = (own: Signing = identity) =>
      createPcHandshake({ identity: { publicKey: own.publicKey, sign: own.sign }, deviceKey: (id) => known.get(id) ?? null, random, now: () => clock.t })
    const phone = (options: { version?: number; device?: { id: string; sign: Signing['sign'] } | null } = {}) =>
      createPhoneHandshake({ device: options.device === undefined ? { id: 'dev-1', sign: device.sign } : options.device, random, version: options.version })
    return { identity, device, known, clock, pc, phone }
  }
  type World = Awaited<ReturnType<typeof world>>

  interface Run {
    hs1: Extract<RelayFrame, { t: 'hs1' }>
    hs2?: Extract<RelayFrame, { t: 'hs2' }>
    hs3?: Extract<RelayFrame, { t: 'hs3' }>
    hs4?: RelayFrame
    startFail?: string
    phoneFail?: string
    outcome?: HandshakeOutcome
    phoneKeys?: SessionKeys | null
  }
  /** Drives both sides over JSON-cloned frames. `tamper` is the relay: it may rewrite a frame in flight. */
  const drive = async (
    pc: ReturnType<World['pc']>,
    phone: ReturnType<World['phone']>,
    expect: { pcKey?: PublicJwk; fingerprint?: string },
    tamper: Partial<Record<'hs1' | 'hs2' | 'hs3' | 'hs4', (frame: Record<string, string>) => unknown>> = {}
  ): Promise<Run> => {
    const hs1 = (await phone.hs1()) as Run['hs1']
    const run: Run = { hs1 }
    const hs2 = await pc.start((tamper.hs1 ?? wire)(wire(hs1) as never))
    if ('fail' in hs2) return { ...run, startFail: hs2.fail }
    run.hs2 = hs2 as Run['hs2']
    const hs3 = await phone.onHs2((tamper.hs2 ?? wire)(wire(hs2) as never), expect)
    if ('fail' in hs3) return { ...run, phoneFail: hs3.fail }
    run.hs3 = hs3 as Run['hs3']
    const done = await pc.finish((tamper.hs3 ?? wire)(wire(hs3) as never))
    run.outcome = done.outcome
    run.hs4 = done.hs4
    if (done.hs4) run.phoneKeys = await phone.onHs4((tamper.hs4 ?? wire)(wire(done.hs4) as never))
    return run
  }

  it('handshake: a known device and the PC agree on keys, in both directions, and the frames pass the wire schema', async () => {
    const w = await world()
    const run = await drive(w.pc(), w.phone(), { pcKey: w.identity.publicKey })
    expect(run.outcome?.ok).toBe(true)
    if (!run.outcome?.ok || !run.phoneKeys) throw new Error('handshake failed')
    expect(run.outcome.device).toEqual({ id: 'dev-1' })
    expect(run.outcome.keys.sid).toBe(run.phoneKeys.sid)
    for (const frame of [run.hs1, run.hs2, run.hs3, run.hs4]) expect(relayFrameSchema.safeParse(frame).success, JSON.stringify(frame).slice(0, 40)).toBe(true)
    const request = await sealRequest(run.phoneKeys, 0, bytes('ask'))
    expect(await openRequest(run.outcome.keys, createReplayWindow(), request)).toEqual(bytes('ask'))
    const answer = await sealAnswer(run.outcome.keys, 0, bytes('reply'))
    expect(await openAnswer(run.phoneKeys, 0, answer)).toEqual(bytes('reply'))
    // The device id and its signature never cross the relay in clear.
    expect(JSON.stringify([run.hs1, run.hs2, run.hs3, run.hs4])).not.toContain('dev-1')
  })

  it('AC-3.4 a relay that substitutes a key or any signed field fails the handshake and the phone sends nothing', async () => {
    const w = await world()
    const attacker = await signingPair()
    const stranger = (await createPhoneHandshake({ device: null, random }).hs1()) as Run['hs1']
    const stored = { pcKey: w.identity.publicKey }
    expect((await drive(w.pc(), w.phone(), stored, { hs2: (f) => ({ ...f, eb: stranger.ea }) })).phoneFail).toBe('signature')
    expect((await drive(w.pc(), w.phone(), stored, { hs1: (f) => ({ ...f, ea: stranger.ea }) })).phoneFail).toBe('signature')
    for (const field of ['nb', 'sid'] as const) {
      const other = b64u.encode(random(16))
      expect((await drive(w.pc(), w.phone(), stored, { hs2: (f) => ({ ...f, [field]: other }) })).phoneFail, field).toBe('signature')
    }
    // The relay terminates the handshake itself with its own identity key and a validly signed transcript.
    const mitm = await drive(w.pc(attacker), w.phone(), stored)
    expect(mitm.phoneFail).toBe('signature')
    expect(mitm.hs3).toBeUndefined()
    // Swapping only the key in a genuine hs2 fails too.
    expect((await drive(w.pc(), w.phone(), stored, { hs2: (f) => ({ ...f, pc: attacker.publicKey }) })).phoneFail).toBe('signature')
    // Nothing known about the PC means nothing to check against, and the phone refuses rather than trust.
    expect((await drive(w.pc(), w.phone(), {})).phoneFail).toBe('fingerprint')
    // A tampered hs3 or hs4 ends the handshake.
    expect((await drive(w.pc(), w.phone(), stored, { hs3: (f) => ({ ...f, ct: flip(f.ct) }) })).outcome).toEqual({ ok: false, reason: 'malformed' })
    expect((await drive(w.pc(), w.phone(), stored, { hs4: (f) => ({ ...f, ct: flip(f.ct) }) })).phoneKeys).toBeNull()
  })

  const flip = (ct: string): string => {
    const raw = b64u.decode(ct)
    raw[0] ^= 1
    return b64u.encode(raw)
  }

  it('AC-4.2 the fingerprint from the QR decides at pairing: a relay in the middle is caught before anything is sent', async () => {
    const w = await world()
    const attacker = await signingPair()
    const real = await fingerprint(w.identity.publicKey)
    const paired = await drive(w.pc(), w.phone({ device: null }), { fingerprint: real })
    expect(paired.outcome?.ok).toBe(true)
    const mitm = await drive(w.pc(attacker), w.phone({ device: null }), { fingerprint: real })
    expect(mitm.phoneFail).toBe('fingerprint')
    expect(mitm.hs3).toBeUndefined()
    expect(mitm.outcome).toBeUndefined()
    expect((await drive(w.pc(), w.phone({ device: null }), { fingerprint: await fingerprint(attacker.publicKey) })).phoneFail).toBe('fingerprint')
    expect((await drive(w.pc(), w.phone({ device: null }), { fingerprint: '' })).phoneFail).toBe('fingerprint')
    // A key that matches the fingerprint but signs nothing for this transcript still fails the signature.
    expect((await drive(w.pc(), w.phone({ device: null }), { fingerprint: real }, { hs2: (f) => ({ ...f, sig: b64u.encode(random(64)) }) })).phoneFail).toBe('signature')
  })

  it('AC-3.4 a known device signs hs3; a revoked, unknown or wrongly signing device gets the same refusal and no hs4', async () => {
    const w = await world()
    const stored = { pcKey: w.identity.publicKey }
    const refusals: unknown[] = []
    // Revoked: the lookup now answers null, exactly as for a device that never existed.
    w.known.delete('dev-1')
    refusals.push((await drive(w.pc(), w.phone(), stored)).outcome)
    refusals.push((await drive(w.pc(), w.phone({ device: { id: 'never-seen', sign: w.device.sign } }), stored)).outcome)
    // Known id, signature by another key.
    w.known.set('dev-1', w.device.publicKey)
    const other = await signingPair()
    refusals.push((await drive(w.pc(), w.phone({ device: { id: 'dev-1', sign: other.sign } }), stored)).outcome)
    for (const refusal of refusals) expect(refusal).toEqual({ ok: false, reason: 'unknown-device' })
    const refused = await drive(w.pc(), w.phone({ device: { id: 'dev-1', sign: other.sign } }), stored)
    expect(refused.hs4).toBeUndefined()
    expect(refused.phoneKeys).toBeUndefined()
    // A signature made for one session does not carry to another.
    let captured: Uint8Array = new Uint8Array()
    const first = await drive(w.pc(), w.phone({ device: { id: 'dev-1', sign: async (data) => (captured = await w.device.sign(data)) } }), stored)
    expect(first.outcome?.ok).toBe(true)
    const replayed = await drive(w.pc(), w.phone({ device: { id: 'dev-1', sign: async () => captured } }), stored)
    expect(replayed.outcome).toEqual({ ok: false, reason: 'unknown-device' })
  })

  it('AC-3.4 an anonymous hs3 is accepted only as anonymous, never as a device', async () => {
    const w = await world()
    const run = await drive(w.pc(), w.phone({ device: null }), { pcKey: w.identity.publicKey })
    expect(run.outcome?.ok && run.outcome.device).toBe('anonymous')
    expect(run.phoneKeys).not.toBeNull()
  })

  it('AC-3.7 parseRelayFrame names the version when the shape is right or not, and malformed otherwise', () => {
    const good = { v: 1, t: 'hs1', ea: text(65), na: text(16) }
    expect(parseRelayFrame(good)).toEqual({ ok: true, frame: good })
    expect(parseRelayFrame({ ...good, v: 0 }).ok).toBe(true)
    expect(parseRelayFrame({ ...good, v: 2 })).toEqual({ ok: false, reason: 'version' })
    expect(parseRelayFrame({ v: 7, t: 'anything', other: [1] })).toEqual({ ok: false, reason: 'version' })
    expect(parseRelayFrame({ ...good, v: -1 })).toEqual({ ok: false, reason: 'version' })
    for (const raw of [null, 'x', [], {}, { ...good, v: '1' }, { ...good, v: 1.5 }, { ...good, v: Number.NaN }, { ...good, extra: 1 }, { ...good, ea: '***' }]) {
      expect(parseRelayFrame(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  it('AC-3.7 the previous version is accepted and the session runs at it; any other is refused with its cause and nothing is downgraded', async () => {
    const w = await world()
    const stored = { pcKey: w.identity.publicKey }
    const old = await drive(w.pc(), w.phone({ version: RELAY_PROTOCOL.previous }), stored)
    expect(old.hs2?.v).toBe(RELAY_PROTOCOL.previous)
    expect(old.outcome?.ok && old.outcome.keys.v).toBe(RELAY_PROTOCOL.previous)
    expect(old.phoneKeys?.v).toBe(RELAY_PROTOCOL.previous)
    for (const v of [2, 3, 99, -1]) {
      expect((await drive(w.pc(), w.phone({ version: v }), stored)).startFail, String(v)).toBe('version')
    }
    expect((await drive(w.pc(), w.phone(), stored, { hs1: (f) => ({ ...f, v: 'one' }) })).startFail).toBe('malformed')
    // A relay that downgrades the answer is refused by the phone before any signature work.
    expect((await drive(w.pc(), w.phone(), stored, { hs2: (f) => ({ ...f, v: RELAY_PROTOCOL.previous }) })).phoneFail).toBe('version')
    expect((await drive(w.pc(), w.phone(), stored, { hs2: (f) => ({ ...f, v: 9 }) })).phoneFail).toBe('version')
    // hs3 at another version than the one negotiated ends the handshake.
    expect((await drive(w.pc(), w.phone(), stored, { hs3: (f) => ({ ...f, v: RELAY_PROTOCOL.previous }) })).outcome).toEqual({ ok: false, reason: 'version' })
    expect((await drive(w.pc(), w.phone(), stored, { hs3: (f) => ({ ...f, v: 5 }) })).outcome).toEqual({ ok: false, reason: 'version' })
  })

  it('handshake: malformed input, a wrong order and a second use are refused without throwing', async () => {
    const w = await world()
    const pc = w.pc()
    expect((await pc.finish({})).outcome).toEqual({ ok: false, reason: 'malformed' })
    expect(await pc.start({ v: 1, t: 'hs3', sid: text(16), ct: text(40) })).toEqual({ fail: 'malformed' })
    expect(await pc.start({ v: 1, t: 'hs1', ea: text(65), na: text(16) })).toEqual({ fail: 'malformed' })
    expect(await pc.start({ v: 1, t: 'hs1', ea: text(10), na: text(16) })).toEqual({ fail: 'malformed' })
    const phone = w.phone()
    expect(await phone.onHs2({}, { pcKey: w.identity.publicKey })).toEqual({ fail: 'malformed' })
    expect(await phone.onHs4({})).toBeNull()
    const run = await drive(w.pc(), w.phone(), { pcKey: w.identity.publicKey })
    const again = w.pc()
    await again.start(run.hs1)
    await again.finish(run.hs3)
    expect((await again.finish(run.hs3)).outcome).toEqual({ ok: false, reason: 'malformed' })
    // hs4 for another session or sealed in the wrong direction yields no keys.
    const a = await drive(w.pc(), w.phone(), { pcKey: w.identity.publicKey })
    const other = await drive(w.pc(), w.phone(), { pcKey: w.identity.publicKey })
    const mismatched = w.phone()
    await mismatched.hs1()
    expect(await mismatched.onHs4(other.hs4)).toBeNull()
    expect(a.phoneKeys).toBeTruthy()
  })

  it('AC-3.5 past traffic stays sealed after the long-term keys leak', async () => {
    const w = await world()
    const run = await drive(w.pc(), w.phone(), { pcKey: w.identity.publicKey })
    if (!run.hs2 || !run.hs3 || !run.hs4 || !run.phoneKeys) throw new Error('handshake failed')
    const recorded = [run.hs1, run.hs2, run.hs3, run.hs4, await sealRequest(run.phoneKeys, 0, bytes('MARKER'))]
    const th = await transcriptHash(run.hs1, run.hs2)
    // The adversary holds both long-term private keys and every recorded byte, and tries them as the ECDH secret.
    for (const leaked of [w.identity.privateJwk, w.device.privateJwk]) {
      const asEcdh = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: leaked.x, y: leaked.y, d: (leaked as { d?: string }).d }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
      for (const peer of [run.hs1.ea, run.hs2.eb]) {
        const z = await ecdhSecret(asEcdh, b64u.decode(peer))
        if (!z) throw new Error('no secret')
        const keys = await deriveKeys(z, th)
        const sid = run.hs2.sid
        expect(await aesOpen(keys.hsC2s, nonceFor(0), b64u.decode(run.hs3.ct), frameAad(run.hs2.v, 'hs3', sid, 0))).toBeNull()
        expect(await aesOpen(keys.hsS2c, nonceFor(0), b64u.decode((run.hs4 as SealedFrame).ct), frameAad(run.hs2.v, 'hs4', sid, 0))).toBeNull()
        expect(await openRequest({ v: run.hs2.v, sid, c2s: keys.c2s, s2c: keys.s2c, expiresAt: 0 }, createReplayWindow(), recorded[4] as SealedFrame)).toBeNull()
      }
    }
    expect(JSON.stringify(recorded)).not.toContain('MARKER')
  })

  it('AC-3.11 every connection gets new ephemeral keys and a new session id, and one session cannot open another', async () => {
    const w = await world()
    const stored = { pcKey: w.identity.publicKey }
    const one = await drive(w.pc(), w.phone(), stored)
    const two = await drive(w.pc(), w.phone(), stored)
    if (!one.phoneKeys || !two.phoneKeys || !one.hs2 || !two.hs2) throw new Error('handshake failed')
    expect(one.hs1.ea).not.toBe(two.hs1.ea)
    expect(one.hs2.eb).not.toBe(two.hs2.eb)
    expect(one.phoneKeys.sid).not.toBe(two.phoneKeys.sid)
    const request = await sealRequest(one.phoneKeys, 0, bytes('first'))
    // Even relabelled with the other session's id, the old keys do not open under the new ones.
    expect(await openRequest(two.phoneKeys, createReplayWindow(), { ...request, sid: two.phoneKeys.sid })).toBeNull()
  })

  it('AC-3.11 the session ends at one hour: hs4 carries the expiry and the check flips exactly there', async () => {
    const w = await world()
    const run = await drive(w.pc(), w.phone(), { pcKey: w.identity.publicKey })
    if (!run.outcome?.ok || !run.phoneKeys) throw new Error('handshake failed')
    expect(SESSION_LIFETIME_MS).toBe(3_600_000)
    expect(run.outcome.keys.expiresAt).toBe(w.clock.t + SESSION_LIFETIME_MS)
    expect(run.phoneKeys.expiresAt).toBe(run.outcome.keys.expiresAt)
    expect(sessionExpired(run.outcome.keys, w.clock.t + SESSION_LIFETIME_MS - 1)).toBe(false)
    expect(sessionExpired(run.outcome.keys, w.clock.t + SESSION_LIFETIME_MS)).toBe(true)
    expect(sessionExpired(run.outcome.keys, w.clock.t + SESSION_LIFETIME_MS + 1)).toBe(true)
  })
})

describe('a frame that fails authentication stops before the handler (spec 027 T15)', () => {
  const flip = (frame: SealedFrame, at = 0): SealedFrame => {
    const ct = b64u.decode(frame.ct)
    ct[at] ^= 1
    return { ...frame, ct: b64u.encode(ct) }
  }
  const plain = new TextEncoder().encode(JSON.stringify({ k: 'req', method: 'GET', path: '/api/x' }))

  it('AC-2.6 a frame that fails authentication is dropped before the handler, and the session it named is over', async () => {
    const rig = await hostRig()
    const phone = rig.phone()
    await phone.connect()
    const keys = phone.keys as SessionKeys
    const good = await sealRequest(keys, 5, plain)
    const size = b64u.decode(good.ct).length
    for (const at of [0, 1, Math.floor(size / 2), size - 1]) {
      // Each tampered frame ends the session, so a fresh one is made for the next.
      expect(await phone.submit(flip(good, at)), `byte ${at}`).toBe('gone')
      expect(await phone.connect()).toEqual({ ok: true })
    }
    expect(await phone.submit({ ...good, sid: b64u.encode(random(16)) })).toBe('gone')
    expect(await phone.submit({ ...good, v: RELAY_PROTOCOL.previous })).toBe('gone')
    expect(rig.calls).toHaveLength(0)
    // The tampered frame ended the session: the genuine frame that follows finds none.
    const next = rig.phone()
    await next.connect()
    const frame = await sealRequest(next.keys as SessionKeys, 0, plain)
    expect(await next.submit(flip(frame))).toBe('gone')
    expect(await next.submit(frame)).toBe('gone')
    expect(rig.calls).toHaveLength(0)
  })

  it('AC-2.6 a replayed frame never runs twice, and frames of the wrong kind or for an unknown session are refused', async () => {
    const rig = await hostRig()
    const phone = rig.phone()
    await phone.connect()
    const frame = await sealRequest(phone.keys as SessionKeys, 0, plain)
    expect(await phone.submit(frame)).not.toBe('gone')
    expect(rig.calls).toHaveLength(1)
    expect(await phone.submit(frame)).toBe('gone')
    expect(rig.calls).toHaveLength(1)
    const other = rig.phone()
    await other.connect()
    const answer = await sealAnswer(other.keys as SessionKeys, 0, plain)
    expect(await other.submit(answer)).toBe('gone')
    expect(await other.submit({ v: RELAY_PROTOCOL.current, t: 'hs4', sid: (other.keys as SessionKeys).sid, ct: frame.ct })).toBe('gone')
    expect(await other.submit({ v: RELAY_PROTOCOL.current, t: 'hs3', sid: b64u.encode(random(16)), ct: frame.ct })).toBe('gone')
    expect(await other.submit({ v: RELAY_PROTOCOL.current, t: 'hs1', ea: 'AAAA', na: 'AAAA' })).toBe('gone')
    expect(rig.calls).toHaveLength(1)
  })

  it('AC-3.2 a request in flight on a session that a tampered frame ends is cancelled, as a dropped connection is', async () => {
    let signal: AbortSignal | null = null
    const rig = await hostRig({
      handler: (_request, given) => {
        signal = given
        return new Promise((resolve) => given.addEventListener('abort', () => resolve({ status: 499 })))
      }
    })
    const phone = rig.phone()
    await phone.connect()
    const keys = phone.keys as SessionKeys
    const slow = phone.submit(await sealRequest(keys, 0, plain))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((signal as AbortSignal | null)?.aborted).toBe(false)
    expect(await phone.submit(flip(await sealRequest(keys, 1, plain)))).toBe('gone')
    expect((signal as AbortSignal | null)?.aborted).toBe(true)
    expect(await slow).toBe('gone')
  })
})

describe('adversarial runs over the relay pair (spec 027 T18)', () => {
  const realImmediate = globalThis.setImmediate
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; !done() && i < 5000; i++) await new Promise((resolve) => realImmediate(resolve))
    expect(done()).toBe(true)
  }
  const ALL = { chat: true, approve: true, home: true, cameras: true, vault: true, history: true }

  it('AC-3.1 the relay recording holds no plaintext marker after chat, a note, a conversation, an approval, a control, a still and a push subscription', async () => {
    await onThePair(async () => {
      const MARK = {
        chat: 'MARKER-CHAT-7c1d9a',
        notePath: 'MARKER-NOTE-PATH',
        noteBody: 'MARKER-NOTE-BODY-3e8f',
        thread: 'MARKER-THREAD-TITLE-51',
        threadText: 'MARKER-THREAD-TEXT-9a',
        command: 'MARKER-APPROVAL-CMD-b2',
        image: 'MARKER-IMAGE-BYTES-0f',
        push: 'MARKER-PUSH-ENDPOINT-4c'
      }
      const { t, pair, headers, token, deviceId } = await served({ cameras: ['camera.patio'], scopes: ALL })
      const call = (method: string, path: string, body?: unknown, query?: string) => t.transport.request({ method, path, query, headers, body })
      const crossed: unknown[] = []

      crossed.push((await call('POST', '/api/chat/send', { text: MARK.chat })).body)
      t.vault.put(`${MARK.notePath}/leer.md`, MARK.noteBody)
      crossed.push((await call('POST', '/api/notes/list', { folder: '' })).body)
      crossed.push((await call('POST', '/api/notes/read', { path: `${MARK.notePath}/leer.md` })).body)
      t.chat.threads.push({ ...makeThread('talk'), title: MARK.thread, updatedAt: 5, messages: [{ role: 'user', content: [{ type: 'text', text: MARK.threadText }], ts: 1 }] })
      crossed.push((await call('POST', '/api/threads/list', { offset: 0 })).body)
      crossed.push((await call('POST', '/api/threads/read', { id: 'talk' })).body)
      const asked = t.approvals.askApproval({ threadId: 'remote', toolUseId: 'tu1', toolName: 'run_command', input: { command: MARK.command }, flagged: false, reason: 'r', allowAlways: true })
      const listed = await call('GET', '/api/approvals')
      crossed.push(listed.body)
      expect((await call('POST', '/api/approvals/answer', { id: asked.approvalId, decision: 'allow' })).status).toBe(200)
      expect((await call('POST', '/api/home/control', { thing: 'light.techo', action: 'on' })).status).toBe(200)
      t.setAlwaysAllowTools(['camera_look'])
      t.home.snapshotBytes = Buffer.from(MARK.image)
      const still = await call('GET', '/api/cameras/still', undefined, 'id=camera.patio')
      expect(still.status).toBe(200)
      expect((still.body as { photo: string }).photo).toBe(Buffer.from(MARK.image).toString('base64'))
      const subscribed = await call('POST', '/api/push/subscribe', { endpoint: `https://fcm.googleapis.com/fcm/send/${MARK.push}`, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) } })
      expect(subscribed.status).toBe(200)

      // The data really crossed: the answers carry the markers the relay must not see.
      const text = JSON.stringify(crossed)
      for (const marker of [MARK.notePath, MARK.noteBody, MARK.thread, MARK.threadText, MARK.command]) expect(text, marker).toContain(marker)
      const recorded = pair.relay.tap
      expect(recorded.of('phoneToRelay').length).toBeGreaterThanOrEqual(12)
      expect(recorded.leaks([...Object.values(MARK), token, deviceId, 'light.techo', '/api/chat/send', '/api/notes/read', '/api/cameras/still', 'id=camera.patio', '/api/home/control', 'Authorization', 'authorization'])).toEqual([])
    })
  })

  const flipCt = (text: string): string => {
    const message = JSON.parse(text)
    const ct: string = message.frame.ct
    message.frame.ct = `${ct.startsWith('A') ? 'B' : 'A'}${ct.slice(1)}`
    return JSON.stringify(message)
  }
  const tampers: Array<[string, (text: string) => string]> = [
    ['a flipped bit', flipCt],
    ['a truncation', (text) => { const m = JSON.parse(text); m.frame.ct = m.frame.ct.slice(0, -8); return JSON.stringify(m) }],
    ['a swapped direction', (text) => { const m = JSON.parse(text); m.frame.t = 'a'; return JSON.stringify(m) }],
    ['a frame from another session', (text) => { const m = JSON.parse(text); m.frame.sid = b64u.encode(new Uint8Array(16).fill(9)); return JSON.stringify(m) }]
  ]

  it.each(tampers)('AC-3.2 %s on the way to the PC never reaches the handler and the phone starts a new session by itself', async (_name, tamper) => {
    await onThePair(async () => {
      const { t, pair, headers } = await served({ scopes: ALL })
      const status = () => t.transport.request({ method: 'GET', path: '/api/status', headers })
      expect((await status()).status).toBe(200)
      const calls = pair.handlerCalls
      let altered = 0
      pair.relay.tamper.relayToPc = (text) => {
        const message = JSON.parse(text)
        if (message.k !== 'f' || message.frame.t !== 'q' || altered++ > 0) return text
        return tamper(text)
      }
      expect((await status()).status).toBe(200)
      // The altered frame was dropped at the PC; only the genuine retry on a new session reached the channel.
      expect(altered).toBeGreaterThanOrEqual(1)
      expect(pair.handlerCalls).toBe(calls + 1)
    })
  })

  it('AC-3.3 a replayed frame and a reordered pair never run an effect twice', async () => {
    await onThePair(async () => {
      const { t, pair, headers } = await served({ scopes: ALL })
      const raw = (path: string, body: unknown) => JSON.stringify({ k: 'req', method: 'POST', path, headers: { authorization: headers.authorization ?? '' }, body })
      const phone = pair.newPhone()
      expect(await phone.connect()).toEqual({ ok: true })
      // Replay: the relay stores the frame and sends it again, to the PC and as the phone.
      expect(await phone.request(raw('/api/home/control', { thing: 'light.techo', action: 'on' }))).toMatchObject({ ok: true })
      expect(t.home.calls).toHaveLength(1)
      await pair.relay.replay('relayToPc')
      await pair.relay.replay('phoneToRelay')
      await pair.relay.idle()
      expect(t.home.calls).toHaveLength(1)
      // The replay ended that session; a new one works, and a reordered pair runs each request once.
      const second = pair.newPhone()
      expect(await second.connect()).toEqual({ ok: true })
      const held: string[] = []
      pair.relay.tamper.relayToPc = (text) => {
        const message = JSON.parse(text)
        if (message.k === 'f' && message.frame.t === 'q' && held.length === 0) {
          held.push(text)
          return null
        }
        return text
      }
      const first = second.request(raw('/api/home/control', { thing: 'light.techo', action: 'off' }))
      await until(() => held.length === 1)
      delete pair.relay.tamper.relayToPc
      expect(await second.request(raw('/api/home/control', { thing: 'light.techo', action: 'on' }))).toMatchObject({ ok: true })
      pair.relay.injectToPc(held[0] ?? '')
      expect(await first).toMatchObject({ ok: true })
      expect(t.home.calls.map((call) => call.service)).toEqual(['light/turn_on', 'light/turn_on', 'light/turn_off'])
      // Delivering the late frame again does nothing.
      pair.relay.injectToPc(held[0] ?? '')
      await pair.relay.idle()
      expect(t.home.calls).toHaveLength(3)
    })
  })

  it('AC-3.4 a relay that substitutes a handshake key makes the handshake fail and nothing is sent', async () => {
    await onThePair(async () => {
      const { t, pair } = await served({ scopes: ALL })
      const calls = pair.handlerCalls
      const stranger = new FakePhone(pair.relay, { device: null, expect: { pcKey: (pair.identity as { publicKey: PublicJwk }).publicKey } })
      const swap = (field: 'ea' | 'eb', frame: 'hs1' | 'hs2') => (text: string) => {
        const message = JSON.parse(text)
        if (message.t === frame) message[field] = b64u.encode(new Uint8Array([4, ...new Uint8Array(64).fill(7)]))
        return JSON.stringify(message)
      }
      pair.relay.tamper.relayToPhone = swap('eb', 'hs2')
      const before = pair.relay.tap.of('phoneToRelay').length
      expect(await stranger.connect()).toEqual({ ok: false, reason: 'signature' })
      expect(pair.relay.tap.of('phoneToRelay').length).toBe(before + 1)
      delete pair.relay.tamper.relayToPhone
      pair.relay.tamper.phoneToRelay = swap('ea', 'hs1')
      expect(await stranger.connect()).toMatchObject({ ok: false })
      delete pair.relay.tamper.phoneToRelay
      expect(pair.handlerCalls).toBe(calls)
      expect(t.store.devices().length).toBe(1)
    })
  })

  it('AC-3.5 past traffic stays sealed after both long-term keys leak', async () => {
    await onThePair(async () => {
      const { t, pair, headers, privateKey } = await served({ scopes: ALL })
      for (let i = 0; i < 3; i++) await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: `MARKER-FS-${i}-aaaa` } })
      const frames = pair.relay.tap.records.flatMap((record) => {
        try {
          const parsed = JSON.parse(record.text)
          return [parsed.frame ?? parsed]
        } catch {
          return []
        }
      }) as Array<{ t: string; v: number; sid: string; ctr?: number; ct?: string; ea?: string; eb?: string }>
      const hs1 = frames.find((frame) => frame.t === 'hs1')
      const hs2 = frames.find((frame) => frame.t === 'hs2')
      if (!hs1 || !hs2) throw new Error('no handshake recorded')
      const th = await transcriptHash(hs1 as never, hs2 as never)
      const sealed = frames.filter((frame) => frame.ct)
      expect(sealed.length).toBeGreaterThanOrEqual(5)
      // The adversary holds the PC identity key and the device key, and every byte the relay saw.
      const device = await crypto.subtle.exportKey('jwk', privateKey)
      let tried = 0
      for (const leaked of [pair.identity?.privateJwk as PublicJwk & { d?: string }, device as PublicJwk & { d?: string }]) {
        const asEcdh = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: leaked.x, y: leaked.y, d: leaked.d }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
        for (const peer of [hs1.ea, hs2.eb]) {
          const z = await ecdhSecret(asEcdh, b64u.decode(peer ?? ''))
          if (!z) throw new Error('no secret')
          const keys = await deriveKeys(z, th)
          for (const frame of sealed) {
            for (const key of Object.values(keys)) {
              tried++
              expect(await aesOpen(key, nonceFor(frame.ctr ?? 0), b64u.decode(frame.ct ?? ''), frameAad(frame.v, frame.t, frame.sid, frame.ctr ?? 0))).toBeNull()
            }
          }
        }
      }
      expect(tried).toBeGreaterThan(40)
    })
  })
})
