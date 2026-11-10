// Independent verification of spec 027 (tester): limits refuse with `full` and never close the PC (AC-5.3), and the
// relay keeps nothing (AC-6.1, AC-6.2, BR-15).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerFor } from '../src/relay/answer'
import { createCounters, logCounters } from '../src/relay/counters'
import { createAddressLimits } from '../src/relay/limits-state'
import { RelayRoom } from '../src/relay/room'
import { b64u } from '../src/shared/remote/crypto'
import { RELAY_CLOSE, RELAY_PROTOCOL, type RelayFrame, registrationMessage } from '../src/shared/remote/relay-frame'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { FakePc, FakeRelay, type KeyPair, keyPair, manualTimers, mentions, random, startEchoPc } from './support/relay-fake'
import { FakePhone } from './support/relay-phone'

// Mutation check: VERIFY_027_MUTATE=nolimit makes the per-id and per-address caps admit everything; the limit tests must fail.
vi.mock('../src/relay/limits-state', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/relay/limits-state')>()
  if (process.env['VERIFY_027_MUTATE'] !== 'nolimit') return real
  return { ...real, createRoomLimits: () => ({ admit: () => true, answered: () => {} }), createAddressLimits: () => ({ attempt: () => true, miss: () => true }) }
})

const clock = { t: 1_000_000_000 }
const now = (): number => clock.t
const tight = (over: Partial<typeof REMOTE_RELAY_LIMITS>) => ({ ...REMOTE_RELAY_LIMITS, ...over })
const ADDRESS = '203.0.113.77'
const effect = JSON.stringify({ k: 'req', method: 'GET', path: '/api/status' })

afterEach(() => {
  vi.restoreAllMocks()
})

async function online(deps: ConstructorParameters<typeof FakeRelay>[0] = {}) {
  clock.t += 10 * 24 * 3_600_000
  const relay = new FakeRelay({ ...deps, deps: { now, ...deps?.deps } })
  const identity = await keyPair()
  const echo = startEchoPc(relay, { identity })
  await echo.ready
  const phone = new FakePhone(relay, { device: null, expect: { pcKey: identity.publicKey }, address: ADDRESS })
  return { relay, identity, echo, phone }
}

/** The PC was never disconnected or reconnected, and is still the one serving. */
const pcUntouched = (relay: FakeRelay): void => {
  expect(relay.urls).toHaveLength(1)
  expect(relay.room.online).toBe(true)
}

const refusedAsFull = (answer: { status: number; body: string }): void => {
  expect(answer.status).toBe(429)
  expect(JSON.parse(answer.body)).toEqual({ error: 'full' })
}

describe('verify 027 (5) limits refuse with full and never close the PC', () => {
  it('AC-5.3 a frame over the cap is refused as full', async () => {
    const { relay, phone } = await online()
    expect(await phone.connect()).toEqual({ ok: true })
    refusedAsFull(await relay.phoneFetch('x'.repeat(REMOTE_RELAY_LIMITS.frameBytes + 1), { address: ADDRESS }))
    expect((await phone.request(effect)).ok).toBe(true)
    pcUntouched(relay)
  })

  it('AC-5.3 over the frames a minute: full, the PC stays, another address is refused too (the cap is per id), and the window reopens', async () => {
    const { relay, phone } = await online({ deps: { limits: tight({ framesPerMinute: 8 }) } })
    expect(await phone.connect()).toEqual({ ok: true })
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await phone.request(effect)).ok ? 200 : 429)
    expect(statuses.filter((status) => status === 200)).toHaveLength(2)
    expect(statuses.filter((status) => status === 429)).toHaveLength(4)
    const stranger = await relay.phoneFetch(JSON.stringify(RELAY_FRAME), { address: '198.51.100.9' })
    refusedAsFull(stranger)
    pcUntouched(relay)
    clock.t += 60_000
    expect((await phone.request(effect)).ok).toBe(true)
    pcUntouched(relay)
  })

  it('AC-5.3 over the bytes a day: full, the PC stays, and the quota reopens after a day', async () => {
    const { relay, phone } = await online({ deps: { limits: tight({ bytesPerDay: 4000 }) } })
    expect(await phone.connect()).toEqual({ ok: true })
    let refused = 0
    for (let i = 0; i < 40 && refused === 0; i++) if (!(await phone.request(JSON.stringify({ k: 'req', method: 'GET', path: '/api/status', query: 'p='.padEnd(300, 'x') }))).ok) refused++
    expect(refused).toBe(1)
    pcUntouched(relay)
    clock.t += 24 * 3_600_000
    expect((await phone.request(effect)).ok).toBe(true)
    pcUntouched(relay)
  })

  it('AC-5.3 over the attempts an address makes a minute: full for that address only', async () => {
    const { relay } = await online({ deps: { limits: tight({ attemptsPerMinutePerAddress: 3 }) } })
    const answers = []
    for (let i = 0; i < 5; i++) answers.push(await relay.phoneFetch('{}', { address: '198.51.100.20' }))
    expect(answers.slice(0, 3).map((answer) => answer.status)).not.toContain(429)
    refusedAsFull(answers[3] as { status: number; body: string })
    refusedAsFull(answers[4] as { status: number; body: string })
    expect((await relay.phoneFetch('{}', { address: '198.51.100.21' })).status).not.toBe(429)
    pcUntouched(relay)
  })

  it('AC-5.3 AC-1.x the pause switch answers full for phones, turns new PC sockets away, and leaves the connected PC alone', async () => {
    let paused = false
    const { relay, phone } = await online({ deps: { paused: () => paused } })
    expect(await phone.connect()).toEqual({ ok: true })
    paused = true
    refusedAsFull(await relay.phoneFetch(JSON.stringify(RELAY_FRAME), { address: ADDRESS }))
    const late = new FakePc()
    await relay.room.acceptPc(late, '198.51.100.30')
    expect(late.closed).toBe(RELAY_CLOSE.full)
    pcUntouched(relay)
    paused = false
    expect((await phone.request(effect)).ok).toBe(true)
  })

  it('AC-5.3 15 held phone requests fill the id; the 16th is full, the PC is not closed, and another id is unaffected', async () => {
    const shared = createAddressLimits(REMOTE_RELAY_LIMITS, now)
    const a = new RelayRoom({ routingId: 'room-a', random, now, addresses: shared })
    const b = new RelayRoom({ routingId: 'room-b', random, now, addresses: shared })
    const pcA = await register(a, 'room-a', await keyPair())
    const pcB = await register(b, 'room-b', await keyPair())
    const held = Array.from({ length: REMOTE_RELAY_LIMITS.phoneConnections }, (_, i) => a.forward(RELAY_FRAME, { address: `198.51.100.${40 + i}`, bytes: 200 }))
    expect(a.inFlight).toBe(REMOTE_RELAY_LIMITS.phoneConnections)
    const over = await a.forward(RELAY_FRAME, { address: '198.51.100.99', bytes: 200 })
    expect(answerFor(over)).toMatchObject({ status: 429, body: JSON.stringify({ error: 'full' }) })
    expect(pcA.closed).toBeNull()
    expect(a.online).toBe(true)
    void b.forward(RELAY_FRAME, { address: '198.51.100.98', bytes: 200 })
    expect(b.inFlight).toBe(1)
    expect(pcB.closed).toBeNull()
    a.onPcClose(pcA)
    expect(await Promise.all(held)).toEqual(Array(REMOTE_RELAY_LIMITS.phoneConnections).fill('offline'))
  })

  it('AC-5.3 AC-5.2 a flood of PC connection attempts, and a PC with another key, never close the connected PC', async () => {
    const timers = manualTimers()
    const room = new RelayRoom({ routingId: 'room-flood', random, now, schedule: timers.schedule, limits: tight({ attemptsPerMinutePerAddress: 5 }) })
    const live = await register(room, 'room-flood', await keyPair())
    const sockets = Array.from({ length: 60 }, () => new FakePc())
    for (const socket of sockets) await room.acceptPc(socket, '198.51.100.50')
    const turnedAway = sockets.filter((socket) => socket.closed === RELAY_CLOSE.full)
    expect(turnedAway.length).toBeGreaterThanOrEqual(55 - 1)
    for (const socket of sockets) if (socket.closed === null) await room.onPcMessage(socket, 'not json')
    expect(sockets.every((socket) => socket.closed !== null)).toBe(true)
    const intruder = await register(room, 'room-flood', await keyPair(), '198.51.100.51')
    expect(intruder.closed).toBe(RELAY_CLOSE.heldByAnotherKey)
    expect(live.closed).toBeNull()
    expect(room.online).toBe(true)
  })

  it('AC-5.4 probing unknown ids from one address is throttled to full, and an unknown id answers like an offline PC', async () => {
    const shared = createAddressLimits(REMOTE_RELAY_LIMITS, now)
    const room = new RelayRoom({ routingId: 'room-nobody', random, now, addresses: shared })
    const answers = []
    for (let i = 0; i < REMOTE_RELAY_LIMITS.unknownIdPerMinute + 3; i++) answers.push(answerFor(await room.forward(RELAY_FRAME, { address: '198.51.100.60', bytes: 200 })))
    expect(answers.slice(0, REMOTE_RELAY_LIMITS.unknownIdPerMinute).every((answer) => answer.status === 503)).toBe(true)
    expect(answers.slice(-2).every((answer) => answer.status === 429)).toBe(true)
    // Still blocked a minute later; free after the backoff.
    clock.t += 60_000
    expect(answerFor(await room.forward(RELAY_FRAME, { address: '198.51.100.60', bytes: 200 })).status).toBe(429)
    clock.t += REMOTE_RELAY_LIMITS.unknownIdBackoffMs
    expect(answerFor(await room.forward(RELAY_FRAME, { address: '198.51.100.60', bytes: 200 })).status).toBe(503)
    // An offline (once registered) PC gives the same answer as an id that never existed.
    const asleep = new RelayRoom({ routingId: 'room-asleep', random, now, addresses: shared })
    const socket = await register(asleep, 'room-asleep', await keyPair())
    asleep.onPcClose(socket)
    expect(answerFor(await asleep.forward(RELAY_FRAME, { address: '198.51.100.61', bytes: 200 }))).toEqual(answerFor(await room.forward(RELAY_FRAME, { address: '198.51.100.62', bytes: 200 })))
  })
})

describe('verify 027 (6) the relay keeps nothing', () => {
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

  it('AC-6.1 after a full session and its end, nothing about it is in the room, and the counters log only numbers', async () => {
    const counters = createCounters()
    const { relay, phone, echo, identity } = await online({ deps: { counters } })
    expect(await phone.connect()).toEqual({ ok: true })
    expect((await phone.request(JSON.stringify({ k: 'req', method: 'POST', path: '/api/chat/send', body: { text: 'MARKER-TEXT-12345678' } }))).ok).toBe(true)
    await relay.phoneFetch('{}', { address: ADDRESS })
    await relay.phoneFetch('x'.repeat(REMOTE_RELAY_LIMITS.frameBytes + 1), { address: ADDRESS })
    const wire = relay.tap.records.map((record) => record.text).join('\n')
    const sid = /"sid":"([^"]+)"/.exec(wire)?.[1] ?? ''
    const rid = /"rid":"([^"]+)"/.exec(wire)?.[1] ?? ''
    const ct = /"ct":"([^"]+)"/.exec(wire)?.[1] ?? ''
    expect(sid.length).toBeGreaterThan(10)
    expect(rid.length).toBeGreaterThan(10)
    expect(ct.length).toBeGreaterThan(10)
    echo.close()
    await relay.idle()
    expect(relay.room.online).toBe(false)
    expect(relay.room.inFlight).toBe(0)
    const held = heldValues(relay.room).join('\n')
    expect(mentions(held, [sid, rid, ct, ADDRESS, relay.pcAddress, 'MARKER-TEXT-12345678', JSON.stringify(identity.publicKey.x)])).toEqual([])
    const lines: string[] = []
    logCounters(counters, (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(mentions(lines[0] ?? '', [sid, rid, ct, ADDRESS, relay.pcAddress, relay.routingId, 'MARKER-TEXT-12345678'])).toEqual([])
    const numbers = (value: unknown): boolean => (typeof value === 'number' ? Number.isInteger(value) : typeof value === 'object' && value !== null && Object.values(value).every(numbers))
    expect(numbers(JSON.parse(lines[0] ?? '{}'))).toBe(true)
  })

  it('BR-15 AC-6.1 an address is gone from memory once its rate window is over (rate-limit tables hold no address past their window)', () => {
    const touched = new Set<Map<unknown, unknown>>()
    const realSet = Map.prototype.set
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      touched.add(this)
      return realSet.call(this, key, value)
    })
    const old = '198.51.100.201'
    const oldMiss = '198.51.100.202'
    let later: string
    try {
      const limits = createAddressLimits(REMOTE_RELAY_LIMITS, now)
      void limits.attempt(old)
      void limits.miss(oldMiss)
      // Ten minutes: every one-minute window is over and nobody is blocked.
      clock.t += 10 * 60_000
      later = '198.51.100.203'
      void limits.attempt(later)
    } finally {
      spy.mockRestore()
    }
    const stillHeld = [old, oldMiss, later].filter((address) => [...touched].some((map) => Map.prototype.has.call(map, address)))
    // Only the address that is inside a live window may still be held.
    expect(stillHeld).toEqual([later])
  })

  it('AC-6.2 refusals and full sessions write no line of their own: the console stays silent', async () => {
    const logged: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    const { relay, phone } = await online({ deps: { limits: tight({ framesPerMinute: 6 }) } })
    expect(await phone.connect()).toEqual({ ok: true })
    for (let i = 0; i < 4; i++) await phone.request(effect)
    await relay.phoneFetch('not json at all', { address: '198.51.100.70' })
    const late = new FakePc()
    await relay.room.acceptPc(late, ADDRESS)
    await relay.room.onPcMessage(late, 'junk')
    expect(logged).toEqual([])
  })
})

const RELAY_FRAME: RelayFrame = { v: RELAY_PROTOCOL.current, t: 'q', sid: b64u.encode(new Uint8Array(16)), ctr: 0, ct: b64u.encode(new Uint8Array(40)) }

async function register(room: RelayRoom, routingId: string, pair: KeyPair, address = '198.51.100.1'): Promise<FakePc> {
  const socket = new FakePc()
  await room.acceptPc(socket, address)
  const challenge = socket.messages()[0]
  if (challenge?.k !== 'challenge') return socket
  const sig = b64u.encode(await pair.sign(registrationMessage(routingId, b64u.decode(challenge.nonce))))
  await room.onPcMessage(socket, JSON.stringify({ k: 'reg', pub: pair.publicKey, sig }))
  return socket
}
