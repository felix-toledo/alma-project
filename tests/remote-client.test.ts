import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { b64u, fingerprint, verifyEs256, type PublicJwk } from '../src/shared/remote/crypto'
import { pairingCode } from '../src/shared/remote/pairing'
import { generateDeviceKey, signWithDeviceKey } from '../src/remote-client/lib/keys'
import { checkHello, deriveCode, isInstalledApp, pairRequestErrorKey, parsePairFragment, pollPairStatus, requestPair } from '../src/remote-client/lib/pairing'
import { backoffMs, mergeState, nextSince, pollOnce, pong, refusalKey, type PwaState } from '../src/remote-client/lib/poll'
import { needsRenewal, openSession, RENEW_BEFORE_MS, type FetchLike, type FetchResponse } from '../src/remote-client/lib/session'
import { forgetPc, memoryStorage, wipePwa } from '../src/remote-client/lib/storage'
import { registerPasskey, submitPasskey } from '../src/remote-client/lib/webauthn'
import { answerApproval, approvalQuestionKey, chatOutcomeKey, newChat, sendChat, stopChat, validateChatInput } from '../src/remote-client/lib/chat'
import { fetchCameras, fetchStill } from '../src/remote-client/lib/cameras'
import { controlThing, fetchThings, groupByRoom, thingActions } from '../src/remote-client/lib/home'
import { assertStepUp, requestStepUp } from '../src/remote-client/lib/stepup'

function jsonResponse(status: number, body: unknown): FetchResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function fakeFetch(handler: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => FetchResponse | Promise<FetchResponse>): FetchLike & { calls: { url: string; init?: object }[] } {
  const calls: { url: string; init?: object }[] = []
  const fetch = (async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => {
    calls.push({ url, init })
    return handler(url, init)
  }) as FetchLike & { calls: { url: string; init?: object }[] }
  fetch.calls = calls
  return fetch
}

async function pcHello(): Promise<{ body: { publicKey: PublicJwk; fingerprint: string; nonce: string; signature: string } }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as PublicJwk
  const nonce = crypto.getRandomValues(new Uint8Array(32))
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, nonce as unknown as ArrayBuffer))
  return { body: { publicKey, fingerprint: await fingerprint(publicKey), nonce: b64u.encode(nonce), signature: b64u.encode(signature) } }
}

describe('T41 PWA logic (AC-4.12, 5.3, 6.8, 8.1, 8.5)', () => {
  it('AC-4.12: hello with a valid signature and the QR fingerprint passes', async () => {
    const { body } = await pcHello()
    const fetch = fakeFetch(() => jsonResponse(200, body))
    await expect(checkHello({ fetch, expectedFingerprint: body.fingerprint })).resolves.toEqual({ ok: true })
  })

  it('AC-4.12: a fingerprint mismatch aborts before sending anything else', async () => {
    const { body } = await pcHello()
    const fetch = fakeFetch(() => jsonResponse(200, body))
    await expect(checkHello({ fetch, expectedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).resolves.toEqual({
      ok: false,
      reason: 'mismatch'
    })
    expect(fetch.calls.map((call) => call.url)).toEqual(['/api/hello'])
  })

  it('AC-4.12: a bad hello signature, or a fingerprint that is not the key one, mismatches', async () => {
    const { body } = await pcHello()
    const badSignature = fakeFetch(() => jsonResponse(200, { ...body, signature: b64u.encode(new Uint8Array(64)) }))
    await expect(checkHello({ fetch: badSignature, expectedFingerprint: body.fingerprint })).resolves.toEqual({ ok: false, reason: 'mismatch' })
    const lyingFingerprint = fakeFetch(() => jsonResponse(200, { ...body, fingerprint: body.fingerprint.slice(0, -1) + (body.fingerprint.endsWith('A') ? 'B' : 'A') }))
    await expect(checkHello({ fetch: lyingFingerprint, expectedFingerprint: body.fingerprint })).resolves.toEqual({ ok: false, reason: 'mismatch' })
  })

  it('the device key is generated non-extractable, signs, and exports only its public half', async () => {
    const device = await generateDeviceKey()
    await expect(crypto.subtle.exportKey('jwk', device.privateKey)).rejects.toThrow()
    const bytes = new TextEncoder().encode('nonce-bytes')
    const signature = await signWithDeviceKey(device.privateKey, bytes)
    await expect(verifyEs256(device.publicJwk, bytes, signature)).resolves.toBe(true)
  })

  it('requestPair sends the secret and the public key, and reads pcNonce and expiry', async () => {
    const device = await generateDeviceKey()
    const fetch = fakeFetch((url, init) => {
      expect(url).toBe('/api/pair/request')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      expect(body.secret).toBe('p'.repeat(43))
      expect(body.phonePublicKey).toEqual(device.publicJwk)
      return jsonResponse(200, { pcNonce: 'n'.repeat(22), expiresAt: 1234 })
    })
    await expect(requestPair({ fetch, secret: 'p'.repeat(43), phonePublicKey: device.publicJwk })).resolves.toEqual({
      ok: true,
      pcNonce: 'n'.repeat(22),
      expiresAt: 1234
    })
  })

  it('requestPair maps refusals; deriveCode equals the shared pairingCode', async () => {
    const device = await generateDeviceKey()
    for (const [status, reason] of [[400, 'invalid'], [410, 'expired'], [409, 'busy'], [429, 'rate-limited']] as const) {
      const fetch = fakeFetch(() => jsonResponse(status, { error: reason }))
      await expect(requestPair({ fetch, secret: 'p'.repeat(43), phonePublicKey: device.publicJwk })).resolves.toEqual({ ok: false, reason })
    }
    const secret = b64u.decode('p'.repeat(43))
    await expect(deriveCode({ secret: 'p'.repeat(43), phoneKey: device.publicJwk, pcNonce: 'n'.repeat(22) })).resolves.toBe(
      await pairingCode({ secret, phoneKey: device.publicJwk, pcNonce: 'n'.repeat(22) })
    )
  })

  it('a failed pair request names its own text: an unknown secret is a stale code, not the wrong PC', () => {
    expect(pairRequestErrorKey('expired')).toBe('remote.pwa.pairing.expired')
    expect(pairRequestErrorKey('invalid')).toBe('remote.pwa.pairing.rescan')
    expect(pairRequestErrorKey('network')).toBe('remote.pwa.pcUnreachable')
    expect(pairRequestErrorKey('busy')).toBe('remote.pwa.rateLimited')
    expect(pairRequestErrorKey('rate-limited')).toBe('remote.pwa.rateLimited')
  })

  it('pollPairStatus reads pending, approval with a passkey challenge, and terminal states', async () => {
    const pending = fakeFetch(() => jsonResponse(200, { status: 'pending', expiresAt: 99 }))
    await expect(pollPairStatus({ fetch: pending, offer: 'o', pcNonce: 'p', fp: 'f' })).resolves.toEqual({ ok: true, status: 'pending', expiresAt: 99 })
    expect(pending.calls[0].url).toBe('/api/pair/status?offer=o&pcNonce=p&fp=f')
    const approved = fakeFetch(() => jsonResponse(200, { status: 'approved', deviceId: 'd1', passkeyChallenge: 'c' }))
    await expect(pollPairStatus({ fetch: approved, offer: 'o', pcNonce: 'p', fp: 'f' })).resolves.toEqual({
      ok: true,
      status: 'approved',
      deviceId: 'd1',
      passkeyChallenge: 'c'
    })
    for (const status of ['rejected', 'expired', 'locked'] as const) {
      const fetch = fakeFetch(() => jsonResponse(200, { status }))
      await expect(pollPairStatus({ fetch, offer: 'o', pcNonce: 'p', fp: 'f' })).resolves.toEqual({ ok: true, status })
    }
  })

  it('openSession signs the challenge nonce and reads the token with its expiry', async () => {
    const device = await generateDeviceKey()
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    const fetch = fakeFetch((url, init) => {
      if (url === '/api/session/challenge') return jsonResponse(200, { nonce: b64u.encode(nonce) })
      const body = JSON.parse(init?.body as string) as { deviceId: string; signature: string }
      expect(body.deviceId).toBe('d1')
      return jsonResponse(200, { token: 'tok', expiresIn: 3600, _signature: body.signature })
    })
    const opened = await openSession({ fetch, deviceId: 'd1', sign: (bytes) => signWithDeviceKey(device.privateKey, bytes), now: () => 1_000_000 })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.session).toEqual({ token: 'tok', expiresAt: 1_000_000 + 3_600_000 })
    const sent = JSON.parse((fetch.calls[1].init as { body: string }).body) as { signature: string }
    await expect(verifyEs256(device.publicJwk, nonce, b64u.decode(sent.signature))).resolves.toBe(true)
  })

  it('openSession maps a key refusal and network failure without throwing', async () => {
    const refused = fakeFetch(() => jsonResponse(401, { error: 'unknown-device' }))
    await expect(openSession({ fetch: refused, deviceId: 'd1', sign: async () => new Uint8Array(64), now: () => 0 })).resolves.toEqual({
      ok: false,
      reason: 'refused'
    })
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(openSession({ fetch: down, deviceId: 'd1', sign: async () => new Uint8Array(64), now: () => 0 })).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
  })

  it('AC-6.8: renewal is due a few minutes before the hour; a miss keeps the old session', async () => {
    expect(RENEW_BEFORE_MS).toBe(5 * 60_000)
    expect(needsRenewal(null, 0)).toBe(true)
    expect(needsRenewal({ token: 't', expiresAt: 3_600_000 }, 0)).toBe(false)
    expect(needsRenewal({ token: 't', expiresAt: 3_600_000 }, 3_600_000 - RENEW_BEFORE_MS - 1)).toBe(false)
    expect(needsRenewal({ token: 't', expiresAt: 3_600_000 }, 3_600_000 - RENEW_BEFORE_MS)).toBe(true)
    // A failed renewal returns a reason (the screen shows pcUnreachable); the stored
    // session is untouched because nothing saved over it.
    const storage = memoryStorage()
    await storage.saveSession({ token: 'old', expiresAt: 100 })
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(openSession({ fetch: down, deviceId: 'd1', sign: async () => new Uint8Array(64), now: () => 0 })).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
    await expect(storage.loadSession()).resolves.toEqual({ token: 'old', expiresAt: 100 })
  })

  it('AC-5.3/AC-8.5: a key refusal wipes the key, the subscription and the caches, and reports revoked', async () => {
    const storage = memoryStorage()
    const device = await generateDeviceKey()
    await storage.saveDevice({ deviceId: 'd1', privateKey: device.privateKey, publicJwk: device.publicJwk })
    await storage.saveSession({ token: 'tok', expiresAt: 1 })
    const deleted: string[] = []
    const caches = { keys: async () => ['alma-shell', 'v1'], delete: async (name: string) => { deleted.push(name); return true } }
    const fetch = fakeFetch(() => jsonResponse(401, { error: 'unknown-device' }))
    const polled = await pollOnce({ fetch, token: 'tok', since: null, signal: new AbortController().signal })
    expect(polled).toEqual({ ok: false, reason: 'refused' })
    expect(refusalKey('refused')).toBe('remote.pwa.revoked')
    await wipePwa({ storage, caches })
    await expect(storage.loadDevice()).resolves.toBeNull()
    await expect(storage.loadSession()).resolves.toBeNull()
    expect(deleted.sort()).toEqual(['alma-shell', 'v1'])
  })

  it('AC-8.1: the poll sends since with the Bearer token and reads one state', async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url).toBe('/api/state?since=41')
      expect(init?.headers).toEqual({ authorization: 'Bearer tok' })
      return jsonResponse(200, { rev: 42, running: false, messages: [], approvals: [] })
    })
    await expect(pollOnce({ fetch, token: 'tok', since: 41, signal: new AbortController().signal })).resolves.toEqual({
      ok: true,
      state: { rev: 42, running: false, messages: [], approvals: [] }
    })
    const first = fakeFetch((url) => {
      expect(url).toBe('/api/state')
      return jsonResponse(200, { rev: 1, running: true })
    })
    await expect(pollOnce({ fetch: first, token: 'tok', since: null, signal: new AbortController().signal })).resolves.toEqual({
      ok: true,
      state: { rev: 1, running: true, messages: [], approvals: [] }
    })
  })

  it('AC-8.1: failures back off with pcUnreachable, never queue, and honor the abort signal', async () => {
    expect([0, 1, 2, 5, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 30000, 30000])
    expect(refusalKey('network')).toBe('remote.pwa.pcUnreachable')
    expect(refusalKey('rate-limited')).toBe('remote.pwa.rateLimited')
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(pollOnce({ fetch: down, token: 't', since: null, signal: new AbortController().signal })).resolves.toEqual({
      ok: false,
      reason: 'network'
    })
    const limited = fakeFetch(() => jsonResponse(429, { error: 'rate-limited' }))
    await expect(pollOnce({ fetch: limited, token: 't', since: null, signal: new AbortController().signal })).resolves.toEqual({
      ok: false,
      reason: 'rate-limited'
    })
    // One call, one request: nothing queues behind a slow poll.
    let inFlight = 0
    let maxInFlight = 0
    const slow = fakeFetch(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      return jsonResponse(200, { rev: 1, running: false })
    })
    await pollOnce({ fetch: slow, token: 't', since: null, signal: new AbortController().signal })
    expect(maxInFlight).toBe(1)
    expect(slow.calls).toHaveLength(1)
    // The caller's signal reaches fetch, so hiding the page aborts the long poll.
    const controller = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    const abortable = fakeFetch((_url, init) => {
      seen.push(init?.signal)
      return jsonResponse(200, { rev: 1, running: false })
    })
    await pollOnce({ fetch: abortable, token: 't', since: null, signal: controller.signal })
    expect(seen).toEqual([controller.signal])
  })

  describe('AC-8.7: earlier messages survive polls', () => {
    const msg = (index: number) => ({ index, role: index % 2 ? 'assistant' : 'user', text: `m${index}`, at: index })
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => msg(from + i))
    const approval = { id: 'a1' }
    const first: PwaState = { rev: 5, running: false, messages: range(0, 5), approvals: [approval] }

    it('AC-8.7: an idle poll (empty delta, same rev) keeps every message', () => {
      const idle: PwaState = { rev: 5, running: false, messages: [], approvals: [approval] }
      expect(mergeState(first, idle).messages).toEqual(first.messages)
    })

    it('AC-8.7: a delta appends the new message with no duplicates, and the first load is kept as is', () => {
      const merged = mergeState(first, { rev: 6, running: true, messages: [msg(5)], approvals: [] })
      expect(merged.messages.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5])
      expect(mergeState(merged, { rev: 6, running: true, messages: [msg(5)], approvals: [] }).messages).toHaveLength(6)
      expect(mergeState(null, first).messages).toEqual(first.messages)
    })

    it('AC-8.7: rev, running, approvals and ping come from the newest poll, never wiped by a delta', () => {
      const merged = mergeState(first, { rev: 6, running: true, messages: [], approvals: [], ping: 'p1' })
      expect(merged).toMatchObject({ rev: 6, running: true, approvals: [], ping: 'p1' })
      expect(mergeState(first, { rev: 5, running: false, messages: [], approvals: [approval] }).approvals).toEqual([approval])
    })

    it('AC-8.7: the screen keeps at most the last 30 messages', () => {
      const full: PwaState = { rev: 30, running: false, messages: range(0, 30), approvals: [] }
      const merged = mergeState(full, { rev: 32, running: false, messages: [msg(30), msg(31)], approvals: [] })
      expect(merged.messages).toHaveLength(30)
      expect(merged.messages[0]?.index).toBe(2)
      expect(merged.messages[29]?.index).toBe(31)
    })

    it('AC-8.7: a new conversation (rev goes back) drops the old messages and asks for a full load', () => {
      const swapped: PwaState = { rev: 0, running: false, messages: [], approvals: [] }
      expect(mergeState(first, swapped).messages).toEqual([])
      expect(nextSince(first, swapped)).toBeNull()
      expect(nextSince(first, { ...first, rev: 6 })).toBe(6)
      expect(nextSince(null, first)).toBe(5)
    })
  })

  describe('T43 device-test pong (AC-2.5)', () => {
    it('pong answers the ping id, and a failure is silent (the PC times out)', async () => {
      const fetch = fakeFetch((url, init) => {
        expect(url).toBe('/api/pong')
        expect(JSON.parse(init?.body as string)).toEqual({ ping: 'p1' })
        return jsonResponse(200, { ok: true })
      })
      await expect(pong({ fetch, token: 'tok', ping: 'p1' })).resolves.toBeUndefined()
      const down: FetchLike = async () => {
        throw new TypeError('fetch failed')
      }
      await expect(pong({ fetch: down, token: 'tok', ping: 'p1' })).resolves.toBeUndefined()
    })
  })

  describe('T42 pairing fragment and passkey (AC-4.2, 4.8, 4.13)', () => {
    it('parsePairFragment reads #p and #f, and rejects anything else', () => {
      expect(parsePairFragment('#p=abc&f=def')).toEqual({ secret: 'abc', fingerprint: 'def' })
      expect(parsePairFragment('#f=def&p=abc')).toEqual({ secret: 'abc', fingerprint: 'def' })
      expect(parsePairFragment('#p=a%2Bb&f=d%2Bf')).toEqual({ secret: 'a+b', fingerprint: 'd+f' })
      expect(parsePairFragment('')).toBeNull()
      expect(parsePairFragment('#p=abc')).toBeNull()
      expect(parsePairFragment('#f=def')).toBeNull()
      expect(parsePairFragment('#p=&f=')).toBeNull()
      expect(parsePairFragment('#other=1')).toBeNull()
      expect(parsePairFragment('p=abc&f=def')).toBeNull()
    })

    it('T51 isInstalledApp is true in standalone display mode or iOS standalone, false in a tab', () => {
      expect(isInstalledApp({ displayModeStandalone: true })).toBe(true)
      expect(isInstalledApp({ displayModeStandalone: false, navigatorStandalone: true })).toBe(true)
      expect(isInstalledApp({ displayModeStandalone: false })).toBe(false)
      expect(isInstalledApp({ displayModeStandalone: false, navigatorStandalone: false })).toBe(false)
    })

    it('registerPasskey encodes the attestation, and a refusal reads as null', async () => {
      const attestation = { attestationObject: new Uint8Array([1, 2, 3]), clientDataJSON: new Uint8Array([4, 5]) }
      const creator = async () => attestation
      await expect(registerPasskey({ create: creator, challenge: new Uint8Array([9]), rpId: 'pc.ts.net', userId: new Uint8Array([7]) })).resolves.toEqual({
        attestationObject: b64u.encode(attestation.attestationObject),
        clientDataJSON: b64u.encode(attestation.clientDataJSON)
      })
      await expect(registerPasskey({ create: async () => null, challenge: new Uint8Array([9]), rpId: 'pc.ts.net', userId: new Uint8Array([7]) })).resolves.toBeNull()
      await expect(
        registerPasskey({
          create: async () => {
            throw new DOMException('cancelled')
          },
          challenge: new Uint8Array([9]),
          rpId: 'pc.ts.net',
          userId: new Uint8Array([7])
        })
      ).resolves.toBeNull()
    })

    it('submitPasskey posts the attestation against the approved pairing', async () => {
      const fetch = fakeFetch((url, init) => {
        expect(url).toBe('/api/pair/passkey')
        expect(JSON.parse(init?.body as string)).toEqual({ offer: 'o', pcNonce: 'p', attestationObject: 'a', clientDataJSON: 'c' })
        return jsonResponse(200, {})
      })
      await expect(submitPasskey({ fetch, offer: 'o', pcNonce: 'p', attestationObject: 'a', clientDataJSON: 'c' })).resolves.toEqual({ ok: true })
      const rejected = fakeFetch(() => jsonResponse(400, { error: 'invalid' }))
      await expect(submitPasskey({ fetch: rejected, offer: 'o', pcNonce: 'p', attestationObject: 'a', clientDataJSON: 'c' })).resolves.toEqual({
        ok: false,
        reason: 'invalid'
      })
      const down: FetchLike = async () => {
        throw new TypeError('fetch failed')
      }
      await expect(submitPasskey({ fetch: down, offer: 'o', pcNonce: 'p', attestationObject: 'a', clientDataJSON: 'c' })).resolves.toEqual({
        ok: false,
        reason: 'network'
      })
    })
  })

  describe('T43 chat helpers (AC-5.5 to 5.9, 5.16, 5.24)', () => {
    it('validateChatInput refuses empty and over-8000 texts', () => {
      expect(validateChatInput('')).toEqual({ ok: false, reason: 'empty' })
      expect(validateChatInput('   ')).toEqual({ ok: false, reason: 'empty' })
      expect(validateChatInput('x'.repeat(8000))).toEqual({ ok: true })
      expect(validateChatInput('x'.repeat(8001))).toEqual({ ok: false, reason: 'too-long' })
    })

    it('sendChat posts the text and maps a busy run and failures to not-delivered', async () => {
      const fetch = fakeFetch((url, init) => {
        expect(url).toBe('/api/chat/send')
        expect(init?.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' })
        expect(JSON.parse(init?.body as string)).toEqual({ text: 'hi' })
        return jsonResponse(200, { ok: true })
      })
      await expect(sendChat({ fetch, token: 'tok', text: 'hi' })).resolves.toEqual({ ok: true })
      const busy = fakeFetch(() => jsonResponse(409, { error: 'busy' }))
      await expect(sendChat({ fetch: busy, token: 'tok', text: 'hi' })).resolves.toEqual({ ok: false, reason: 'not-delivered' })
      const failed = fakeFetch(() => jsonResponse(500, { error: 'failed' }))
      await expect(sendChat({ fetch: failed, token: 'tok', text: 'hi' })).resolves.toEqual({ ok: false, reason: 'not-delivered' })
      const refused = fakeFetch(() => jsonResponse(401, { error: 'unknown-device' }))
      await expect(sendChat({ fetch: refused, token: 'tok', text: 'hi' })).resolves.toEqual({ ok: false, reason: 'refused' })
      const off = fakeFetch(() => jsonResponse(403, { error: 'scope-off' }))
      await expect(sendChat({ fetch: off, token: 'tok', text: 'hi' })).resolves.toEqual({ ok: false, reason: 'scope-off' })
    })

    it('answerApproval posts the decision and maps already-answered', async () => {
      const fetch = fakeFetch((url, init) => {
        expect(url).toBe('/api/approvals/answer')
        expect(JSON.parse(init?.body as string)).toEqual({ id: 'a1', decision: 'allow' })
        return jsonResponse(200, { ok: true })
      })
      await expect(answerApproval({ fetch, token: 'tok', id: 'a1', decision: 'allow' })).resolves.toEqual({ ok: true })
      const answered = fakeFetch(() => jsonResponse(409, { error: 'already-answered' }))
      await expect(answerApproval({ fetch: answered, token: 'tok', id: 'a1', decision: 'deny' })).resolves.toEqual({
        ok: false,
        reason: 'already-answered'
      })
    })

    it('newChat and stopChat post empty bodies', async () => {
      for (const path of ['/api/chat/new', '/api/chat/stop'] as const) {
        const fetch = fakeFetch((url, init) => {
          expect(url).toBe(path)
          expect(JSON.parse(init?.body as string)).toEqual({})
          return jsonResponse(200, { ok: true })
        })
        const call = path === '/api/chat/new' ? newChat : stopChat
        await expect(call({ fetch, token: 'tok' })).resolves.toEqual({ ok: true })
      }
    })

    it('chatOutcomeKey maps every reason, and approval questions map to PWA keys', () => {
      expect(chatOutcomeKey('refused')).toBe('remote.pwa.revoked')
      expect(chatOutcomeKey('not-delivered')).toBe('remote.pwa.notDelivered')
      expect(chatOutcomeKey('network')).toBe('remote.pwa.pcUnreachable')
      expect(chatOutcomeKey('rate-limited')).toBe('remote.pwa.rateLimited')
      expect(chatOutcomeKey('scope-off')).toBe('remote.pwa.scopeOff')
      expect(chatOutcomeKey('too-long')).toBe('remote.pwa.tooLong')
      expect(chatOutcomeKey('already-answered')).toBe('remote.pwa.alreadyAnswered')
      expect(approvalQuestionKey('chan.allowQuestion')).toBe('remote.pwa.approve.question')
      expect(approvalQuestionKey('chan.flagged')).toBe('remote.pwa.approve.flagged')
    })
  })

  describe('T44 house, step-up and cameras (AC-5.10 to 5.14, 5.20 to 5.23)', () => {
    const things = [
      { id: 'l1', entityId: 'light.techo', name: 'Luz', kind: 'light', areaId: 'cocina', state: 'off', sensitive: false },
      { id: 'k1', entityId: 'lock.puerta', name: 'Puerta', kind: 'lock', areaId: null, state: 'locked', sensitive: true }
    ]
    const areas = [{ id: 'cocina', name: 'Cocina' }]

    it('fetchThings reads things with areas, and maps house-off with its note', async () => {
      const fetch = fakeFetch((url) => {
        expect(url).toBe('/api/home/things')
        return jsonResponse(200, { things, areas })
      })
      await expect(fetchThings({ fetch, token: 'tok' })).resolves.toEqual({ ok: true, things, areas })
      const off = fakeFetch(() => jsonResponse(503, { error: 'house-off', note: 'La casa está apagada.' }))
      await expect(fetchThings({ fetch: off, token: 'tok' })).resolves.toEqual({ ok: false, reason: 'house-off', note: 'La casa está apagada.' })
      const denied = fakeFetch(() => jsonResponse(403, { error: 'scope-off' }))
      await expect(fetchThings({ fetch: denied, token: 'tok' })).resolves.toEqual({ ok: false, reason: 'scope-off' })
    })

    it('groupByRoom groups by area name, unassigned last; thingActions fits the kind', () => {
      expect(groupByRoom(things, areas)).toEqual([
        { area: 'Cocina', things: [things[0]] },
        { area: null, things: [things[1]] }
      ])
      expect(thingActions({ kind: 'light', sensitive: false })).toEqual(['toggle'])
      expect(thingActions({ kind: 'switch', sensitive: false })).toEqual(['toggle'])
      expect(thingActions({ kind: 'fan', sensitive: false })).toEqual(['toggle'])
      expect(thingActions({ kind: 'lock', sensitive: true })).toEqual(['lock', 'unlock'])
      expect(thingActions({ kind: 'cover', sensitive: true })).toEqual(['open', 'close'])
      expect(thingActions({ kind: 'cover', sensitive: false })).toEqual(['open', 'close'])
      expect(thingActions({ kind: 'alarm', sensitive: true })).toEqual(['arm_home', 'arm_away', 'disarm'])
      expect(thingActions({ kind: 'camera', sensitive: false })).toEqual([])
      expect(thingActions({ kind: 'sensor', sensitive: false })).toEqual([])
      expect(thingActions({ kind: 'climate', sensitive: false })).toEqual([])
    })

    it('controlThing posts thing and action, and maps refusals with notes', async () => {
      const fetch = fakeFetch((url, init) => {
        expect(url).toBe('/api/home/control')
        expect(JSON.parse(init?.body as string)).toEqual({ thing: 'light.techo', action: 'toggle' })
        return jsonResponse(200, { ok: true, state: 'on' })
      })
      await expect(controlThing({ fetch, token: 'tok', thing: 'light.techo', action: 'toggle' })).resolves.toEqual({ ok: true })
      const needStepUp = fakeFetch(() => jsonResponse(403, { error: 'step-up-required' }))
      await expect(controlThing({ fetch: needStepUp, token: 'tok', thing: 'lock.puerta', action: 'unlock' })).resolves.toEqual({
        ok: false,
        reason: 'step-up-required'
      })
      const subOff = fakeFetch(() => jsonResponse(403, { error: 'sensitive-off' }))
      await expect(controlThing({ fetch: subOff, token: 'tok', thing: 'lock.puerta', action: 'lock' })).resolves.toEqual({
        ok: false,
        reason: 'sensitive-off'
      })
      const denied = fakeFetch(() => jsonResponse(403, { error: 'denied', note: 'Bloqueado.' }))
      await expect(controlThing({ fetch: denied, token: 'tok', thing: 'light.techo', action: 'toggle' })).resolves.toEqual({
        ok: false,
        reason: 'denied',
        note: 'Bloqueado.'
      })
    })

    it('requestStepUp reads the challenge; an invalid challenge means no passkey', async () => {
      const fetch = fakeFetch((url, init) => {
        expect(url).toBe('/api/stepup/challenge')
        expect(JSON.parse(init?.body as string)).toEqual({ thing: 'lock.puerta', action: 'unlock' })
        return jsonResponse(200, { challenge: 'c1' })
      })
      await expect(requestStepUp({ fetch, token: 'tok', thing: 'lock.puerta', action: 'unlock' })).resolves.toEqual({ ok: true, challenge: 'c1' })
      const none = fakeFetch(() => jsonResponse(400, { error: 'invalid' }))
      await expect(requestStepUp({ fetch: none, token: 'tok', thing: 'lock.puerta', action: 'unlock' })).resolves.toEqual({
        ok: false,
        reason: 'unsupported'
      })
    })

    it('assertStepUp encodes the assertion, and a refusal reads as null', async () => {
      const assertion = { authenticatorData: new Uint8Array([1]), clientDataJSON: new Uint8Array([2]), signature: new Uint8Array([3]) }
      const get = async () => assertion
      await expect(assertStepUp({ get, challenge: new Uint8Array([9]), rpId: 'pc.ts.net' })).resolves.toEqual({
        authenticatorData: b64u.encode(assertion.authenticatorData),
        clientDataJSON: b64u.encode(assertion.clientDataJSON),
        signature: b64u.encode(assertion.signature)
      })
      await expect(assertStepUp({ get: async () => null, challenge: new Uint8Array([9]), rpId: 'pc.ts.net' })).resolves.toBeNull()
      await expect(
        assertStepUp({
          get: async () => {
            throw new DOMException('cancelled')
          },
          challenge: new Uint8Array([9]),
          rpId: 'pc.ts.net'
        })
      ).resolves.toBeNull()
    })

    it('fetchCameras lists the allowed ones; fetchStill reads the photo or photoTooBig', async () => {
      const cameras = [{ id: 'c1', entityId: 'camera.patio', name: 'Patio', state: 'idle' }]
      const fetch = fakeFetch((url) => {
        expect(url).toBe('/api/cameras')
        return jsonResponse(200, { cameras })
      })
      await expect(fetchCameras({ fetch, token: 'tok' })).resolves.toEqual({ ok: true, cameras })
      const still = fakeFetch((url) => {
        expect(url).toBe('/api/cameras/still?id=camera.patio')
        return jsonResponse(200, { photo: 'aGk=', mediaType: 'image/jpeg' })
      })
      await expect(fetchStill({ fetch: still, token: 'tok', entityId: 'camera.patio' })).resolves.toEqual({
        ok: true,
        photo: 'aGk=',
        mediaType: 'image/jpeg'
      })
      const big = fakeFetch(() => jsonResponse(413, { error: 'too-large' }))
      await expect(fetchStill({ fetch: big, token: 'tok', entityId: 'camera.patio' })).resolves.toEqual({ ok: false, reason: 'photo-too-big' })
      const notAllowed = fakeFetch(() => jsonResponse(403, { error: 'camera-not-allowed' }))
      await expect(fetchStill({ fetch: notAllowed, token: 'tok', entityId: 'camera.x' })).resolves.toEqual({ ok: false, reason: 'camera-off' })
    })
  })

  describe('T45 service worker and forget (AC-8.5, 8.6, 6.10)', () => {
    interface FakeCache {
      added: string[]
      puts: string[]
      match(request: { url: string }): Promise<null>
      addAll(urls: string[]): Promise<void>
      put(request: { url: string }): Promise<void>
    }

    function loadWorker(navigatorLanguage = 'en-US', served: { ok: boolean } = { ok: true }): {
      listeners: Record<string, (event: never) => void>
      cachesSeen: { opened: string[]; deleted: string[] }
      precached: string[]
      puts: string[]
      notifications: { title: string; body: string }[]
      opened: string[]
    } {
      const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'public', 'sw.js'), 'utf8')
      const listeners: Record<string, (event: never) => void> = {}
      const cachesSeen = { opened: [] as string[], deleted: [] as string[] }
      const precached: string[] = []
      const puts: string[] = []
      const notifications: { title: string; body: string }[] = []
      const opened: string[] = []
      const cache: FakeCache = {
        added: precached,
        puts,
        match: async () => null,
        addAll: async (urls) => {
          precached.push(...urls)
        },
        put: async (request) => {
          puts.push(request.url)
        }
      }
      const caches = {
        open: async (name: string) => {
          cachesSeen.opened.push(name)
          return cache
        },
        match: async () => null,
        keys: async () => ['alma-shell-v0', 'alma-shell-v1'],
        delete: async (name: string) => {
          cachesSeen.deleted.push(name)
          return true
        }
      }
      const self = {
        addEventListener: (type: string, fn: (event: never) => void) => {
          listeners[type] = fn
        },
        skipWaiting: () => undefined,
        clients: {
          claim: async () => undefined,
          openWindow: async (url: string) => {
            opened.push(url)
          }
        },
        registration: {
          showNotification: async (title: string, options: { body: string }) => {
            notifications.push({ title, body: options.body })
          }
        }
      }
      const navigator = { language: navigatorLanguage }
      new Function('self', 'caches', 'fetch', 'navigator', source)(self, caches, async () => ({ ok: served.ok, clone: () => ({}) }), navigator)
      return { listeners, cachesSeen, precached, puts, notifications, opened }
    }

    it('the service worker precaches the shell, and never touches /api responses', async () => {
      const worker = loadWorker()
      const waited: Promise<unknown>[] = []
      await worker.listeners.install({ waitUntil: (p: Promise<unknown>) => waited.push(p) } as never)
      await Promise.all(waited)
      expect(worker.precached.length).toBeGreaterThan(0)
      expect(worker.precached.every((url) => !url.includes('/api/'))).toBe(true)
      // An API request falls through to the network: no respondWith, nothing cached.
      let answered = false
      await worker.listeners.fetch({ request: { url: 'https://pc.ts.net/api/state?since=1', method: 'GET' }, respondWith: () => { answered = true } } as never)
      expect(answered).toBe(false)
      expect(worker.puts).toEqual([])
      // A shell asset is answered from the worker.
      let shellAnswered = false
      await worker.listeners.fetch({ request: { url: 'https://pc.ts.net/assets/index-abc.js', method: 'GET' }, respondWith: () => { shellAnswered = true }, waitUntil: () => undefined } as never)
      expect(shellAnswered).toBe(true)
    })

    it('a shell asset is cached only when the server answered ok, and the write is awaited by the worker', async () => {
      for (const [ok, cached] of [[true, 1], [false, 0]] as const) {
        const worker = loadWorker('en-US', { ok })
        const waited: Promise<unknown>[] = []
        let answer: Promise<unknown> = Promise.resolve()
        await worker.listeners.fetch({
          request: { url: 'https://pc.ts.net/assets/index-abc.js', method: 'GET' },
          respondWith: (p: Promise<unknown>) => { answer = p },
          waitUntil: (p: Promise<unknown>) => waited.push(p)
        } as never)
        await answer
        await Promise.all(waited)
        expect(worker.puts, ok ? 'ok response' : 'error response').toHaveLength(cached)
        expect(waited.length > 0, 'put is kept alive').toBe(ok)
      }
    })

    it('AC-4.1 (028) /api/ stays network-only and no new path is cached', async () => {
      const worker = loadWorker()
      const waited: Promise<unknown>[] = []
      await worker.listeners.install({ waitUntil: (p: Promise<unknown>) => waited.push(p) } as never)
      await Promise.all(waited)
      const paths = ['/api/notes/list', '/api/notes/find', '/api/notes/read', '/api/notes/image', '/api/threads/list', '/api/threads/read', '/api/threads/send', '/api/threads/stop', '/api/status']
      for (const path of paths) {
        for (const method of ['GET', 'POST']) {
          let answered = false
          await worker.listeners.fetch({ request: { url: `https://pc.ts.net${path}`, method }, respondWith: () => { answered = true } } as never)
          expect(answered, `${method} ${path}`).toBe(false)
        }
      }
      expect(worker.puts).toEqual([])
      expect(worker.precached.some((url) => url.includes('api'))).toBe(false)
      // The rule is one prefix check, not a list a new route could be missing from.
      const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'public', 'sw.js'), 'utf8')
      expect(source).toContain("url.pathname.startsWith('/api/')")
      const code = source.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('//')).join('\n')
      expect(code).not.toMatch(/notes|threads|conversation/i)
    })

    it('T46: a push shows the fixed text in the phone language, and tapping opens the app', async () => {
      for (const [language, expected] of [
        ['es-AR', es['remote.pwa.push.text']],
        ['en-US', en['remote.pwa.push.text']]
      ] as const) {
        const worker = loadWorker(language)
        const waited: Promise<unknown>[] = []
        await worker.listeners.push({ waitUntil: (p: Promise<unknown>) => waited.push(p) } as never)
        await Promise.all(waited)
        expect(worker.notifications).toEqual([{ title: 'Alma', body: expected }])
      }
      const worker = loadWorker()
      const waited: Promise<unknown>[] = []
      let closed = false
      await worker.listeners.notificationclick({ notification: { close: () => { closed = true } }, waitUntil: (p: Promise<unknown>) => waited.push(p) } as never)
      await Promise.all(waited)
      expect(closed).toBe(true)
      expect(worker.opened).toEqual(['./'])
    })

    it('forget tells the PC and wipes even when the PC is unreachable', async () => {
      const storage = memoryStorage()
      const device = await generateDeviceKey()
      await storage.saveDevice({ deviceId: 'd1', privateKey: device.privateKey, publicJwk: device.publicJwk })
      await storage.saveSession({ token: 'tok', expiresAt: 1 })
      const deleted: string[] = []
      const caches = { keys: async () => ['alma-shell-v1'], delete: async (name: string) => { deleted.push(name); return true } }
      const told: string[] = []
      const fetch = fakeFetch((url) => {
        told.push(url)
        return jsonResponse(200, { ok: true })
      })
      await forgetPc({ fetch, token: 'tok', storage, caches })
      expect(told).toEqual(['/api/forget'])
      await expect(storage.loadDevice()).resolves.toBeNull()
      await expect(storage.loadSession()).resolves.toBeNull()
      expect(deleted).toEqual(['alma-shell-v1'])
      // Unreachable: the tell fails, the wipe still happens.
      await storage.saveDevice({ deviceId: 'd1', privateKey: device.privateKey, publicJwk: device.publicJwk })
      const down: FetchLike = async () => {
        throw new TypeError('fetch failed')
      }
      await forgetPc({ fetch: down, token: 'tok', storage, caches })
      await expect(storage.loadDevice()).resolves.toBeNull()
    })
  })

  describe('memory storage', () => {
    let storage: ReturnType<typeof memoryStorage>

    beforeEach(() => {
      storage = memoryStorage()
    })

    it('round-trips the device and the session, and clears both', async () => {
      await expect(storage.loadDevice()).resolves.toBeNull()
      const device = await generateDeviceKey()
      await storage.saveDevice({ deviceId: 'd1', privateKey: device.privateKey, publicJwk: device.publicJwk })
      await storage.saveSession({ token: 'tok', expiresAt: 5 })
      await expect(storage.loadDevice()).resolves.toMatchObject({ deviceId: 'd1', publicJwk: device.publicJwk })
      await expect(storage.loadSession()).resolves.toEqual({ token: 'tok', expiresAt: 5 })
      await storage.clear()
      await expect(storage.loadDevice()).resolves.toBeNull()
      await expect(storage.loadSession()).resolves.toBeNull()
    })
  })
})

describe('PWA shell cache name (028 BR-26, T67)', () => {
  it('AC-4.1 (028) the shell cache is v9, so installed phones drop the code that had no Notes or conversations', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'public', 'sw.js'), 'utf8')
    expect(source).toMatch(/const SHELL = 'alma-shell-v9'/)
  })
})
