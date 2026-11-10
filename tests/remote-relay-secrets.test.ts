import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCounters, logCounters } from '../src/relay/counters'
import type { WebSocketCtor } from '../src/coordinator/channels/remote/relay-connection'
import { RelayTransport } from '../src/coordinator/channels/remote/relay-transport'
import { b64u } from '../src/shared/remote/crypto'
import { sealRequest } from '../src/shared/remote/relay-e2e'
import type { RelayState } from '../src/shared/remote/relay-status'
import { FakeRelay, keyPair, manualTimers, mentions, random, startEchoPc } from './support/relay-fake'
import { type HostPhone, hostRig } from './support/relay-host-rig'
import { FakePhone } from './support/relay-phone'
import { onThePair, served } from './support/relay-served'
import { HOST } from './support/remote-harness'

const root = join(__dirname, '..')
const OFFER = b64u.encode(new Uint8Array(32).fill(1))

/** Everything the code could say out loud: console output, the errors it raised, the states it reported. */
const heard: { console: string[]; errors: string[]; states: string[] } = { console: [], errors: [], states: [] }
const privateD = (jwk: unknown): string => (jwk as { d?: string }).d ?? ''
const say = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)))

function listen(): void {
  heard.console = []
  heard.errors = []
  heard.states = []
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void heard.console.push(args.map(say).join(' ')))
  }
}

afterEach(() => vi.restoreAllMocks())

/** Runs a step that may fail; what it throws is kept to be searched. */
async function attempt<T>(step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step()
  } catch (error) {
    heard.errors.push(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error))
    return undefined
  }
}

const everything = (extra: string[] = []): string => [...heard.console, ...heard.errors, ...heard.states, ...extra].join('\n')

describe('keys and credentials never reach logs, audit or errors (spec 027 T19)', () => {
  it('AC-3.6 the scan sees a leak when there is one', () => {
    listen()
    const secret = 'MARKER-SECRET-VALUE-1234'
    console.log(`oops ${secret}`)
    heard.errors.push(new Error(`failed with ${btoa(secret)}`).message)
    expect(mentions(everything(), [secret, 'not-present-anywhere'])).toEqual([secret])
    expect(mentions(heard.errors.join('\n'), [secret])).toEqual([secret])
  })

  it('AC-3.6 the relay path through the real channel: success, tampering, replay, revocation and every refusal say nothing about a key or a credential', async () => {
    listen()
    await onThePair(async () => {
      const { t, pair, headers, token, privateKey, deviceId } = await served({
        cameras: ['camera.patio'],
        scopes: { chat: true, approve: true, home: true, cameras: true, vault: true, history: true }
      })
      const known = [
        token,
        OFFER,
        privateD((pair.identity as NonNullable<typeof pair.identity>).privateJwk),
        ((await crypto.subtle.exportKey('jwk', privateKey)) as { d?: string }).d ?? '',
        'WRONG-BEARER-TOKEN-0123456789abcdef',
        'WRONG-PAIRING-SECRET-0123456789ab'
      ]
      const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => t.transport.request({ method, path, headers: { ...headers, ...extra }, body })
      // Success paths.
      await attempt(() => call('GET', '/api/status'))
      await attempt(() => call('POST', '/api/chat/send', { text: 'hola' }))
      // A bearer that is not a session, a pairing secret that is not the offer.
      await attempt(() => call('GET', '/api/status', undefined, { authorization: 'Bearer WRONG-BEARER-TOKEN-0123456789abcdef' }))
      await t.state.update({ hostName: new URL(pair.relay.origin).host })
      await t.channel.pairStart()
      const key = await crypto.subtle.exportKey('jwk', (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).publicKey)
      await attempt(() =>
        t.transport.request({ method: 'POST', path: '/api/pair/request', headers: HOST, body: { secret: b64u.encode(new TextEncoder().encode('WRONG-PAIRING-SECRET-0123456789ab').slice(0, 32)), phonePublicKey: { kty: key.kty, crv: key.crv, x: key.x, y: key.y } } })
      )
      // The relay alters, replays and drops what it carries.
      let once = 0
      pair.relay.tamper.relayToPc = (text) => {
        const message = JSON.parse(text)
        if (message.k === 'f' && message.frame.t === 'q' && once++ === 0) message.frame.ct = `A${message.frame.ct.slice(1)}`
        return JSON.stringify(message)
      }
      await attempt(() => call('GET', '/api/status'))
      delete pair.relay.tamper.relayToPc
      await attempt(() => pair.relay.replay('relayToPc').then(() => undefined))
      pair.relay.tamper.phoneToRelay = () => null
      await attempt(() => call('GET', '/api/status'))
      delete pair.relay.tamper.phoneToRelay
      // The relay closes the PC's connection in every way it can, and the device is revoked while connected.
      for (const code of [1006, 4001, 4003, 4008]) {
        pair.relay.closeFromRelay(code)
        await attempt(() => call('GET', '/api/status'))
      }
      await attempt(() => t.channel.revokeDevice(deviceId))
      await attempt(() => call('GET', '/api/status'))
      await t.channel.stop()
      await attempt(() => call('GET', '/api/status'))

      expect(mentions(everything([JSON.stringify(t.records), JSON.stringify(t.statuses), JSON.stringify(t.pairings), JSON.stringify(t.confirmCalls.map((c) => c.kind))]), known)).toEqual([])
      expect(heard.errors.length).toBeGreaterThan(0)
      expect(t.records.length).toBeGreaterThan(0)
    })
  })

  it('AC-3.6 the PC end of the end-to-end layer: every failed handshake, tampered frame, expired session and failing handler says nothing', async () => {
    listen()
    const SECRET_IN_THE_MESSAGE = 'handler-secret-ABCDEFGH-12345'
    const rig = await hostRig({
      handler: async (request) => {
        if (request.path === '/api/boom') throw new Error(`failed with ${SECRET_IN_THE_MESSAGE}`)
        return { status: 200, body: { echoed: request.headers.authorization ?? null } }
      }
    })
    const known = [SECRET_IN_THE_MESSAGE, privateD(rig.identity.privateJwk), privateD(rig.device.privateJwk), 'Bearer-secret-token-XYZXYZXYZXYZ']
    const phone = rig.phone()
    await attempt(async () => phone.connect())
    await attempt(() => phone.call({ method: 'GET', path: '/api/boom', headers: { authorization: 'Bearer-secret-token-XYZXYZXYZXYZ' } }))
    await attempt(() => phone.call({ method: 'POST', path: '/api/x', body: { blob: 'y'.repeat(2_000_000) } }))
    await attempt(() => phone.ask('not json: Bearer-secret-token-XYZXYZXYZXYZ'))
    const tampered = await sealRequest(phone.keys as NonNullable<HostPhone['keys']>, 99, new TextEncoder().encode('{}'))
    await attempt(async () => phone.submit({ ...tampered, ct: `A${(tampered as { ct: string }).ct.slice(1)}` }))
    await attempt(() => phone.call({ method: 'GET', path: '/api/x' }))
    // A device that is revoked, one that signs wrongly, an expired session.
    rig.devices.delete('dev-1')
    await attempt(async () => rig.phone().connect())
    const stranger = await keyPair()
    await attempt(async () => rig.phone({ device: { id: 'dev-1', sign: stranger.sign } }).connect())
    const late = rig.phone({ device: null })
    await attempt(async () => late.connect())
    rig.clock.t += 2 * 3_600_000
    await attempt(() => late.call({ method: 'GET', path: '/api/x' }))
    expect(mentions(everything(), known)).toEqual([])
    expect(heard.errors.length).toBeGreaterThan(0)
  })

  it('AC-3.6 the connection and the relay server say nothing about a key or a challenge, in logs, states or counters', async () => {
    listen()
    const relay = new FakeRelay()
    const timers = manualTimers()
    const identity = await keyPair()
    const states: RelayState[] = []
    const transport = new RelayTransport({
      routingId: relay.routingId,
      relayDomain: 'relay.test',
      identity,
      deviceKey: () => null,
      webSocket: relay.webSocket as unknown as WebSocketCtor,
      random,
      now: () => Date.now(),
      schedule: timers.schedule,
      jitter: () => 0.5,
      onState: (state) => states.push(state)
    })
    await transport.start(async () => ({ status: 200, body: { ok: true } }))
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await relay.idle()
      }
    }
    await settle()
    const challenge = relay.tap.of('relayToPc').map((text) => (JSON.parse(text) as { k: string; nonce?: string }).nonce).find(Boolean) ?? ''
    for (const code of [4001, 4002, 4003, 4008, 4009, 4010, 1006, 1000]) {
      relay.closeFromRelay(code)
      await settle()
      relay.refuseConnections = code % 2 === 0
      timers.fire()
      await settle()
      relay.refuseConnections = false
      timers.fire()
      await settle()
    }
    relay.muteKeepalive = true
    timers.fireMs(25_000)
    timers.fireMs(70_000)
    await settle()
    await transport.stop()
    heard.states.push(JSON.stringify(states))
    const counters = createCounters()
    logCounters(counters, (line) => heard.console.push(line))
    const phone = new FakePhone(relay, { device: null, expect: { pcKey: identity.publicKey } })
    await attempt(async () => phone.connect())
    const echo = startEchoPc(relay, { identity })
    await echo.ready
    const known = [privateD(identity.privateJwk), challenge]
    expect(challenge.length).toBeGreaterThan(20)
    expect(states.length).toBeGreaterThan(4)
    expect(mentions(everything(), known)).toEqual([])
  })

  it('AC-3.6 no relay code writes a line on its own: the only console use is the counters helper', () => {
    const dirs = [join(root, 'src', 'coordinator', 'channels', 'remote'), join(root, 'src', 'relay'), join(root, 'src', 'shared', 'remote')]
    const lines = (source: string): string[] => [...source.matchAll(/\bconsole\s*\.|process\.(?:stdout|stderr)|\bdebugger\b/g)].map((m) => m[0])
    expect(lines('console.log(x); process.stderr.write(y)')).toHaveLength(2)
    for (const dir of dirs) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/relay-.*\.ts$|^(room|registration|limits-state|answer|counters)\.ts$/.test(entry.name)) continue
        if (entry.name === 'counters.ts') continue
        expect(lines(readFileSync(join(dir, entry.name), 'utf8')), entry.name).toEqual([])
      }
    }
  })
})
