import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayStore } from '../src/coordinator/channels/remote/relay-store'
import type { SealBox } from '../src/coordinator/channels/remote/store'
import type { RelayHost } from '../src/coordinator/channels/remote/relay-host'
import { addressKey, createAddressLimits } from '../src/relay/limits-state'
import { RelayRoom } from '../src/relay/room'
import type { RemoteResponse } from '../src/shared/remote/api'
import { b64u } from '../src/shared/remote/crypto'
import { RELAY_PROTOCOL, type RelayFrame, registrationMessage } from '../src/shared/remote/relay-frame'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { hostRig } from './support/relay-host-rig'
import { FakePc, type KeyPair, keyPair, manualTimers, random } from './support/relay-fake'

// Fixes found in review of spec 027 (quality-checker), one failing test each.
const ok: RemoteResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } }
const inside = (host: RelayHost) => host as unknown as { sessions: Map<string, { tokens: Set<string> }>; tokenDevice: Map<string, string> }
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('the PC end of the relay keeps only tokens the channel knows (spec 027 BR-28, AC-8.1)', () => {
  it('AC-8.1 a bearer the channel never resolved is not remembered, however many a stranger sends', async () => {
    const rig = await hostRig({ handler: async () => ({ status: 401 }) })
    const stranger = rig.phone({ device: null })
    await stranger.connect()
    for (let i = 0; i < 20; i++) await stranger.call({ method: 'GET', path: '/api/status', headers: bearer(`bogus-${i}-${'x'.repeat(4000)}`) })
    const sessions = [...inside(rig.host).sessions.values()]
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.tokens.size).toBe(0)
    expect(inside(rig.host).tokenDevice.size).toBe(0)
  })

  it('AC-8.1 a bearer the channel resolved to a device is remembered, and a revoke of that device cuts the session', async () => {
    const holder: { host?: RelayHost } = {}
    const rig = await hostRig({
      handler: async (request) => {
        const token = /^Bearer (.+)$/.exec(request.headers['authorization'] ?? '')?.[1]
        if (token) holder.host?.track(token, 'dev-1')
        return ok
      }
    })
    holder.host = rig.host
    const phone = rig.phone({ device: null })
    await phone.connect()
    await phone.call({ method: 'GET', path: '/api/status', headers: bearer('real') })
    expect([...inside(rig.host).sessions.values()][0]?.tokens).toEqual(new Set(['real']))
    rig.host.closeDevice('dev-1')
    await expect(phone.call({ method: 'GET', path: '/api/status' })).rejects.toThrow('gone')
  })

  it('AC-8.1 a session that ends does not take away a token another live session still carries', async () => {
    const holder: { host?: RelayHost } = {}
    const rig = await hostRig({
      handler: async (request) => {
        const token = /^Bearer (.+)$/.exec(request.headers['authorization'] ?? '')?.[1]
        if (token) holder.host?.track(token, 'dev-1')
        return ok
      }
    })
    holder.host = rig.host
    const first = rig.phone({ device: null })
    const second = rig.phone({ device: null })
    await first.connect()
    await second.connect()
    await first.call({ method: 'GET', path: '/api/status', headers: bearer('shared') })
    await second.call({ method: 'GET', path: '/api/status', headers: bearer('shared') })
    // The first session ends on its own (a replayed counter); the second one is untouched.
    first.ctr = 0
    expect(await first.ask({ k: 'req', method: 'GET', path: '/api/status' })).toBe('gone')
    expect(inside(rig.host).tokenDevice.get('shared')).toBe('dev-1')
    rig.host.closeDevice('dev-1')
    await expect(second.call({ method: 'GET', path: '/api/status' })).rejects.toThrow('gone')
    expect(inside(rig.host).tokenDevice.size).toBe(0)
  })

  it('AC-8.1 a token tracked after its session ended is not kept', async () => {
    const holder: { host?: RelayHost } = {}
    const rig = await hostRig({
      handler: (request, signal) => {
        if (request.path !== '/api/slow') return Promise.resolve(ok)
        return new Promise((resolve) =>
          signal.addEventListener('abort', () => {
            holder.host?.track('late', 'dev-1')
            resolve({ status: 499 })
          })
        )
      }
    })
    holder.host = rig.host
    const phone = rig.phone()
    await phone.connect()
    const slow = phone.call({ method: 'GET', path: '/api/slow', headers: bearer('late') }).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    rig.host.closeDevice('dev-1')
    await slow
    expect(inside(rig.host).tokenDevice.size).toBe(0)
  })
})

describe('the room and a socket that dies (spec 027 AC-5.2, BR-28)', () => {
  const ID = 'room-id-one'
  const frame: RelayFrame = { v: RELAY_PROTOCOL.current, t: 'q', sid: b64u.encode(new Uint8Array(16)), ctr: 0, ct: b64u.encode(new Uint8Array(40)) }
  const from = { address: '203.0.113.7', bytes: 200 }
  class MortalPc extends FakePc {
    dead = false
    override send(message: string): void {
      if (this.dead) throw new Error('socket closed')
      super.send(message)
    }
  }
  const registration = async (room: RelayRoom, socket: FakePc, pair: KeyPair): Promise<string> => {
    await room.acceptPc(socket, '198.51.100.2')
    const challenge = socket.messages()[0]
    if (challenge?.k !== 'challenge') throw new Error('no challenge')
    const sig = b64u.encode(await pair.sign(registrationMessage(ID, b64u.decode(challenge.nonce))))
    return JSON.stringify({ k: 'reg', pub: pair.publicKey, sig })
  }

  it('AC-5.2 a socket that closes while its key is being checked does not become the PC', async () => {
    const room = new RelayRoom({ routingId: ID, random })
    const socket = new FakePc()
    const message = await registration(room, socket, await keyPair())
    const checking = room.onPcMessage(socket, message)
    room.onPcClose(socket)
    await checking
    expect(room.online).toBe(false)
    expect(socket.messages().some((m) => m.k === 'ready')).toBe(false)
    expect(await room.forward(frame, from)).toBe('offline')
  })

  it('AC-5.2 a PC whose socket is dead when a request arrives answers offline, and leaves no request or timer behind', async () => {
    const timers = manualTimers()
    const room = new RelayRoom({ routingId: ID, random, schedule: timers.schedule })
    const socket = new MortalPc()
    await room.onPcMessage(socket, await registration(room, socket, await keyPair()))
    expect(room.online).toBe(true)
    socket.dead = true
    expect(await room.forward(frame, from)).toBe('offline')
    expect(room.inFlight).toBe(0)
    expect(timers.live()).toBe(0)
    expect(room.online).toBe(false)
  })

  it('AC-5.8 the abort sent to a PC that died while a request waited does not throw inside the timer', async () => {
    const timers = manualTimers()
    const room = new RelayRoom({ routingId: ID, random, schedule: timers.schedule })
    const socket = new MortalPc()
    await room.onPcMessage(socket, await registration(room, socket, await keyPair()))
    const waiting = room.forward(frame, from)
    socket.dead = true
    expect(() => timers.fireMs(REMOTE_RELAY_LIMITS.requestTimeoutMs)).not.toThrow()
    expect(await waiting).toBe('timeout')
    expect(room.inFlight).toBe(0)
  })
})

describe('the per-address limits key (spec 027 BR-28)', () => {
  it('AC-5.3 an IPv4 address is its own key and an IPv6 address is keyed by its /64, in any spelling', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7')
    expect(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2')
    expect(addressKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2')
    expect(addressKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe('2001:db8:1:2')
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0')
    expect(addressKey('::1')).toBe('0:0:0:0')
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    // Something that is not an address is kept as it came, so it still counts against whoever sent it.
    for (const odd of ['unknown', '', '1:2:3', '1::2::3', 'gggg::1', '1:2:3:4:5:6:7:8:9']) expect(addressKey(odd), odd).toBe(odd)
  })

  it('AC-5.3 one /64 is one address for the attempt cap, however the host part changes, and the next /64 is another', () => {
    const limits = createAddressLimits(REMOTE_RELAY_LIMITS, () => 1_000_000)
    for (let i = 0; i < REMOTE_RELAY_LIMITS.attemptsPerMinutePerAddress; i++) expect(limits.attempt(`2001:db8:1:2::${i.toString(16)}`)).toBe(true)
    expect(limits.attempt('2001:db8:1:2:ffff::9')).toBe(false)
    expect(limits.attempt('2001:db8:1:3::1')).toBe(true)
  })

  it('AC-5.3 many addresses do not make every call walk all of them: idle ones are dropped at most once in a while', () => {
    const clock = { t: 5_000_000, reads: 0 }
    const limits = createAddressLimits(REMOTE_RELAY_LIMITS, () => {
      clock.reads++
      return clock.t
    })
    for (let i = 0; i < 1100; i++) void limits.attempt(`198.51.${Math.floor(i / 250)}.${i % 250}`)
    clock.reads = 0
    for (let i = 0; i < 100; i++) void limits.attempt('203.0.113.9')
    expect(clock.reads).toBeLessThan(2000)
    // Once the time has passed they are walked, one time.
    clock.t += 120_000
    clock.reads = 0
    void limits.attempt('203.0.113.9')
    expect(clock.reads).toBeGreaterThan(1000)
    clock.reads = 0
    void limits.attempt('203.0.113.9')
    expect(clock.reads).toBeLessThan(50)
  })
})

describe('the relay credentials say when they could not be read or kept (spec 027 AC-4.8, BR-13)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-relay-problem-'))
    dirs.push(dir)
    return dir
  }
  const box = (options: { failSeal?: boolean } = {}): SealBox => ({
    seal: async (plain) => {
      if (options.failSeal) throw new Error('keychain locked')
      return `sealed:${[...plain].reverse().join('')}`
    },
    open: async (sealed) => {
      if (!sealed.startsWith('sealed:')) throw new Error('not sealed')
      return [...sealed.slice('sealed:'.length)].reverse().join('')
    }
  })
  const open = (dir: string, problems: string[], sealBox = box(), domain = 'relay.example') =>
    RelayStore.load({ dir, sealBox, random, domain: () => domain, onProblem: (problem) => problems.push(problem) })
  const sealed = (value: unknown): string => `sealed:${[...JSON.stringify(value)].reverse().join('')}`

  it('AC-4.8 a damaged file is reported, once, and the safe behaviour stays: no id until one is made on purpose', async () => {
    const damage: Array<[string, (file: string) => void]> = [
      ['garbage', (file) => writeFileSync(file, 'not sealed at all')],
      ['sealed garbage', (file) => writeFileSync(file, 'sealed:}}} not json')],
      ['wrong shape', (file) => writeFileSync(file, sealed({ routingId: 7 }))],
      ['a folder in the way', (file) => mkdirSync(file)]
    ]
    for (const [name, spoil] of damage) {
      const dir = folder()
      spoil(join(dir, 'relay-sealed'))
      const problems: string[] = []
      const store = await open(dir, problems)
      expect(problems, name).toEqual(['damaged'])
      expect(store.routingId(), name).toBeNull()
    }
  })

  it('AC-4.8 no file at all is the normal first run and reports nothing', async () => {
    const problems: string[] = []
    const store = await open(folder(), problems)
    expect(store.routingId()).toBeNull()
    expect(problems).toEqual([])
  })

  it('AC-4.8 a pairing that could not be saved is reported and does not throw; what the store knows in memory is kept', async () => {
    const problems: string[] = []
    const store = await open(folder(), problems, box({ failSeal: true }))
    await expect(store.recordPairing()).resolves.toBeUndefined()
    expect(problems).toEqual(['unsaved'])
    expect(store.pairedDomain()).toBe('relay.example')
  })

  it('AC-4.8 a rename that could not be saved is reported, and the warning still shows', async () => {
    const dir = folder()
    const id = 'a'.repeat(26)
    writeFileSync(join(dir, 'relay-sealed'), sealed({ routingId: id, pairedDomain: 'old.example', renamed: false }))
    const problems: string[] = []
    const store = await open(dir, problems, box({ failSeal: true }), 'new.example')
    expect(store.renamed()).toBe(true)
    expect(problems).toEqual(['unsaved'])
  })
})
