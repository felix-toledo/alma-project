import http from 'node:http'
import net from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../src/coordinator/channels/remote/session'
import { TransportStartError } from '../src/coordinator/channels/remote/transport'
import { REMOTE_LIMITS, ROUTES, type RemoteResponse } from '../src/shared/remote/api'
import { b64u, fingerprint, verifyEs256, type PublicJwk } from '../src/shared/remote/crypto'
import { HOST, openSession, pairDevice, signBytes, testChannel } from './support/remote-harness'

describe('remote channel skeleton (spec 026 T11)', () => {
  it('AC-1.1 off starts nothing and never creates the transport', async () => {
    const t = await testChannel()
    expect(t.channel.currentStatus()).toEqual({ state: 'off' })
    await t.channel.sync()
    expect(t.factoryCalls()).toBe(0)
    expect(t.statuses).toEqual([])
  })

  it('AC-1.8 a restart starts the channel again without asking, and nothing starts when off', async () => {
    const on = await testChannel({ remote: { enabled: true } })
    await on.channel.sync()
    expect(on.factoryCalls()).toBe(1)
    expect(on.channel.currentStatus().state).toBe('online')
    const off = await testChannel()
    await off.channel.sync()
    expect(off.factoryCalls()).toBe(0)
  })

  it('AC-2.6 status changes are emitted and readable', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    expect(t.statuses).toEqual([{ state: 'connecting' }, { state: 'online', address: 'https://test.invalid' }])
    expect(t.channel.currentStatus()).toEqual({ state: 'online', address: 'https://test.invalid' })
    await t.channel.sync()
    expect(t.statuses).toHaveLength(2)
    t.setRemote({ enabled: false })
    await t.channel.sync()
    expect(t.statuses[2]).toEqual({ state: 'off' })
  })

  it('AC-1.7 turning off stops the listener and cuts every open connection', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    t.transport.holdConnection('d1')
    t.transport.holdConnection('d2')
    t.setRemote({ enabled: false })
    await t.channel.sync()
    expect(t.transport.stopped).toBe(true)
    expect(t.transport.closedDevices).toEqual(['d1', 'd2'])
    expect(t.channel.currentStatus()).toEqual({ state: 'off' })
  })

  it('AC-1.7 turning off twice closes each connection once', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    t.transport.holdConnection('d1')
    t.setRemote({ enabled: false })
    await t.channel.sync()
    await t.channel.sync()
    expect(t.transport.stopped).toBe(true)
    expect(t.transport.closedDevices).toEqual(['d1'])
    expect(t.channel.currentStatus()).toEqual({ state: 'off' })
  })

  it('AC-9.1 serving requests opens no outbound connection', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const requestSpy = vi.spyOn(http, 'request')
    const getSpy = vi.spyOn(http, 'get')
    const connectSpy = vi.spyOn(net, 'connect')
    try {
      await t.transport.request({ method: 'GET', path: '/api/hello', headers: HOST })
      const { deviceId, privateKey } = await pairDevice(t)
      const token = await openSession(t, deviceId, privateKey)
      const authed = await t.transport.request({
        method: 'GET',
        path: '/api/status',
        headers: { ...HOST, authorization: `Bearer ${token}` }
      })
      expect(authed.status).toBe(200)
    } finally {
      vi.restoreAllMocks()
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(requestSpy).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('AC-3.5 a transport that cannot start leaves the channel in error with the cause', async () => {
    const t = await testChannel({ remote: { enabled: true }, failStart: new TransportStartError('tailscaleDown', 'boom') })
    await t.channel.sync()
    expect(t.channel.currentStatus()).toEqual({ state: 'error', failure: 'tailscaleDown', detail: 'boom' })
    expect(t.transport.stopped).toBe(true)
    const generic = await testChannel({ remote: { enabled: true }, failStart: new Error('x') })
    await generic.channel.sync()
    expect(generic.channel.currentStatus()).toEqual({ state: 'error', failure: 'listener', detail: 'x' })
  })

  it('AC-3.5 a transport factory that throws is reported, never an unhandled rejection', async () => {
    const t = await testChannel({
      remote: { enabled: true },
      failTransport: new TransportStartError('tailscaleDown', 'tailscale transport not wired yet (T29-T33)')
    })
    await t.channel.sync()
    expect(t.channel.currentStatus()).toEqual({
      state: 'error',
      failure: 'tailscaleDown',
      detail: 'tailscale transport not wired yet (T29-T33)'
    })
  })

  it('AC-3.1 every session route refuses a request without credentials', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const sessionRoutes = ROUTES.filter((r) => r.auth === 'session')
    expect(sessionRoutes.length).toBeGreaterThan(10)
    for (const route of sessionRoutes) {
      const response = await t.transport.request({ method: route.method, path: route.path, headers: HOST })
      expect(response.status, route.path).toBe(401)
      expect(response.body, route.path).toEqual({ error: 'unknown-device' })
    }
  })

  it('AC-5.3 every unauthenticated request shares one byte-identical refusal', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const variants = [undefined, '', 'Bearer junk', 'Basic abc', 'Bearer ']
    const seen = new Set<string>()
    for (const authorization of variants) {
      for (const path of ['/api/chat/send', '/api/approvals', '/api/cameras/still']) {
        const headers = authorization === undefined ? { ...HOST } : { ...HOST, authorization }
        const response = await t.transport.request({ method: path === '/api/chat/send' ? 'POST' : 'GET', path, headers })
        expect(response.status).toBe(401)
        seen.add(JSON.stringify(response.body))
      }
    }
    expect([...seen]).toEqual([JSON.stringify({ error: 'unknown-device' })])
  })

  it('AC-3.3 an address inside the tailnet with no credential is refused', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const response = await t.transport.request({ method: 'GET', path: '/api/approvals', headers: HOST, remoteAddress: '100.100.0.5' })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'unknown-device' })
  })

  it('AC-3.3 forwarding headers grant nothing: only credentials authenticate', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const response = await t.transport.request({
      method: 'GET',
      path: '/api/approvals',
      headers: { ...HOST, 'x-forwarded-for': '100.100.0.5' },
      remoteAddress: '100.100.0.5'
    })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'unknown-device' })
  })

  it('AC-3.3 a wrong host or a foreign origin is refused', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    expect((await t.transport.request({ method: 'GET', path: '/api/hello', headers: { host: 'evil.ts.net' } })).status).toBe(400)
    expect((await t.transport.request({ method: 'GET', path: '/api/hello', headers: { ...HOST, origin: 'https://evil.com' } })).status).toBe(400)
    const sameOrigin = await t.transport.request({ method: 'GET', path: '/api/hello', headers: { ...HOST, origin: 'https://test.invalid' } })
    expect(sameOrigin.status).toBe(200)
  })

  it('AC-3.6 unknown routes, wrong methods and path tricks are refused', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const cases = [
      ['GET', '/api/settings'],
      ['GET', '/api/vault'],
      ['POST', '/api/hello'],
      ['GET', '/api/chat/send/../hello'],
      ['GET', '/API/HELLO'],
      ['GET', ''],
      ['DELETE', '/api/chat/send']
    ] as const
    for (const [method, path] of cases) {
      const response = await t.transport.request({ method, path, headers: HOST })
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(response.body).toEqual({ error: 'unknown-route' })
    }
  })

  it('AC-5.4 malformed bodies are rejected before any handler runs', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    for (const body of [{ deviceId: 7 }, {}, { deviceId: 'd', extra: 1 }]) {
      const response = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body })
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'invalid' })
    }
    const missing = await t.transport.request({ method: 'POST', path: '/api/session', headers: HOST, body: { deviceId: 'd' } })
    expect(missing.status).toBe(400)
  })

  it('AC-5.4 a body over 1 MB is refused before the handler runs, exactly 1 MB is not', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const overhead = JSON.stringify({ text: '' }).length
    const fits = { text: 'x'.repeat(REMOTE_LIMITS.requestBytes - overhead) }
    expect(JSON.stringify(fits).length).toBe(REMOTE_LIMITS.requestBytes)
    const ok = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers: HOST, body: fits })
    expect(ok.status).not.toBe(413)
    const over = { text: 'x'.repeat(REMOTE_LIMITS.requestBytes - overhead + 1) }
    const refused = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers: HOST, body: over })
    expect(refused.status).toBe(413)
    expect(refused.body).toEqual({ error: 'too-large' })
  })

  it('AC-4.12 hello carries the key, the fingerprint and a verifiable signature', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const response = await t.transport.request({ method: 'GET', path: '/api/hello', headers: HOST })
    expect(response.status).toBe(200)
    const body = response.body as { publicKey: PublicJwk; fingerprint: string; nonce: string; signature: string }
    expect(await fingerprint(body.publicKey)).toBe(body.fingerprint)
    expect(await verifyEs256(body.publicKey, b64u.decode(body.nonce), b64u.decode(body.signature))).toBe(true)
  })

  it('API responses are never cached (plan 7)', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const ok = await t.transport.request({ method: 'GET', path: '/api/hello', headers: HOST })
    expect(ok.headers?.['cache-control']).toBe('no-store')
    const refused = await t.transport.request({ method: 'GET', path: '/api/nope', headers: HOST })
    expect(refused.headers?.['cache-control']).toBe('no-store')
  })
})

describe('remote sessions (spec 026 T12)', () => {
  const auth = (token: string) => ({ ...HOST, authorization: `Bearer ${token}` })

  it('AC-6.8 a session lasts an hour and renews by signing', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    t.setNow(3_599_000)
    expect((await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })).status).toBe(200)
    t.setNow(3_601_000)
    const expired = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
    expect(expired.status).toBe(401)
    expect(expired.body).toEqual({ error: 'unknown-device' })
    const renewed = await openSession(t, deviceId, privateKey)
    expect((await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(renewed) })).status).toBe(200)
  })

  it('AC-6.8 a challenge is single use: replaying it is refused', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const challenge = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId } })
    const nonce = (challenge.body as { nonce: string }).nonce
    const signature = b64u.encode(await signBytes(privateKey, b64u.decode(nonce)))
    const first = await t.transport.request({ method: 'POST', path: '/api/session', headers: HOST, body: { deviceId, signature } })
    expect(first.status).toBe(200)
    const replay = await t.transport.request({ method: 'POST', path: '/api/session', headers: HOST, body: { deviceId, signature } })
    expect(replay.status).toBe(401)
    expect(replay.body).toEqual({ error: 'unknown-device' })
  })

  it('AC-6.8 a challenge older than 60 seconds is refused', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const challenge = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId } })
    const nonce = (challenge.body as { nonce: string }).nonce
    t.setNow(61_000)
    const signature = b64u.encode(await signBytes(privateKey, b64u.decode(nonce)))
    const late = await t.transport.request({ method: 'POST', path: '/api/session', headers: HOST, body: { deviceId, signature } })
    expect(late.status).toBe(401)
  })

  it('AC-6.8 a wrong signature or another key is refused like an unknown device', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const first = await pairDevice(t, 'one')
    const second = await pairDevice(t, 'two')
    const signFor = async (key: CryptoKey, bytes: Uint8Array): Promise<string> => b64u.encode(await signBytes(key, bytes))
    const attempt = async (deviceId: string, signature: string) =>
      t.transport.request({ method: 'POST', path: '/api/session', headers: HOST, body: { deviceId, signature } })

    await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId: first.deviceId } })
    const wrongBytes = await attempt(first.deviceId, await signFor(first.privateKey, new TextEncoder().encode('not the nonce')))
    expect(wrongBytes.status).toBe(401)
    expect(wrongBytes.body).toEqual({ error: 'unknown-device' })

    const challenge = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId: first.deviceId } })
    const nonce = (challenge.body as { nonce: string }).nonce
    const wrongKey = await attempt(first.deviceId, await signFor(second.privateKey, b64u.decode(nonce)))
    expect(wrongKey.status).toBe(401)
    expect(wrongKey.body).toEqual({ error: 'unknown-device' })
  })

  it('AC-5.3 unknown, revoked and idle devices share the refusal at challenge time', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const idle = await pairDevice(t, 'idle')
    const gone = await pairDevice(t, 'gone')
    await t.store.remove(gone.deviceId)
    t.setNow(16 * 24 * 3_600_000)
    const bodies = new Set<string>()
    for (const deviceId of ['never-paired', gone.deviceId, idle.deviceId]) {
      const response = await t.transport.request({ method: 'POST', path: '/api/session/challenge', headers: HOST, body: { deviceId } })
      expect(response.status, deviceId).toBe(401)
      bodies.add(JSON.stringify(response.body))
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: 'unknown-device' })])
  })

  it('T32 resolving a session reports token ownership so closeDevice can cut it', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    expect(t.transport.tracked.get(token)).toBeUndefined()
    const response = await t.transport.request({ method: 'GET', path: '/api/approvals', headers: { ...HOST, authorization: `Bearer ${token}` } })
    expect(response.status).not.toBe(401)
    expect(t.transport.tracked.get(token)).toBe(deviceId)
  })

  it('AC-6.2 revoking a device deletes its sessions', () => {
    let now = 0
    const sessions = new SessionStore({ now: () => now, random: (length: number) => new Uint8Array(length).fill(2) })
    const nonce = sessions.challenge('d1')
    expect(sessions.attempt('d1')).toEqual(b64u.decode(nonce))
    const { token } = sessions.issue('d1')
    expect(sessions.resolve(token)).toEqual({ deviceId: 'd1' })
    sessions.challenge('d1')
    sessions.revoke('d1')
    expect(sessions.resolve(token)).toBeNull()
    expect(sessions.attempt('d1')).toBeNull()
    now = 10_000
    expect(sessions.resolve(token)).toBeNull()
  })

  it('AC-6.2 revoking a device deletes its sessions, cuts its connections and refuses the next request', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    t.transport.holdConnection(deviceId)
    await t.channel.revokeDevice(deviceId)
    expect(t.store.devices()).toEqual([])
    expect(t.transport.closedDevices).toEqual([deviceId])
    const after = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
    expect(after.status).toBe(401)
    expect(after.body).toEqual({ error: 'unknown-device' })
  })

  it('AC-6.2 revoking an unknown device is harmless', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    await t.channel.revokeDevice('nope')
    expect(t.transport.closedDevices).toEqual(['nope'])
  })

  it('AC-6.7 use updates lastSeen', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    expect(t.store.devices()[0]?.lastSeen).toBeNull()
    const token = await openSession(t, deviceId, privateKey)
    expect(t.store.devices()[0]?.lastSeen).toBe(0)
    t.setNow(5000)
    await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
    expect(t.store.devices()[0]?.lastSeen).toBe(5000)
  })

  it('AC-10.2 the channel refuses past 60 requests a minute', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    for (let i = 0; i < 60; i++) {
      const response = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
      expect(response.status, `request ${i}`).toBe(200)
    }
    const refused = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual({ error: 'rate-limited' })
  })

  it('AC-10.4 a request the PC does not finish within 30 seconds ends with an error', async () => {
    vi.useFakeTimers()
    try {
      const t = await testChannel({ remote: { enabled: true } })
      await t.channel.sync()
      const { deviceId, privateKey } = await pairDevice(t)
      const token = await openSession(t, deviceId, privateKey)
      // The session lookup never answers: the handler hangs.
      vi.spyOn(t.store, 'touch').mockImplementation(() => new Promise(() => {}))
      let settled: RemoteResponse | null = null
      void t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) }).then((response) => {
        settled = response
      })
      await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.timeoutMs - 1)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toMatchObject({ status: 500, body: { error: 'failed' } })
    } finally {
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it('AC-10.4 the 30 second cut leaves the 25 second long poll alone', async () => {
    vi.useFakeTimers()
    try {
      const t = await testChannel({ remote: { enabled: true } })
      await t.channel.sync()
      const { deviceId, privateKey } = await pairDevice(t)
      const token = await openSession(t, deviceId, privateKey)
      t.setRemote({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      t.chat.seed([{ role: 'user', content: [{ type: 'text', text: 'viejo' }], ts: 1000 }])
      const pending = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=1', headers: auth(token) })
      await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.longPollMs)
      expect((await pending).status).toBe(200)
      await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.timeoutMs)
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-5.1 status reports the live scope switches and no device id', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    const response = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
    expect(response.body).toEqual({ scopes: { chat: false, approve: false, home: false, cameras: false, vault: false, history: false }, sensitive: false, continue: false })
    t.setRemote({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
    const on = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
    expect((on.body as { scopes: Record<string, boolean> }).scopes.chat).toBe(true)
  })

  it('AC-5.2 a scope change applies on the next request', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    const { deviceId, privateKey } = await pairDevice(t)
    const token = await openSession(t, deviceId, privateKey)
    const send = { method: 'POST' as const, path: '/api/chat/send', headers: auth(token), body: { text: 'hi' } }
    const before = await t.transport.request(send)
    expect(before.status).toBe(403)
    expect(before.body).toEqual({ error: 'scope-off' })
    t.setRemote({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
    // The request passed authorization and reached the T20 handler: the run starts.
    expect((await t.transport.request(send)).status).toBe(200)
    expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: 'hi' }])
  })
})
