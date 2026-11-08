import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPairingUrl } from '../src/coordinator/channels/remote/pairing-flow'
import { b64u, fingerprint, type PublicJwk } from '../src/shared/remote/crypto'
import { OFFER_EXPIRES_MS, PAIRING_LOCK_MS } from '../src/shared/remote/pairing'
import { DEVICE_IDLE_MS, DeviceStore, expiredDevices, RemoteStateStore, type DeviceRecord, type SealBox } from '../src/coordinator/channels/remote/store'
import { HOST, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'
import { fakeAttestation, fakeCredential } from './support/webauthn-fake'

describe('T25 device administration (AC-2.5, 6.2, 6.3, 6.5, 6.9, 6.10, BR-22)', () => {
  async function servedAdmin(): Promise<{ t: Harness; a: { deviceId: string; token: string }; b: { deviceId: string; token: string } }> {
    // Two live sessions need two tokens: the default fill(1) random would collide them.
    let byte = 0
    const random = (length: number): Uint8Array => {
      byte = (byte % 250) + 1
      return new Uint8Array(length).fill(byte)
    }
    const t = await testChannel({ remote: { enabled: true, scopes: { chat: true, approve: true, home: false, cameras: false, vault: false, history: false } }, random })
    await t.channel.sync()
    const first = await pairDevice(t, 'phone-a')
    const second = await pairDevice(t, 'phone-b')
    const a = { deviceId: first.deviceId, token: await openSession(t, first.deviceId, first.privateKey) }
    const b = { deviceId: second.deviceId, token: await openSession(t, second.deviceId, second.privateKey) }
    return { t, a, b }
  }

  const auth = (token: string): Record<string, string> => ({ ...HOST, authorization: `Bearer ${token}` })

  it('AC-6.2: revoke borra el registro, corta sesiones y conexiones, audita; otros intactos; dos veces inofensivo', async () => {
    const { t, a, b } = await servedAdmin()
    t.transport.holdConnection(a.deviceId)
    t.transport.holdConnection(b.deviceId)
    await t.channel.revokeDevice(a.deviceId)
    expect(t.store.devices().map((known) => known.id)).toEqual([b.deviceId])
    expect(t.transport.closedDevices).toEqual([a.deviceId])
    const refused = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(a.token) })
    expect(refused.status).toBe(401)
    const kept = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(b.token) })
    expect(kept.status).toBe(200)
    expect(t.records).toEqual([
      { action: 'remote.device.revoke', actor: 'user', target: a.deviceId, outcome: 'ok', detail: { deviceId: a.deviceId } },
      // The refused request right above is itself audited (AC-7.5).
      { action: 'remote.status', actor: 'remote', outcome: 'denied', throttle: true }
    ])
    expect(t.deviceLists.at(-1)?.map((row) => row.id)).toEqual([b.deviceId])
    await t.channel.revokeDevice(a.deviceId)
    expect(t.records.filter((entry) => entry.action === 'remote.device.revoke')).toHaveLength(1)
    expect(t.store.devices().map((known) => known.id)).toEqual([b.deviceId])
  })

  it('AC-6.3: la llave vieja ya no autentica; solo vuelve por pairing', async () => {
    const { t, a } = await servedAdmin()
    await t.channel.revokeDevice(a.deviceId)
    const challenge = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId: a.deviceId } })
    expect(challenge.status).toBe(401)
    expect(challenge.body).toEqual({ error: 'unknown-device' })
  })

  it('AC-6.5: revoke all pide confirmación; cancelar no cambia nada', async () => {
    const { t, a, b } = await servedAdmin()
    t.setConfirm(false)
    expect(await t.channel.revokeAll()).toEqual({ ok: false })
    expect(t.store.devices()).toHaveLength(2)
    expect(t.records).toEqual([])
    expect(t.confirmCalls).toEqual([{ kind: 'revokeAll', params: {} }])
    t.setConfirm(true)
    expect(await t.channel.revokeAll()).toEqual({ ok: true })
    expect(t.store.devices()).toEqual([])
    expect(t.records.map((entry) => entry.target).sort()).toEqual([a.deviceId, b.deviceId].sort())
    expect(t.records.every((entry) => entry.actor === 'user')).toBe(true)
  })

  it('AC-6.10: forget borra el propio device y se audita como remoto (el PC inalcanzable es tema de la PWA)', async () => {
    const { t, a, b } = await servedAdmin()
    const res = await t.transport.request({ method: 'POST', path: '/api/forget', headers: auth(a.token) })
    expect(res.status).toBe(200)
    expect(t.store.devices().map((known) => known.id)).toEqual([b.deviceId])
    const refused = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(a.token) })
    expect(refused.status).toBe(401)
    expect(t.records).toEqual([
      { action: 'remote.device.forget', actor: 'remote', target: a.deviceId, outcome: 'ok', detail: { deviceId: a.deviceId } },
      // The refused request right above is itself audited (AC-7.5).
      { action: 'remote.status', actor: 'remote', outcome: 'denied', throttle: true }
    ])
  })

  it('AC-6.9: el sweep saca idle y dormant con auditoría system', async () => {
    const { t, a, b } = await servedAdmin()
    t.setNow(DEVICE_IDLE_MS + 1000)
    // b is touched now (the same path as every request): it stays fresh.
    await t.store.touch(b.deviceId)
    t.setRemote({ enabled: false })
    await t.channel.sweepDevices()
    expect(t.store.devices().map((known) => known.id)).toEqual([b.deviceId])
    expect(t.records).toEqual([{ action: 'remote.device.sweep', actor: 'system', target: a.deviceId, outcome: 'ok', detail: { deviceId: a.deviceId } }])
    expect(t.deviceLists.at(-1)?.map((row) => row.id)).toEqual([b.deviceId])
  })

  it('AC-2.5: el ping aparece en state y el pong a tiempo da ok', async () => {
    const { t, a, b } = await servedAdmin()
    const ping = await t.channel.testDevice(a.deviceId)
    expect(typeof ping).toBe('string')
    const stateA = await t.transport.request({ method: 'GET', path: '/api/state', headers: auth(a.token) })
    expect((stateA.body as { ping?: string }).ping).toBe(ping)
    const stateB = await t.transport.request({ method: 'GET', path: '/api/state', headers: auth(b.token) })
    expect('ping' in (stateB.body as Record<string, unknown>)).toBe(false)
    const pong = await t.transport.request({ method: 'POST', path: '/api/pong', headers: auth(a.token), body: { ping } })
    expect(pong.status).toBe(200)
    expect(t.testResults).toEqual([{ deviceId: a.deviceId, ok: true }])
  })

  it('AC-2.5: pong tardío, repetido o ajeno da phoneSilent', async () => {
    const { t, a, b } = await servedAdmin()
    const ping = await t.channel.testDevice(a.deviceId)
    const wrong = await t.transport.request({ method: 'POST', path: '/api/pong', headers: auth(a.token), body: { ping: 'no-es' } })
    expect(wrong.status).toBe(404)
    expect(wrong.body).toEqual({ error: 'unknown-ping' })
    const foreign = await t.transport.request({ method: 'POST', path: '/api/pong', headers: auth(b.token), body: { ping } })
    expect(foreign.status).toBe(404)
    t.setNow(11_000)
    const late = await t.transport.request({ method: 'POST', path: '/api/pong', headers: auth(a.token), body: { ping } })
    expect(late.status).toBe(404)
    expect(late.body).toEqual({ error: 'unknown-ping' })
    const state = await t.transport.request({ method: 'GET', path: '/api/state', headers: auth(a.token) })
    expect('ping' in (state.body as Record<string, unknown>)).toBe(false)
    expect(t.testResults).toEqual([])
    expect(await t.channel.testDevice('no-existe')).toBeNull()
  })

  it('T25: el sweep corre cada hora mientras sirve', async () => {
    vi.useFakeTimers()
    try {
      const { t, b } = await servedAdmin()
      t.setNow(DEVICE_IDLE_MS + 1000)
      await t.store.touch(b.deviceId)
      await vi.advanceTimersByTimeAsync(3_600_000)
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(t.store.devices().map((known) => known.id)).toEqual([b.deviceId])
      expect(t.records).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'alma-remote-store-'))
  dirs.push(dir)
  return dir
}

// A seal that transforms (base64), so "sealed on disk" is observable.
const sealBox: SealBox = {
  seal: async (plain: string) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  open: async (sealed: string) => Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
}

const jwk = (x: string): PublicJwk => ({ kty: 'EC', crv: 'P-256', x, y: 'eQ' })

describe('remote device store (spec 026 T10)', () => {
  it('AC-4.11 the sixth device is refused, every stored one counts', async () => {
    let n = 0
    const store = await DeviceStore.load({ dir: fresh(), now: () => 0, sealBox, randomId: () => `d${++n}` })
    for (let i = 0; i < 5; i++) {
      const added = await store.add({ name: `phone ${i}`, publicKey: jwk(`x${i}`) })
      expect(added?.name).toBe(`phone ${i}`)
    }
    expect(store.devices()).toHaveLength(5)
    expect(await store.add({ name: 'phone 5', publicKey: jwk('x5') })).toBeNull()
    expect(store.devices()).toHaveLength(5)
  })

  it('AC-6.7 a key idle for over 15 days is expired, exactly 15 days is not', () => {
    const now = 10 * DEVICE_IDLE_MS
    const record = (pairedAt: number, lastSeen: number | null): DeviceRecord => ({
      id: 'd',
      name: 'phone',
      pairedAt,
      lastSeen,
      publicKey: jwk('x'),
      passkey: null,
      push: null
    })
    const day = 24 * 3_600 * 1_000
    const devices = [
      record(now - 16 * day, now - 16 * day),
      record(now - 15 * day, now - 15 * day),
      record(now - 16 * day, null),
      record(now - 2 * day, now - 2 * day)
    ]
    expect(expiredDevices(devices, now).map((d) => d.pairedAt)).toEqual([now - 16 * day, now - 16 * day])
  })

  it('AC-6.9 expiredDevices considers every record passed, with no status filter', () => {
    const now = 10 * DEVICE_IDLE_MS
    const mk = (id: string): DeviceRecord => ({ id, name: id, pairedAt: 0, lastSeen: 0, publicKey: jwk('x'), passkey: null, push: null })
    expect(expiredDevices([mk('a'), mk('b')], now).map((d) => d.id)).toEqual(['a', 'b'])
    expect(expiredDevices([], now)).toEqual([])
  })

  it('AC-11.3 the devices file is written sealed and never holds a push subscription in clear', async () => {
    const dir = fresh()
    const store = await DeviceStore.load({ dir, now: () => 7, sealBox })
    const added = await store.add({ id: 'd1', name: 'phone', publicKey: jwk('aa') })
    expect(added?.lastSeen).toBeNull()
    await store.setPush('d1', { endpoint: 'https://push.example.com/secret-subscription', keys: { p256dh: 'p256dh-secret', auth: 'auth-secret' } })
    const raw = readFileSync(join(dir, 'devices.json'), 'utf8')
    expect(raw).toContain('sealed:')
    expect(raw).not.toContain('secret-subscription')
    expect(raw).not.toContain('p256dh-secret')
    expect(raw).not.toContain('auth-secret')
    const reloaded = await DeviceStore.load({ dir, now: () => 7, sealBox })
    expect(reloaded.devices()[0]?.push).toEqual({ endpoint: 'https://push.example.com/secret-subscription', keys: { p256dh: 'p256dh-secret', auth: 'auth-secret' } })
  })

  it('devices round-trip: add, passkey, touch and remove persist across a reload', async () => {
    const dir = fresh()
    let now = 1000
    const store = await DeviceStore.load({ dir, now: () => now, sealBox })
    await store.add({ id: 'd1', name: 'phone', publicKey: jwk('aa') })
    await store.setPasskey('d1', { credentialId: 'cred', publicKey: jwk('bb'), counter: 3 })
    now = 2000
    await store.touch('d1')
    const reloaded = await DeviceStore.load({ dir, now: () => now, sealBox })
    expect(reloaded.devices()).toEqual([
      { id: 'd1', name: 'phone', pairedAt: 1000, lastSeen: 2000, publicKey: jwk('aa'), passkey: { credentialId: 'cred', publicKey: jwk('bb'), counter: 3 }, push: null }
    ])
    await reloaded.remove('d1')
    expect((await DeviceStore.load({ dir, now: () => now, sealBox })).devices()).toEqual([])
  })

  it('a corrupt devices file loads as an empty store', async () => {
    const dir = fresh()
    writeFileSync(join(dir, 'devices.json'), 'not json{{{', 'utf8')
    expect((await DeviceStore.load({ dir, now: () => 0, sealBox })).devices()).toEqual([])
  })

  it('the state file holds no private key in clear', async () => {
    const dir = fresh()
    const store = await RemoteStateStore.load({ dir, sealBox })
    expect(store.state.threadId).toBeNull()
    expect(store.state.port).toBeNull()
    expect(store.state.hostName).toBeNull()
    const privateD = (store.state.pcKey.private as { d?: string }).d
    expect(privateD).toBeDefined()
    const raw = readFileSync(join(dir, 'state.json'), 'utf8')
    expect(raw).toContain('sealed:')
    expect(raw).not.toContain(privateD ?? 'missing-in-test')
  })

  it('state round-trips across a reload and unknown ids are harmless', async () => {
    const dir = fresh()
    const store = await RemoteStateStore.load({ dir, sealBox })
    await store.update({ threadId: 't1', port: 18789, hostName: 'alma.tail123.ts.net' })
    const reloaded = await RemoteStateStore.load({ dir, sealBox })
    expect(reloaded.state.threadId).toBe('t1')
    expect(reloaded.state.port).toBe(18789)
    expect(reloaded.state.hostName).toBe('alma.tail123.ts.net')
    expect(reloaded.state.pcKey.public).toEqual(store.state.pcKey.public)
    const devices = await DeviceStore.load({ dir, now: () => 0, sealBox })
    await devices.remove('nope')
    await devices.touch('nope')
    await devices.setPush('nope', null)
    expect(devices.devices()).toEqual([])
  })

  it('a dotted hostName is stored bare: tailscaled aborts TLS for a dotted SNI (alert 50)', async () => {
    const dir = fresh()
    const store = await RemoteStateStore.load({ dir, sealBox })
    await store.update({ hostName: 'alma.tail123.ts.net.' })
    expect(store.state.hostName).toBe('alma.tail123.ts.net')
    expect((await RemoteStateStore.load({ dir, sealBox })).state.hostName).toBe('alma.tail123.ts.net')
  })

  it('a legacy dotted hostName on disk loads bare', async () => {
    const dir = fresh()
    const store = await RemoteStateStore.load({ dir, sealBox })
    await store.update({ hostName: 'alma.tail123.ts.net' })
    const file = join(dir, 'state.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('alma.tail123.ts.net', 'alma.tail123.ts.net.'), 'utf8')
    expect((await RemoteStateStore.load({ dir, sealBox })).state.hostName).toBe('alma.tail123.ts.net')
  })
})

describe('remote pairing flow (spec 026 T15)', () => {
  // The harness pins random to 0x01, so the offer secret is known without reading the QR.
  const OFFER = b64u.encode(new Uint8Array(32).fill(1))
  const KEY = { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) }
  const KEY_META = { ...KEY, key_ops: ['verify'], ext: true }
  const KEY_B = { kty: 'EC', crv: 'P-256', x: 'b'.repeat(43), y: 'y'.repeat(43) }
  const UNKNOWN = 'z'.repeat(43)

  async function served(): Promise<Harness> {
    const t = await testChannel({ remote: { enabled: true } })
    await t.state.update({ hostName: 'alma-test.ts.net' })
    await t.channel.sync()
    return t
  }

  function pairRequest(t: Harness, secret: string, phonePublicKey: unknown) {
    return t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret, phonePublicKey } })
  }

  function pairStatus(t: Harness, query: string) {
    return t.transport.request({ method: 'GET', path: '/api/pair/status', headers: HOST, query })
  }

  it('AC-4.1 the pairing URL carries host, secret and fingerprint in the fragment', () => {
    expect(buildPairingUrl('pc.ts.net', 'the-secret', 'the-fingerprint')).toBe('https://pc.ts.net/#p=the-secret&f=the-fingerprint')
  })

  it('AC-4.1 the pairing URL never carries the DNS root dot: dotted SNI aborts the phone handshake', () => {
    expect(buildPairingUrl('pc.ts.net.', 'the-secret', 'the-fingerprint')).toBe('https://pc.ts.net/#p=the-secret&f=the-fingerprint')
  })

  it('AC-4.1 remote off refuses to start', async () => {
    const t = await testChannel()
    expect(await t.channel.pairStart()).toEqual({ ok: false, reason: 'off' })
    expect(t.pairings).toEqual([])
  })

  it('AC-4.1 start without a host name refuses: no QR can be built', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    expect(await t.channel.pairStart()).toEqual({ ok: false, reason: 'no-host' })
    expect(t.pairings).toEqual([])
  })

  it('AC-4.3 native allow creates the device with the typed name and its public key', async () => {
    const t = await served()
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    expect(t.pairings[0]).toEqual({ stage: 'offer', qrDataUrl: expect.stringMatching(/^data:image\/png/), expiresAt: OFFER_EXPIRES_MS })
    const request = await pairRequest(t, OFFER, KEY_META)
    expect(request.status).toBe(200)
    const { pcNonce, expiresAt } = request.body as { pcNonce: string; expiresAt: number }
    expect(expiresAt).toBe(OFFER_EXPIRES_MS)
    expect(t.pairings[1]).toEqual({ stage: 'request', code: expect.stringMatching(/^\d{6}$/), expiresAt: OFFER_EXPIRES_MS })
    const shown = (t.pairings[1] as { code: string }).code

    expect(await t.channel.pairApprove('Pixel')).toMatchObject({ ok: true })
    expect(t.confirmCalls).toEqual([{ kind: 'pair', params: { name: 'Pixel', code: shown } }])
    const devices = t.store.devices()
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ name: 'Pixel', publicKey: KEY_META, pairedAt: 0, lastSeen: null })
    expect(t.deviceLists.at(-1)).toEqual([
      { id: devices[0].id, name: 'Pixel', pairedAt: 0, lastSeen: null, dormant: false }
    ])
    expect(t.pairings.at(-1)).toBeNull()

    // The secret is burned on the request path, spent on the status path.
    expect((await pairRequest(t, OFFER, KEY_META)).status).toBe(400)
    const status = await pairStatus(t, `offer=${OFFER}&pcNonce=${pcNonce}`)
    expect(status.status).toBe(200)
    expect(status.body).toEqual({
      status: 'approved',
      deviceId: devices[0].id,
      passkeyChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
    })
  })

  it('AC-4.4 native cancel creates nothing and burns the secret', async () => {
    const t = await served()
    t.setConfirm(false)
    await t.channel.pairStart()
    const request = await pairRequest(t, OFFER, KEY)
    const { pcNonce } = request.body as { pcNonce: string }
    expect(await t.channel.pairApprove('Pixel')).toEqual({ ok: false, reason: 'denied' })
    expect(t.store.devices()).toEqual([])
    expect(t.deviceLists).toEqual([])
    expect(t.pairings.at(-1)).toBeNull()
    expect((await pairRequest(t, OFFER, KEY)).status).toBe(400)
    expect((await pairStatus(t, `offer=${OFFER}&pcNonce=${pcNonce}`)).body).toEqual({ status: 'rejected' })
  })

  it('AC-4.4 reject creates nothing and burns the secret', async () => {
    const t = await served()
    await t.channel.pairStart()
    const request = await pairRequest(t, OFFER, KEY)
    const { pcNonce } = request.body as { pcNonce: string }
    expect(await t.channel.pairReject()).toEqual({ ok: true })
    expect(t.store.devices()).toEqual([])
    expect(t.pairings.at(-1)).toBeNull()
    expect((await pairRequest(t, OFFER, KEY)).status).toBe(400)
    expect((await pairStatus(t, `offer=${OFFER}&pcNonce=${pcNonce}`)).body).toEqual({ status: 'rejected' })
  })

  it('AC-4.7 a valid secret with no approval issues no key', async () => {
    const t = await served()
    await t.channel.pairStart()
    const request = await pairRequest(t, OFFER, KEY)
    const { pcNonce } = request.body as { pcNonce: string }
    expect(t.store.devices()).toEqual([])
    const status = await pairStatus(t, `offer=${OFFER}&pcNonce=${pcNonce}&fp=${await fingerprint(KEY)}`)
    expect(status.body).toEqual({ status: 'pending', expiresAt: OFFER_EXPIRES_MS })
    expect(t.pairings).toHaveLength(2)
  })

  it('AC-4.5 the offer dies at 3 minutes, even mid-approval', async () => {
    const t = await served()
    await t.channel.pairStart()
    await pairRequest(t, OFFER, KEY)
    t.setConfirm(() => {
      t.setNow(OFFER_EXPIRES_MS + 1)
      return true
    })
    expect(await t.channel.pairApprove('Pixel')).toEqual({ ok: false, reason: 'expired' })
    expect(t.store.devices()).toEqual([])

    const late = await served()
    await late.channel.pairStart()
    late.setNow(OFFER_EXPIRES_MS + 1)
    const request = await pairRequest(late, OFFER, KEY)
    expect(request.status).toBe(410)
    expect(request.body).toEqual({ error: 'expired' })
  })

  it('AC-4.9 the sixth pairing request in a minute is refused, status polls are not requests', async () => {
    const t = await served()
    for (let i = 0; i < 5; i++) {
      expect((await pairRequest(t, 'short', KEY)).status, `request ${i}`).toBe(400)
    }
    const refused = await pairRequest(t, 'short', KEY)
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual({ error: 'rate-limited' })
    for (let i = 0; i < 6; i++) {
      expect((await pairStatus(t, `offer=${UNKNOWN}&pcNonce=x`)).status, `poll ${i}`).toBe(400)
    }
  })

  it('AC-4.6 three bad secrets lock pairing for 5 minutes, then it unlocks itself', async () => {
    const t = await served()
    for (let i = 0; i < 3; i++) {
      const bad = await pairRequest(t, UNKNOWN, KEY)
      expect(bad.status).toBe(400)
      expect(bad.body).toEqual({ error: 'invalid' })
    }
    expect(t.pairings.at(-1)).toEqual({ stage: 'locked', lockedUntil: PAIRING_LOCK_MS })
    expect(await t.channel.pairStart()).toEqual({ ok: false, reason: 'locked' })
    expect((await pairRequest(t, UNKNOWN, KEY)).body).toEqual({ error: 'invalid' })
    t.setNow(PAIRING_LOCK_MS + 1)
    expect(await t.channel.pairStart()).toEqual({ ok: true })
  })

  it('AC-4.6 a reject does not count toward the lockout', async () => {
    const t = await served()
    await pairRequest(t, UNKNOWN, KEY)
    await pairRequest(t, UNKNOWN, KEY)
    await t.channel.pairStart()
    await t.channel.pairReject()
    expect(t.pairings).toHaveLength(2)
    await pairRequest(t, UNKNOWN, KEY)
    expect(t.pairings.at(-1)).toEqual({ stage: 'locked', lockedUntil: PAIRING_LOCK_MS })
  })

  it('AC-4.6 a good request resets the strikes', async () => {
    const t = await served()
    await pairRequest(t, UNKNOWN, KEY)
    await pairRequest(t, UNKNOWN, KEY)
    await t.channel.pairStart()
    expect((await pairRequest(t, OFFER, KEY)).status).toBe(200)
    t.channel.pairCancel()
    await pairRequest(t, UNKNOWN, KEY)
    await pairRequest(t, UNKNOWN, KEY)
    expect(t.pairings.some((view) => view?.stage === 'locked')).toBe(false)
  })

  it('AC-4.10 a second key is busy while the first stays bound', async () => {
    const t = await served()
    await t.channel.pairStart()
    const first = await pairRequest(t, OFFER, KEY)
    expect(first.status).toBe(200)
    const busy = await pairRequest(t, OFFER, KEY_B)
    expect(busy.status).toBe(409)
    expect(busy.body).toEqual({ error: 'busy' })
    const retry = await pairRequest(t, OFFER, KEY)
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual(first.body)
    expect(await t.channel.pairApprove('Pixel')).toMatchObject({ ok: true })
    expect(t.store.devices()[0]?.publicKey).toEqual(KEY)
  })

  it('AC-4.10 starting twice is busy', async () => {
    const t = await served()
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    expect(await t.channel.pairStart()).toEqual({ ok: false, reason: 'busy' })
  })

  it('AC-4.11 a sixth pairing start is refused with limit', async () => {
    const t = await served()
    for (let i = 0; i < 5; i++) {
      const added = await t.store.add({ name: `phone ${i}`, publicKey: KEY })
      if (!added) throw new Error('store setup failed')
    }
    expect(await t.channel.pairStart()).toEqual({ ok: false, reason: 'limit' })
    expect(t.pairings).toEqual([])
    await t.channel.revokeDevice(t.store.devices()[0]?.id ?? '')
    expect(await t.channel.pairStart()).toEqual({ ok: true })
  })

  it('AC-5.3 pairing refusals are uniform: unknown, used and locked spray look the same', async () => {
    const seen = new Set<string>()
    const idle = await served()
    seen.add(JSON.stringify((await pairRequest(idle, UNKNOWN, KEY)).body))
    await idle.channel.pairStart()
    await pairRequest(idle, OFFER, KEY)
    await idle.channel.pairApprove('Pixel')
    seen.add(JSON.stringify((await pairRequest(idle, OFFER, KEY)).body))
    const cancelled = await served()
    await cancelled.channel.pairStart()
    cancelled.channel.pairCancel()
    seen.add(JSON.stringify((await pairRequest(cancelled, OFFER, KEY)).body))
    const sprayed = await served()
    for (let i = 0; i < 4; i++) seen.add(JSON.stringify((await pairRequest(sprayed, UNKNOWN, KEY)).body))
    expect([...seen]).toEqual([JSON.stringify({ error: 'invalid' })])
  })

  it('AC-4.3 approve needs a name and a live request, and asks nothing without one', async () => {
    const t = await served()
    await t.channel.pairStart()
    await pairRequest(t, OFFER, KEY)
    expect(await t.channel.pairApprove('   ')).toEqual({ ok: false, reason: 'invalid' })
    expect(t.confirmCalls).toEqual([])
    expect(await t.channel.pairApprove('Pixel')).toMatchObject({ ok: true })

    const bare = await served()
    await bare.channel.pairStart()
    expect(await bare.channel.pairApprove('Pixel')).toEqual({ ok: false, reason: 'invalid' })
    expect(bare.confirmCalls).toEqual([])
  })

  async function approvedPairing(t: Harness): Promise<{ pcNonce: string; deviceId: string; challenge: Uint8Array }> {
    await t.channel.pairStart()
    const request = await pairRequest(t, OFFER, KEY)
    const { pcNonce } = request.body as { pcNonce: string }
    await t.channel.pairApprove('Pixel')
    const status = await pairStatus(t, `offer=${OFFER}&pcNonce=${pcNonce}`)
    const body = status.body as { status: string; deviceId: string; passkeyChallenge: string }
    return { pcNonce, deviceId: body.deviceId, challenge: b64u.decode(body.passkeyChallenge) }
  }

  function passkeyRequest(t: Harness, pcNonce: string, attestationObject: Uint8Array, clientDataJSON: Uint8Array, secret = OFFER) {
    return t.transport.request({
      method: 'POST',
      path: '/api/pair/passkey',
      headers: HOST,
      body: { offer: secret, pcNonce, attestationObject: b64u.encode(attestationObject), clientDataJSON: b64u.encode(clientDataJSON) }
    })
  }

  it('AC-4.13 a passkey is registered during pairing and stored with the device', async () => {
    const t = await served()
    const { pcNonce, deviceId, challenge } = await approvedPairing(t)
    const credential = await fakeCredential()
    const made = await fakeAttestation(credential, { challenge, origin: 'https://alma-test.ts.net', rpId: 'alma-test.ts.net' })
    const registered = await passkeyRequest(t, pcNonce, made.attestationObject, made.clientDataJSON)
    expect(registered.status).toBe(200)
    expect(registered.body).toEqual({ ok: true })
    const device = t.store.devices().find((known) => known.id === deviceId)
    expect(device?.passkey).toEqual({
      credentialId: b64u.encode(credential.credentialId),
      publicKey: { kty: 'EC', crv: 'P-256', x: credential.publicKey.x, y: credential.publicKey.y },
      counter: 0
    })
  })

  it('AC-4.13 a phone that sends no passkey still pairs and is marked as without', async () => {
    const t = await served()
    const { deviceId } = await approvedPairing(t)
    const device = t.store.devices().find((known) => known.id === deviceId)
    expect(device?.name).toBe('Pixel')
    expect(device?.passkey).toBeNull()
  })

  it('AC-4.13 bad attestation or wrong rpId leaves the device without a passkey, retry still works', async () => {
    const t = await served()
    const { pcNonce, deviceId, challenge } = await approvedPairing(t)
    const credential = await fakeCredential()
    const good = await fakeAttestation(credential, { challenge, origin: 'https://alma-test.ts.net', rpId: 'alma-test.ts.net' })
    const broken = Uint8Array.from(good.attestationObject)
    broken[broken.length - 1] = broken[broken.length - 1] === 0 ? 1 : 0
    expect((await passkeyRequest(t, pcNonce, broken, good.clientDataJSON)).status).toBe(400)
    const foreign = await fakeAttestation(credential, { challenge, origin: 'https://evil.ts.net', rpId: 'evil.ts.net' })
    expect((await passkeyRequest(t, pcNonce, foreign.attestationObject, foreign.clientDataJSON)).status).toBe(400)
    expect(t.store.devices().find((known) => known.id === deviceId)?.passkey).toBeNull()
    expect(t.store.devices()).toHaveLength(1)
    expect((await passkeyRequest(t, pcNonce, good.attestationObject, good.clientDataJSON)).status).toBe(200)
    expect(t.store.devices().find((known) => known.id === deviceId)?.passkey).not.toBeNull()
  })

  it('AC-4.13 the registration challenge is single use', async () => {
    const t = await served()
    const { pcNonce, challenge } = await approvedPairing(t)
    const credential = await fakeCredential()
    const made = await fakeAttestation(credential, { challenge, origin: 'https://alma-test.ts.net', rpId: 'alma-test.ts.net' })
    expect((await passkeyRequest(t, pcNonce, made.attestationObject, made.clientDataJSON)).status).toBe(200)
    const replay = await passkeyRequest(t, pcNonce, made.attestationObject, made.clientDataJSON)
    expect(replay.status).toBe(400)
    expect(replay.body).toEqual({ error: 'invalid' })
    const other = await fakeCredential()
    const second = await fakeAttestation(other, { challenge, origin: 'https://alma-test.ts.net', rpId: 'alma-test.ts.net' })
    expect((await passkeyRequest(t, pcNonce, second.attestationObject, second.clientDataJSON)).status).toBe(400)
  })

  it('AC-4.13 a new pairing closes the previous registration window', async () => {
    const t = await served()
    const { pcNonce, deviceId, challenge } = await approvedPairing(t)
    expect(await t.channel.pairStart()).toEqual({ ok: true })
    const credential = await fakeCredential()
    const made = await fakeAttestation(credential, { challenge, origin: 'https://alma-test.ts.net', rpId: 'alma-test.ts.net' })
    expect((await passkeyRequest(t, pcNonce, made.attestationObject, made.clientDataJSON)).status).toBe(400)
    expect(t.store.devices().find((known) => known.id === deviceId)?.passkey).toBeNull()
  })
})
