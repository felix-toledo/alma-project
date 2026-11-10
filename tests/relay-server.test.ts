import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { answerFor } from '../src/relay/answer'
import { createCounters, logCounters } from '../src/relay/counters'
import { createAddressLimits } from '../src/relay/limits-state'
import { RelayRoom, type RoomDeps } from '../src/relay/room'
import { b64u, fingerprint } from '../src/shared/remote/crypto'
import type { SealedFrame } from '../src/shared/remote/relay-e2e'
import { RELAY_PROTOCOL, type RelayFrame, type RelayToPc, registrationMessage } from '../src/shared/remote/relay-frame'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { FakePc, FakeRelay, type KeyPair, keyPair, manualTimers, random, startEchoPc } from './support/relay-fake'
import { FakePhone } from './support/relay-phone'

const root = join(__dirname, '..')
const ID = 'room-id-one'
const PC_ADDRESS = '198.51.100.2'
const newRoom = (routingId = ID, extra: Partial<RoomDeps> = {}): RelayRoom => new RelayRoom({ routingId, random, ...extra })

/** The PC side of registration: connect, read the challenge, answer it. */
async function connect(room: RelayRoom, pair: KeyPair, routingId = ID): Promise<FakePc> {
  const socket = new FakePc()
  await room.acceptPc(socket, PC_ADDRESS)
  const challenge = socket.messages()[0]
  if (challenge?.k !== 'challenge') throw new Error('no challenge')
  const sig = b64u.encode(await pair.sign(registrationMessage(routingId, b64u.decode(challenge.nonce))))
  await room.onPcMessage(socket, JSON.stringify({ k: 'reg', pub: pair.publicKey, sig }))
  return socket
}

const ready = (socket: FakePc): boolean => socket.messages().some((message) => message.k === 'ready')
const request: RelayFrame = { v: RELAY_PROTOCOL.current, t: 'q', sid: b64u.encode(new Uint8Array(16)), ctr: 0, ct: b64u.encode(new Uint8Array(40)) }
const from = { address: '203.0.113.7', bytes: 200 }
const answer = (ctr = 0): SealedFrame => ({ v: RELAY_PROTOCOL.current, t: 'a', sid: b64u.encode(new Uint8Array(16)), ctr, ct: b64u.encode(new Uint8Array(40).fill(9)) })
type Asked = Extract<RelayToPc, { k: 'f' | 'abort' }>
const asked = (socket: FakePc): Asked[] => socket.messages().filter((m): m is Asked => m.k === 'f' || m.k === 'abort')
const reply = (room: RelayRoom, socket: FakePc, rid: string, frame: RelayFrame): Promise<void> => room.onPcMessage(socket, JSON.stringify({ k: 'r', rid, frame }))

describe('relay registration (spec 027 T9)', () => {
  it('AC-5.2 a PC that signs the challenge with its key is registered and told ready', async () => {
    const room = newRoom()
    const pc = await keyPair()
    const socket = new FakePc()
    await room.acceptPc(socket, PC_ADDRESS)
    const first = socket.messages()
    expect(first).toHaveLength(1)
    expect(first[0]?.k).toBe('challenge')
    expect(room.online).toBe(false)
    const registered = await connect(room, pc)
    expect(ready(registered)).toBe(true)
    expect(registered.closed).toBeNull()
    expect(room.online).toBe(true)
  })

  it('AC-5.2 every challenge is fresh and a signature for one challenge, id or key does not register another', async () => {
    const room = newRoom()
    const pc = await keyPair()
    const stranger = await keyPair()
    const a = new FakePc()
    const b = new FakePc()
    await room.acceptPc(a, PC_ADDRESS)
    await room.acceptPc(b, PC_ADDRESS)
    const nonceA = (a.messages()[0] as { nonce: string }).nonce
    const nonceB = (b.messages()[0] as { nonce: string }).nonce
    expect(nonceA).not.toBe(nonceB)
    expect(b64u.decode(nonceA)).toHaveLength(32)
    // A signature over the other socket's challenge.
    const replayed = b64u.encode(await pc.sign(registrationMessage(ID, b64u.decode(nonceB))))
    await room.onPcMessage(a, JSON.stringify({ k: 'reg', pub: pc.publicKey, sig: replayed }))
    expect(a.closed).toBe(4001)
    // A signature for another routing id.
    const otherId = b64u.encode(await pc.sign(registrationMessage('some-other-id', b64u.decode(nonceB))))
    await room.onPcMessage(b, JSON.stringify({ k: 'reg', pub: pc.publicKey, sig: otherId }))
    expect(b.closed).toBe(4001)
    // A valid signature by a key that is not the one announced.
    const c = new FakePc()
    await room.acceptPc(c, PC_ADDRESS)
    const sigByStranger = b64u.encode(await stranger.sign(registrationMessage(ID, b64u.decode((c.messages()[0] as { nonce: string }).nonce))))
    await room.onPcMessage(c, JSON.stringify({ k: 'reg', pub: pc.publicKey, sig: sigByStranger }))
    expect(c.closed).toBe(4001)
    expect(room.online).toBe(false)
    expect([a, b, c].some(ready)).toBe(false)
  })

  it('AC-5.2 a malformed first message, a message that is not a registration closes the socket as refused', async () => {
    const room = newRoom()
    const pc = await keyPair()
    for (const raw of ['not json', '{}', JSON.stringify({ k: 'ready' }), JSON.stringify({ k: 'r', rid: 'x', frame: request }), JSON.stringify({ k: 'reg', pub: { kty: 'EC' }, sig: 'x' }), JSON.stringify({ k: 'reg', pub: pc.publicKey, sig: 'not base64url!' })]) {
      const socket = new FakePc()
      await room.acceptPc(socket, PC_ADDRESS)
      await room.onPcMessage(socket, raw)
      expect(socket.closed, raw).toBe(4001)
    }
    expect(room.online).toBe(false)
    // The challenge is single use: a second registration message on the same socket gets nothing.
    const used = await connect(room, pc)
    expect(room.online).toBe(true)
    await room.onPcMessage(used, JSON.stringify({ k: 'reg', pub: pc.publicKey, sig: 'x' }))
    expect(used.closed).toBeNull()
  })

  it('AC-5.2 a second registration with another key is refused and the first connection is untouched', async () => {
    const room = newRoom()
    const first = await keyPair()
    const second = await keyPair()
    const live = await connect(room, first)
    const refused = await connect(room, second)
    expect(refused.closed).toBe(4003)
    expect(ready(refused)).toBe(false)
    expect(live.closed).toBeNull()
    expect(room.online).toBe(true)
    // Closing the refused socket does not take the real PC offline.
    room.onPcClose(refused)
    expect(room.online).toBe(true)
  })

  it('AC-5.2 the same key replaces its own stale connection: the old one is closed as replaced and the new one is ready', async () => {
    const room = newRoom()
    const pc = await keyPair()
    const stale = await connect(room, pc)
    const fresh = await connect(room, pc)
    expect(stale.closed).toBe(4002)
    expect(fresh.closed).toBeNull()
    expect(ready(fresh)).toBe(true)
    // The old socket closing late, or still talking, changes nothing.
    room.onPcClose(stale)
    await room.onPcMessage(stale, JSON.stringify({ k: 'r', rid: 'x', frame: request }))
    expect(room.online).toBe(true)
    room.onPcClose(fresh)
    expect(room.online).toBe(false)
  })

  it('AC-5.2 with no live connection the next valid registration wins, even by another key', async () => {
    const room = newRoom()
    const first = await keyPair()
    const second = await keyPair()
    const live = await connect(room, first)
    room.onPcClose(live)
    expect(room.online).toBe(false)
    const next = await connect(room, second)
    expect(ready(next)).toBe(true)
    expect(room.online).toBe(true)
    // ...and now the first key is the one refused.
    expect((await connect(room, first)).closed).toBe(4003)
  })

  it('AC-5.2 two registrations racing for a free room: exactly one wins', async () => {
    const room = newRoom()
    const [a, b] = [await keyPair(), await keyPair()]
    const sockets = [new FakePc(), new FakePc()]
    for (const socket of sockets) await room.acceptPc(socket, PC_ADDRESS)
    const sign = async (socket: FakePc, pair: KeyPair): Promise<string> =>
      JSON.stringify({ k: 'reg', pub: pair.publicKey, sig: b64u.encode(await pair.sign(registrationMessage(ID, b64u.decode((socket.messages()[0] as { nonce: string }).nonce)))) })
    const messages = [await sign(sockets[0], a), await sign(sockets[1], b)]
    await Promise.all(sockets.map((socket, i) => room.onPcMessage(socket, messages[i])))
    expect(sockets.filter(ready)).toHaveLength(1)
    expect(sockets.filter((socket) => socket.closed === 4003)).toHaveLength(1)
  })

  it('AC-5.4 an unknown id and an offline PC answer the same, and registration state is not revealed', async () => {
    const unknown = newRoom('never-registered')
    const offline = newRoom('was-registered')
    const pc = await keyPair()
    offline.onPcClose(await connect(offline, pc, 'was-registered'))
    const answers = [await unknown.forward(request, from), await offline.forward(request, from)]
    expect(answers).toEqual(['offline', 'offline'])
    expect(await unknown.forward('garbage', from)).toBe(await offline.forward('garbage', from))
  })

  it('AC-5.1 the relay routes by the routing id alone: nothing it is given names an account, a login or a person', () => {
    for (const file of ['room.ts', 'registration.ts']) {
      const source = readFileSync(join(root, 'src', 'relay', file), 'utf8')
      expect(source, file).not.toMatch(/\b(cookie|authorization|account|e-?mail|password|login|token)\b/i)
    }
    expect(readdirSync(join(root, 'src', 'relay')).length).toBeGreaterThan(0)
  })
})

describe('relay forwarding (spec 027 T10)', () => {
  const online = async (extra: Partial<RoomDeps> = {}) => {
    const room = newRoom(ID, extra)
    const socket = await connect(room, await keyPair())
    return { room, socket }
  }

  it('AC-5.5 one frame in, one frame out: the PC gets the phone frame untouched and its answer is the phone response', async () => {
    const { room, socket } = await online()
    const pending = room.forward(request, from)
    const [sent] = asked(socket)
    expect(sent?.k).toBe('f')
    if (sent?.k !== 'f') throw new Error('not forwarded')
    expect(sent.frame).toEqual(request)
    await reply(room, socket, sent.rid, answer())
    expect(await pending).toEqual(answer())
    // The same answer sent again finds nothing waiting.
    await reply(room, socket, sent.rid, answer(1))
    expect(asked(socket)).toHaveLength(1)
  })

  it('AC-5.5 a call for an offline PC ends at once and nothing is held or scheduled', async () => {
    const timers = manualTimers()
    const room = newRoom(ID, { schedule: timers.schedule })
    expect(await room.forward(request, from)).toBe('offline')
    expect(timers.timers).toHaveLength(0)
    const { room: other, socket } = await online({ schedule: timers.schedule })
    other.onPcClose(socket)
    expect(await other.forward(request, from)).toBe('offline')
    expect(timers.live()).toBe(0)
  })

  it('AC-5.5 parallel requests are matched to their own answers by id, whatever order the PC answers in', async () => {
    const { room, socket } = await online()
    const first = room.forward(request, from)
    const second = room.forward({ ...request, ctr: 1 }, from)
    const [a, b] = asked(socket)
    if (a?.k !== 'f' || b?.k !== 'f') throw new Error('not forwarded')
    expect(a.rid).not.toBe(b.rid)
    await reply(room, socket, b.rid, answer(1))
    await reply(room, socket, a.rid, answer(0))
    expect(await second).toEqual(answer(1))
    expect(await first).toEqual(answer(0))
  })

  it('AC-5.5 the PC that does not answer ends in timeout after the request timeout, the PC is told to abort and a late answer is dropped', async () => {
    const timers = manualTimers()
    const { room, socket } = await online({ schedule: timers.schedule })
    const pending = room.forward(request, from)
    expect(timers.live()).toBe(1)
    expect(timers.timers.at(-1)?.ms).toBe(REMOTE_RELAY_LIMITS.requestTimeoutMs)
    timers.fire()
    expect(await pending).toBe('timeout')
    const sent = asked(socket)
    expect(sent.map((m) => m.k)).toEqual(['f', 'abort'])
    expect(sent[1]?.rid).toBe(sent[0]?.rid)
    await reply(room, socket, sent[0]?.rid ?? '', answer())
    expect(room.inFlight).toBe(0)
  })

  it('AC-5.5 an answer frees the timer: nothing is left scheduled', async () => {
    const timers = manualTimers()
    const { room, socket } = await online({ schedule: timers.schedule })
    const pending = room.forward(request, from)
    const [sent] = asked(socket)
    await reply(room, socket, sent?.rid ?? '', answer())
    await pending
    expect(timers.live()).toBe(0)
    expect(room.inFlight).toBe(0)
  })

  it('AC-5.9 a phone that goes away aborts the request: the PC is told, the slot is freed and the caller sees the abort', async () => {
    const timers = manualTimers()
    const { room, socket } = await online({ schedule: timers.schedule })
    const controller = new AbortController()
    const pending = room.forward(request, { ...from, signal: controller.signal })
    expect(room.inFlight).toBe(1)
    controller.abort(new Error('phone gone'))
    await expect(pending).rejects.toThrow('phone gone')
    expect(room.inFlight).toBe(0)
    expect(timers.live()).toBe(0)
    expect(asked(socket).map((m) => m.k)).toEqual(['f', 'abort'])
    // Aborting again, or answering late, changes nothing.
    controller.abort()
    await reply(room, socket, (asked(socket)[0] as { rid: string }).rid, answer())
    expect(asked(socket)).toHaveLength(2)
  })

  it('AC-5.9 a request whose signal is already aborted is never sent to the PC', async () => {
    const { room, socket } = await online()
    const controller = new AbortController()
    controller.abort(new Error('early'))
    await expect(room.forward(request, { ...from, signal: controller.signal })).rejects.toThrow('early')
    expect(asked(socket)).toHaveLength(0)
    expect(room.inFlight).toBe(0)
  })

  it('AC-5.5 when the PC connection ends or is replaced, every request waiting on it ends as offline', async () => {
    const pc = await keyPair()
    const room = newRoom()
    const stale = await connect(room, pc)
    const pending = room.forward(request, from)
    const fresh = await connect(room, pc)
    expect(await pending).toBe('offline')
    expect(stale.closed).toBe(4002)
    const next = room.forward(request, from)
    room.onPcClose(fresh)
    expect(await next).toBe('offline')
    expect(room.inFlight).toBe(0)
  })

  it('AC-5.5 only the registered PC can answer, and only with a well-formed frame', async () => {
    const { room, socket } = await online()
    const pending = room.forward(request, from)
    const [sent] = asked(socket)
    const rid = sent?.rid ?? ''
    const intruder = new FakePc()
    await reply(room, intruder, rid, answer())
    await room.onPcMessage(socket, 'not json')
    await room.onPcMessage(socket, JSON.stringify({ k: 'r', rid, frame: { v: 1, t: 'a' } }))
    await room.onPcMessage(socket, JSON.stringify({ k: 'r', rid, frame: { ...answer(), extra: 1 } }))
    expect(room.inFlight).toBe(1)
    expect(socket.closed).toBeNull()
    await reply(room, socket, rid, answer())
    expect(await pending).toEqual(answer())
  })

  it('AC-5.1 what is not a frame, or speaks another version, is refused without reaching the PC', async () => {
    const { room, socket } = await online()
    for (const raw of [null, 'x', {}, { ...request, extra: 1 }, { ...request, ct: '***' }]) expect(await room.forward(raw, from), JSON.stringify(raw)).toBe('malformed')
    expect(await room.forward({ ...request, v: 9 }, from)).toBe('version')
    expect(asked(socket)).toHaveLength(0)
    expect(room.inFlight).toBe(0)
  })

  it('AC-5.9 the relay has no outbound feature: no client-side network call anywhere in the relay zone, and the scan sees one when it is there', () => {
    const outbound = (source: string): string[] =>
      [...source.matchAll(/(?:await|return|=>|[=(,:])\s*fetch\s*\(|new\s+WebSocket\b|XMLHttpRequest|EventSource|sendBeacon|node:(?:https?|http2|net|tls|dgram|dns)\b/g)].map((m) => m[0])
    expect(outbound("const r = await fetch('http://example.test')")).toHaveLength(1)
    expect(outbound('return fetch(url)')).toHaveLength(1)
    expect(outbound("const s = new WebSocket('wss://example.test')")).toHaveLength(1)
    expect(outbound("import https from 'node:https'")).toHaveLength(1)
    // A Durable Object stub call and a handler definition are not outbound requests.
    expect(outbound('const r = await stub.fetch(request)\nexport default { async fetch(request, env) { return new Response() } }')).toEqual([])
    const found: string[] = []
    for (const entry of readdirSync(join(root, 'src', 'relay'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      found.push(...outbound(readFileSync(join(entry.parentPath, entry.name), 'utf8')))
    }
    expect(found).toEqual([])
  })
})

describe('relay limits (spec 027 T11)', () => {
  const clock = { t: 1_000_000 }
  const now = (): number => clock.t
  const tight = (over: Partial<typeof REMOTE_RELAY_LIMITS>) => ({ ...REMOTE_RELAY_LIMITS, ...over })
  const online = async (extra: Partial<RoomDeps> = {}, id = ID) => {
    const room = newRoom(id, { now, ...extra })
    const socket = await connect(room, await keyPair(), id)
    return { room, socket }
  }
  const at = (address: string, bytes = 200) => ({ address, bytes })

  it('AC-5.3 a frame over the cap is refused as full before it is forwarded; one exactly at the cap goes through; the PC stays connected', async () => {
    const { room, socket } = await online()
    expect(await room.forward(request, at('203.0.113.1', REMOTE_RELAY_LIMITS.frameBytes + 1))).toBe('full')
    expect(asked(socket)).toHaveLength(0)
    void room.forward(request, at('203.0.113.1', REMOTE_RELAY_LIMITS.frameBytes))
    expect(asked(socket)).toHaveLength(1)
    expect(socket.closed).toBeNull()
    expect(room.online).toBe(true)
  })

  it('AC-5.3 phone connections are capped per id: the one over the cap is full, a freed slot is usable again, and the PC is never closed to make room', async () => {
    const { room, socket } = await online()
    const waiting = Array.from({ length: REMOTE_RELAY_LIMITS.phoneConnections }, () => room.forward(request, at('203.0.113.2')))
    expect(asked(socket)).toHaveLength(REMOTE_RELAY_LIMITS.phoneConnections)
    expect(await room.forward(request, at('203.0.113.2'))).toBe('full')
    expect(socket.closed).toBeNull()
    const first = asked(socket)[0]
    if (first?.k !== 'f') throw new Error('not forwarded')
    await reply(room, socket, first.rid, answer())
    await waiting[0]
    void room.forward(request, at('203.0.113.2'))
    expect(asked(socket)).toHaveLength(REMOTE_RELAY_LIMITS.phoneConnections + 1)
  })

  it('AC-5.3 frames a minute are capped per id, both directions counted, and the window reopens; another id is unaffected', async () => {
    const limits = tight({ framesPerMinute: 4 })
    const { room, socket } = await online({ limits })
    const other = await online({ limits }, 'another-id')
    void room.forward(request, at('203.0.113.3'))
    void room.forward(request, at('203.0.113.3'))
    expect(await room.forward(request, at('203.0.113.3'))).toBe('full')
    expect(asked(socket)).toHaveLength(2)
    expect(socket.closed).toBeNull()
    void other.room.forward(request, at('203.0.113.3'))
    expect(asked(other.socket)).toHaveLength(1)
    clock.t += 60_000
    void room.forward(request, at('203.0.113.3'))
    expect(asked(socket)).toHaveLength(3)
  })

  it('AC-5.3 bytes a day are capped per id, the answers count too, and the quota reopens after a day', async () => {
    // A request id is 12 random bytes, 16 characters, so the answer message has a known size.
    const answerSize = JSON.stringify({ k: 'r', rid: 'A'.repeat(16), frame: answer() }).length
    const limits = tight({ bytesPerDay: 100 + answerSize + 50 })
    const { room, socket } = await online({ limits })
    const first = room.forward(request, at('203.0.113.4', 100))
    const [one] = asked(socket)
    if (one?.k !== 'f') throw new Error('not forwarded')
    await room.onPcMessage(socket, JSON.stringify({ k: 'r', rid: one.rid, frame: answer() }))
    await first
    expect(await room.forward(request, at('203.0.113.4', 51))).toBe('full')
    expect(socket.closed).toBeNull()
    void room.forward(request, at('203.0.113.4', 50))
    expect(asked(socket)).toHaveLength(2)
    clock.t += 24 * 60 * 60 * 1000
    void room.forward(request, at('203.0.113.4', 100))
    expect(asked(socket)).toHaveLength(3)
  })

  it('AC-5.3 attempts per address are capped a minute; another address is unaffected; the window reopens', async () => {
    const limits = tight({ attemptsPerMinutePerAddress: 3 })
    const { room, socket } = await online({ limits })
    for (let i = 0; i < 3; i++) void room.forward(request, at('203.0.113.5'))
    expect(await room.forward(request, at('203.0.113.5'))).toBe('full')
    void room.forward(request, at('203.0.113.6'))
    expect(asked(socket)).toHaveLength(4)
    expect(socket.closed).toBeNull()
    clock.t += 60_000
    void room.forward(request, at('203.0.113.5'))
    expect(asked(socket)).toHaveLength(5)
  })

  it('AC-5.3 a PC that connects too often from one address is refused as full at the door', async () => {
    const limits = tight({ attemptsPerMinutePerAddress: 2 })
    const room = newRoom(ID, { now, limits })
    const sockets = [new FakePc(), new FakePc(), new FakePc()]
    for (const socket of sockets) await room.acceptPc(socket, '203.0.113.7')
    expect(sockets.map((socket) => socket.closed)).toEqual([null, null, 4008])
    expect(sockets[2]?.sent).toEqual([])
  })

  it('AC-5.4 probing is throttled: ids with no live PC answer offline until the cap, then full for five minutes, for every id from that address', async () => {
    const addresses = createAddressLimits(REMOTE_RELAY_LIMITS, now)
    const probe = (id: string) => newRoom(id, { now, addresses })
    for (let i = 0; i < REMOTE_RELAY_LIMITS.unknownIdPerMinute; i++) expect(await probe(`guess-${i}`).forward(request, at('203.0.113.8'))).toBe('offline')
    expect(await probe('guess-last').forward(request, at('203.0.113.8'))).toBe('full')
    // Blocked from here on, whichever id: a live one is not distinguishable from a dead one by the answer.
    const live = await online({ addresses }, 'real-id')
    expect(await live.room.forward(request, at('203.0.113.8'))).toBe('full')
    expect(asked(live.socket)).toHaveLength(0)
    // Another address is untouched.
    expect(await probe('guess-other').forward(request, at('203.0.113.9'))).toBe('offline')
    void live.room.forward(request, at('203.0.113.9'))
    expect(asked(live.socket)).toHaveLength(1)
    clock.t += REMOTE_RELAY_LIMITS.unknownIdBackoffMs - 1
    expect(await live.room.forward(request, at('203.0.113.8'))).toBe('full')
    clock.t += 1
    void live.room.forward(request, at('203.0.113.8'))
    expect(asked(live.socket)).toHaveLength(2)
  })

  it('AC-5.4 a PC that is simply asleep is counted like an unknown id: a phone retrying against it hits the same throttle', async () => {
    const addresses = createAddressLimits(REMOTE_RELAY_LIMITS, now)
    const { room, socket } = await online({ addresses }, 'asleep-id')
    room.onPcClose(socket)
    for (let i = 0; i < REMOTE_RELAY_LIMITS.unknownIdPerMinute; i++) expect(await room.forward(request, at('203.0.113.10'))).toBe('offline')
    expect(await room.forward(request, at('203.0.113.10'))).toBe('full')
  })

  it('AC-5.3 handshakes are capped a minute per id and ordinary requests are not', async () => {
    const hs1: RelayFrame = { v: RELAY_PROTOCOL.current, t: 'hs1', ea: b64u.encode(new Uint8Array(65)), na: b64u.encode(new Uint8Array(16)) }
    const limits = tight({ anonymousHandshakesPerMinute: 2 })
    const { room, socket } = await online({ limits })
    void room.forward(hs1, at('203.0.113.11'))
    void room.forward(hs1, at('203.0.113.11'))
    expect(await room.forward(hs1, at('203.0.113.11'))).toBe('full')
    void room.forward(request, at('203.0.113.11'))
    expect(asked(socket)).toHaveLength(3)
    clock.t += 60_000
    void room.forward(hs1, at('203.0.113.11'))
    expect(asked(socket)).toHaveLength(4)
  })

  it('AC-5.3 the pause switch makes every route answer full without dropping the PC, and lifting it restores service', async () => {
    let paused = false
    const { room, socket } = await online({ paused: () => paused })
    paused = true
    expect(await room.forward(request, at('203.0.113.12'))).toBe('full')
    const door = new FakePc()
    await room.acceptPc(door, '203.0.113.12')
    expect(door.closed).toBe(4008)
    expect(socket.closed).toBeNull()
    expect(room.online).toBe(true)
    paused = false
    void room.forward(request, at('203.0.113.12'))
    expect(asked(socket)).toHaveLength(1)
  })

  it('AC-5.3 a refused request spends no budget', async () => {
    const limits = tight({ framesPerMinute: 2 })
    const { room, socket } = await online({ limits })
    for (let i = 0; i < 5; i++) expect(await room.forward(request, at('203.0.113.13', REMOTE_RELAY_LIMITS.frameBytes + 1))).toBe('full')
    void room.forward(request, at('203.0.113.13'))
    expect(asked(socket)).toHaveLength(1)
  })
})

describe('relay keeps nothing and logs counters only (spec 027 T12)', () => {
  const MARKER = 'MARKER-PLAINTEXT-4f1c'
  const phoneAddress = '203.0.113.99'

  /** Every string reachable from the room's own state: its maps, sets, arrays and objects. The injected collaborators are configuration, not state. */
  const heldStrings = (room: RelayRoom): string[] => {
    const found: string[] = []
    const seen = new Set<unknown>()
    const walk = (value: unknown): void => {
      if (typeof value === 'string') return void found.push(value)
      if (typeof value !== 'object' || value === null || seen.has(value)) return
      seen.add(value)
      if (value instanceof Map) for (const [key, entry] of value) (walk(key), walk(entry))
      else if (value instanceof Set || Array.isArray(value)) for (const entry of value) walk(entry)
      else if (value instanceof Uint8Array) found.push(Array.from(value).join(','))
      else for (const [key, entry] of Object.entries(value)) if (key !== 'deps') walk(entry)
    }
    walk(room)
    return found
  }

  async function session() {
    const counters = createCounters()
    const room = newRoom(ID, { counters })
    const pc = await keyPair()
    const socket = await connect(room, pc)
    const challenge = (socket.messages()[0] as { nonce: string }).nonce
    const sid = b64u.encode(random(16))
    const carrying: RelayFrame = { v: RELAY_PROTOCOL.current, t: 'q', sid, ctr: 0, ct: b64u.encode(new TextEncoder().encode(MARKER + MARKER)) }
    const pending = room.forward(carrying, { address: phoneAddress, bytes: 300 })
    const sent = asked(socket)[0]
    if (sent?.k !== 'f') throw new Error('not forwarded')
    await reply(room, socket, sent.rid, { ...answer(), sid })
    await pending
    return { room, socket, counters, challenge, sid, rid: sent.rid, ct: carrying.ct, keyHash: await fingerprint(pc.publicKey) }
  }

  it('AC-6.1 after a session ends the relay state holds nothing about it', async () => {
    const run = await session()
    // While it lives the room holds its connection and nothing else about the traffic.
    expect(run.room.online).toBe(true)
    expect(run.room.inFlight).toBe(0)
    run.room.onPcClose(run.socket)
    const held = heldStrings(run.room)
    for (const secret of [MARKER, run.challenge, run.sid, run.rid, run.ct, run.keyHash, phoneAddress]) {
      expect(held.some((text) => text.includes(secret)), secret.slice(0, 12)).toBe(false)
    }
    expect(run.room.online).toBe(false)
    expect(run.room.inFlight).toBe(0)
    expect(heldStrings(run.room)).toEqual([])
    // A fresh registration after it finds a free room and nothing remembered.
    expect(ready(await connect(run.room, await keyPair()))).toBe(true)
  })

  it('AC-6.1 a refused or replaced connection and an aborted request leave nothing behind either', async () => {
    const room = newRoom()
    const first = await keyPair()
    const live = await connect(room, first)
    const refused = await connect(room, await keyPair())
    const controller = new AbortController()
    const pending = room.forward(request, { ...from, signal: controller.signal })
    controller.abort(new Error('gone'))
    await pending.catch(() => {})
    room.onPcClose(refused)
    room.onPcClose(live)
    const bad = new FakePc()
    await room.acceptPc(bad, PC_ADDRESS)
    await room.onPcMessage(bad, 'garbage')
    expect(heldStrings(room)).toEqual([])
    expect(room.inFlight).toBe(0)
  })

  it('AC-6.2 the relay writes only aggregate counters: numbers, no payload, no address, no routing id', async () => {
    const run = await session()
    const refusedBig = await run.room.forward(request, { address: phoneAddress, bytes: REMOTE_RELAY_LIMITS.frameBytes + 1 })
    expect(refusedBig).toBe('full')
    run.room.onPcClose(run.socket)
    expect(await run.room.forward(request, { address: phoneAddress, bytes: 200 })).toBe('offline')
    expect(await run.room.forward({ ...request, v: 9 }, { address: phoneAddress, bytes: 200 })).toBe('version')
    const lines: string[] = []
    logCounters(run.counters, (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    for (const secret of [MARKER, run.challenge, run.sid, run.rid, run.ct, run.keyHash, phoneAddress, ID]) expect(lines[0], secret.slice(0, 12)).not.toContain(secret)
    const numbers = (value: unknown): boolean => (typeof value === 'number' ? Number.isInteger(value) : typeof value === 'object' && value !== null && Object.values(value).every(numbers))
    const logged = JSON.parse(lines[0] ?? '{}')
    expect(numbers(logged)).toBe(true)
    expect(logged).toEqual({
      framesForwarded: 2,
      pcRegistrations: 1,
      refusals: { offline: 1, full: 1, timeout: 0, version: 1, gone: 0, malformed: 0, registration: 0 }
    })
  })

  it('AC-6.2 registration refusals and timeouts are counted, and still only as numbers', async () => {
    const counters = createCounters()
    const timers = manualTimers()
    const room = newRoom(ID, { counters, schedule: timers.schedule })
    const bad = new FakePc()
    await room.acceptPc(bad, PC_ADDRESS)
    await room.onPcMessage(bad, 'garbage')
    const socket = await connect(room, await keyPair())
    const refused = await connect(room, await keyPair())
    expect(refused.closed).toBe(4003)
    const pending = room.forward(request, from)
    timers.fire()
    expect(await pending).toBe('timeout')
    await expect(room.forward('x', from)).resolves.toBe('malformed')
    expect(socket.closed).toBeNull()
    expect(counters.snapshot().refusals).toMatchObject({ registration: 2, timeout: 1, malformed: 1 })
  })

  it('AC-6.2 the relay code has one place that logs, and it never touches storage or a database', () => {
    const logs = (source: string): string[] => [...source.matchAll(/\bconsole\s*\./g)].map((m) => m[0])
    const storage = (source: string): string[] => [...source.matchAll(/\b(?:storage|sql|sqlite|kv|r2|d1)\b/gi)].map((m) => m[0])
    expect(logs("console.log('x')")).toHaveLength(1)
    expect(storage('await this.ctx.storage.put(key, value)')).toHaveLength(1)
    expect(storage('exec(sql)')).toHaveLength(1)
    expect(logs('const consoleLike = 1')).toEqual([])
    const dir = join(root, 'src', 'relay')
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      if (entry.name !== 'counters.ts') expect(logs(source), `${entry.name} logs`).toEqual([])
      expect(storage(source), `${entry.name} storage`).toEqual([])
    }
  })
})

describe('relay harness (spec 027 T13)', () => {
  const setup = async () => {
    const relay = new FakeRelay()
    const identity = await keyPair()
    const device = await keyPair()
    const pc = startEchoPc(relay, { identity, devices: new Map([['dev-1', device.publicKey]]) })
    await pc.ready
    const phone = new FakePhone(relay, { device: { id: 'dev-1', sign: device.sign }, expect: { pcKey: identity.publicKey } })
    return { relay, identity, device, pc, phone }
  }
  const flipOnFrame = (text: string): string => {
    const message = JSON.parse(text)
    if (message.k === 'f') message.frame.ct = `${message.frame.ct.startsWith('A') ? 'B' : 'A'}${message.frame.ct.slice(1)}`
    return JSON.stringify(message)
  }

  it('harness: a phone request reaches the fake PC socket and returns, and the tap records every byte', async () => {
    const { relay, pc, phone } = await setup()
    expect(await phone.connect()).toEqual({ ok: true })
    expect(await phone.request('hello world one')).toEqual({ ok: true, plaintext: 'HELLO WORLD ONE' })
    expect(pc.received).toEqual(['hello world one'])
    expect(relay.urls).toEqual([`wss://${relay.host}/relay/v1/pc`])
    // Two handshake round trips and one request: three frames each way on the phone side.
    expect(relay.tap.of('phoneToRelay')).toHaveLength(3)
    expect(relay.tap.of('relayToPhone')).toHaveLength(3)
    expect(relay.tap.of('relayToPc').length).toBeGreaterThanOrEqual(3)
    expect(relay.tap.of('pcToRelay').length).toBeGreaterThanOrEqual(3)
    const everything = relay.tap.records.reduce((sum, record) => sum + new TextEncoder().encode(record.text).length, 0)
    expect(relay.tap.bytes()).toBe(everything)
    expect(everything).toBeGreaterThan(0)
    expect(relay.tap.leaks(['hello world one', 'HELLO WORLD ONE', 'dev-1'])).toEqual([])
  })

  it('harness: the tap scan sees a marker in clear, in base64 at any alignment, in base64url and in hex', async () => {
    const { relay } = await setup()
    const marker = 'visible-marker-9'
    await relay.phoneFetch(`{"note":"${marker}"}`)
    expect(relay.tap.leaks([marker, 'absent-marker-1'])).toEqual([marker])
    for (const [i, encode] of [
      (text: string) => btoa(text),
      (text: string) => btoa(`x${text}`),
      (text: string) => btoa(`xy${text}`),
      (text: string) => btoa(text).replaceAll('+', '-').replaceAll('/', '_'),
      (text: string) => [...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    ].entries()) {
      const fresh = await setup()
      await fresh.relay.phoneFetch(JSON.stringify({ blob: encode(marker) }))
      expect(fresh.relay.tap.leaks([marker]), `encoding ${i}`).toEqual([marker])
    }
  })

  it('harness: relay refusals reach the phone as plain statuses', async () => {
    const empty = new FakeRelay()
    const frame = JSON.stringify(request)
    expect((await empty.phoneFetch(frame)).status).toBe(503)
    expect(JSON.parse((await empty.phoneFetch(frame)).body)).toEqual({ error: 'offline' })
    expect((await empty.phoneFetch('not json')).status).toBe(400)
    expect((await empty.phoneFetch(JSON.stringify({ ...request, v: 9 }))).status).toBe(426)
    expect((await empty.phoneFetch(frame, { address: 'x' })).status).toBe(503)
    const { relay } = await setup()
    const huge = await relay.phoneFetch(`${' '.repeat(REMOTE_RELAY_LIMITS.frameBytes)}${frame}`)
    expect(huge.status).toBe(429)
    // The pure mapping, for the two results the harness cannot easily provoke.
    expect(answerFor('gone')).toMatchObject({ status: 410, body: '{"error":"gone"}' })
    expect(answerFor('timeout').status).toBe(504)
    expect(answerFor(answer())).toMatchObject({ status: 200, body: JSON.stringify(answer()) })
  })

  it('harness: the adversary switch alters, drops, replays and substitutes, and the PC end rejects what it must', async () => {
    const { relay, pc, phone } = await setup()
    expect(await phone.connect()).toEqual({ ok: true })
    // Alter a frame on its way to the PC: it fails authentication there, the PC refuses it as gone and the session is over.
    relay.tamper.relayToPc = flipOnFrame
    expect(await phone.request('first request')).toMatchObject({ ok: false, status: 410, error: 'gone' })
    expect(pc.rejected).toBe(1)
    delete relay.tamper.relayToPc
    // A new session, a genuine request, then the relay sends the same frame again.
    expect(await phone.connect()).toEqual({ ok: true })
    expect(await phone.request('only once')).toEqual({ ok: true, plaintext: 'ONLY ONCE' })
    await relay.replay('relayToPc')
    expect(await relay.replay('phoneToRelay')).toMatchObject({ status: 410 })
    await relay.idle()
    expect(pc.received).toEqual(['only once'])
    expect(pc.rejected).toBeGreaterThanOrEqual(2)
    // Drop: nothing arrives, the phone sees a network error.
    relay.tamper.phoneToRelay = () => null
    await expect(phone.request('dropped')).rejects.toThrow('dropped')
    delete relay.tamper.phoneToRelay
    // Substitute the PC's ephemeral key in the handshake answer: the phone refuses before sending anything.
    relay.tamper.relayToPhone = (text) => {
      const frame = JSON.parse(text)
      if (frame.t === 'hs2') frame.eb = frame.eb.startsWith('A') ? `B${frame.eb.slice(1)}` : `A${frame.eb.slice(1)}`
      return JSON.stringify(frame)
    }
    const before = relay.tap.of('phoneToRelay').length
    expect(await phone.connect()).toMatchObject({ ok: false })
    expect(relay.tap.of('phoneToRelay').length).toBe(before + 1)
  })
})

describe('the PC refuses a request as gone (spec 027 T14 step 0)', () => {
  it('AC-5.5 a PC refusal settles the waiting request with gone, once, and only from the registered PC', async () => {
    const room = newRoom()
    const socket = await connect(room, await keyPair())
    const pending = room.forward(request, from)
    const [sent] = asked(socket)
    if (sent?.k !== 'f') throw new Error('not forwarded')
    const refuse = (target: FakePc, rid: string): Promise<void> => room.onPcMessage(target, JSON.stringify({ k: 'x', rid, refusal: 'gone' }))
    await refuse(new FakePc(), sent.rid)
    await refuse(socket, 'some-other-id')
    expect(room.inFlight).toBe(1)
    await refuse(socket, sent.rid)
    expect(await pending).toBe('gone')
    expect(room.inFlight).toBe(0)
    expect(answerFor('gone').status).toBe(410)
    await refuse(socket, sent.rid)
    expect(socket.closed).toBeNull()
  })
})

describe('the room on a platform that sleeps and shares nothing (spec 027 T31)', () => {
  it('AC-5.3 the per-address limits may live in another place that answers later: the room waits for them and its rules do not change', async () => {
    const verdicts = { attempt: true, miss: true }
    const calls: string[] = []
    const addresses = {
      attempt: async (address: string) => (calls.push(`attempt ${address}`), verdicts.attempt),
      miss: async (address: string) => (calls.push(`miss ${address}`), verdicts.miss)
    }
    const room = newRoom(ID, { addresses })
    expect(await room.forward(request, from)).toBe('offline')
    expect(calls).toEqual([`attempt ${from.address}`, `miss ${from.address}`])
    verdicts.miss = false
    expect(await room.forward(request, from)).toBe('full')
    verdicts.attempt = false
    expect(await room.forward(request, from)).toBe('full')
    const refused = new FakePc()
    await room.acceptPc(refused, PC_ADDRESS)
    expect(refused.closed).toBe(4008)
    verdicts.attempt = true
    const allowed = new FakePc()
    await room.acceptPc(allowed, PC_ADDRESS)
    expect(allowed.closed).toBeNull()
    expect(allowed.messages()[0]?.k).toBe('challenge')
  })

  it('AC-5.3 a socket that connects and never registers is closed as refused after the registration time, and nothing of it is left', async () => {
    const timers = manualTimers()
    const counters = createCounters()
    const room = newRoom(ID, { schedule: timers.schedule, counters })
    const idle = new FakePc()
    await room.acceptPc(idle, PC_ADDRESS)
    expect(timers.live()).toBe(1)
    expect(timers.timers[0]?.ms).toBe(REMOTE_RELAY_LIMITS.registerTimeoutMs)
    expect(idle.closed).toBeNull()
    timers.fire()
    expect(idle.closed).toBe(4001)
    expect(counters.snapshot().refusals.registration).toBe(1)
    // A late message from it finds nothing, and the room is as it was.
    await room.onPcMessage(idle, JSON.stringify({ k: 'reg', pub: (await keyPair()).publicKey, sig: 'x' }))
    expect(room.online).toBe(false)
  })

  it('AC-5.3 the registration time stops running when the socket answers, registers or closes', async () => {
    const timers = manualTimers()
    const room = newRoom(ID, { schedule: timers.schedule })
    const registered = await connect(room, await keyPair())
    expect(timers.live()).toBe(0)
    const leaving = new FakePc()
    await room.acceptPc(leaving, PC_ADDRESS)
    expect(timers.live()).toBe(1)
    room.onPcClose(leaving)
    expect(timers.live()).toBe(0)
    timers.fire()
    expect(leaving.closed).toBeNull()
    expect(registered.closed).toBeNull()
    const garbage = new FakePc()
    await room.acceptPc(garbage, PC_ADDRESS)
    await room.onPcMessage(garbage, 'garbage')
    expect(timers.live()).toBe(0)
  })

  it('AC-6.1 a registered PC tells its socket what to remember, so a room that slept can find it again', async () => {
    const remembered: string[] = []
    const room = newRoom()
    const pc = await keyPair()
    const socket = Object.assign(new FakePc(), { remember: (keyHash: string) => void remembered.push(keyHash) })
    await room.acceptPc(socket, PC_ADDRESS)
    const nonce = (socket.messages()[0] as { nonce: string }).nonce
    const sig = b64u.encode(await pc.sign(registrationMessage(ID, b64u.decode(nonce))))
    await room.onPcMessage(socket, JSON.stringify({ k: 'reg', pub: pc.publicKey, sig }))
    expect(remembered).toEqual([await fingerprint(pc.publicKey)])
    // A refused registration remembers nothing.
    const other = Object.assign(new FakePc(), { remember: (keyHash: string) => void remembered.push(keyHash) })
    await connect(room, await keyPair())
    expect(other.closed).toBeNull()
    expect(remembered).toHaveLength(1)
  })

  it('AC-5.2 a room that woke from sleep takes back the PC whose socket remembered its key, and still refuses another key', async () => {
    const pc = await keyPair()
    const keyHash = await fingerprint(pc.publicKey)
    const woke = newRoom()
    const socket = new FakePc()
    woke.restorePc(socket, keyHash)
    expect(woke.online).toBe(true)
    expect(socket.closed).toBeNull()
    // Requests reach it, and its answers settle them, as for a PC that never slept.
    const pending = woke.forward(request, from)
    const [sent] = asked(socket)
    if (sent?.k !== 'f') throw new Error('not forwarded')
    await reply(woke, socket, sent.rid, answer())
    expect(await pending).toEqual(answer())
    // The same key may replace it; another key is refused.
    const replacement = await connect(woke, pc)
    expect(replacement.closed).toBeNull()
    expect(socket.closed).toBe(4002)
    expect((await connect(woke, await keyPair())).closed).toBe(4003)
    // Closing the restored socket takes the room offline like any other.
    const second = newRoom()
    const restored = new FakePc()
    second.restorePc(restored, keyHash)
    second.onPcClose(restored)
    expect(second.online).toBe(false)
  })

  it('AC-5.2 a second socket restored for a room that already has its PC is closed as replaced', () => {
    const room = newRoom()
    const first = new FakePc()
    const extra = new FakePc()
    room.restorePc(first, 'hash-one')
    room.restorePc(extra, 'hash-one')
    expect(first.closed).toBeNull()
    expect(extra.closed).toBe(4002)
    expect(room.online).toBe(true)
  })

  it('AC-5.5 a page of the relay answers with its own headers: JSON, never cached', () => {
    expect(answerFor('offline').headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' })
    expect(answerFor(answer()).headers).toEqual({ 'content-type': 'application/json', 'cache-control': 'no-store' })
    expect(answerFor('not-found')).toMatchObject({ status: 404, body: '{"error":"not-found"}' })
  })
})
