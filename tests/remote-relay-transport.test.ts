import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BACKOFF, KEEPALIVE, RelayConnection, type RelayConnectionDeps, retryDelay, type WebSocketCtor } from '../src/coordinator/channels/remote/relay-connection'
import { RelayTransport } from '../src/coordinator/channels/remote/relay-transport'
import type { RemoteHandler, RemoteRequest } from '../src/shared/remote/api'
import { b64u } from '../src/shared/remote/crypto'
import type { RelayFrame } from '../src/shared/remote/relay-frame'
import { RELAY_PROTOCOL } from '../src/shared/remote/relay-frame'
import type { RelayState } from '../src/shared/remote/relay-status'
import { FakeRelay, keyPair, manualTimers } from './support/relay-fake'
import { FakePhone } from './support/relay-phone'

const root = join(__dirname, '..')
const question: RelayFrame = { v: RELAY_PROTOCOL.current, t: 'q', sid: b64u.encode(new Uint8Array(16)), ctr: 0, ct: b64u.encode(new Uint8Array(40)) }
const reply = (ctr = 0): RelayFrame => ({ v: RELAY_PROTOCOL.current, t: 'a', sid: b64u.encode(new Uint8Array(16)), ctr, ct: b64u.encode(new Uint8Array(40).fill(5)) })

/** Lets the sign-and-reply chain of registration and the fake's deliveries finish. */
async function settle(relay: FakeRelay): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await relay.idle()
  }
}

/** A quicker settle for steps that do no cryptography (a connection that is refused before it opens). */
async function flush(relay: FakeRelay): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await relay.idle()
  }
}

async function rig(
  options: {
    jitter?: number
    onFrame?: RelayConnectionDeps['onFrame']
    relay?: FakeRelay
  } = {}
) {
  const relay = options.relay ?? new FakeRelay()
  const timers = manualTimers()
  const states: RelayState[] = []
  const seen: Array<{ rid: string; frame: RelayFrame; signal: AbortSignal }> = []
  const sockets: Array<{ onclose: ((event: never) => void) | null }> = []
  const Base = relay.webSocket
  const Spy = class extends Base {
    constructor(url: string) {
      super(url)
      sockets.push(this)
    }
  }
  const counts = { connected: 0 }
  const connection = new RelayConnection({
    url: `wss://${relay.host}/relay/v1/pc`,
    routingId: relay.routingId,
    identity: await keyPair(),
    webSocket: Spy as unknown as WebSocketCtor,
    schedule: timers.schedule,
    jitter: () => options.jitter ?? 0.5,
    onFrame:
      options.onFrame ??
      (async (rid, frame, signal) => {
        seen.push({ rid, frame, signal })
        return reply(frame.t === 'q' ? frame.ctr : 0)
      }),
    onState: (state) => states.push(state),
    onConnected: () => void counts.connected++
  })
  const live = (): number[] => timers.timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms)
  return { relay, timers, states, seen, sockets, counts, connection, live }
}

describe('relay connection (spec 027 T14)', () => {
  it('connection: registers by signing the challenge, reports connecting then online, and opens exactly one socket', async () => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    expect(t.states).toEqual([{ state: 'connecting' }, { state: 'online' }])
    expect(t.relay.room.online).toBe(true)
    expect(t.relay.urls).toEqual([`wss://${t.relay.host}/relay/v1/pc`])
    expect(t.counts.connected).toBe(1)
    expect(t.live().sort((a, b) => a - b)).toEqual([KEEPALIVE.pingMs, BACKOFF.stableMs, KEEPALIVE.silentMs])
    // Starting again while running changes nothing.
    t.connection.start()
    await settle(t.relay)
    expect(t.relay.urls).toHaveLength(1)
    expect(t.states).toHaveLength(2)
  })

  it('AC-5.10 one outbound WebSocket carries every phone request', async () => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    for (let ctr = 0; ctr < 3; ctr++) {
      const answer = await t.relay.phoneFetch(JSON.stringify({ ...question, ctr }))
      expect(answer.status).toBe(200)
      expect(JSON.parse(answer.body)).toEqual(reply(ctr))
    }
    expect(t.seen).toHaveLength(3)
    expect(new Set(t.seen.map((call) => call.rid)).size).toBe(3)
    expect(t.relay.urls).toHaveLength(1)
  })

  it('connection: an answer of gone, a thrown handler and a silent one are told to the relay as gone, gone and nothing', async () => {
    const results: Array<'gone' | 'throw' | 'none'> = ['gone', 'throw', 'none']
    const t = await rig({
      onFrame: async () => {
        const next = results.shift()
        if (next === 'throw') throw new Error('handler failed')
        return next === 'gone' ? 'gone' : null
      }
    })
    t.connection.start()
    await settle(t.relay)
    expect(await t.relay.phoneFetch(JSON.stringify(question))).toMatchObject({ status: 410 })
    expect(await t.relay.phoneFetch(JSON.stringify(question))).toMatchObject({ status: 410 })
    const silent = t.relay.phoneFetch(JSON.stringify(question))
    await settle(t.relay)
    t.relay.timers.fire()
    expect(await silent).toMatchObject({ status: 504 })
  })

  it('AC-5.9 a relay abort cancels the request in the handler, and so does the connection ending', async () => {
    const signals: AbortSignal[] = []
    const t = await rig({
      onFrame: (_rid, _frame, signal) => {
        signals.push(signal)
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null)))
      }
    })
    t.connection.start()
    await settle(t.relay)
    const controller = new AbortController()
    const first = t.relay.phoneFetch(JSON.stringify(question), { signal: controller.signal })
    const second = t.relay.phoneFetch(JSON.stringify({ ...question, ctr: 1 }))
    await settle(t.relay)
    expect(signals).toHaveLength(2)
    controller.abort(new Error('phone gone'))
    await expect(first).rejects.toThrow('phone gone')
    await settle(t.relay)
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    t.relay.closeFromRelay(1006)
    await settle(t.relay)
    expect(signals[1]?.aborted).toBe(true)
    expect(await second).toMatchObject({ status: 503 })
  })

  it('AC-7.2 the retry delay doubles from one second to a sixty second cap with a fifth of jitter either way', () => {
    expect(retryDelay(0, 0.5)).toBe(BACKOFF.startMs)
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => retryDelay(attempt, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
    expect(retryDelay(0, 0)).toBe(800)
    expect(retryDelay(0, 0.9999)).toBeLessThanOrEqual(1200)
    expect(retryDelay(3, 0)).toBe(6400)
    expect(retryDelay(9, 0)).toBe(48000)
    expect(retryDelay(9, 0.9999)).toBeLessThanOrEqual(72000)
    expect(retryDelay(0, 0.5, true)).toBe(BACKOFF.capMs)
    expect(retryDelay(Number.MAX_SAFE_INTEGER, 0.5)).toBe(BACKOFF.capMs)
  })

  it('AC-7.2 an unreachable relay is retried on the schedule, forever, with the timer replaced each time', async () => {
    const t = await rig()
    t.relay.refuseConnections = true
    t.connection.start()
    await settle(t.relay)
    const seen: number[] = []
    for (let i = 0; i < 9; i++) {
      expect(t.live()).toHaveLength(1)
      const [delay] = t.live()
      seen.push(delay ?? 0)
      t.timers.fireMs(delay ?? 0)
      await settle(t.relay)
    }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000])
    expect(t.relay.urls).toHaveLength(10)
  })

  it('AC-7.2 one outage is one state transition however many retries, and recovery is one more', async () => {
    const t = await rig()
    t.relay.refuseConnections = true
    t.connection.start()
    await settle(t.relay)
    for (let i = 0; i < 50; i++) {
      t.timers.fire()
      await flush(t.relay)
    }
    expect(t.states).toEqual([{ state: 'connecting' }, { state: 'error', failure: 'relayUnreachable' }])
    t.relay.refuseConnections = false
    t.timers.fire()
    await settle(t.relay)
    expect(t.states.at(-1)).toEqual({ state: 'online' })
    expect(t.states).toHaveLength(3)
    expect(t.counts.connected).toBe(1)
  })

  it('AC-7.2 the retry count resets after thirty stable seconds and not before', async () => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    // A connection that drops before it was stable keeps climbing the schedule.
    t.relay.closeFromRelay(1006)
    await settle(t.relay)
    expect(t.live()).toEqual([1000])
    t.timers.fireMs(1000)
    await settle(t.relay)
    expect(t.states.at(-1)).toEqual({ state: 'online' })
    t.relay.closeFromRelay(1006)
    await settle(t.relay)
    expect(t.live()).toEqual([2000])
    // One that held for thirty seconds starts over.
    t.timers.fireMs(2000)
    await settle(t.relay)
    t.timers.fireMs(BACKOFF.stableMs)
    t.relay.closeFromRelay(1006)
    await settle(t.relay)
    expect(t.live()).toEqual([1000])
  })

  it.each([
    [4009, 'relayVersion', 'stops'],
    [4010, 'relayGone', 'stops'],
    [4001, 'relayRefused', 'cap'],
    [4003, 'relayRefused', 'cap'],
    [4002, 'relayRefused', 'cap'],
    [4008, 'relayFull', 'cap'],
    [1006, 'relayUnreachable', 'schedule'],
    [1000, 'relayUnreachable', 'schedule']
  ] as const)('AC-7.2 a close with code %i is %s and the connection %s', async (code, failure, then) => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    t.relay.closeFromRelay(code)
    await settle(t.relay)
    expect(t.states.at(-1)).toMatchObject({ state: 'error', failure })
    expect(t.states.filter((state) => state.state === 'error')).toHaveLength(1)
    expect(t.live()).toEqual(then === 'stops' ? [] : then === 'cap' ? [BACKOFF.capMs] : [BACKOFF.startMs])
    if (then === 'stops') {
      t.timers.fire()
      await settle(t.relay)
      expect(t.relay.urls).toHaveLength(1)
    }
  })

  it('AC-7.2 a cause that changes during an outage is a new transition; the same cause again is not', async () => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    t.relay.closeFromRelay(4008)
    await settle(t.relay)
    t.relay.refuseConnections = true
    for (let i = 0; i < 3; i++) {
      t.timers.fire()
      await settle(t.relay)
    }
    expect(t.states.filter((state) => state.state === 'error').map((state) => state.failure)).toEqual(['relayFull', 'relayUnreachable'])
  })

  it('connection: keepalive pings every 25 seconds and any word from the relay resets the 70 second watchdog', async () => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    t.timers.fireMs(KEEPALIVE.pingMs)
    await settle(t.relay)
    expect(t.relay.tap.of('pcToRelay')).toContain('ping')
    expect(t.live().filter((ms) => ms === KEEPALIVE.silentMs)).toHaveLength(1)
    expect(t.live().filter((ms) => ms === KEEPALIVE.pingMs)).toHaveLength(1)
    expect(t.states).toHaveLength(2)
  })

  it('AC-7.2 a silent socket is closed after 70 seconds and retried; the late close of the old socket changes nothing', async () => {
    const t = await rig()
    t.relay.muteKeepalive = true
    t.connection.start()
    await settle(t.relay)
    t.timers.fireMs(KEEPALIVE.pingMs)
    await settle(t.relay)
    t.timers.fireMs(KEEPALIVE.silentMs)
    await settle(t.relay)
    expect(t.states.at(-1)).toEqual({ state: 'error', failure: 'relayUnreachable' })
    expect(t.relay.room.online).toBe(false)
    expect(t.live()).toEqual([BACKOFF.startMs])
    t.relay.muteKeepalive = false
    t.timers.fireMs(BACKOFF.startMs)
    await settle(t.relay)
    expect(t.states.at(-1)).toEqual({ state: 'online' })
    const before = t.states.length
    t.sockets[0]?.onclose?.({ code: 4002 } as never)
    await settle(t.relay)
    expect(t.states).toHaveLength(before)
    expect(t.relay.room.online).toBe(true)
    expect(t.counts.connected).toBe(2)
  })

  it('connection: stop closes the socket, cancels every timer and aborts what is in flight, and nothing retries afterwards', async () => {
    const signals: AbortSignal[] = []
    const t = await rig({
      onFrame: (_rid, _frame, signal) => {
        signals.push(signal)
        return new Promise(() => {})
      }
    })
    t.connection.start()
    await settle(t.relay)
    const pending = t.relay.phoneFetch(JSON.stringify(question))
    await settle(t.relay)
    t.connection.stop()
    await settle(t.relay)
    expect(signals[0]?.aborted).toBe(true)
    expect(t.relay.room.online).toBe(false)
    expect(t.live()).toEqual([])
    expect(t.states.at(-1)).toEqual({ state: 'off' })
    expect(await pending).toMatchObject({ status: 503 })
    t.timers.fire()
    await settle(t.relay)
    expect(t.relay.urls).toHaveLength(1)
    // Stopping during an outage cancels the pending retry.
    const down = await rig()
    down.relay.refuseConnections = true
    down.connection.start()
    await settle(down.relay)
    expect(down.live()).toEqual([1000])
    down.connection.stop()
    expect(down.live()).toEqual([])
    // And it can be started again.
    down.relay.refuseConnections = false
    down.connection.start()
    await settle(down.relay)
    expect(down.states.at(-1)).toEqual({ state: 'online' })
  })

  it('connection: words that are not messages, and messages that are not for the PC, are ignored', async () => {
    const t = await rig()
    t.connection.start()
    await settle(t.relay)
    for (const text of ['not json', '{}', '{"k":"zzz"}', '{"k":"f","rid":"x"}', '{"k":"f","rid":"x","frame":{"v":1}}', '{"k":"challenge","nonce":"AAAA"}', '{"k":"ready"}', 'pong']) t.relay.injectToPc(text)
    await settle(t.relay)
    expect(t.seen).toHaveLength(0)
    expect(t.states).toEqual([{ state: 'connecting' }, { state: 'online' }])
    expect(t.relay.room.online).toBe(true)
  })

  it('AC-1.11 the connection never binds or listens: no server, no socket API of the runtime beyond the WebSocket client it is given', () => {
    const source = readFileSync(join(root, 'src', 'coordinator', 'channels', 'remote', 'relay-connection.ts'), 'utf8')
    expect(source).not.toMatch(/node:|createServer|\.listen\(|WebSocketServer|\bnet\./)
    expect(source).not.toMatch(/\bnew WebSocket\b|globalThis\.WebSocket/)
  })
})

describe('relay transport (spec 027 T16)', () => {
  const request = JSON.stringify({ k: 'req', method: 'GET', path: '/api/x' })

  async function transportRig(options: { routingId?: string; handler?: RemoteHandler } = {}) {
    const relay = new FakeRelay({ routingId: options.routingId ?? 'abc123' })
    const timers = manualTimers()
    const identity = await keyPair()
    const devices = new Map<string, Awaited<ReturnType<typeof keyPair>>>()
    for (const id of ['dev-1', 'dev-2']) devices.set(id, await keyPair())
    const revoked = new Set<string>()
    const states: RelayState[] = []
    const calls: RemoteRequest[] = []
    const handler: RemoteHandler =
      options.handler ??
      (async (call) => {
        calls.push(call)
        return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } }
      })
    const transport = new RelayTransport({
      routingId: relay.routingId,
      relayDomain: 'relay.test',
      identity,
      deviceKey: (id) => (revoked.has(id) ? null : (devices.get(id)?.publicKey ?? null)),
      webSocket: relay.webSocket as unknown as WebSocketCtor,
      random: (length) => crypto.getRandomValues(new Uint8Array(length)),
      now: () => Date.now(),
      schedule: timers.schedule,
      jitter: () => 0.5,
      onState: (state) => states.push(state)
    })
    const phone = (id: string) =>
      new FakePhone(relay, { device: { id, sign: (devices.get(id) as Awaited<ReturnType<typeof keyPair>>).sign }, expect: { pcKey: identity.publicKey } })
    return { relay, timers, transport, states, calls, handler, phone, revoked, identity }
  }

  it('AC-1.10 the relay transport has its own id and returns its relay-form address at once, before it is connected', async () => {
    const t = await transportRig({ routingId: 'AbC_-123' })
    t.relay.refuseConnections = true
    expect(t.transport.id).toBe('relay')
    const started = await t.transport.start(t.handler)
    expect(started).toEqual({ address: 'https://AbC_-123.relay.test' })
    await settle(t.relay)
    // The relay cannot be reached, which is reported as a state and retried; the start did not wait for it or fail.
    expect(t.states.at(-1)).toEqual({ state: 'error', failure: 'relayUnreachable' })
    t.relay.refuseConnections = false
    t.timers.fire()
    await settle(t.relay)
    expect(t.states.at(-1)).toEqual({ state: 'online' })
    await t.transport.stop()
  })

  it('AC-5.10 one outbound WebSocket carries every phone request, through the host and the unchanged handler', async () => {
    const t = await transportRig()
    await t.transport.start(t.handler)
    await settle(t.relay)
    const phone = t.phone('dev-1')
    expect(await phone.connect()).toEqual({ ok: true })
    for (let i = 0; i < 3; i++) {
      const answer = await phone.request(request)
      expect(answer).toMatchObject({ ok: true })
      expect(answer.ok && JSON.parse(answer.plaintext)).toMatchObject({ k: 'res', status: 200, json: { ok: true } })
    }
    expect(t.calls).toHaveLength(3)
    expect(t.relay.urls).toEqual([`wss://${t.relay.host}/relay/v1/pc`])
    await t.transport.stop()
  })

  it('AC-1.7 stop closes the relay connection and every end-to-end session', async () => {
    const t = await transportRig()
    await t.transport.start(t.handler)
    await settle(t.relay)
    const phone = t.phone('dev-1')
    await phone.connect()
    expect(await phone.request(request)).toMatchObject({ ok: true })
    await t.transport.stop()
    await settle(t.relay)
    expect(t.relay.room.online).toBe(false)
    expect(t.states.at(-1)).toEqual({ state: 'off' })
    expect(await phone.request(request)).toMatchObject({ ok: false, status: 503, error: 'offline' })
    // Starting again is a new connection with no memory of the old sessions.
    await t.transport.start(t.handler)
    await settle(t.relay)
    expect(await phone.request(request)).toMatchObject({ ok: false, status: 410, error: 'gone' })
    expect(await phone.connect()).toEqual({ ok: true })
    await t.transport.stop()
    // Safe to stop twice, and before any start.
    await t.transport.stop()
    await (await transportRig()).transport.stop()
  })

  it('AC-8.1 closeDevice ends that device sessions and refuses its next frame, and no other device is touched', async () => {
    let seen: AbortSignal | null = null
    const t = await transportRig({
      handler: (call, signal) => {
        if (call.path === '/api/slow') {
          seen = signal
          return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 499 })))
        }
        return Promise.resolve({ status: 200, body: { ok: true } })
      }
    })
    await t.transport.start(t.handler)
    await settle(t.relay)
    const one = t.phone('dev-1')
    const two = t.phone('dev-2')
    await one.connect()
    await two.connect()
    const slow = one.request(JSON.stringify({ k: 'req', method: 'GET', path: '/api/slow' }))
    await settle(t.relay)
    expect((seen as AbortSignal | null)?.aborted).toBe(false)
    t.revoked.add('dev-1')
    t.transport.closeDevice('dev-1')
    await settle(t.relay)
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    expect(await slow).toMatchObject({ ok: false, status: 410, error: 'gone' })
    expect(await one.request(request)).toMatchObject({ ok: false, status: 410, error: 'gone' })
    expect(await two.request(request)).toMatchObject({ ok: true })
    // The revoked device cannot come back: its handshake is refused.
    expect(await t.phone('dev-1').connect()).toMatchObject({ ok: false })
    await t.transport.stop()
  })

  it('AC-8.1 a token the channel tracked to a device cuts the session that carried it', async () => {
    // The channel resolves the bearer to a device while it handles the request, and tells the transport then.
    const holder: { transport?: { track(token: string, deviceId: string): void } } = {}
    const t = await transportRig({
      handler: async (call) => {
        const token = /^Bearer (.+)$/.exec(call.headers['authorization'] ?? '')?.[1]
        if (token) holder.transport?.track(token, 'dev-1')
        return { status: 200, body: { ok: true } }
      }
    })
    holder.transport = t.transport
    await t.transport.start(t.handler)
    await settle(t.relay)
    const anonymous = new FakePhone(t.relay, { device: null, expect: { pcKey: t.identity.publicKey } })
    await anonymous.connect()
    await anonymous.request(JSON.stringify({ k: 'req', method: 'GET', path: '/api/status', headers: { authorization: 'Bearer carried-token' } }))
    t.transport.closeDevice('dev-1')
    expect(await anonymous.request(request)).toMatchObject({ ok: false, status: 410 })
    await t.transport.stop()
  })

  it('AC-6.5 the relay is the only host the transport contacts, and it makes no Tailscale call and opens no listener', async () => {
    const t = await transportRig()
    await t.transport.start(t.handler)
    await settle(t.relay)
    await t.phone('dev-1').connect()
    expect(t.relay.urls).toEqual([`wss://${t.relay.host}/relay/v1/pc`])
    await t.transport.stop()
    const dir = join(root, 'src', 'coordinator', 'channels', 'remote')
    for (const file of ['relay-transport.ts', 'relay-connection.ts', 'relay-host.ts']) {
      const source = readFileSync(join(dir, file), 'utf8')
      expect(source, file).not.toMatch(/node:|child_process|createServer|\.listen\(|\bfetch\s*\(|XMLHttpRequest|\btailscale/i)
      expect(source, file).not.toMatch(/from '\.\/(tailscale|tailscale-transport|monitor)'/)
    }
  })

  it('AC-2.3 the transport interface only gained the relay id', () => {
    const source = readFileSync(join(root, 'src', 'coordinator', 'channels', 'remote', 'transport.ts'), 'utf8')
    expect(source).toContain("readonly id: 'tailscale' | 'test' | 'relay'")
    expect(source.replace("readonly id: 'tailscale' | 'test' | 'relay'", '')).not.toMatch(/relay/i)
  })
})
