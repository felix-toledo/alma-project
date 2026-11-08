import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { b64u, fingerprint, signEs256, verifyEs256, type PublicJwk } from '../src/shared/remote/crypto'
import {
  MAX_ATTEMPTS,
  MAX_PAIRINGS_PER_WINDOW,
  OFFER_EXPIRES_MS,
  PAIRING_LOCK_MS,
  PAIRING_WINDOW_MS,
  pairingCode,
  pairingExchanges
} from '../src/shared/remote/pairing'

const genKey = () => crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])

describe('remote crypto (spec 026 T8)', () => {
  it('base64url round trips', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255])
    expect(b64u.decode(b64u.encode(bytes))).toEqual(bytes)
    expect(b64u.encode(new Uint8Array([]))).toBe('')
    expect(b64u.decode('')).toEqual(new Uint8Array([]))
  })

  it('base64url uses the url-safe alphabet with no padding', () => {
    expect(b64u.encode(new Uint8Array([251, 255, 254, 253]))).toMatch(/^[-_A-Za-z0-9]+$/)
    expect(b64u.encode(new Uint8Array([1]))).not.toContain('=')
    expect(b64u.encode(new Uint8Array([1, 2]))).not.toContain('=')
  })

  it('fingerprint is stable and differs per key', async () => {
    const a = await genKey()
    const b = await genKey()
    const jwkA = await crypto.subtle.exportKey('jwk', a.publicKey)
    const first = await fingerprint(jwkA)
    expect(first.length).toBeGreaterThan(20)
    expect(await fingerprint(jwkA)).toBe(first)
    expect(await fingerprint(await crypto.subtle.exportKey('jwk', b.publicKey))).not.toBe(first)
    const reordered = { y: jwkA.y, x: jwkA.x, kty: jwkA.kty, crv: jwkA.crv }
    expect(await fingerprint(reordered)).toBe(first)
  })

  it('verifyEs256 accepts a good signature and rejects forgeries', async () => {
    const key = await genKey()
    const other = await genKey()
    const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
    const otherJwk = await crypto.subtle.exportKey('jwk', other.publicKey)
    const data = new TextEncoder().encode('the pairing nonce')
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, data))
    expect(await verifyEs256(jwk, data, signature)).toBe(true)
    const flipped = new Uint8Array(signature)
    flipped[0] = flipped[0] ^ 1
    expect(await verifyEs256(jwk, data, flipped)).toBe(false)
    expect(await verifyEs256(otherJwk, data, signature)).toBe(false)
    expect(await verifyEs256(jwk, data, signature.slice(0, 32))).toBe(false)
    expect(await verifyEs256(jwk, new TextEncoder().encode('other data'), signature)).toBe(false)
  })

  it('sign and verify accept keys exported with restricted usages', async () => {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    const jwk = await crypto.subtle.exportKey('jwk', key.publicKey)
    const privateJwk = await crypto.subtle.exportKey('jwk', key.privateKey)
    const data = new TextEncoder().encode('hello nonce')
    const signature = await signEs256(privateJwk, data)
    expect(await verifyEs256(jwk, data, signature)).toBe(true)
  })
})

describe('remote pairing machine (spec 026 T14)', () => {
  const PHONE_KEY = { kty: 'EC', crv: 'P-256', x: 'phone-x-value', y: 'phone-y-value' }
  const PHONE_KEY_REORDERED = {
    y: 'phone-y-value',
    ext: true,
    kty: 'EC',
    key_ops: ['verify'],
    x: 'phone-x-value',
    crv: 'P-256'
  }
  const OTHER_KEY = { kty: 'EC', crv: 'P-256', x: 'other-x-value', y: 'other-y-value' }
  const NOW = 1_000_000

  function freshOffer(now = NOW) {
    const result = pairingExchanges.newOffer({ state: 'idle', now })
    if (result.state === 'idle' || result.state.phase !== 'offered') throw new Error('offer setup failed')
    return result.state
  }

  async function accepted(now = NOW, key = PHONE_KEY, name = 'Pixel') {
    const bound = await pairingExchanges.code({ state: freshOffer(now), phoneKey: key, deviceName: name, now })
    if (!('digits' in bound)) throw new Error(`bind setup failed: ${bound.error}`)
    if (bound.state === 'idle' || bound.state.phase !== 'accepted') throw new Error('bind setup failed')
    return { state: bound.state, digits: bound.digits }
  }

  it('AC-4.5/4.6/4.9 the pairing windows and counts are the spec values', () => {
    expect(OFFER_EXPIRES_MS).toBe(180_000)
    expect(PAIRING_LOCK_MS).toBe(300_000)
    expect(MAX_ATTEMPTS).toBe(3)
    expect(PAIRING_WINDOW_MS).toBe(60_000)
    expect(MAX_PAIRINGS_PER_WINDOW).toBe(5)
  })

  it('AC-4.1/4.2/4.3 offer, present, code and approve consume the offer', async () => {
    const created = pairingExchanges.newOffer({ state: 'idle', now: NOW })
    if (!created.offer || created.state === 'idle' || created.state.phase !== 'offered') {
      throw new Error('offer setup failed')
    }
    const offer = created.state
    expect(created.offer.qr).toBe(b64u.encode(created.offer.secret))
    expect(offer.offer).toBe(created.offer.qr)

    const live = pairingExchanges.present({ state: offer, now: NOW, pcNonce: offer.pcNonce, phoneKey: '', rate: 0 })
    expect(live).toEqual({ expiresAt: NOW + OFFER_EXPIRES_MS, outcome: 'pending' })

    const bound = await pairingExchanges.code({ state: offer, phoneKey: PHONE_KEY, deviceName: 'Pixel', now: NOW })
    if (!('digits' in bound)) throw new Error(`bind failed: ${bound.error}`)
    expect(bound.digits).toMatch(/^\d{6}$/)
    if (bound.state === 'idle' || bound.state.phase !== 'accepted') throw new Error('bind failed')
    expect(bound.state.offer).toBe(offer.offer)
    expect(bound.state.secret).toEqual(offer.secret)
    expect(bound.state.accepted).toEqual({
      deviceKey: PHONE_KEY,
      deviceFp: await fingerprint(PHONE_KEY),
      deviceName: 'Pixel'
    })

    const done = await pairingExchanges.decide({ state: bound.state, now: NOW, approved: true, digits: bound.digits })
    if (!('decision' in done)) throw new Error(`decide failed: ${done.error}`)
    if (done.decision !== 'consumed') throw new Error('decide did not consume')
    expect(done.state).toBe('idle')
    expect(done.device).toEqual({ deviceKey: PHONE_KEY, deviceName: 'Pixel' })
  })

  it('AC-4.2/4.5 a status poll proves it completed the request step', async () => {
    expect(pairingExchanges.present({ state: 'idle', now: NOW, pcNonce: '', phoneKey: '', rate: 0 })).toEqual({
      expiresAt: 0,
      outcome: 'expired'
    })
    const offer = freshOffer(NOW)
    expect(pairingExchanges.present({ state: offer, now: NOW, pcNonce: 'unknown', phoneKey: '', rate: 0 }).outcome).toBe(
      'busy'
    )
    const { state: live } = await accepted(NOW)
    const wizard = pairingExchanges.present({ state: live, now: NOW, pcNonce: live.pcNonce, phoneKey: '', rate: 0 })
    expect(wizard.outcome).toBe('pending')
    const own = await fingerprint(PHONE_KEY)
    const phone = pairingExchanges.present({ state: live, now: NOW, pcNonce: live.pcNonce, phoneKey: own, rate: 0 })
    expect(phone.outcome).toBe('pending')
    const stranger = pairingExchanges.present({
      state: live,
      now: NOW,
      pcNonce: live.pcNonce,
      phoneKey: 'someone-else',
      rate: 0
    })
    expect(stranger.outcome).toBe('busy')
  })

  it('AC-4.2 the bind shows digits but issues no device, and refuses anything else', async () => {
    const { state: live, digits } = await accepted(NOW)
    const reshow = await pairingExchanges.code({ state: live, phoneKey: PHONE_KEY, deviceName: 'Changed', now: NOW })
    if (!('digits' in reshow)) throw new Error('reshow failed')
    expect(reshow.digits).toBe(digits)
    if (reshow.state === 'idle' || reshow.state.phase !== 'accepted') throw new Error('reshow failed')
    expect(reshow.state.accepted.deviceName).toBe('Pixel')
    const stolen = await pairingExchanges.code({ state: live, phoneKey: OTHER_KEY, deviceName: 'Stranger', now: NOW })
    expect('error' in stolen && stolen.error).toBe('mismatch')
    const noOffer = await pairingExchanges.code({ state: 'idle', phoneKey: PHONE_KEY, deviceName: 'Pixel', now: NOW })
    expect('error' in noOffer && noOffer.error).toBe('mismatch')
    const frozen = await pairingExchanges.code({
      state: { phase: 'locked', until: NOW + 1000 },
      phoneKey: PHONE_KEY,
      deviceName: 'Pixel',
      now: NOW
    })
    expect('error' in frozen && frozen.error).toBe('mismatch')
    const offer = freshOffer(NOW)
    const noKey = await pairingExchanges.code({
      state: offer,
      phoneKey: null as unknown as PublicJwk,
      deviceName: 'Pixel',
      now: NOW
    })
    expect('error' in noKey && noKey.error).toBe('mismatch')
  })

  it('AC-4.1 the secret comes from the injected random source', () => {
    const pinned = (n: number) => new Uint8Array(n).fill(7)
    const first = pairingExchanges.newOffer({ state: 'idle', now: NOW, random: pinned })
    const second = pairingExchanges.newOffer({ state: 'idle', now: NOW, random: pinned })
    expect(first.offer?.qr).toBeDefined()
    expect(first.offer?.qr).toBe(second.offer?.qr)
    expect(first.offer?.secret).toEqual(new Uint8Array(32).fill(7))
    if (first.state === 'idle' || first.state.phase !== 'offered') throw new Error('offer setup failed')
    expect(first.state.pcNonce).toHaveLength(22)
    const live = pairingExchanges.newOffer({ state: 'idle', now: NOW })
    const live2 = pairingExchanges.newOffer({ state: 'idle', now: NOW })
    expect(live.offer?.qr).not.toBe(live2.offer?.qr)
  })

  it('AC-4.2 the digits match on both sides whatever the key member order', async () => {
    const secret = new Uint8Array(32).fill(9)
    const pc = await pairingCode({ secret, phoneKey: PHONE_KEY, pcNonce: 'nonce-1' })
    expect(pc).toMatch(/^\d{6}$/)
    expect(await pairingCode({ secret, phoneKey: PHONE_KEY_REORDERED, pcNonce: 'nonce-1' })).toBe(pc)
    expect(await pairingCode({ secret, phoneKey: OTHER_KEY, pcNonce: 'nonce-1' })).not.toBe(pc)
    expect(await pairingCode({ secret, phoneKey: PHONE_KEY, pcNonce: 'nonce-2' })).not.toBe(pc)
  })

  it('AC-4.2 the digits are HMAC-SHA256 over the canonical key and nonce (PD-7)', async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, i) => i)
    const key = { y: 'y-bytes', kty: 'EC', x: 'x-bytes', crv: 'P-256', key_ops: ['verify'], ext: true }
    const canonical = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })
    const mac = createHmac('sha256', secret).update(`${canonical}|pc-nonce-1`, 'utf8').digest()
    const offset = mac[mac.length - 1] & 0x0f
    const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
    const expected = String(code % 1_000_000).padStart(6, '0')
    expect(await pairingCode({ secret, phoneKey: key, pcNonce: 'pc-nonce-1' })).toBe(expected)
  })

  it('AC-4.2 short codes are zero-padded to 6 digits', async () => {
    const secret = new Uint8Array(32).fill(3)
    let zeroPrefixed = ''
    for (let i = 0; i < 200 && !zeroPrefixed; i++) {
      const digits = await pairingCode({ secret, phoneKey: PHONE_KEY, pcNonce: `pad-${i}` })
      expect(digits).toMatch(/^\d{6}$/)
      if (digits.startsWith('0')) zeroPrefixed = digits
    }
    expect(zeroPrefixed.startsWith('0')).toBe(true)
  })

  it('AC-4.4/4.5/4.7 an expired offer is refused and a decided offer is single-use', async () => {
    const offer = freshOffer(NOW)
    const late = NOW + OFFER_EXPIRES_MS + 1
    const gone = pairingExchanges.present({ state: offer, now: late, pcNonce: offer.pcNonce, phoneKey: '', rate: 0 })
    expect(gone.outcome).toBe('expired')
    const bound = await pairingExchanges.code({ state: offer, phoneKey: PHONE_KEY, deviceName: 'Pixel', now: NOW })
    if (!('digits' in bound) || bound.state === 'idle' || bound.state.phase !== 'accepted') {
      throw new Error('bind setup failed')
    }
    const expired = await pairingExchanges.decide({ state: bound.state, now: late, approved: true, digits: bound.digits })
    expect('error' in expired && expired.error).toBe('expired')

    const approved = await accepted(NOW)
    const consumed = await pairingExchanges.decide({ state: approved.state, now: NOW, approved: true, digits: approved.digits })
    if (!('decision' in consumed)) throw new Error('decide setup failed')
    expect(consumed.decision).toBe('consumed')
    const again = await pairingExchanges.decide({ state: consumed.state, now: NOW, approved: true, digits: approved.digits })
    expect('error' in again && again.error).toBe('invalid')

    const denied = await accepted(NOW)
    const refused = await pairingExchanges.decide({ state: denied.state, now: NOW, approved: false, digits: 'whatever' })
    if (!('decision' in refused)) throw new Error('decide setup failed')
    expect(refused.decision).toBe('rejected')
    expect(refused.state).toBe('idle')
    const refusedAgain = await pairingExchanges.decide({ state: refused.state, now: NOW, approved: false, digits: 'whatever' })
    expect('error' in refusedAgain && refusedAgain.error).toBe('invalid')
  })

  it('AC-4.5 a new offer discards an expired one', () => {
    const offer = freshOffer(NOW)
    const next = pairingExchanges.newOffer({ state: offer, now: NOW + OFFER_EXPIRES_MS + 1 })
    if (!next.offer || next.state === 'idle' || next.state.phase !== 'offered') throw new Error('re-offer failed')
    expect(next.state.createdAt).toBe(NOW + OFFER_EXPIRES_MS + 1)
  })

  it('AC-4.5 the offer lives at 3:00 and dies right after', () => {
    const offer = freshOffer(NOW)
    const atThree = pairingExchanges.present({
      state: offer,
      now: NOW + OFFER_EXPIRES_MS,
      pcNonce: offer.pcNonce,
      phoneKey: '',
      rate: 0
    })
    expect(atThree.outcome).toBe('pending')
    const pastThree = pairingExchanges.present({
      state: offer,
      now: NOW + OFFER_EXPIRES_MS + 1,
      pcNonce: offer.pcNonce,
      phoneKey: '',
      rate: 0
    })
    expect(pastThree.outcome).toBe('expired')
  })

  it('AC-4.2/4.5/4.6 decide refuses states with nothing to decide', async () => {
    const offer = freshOffer(NOW)
    const idle = await pairingExchanges.decide({ state: 'idle', now: NOW, approved: true, digits: '123456' })
    expect('error' in idle && idle.error).toBe('invalid')
    const unaccepted = await pairingExchanges.decide({ state: offer, now: NOW, approved: true, digits: '123456' })
    expect('error' in unaccepted && unaccepted.error).toBe('invalid')
    const frozen = await pairingExchanges.decide({
      state: { phase: 'locked', until: NOW + 1000 },
      now: NOW,
      approved: true,
      digits: '123456'
    })
    expect('error' in frozen && frozen.error).toBe('locked')
  })

  it('AC-4.6 wrong digits count down and the third locks the machine for 5 minutes', async () => {
    const { state: start, digits } = await accepted(NOW)
    const wrong = digits === '000000' ? '000001' : '000000'
    const first = await pairingExchanges.decide({ state: start, now: NOW, approved: true, digits: wrong })
    if (!('error' in first) || first.state === 'idle' || first.state.phase !== 'accepted') {
      throw new Error('countdown setup failed')
    }
    expect(first.error).toBe('mismatch')
    expect(first.state.attempts).toBe(1)
    const second = await pairingExchanges.decide({ state: first.state, now: NOW, approved: true, digits: wrong })
    if (!('error' in second) || second.state === 'idle' || second.state.phase !== 'accepted') {
      throw new Error('countdown setup failed')
    }
    expect(second.error).toBe('mismatch')
    expect(second.state.attempts).toBe(2)
    const third = await pairingExchanges.decide({ state: second.state, now: NOW, approved: true, digits: wrong })
    if (!('error' in third)) throw new Error('lock setup failed')
    expect(third.error).toBe('locked')
    if (third.state === 'idle' || third.state.phase !== 'locked') throw new Error('lock setup failed')
    expect(third.state.until).toBe(NOW + PAIRING_LOCK_MS)
    expect(pairingExchanges.present({ state: third.state, now: NOW, pcNonce: '', phoneKey: '', rate: 0 })).toEqual({
      expiresAt: NOW + PAIRING_LOCK_MS,
      outcome: 'locked'
    })
    const frozen = pairingExchanges.newOffer({ state: third.state, now: NOW })
    expect(frozen.refusal).toBe('locked')
    expect(frozen.state).toEqual(third.state)
    const after = NOW + PAIRING_LOCK_MS + 1
    const thawed = pairingExchanges.present({ state: third.state, now: after, pcNonce: '', phoneKey: '', rate: 0 })
    expect(thawed.outcome).toBe('expired')
    const revived = pairingExchanges.newOffer({ state: third.state, now: after })
    expect(revived.offer).toBeDefined()
    expect(revived.refusal).toBeUndefined()
  })

  it('AC-4.6 the lockout threshold is an input so policy stays testable', async () => {
    const { state: start, digits } = await accepted(NOW)
    const wrong = digits === '000000' ? '000001' : '000000'
    const strict = await pairingExchanges.decide({ state: start, now: NOW, approved: true, digits: wrong, attempts: 1 })
    expect('error' in strict && strict.error).toBe('locked')
  })

  it('AC-4.6 the lock lifts by itself at 5:00', async () => {
    const until = NOW + PAIRING_LOCK_MS
    const locked = { phase: 'locked', until } as const
    const frozen = pairingExchanges.present({ state: locked, now: until - 1, pcNonce: '', phoneKey: '', rate: 0 })
    expect(frozen.outcome).toBe('locked')
    const thawed = pairingExchanges.present({ state: locked, now: until, pcNonce: '', phoneKey: '', rate: 0 })
    expect(thawed.outcome).toBe('expired')
    const decideThawed = await pairingExchanges.decide({ state: locked, now: until, approved: true, digits: '123456' })
    expect('error' in decideThawed && decideThawed.error).toBe('expired')
    const revived = pairingExchanges.newOffer({ state: locked, now: until })
    expect(revived.offer).toBeDefined()
    expect(revived.refusal).toBeUndefined()
  })

  it('AC-4.6 a reject does not count toward the lockout', async () => {
    const first = await accepted(NOW)
    const wrong = first.digits === '000000' ? '000001' : '000000'
    const once = await pairingExchanges.decide({ state: first.state, now: NOW, approved: true, digits: wrong })
    if (!('error' in once) || once.state === 'idle' || once.state.phase !== 'accepted') throw new Error('setup failed')
    const twice = await pairingExchanges.decide({ state: once.state, now: NOW, approved: true, digits: wrong })
    if (!('error' in twice) || twice.state === 'idle' || twice.state.phase !== 'accepted') throw new Error('setup failed')
    const rejected = await pairingExchanges.decide({ state: twice.state, now: NOW, approved: false, digits: wrong })
    if (!('decision' in rejected)) throw new Error('setup failed')
    expect(rejected.decision).toBe('rejected')
    const next = await accepted(NOW)
    const freshWrong = next.digits === '000000' ? '000001' : '000000'
    const fresh = await pairingExchanges.decide({ state: next.state, now: NOW, approved: true, digits: freshWrong })
    if (!('error' in fresh) || fresh.state === 'idle' || fresh.state.phase !== 'accepted') throw new Error('setup failed')
    expect(fresh.error).toBe('mismatch')
    expect(fresh.state.attempts).toBe(1)
  })

  it('AC-4.9 the global pairing window holds 5 per minute', () => {
    const offer = freshOffer(NOW)
    const poll = { state: offer, now: NOW, pcNonce: offer.pcNonce, phoneKey: '', rate: MAX_PAIRINGS_PER_WINDOW - 1 }
    expect(pairingExchanges.present(poll).outcome).toBe('pending')
    expect(pairingExchanges.present({ ...poll, rate: MAX_PAIRINGS_PER_WINDOW }).outcome).toBe('rate-limited')
  })

  it('AC-4.10 only one offer lives at a time', async () => {
    const offer = freshOffer(NOW)
    const overOffered = pairingExchanges.newOffer({ state: offer, now: NOW })
    expect(overOffered.refusal).toBe('busy')
    expect(overOffered.offer).toBeUndefined()
    expect(overOffered.state).toEqual(offer)
    const { state: live } = await accepted(NOW)
    const overAccepted = pairingExchanges.newOffer({ state: live, now: NOW })
    expect(overAccepted.refusal).toBe('busy')
    expect(overAccepted.state).toEqual(live)
  })
})
