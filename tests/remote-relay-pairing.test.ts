import { describe, expect, it } from 'vitest'
import { buildPairingUrl } from '../src/coordinator/channels/remote/pairing-flow'
import { b64u, fingerprint, type PublicJwk } from '../src/shared/remote/crypto'
import { PAIRING_LOCK_MS, pairingCode } from '../src/shared/remote/pairing'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { FakeRelay, keyPair, startEchoPc } from './support/relay-fake'
import { FakePhone } from './support/relay-phone'
import { onThePair, served } from './support/relay-served'
import { HOST } from './support/remote-harness'

// The harness `random` fills with 1s, so the offer secret of every pairing in these tests is this one.
const OFFER = b64u.encode(new Uint8Array(32).fill(1))

async function phoneKey(): Promise<PublicJwk> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
}

const request = (t: Awaited<ReturnType<typeof served>>['t'], secret: string, key: PublicJwk) =>
  t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret, phonePublicKey: key } })

describe('pairing over the relay (spec 027 T18)', () => {
  it('AC-4.1 the pairing URL for the relay carries address, secret and fingerprint in the right places', async () => {
    const pc = await keyPair()
    const print = await fingerprint(pc.publicKey)
    const relayHost = 'ab12cd34ef56gh78ij90kl12mn.relay.example'
    const url = new URL(buildPairingUrl(relayHost, OFFER, print))
    expect(url.origin).toBe(`https://${relayHost}`)
    expect(url.pathname).toBe('/')
    expect(url.search).toBe('')
    // The fragment is never sent to a server: the secret and the fingerprint ride there and nowhere else.
    expect(new URLSearchParams(url.hash.slice(1)).get('p')).toBe(OFFER)
    expect(new URLSearchParams(url.hash.slice(1)).get('f')).toBe(print)
    expect(url.href.replace(url.hash, '')).not.toContain(OFFER)
    expect(url.href.replace(url.hash, '')).not.toContain(print)
  })

  it('AC-4.1 a pairing over the pair completes and the secret, the phone key, the nonce and the code never appear in a relay-visible byte', async () => {
    await onThePair(async () => {
      const { t, pair } = await served({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      // The composition root names the relay host as the PC's address, which is what the QR carries (T25).
      await t.state.update({ hostName: new URL(pair.relay.origin).host })
      const key = await phoneKey()
      expect(await t.channel.pairStart()).toEqual({ ok: true })
      const asked = await request(t, OFFER, key)
      expect(asked.status).toBe(200)
      const pcNonce = (asked.body as { pcNonce: string }).pcNonce
      const before = t.store.devices().length
      const approved = await t.channel.pairApprove('Pixel')
      expect(approved.ok).toBe(true)
      expect(t.store.devices().length).toBe(before + 1)
      const code = t.confirmCalls.at(-1)?.params['code'] ?? ''
      expect(code).toMatch(/^\d{6}$/)
      expect(pair.relay.tap.records.length).toBeGreaterThan(2)
      expect(pair.relay.tap.leaks([OFFER, key.x ?? '', key.y ?? '', pcNonce, `"${code}"`])).toEqual([])
    })
  })

  it('AC-4.2 a man-in-the-middle relay is caught by the fingerprint before the phone sends anything', async () => {
    const real = await keyPair()
    const attacker = await keyPair()
    const fromQr = await fingerprint(real.publicKey)
    // The relay terminates the handshake itself with its own key; the real PC is not even involved.
    const relay = new FakeRelay()
    const echo = startEchoPc(relay, { identity: attacker })
    await echo.ready
    const phone = new FakePhone(relay, { device: null, expect: { fingerprint: fromQr } })
    expect(await phone.connect()).toEqual({ ok: false, reason: 'fingerprint' })
    expect(phone.keys).toBeNull()
    // Only the first handshake frame left the phone: no secret, no key, no request followed it.
    expect(relay.tap.of('phoneToRelay')).toHaveLength(1)
    expect(echo.received).toEqual([])
    // The same relay with the genuine fingerprint of its own key is of course accepted: the check is the fingerprint, nothing else.
    const accepted = new FakePhone(relay, { device: null, expect: { fingerprint: await fingerprint(attacker.publicKey) } })
    expect(await accepted.connect()).toEqual({ ok: true })
  })

  it('AC-4.2 a substituted device key shows different digits on the two screens', async () => {
    await onThePair(async () => {
      const { t, pair } = await served({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      await t.state.update({ hostName: new URL(pair.relay.origin).host })
      const mine = await phoneKey()
      const planted = await phoneKey()
      expect(await t.channel.pairStart()).toEqual({ ok: true })
      // Whoever sits in the middle puts their key in the request; the PC computes its digits from what it received.
      const asked = await request(t, OFFER, planted)
      const pcNonce = (asked.body as { pcNonce: string }).pcNonce
      await t.channel.pairApprove('Pixel')
      const pcScreen = t.confirmCalls.at(-1)?.params['code']
      const phoneScreen = await pairingCode({ secret: b64u.decode(OFFER), phoneKey: mine, pcNonce })
      const honest = await pairingCode({ secret: b64u.decode(OFFER), phoneKey: planted, pcNonce })
      expect(pcScreen).toBe(honest)
      expect(pcScreen).not.toBe(phoneScreen)
    })
  })

  it('AC-4.4 a stranger with the address can lock pairing but gains nothing', async () => {
    await onThePair(async () => {
      const { t, pair } = await served({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      // The composition root names the relay host as the PC's address, which is what the QR carries (T25).
      await t.state.update({ hostName: new URL(pair.relay.origin).host })
      const devicesBefore = t.store.devices().length
      expect(await t.channel.pairStart()).toEqual({ ok: true })
      const stranger = await phoneKey()
      const guesses = Array.from({ length: 12 }, (_, i) => b64u.encode(new Uint8Array(32).fill(100 + i)))
      const seen: unknown[] = []
      for (const guess of guesses) seen.push((await request(t, guess, stranger)).body)
      // Nothing but refusals came back, and no device was made.
      for (const body of seen) expect(Object.keys(body as object)).toEqual(['error'])
      expect(t.store.devices().length).toBe(devicesBefore)
      expect(t.pairings.at(-1)).toMatchObject({ stage: 'locked' })
      // The real phone is locked out too, for the lock period and no longer.
      // Refused either as locked or, with that many requests in a minute, as rate-limited: the 026 limits, unchanged.
      expect(['locked', 'rate-limited']).toContain(((await request(t, OFFER, await phoneKey())).body as { error: string }).error)
      expect(t.store.devices().length).toBe(devicesBefore)
      t.setNow(PAIRING_LOCK_MS + 1)
      expect(await t.channel.pairStart()).toEqual({ ok: true })
      expect((await request(t, OFFER, await phoneKey())).status).toBe(200)
      expect(pair.handlerCalls).toBeGreaterThan(12)
    })
  })

  it('AC-4.4 the relay adds no second pairing limit but caps handshakes: past the cap a stranger is told the relay is full', async () => {
    const relay = new FakeRelay()
    const pc = await keyPair()
    const echo = startEchoPc(relay, { identity: pc })
    await echo.ready
    const fromQr = await fingerprint(pc.publicKey)
    const results: string[] = []
    for (let i = 0; i < REMOTE_RELAY_LIMITS.anonymousHandshakesPerMinute + 2; i++) {
      const phone = new FakePhone(relay, { device: null, expect: { fingerprint: fromQr }, address: `203.0.113.${i}` })
      const connected = await phone.connect()
      results.push(connected.ok ? 'ok' : connected.reason)
    }
    expect(results.slice(0, REMOTE_RELAY_LIMITS.anonymousHandshakesPerMinute)).toEqual(Array(REMOTE_RELAY_LIMITS.anonymousHandshakesPerMinute).fill('ok'))
    expect(results.slice(REMOTE_RELAY_LIMITS.anonymousHandshakesPerMinute)).toEqual(['relay 429', 'relay 429'])
  })
})
