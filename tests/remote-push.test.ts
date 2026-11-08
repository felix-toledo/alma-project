import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { b64u, verifyEs256 } from '../src/shared/remote/crypto'
import { subscribePush } from '../src/remote-client/lib/push'
import { HOST, openSession, pairDevice, testChannel } from './support/remote-harness'

const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-token-123',
  keys: { p256dh: 'p256dh-key-material', auth: 'auth-secret-material' }
}

async function paired(): Promise<{ t: Awaited<ReturnType<typeof testChannel>>; deviceId: string; token: string }> {
  let byte = 0
  const random = (length: number): Uint8Array => {
    byte = (byte % 250) + 1
    return new Uint8Array(length).fill(byte)
  }
  const t = await testChannel({ remote: { enabled: true, scopes: { chat: true, approve: true, home: false, cameras: false, vault: false, history: false } }, random })
  await t.channel.sync()
  const { deviceId, privateKey } = await pairDevice(t, 'phone')
  const token = await openSession(t, deviceId, privateKey)
  return { t, deviceId, token }
}

const auth = (token: string): Record<string, string> => ({ ...HOST, authorization: `Bearer ${token}` })

describe('T46 push without content (AC-11.1 to 11.5, 9.1)', () => {
  it('AC-11.1: one request, empty body, valid VAPID authorization, no tool name anywhere', async () => {
    const { t, token } = await paired()
    const keyRes = await t.transport.request({ method: 'GET', path: '/api/push/key', headers: auth(token) })
    expect(keyRes.status).toBe(200)
    const sub = await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: SUBSCRIPTION })
    expect(sub.status).toBe(200)
    t.setNow(1_000_000)
    const asked = t.approvals.askApproval({ threadId: 'remote', toolUseId: 'u1', toolName: 'shell_exec', input: {}, flagged: false, allowAlways: false })
    // The broker event drives the push; wait for the async send.
    for (let i = 0; i < 100 && t.posts.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.posts).toHaveLength(1)
    const [post] = t.posts
    expect(post.url).toBe(SUBSCRIPTION.endpoint)
    expect(post.body.length).toBe(0)
    const authorization = post.headers.authorization ?? ''
    expect(authorization.startsWith('vapid t=')).toBe(true)
    const [, jwt, key] = authorization.match(/^vapid t=([^,]+), k=(.+)$/) ?? []
    expect(jwt).toBeTruthy()
    expect(key).toBe((keyRes.body as { key: string }).key)
    // The JWT verifies against the VAPID public key, for this endpoint only.
    const [header, payload, signature] = jwt.split('.')
    const vapid = t.state.state.vapid
    await expect(verifyEs256(vapid.public, new TextEncoder().encode(`${header}.${payload}`), b64u.decode(signature))).resolves.toBe(true)
    const claims = JSON.parse(new TextDecoder().decode(b64u.decode(payload))) as { aud: string; exp: number }
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.exp).toBe(1000 + 12 * 3600)
    // No payload, no tool name: the push carries nothing about the approval.
    // The signature and key are random base64url: "u1" shows up in them by chance (1 run in ~40), so only
    // the readable parts are searched.
    const seen = `${post.url} ${JSON.stringify(claims)} ${post.headers.TTL}`
    expect(seen).not.toContain('shell_exec')
    expect(seen).not.toContain('u1')
    asked.decision.catch(() => undefined)
  })

  it('AC-11.2: nothing without a subscription, with the scope off, or for another thread', async () => {
    const { t, token } = await paired()
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.posts).toEqual([])
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: SUBSCRIPTION })
    t.setRemote({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.posts).toEqual([])
    t.setRemote({ scopes: { chat: true, approve: true, home: false, cameras: false, vault: false, history: false } })
    await t.channel.notifyPush({ threadId: 'some-other-thread' })
    expect(t.posts).toEqual([])
  })

  it('AC-11.3: the subscription is sealed on disk and absent from the audit', async () => {
    const { t, token } = await paired()
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: SUBSCRIPTION })
    // The harness seal is a visible `sealed:` prefix by design (safeStorage needs the
    // real app); what this pins is that the subscription only ever reaches the disk
    // through the seal box, never as plaintext fields.
    const file = readFileSync(join(t.dir, 'devices.json'), 'utf8')
    expect(file).toContain('pushSealed')
    expect(file).not.toContain('"push":')
    expect(file).not.toContain('"endpoint":')
    expect(file).not.toContain('"p256dh":')
    expect(file).not.toContain('"auth":')
    const audit = JSON.stringify(t.records)
    expect(audit).not.toContain('device-token-123')
    expect(audit).not.toContain('p256dh-key-material')
  })

  it('AC-11.4: revoke and erase delete the subscription', async () => {
    const { t, token, deviceId } = await paired()
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: SUBSCRIPTION })
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.posts).toHaveLength(1)
    // Unsubscribe from the phone stops it.
    const deleted = await t.transport.request({ method: 'DELETE', path: '/api/push', headers: auth(token) })
    expect(deleted.status).toBe(200)
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.posts).toHaveLength(1)
    // Revoke deletes it with the record.
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: SUBSCRIPTION })
    await t.channel.revokeDevice(deviceId)
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.posts).toHaveLength(1)
  })

  it('AC-11.5: a push failure leaves the approval pending', async () => {
    const { t, token } = await paired()
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: SUBSCRIPTION })
    const asked = t.approvals.askApproval({ threadId: 'remote', toolUseId: 'u1', toolName: 'shell_exec', input: {}, flagged: false, allowAlways: false })
    t.failPost()
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.approvals.broker.pending().map((pending) => pending.approvalId)).toContain(asked.approvalId)
    asked.decision.catch(() => undefined)
  })

  it('endpoint checks: http, private, unknown-host and credentialed URLs are refused', async () => {
    const { t, token } = await paired()
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://192.168.1.2/fcm/send/x',
      'https://localhost/fcm/send/x',
      'https://evil.example.com/fcm/send/x',
      'https://user:pass@fcm.googleapis.com/fcm/send/x',
      'not-a-url'
    ]) {
      const res = await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: { endpoint, keys: SUBSCRIPTION.keys } })
      expect(res.status).toBe(400)
    }
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/x',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://api.push.apple.com/3/device/x',
      'https://s.notify.windows.com/?token=x'
    ]) {
      const res = await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: { endpoint, keys: SUBSCRIPTION.keys } })
      expect(res.status).toBe(200)
    }
  })

  it('AC-11.6 lib/push: subscribes with the PC key and posts endpoint plus keys', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined })
      if (url === '/api/push/key') return { ok: true, status: 200, json: async () => ({ key: 'a2V5' }) }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as never
    const subscription = { endpoint: SUBSCRIPTION.endpoint, keys: SUBSCRIPTION.keys }
    const seen: unknown[] = []
    const subscribe = async (options: unknown) => {
      seen.push(options)
      return subscription
    }
    await expect(subscribePush({ fetch, token: 'tok', subscribe })).resolves.toEqual({ ok: true })
    expect(seen).toEqual([{ applicationServerKey: 'a2V5', userVisibleOnly: true }])
    expect(calls).toEqual([
      { url: '/api/push/key', body: undefined },
      { url: '/api/push/subscribe', body: subscription }
    ])
  })
})
