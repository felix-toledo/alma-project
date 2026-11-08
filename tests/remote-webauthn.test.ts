import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { b64u } from '../src/shared/remote/crypto'
import {
  derToRawSignature,
  verifyAssertion,
  verifyRegistration,
  WEBAUTHN_MAX_CBOR,
  WEBAUTHN_MAX_DEPTH,
  type WebauthnError
} from '../src/shared/remote/webauthn'
import { encodeCbor, fakeAssertion, fakeAttestation, fakeCredential, rawToDer } from './support/webauthn-fake'

const RP = 'pc.ts.net'
const ORIGIN = 'https://pc.ts.net'
const CHALLENGE = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

describe('webauthn fake (spec 026 T17 support)', () => {
  it('the CBOR writer matches hand-computed bytes', () => {
    expect([...encodeCbor(new Map([[1, 2]]))]).toEqual([0xa1, 0x01, 0x02])
    expect([...encodeCbor(new Map([['fmt', 'none']]))]).toEqual([
      0xa1, 0x63, 0x66, 0x6d, 0x74, 0x64, 0x6e, 0x6f, 0x6e, 0x65
    ])
    expect([...encodeCbor(-7)]).toEqual([0x26])
    expect([...encodeCbor(new Uint8Array(32).fill(9))].slice(0, 2)).toEqual([0x58, 0x20])
  })

  it('the DER signature verifies under node:crypto, independent of the verifier', async () => {
    const credential = await fakeCredential()
    const assertion = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 1 })
    const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', assertion.clientDataJSON as unknown as ArrayBuffer))
    const signed = new Uint8Array([...assertion.authenticatorData, ...clientHash])
    const key = createPublicKey({ key: credential.publicKey, format: 'jwk' })
    expect(verify('sha256', signed, key, assertion.signature)).toBe(true)
  })
})

describe('webauthn verification (spec 026 T17)', () => {
  it('AC-4.13 a valid none-attestation registration returns the credential and key', async () => {
    const credential = await fakeCredential()
    const made = await fakeAttestation(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP })
    const result = await verifyRegistration({
      attestationObject: made.attestationObject,
      clientDataJSON: made.clientDataJSON,
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP
    })
    if (!result.ok) throw new Error(`registration failed: ${result.error}`)
    expect(result.credentialId).toEqual(credential.credentialId)
    expect(result.publicKey).toMatchObject({ kty: 'EC', crv: 'P-256', x: credential.publicKey.x, y: credential.publicKey.y })
    expect(result.counter).toBe(0)
  })

  it('AC-5.13 a valid assertion verifies and returns the new counter', async () => {
    const credential = await fakeCredential()
    const made = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 7 })
    const result = await verifyAssertion({
      ...made,
      challenge: CHALLENGE,
      origin: ORIGIN,
      rpId: RP,
      publicKey: credential.publicKey,
      lastCounter: 6
    })
    expect(result).toEqual({ ok: true, counter: 7 })
  })

  it('AC-4.13 registration refuses forgeries, wrong ceremonies and malformed CBOR', async () => {
    const credential = await fakeCredential()
    const input = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP }
    const made = await fakeAttestation(credential, input)
    const check = (override: Partial<typeof made & typeof input>): Promise<WebauthnError | 'ok'> =>
      verifyRegistration({ ...made, ...input, ...override }).then((r) => (r.ok ? 'ok' : r.error))
    // Wrong ceremony.
    expect(await check({ challenge: new Uint8Array(32).fill(2) })).toBe('challenge')
    expect(await check({ origin: 'https://evil.ts.net' })).toBe('origin')
    expect(await check({ rpId: 'evil.ts.net' })).toBe('rp-id')
    const asGet = await fakeAssertion(credential, { ...input, counter: 0 })
    expect(await check({ clientDataJSON: asGet.clientDataJSON })).toBe('type')
    expect(await check({ clientDataJSON: made.clientDataJSON.slice(0, 20) })).toBe('client-data')
    // Missing user presence or verification.
    const noUp = await fakeAttestation(credential, { ...input, flags: 0x44 })
    expect(await check({ attestationObject: noUp.attestationObject })).toBe('flags')
    const noUv = await fakeAttestation(credential, { ...input, flags: 0x41 })
    expect(await check({ attestationObject: noUv.attestationObject })).toBe('flags')
    // A non-ES256 key: the COSE -7 (0x26) becomes -8, like an EdDSA key would carry.
    const cose = [...made.attestationObject]
    const at = cose.findIndex((_, i) => cose.slice(i, i + 5).join(',') === '165,1,2,3,38')
    if (at < 0) throw new Error('cose fixture setup failed')
    const eddsa = Uint8Array.from(made.attestationObject)
    eddsa[at + 4] = 0x27
    expect(await check({ attestationObject: eddsa })).toBe('key')
    // Malformed CBOR.
    expect(await check({ attestationObject: made.attestationObject.slice(0, made.attestationObject.length - 5) })).toBe('cbor')
    expect(await check({ attestationObject: new Uint8Array(WEBAUTHN_MAX_CBOR + 100).fill(7) })).toBe('cbor')
    // Indefinite framing around otherwise valid content: only the framing check refuses it.
    const probe = await fakeAssertion(credential, { ...input, counter: 0 })
    const pieces = [
      encodeCbor('fmt'),
      encodeCbor('none'),
      encodeCbor('authData'),
      encodeCbor(probe.authenticatorData),
      encodeCbor('attStmt'),
      encodeCbor(new Map())
    ]
    const indefinite = Uint8Array.from([0xbf, ...pieces.flatMap((part) => [...part]), 0xff])
    expect(await check({ attestationObject: indefinite })).toBe('cbor')
    let deep: Map<number | string, unknown> = new Map([[0, 0]])
    for (let i = 0; i < WEBAUTHN_MAX_DEPTH + 1; i++) deep = new Map([[0, deep]])
    expect(await check({ attestationObject: encodeCbor(deep as never) })).toBe('cbor')
    // A format that is not none.
    const notNone = Uint8Array.from(made.attestationObject)
    const fmtAt = [...notNone].findIndex((byte, i, all) => byte === 0x64 && all[i + 1] === 0x6e && all[i + 2] === 0x6f && all[i + 3] === 0x6e && all[i + 4] === 0x65)
    if (fmtAt < 0) throw new Error('format fixture setup failed')
    notNone[fmtAt + 1] = 0x70
    expect(await check({ attestationObject: notNone })).toBe('format')
  })

  it('AC-5.13 assertion refuses forgeries, replays and regressions, except the zero counter', async () => {
    const credential = await fakeCredential()
    const other = await fakeCredential()
    const input = { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, publicKey: credential.publicKey, lastCounter: 6 }
    const made = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 7 })
    const check = (override: Partial<typeof made & typeof input>): Promise<WebauthnError | 'ok'> =>
      verifyAssertion({ ...made, ...input, ...override }).then((r) => (r.ok ? 'ok' : r.error))
    expect(await check({ challenge: new Uint8Array(32).fill(2) })).toBe('challenge')
    expect(await check({ origin: 'https://evil.ts.net' })).toBe('origin')
    expect(await check({ rpId: 'evil.ts.net' })).toBe('rp-id')
    const created = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 7, type: 'webauthn.create' })
    expect(await check({ clientDataJSON: created.clientDataJSON })).toBe('type')
    expect(await check({ clientDataJSON: made.clientDataJSON.slice(0, 20) })).toBe('client-data')
    const noUp = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 7, flags: 0x04 })
    expect(await check({ authenticatorData: noUp.authenticatorData })).toBe('flags')
    const noUv = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 7, flags: 0x01 })
    expect(await check({ authenticatorData: noUv.authenticatorData })).toBe('flags')
    const foreign = await fakeAssertion(other, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 7 })
    expect(await check({ signature: foreign.signature })).toBe('signature')
    const flipped = Uint8Array.from(made.signature)
    flipped[flipped.length - 1] = flipped[flipped.length - 1] === 0 ? 1 : 0
    expect(await check({ signature: flipped })).toBe('signature')
    const stale = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 5 })
    expect(await check({ authenticatorData: stale.authenticatorData, signature: stale.signature })).toBe('counter')
    const replayed = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 6 })
    expect(await check({ authenticatorData: replayed.authenticatorData, signature: replayed.signature })).toBe('counter')
    expect(await check({ authenticatorData: made.authenticatorData.slice(0, 30) })).toBe('cbor')
    // Authenticators without a counter always send zero; only a moving counter is checked.
    const zero = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 0 })
    expect(await check({ authenticatorData: zero.authenticatorData, signature: zero.signature, lastCounter: 0 })).toEqual('ok')
  })

  it('AC-5.13 absurd inputs are refused quickly, never throw', async () => {
    const credential = await fakeCredential()
    const made = await fakeAssertion(credential, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP, counter: 1 })
    const base = { ...made, challenge: CHALLENGE, origin: ORIGIN, rpId: RP, publicKey: credential.publicKey, lastCounter: 0 }
    const started = Date.now()
    expect((await verifyAssertion({ ...base, authenticatorData: new Uint8Array(1_000_000).fill(0xa0) })).ok).toBe(false)
    expect(
      (await verifyRegistration({
        attestationObject: new Uint8Array(1_000_000).fill(0xa0),
        clientDataJSON: made.clientDataJSON,
        challenge: CHALLENGE,
        origin: ORIGIN,
        rpId: RP
      })).ok
    ).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('AC-4.13 the raw signature round-trips through DER', async () => {
    const { privateKey } = await fakeCredential()
    for (const text of ['step-up bytes', '0', 'x'.repeat(200)]) {
      const data = new TextEncoder().encode(text)
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data as unknown as ArrayBuffer))
      expect(raw).toHaveLength(64)
      const der = rawToDer(raw)
      expect(der[0]).toBe(0x30)
      expect(derToRawSignature(der)).toEqual(raw)
    }
    expect(b64u.encode(new Uint8Array(64).fill(1)).length).toBe(86)
  })
})
