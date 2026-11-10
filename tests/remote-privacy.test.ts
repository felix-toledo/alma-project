import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceExportList } from '../src/coordinator/channels/remote/devices-admin'
import { eraseRelay, transportExport } from '../src/coordinator/channels/remote/relay-privacy'
import { RelayStore } from '../src/coordinator/channels/remote/relay-store'
import { exportPersonalData } from '../src/coordinator/privacy'
import { defaultRemote } from '../src/shared/remote/settings'
import { HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

describe('T28 privacy (AC-9.4, 9.5, BR-35)', () => {
  async function servedPair(): Promise<{ t: Harness; a: { deviceId: string; token: string }; b: { deviceId: string; token: string } }> {
    let byte = 0
    const random = (length: number): Uint8Array => {
      byte = (byte % 250) + 1
      return new Uint8Array(length).fill(byte)
    }
    const t = await testChannel({ remote: { enabled: true, scopes: { chat: true, approve: true, home: false, cameras: false, vault: false, history: false } }, random })
    await t.channel.sync()
    const first = await pairDevice(t, 'phone-a')
    const second = await pairDevice(t, 'phone-b')
    const a = { deviceId: first.deviceId, token: await openSession(t, first.deviceId, first.privateKey) }
    const b = { deviceId: second.deviceId, token: await openSession(t, second.deviceId, second.privateKey) }
    return { t, a, b }
  }

  const auth = (token: string): Record<string, string> => ({ ...HOST, authorization: `Bearer ${token}` })

  it('AC-9.4: erase revoca todo sin pedir confirmación (ya la dio), borra registros, corta sesiones y cuenta', async () => {
    const { t, a, b } = await servedPair()
    t.setConfirm(false)
    t.transport.holdConnection(a.deviceId)
    t.transport.holdConnection(b.deviceId)
    const result = await t.channel.erase()
    expect(result).toEqual({ devices: 2 })
    expect(t.store.devices()).toEqual([])
    expect(t.confirmCalls).toEqual([])
    expect(t.transport.closedDevices.sort()).toEqual([a.deviceId, b.deviceId].sort())
    for (const token of [a.token, b.token]) {
      const refused = await t.transport.request({ method: 'GET', path: '/api/status', headers: auth(token) })
      expect(refused.status).toBe(401)
    }
    const revokes = t.records.filter((entry) => entry.action === 'remote.device.revoke')
    expect(revokes.map((entry) => entry.target).sort()).toEqual([a.deviceId, b.deviceId].sort())
    // The file on disk keeps no record either.
    await t.channel.sync()
    expect(t.store.devices()).toEqual([])
  })

  it('AC-9.5: export lista nombres y fechas, nunca material de llave', async () => {
    const { t } = await servedPair()
    const list = deviceExportList(t.store.devices())
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ name: 'phone-a', pairedAt: expect.any(Number), lastSeenAt: expect.any(Number) })
    const json = JSON.stringify(list)
    expect(json).toContain('phone-a')
    for (const banned of ['secret', 'credential', 'passkey', 'push', 'endpoint', 'token', 'privateKey']) expect(json).not.toContain(banned)
  })
})

describe('privacy of the notes and conversations routes (spec 028)', () => {
  async function servedReading(): Promise<Harness> {
    const scopes = { ...defaultRemote().scopes, chat: true, approve: true, vault: true, history: true }
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true } })
    await t.channel.sync()
    t.vault.put('Diario/hoy.md', 'hola')
    t.vault.put('Diario/foto.png', new Uint8Array([1, 2, 3]))
    t.chat.threads.push({ ...makeThread('t1'), messages: [{ role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 1 }] })
    return t
  }

  async function browse(t: Harness): Promise<void> {
    for (const [path, body] of [
      ['/api/notes/list', { folder: 'Diario' }],
      ['/api/notes/find', { query: 'hoy' }],
      ['/api/notes/read', { path: 'Diario/hoy.md' }],
      ['/api/notes/image', { target: 'foto.png', from: 'Diario/hoy.md' }],
      ['/api/threads/list', { offset: 0 }],
      ['/api/threads/read', { id: 't1' }]
    ] as const) {
      expect((await t.call(path, body)).status, path).toBe(200)
    }
  }

  it('AC-4.4 (028) reading makes no outbound call and sends nothing to a provider', async () => {
    const fetched = vi.spyOn(globalThis, 'fetch')
    try {
      const t = await servedReading()
      await browse(t)
      expect(t.posts).toEqual([])
      expect(fetched).not.toHaveBeenCalled()
      expect(t.chat.askCalls).toEqual([])
      // Only a message sent into a conversation reaches the model, through the same ask the PC uses.
      expect((await t.call('/api/threads/send', { id: 't1', text: 'sigue' })).status).toBe(200)
      expect(t.chat.askCalls).toEqual([{ threadId: 't1', text: 'sigue' }])
      expect(t.posts).toEqual([])
      expect(fetched).not.toHaveBeenCalled()
    } finally {
      fetched.mockRestore()
    }
  })

  it('AC-4.5 (028) the remote data folder holds nothing new after browsing', async () => {
    const t = await servedReading()
    await t.phone()
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(readdirSync(t.dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
        const file = join(entry.parentPath, entry.name)
        return [file, readFileSync(file, 'utf8')]
      }))
    const before = snapshot()
    expect(Object.keys(before).length).toBeGreaterThan(0)
    await browse(t)
    expect(snapshot()).toEqual(before)
  })

  it('AC-4.6 (028) export and erase are unchanged', async () => {
    const t = await servedReading()
    const { deviceId } = await t.phone()
    await browse(t)
    expect(deviceExportList(t.store.devices())).toEqual([{ name: 'phone', pairedAt: expect.any(Number), lastSeenAt: expect.any(Number) }])
    t.setConfirm(false)
    expect(await t.channel.erase()).toEqual({ devices: 1 })
    expect(t.confirmCalls).toEqual([])
    expect(t.store.devices().some((device) => device.id === deviceId)).toBe(false)
    // Erasing the phones never touches the vault or the conversations.
    expect(t.vault.entries.map((entry) => entry.path)).toContain('Diario/hoy.md')
    expect(t.chat.threads.map((thread) => thread.id)).toContain('t1')
  })
})

describe('privacy of the relay (spec 027 T23)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-relay-privacy-'))
    dirs.push(dir)
    return dir
  }
  const box = { seal: async (plain: string) => `sealed:${plain}`, open: async (sealed: string) => sealed.slice('sealed:'.length) }
  const storeIn = (dir: string) => RelayStore.load({ dir, sealBox: box, random: (length) => crypto.getRandomValues(new Uint8Array(length)), domain: () => 'relay.example' })

  it('AC-8.2 (027) erase deletes the relay credentials and the routing id, and disconnects first', async () => {
    const dir = folder()
    const store = await storeIn(dir)
    const id = await store.ensureRoutingId()
    await store.recordPairing()
    const steps: string[] = []
    await eraseRelay({
      store,
      disconnect: () => {
        steps.push(`disconnect while the id is ${store.routingId() === id ? 'still there' : 'gone'}`)
      }
    })
    expect(steps).toEqual(['disconnect while the id is still there'])
    expect(existsSync(join(dir, 'relay-sealed'))).toBe(false)
    expect(store.routingId()).toBeNull()
    expect(store.pairedDomain()).toBeNull()
    expect((await storeIn(dir)).routingId()).toBeNull()
    // The next use makes a new id, so the old address is dead for good.
    expect(await store.ensureRoutingId()).not.toBe(id)
  })

  it('AC-8.2 (027) erase deletes the credentials even when disconnecting fails or nothing is there', async () => {
    const dir = folder()
    const store = await storeIn(dir)
    await store.ensureRoutingId()
    await expect(
      eraseRelay({
        store,
        disconnect: async () => {
          throw new Error('socket already closed')
        }
      })
    ).resolves.toBeUndefined()
    expect(existsSync(join(dir, 'relay-sealed'))).toBe(false)
    await expect(eraseRelay({ store: await storeIn(folder()), disconnect: () => {} })).resolves.toBeUndefined()
  })

  it('AC-8.2 (027) the relay is told nothing: erasing contacts no host', async () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'coordinator', 'channels', 'remote', 'relay-privacy.ts'), 'utf8')
    expect(source).not.toMatch(/fetch\s*\(|WebSocket|node:(?:https?|net|tls|dns)/)
  })

  it('AC-8.3 (027) export lists the transport choice without credentials', async () => {
    const tailscale = defaultRemote()
    expect(transportExport(tailscale)).toEqual({ transport: 'tailscale', relayOn: false })
    expect(transportExport({ ...tailscale, enabled: true })).toEqual({ transport: 'tailscale', relayOn: false })
    expect(transportExport({ ...tailscale, transport: 'relay' })).toEqual({ transport: 'relay', relayOn: false })
    expect(transportExport({ ...tailscale, transport: 'relay', enabled: true })).toEqual({ transport: 'relay', relayOn: true })
    // Whatever else is attached to the settings object at runtime, only the two facts leave.
    const crowded = { ...tailscale, transport: 'relay' as const, enabled: true, routingId: 'abcdefghijklmnopqrstuvwxyz', relayDomain: 'relay.example', privateKey: 'd-secret' }
    const json = JSON.stringify(transportExport(crowded as never))
    expect(Object.keys(JSON.parse(json))).toEqual(['transport', 'relayOn'])
    for (const banned of ['routingId', 'abcdefgh', 'relay.example', 'privateKey', 'd-secret', 'key', 'token', 'secret']) expect(json).not.toContain(banned)
  })

  it('AC-8.3 (027) the personal-data export never copies the sealed relay file', async () => {
    const data = folder()
    const target = folder()
    const remoteDir = join(data, 'remote')
    const store = await storeIn(remoteDir)
    const id = await store.ensureRoutingId()
    mkdirSync(join(data, 'threads'), { recursive: true })
    writeFileSync(join(data, 'threads', 't.json'), '{}')
    const out = exportPersonalData(data, target)
    const copied = readdirSync(out, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    expect(copied.length).toBeGreaterThan(0)
    for (const entry of copied) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toContain(id)
    expect(existsSync(join(out, 'remote'))).toBe(false)
  })

  it('AC-8.2 (027) and the 026 erase is unchanged: devices are revoked and the channel needs nothing from the relay', async () => {
    const t = await testChannel({ remote: { enabled: true } })
    await t.channel.sync()
    await pairDevice(t, 'phone-a')
    t.setConfirm(false)
    expect(await t.channel.erase()).toEqual({ devices: 1 })
    expect(t.confirmCalls).toEqual([])
  })
})
