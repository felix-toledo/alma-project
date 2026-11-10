// Independent verification of spec 027 from the outside (tester): the relay is blind, tamper and replay never run an
// effect twice, and a revoked device is refused exactly like an unknown one. Built only on the real RelayTransport and the
// test supports; nothing here reads how the code was planned.
//
// Mutation checks: VERIFY_027_MUTATE=replay swaps the replay window for one that accepts everything; VERIFY_027_MUTATE=leak seals
// answers as plain base64url. The replay and the blindness tests must fail respectively.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayTransport } from '../src/coordinator/channels/remote/relay-transport'
import type { WebSocketCtor } from '../src/coordinator/channels/remote/relay-connection'
import type { RemoteHandler, RemoteRequest } from '../src/shared/remote/api'
import type { PublicJwk } from '../src/shared/remote/crypto'
import { createPhoneHandshake, openAnswer, sealRequest } from '../src/shared/remote/relay-e2e'
import { relayFrameSchema } from '../src/shared/remote/relay-frame'
import { FakeRelay, type KeyPair, keyPair, mentions, random } from './support/relay-fake'
import { FakePhone } from './support/relay-phone'

vi.mock('../src/shared/remote/relay-e2e', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shared/remote/relay-e2e')>()
  const mutate = process.env['VERIFY_027_MUTATE']
  if (mutate === 'replay') return { ...real, createReplayWindow: () => ({ accept: () => true }) }
  if (mutate === 'leak') {
    const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
    return {
      ...real,
      sealAnswer: async (keys: { v: number; sid: string }, ctr: number, plain: Uint8Array) => ({ v: keys.v, t: 'a' as const, sid: keys.sid, ctr, ct: b64(plain) }),
      openAnswer: async (_keys: unknown, _ctr: number, frame: { ct: string }) => new Uint8Array(Buffer.from(frame.ct, 'base64url'))
    }
  }
  return real
})

const realImmediate = globalThis.setImmediate
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

async function rig(handler?: RemoteHandler) {
  const relay = new FakeRelay({ routingId: 'verify-route-id', domain: 'invalid' })
  const identity = await keyPair()
  const devices = new Map<string, PublicJwk>()
  const seen: RemoteRequest[] = []
  const effects: number[] = []
  let handshakeFailures = 0
  const base: RemoteHandler = async (request, signal) => {
    seen.push(request)
    const body = request.body as { n?: number } | undefined
    if (request.path === '/api/effect' && typeof body?.n === 'number') effects.push(body.n)
    return handler ? handler(request, signal) : { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: { ok: true, n: body?.n } }
  }
  const transport = new RelayTransport({
    routingId: relay.routingId,
    relayDomain: 'invalid',
    identity,
    deviceKey: (id) => devices.get(id) ?? null,
    webSocket: relay.webSocket as unknown as WebSocketCtor,
    random,
    now: () => Date.now(),
    schedule: (fn, ms) => relay.timers.schedule(fn, ms),
    jitter: () => 0.5,
    onState: () => {},
    onHandshakeFailed: () => void handshakeFailures++
  })
  await transport.start(base)
  for (let i = 0; !relay.room.online; i++) {
    if (i > 5000) throw new Error('relay never came online')
    await new Promise((resolve) => realImmediate(resolve))
  }
  const addDevice = async (id: string): Promise<KeyPair> => {
    const key = await keyPair()
    devices.set(id, key.publicKey)
    return key
  }
  const phone = async (id: string, key: KeyPair): Promise<FakePhone> => {
    const p = new FakePhone(relay, { device: { id, sign: key.sign }, expect: { pcKey: identity.publicKey } })
    const connected = await p.connect()
    if (!connected.ok) throw new Error(`handshake failed: ${connected.reason}`)
    return p
  }
  return { relay, identity, devices, seen, effects, transport, addDevice, phone, handshakeFailures: () => handshakeFailures }
}

const effect = (n: number, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ k: 'req', method: 'POST', path: '/api/effect', headers: { authorization: 'Bearer t' }, body: { n, ...extra } })

/** Sends one hand-made sealed request and opens its answer. */
async function raw(relay: FakeRelay, phone: FakePhone, ctr: number, plain: string): Promise<{ status: number; ok: boolean }> {
  if (!phone.keys) throw new Error('no session')
  const frame = await sealRequest(phone.keys, ctr, new TextEncoder().encode(plain))
  const sent = await relay.phoneFetch(JSON.stringify(frame))
  if (sent.status !== 200) return { status: sent.status, ok: false }
  const opened = await openAnswer(phone.keys, ctr, relayFrameSchema.parse(JSON.parse(sent.body)))
  return { status: 200, ok: opened !== null }
}

const heldValues = (root: unknown): string[] => {
  const found: string[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown): void => {
    if (typeof value === 'string') return void found.push(value)
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    if (value instanceof Map) for (const [key, entry] of value) {
      walk(key)
      walk(entry)
    }
    else if (value instanceof Set || Array.isArray(value)) for (const entry of value) walk(entry)
    else if (value instanceof Uint8Array) found.push(Array.from(value).join(','))
    else for (const [key, entry] of Object.entries(value)) if (key !== 'deps') walk(entry)
  }
  walk(root)
  return found
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('verify 027 (1) the relay never sees plaintext or secrets, on error paths too', () => {
  it('AC-3.1 BR-14 the detector sees a marker in clear, base64, base64url and hex (negative control)', () => {
    const marker = 'MARKER-CONTROL-0042'
    const b64 = btoa(`x${marker}`)
    const hex = [...new TextEncoder().encode(marker)].map((b) => b.toString(16).padStart(2, '0')).join('')
    for (const carrier of [`..${marker}..`, `..${b64}..`, `..${b64.replaceAll('+', '-')}..`, `..${hex}..`]) expect(mentions(carrier, [marker])).toEqual([marker])
    expect(mentions('nothing to see here at all', [marker])).toEqual([])
  })

  it('AC-3.1 success, handler crash, junk plaintext, oversize body, tampering, unknown device and offline PC: no marker in any relay-visible byte, no log line', async () => {
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    const M = {
      device: 'DEVICE-ID-MARKER-5521',
      bearer: 'BEARER-MARKER-cc33ff',
      path: '/api/MARKER-PATH-aa11bb',
      query: 'q=MARKER-QUERY-bb22cc',
      text: 'MARKER-TEXT-dd44ee',
      crash: 'MARKER-CRASH-ee55ff',
      junk: 'MARKER-JUNK-ff66aa',
      big: 'MARKER-BIG-0a1b2c',
      answer: 'MARKER-ANSWER-1d2e3f',
      ghost: 'GHOST-DEVICE-MARKER-7788'
    }
    const r = await rig(async (request) => {
      if (request.path.includes('crash')) throw new Error(M.crash)
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { answer: M.answer, echo: request.body } }
    })
    const key = await r.addDevice(M.device)
    const phone = await r.phone(M.device, key)
    const call = (path: string, body: unknown, query?: string) => phone.request(JSON.stringify({ k: 'req', method: 'POST', path, query, headers: { authorization: `Bearer ${M.bearer}` }, body }))

    // Success: the data really crossed (so the test is not vacuous).
    const good = await call(M.path, { text: M.text }, M.query)
    expect(good.ok && good.plaintext.includes(M.answer)).toBe(true)
    expect(r.seen.at(-1)?.headers['authorization']).toBe(`Bearer ${M.bearer}`)
    // The handler throws: the phone hears a sealed generic failure, never the message.
    const crashed = await call('/api/crash', { text: M.crash })
    expect(crashed.ok && crashed.plaintext.includes(M.crash)).toBe(false)
    // Junk that is not a request, and a body past the request cap.
    expect((await phone.request(M.junk)).ok).toBe(true)
    await call('/api/big', { text: `${M.big}${'x'.repeat(1_100_000)}` })
    // Tampering: the session ends; the next request starts a new one by itself in the real client, here by hand.
    r.relay.tamper.relayToPc = (text) => {
      const message = JSON.parse(text)
      if (message.k === 'f' && message.frame.t === 'q') message.frame.ct = `${message.frame.ct.startsWith('A') ? 'B' : 'A'}${message.frame.ct.slice(1)}`
      return JSON.stringify(message)
    }
    expect((await call(M.path, { text: M.text })).ok).toBe(false)
    delete r.relay.tamper.relayToPc
    const again = await r.phone(M.device, key)
    expect((await again.request(effect(1, { text: M.text }))).ok).toBe(true)
    // A device the PC does not know tries to handshake.
    const ghost = new FakePhone(r.relay, { device: { id: M.ghost, sign: key.sign }, expect: { pcKey: r.identity.publicKey } })
    expect((await ghost.connect()).ok).toBe(false)
    // The PC goes away: calls end at once.
    await r.transport.stop()
    await settle()
    const offline = new FakePhone(r.relay, { device: null, expect: { pcKey: r.identity.publicKey } })
    expect(await offline.connect()).toEqual({ ok: false, reason: 'relay 503' })

    const markers = Object.values(M)
    const wire = r.relay.tap.records.map((record) => record.text).join('\n')
    expect(mentions(wire, [...markers, 'authorization', 'Authorization', 'Bearer', '/api/effect', 'k":"req"'])).toEqual([])
    // Refusals the relay itself writes are a closed set with a single member each.
    for (const text of r.relay.tap.of('relayToPhone')) {
      const body = JSON.parse(text) as Record<string, unknown>
      if ('error' in body) {
        expect(Object.keys(body)).toEqual(['error'])
        expect(['offline', 'full', 'timeout', 'version', 'gone', 'malformed', 'not-found']).toContain(body['error'])
      }
    }
    // The relay's own state after all that holds none of it.
    expect(mentions(heldValues(r.relay.room).join('\n'), markers)).toEqual([])
    // Nothing on the console either.
    expect(mentions(logged.join('\n'), markers)).toEqual([])
  })

  it('AC-3.1 the pairing path (an anonymous session) carries a secret and a code the relay never sees', async () => {
    const r = await rig()
    const SECRET = 'PAIRING-SECRET-MARKER-9f8e7d'
    const CODE = 'PAIR-CODE-MARKER-123456'
    const anon = new FakePhone(r.relay, { device: null, expect: { pcKey: r.identity.publicKey } })
    expect(await anon.connect()).toEqual({ ok: true })
    expect((await anon.request(JSON.stringify({ k: 'req', method: 'POST', path: '/api/pair/request', body: { secret: SECRET, phonePublicKey: { kty: 'EC', x: 'KEY-X-MARKER-aaaaaa', y: 'KEY-Y-MARKER-bbbbbb' } } }))).ok).toBe(true)
    expect((await anon.request(JSON.stringify({ k: 'req', method: 'POST', path: '/api/step-up/verify', body: { assertion: CODE } }))).ok).toBe(true)
    const wire = r.relay.tap.records.map((record) => record.text).join('\n')
    expect(mentions(wire, [SECRET, CODE, 'KEY-X-MARKER-aaaaaa', 'KEY-Y-MARKER-bbbbbb', '/api/pair/request'])).toEqual([])
  })
})

describe('verify 027 (2) tamper, replay and reorder never run an effect twice', () => {
  it('AC-3.3 every frame the relay ever recorded, sent again at any later time and in any order, runs no effect twice', async () => {
    const r = await rig()
    const key = await r.addDevice('dev-a')
    const a = await r.phone('dev-a', key)
    for (const n of [1, 2, 3]) expect((await a.request(effect(n))).ok).toBe(true)
    expect(r.effects).toEqual([1, 2, 3])

    // 1. Toward the PC, while the session is live: recorded order, then reversed.
    const toPc = r.relay.tap.of('relayToPc').slice()
    for (const text of toPc) r.relay.injectToPc(text)
    for (const text of toPc.slice().reverse()) r.relay.injectToPc(text)
    await settle()
    expect(r.effects).toEqual([1, 2, 3])

    // 2. From the phone side, everything the phone ever sent.
    for (const text of r.relay.tap.of('phoneToRelay').slice()) await r.relay.phoneFetch(text)
    await settle()
    expect(r.effects).toEqual([1, 2, 3])

    // 3. A new session, a new effect, then the old frames again, and the new ones too.
    const b = await r.phone('dev-a', key)
    expect((await b.request(effect(4))).ok).toBe(true)
    for (const text of r.relay.tap.of('relayToPc').slice()) r.relay.injectToPc(text)
    for (const text of r.relay.tap.of('phoneToRelay').slice()) await r.relay.phoneFetch(text)
    await settle()
    expect(r.effects).toEqual([1, 2, 3, 4])
  })

  it('AC-3.3 the same frame delivered twice at the same moment runs once', async () => {
    const r = await rig()
    const key = await r.addDevice('dev-a')
    const p = await r.phone('dev-a', key)
    if (!p.keys) throw new Error('no session')
    const frame = JSON.stringify(await sealRequest(p.keys, 0, new TextEncoder().encode(effect(5))))
    const results = await Promise.all([r.relay.phoneFetch(frame), r.relay.phoneFetch(frame)])
    await settle()
    expect(r.effects).toEqual([5])
    // At most one answer got through; the duplicate ended the session.
    expect(results.filter((result) => result.status === 200).length).toBeLessThanOrEqual(1)
  })

  it('AC-3.3 a reordered pair inside the window runs once each; a counter that has left the window, or a repeat, is refused', async () => {
    const r = await rig()
    const key = await r.addDevice('dev-a')
    const inside = await r.phone('dev-a', key)
    expect(await raw(r.relay, inside, 5, effect(10))).toEqual({ status: 200, ok: true })
    expect(await raw(r.relay, inside, 3, effect(11))).toEqual({ status: 200, ok: true })
    expect((await raw(r.relay, inside, 3, effect(12))).ok).toBe(false)
    expect(r.effects).toEqual([10, 11])
    // After a repeat the session is over: even a fresh counter finds nothing.
    expect((await raw(r.relay, inside, 9, effect(13))).ok).toBe(false)
    expect(r.effects).toEqual([10, 11])

    const outside = await r.phone('dev-a', key)
    expect(await raw(r.relay, outside, 200, effect(20))).toEqual({ status: 200, ok: true })
    expect((await raw(r.relay, outside, 5, effect(21))).ok).toBe(false)
    expect(r.effects).toEqual([10, 11, 20])
  })

  it('AC-3.2 AC-2.6 any alteration of a sealed request never reaches the handler and ends that session only', async () => {
    const r = await rig()
    const keyA = await r.addDevice('dev-a')
    const keyB = await r.addDevice('dev-b')
    const a = await r.phone('dev-a', keyA)
    const b = await r.phone('dev-b', keyB)
    if (!a.keys || !b.keys) throw new Error('no session')
    const frame = await sealRequest(a.keys, 0, new TextEncoder().encode(effect(30)))
    const flipped = (text: string): string => `${text.startsWith('A') ? 'B' : 'A'}${text.slice(1)}`
    const variants: Array<[string, unknown]> = [
      ['flipped ct', { ...frame, ct: flipped(frame.ct) }],
      ['truncated ct', { ...frame, ct: frame.ct.slice(0, -4) }],
      ['other counter', { ...frame, ctr: 1 }],
      ['other session id (B)', { ...frame, sid: b.keys.sid }],
      ['answer kind', { ...frame, t: 'a' }],
      ['unknown member', { ...frame, extra: 1 }],
      ['other version', { ...frame, v: 9 }]
    ]
    for (const [name, variant] of variants) {
      const sent = await r.relay.phoneFetch(JSON.stringify(variant))
      expect(sent.status, name).not.toBe(200)
    }
    await settle()
    expect(r.effects).toEqual([])
    // B was named by one of the variants and ended; A's own frame is still unspent only if A was never named correctly.
    const genuine = await r.relay.phoneFetch(JSON.stringify(frame))
    await settle()
    expect(r.effects.length).toBeLessThanOrEqual(1)
    expect(genuine.status === 200 ? r.effects : []).toEqual(genuine.status === 200 ? [30] : [])
  })

  it('AC-3.2 an answer from an earlier session, or for another counter, is not accepted by the phone', async () => {
    const r = await rig()
    const key = await r.addDevice('dev-a')
    const first = await r.phone('dev-a', key)
    expect((await first.request(effect(1))).ok).toBe(true)
    const oldAnswer = r.relay.tap.of('relayToPhone').at(-1) ?? ''
    const second = await r.phone('dev-a', key)
    // The relay answers the next request with the old answer instead.
    r.relay.tamper.relayToPhone = () => oldAnswer
    const reply = await second.request(effect(2))
    expect(reply.ok).toBe(false)
    expect(second.keys).toBeNull()
  })
})

describe('verify 027 (3) a revoked or unknown device gets the same refusal', () => {
  const handshakeTo = async (relay: FakeRelay, pcKey: PublicJwk, device: { id: string; sign: KeyPair['sign'] } | null, corrupt = false) => {
    const handshake = createPhoneHandshake({ device, random })
    const first = await relay.phoneFetch(JSON.stringify(await handshake.hs1()))
    const hs3 = await handshake.onHs2(JSON.parse(first.body), { pcKey })
    if ('fail' in hs3) throw new Error(hs3.fail)
    const body = corrupt && 'ct' in hs3 ? { ...hs3, ct: `${hs3.ct.startsWith('A') ? 'B' : 'A'}${hs3.ct.slice(1)}` } : hs3
    return relay.phoneFetch(JSON.stringify(body))
  }

  it('AC-8.1 AC-3.4 unknown, revoked, wrongly signing and corrupted handshakes get byte-identical answers, each audited once, and a known device gets in', async () => {
    const r = await rig()
    const good = await r.addDevice('dev-good')
    const revoked = await r.addDevice('dev-revoked')
    r.devices.delete('dev-revoked')
    const stranger = await keyPair()
    const pc = r.identity.publicKey
    const failuresBefore = r.handshakeFailures()
    const answers = {
      unknown: await handshakeTo(r.relay, pc, { id: 'dev-never-seen', sign: stranger.sign }),
      revoked: await handshakeTo(r.relay, pc, { id: 'dev-revoked', sign: revoked.sign }),
      wrongSignature: await handshakeTo(r.relay, pc, { id: 'dev-good', sign: stranger.sign }),
      corrupted: await handshakeTo(r.relay, pc, { id: 'dev-good', sign: good.sign }, true)
    }
    expect(answers.unknown).toEqual(answers.revoked)
    expect(answers.unknown).toEqual(answers.wrongSignature)
    expect(answers.unknown).toEqual(answers.corrupted)
    expect(answers.unknown.status).not.toBe(200)
    expect(JSON.parse(answers.unknown.body)).toEqual({ error: 'gone' })
    expect(r.handshakeFailures() - failuresBefore).toBe(4)
    const ok = await handshakeTo(r.relay, pc, { id: 'dev-good', sign: good.sign })
    expect(ok.status).toBe(200)
  })

  it('AC-8.1 closeDevice cuts that device at once, the next frame is refused like an unknown session, and the other device is untouched', async () => {
    const r = await rig()
    const keyA = await r.addDevice('dev-a')
    const keyB = await r.addDevice('dev-b')
    const a = await r.phone('dev-a', keyA)
    const b = await r.phone('dev-b', keyB)
    expect((await a.request(effect(1))).ok).toBe(true)
    r.devices.delete('dev-a')
    r.transport.closeDevice('dev-a')
    const after = await a.request(effect(2))
    expect(after).toMatchObject({ ok: false, status: 410, error: 'gone' })
    // An unknown session id gets the identical answer.
    const unknownSession = await r.relay.phoneFetch(JSON.stringify({ v: 1, t: 'q', sid: 'AAAAAAAAAAAAAAAAAAAAAA', ctr: 0, ct: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
    expect(unknownSession.body).toBe(JSON.stringify({ error: 'gone' }))
    expect((await b.request(effect(3))).ok).toBe(true)
    // The revoked device cannot come back with its old key.
    const again = new FakePhone(r.relay, { device: { id: 'dev-a', sign: keyA.sign }, expect: { pcKey: r.identity.publicKey } })
    expect((await again.connect()).ok).toBe(false)
    expect(r.effects).toEqual([1, 3])
  })

  it('AC-8.1 closeAll (the kill switch) ends every session', async () => {
    const r = await rig()
    const phones = await Promise.all(['a', 'b', 'c'].map(async (id) => r.phone(`dev-${id}`, await r.addDevice(`dev-${id}`))))
    await r.transport.stop()
    await settle()
    for (const phone of phones) expect((await phone.request(effect(9))).ok).toBe(false)
    expect(r.effects).toEqual([])
  })
})

describe('verify 027 (3b) revoking a device cuts the session that carries its token, even mid-request', () => {
  it('AC-8.1 a held request on an anonymous end-to-end session is aborted and the session ended when the device its bearer belongs to is revoked', async () => {
    const { hostRig } = await import('./support/relay-host-rig')
    const state: { aborted: boolean; rig: Awaited<ReturnType<typeof hostRig>> | null } = { aborted: false, rig: null }
    state.rig = await hostRig({
      handler: (request, signal) =>
        new Promise((resolve) => {
          if (request.path !== '/api/hold') return resolve({ status: 200, body: { ok: true } })
          // What the channel does while it authenticates a bearer.
          state.rig?.host.track('tok-held', 'dev-9')
          signal.addEventListener('abort', () => {
            state.aborted = true
            resolve({ status: 200, body: { late: true } })
          })
          setTimeout(() => resolve({ status: 200, body: { late: true } }), 400)
        })
    })
    const phone = state.rig.phone({ device: null })
    expect(await phone.connect()).toEqual({ ok: true })
    const held = phone.call({ method: 'GET', path: '/api/hold', headers: { authorization: 'Bearer tok-held' } }).then(
      () => 'answered',
      () => 'cut'
    )
    await settle()
    state.rig.host.closeDevice('dev-9')
    expect(await held).toBe('cut')
    expect(state.aborted).toBe(true)
    await expect(phone.call({ method: 'GET', path: '/api/x' })).rejects.toThrow('gone')
  })
})
