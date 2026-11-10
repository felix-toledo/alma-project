import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WebSocketCtor } from '../src/coordinator/channels/remote/relay-connection'
import { RelayTransport } from '../src/coordinator/channels/remote/relay-transport'
import type { RemoteRequest } from '../src/shared/remote/api'
import { b64u, fingerprint, type PublicJwk, signEs256 } from '../src/shared/remote/crypto'
import { type ShellAnnouncement, acceptShell, shellAnnouncementMessage } from '../src/shared/remote/relay-shell'
import { chatOutcomeKey, sendChat } from '../src/remote-client/lib/chat'
import { generateDeviceKey } from '../src/remote-client/lib/keys'
import { getJson } from '../src/remote-client/lib/request'
import { openSession, type FetchLike } from '../src/remote-client/lib/session'
import { memoryStorage } from '../src/remote-client/lib/storage'
import { createRelayClient, type RelayClient } from '../src/remote-client/relay/client'
import { checkShell, loadInstalledShell } from '../src/remote-client/relay/shell'
import { FakeRelay, keyPair, manualTimers } from './support/relay-fake'

interface Signing {
  publicKey: PublicJwk
  privateJwk: PublicJwk
}
const signingPair = async (): Promise<Signing> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as unknown as PublicJwk
  return { publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, privateJwk }
}
const announce = async (signer: Signing, version: number, rootHash: string): Promise<ShellAnnouncement> => ({
  version,
  rootHash,
  sig: b64u.encode(await signEs256(signer.privateJwk, shellAnnouncementMessage(version, rootHash)))
})

describe('acceptShell (spec 027 T7)', () => {
  const installed = { version: 3, rootHash: 'hash-three' }

  it('AC-3.12 acceptShell accepts only a PC-signed newer version and refuses the rest: current when the running hash is the announced one', async () => {
    const pc = await signingPair()
    expect(await acceptShell(installed, await announce(pc, 3, 'hash-three'), pc.publicKey)).toBe('current')
    expect(await acceptShell(installed, await announce(pc, 4, 'hash-three'), pc.publicKey)).toBe('current')
  })

  it('AC-3.12 acceptShell updates to a newer version the PC signed', async () => {
    const pc = await signingPair()
    expect(await acceptShell(installed, await announce(pc, 4, 'hash-four'), pc.publicKey)).toBe('update')
    expect(await acceptShell(installed, await announce(pc, 99, 'hash-far'), pc.publicKey)).toBe('update')
  })

  it('AC-3.12 acceptShell refuses a hash nobody announced, including no announcement at all', async () => {
    const pc = await signingPair()
    expect(await acceptShell(installed, null, pc.publicKey)).toBe('refuse')
    // The same version under a different hash is a shell the PC did not announce for that version.
    expect(await acceptShell(installed, await announce(pc, 3, 'hash-other'), pc.publicKey)).toBe('refuse')
  })

  it('AC-3.12 acceptShell refuses a bad signature, a signature over other fields and an announcement from another PC key', async () => {
    const pc = await signingPair()
    const stranger = await signingPair()
    const good = await announce(pc, 4, 'hash-four')
    expect(await acceptShell(installed, await announce(stranger, 4, 'hash-four'), pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, { ...good, sig: b64u.encode(new Uint8Array(64)) }, pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, { ...good, sig: '***' }, pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, { ...good, sig: '' }, pc.publicKey)).toBe('refuse')
    // The signature binds both fields: neither can be swapped under it.
    expect(await acceptShell(installed, { ...good, rootHash: 'hash-evil' }, pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, { ...good, version: 5 }, pc.publicKey)).toBe('refuse')
    // Even when the running hash equals the announced one, a bad signature is not "current".
    expect(await acceptShell(installed, await announce(stranger, 3, 'hash-three'), pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, good, {} as PublicJwk)).toBe('refuse')
  })

  it('AC-3.12 acceptShell refuses a downgrade to an older version, even a signed one', async () => {
    const pc = await signingPair()
    expect(await acceptShell(installed, await announce(pc, 2, 'hash-two'), pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, await announce(pc, 0, 'hash-zero'), pc.publicKey)).toBe('refuse')
    expect(await acceptShell(installed, await announce(pc, 2, 'hash-three'), pc.publicKey)).toBe('refuse')
  })

  it('AC-3.12 the signed message binds the version and the hash without ambiguity', () => {
    expect(shellAnnouncementMessage(1, '23')).not.toEqual(shellAnnouncementMessage(12, '3'))
    expect(shellAnnouncementMessage(1, 'a')).toEqual(shellAnnouncementMessage(1, 'a'))
    expect(shellAnnouncementMessage(1, 'a')).not.toEqual(shellAnnouncementMessage(1, 'b'))
  })
})

const HASH = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

describe('the phone relay client (spec 027 T26)', () => {
  const root = join(__dirname, '..')
  const filesUnder = (dir: string): string[] =>
    readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))

  /** Calls of the global `fetch`: a bare `fetch(` in a file that does not take `fetch` as a parameter. */
  const globalFetchCalls = (source: string): number => {
    const takesFetch = /\bfetch\s*:\s*FetchLike|\bfetch\s*,|\(\s*fetch\b/.test(source)
    return takesFetch ? 0 : [...source.matchAll(/(?<![.\w])fetch\s*\(|globalThis\.fetch|window\.fetch/g)].length
  }

  it('AC-2.8 no lib module names the relay and only http.ts touches the global fetch', () => {
    const naming = [...filesUnder('src/remote-client/lib'), ...filesUnder('src/remote-client/screens')].filter((file) => /relay/i.test(readFileSync(file, 'utf8')))
    expect(naming.map((file) => file.replace(root, ''))).toEqual([])
    const touching = filesUnder('src/remote-client').filter((file) => !file.endsWith('http.ts') && globalFetchCalls(readFileSync(file, 'utf8')) > 0)
    expect(touching.map((file) => file.replace(root, ''))).toEqual([])
    expect(globalFetchCalls(readFileSync(join(root, 'src/remote-client/http.ts'), 'utf8'))).toBeGreaterThan(0)
    // Negative fixtures: the scans see what they are for.
    expect(globalFetchCalls("const r = await fetch('/api/x')")).toBe(1)
    expect(globalFetchCalls('return globalThis.fetch(url)')).toBe(1)
    expect(globalFetchCalls('async function call(fetch: FetchLike, path: string) { return fetch(path) }')).toBe(0)
    expect(globalFetchCalls('deps.fetch(path)')).toBe(0)
  })

  interface Rig {
    relay: FakeRelay
    storage: ReturnType<typeof memoryStorage>
    raw: string[]
    handled: RemoteRequest[]
    clock: { t: number }
    client: RelayClient
    transport: RelayTransport
    device: { deviceId: string; privateKey: CryptoKey; publicJwk: PublicJwk }
    identity: Awaited<ReturnType<typeof keyPair>>
    devices: Map<string, PublicJwk>
    override: { frame?: (init: Parameters<FetchLike>[1]) => Promise<{ status: number; body: unknown }> | undefined }
    /** What the origin serves as /shell-manifest.json; null is a 404. */
    manifest: { value: unknown }
    rawFetch: FetchLike
    settle(): Promise<void>
    restartPc(): Promise<void>
  }

  async function rig(options: { paired?: boolean; announce?: boolean } = {}): Promise<Rig> {
    const relay = new FakeRelay({ routingId: 'abc123' })
    const timers = manualTimers()
    const identity = await keyPair()
    const storage = memoryStorage()
    const devices = new Map<string, PublicJwk>()
    const device = await generateDeviceKey()
    const deviceId = 'dev-phone'
    devices.set(deviceId, device.publicJwk)
    const handled: RemoteRequest[] = []
    const make = () =>
      new RelayTransport({
        routingId: relay.routingId,
        relayDomain: 'relay.test',
        identity,
        deviceKey: (id) => devices.get(id) ?? null,
        webSocket: relay.webSocket as unknown as WebSocketCtor,
        random: (length) => crypto.getRandomValues(new Uint8Array(length)),
        now: () => Date.now(),
        schedule: timers.schedule,
        jitter: () => 0.5,
        onState: () => {},
        shell: options.announce ? () => ({ version: 7, rootHash: HASH }) : undefined
      })
    const handler = async (request: RemoteRequest) => {
      handled.push(request)
      return { status: 200, headers: { 'cache-control': 'no-store' }, body: { path: request.path, auth: request.headers['authorization'] ?? null, body: request.body ?? null } }
    }
    let transport = make()
    await transport.start(handler)
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        await relay.idle()
      }
    }
    await settle()
    const raw: string[] = []
    const override: Rig['override'] = {}
    const clock = { t: 1_700_000_000_000 }
    const manifest: Rig['manifest'] = { value: { version: 7, rootHash: HASH } }
    const rawFetch: FetchLike = async (url, init) => {
      raw.push(url)
      if (url === '/shell-manifest.json') return { ok: manifest.value !== null, status: manifest.value === null ? 404 : 200, json: async () => manifest.value }
      const forced = override.frame?.(init)
      if (forced) {
        const answer = await forced
        return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body }
      }
      const answer = await relay.phoneFetch(init?.body ?? '', { signal: init?.signal })
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => JSON.parse(answer.body) }
    }
    if (options.paired) await storage.saveDevice({ deviceId, privateKey: device.privateKey, publicJwk: device.publicJwk })
    if (options.paired) await storage.savePcKey(identity.publicKey)
    const client = createRelayClient({ rawFetch, storage, random: (length) => crypto.getRandomValues(new Uint8Array(length)), now: () => clock.t })
    const built: Rig = {
      relay,
      storage,
      raw,
      handled,
      clock,
      client,
      get transport() {
        return transport
      },
      device: { deviceId, ...device },
      identity,
      devices,
      override,
      manifest,
      rawFetch,
      settle,
      async restartPc() {
        await transport.stop()
        transport = make()
        await transport.start(handler)
        await settle()
      }
    }
    return built
  }

  it('AC-2.8 a request crosses as a sealed frame to /relay/v1/frame only, and the answer comes back as an ordinary response', async () => {
    const t = await rig({ paired: true })
    const response = await t.client.fetch('/api/notes/read?x=1', {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token-ABCDEFGH', 'content-type': 'application/json', 'x-other': 'dropped', host: 'evil.test' },
      body: JSON.stringify({ path: 'Diario/hoy.md' })
    })
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ path: '/api/notes/read', auth: 'Bearer secret-token-ABCDEFGH', body: { path: 'Diario/hoy.md' } })
    const [seen] = t.handled
    expect(seen?.query.get('x')).toBe('1')
    expect(seen?.headers['x-other']).toBeUndefined()
    expect(seen?.headers['host']).toBe('abc123.relay.test')
    expect(new Set(t.raw)).toEqual(new Set(['/relay/v1/frame']))
    expect(t.relay.tap.leaks(['/api/notes/read', 'secret-token-ABCDEFGH', 'Diario/hoy.md', 'dev-phone'])).toEqual([])
    // Two handshake trips, one request.
    expect(t.relay.tap.of('phoneToRelay')).toHaveLength(3)
  })

  it('AC-2.8 a GET carries no body, a text body that is not JSON goes as text, and parallel first calls share one handshake', async () => {
    const t = await rig({ paired: true })
    const [a, b, c] = await Promise.all([t.client.fetch('/api/hello'), t.client.fetch('/api/state?since=3'), t.client.fetch('/api/x', { method: 'POST', body: 'plain text' })])
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(t.relay.tap.of('phoneToRelay').filter((text) => JSON.parse(text).t === 'hs1')).toHaveLength(1)
    expect(t.handled.map((request) => request.method)).toEqual(expect.arrayContaining(['GET', 'POST']))
    const posted = t.handled.find((request) => request.path === '/api/x')
    expect(posted?.body).toBe('plain text')
    expect(t.handled.find((request) => request.path === '/api/hello')?.body).toBeUndefined()
  })

  it('AC-4.6 a phone with no key in the relay origin asks to pair again, and sends nothing', async () => {
    const t = await rig()
    await expect(t.client.fetch('/api/hello')).rejects.toMatchObject({ name: 'RelayClientError', kind: 'pair-again' })
    expect(await t.client.connect()).toEqual({ ok: false, reason: 'pair-again' })
    expect(t.client.problem()).toBe('pair-again')
    expect(t.relay.tap.of('phoneToRelay')).toEqual([])
    expect(t.raw).toEqual([])
  })

  it('AC-4.2 pairing checks the PC against the fingerprint of the QR, remembers its key, and later sessions use that key', async () => {
    const t = await rig()
    const fromQr = await fingerprint(t.identity.publicKey)
    expect(await t.client.connect(fromQr)).toEqual({ ok: true })
    expect(await t.storage.loadPcKey()).toEqual(t.identity.publicKey)
    // Later, paired: a new client over the same storage needs no fingerprint, only the stored key.
    await t.storage.saveDevice({ deviceId: t.device.deviceId, privateKey: t.device.privateKey, publicJwk: t.device.publicJwk })
    const later = createRelayClient({
      rawFetch: async (_url, init) => {
        const answer = await t.relay.phoneFetch(init?.body ?? '')
        return { ok: answer.status === 200, status: answer.status, json: async () => JSON.parse(answer.body) }
      },
      storage: t.storage,
      random: (length) => crypto.getRandomValues(new Uint8Array(length)),
      now: () => t.clock.t
    })
    expect(await later.connect()).toEqual({ ok: true })
    expect((await later.fetch('/api/hello')).status).toBe(200)
  })

  it('AC-4.2 a PC whose key is not the one in the QR is refused after the first frame, nothing else is sent and nothing is remembered', async () => {
    const t = await rig()
    const stranger = await keyPair()
    expect(await t.client.connect(await fingerprint(stranger.publicKey))).toEqual({ ok: false, reason: 'mismatch' })
    expect(t.client.problem()).toBe('mismatch')
    expect(t.relay.tap.of('phoneToRelay')).toHaveLength(1)
    expect(await t.storage.loadPcKey()).toBeNull()
    await expect(t.client.fetch('/api/hello')).rejects.toMatchObject({ kind: 'mismatch' })
    expect(t.handled).toEqual([])
  })

  it('AC-4.2 a stored PC key that is not the PC that answers is refused too, so a different PC on that address cannot be trusted', async () => {
    const t = await rig({ paired: true })
    await t.storage.savePcKey((await keyPair()).publicKey)
    await expect(t.client.fetch('/api/hello')).rejects.toMatchObject({ kind: 'mismatch' })
    expect(t.handled).toEqual([])
  })

  it('AC-5.5 an offline PC maps to the existing network reason, and a message being typed stays in the input box', async () => {
    const t = await rig({ paired: true })
    expect((await t.client.fetch('/api/hello')).status).toBe(200)
    await t.transport.stop()
    await t.settle()
    await expect(t.client.fetch('/api/hello')).rejects.toBeInstanceOf(TypeError)
    // A message that could not be delivered is not accepted, so the screen keeps the text in the input box.
    const sent = await sendChat({ fetch: t.client.fetch, token: 'tok', text: 'a draft I am typing' })
    expect(sent).toEqual({ ok: false, reason: 'not-delivered' })
    expect(chatOutcomeKey('not-delivered')).toBe('remote.pwa.notDelivered')
    // Everything else that needs the PC reads as the existing network reason, shown as pcUnreachable.
    expect(chatOutcomeKey('network')).toBe('remote.pwa.pcUnreachable')
    expect(await getJson({ fetch: t.client.fetch, token: 'tok', path: '/api/state' })).toEqual({ ok: false, reason: 'network' })
    expect(t.client.problem()).toBeNull()
  })

  it('AC-5.5 a relay that cannot be reached is told apart from a PC that is off, so the person is told which one', async () => {
    const t = await rig({ paired: true })
    t.override.frame = () => Promise.reject(new TypeError('network'))
    expect(await t.client.connect()).toEqual({ ok: false, reason: 'down' })
    await expect(t.client.fetch('/api/hello')).rejects.toBeInstanceOf(TypeError)
    expect(t.client.problem()).toBeNull()
    delete t.override.frame
    await t.transport.stop()
    await t.settle()
    expect(await t.client.connect()).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('AC-5.5 a relay that is full is the existing rate-limited answer', async () => {
    const t = await rig({ paired: true })
    t.override.frame = () => Promise.resolve({ status: 429, body: { error: 'full' } })
    const response = await t.client.fetch('/api/hello')
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: 'rate-limited' })
    expect(await getJson({ fetch: t.client.fetch, token: 'tok', path: '/api/state' })).toEqual({ ok: false, reason: 'rate-limited' })
  })

  it('AC-3.7 a relay that speaks another version is told as such and nothing is downgraded', async () => {
    const t = await rig({ paired: true })
    t.override.frame = () => Promise.resolve({ status: 426, body: { error: 'version' } })
    await expect(t.client.fetch('/api/hello')).rejects.toMatchObject({ name: 'RelayClientError', kind: 'version' })
    expect(t.client.problem()).toBe('version')
    delete t.override.frame
    expect((await t.client.fetch('/api/hello')).status).toBe(200)
    expect(t.client.problem()).toBeNull()
  })

  it('AC-5.3 a device the PC has revoked reads as refused, which is how the app wipes itself', async () => {
    const t = await rig({ paired: true })
    t.devices.delete(t.device.deviceId)
    const response = await t.client.fetch('/api/hello')
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unknown-device' })
    const opened = await openSession({ fetch: t.client.fetch, deviceId: t.device.deviceId, sign: async () => new Uint8Array(), now: () => 0 })
    expect(opened).toEqual({ ok: false, reason: 'refused' })
  })

  it('AC-3.2 a session the PC lost is renewed by itself: reads retry once, a change is not repeated', async () => {
    const t = await rig({ paired: true })
    expect((await t.client.fetch('/api/hello')).status).toBe(200)
    await t.restartPc()
    const before = t.handled.length
    expect((await t.client.fetch('/api/state')).status).toBe(200)
    expect(t.handled.length).toBe(before + 1)
    await t.restartPc()
    const mutating = t.handled.length
    await expect(t.client.fetch('/api/chat/send', { method: 'POST', body: JSON.stringify({ text: 'hola' }) })).rejects.toBeInstanceOf(TypeError)
    expect(t.handled.length).toBe(mutating)
    // The next request opens a new session by itself.
    expect((await t.client.fetch('/api/chat/send', { method: 'POST', body: JSON.stringify({ text: 'hola' }) })).status).toBe(200)
    expect(t.handled.length).toBe(mutating + 1)
  })

  it('AC-3.2 an answer the relay altered fails, ends that session, and the next request starts a new one', async () => {
    const t = await rig({ paired: true })
    expect((await t.client.fetch('/api/hello')).status).toBe(200)
    t.relay.tamper.relayToPhone = (text) => {
      const frame = JSON.parse(text)
      if (frame.t === 'a') frame.ct = `${frame.ct.startsWith('A') ? 'B' : 'A'}${frame.ct.slice(1)}`
      return JSON.stringify(frame)
    }
    await expect(t.client.fetch('/api/hello')).rejects.toBeInstanceOf(TypeError)
    delete t.relay.tamper.relayToPhone
    expect((await t.client.fetch('/api/hello')).status).toBe(200)
    expect(t.relay.tap.of('phoneToRelay').filter((text) => JSON.parse(text).t === 'hs1')).toHaveLength(2)
  })

  it('AC-3.11 the session is renewed before its hour ends: the next request after 55 minutes opens a new one', async () => {
    const t = await rig({ paired: true })
    await t.client.fetch('/api/hello')
    const hs1 = (): number => t.relay.tap.of('phoneToRelay').filter((text) => JSON.parse(text).t === 'hs1').length
    expect(hs1()).toBe(1)
    t.clock.t += 54 * 60_000
    await t.client.fetch('/api/hello')
    expect(hs1()).toBe(1)
    t.clock.t += 2 * 60_000
    await t.client.fetch('/api/hello')
    expect(hs1()).toBe(2)
  })

  it('AC-3.12 the PC announcement of its shell comes through the session, signed, or as nothing', async () => {
    const announced = await rig({ paired: true, announce: true })
    const announcement = await announced.client.announcement()
    expect(announcement).toMatchObject({ version: 7, rootHash: HASH })
    if (announcement === null || announcement === 'unavailable') throw new Error('no announcement')
    expect(await acceptShell({ version: 7, rootHash: HASH }, announcement, announced.identity.publicKey)).toBe('current')
    expect(announced.handled).toEqual([])
    const bare = await rig({ paired: true })
    expect(await bare.client.announcement()).toBeNull()
    const offline = await rig({ paired: true })
    await offline.transport.stop()
    await offline.settle()
    expect(await offline.client.announcement()).toBe('unavailable')
  })

  it('AC-3.13 the running version of the app is the root hash the origin serves, or nothing when it serves none', async () => {
    const t = await rig({ paired: true })
    expect(await loadInstalledShell(t.rawFetch)).toEqual({ version: 7, rootHash: HASH })
    for (const bad of [null, { version: 7 }, { version: 7, rootHash: 'short' }, 'text']) {
      t.manifest.value = bad
      expect(await loadInstalledShell(t.rawFetch), JSON.stringify(bad)).toBeNull()
    }
    expect(await loadInstalledShell(async () => Promise.reject(new TypeError('offline')))).toBeNull()
  })

  it('AC-3.12 the app asks the PC which shell is official and applies acceptShell: current, update, or refuse', async () => {
    const t = await rig({ paired: true, announce: true })
    const ask = () => checkShell({ rawFetch: t.rawFetch, storage: t.storage, client: t.client })
    expect(await ask()).toEqual({ hash: HASH, decision: 'current' })
    t.manifest.value = { version: 6, rootHash: OTHER }
    expect(await ask()).toEqual({ hash: OTHER, decision: 'update' })
    // Same version under another hash, or a shell newer than anything the PC announced: a build nobody announced.
    t.manifest.value = { version: 7, rootHash: OTHER }
    expect(await ask()).toEqual({ hash: OTHER, decision: 'refuse' })
    t.manifest.value = { version: 8, rootHash: OTHER }
    expect(await ask()).toEqual({ hash: OTHER, decision: 'refuse' })
    // The PC's answer was signed by its own key: another key is refused.
    t.manifest.value = { version: 7, rootHash: HASH }
    await t.storage.savePcKey((await keyPair()).publicKey)
    expect((await ask()).decision).toBe('refuse')
  })

  it('AC-3.12 a PC with no official shell to announce is refused for the relay, and a development build has no manifest to compare', async () => {
    const t = await rig({ paired: true })
    expect(await checkShell({ rawFetch: t.rawFetch, storage: t.storage, client: t.client })).toEqual({ hash: HASH, decision: 'refuse' })
    const dev = await rig({ paired: true, announce: true })
    dev.manifest.value = null
    expect(await checkShell({ rawFetch: dev.rawFetch, storage: dev.storage, client: dev.client })).toEqual({ hash: null, decision: 'update' })
    const devNoAnnouncement = await rig({ paired: true })
    devNoAnnouncement.manifest.value = null
    expect((await checkShell({ rawFetch: devNoAnnouncement.rawFetch, storage: devNoAnnouncement.storage, client: devNoAnnouncement.client })).decision).toBe('refuse')
  })

  it('AC-3.12 the gate is for the relay only: over a direct address the app shows its version and refuses nothing', async () => {
    const t = await rig({ paired: true })
    const before = t.relay.tap.records.length
    expect(await checkShell({ rawFetch: t.rawFetch, storage: t.storage, client: null })).toEqual({ hash: HASH, decision: null })
    t.manifest.value = null
    expect(await checkShell({ rawFetch: t.rawFetch, storage: t.storage, client: null })).toEqual({ hash: null, decision: null })
    expect(t.relay.tap.records.length).toBe(before)
  })

  it('AC-3.12 a PC that cannot be asked is not a refusal: the app says nothing', async () => {
    const t = await rig({ paired: true, announce: true })
    await t.transport.stop()
    await t.settle()
    expect(await checkShell({ rawFetch: t.rawFetch, storage: t.storage, client: t.client })).toEqual({ hash: HASH, decision: null })
  })
})
