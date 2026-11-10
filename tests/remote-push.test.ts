import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { b64u, verifyEs256 } from '../src/shared/remote/crypto'
import { encryptPushPayload, GREETING_PUSH_CODE } from '../src/shared/remote/push'
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

const text = new TextEncoder()
type Bytes = Parameters<typeof crypto.subtle.digest>[1]
type KeyPair = { publicKey: CryptoKey; privateKey: CryptoKey }
const bytes = (data: Uint8Array): Bytes => data as Bytes
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bytes(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bytes(salt), info: bytes(info) }, key, length * 8))
}

/** The phone's side of RFC 8291, written here independently of the sender so the two can disagree. */
async function decryptPush(body: Uint8Array, receiver: CryptoKey, receiverPublic: Uint8Array, authSecret: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16)
  const idlen = body[20]
  const senderPublic = body.slice(21, 21 + idlen)
  const sender = await crypto.subtle.importKey('raw', bytes(senderPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, receiver, 256))
  const ikm = await hkdf(authSecret, ecdh, concat(text.encode('WebPush: info '), receiverPublic, senderPublic), 32)
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm '), 16)
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce '), 12)
  const key = await crypto.subtle.importKey('raw', bytes(cek), 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(nonce) }, key, bytes(body.slice(21 + idlen))))
  let end = padded.length - 1
  while (padded[end] === 0) end--
  expect(padded[end]).toBe(2)
  return new TextDecoder().decode(padded.slice(0, end))
}

// RFC 8291 section 5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

async function ecdhPair(publicRaw: string, privateD: string): Promise<KeyPair> {
  const point = b64u.decode(publicRaw)
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(point.slice(1, 33)), y: b64u.encode(point.slice(33, 65)) }
  return {
    publicKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
    privateKey: await crypto.subtle.importKey('jwk', { ...jwk, d: privateD }, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  }
}

describe('033 greeting push payload (AC-7.13, D-1)', () => {
  it('AC-7.13 (033) the greeting payload is RFC 8291 aes128gcm', async () => {
    // The RFC's own example reproduces byte for byte.
    const sender = await ecdhPair(RFC.asPublic, RFC.asPrivate)
    const vector = await encryptPushPayload({
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
      plaintext: text.encode(RFC.plaintext),
      salt: b64u.decode(RFC.salt),
      sender
    })
    expect(b64u.encode(vector.body)).toBe(RFC.body)
    expect(vector.headers['Content-Encoding']).toBe('aes128gcm')
    const receiver = await ecdhPair(RFC.uaPublic, RFC.uaPrivate)
    await expect(decryptPush(vector.body, receiver.privateKey, b64u.decode(RFC.uaPublic), b64u.decode(RFC.auth))).resolves.toBe(RFC.plaintext)

    // A real subscription: fresh keys, fresh salt, and the plaintext is exactly the fixed code.
    expect(GREETING_PUSH_CODE).toBe('g')
    const phone = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as KeyPair
    const phonePublic = new Uint8Array(await crypto.subtle.exportKey('raw', phone.publicKey))
    const authSecret = crypto.getRandomValues(new Uint8Array(16))
    const sealed = await encryptPushPayload({ p256dh: b64u.encode(phonePublic), auth: b64u.encode(authSecret), plaintext: text.encode(GREETING_PUSH_CODE) })
    expect(sealed.headers['Content-Encoding']).toBe('aes128gcm')
    await expect(decryptPush(sealed.body, phone.privateKey, phonePublic, authSecret)).resolves.toBe(GREETING_PUSH_CODE)
  })

  it('AC-7.13 (033) a plaintext that does not fit one record is refused', async () => {
    const phone = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as KeyPair
    const p256dh = b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', phone.publicKey)))
    const auth = b64u.encode(crypto.getRandomValues(new Uint8Array(16)))
    // 4096 bytes a record: the plaintext, its delimiter and the 16-byte tag.
    await expect(encryptPushPayload({ p256dh, auth, plaintext: new Uint8Array(4079) })).resolves.toBeDefined()
    await expect(encryptPushPayload({ p256dh, auth, plaintext: new Uint8Array(4080) })).rejects.toThrow()
  })
})

/** A subscription with real keys, so the greeting payload can be decrypted as the phone would. */
async function phoneSubscription(endpoint: string): Promise<{ body: { endpoint: string; keys: { p256dh: string; auth: string } }; decrypt(body: Uint8Array): Promise<string> }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as KeyPair
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))
  return {
    body: { endpoint, keys: { p256dh: b64u.encode(publicRaw), auth: b64u.encode(authSecret) } },
    decrypt: (body) => decryptPush(body, pair.privateKey, publicRaw, authSecret)
  }
}

const SCOPES = { chat: true, approve: true, home: false, cameras: false, vault: false, history: false }

describe('033 greeting push (AC-7.13, AC-7.6, AC-8.1)', () => {
  it('AC-7.13 (033) the greeting push is content-free and needs History', async () => {
    const { t, token } = await paired()
    const phone = await phoneSubscription(SUBSCRIPTION.endpoint)
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: phone.body })
    // History off: nothing.
    await t.channel.notifyGreeting()
    expect(t.posts).toEqual([])
    t.setRemote({ scopes: { ...SCOPES, history: true } })
    await t.channel.notifyGreeting()
    expect(t.posts).toHaveLength(1)
    const [post] = t.posts
    expect(post.url).toBe(SUBSCRIPTION.endpoint)
    expect(post.headers.authorization?.startsWith('vapid t=')).toBe(true)
    expect(post.headers['Content-Encoding']).toBe('aes128gcm')
    await expect(phone.decrypt(post.body)).resolves.toBe(GREETING_PUSH_CODE)
    // Each subscribed device gets one post of its own (AC-8.1: only to its push service).
    const tablet = await pairDevice(t, 'tablet')
    const tabletToken = await openSession(t, tablet.deviceId, tablet.privateKey)
    const second = await phoneSubscription('https://updates.push.services.mozilla.com/wpush/v2/tablet')
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(tabletToken), body: second.body })
    await t.channel.notifyGreeting()
    expect(t.posts.slice(1).map((sent) => sent.url).sort()).toEqual([SUBSCRIPTION.endpoint, second.body.endpoint].sort())
    await expect(second.decrypt(t.posts.find((sent, i) => i > 0 && sent.url === second.body.endpoint)?.body ?? new Uint8Array())).resolves.toBe(GREETING_PUSH_CODE)
    // Remote off: nothing.
    t.setRemote({ enabled: false })
    await t.channel.notifyGreeting()
    expect(t.posts).toHaveLength(3)
    // The approval push is still an empty body.
    t.setRemote({ enabled: true })
    await t.channel.notifyPush({ threadId: 'remote' })
    expect(t.posts.slice(3).map((sent) => sent.body.length)).toEqual([0, 0])
  })

  it('AC-7.6 (033) a failed greeting push is silent and not retried', async () => {
    const { t, token } = await paired()
    const phone = await phoneSubscription(SUBSCRIPTION.endpoint)
    await t.transport.request({ method: 'POST', path: '/api/push/subscribe', headers: auth(token), body: phone.body })
    t.setRemote({ scopes: { ...SCOPES, history: true } })
    t.failPost()
    await expect(t.channel.notifyGreeting()).resolves.toBeUndefined()
    expect(t.refused).toEqual([SUBSCRIPTION.endpoint])
  })
})
