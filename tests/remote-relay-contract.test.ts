import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RelayHost } from '../src/coordinator/channels/remote/relay-host'
import { refusalResponse, type RemoteTransport } from '../src/coordinator/channels/remote/transport'
import { REMOTE_LIMITS, ROUTES, type RemoteHandler, type RemoteResponse } from '../src/shared/remote/api'
import { authorizeRemote } from '../src/shared/remote/authorize'
import { defaultRemote } from '../src/shared/remote/settings'
import type { ChatMessage } from '../src/shared/types'
import { b64u } from '../src/shared/remote/crypto'
import { SESSION_LIFETIME_MS } from '../src/shared/remote/relay-e2e'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { acceptShell } from '../src/shared/remote/relay-shell'
import { ADDRESS, HostPhone, hostRig } from './support/relay-host-rig'
import { keyPair, random } from './support/relay-fake'
import { RelayPairTransport } from './support/relay-pair'
import { pairDevice, signBytes, testChannel } from './support/remote-harness'
import { onThePair, served } from './support/relay-served'
import { importsOf } from './support/arch'

const root = join(__dirname, '..')
const json = { 'content-type': 'application/json', 'cache-control': 'no-store' }

describe('relay host: requests and answers (spec 027 T15)', () => {
  it('AC-2.9 a sealed request becomes a handler request with Host and Origin from the relay address, the allowed headers only, and remoteAddress relay', async () => {
    const rig = await hostRig()
    const phone = rig.phone()
    expect(await phone.connect()).toEqual({ ok: true })
    const answer = await phone.call({
      method: 'POST',
      path: '/api/chat/send',
      query: 'a=1&b=two',
      headers: {
        Authorization: 'Bearer tok123',
        'Content-Type': 'application/json',
        Accept: '*/*',
        Host: 'evil.test',
        Origin: 'https://evil.test',
        Cookie: 'session=1',
        'X-Forwarded-For': '1.2.3.4'
      },
      body: { text: 'hola' }
    })
    expect(answer).toEqual({ k: 'res', status: 200, contentType: 'application/json', cache: 'no-store', json: { ok: true } })
    expect(rig.calls).toHaveLength(1)
    const [request] = rig.calls
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/api/chat/send')
    expect(request?.query.get('a')).toBe('1')
    expect(request?.query.get('b')).toBe('two')
    expect(request?.body).toEqual({ text: 'hola' })
    expect(request?.remoteAddress).toBe('relay')
    expect(request?.headers).toEqual({
      authorization: 'Bearer tok123',
      'content-type': 'application/json',
      accept: '*/*',
      host: new URL(ADDRESS).host,
      origin: new URL(ADDRESS).origin
    })
  })

  it('AC-2.9 a request with no query, no headers and no body reaches the handler with the stamped host only', async () => {
    const rig = await hostRig()
    const phone = rig.phone()
    await phone.connect()
    await phone.call({ method: 'GET', path: '/api/hello' })
    expect(rig.calls[0]?.headers).toEqual({ host: new URL(ADDRESS).host, origin: new URL(ADDRESS).origin })
    expect([...(rig.calls[0]?.query ?? [])]).toEqual([])
    expect(rig.calls[0]?.body).toBeUndefined()
  })

  it('AC-2.9 the answer keeps status, content type, cache control and the body: JSON as JSON, bytes as base64url, nothing else', async () => {
    const answers: RemoteResponse[] = [
      { status: 201, headers: { ...json, 'set-cookie': 'a=b', 'x-other': '1' }, body: { made: true } },
      { status: 200, headers: {}, body: new Uint8Array([1, 2, 3, 250]) },
      { status: 200, headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array([9]) },
      { status: 404, headers: json },
      { status: 200, headers: json, body: null }
    ]
    const rig = await hostRig({ handler: async () => answers.shift() ?? { status: 500 } })
    const phone = rig.phone()
    await phone.connect()
    const call = () => phone.call({ method: 'GET', path: '/api/x' })
    expect(await call()).toEqual({ k: 'res', status: 201, contentType: 'application/json', cache: 'no-store', json: { made: true } })
    expect(await call()).toEqual({ k: 'res', status: 200, contentType: 'application/octet-stream', bytes: b64u.encode(new Uint8Array([1, 2, 3, 250])) })
    expect(await call()).toMatchObject({ contentType: 'image/jpeg', bytes: b64u.encode(new Uint8Array([9])) })
    expect(await call()).toEqual({ k: 'res', status: 404, contentType: 'application/json', cache: 'no-store' })
    expect(await call()).toMatchObject({ status: 200, json: null })
  })

  it('AC-2.5 a handler that throws, a body past the request cap and an answer past the frame cap each get a plain refusal', async () => {
    let mode: 'throw' | 'ok' | 'huge' = 'throw'
    const rig = await hostRig({
      handler: async () => {
        if (mode === 'throw') throw new Error('boom: secret-detail')
        return { status: 200, headers: json, body: mode === 'huge' ? { blob: 'x'.repeat(REMOTE_RELAY_LIMITS.frameBytes) } : { ok: true } }
      }
    })
    const phone = rig.phone()
    await phone.connect()
    const failed = await phone.call({ method: 'GET', path: '/api/x' })
    expect(failed).toMatchObject({ status: 500, json: { error: 'failed' } })
    expect(JSON.stringify(failed)).not.toContain('secret-detail')
    mode = 'ok'
    const callsBefore = rig.calls.length
    const tooLarge = await phone.call({ method: 'POST', path: '/api/x', body: { blob: 'y'.repeat(REMOTE_LIMITS.requestBytes + 1) } })
    expect(tooLarge).toMatchObject({ status: refusalResponse('too-large').status, json: { error: 'too-large' } })
    expect(rig.calls.length).toBe(callsBefore)
    mode = 'huge'
    expect(await phone.call({ method: 'GET', path: '/api/x' })).toMatchObject({ status: 500, json: { error: 'failed' } })
  })

  it('AC-3.12 the shell control message is answered with the PC-signed announcement and never reaches the handler', async () => {
    const rig = await hostRig({ shell: () => ({ version: 3, rootHash: 'root-hash-3' }) })
    const phone = rig.phone()
    await phone.connect()
    const answer = await phone.shell()
    expect(answer.announcement).toMatchObject({ version: 3, rootHash: 'root-hash-3' })
    expect(await acceptShell({ version: 3, rootHash: 'root-hash-3' }, answer.announcement, rig.identity.publicKey)).toBe('current')
    expect(await acceptShell({ version: 2, rootHash: 'old' }, answer.announcement, rig.identity.publicKey)).toBe('update')
    expect(await acceptShell({ version: 2, rootHash: 'old' }, answer.announcement, (await keyPair()).publicKey)).toBe('refuse')
    expect(rig.calls).toHaveLength(0)
    // A PC with no shell hash to announce says so rather than inventing one.
    const bare = (await hostRig()).phone()
    await bare.connect()
    expect((await bare.shell()).announcement).toBeNull()
  })

  it('AC-2.5 an authenticated message that is not a request or a control gets the plain invalid refusal and never reaches the handler', async () => {
    const rig = await hostRig()
    const phone = rig.phone()
    await phone.connect()
    for (const plain of ['not json at all', { k: 'req' }, { k: 'zzz' }, { k: 'req', method: '', path: '/api/x' }, { k: 'req', method: 'GET', path: 'x'.repeat(3000) }, { k: 'req', method: 'GET', path: '/api/x', extra: 1 }, { k: 'ctl', op: 'format' }, [1, 2], 'null']) {
      expect(await phone.ask(plain), JSON.stringify(plain)).toMatchObject({ k: 'res', status: refusalResponse('invalid').status, json: { error: 'invalid' } })
    }
    expect(rig.calls).toHaveLength(0)
  })

  it('AC-2.9 an anonymous session and device sessions are separate: ending one device cuts only its own, and a token tracked to a device cuts the session that carried it', async () => {
    // The channel resolves a bearer to a device while it handles the request, and tells the transport then.
    const holder: { host?: { track(token: string, deviceId: string): void } } = {}
    const rig = await hostRig({
      handler: async (request) => {
        if (request.headers['authorization'] === 'Bearer paired-token') holder.host?.track('paired-token', 'dev-9')
        return { status: 200, body: { ok: true } }
      }
    })
    holder.host = rig.host
    const second = await keyPair()
    rig.devices.set('dev-2', second.publicKey)
    const one = rig.phone()
    const two = rig.phone({ device: { id: 'dev-2', sign: second.sign } })
    const anonymous = rig.phone({ device: null })
    const carrier = rig.phone({ device: null })
    for (const phone of [one, two, anonymous, carrier]) expect(await phone.connect()).toEqual({ ok: true })
    await carrier.call({ method: 'GET', path: '/api/status', headers: { authorization: 'Bearer paired-token' } })
    rig.host.closeDevice('dev-1')
    await expect(one.call({ method: 'GET', path: '/api/x' })).rejects.toThrow('gone')
    for (const phone of [two, anonymous, carrier]) expect(await phone.call({ method: 'GET', path: '/api/x' })).toMatchObject({ status: 200 })
    rig.host.closeDevice('dev-9')
    await expect(carrier.call({ method: 'GET', path: '/api/x' })).rejects.toThrow('gone')
    for (const phone of [two, anonymous]) expect(await phone.call({ method: 'GET', path: '/api/x' })).toMatchObject({ status: 200 })
    // A closed device is refused its next handshake the moment it is revoked.
    rig.devices.delete('dev-2')
    expect((await rig.phone({ device: { id: 'dev-2', sign: second.sign } }).connect()).ok).toBe(false)
  })

  it('AC-3.11 a session ends at one hour, and closeAll ends every one (a reconnect always means new keys)', async () => {
    const rig = await hostRig()
    const old = rig.phone()
    await old.connect()
    expect(await old.call({ method: 'GET', path: '/api/x' })).toMatchObject({ status: 200 })
    rig.clock.t += SESSION_LIFETIME_MS - 1
    expect(await old.call({ method: 'GET', path: '/api/x' })).toMatchObject({ status: 200 })
    rig.clock.t += 1
    await expect(old.call({ method: 'GET', path: '/api/x' })).rejects.toThrow('gone')
    const fresh = rig.phone()
    await fresh.connect()
    rig.host.closeAll()
    await expect(fresh.call({ method: 'GET', path: '/api/x' })).rejects.toThrow('gone')
    expect(await rig.phone().connect()).toEqual({ ok: true })
  })

  it('AC-2.6 a handshake for a device the PC does not know, or no longer knows, is refused as gone with no session', async () => {
    const rig = await hostRig()
    rig.devices.delete('dev-1')
    const revoked = rig.phone()
    expect(await revoked.connect()).toEqual({ ok: false, reason: 'hs3 refused' })
    expect(revoked.keys).toBeNull()
    expect(rig.calls).toHaveLength(0)
  })

  it('AC-7.2 a handshake the PC refuses is reported once, and one that succeeds is not', async () => {
    let failed = 0
    const rig = await hostRig({ onHandshakeFailed: () => void failed++ })
    expect(await rig.phone().connect()).toEqual({ ok: true })
    expect(await rig.phone({ device: null }).connect()).toEqual({ ok: true })
    expect(failed).toBe(0)
    const stranger = await keyPair()
    expect((await rig.phone({ device: { id: 'dev-1', sign: stranger.sign } }).connect()).ok).toBe(false)
    expect(failed).toBe(1)
    rig.devices.delete('dev-1')
    expect((await rig.phone().connect()).ok).toBe(false)
    expect(failed).toBe(2)
    // A hook that throws never breaks the answer.
    const fragile = await hostRig({
      onHandshakeFailed: () => {
        throw new Error('sink failed')
      }
    })
    fragile.devices.delete('dev-1')
    expect(await fragile.phone().connect()).toEqual({ ok: false, reason: 'hs3 refused' })
  })

  it('AC-5.9 an abort from the relay reaches the handler, and the pending handshakes do not pile up', async () => {
    let seen: AbortSignal | null = null
    const handler: RemoteHandler = (_request, signal) => {
      seen = signal
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 499 })))
    }
    const rig = await hostRig({ handler })
    const phone = rig.phone()
    await phone.connect()
    const controller = new AbortController()
    const asked = phone.ask({ k: 'req', method: 'GET', path: '/api/x' }, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((seen as AbortSignal | null)?.aborted).toBe(false)
    controller.abort()
    await asked
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
    // Many handshakes begun and never finished: the oldest are forgotten and the latest still completes.
    const starts = await Promise.all(Array.from({ length: 40 }, () => rig.phone({ device: null })))
    const first = starts[0]
    const last = starts[starts.length - 1]
    const results: boolean[] = []
    for (const waiting of [first, last]) results.push((await waiting?.connect())?.ok === true)
    expect(results).toEqual([true, true])
  })
})

/** A RemoteTransport around a RelayHost, so the real channel can run over the relay's PC side. */
class HostTransport implements RemoteTransport {
  readonly id = 'test' as const
  host: RelayHost | null = null
  constructor(
    private readonly build: (handler: RemoteHandler) => RelayHost,
    private readonly address: string
  ) {}
  async start(handler: RemoteHandler): Promise<{ address: string }> {
    this.host = this.build(handler)
    return { address: this.address }
  }
  async stop(): Promise<void> {
    this.host?.closeAll()
    this.host = null
  }
  closeDevice(deviceId: string): void {
    this.host?.closeDevice(deviceId)
  }
  track(token: string, deviceId: string): void {
    this.host?.track(token, deviceId)
  }
}

async function channelOverRelay(options: { hostAddress?: string } = {}) {
  const identity = await keyPair()
  const clock = { t: 0 }
  let t: Awaited<ReturnType<typeof testChannel>> | null = null
  const transport = new HostTransport(
    (handler) =>
      new RelayHost({
        address: options.hostAddress ?? ADDRESS,
        handler,
        identity: { publicKey: identity.publicKey, sign: identity.sign },
        deviceKey: (id) => t?.store.devices().find((device) => device.id === id)?.publicKey ?? null,
        random,
        now: () => clock.t
      }),
    ADDRESS
  )
  t = await testChannel({ remote: { enabled: true }, transport })
  await t.channel.sync()
  const setClock = (ms: number): void => {
    clock.t = ms
    t?.setNow(ms)
  }
  const connect = async (deviceId: string | null, privateKey?: CryptoKey) => {
    const host = transport.host
    if (!host) throw new Error('channel is not online')
    const phone = new HostPhone(host, {
      device: deviceId && privateKey ? { id: deviceId, sign: (data) => signBytes(privateKey, data) } : null,
      expect: { pcKey: identity.publicKey }
    })
    const connected = await phone.connect()
    if (!connected.ok) throw new Error(`handshake failed: ${connected.reason}`)
    return phone
  }
  return { t, transport, identity, clock, setClock, connect }
}

describe('the real channel over the relay host (spec 027 T15)', () => {
  it('AC-2.9 the relay transport stamps Host and Origin from its own address and the host check is unchanged', async () => {
    const rig = await channelOverRelay()
    expect(rig.t.channel.currentStatus()).toEqual({ state: 'online', address: ADDRESS })
    const { deviceId, privateKey } = await pairDevice(rig.t)
    const phone = await rig.connect(deviceId, privateKey)
    // The unchanged channel accepts a request only when its Host and Origin are its own: a 200 here is the host check passing.
    const challenge = await phone.call({ method: 'POST', path: '/api/session/challenge', body: { deviceId } })
    expect(challenge.status).toBe(200)
    // The phone cannot choose them: values it sends are ignored.
    const forged = await phone.call({ method: 'POST', path: '/api/session/challenge', body: { deviceId }, headers: { host: 'evil.test', origin: 'https://evil.test' } })
    expect(forged.status).toBe(200)
  })

  it('AC-2.9 an address the channel did not start with is refused by the same check, for every request', async () => {
    const rig = await channelOverRelay({ hostAddress: 'https://other.relay.test' })
    const { deviceId, privateKey } = await pairDevice(rig.t)
    const phone = await rig.connect(deviceId, privateKey)
    expect(await phone.call({ method: 'POST', path: '/api/session/challenge', body: { deviceId } })).toMatchObject({ status: refusalResponse('invalid').status, json: { error: 'invalid' } })
    expect(await phone.call({ method: 'GET', path: '/api/hello' })).toMatchObject({ json: { error: 'invalid' } })
  })

  it('AC-2.5 a valid end-to-end session with no device credential is refused like any other', async () => {
    const rig = await channelOverRelay()
    const { deviceId, privateKey } = await pairDevice(rig.t)
    const expected = refusalResponse('unknown-device')
    const asWire = { status: expected.status, cache: expected.headers?.['cache-control'], json: expected.body }
    for (const phone of [await rig.connect(null), await rig.connect(deviceId, privateKey)]) {
      for (const headers of [undefined, { authorization: `Bearer ${'a'.repeat(40)}` }, { authorization: 'Basic abc' }]) {
        const refused = await phone.call({ method: 'GET', path: '/api/state', headers })
        expect({ status: refused.status, cache: refused.cache, json: refused.json }).toEqual(asWire)
        expect(JSON.stringify(refused.json)).toBe(JSON.stringify(expected.body))
      }
    }
    // The pairing and hello routes stay open to an anonymous session, as the channel decides.
    expect((await (await rig.connect(null)).call({ method: 'GET', path: '/api/hello' })).status).toBe(200)
  })

  it('AC-3.10 the bearer session is independent of the end-to-end session', async () => {
    const rig = await channelOverRelay()
    const { deviceId, privateKey } = await pairDevice(rig.t)
    const wire: string[] = []
    const login = async (phone: Awaited<ReturnType<typeof rig.connect>>): Promise<string> => {
      const challenge = await phone.call({ method: 'POST', path: '/api/session/challenge', body: { deviceId } })
      const nonce = (challenge.json as { nonce: string }).nonce
      const signature = b64u.encode(await signBytes(privateKey, b64u.decode(nonce)))
      const session = await phone.call({ method: 'POST', path: '/api/session', body: { deviceId, signature } })
      expect(session.status).toBe(200)
      return (session.json as { token: string }).token
    }
    const status = (phone: Awaited<ReturnType<typeof rig.connect>>, token: string) => phone.call({ method: 'GET', path: '/api/status', headers: { authorization: `Bearer ${token}` } })
    rig.setClock(1_000)
    const first = await rig.connect(deviceId, privateKey)
    const token = await login(first)
    expect((await status(first, token)).status).toBe(200)
    // A second end-to-end session half an hour later: ending or replacing the first does not shorten the bearer.
    rig.setClock(1_000 + 30 * 60_000)
    const second = await rig.connect(deviceId, privateKey)
    expect((await status(second, token)).status).toBe(200)
    // The bearer still expires on its own hour, and a fresh end-to-end session does not extend it.
    rig.setClock(1_000 + SESSION_LIFETIME_MS + 1)
    const third = await rig.connect(deviceId, privateKey)
    expect((await status(third, token)).status).toBe(refusalResponse('unknown-device').status)
    await expect(status(first, token)).rejects.toThrow('gone')
    // The token only ever travelled inside sealed frames.
    wire.push(...first.wire, ...second.wire, ...third.wire)
    expect(wire.join('\n')).not.toContain(token)
    expect(wire.join('\n')).not.toContain(deviceId)
  })
})

describe('the channel did not change (spec 027 T17)', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'tests', 'support', 'remote-protected.json'), 'utf8')) as Record<string, string>
  const read = (file: string): string => readFileSync(join(root, file), 'utf8')
  const hashOf = (source: string): string => createHash('sha256').update(source.replaceAll('\r\n', '\n')).digest('hex')

  /** The protected files whose content no longer matches the manifest. The manifest is checked in: a deliberate change to the security layer updates it in the same commit, in plain sight. */
  const changed = (source: (file: string) => string): string[] => Object.keys(manifest).filter((file) => hashOf(source(file)) !== manifest[file])

  it('AC-2.3 the security layer is byte-identical to the manifest; the one allowed edit is the relay member of the transport id', () => {
    expect(Object.keys(manifest).length).toBeGreaterThanOrEqual(30)
    expect(changed(read)).toEqual([])
    // The gate fails on a change, even a single character and even in transport.ts.
    const tweaked = (file: string) => (file.endsWith('/channel.ts') ? `${read(file)}\n` : read(file))
    expect(changed(tweaked)).toEqual(['src/coordinator/channels/remote/channel.ts'])
    const widened = (file: string) => (file.endsWith('/transport.ts') ? read(file).replace("'test' | 'relay'", "'test' | 'relay' | 'other'") : read(file))
    expect(changed(widened)).toEqual(['src/coordinator/channels/remote/transport.ts'])
    // Line endings are not a change.
    expect(changed((file) => read(file).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))).toEqual([])
  })

  const mentionsRelay = (source: string): string[] => [...source.matchAll(/relay/gi)].map((match) => match[0])
  const branchesOnTransport = (source: string): string[] =>
    [...source.matchAll(/\btransport\??\.id\b|\.id\s*[!=]==?\s*['"](?:tailscale|test|relay)['"]|\bswitch\s*\(\s*[\w.?]*\.id\s*\)/g)].map((match) => match[0])

  it('AC-2.3 the security layer never mentions the relay, and a branch on it is caught', () => {
    const scanned = Object.keys(manifest).filter((file) => !file.endsWith('/transport.ts'))
    for (const file of scanned) {
      expect(mentionsRelay(read(file)), `${file} names the relay`).toEqual([])
      expect(branchesOnTransport(read(file)), `${file} branches on the transport`).toEqual([])
    }
    // The only mention in transport.ts is the id union.
    expect(mentionsRelay(read('src/coordinator/channels/remote/transport.ts'))).toEqual(['relay'])
    // Negative fixtures: a copy of the channel with a relay branch makes both scans fail.
    const channel = read('src/coordinator/channels/remote/channel.ts')
    const withBranch = `${channel}\nif (this.transport?.id === 'relay') { relayOnly() }\n`
    expect(mentionsRelay(withBranch).length).toBeGreaterThan(0)
    expect(branchesOnTransport(withBranch).length).toBeGreaterThan(0)
    expect(branchesOnTransport(`${channel}\nconst kind = transport.id\n`)).toHaveLength(1)
    expect(branchesOnTransport("if (device.id === 'dev-1') {}")).toEqual([])
  })

  it('AC-2.2 api.ts and authorize.ts do not import the relay module', () => {
    for (const file of ['src/shared/remote/api.ts', 'src/shared/remote/authorize.ts']) {
      const imports = importsOf(read(file))
      expect(imports.filter((specifier) => /relay/i.test(specifier)), file).toEqual([])
    }
    expect(importsOf("import { relayFrameSchema } from './relay-frame'").filter((specifier) => /relay/i.test(specifier))).toHaveLength(1)
    // The frame schemas live apart: the closed route table does not know them.
    expect(ROUTES.some((route) => /relay/i.test(route.path))).toBe(false)
  })

  it('AC-2.4 the verdict is the same for any transport id, a third one included', () => {
    const everything = { ...defaultRemote(), sensitive: true, continueHistory: true, cameras: ['camera.a'], scopes: { chat: true, approve: true, home: true, cameras: true, vault: true, history: true } }
    for (const route of ROUTES) {
      for (const remote of [defaultRemote(), everything]) {
        for (const device of [null, { deviceId: 'd1' }]) {
          for (const cameraId of [undefined, 'camera.a', 'camera.b']) {
            const base = authorizeRemote({ device, remote, route, cameraId })
            for (const transport of ['tailscale', 'test', 'relay']) {
              expect(authorizeRemote({ device, remote, route, cameraId, transport } as never), `${route.path} ${transport}`).toEqual(base)
            }
          }
        }
      }
    }
  })
})

describe('what crosses the relay pair (spec 027 T17)', () => {
  const realImmediate = globalThis.setImmediate
  const turn = (): Promise<void> => new Promise((resolve) => realImmediate(resolve))
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; !done() && i < 5000; i++) await turn()
    expect(done()).toBe(true)
  }
  const text = (message: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: message }], ts: 1000 })

  it('AC-2.1 the harness really builds the relay pair, and the 026 requests cross the relay as ciphertext', async () => {
    await onThePair(async () => {
      const { t, pair, headers } = await served({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      expect(t.transport).toBeInstanceOf(RelayPairTransport)
      await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'marker-text-to-hide' } })
      expect(pair.relay.tap.of('phoneToRelay').length).toBeGreaterThan(2)
      expect(pair.relay.tap.leaks(['marker-text-to-hide', headers.authorization ?? ''])).toEqual([])
    })
  })

  it('AC-5.7 a camera still of exactly 2 MB crosses the relay in one frame under the cap, and 2 MB plus 1 is refused by the channel', async () => {
    await onThePair(async () => {
      const { t, pair, headers } = await served({ cameras: ['camera.patio'], scopes: { chat: false, approve: true, home: false, cameras: true, vault: false, history: false } })
      t.setAlwaysAllowTools(['camera_look'])
      t.home.snapshotBytes = Buffer.alloc(REMOTE_LIMITS.photoBytes, 7)
      const ok = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
      expect(ok.status).toBe(200)
      expect((ok.body as { photo: string }).photo).toBe(t.home.snapshotBytes.toString('base64'))
      const biggest = Math.max(...pair.relay.tap.of('relayToPhone').map((frame) => frame.length))
      expect(biggest).toBeGreaterThan(REMOTE_LIMITS.photoBytes)
      expect(biggest).toBeLessThan(REMOTE_RELAY_LIMITS.frameBytes)
      t.home.snapshotBytes = Buffer.alloc(REMOTE_LIMITS.photoBytes + 1, 7)
      const big = await t.transport.request({ method: 'GET', path: '/api/cameras/still', query: 'id=camera.patio', headers })
      expect(big.status).toBe(413)
      expect(big.body).toEqual({ error: 'too-large' })
    })
  })

  it('AC-5.8 the 25 second long poll answers inside the 30 second timeout through the relay, and its slot is free afterwards', async () => {
    // The relay never times a request out before the channel does, and the poll fits under the channel's own cut.
    expect(REMOTE_LIMITS.longPollMs).toBeLessThan(REMOTE_LIMITS.timeoutMs)
    expect(REMOTE_LIMITS.timeoutMs).toBeLessThan(REMOTE_RELAY_LIMITS.requestTimeoutMs)
    await onThePair(async () => {
      const { t, pair, headers } = await served({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      t.chat.seed([text('viejo')])
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        const pending = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=1', headers })
        // The channel holds the poll once it has its cut timer and its hold timer.
        await until(() => vi.getTimerCount() >= 2)
        expect(pair.relay.room.inFlight).toBe(1)
        await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.longPollMs)
        const state = await pending
        expect(state.status).toBe(200)
        expect((state.body as { rev: number; messages: unknown[] }).rev).toBe(1)
        expect((state.body as { messages: unknown[] }).messages).toEqual([])
        expect(pair.relay.room.inFlight).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('AC-5.8 a held poll wakes on a change and an aborted one frees its slot at the relay', async () => {
    await onThePair(async () => {
      const { t, pair, headers } = await served({ scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false } })
      t.chat.seed([text('viejo')])
      const woken = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=1', headers })
      await until(() => pair.relay.room.inFlight === 1)
      const sent = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'nuevo' } })
      expect(sent.status).toBe(200)
      const state = await woken
      expect((state.body as { rev: number }).rev).toBe(2)
      expect(pair.relay.room.inFlight).toBe(0)
      const controller = new AbortController()
      const aborted = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=2', headers, signal: controller.signal })
      await until(() => pair.relay.room.inFlight === 1)
      controller.abort(new Error('phone gone'))
      await expect(aborted).rejects.toThrow('phone gone')
      await until(() => pair.relay.room.inFlight === 0)
      // The channel's slot was freed too: the device can hold two polls again.
      const again = [1, 2].map(() => t.transport.request({ method: 'GET', path: '/api/state', query: 'since=2', headers }))
      await until(() => pair.relay.room.inFlight === 2)
      t.chat.resolveAsk(0, 'listo')
      for (const response of await Promise.all(again)) expect(response.status).toBe(200)
      expect(pair.relay.room.inFlight).toBe(0)
    })
  })
})
