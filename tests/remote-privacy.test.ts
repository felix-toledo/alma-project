import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { deviceExportList } from '../src/coordinator/channels/remote/devices-admin'
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
