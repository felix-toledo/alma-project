import { describe, expect, it, vi } from 'vitest'
import { RunTies } from '../src/coordinator/channels/remote/runs'
import { ThreadsFlow } from '../src/coordinator/channels/remote/threads'
import { refusalResponse } from '../src/coordinator/channels/remote/transport'
import { UploadsFlow } from '../src/coordinator/channels/remote/uploads'
import { defaultSettings } from '../src/shared/defaults'
import type { RemoteSettings, Settings, Thread } from '../src/shared/types'
import { defaultRemote } from '../src/shared/remote/settings'
import { COMPANY_AGENT, fakeFiles, fakeTimers, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

const settings = (): Settings => {
  const base = defaultSettings()
  return { ...base, agents: [...base.agents, { ...base.agents[0], id: COMPANY_AGENT, companyId: 'acme' }] }
}

const body = (name = 'nota.txt', text = 'hola') => ({ name, size: Buffer.byteLength(text), base64: Buffer.from(text).toString('base64') })

/** The uploads flow over fake collaborators; `reachable` is the real conversation rule of `ThreadsFlow`. */
function rig() {
  const state = { now: 0, shared: 'remote', leftover: 0 }
  const store = new Map<string, Thread>(
    [makeThread('remote'), makeThread('t1'), makeThread('t2'), makeThread('co', COMPANY_AGENT)].map((thread) => [thread.id, thread])
  )
  const running = new Set<string>()
  const files = fakeFiles()
  const timers = fakeTimers(() => state.now)
  const threads = new ThreadsFlow({
    threads: { list: () => [], get: (id) => store.get(id), isRunning: (id) => running.has(id), markOpened: () => {} },
    settings,
    sharedId: () => state.shared,
    ties: new RunTies(),
    waiting: () => false,
      now: () => 0,
    ask: () => Promise.resolve(),
    cancel: vi.fn(),
    sendShared: () => ({ ok: true }),
    uploads: { claimForSend: () => ({ ok: true, ids: undefined }), bound: () => {} }
  })
  const flow = new UploadsFlow({
    now: () => state.now,
    sharedId: () => state.shared,
    reachable: (id) => threads.reachable(id),
    isRunning: (id) => running.has(id),
    files,
    timers,
    onLeftover: () => void (state.leftover += 1)
  })
  return { flow, files, timers, state, store, running }
}

describe('UploadsFlow.put: target and busy (spec 031 T22)', () => {
  it('AC-2.6 (031) a company, an unknown and a deleted conversation answer the same gone', () => {
    const { flow, files, store } = rig()
    store.set('doomed', makeThread('doomed'))
    store.delete('doomed')
    const answers = ['co', 'nope', 'doomed'].map((id) => flow.put('d1', { shared: false, id }, body()).response)
    expect(answers[0]).toEqual(refusalResponse('gone'))
    expect(answers.map((a) => JSON.stringify(a))).toEqual(Array(3).fill(JSON.stringify(refusalResponse('gone'))))
    expect(files.puts).toHaveLength(0)
  })

  it('AC-2.7 (031) a put into a conversation with a run in progress is busy', () => {
    const { flow, files, running } = rig()
    // a run started by the PC, by a phone or by the Chat tab is the same fact to the flow: the thread has a run
    for (const id of ['t1', 'remote']) {
      running.add(id)
      const target = id === 'remote' ? { shared: true as const } : { shared: false as const, id }
      expect(flow.put('d1', target, body()).response).toEqual(refusalResponse('busy'))
      running.delete(id)
    }
    expect(files.puts).toHaveLength(0)
    // once the run ends the same put goes through
    expect(flow.put('d1', { shared: false, id: 't1' }, body()).response.status).toBe(200)
  })

  it('AC-1.7 (031) the shared thread is the Chat tab\'s thread at that moment', () => {
    const { flow, files, state } = rig()
    flow.put('d1', { shared: true }, body('a.txt'))
    state.shared = 't2'
    flow.put('d1', { shared: true }, body('b.txt'))
    flow.put('d1', { shared: false, id: 't1' }, body('c.txt'))
    expect(files.puts.map((p) => [p.name, p.threadId])).toEqual([
      ['a.txt', 'remote'],
      ['b.txt', 't2'],
      ['c.txt', 't1']
    ])
  })
})

describe('UploadsFlow.put: pending list and cap (spec 031 T23)', () => {
  const shared = { shared: true as const }
  const claim = (flow: UploadsFlow, device: string, ids: string[], thread = 'remote') => flow.claim(device, thread, ids)

  it('AC-2.1 (031) put answers id, name, kind, size, records a pending upload and calls no provider', () => {
    const { flow, files } = rig()
    const { response, stored } = flow.put('d1', shared, body('nota.txt', 'hola'))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, attachment: { id: 'att-1', name: 'nota.txt', kind: 'text', size: 4 } })
    expect(stored).toEqual({ kind: 'text', size: 4 })
    // the flow's only collaborator that stores is the port: one put, one record, nothing else called
    expect(files.puts).toHaveLength(1)
    expect(files.removes).toEqual([])
    // it is now this device's pending upload for that conversation, and nobody else's
    expect(claim(flow, 'd2', ['att-1'])).toEqual({ ok: false })
    expect(claim(flow, 'd1', ['att-1'], 't1')).toEqual({ ok: false })
    expect(claim(flow, 'd1', ['att-1'])).toEqual({ ok: true, ids: ['att-1'] })
  })

  it('AC-2.9 (031) a sixth pending upload is too-many and nothing is stored', () => {
    const { flow, files } = rig()
    for (let i = 0; i < 5; i++) expect(flow.put('d1', shared, body(`f${i}.txt`)).response.status).toBe(200)
    const sixth = flow.put('d1', shared, body('f5.txt'))
    expect(sixth.response).toEqual(refusalResponse('too-many'))
    expect(sixth.stored).toBeUndefined()
    expect(files.puts).toHaveLength(5)
    // the cap counts every conversation of the device, not one
    expect(flow.put('d1', { shared: false, id: 't1' }, body()).response).toEqual(refusalResponse('too-many'))
  })

  it('AC-2.9 (031) a freed slot works again once the upload is sent', () => {
    const { flow } = rig()
    for (let i = 0; i < 5; i++) flow.put('d1', shared, body(`f${i}.txt`))
    flow.bound('d1', ['att-2'])
    expect(flow.put('d1', shared, body('again.txt')).response.status).toBe(200)
    expect(flow.put('d1', shared, body('more.txt')).response).toEqual(refusalResponse('too-many'))
    // a sent upload is no longer claimable
    expect(claim(flow, 'd1', ['att-2'])).toEqual({ ok: false })
  })

  it("AC-2.9 (031) another device's pending uploads do not count", () => {
    const { flow } = rig()
    for (let i = 0; i < 5; i++) flow.put('d1', shared, body(`f${i}.txt`))
    expect(flow.put('d2', shared, body('mine.txt')).response.status).toBe(200)
    expect(flow.put('d1', shared, body('over.txt')).response).toEqual(refusalResponse('too-many'))
  })

  it('AC-2.9 (031) a refusal from files.put adds nothing to the list', () => {
    const { flow, files } = rig()
    files.refuse = 'file-type'
    for (let i = 0; i < 6; i++) expect(flow.put('d1', shared, body(`f${i}.exe`)).response).toEqual(refusalResponse('file-type'))
    files.refuse = null
    for (let i = 0; i < 5; i++) expect(flow.put('d1', shared, body(`ok${i}.txt`)).response.status).toBe(200)
  })
})

describe('UploadsFlow.remove (spec 031 T24)', () => {
  const shared = { shared: true as const }
  const ok = { status: 200, headers: { 'cache-control': 'no-store' }, body: { ok: true } }

  it('AC-3.2 (031) removing what is not yours deletes nothing and answers the same', () => {
    const { flow, files } = rig()
    flow.put('d2', shared, body('theirs.txt')) // att-1: another device's pending upload
    flow.put('d1', shared, body('sent.txt')) // att-2: this device's, then sent
    flow.bound('d1', ['att-2'])
    const answers = ['att-1', 'att-2', 'att-99', '../x', '', 'x'.repeat(300), 42 as unknown as string].map((id) => flow.remove('d1', id))
    for (const answer of answers) expect(answer).toEqual(ok)
    expect(JSON.stringify(answers[0])).toBe(JSON.stringify(ok))
    expect(files.removes).toEqual([])
    // the other device's upload is still its own to send
    expect(flow.claim('d2', 'remote', ['att-1'])).toEqual({ ok: true, ids: ['att-1'] })
  })

  it('AC-3.2 (031) only a real own pending upload calls files.remove, and answers like the others', () => {
    const { flow, files } = rig()
    flow.put('d1', shared, body('mine.txt'))
    const answer = flow.remove('d1', 'att-1')
    expect(answer).toEqual(ok)
    expect(files.removes).toEqual(['att-1'])
    expect(files.stored.has('att-1')).toBe(false)
    // it is gone from the list: not claimable, and removing it again deletes nothing
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: false })
    expect(flow.remove('d1', 'att-1')).toEqual(ok)
    expect(files.removes).toEqual(['att-1'])
  })

  it('AC-2.9 (031) a freed slot works again once the upload is removed', () => {
    const { flow } = rig()
    for (let i = 0; i < 5; i++) flow.put('d1', shared, body(`f${i}.txt`))
    expect(flow.put('d1', shared, body('x.txt')).response.status).toBe(409)
    flow.remove('d1', 'att-3')
    expect(flow.put('d1', shared, body('x.txt')).response.status).toBe(200)
  })

  it('AC-3.1 (031) a file that cannot be deleted stays pending and the answer is failed, not a false removal', () => {
    const { flow, files } = rig()
    flow.put('d1', shared, body('mine.txt'))
    files.remove = () => {
      throw new Error('EBUSY')
    }
    expect(flow.remove('d1', 'att-1')).toMatchObject({ status: 500, body: { error: 'failed' } })
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: true, ids: ['att-1'] })
  })
})

describe('UploadsFlow: expiry (spec 031 T26)', () => {
  const shared = { shared: true as const }
  const FIFTEEN = 900_000

  it('AC-3.1 (031) a pending upload is deleted 15 minutes after it was put', () => {
    const { flow, files, timers, state } = rig()
    flow.put('d1', shared, body('a.txt'))
    expect(timers.active()).toBe(1)
    state.now = FIFTEEN - 1
    timers.fireDue()
    expect(files.removes).toEqual([])
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: true, ids: ['att-1'] })
    state.now = FIFTEEN
    timers.fireDue()
    expect(files.removes).toEqual(['att-1'])
    expect(files.stored.has('att-1')).toBe(false)
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: false })
    expect(timers.active()).toBe(0)
  })

  it('AC-3.1 (031) the slot of an expired upload is free', () => {
    const { flow, timers, state } = rig()
    for (let i = 0; i < 5; i++) flow.put('d1', shared, body(`f${i}.txt`))
    expect(flow.put('d1', shared, body('x.txt')).response.status).toBe(409)
    state.now = FIFTEEN
    timers.fireDue()
    expect(flow.put('d1', shared, body('x.txt')).response.status).toBe(200)
  })

  it('AC-3.1 (031) a send after expiry is unavailable even if the timer never fired', () => {
    const { flow, files, state } = rig()
    flow.put('d1', shared, body('a.txt'))
    state.now = FIFTEEN
    // no fireDue: the timer was missed
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: false })
    // and the next put sweeps what expired, so neither the cap nor the disk keeps it
    expect(flow.put('d1', shared, body('b.txt')).response.status).toBe(200)
    expect(files.removes).toEqual(['att-1'])
  })

  it('AC-3.1 (031) an upload that was sent or removed has no timer left, and a sent file is never deleted by expiry', () => {
    const { flow, files, timers, state } = rig()
    flow.put('d1', shared, body('a.txt'))
    flow.put('d1', shared, body('b.txt'))
    flow.bound('d1', ['att-1'])
    flow.remove('d1', 'att-2')
    expect(timers.active()).toBe(0)
    state.now = FIFTEEN * 2
    timers.fireDue()
    expect(files.removes).toEqual(['att-2'])
    expect(files.stored.has('att-1')).toBe(true)
  })
})

describe('UploadsFlow: drops keep what was sent (spec 031 T27)', () => {
  const shared = { shared: true as const }

  it('AC-3.1 (031) dropDevice, dropThread and dropAll delete pending uploads and never a sent attachment', () => {
    const { flow, files, timers } = rig()
    flow.put('d1', shared, body('a.txt')) // att-1: sent
    flow.put('d1', shared, body('b.txt')) // att-2: pending
    flow.put('d1', { shared: false, id: 't1' }, body('c.txt')) // att-3: pending, another conversation
    flow.put('d2', shared, body('d.txt')) // att-4: another device
    flow.bound('d1', ['att-1'])
    flow.dropDevice('d1')
    expect(files.removes).toEqual(['att-2', 'att-3'])
    expect(files.stored.has('att-1')).toBe(true)
    expect(files.stored.has('att-4')).toBe(true)
    flow.put('d1', shared, body('e.txt')) // att-5, shared thread
    flow.put('d1', { shared: false, id: 't1' }, body('f.txt')) // att-6
    flow.dropThread('remote')
    expect(files.removes).toEqual(['att-2', 'att-3', 'att-4', 'att-5'])
    flow.dropAll()
    expect(files.removes).toEqual(['att-2', 'att-3', 'att-4', 'att-5', 'att-6'])
    expect([...files.stored.keys()]).toEqual(['att-1'])
    expect(timers.active()).toBe(0)
  })

  it('AC-3.1 (031) a file that cannot be deleted does not stop the others and is no longer pending', () => {
    const { flow, files } = rig()
    flow.put('d1', shared, body('a.txt'))
    flow.put('d1', shared, body('b.txt'))
    const remove = files.remove
    files.remove = (id) => {
      if (id === 'att-1') throw new Error('EBUSY')
      remove(id)
    }
    flow.dropAll()
    expect(files.stored.has('att-2')).toBe(false)
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: false })
  })

  it('AC-3.3 (031) after a restart nothing is pending and the files stay', () => {
    const { flow, files, state } = rig()
    flow.put('d1', shared, body('a.txt'))
    // a restart is a new process: a new flow over the same store, with nothing in memory and nothing deleted
    const restarted = new UploadsFlow({ now: () => state.now, sharedId: () => state.shared, reachable: () => undefined, isRunning: () => false, files, timers: fakeTimers(() => state.now) })
    expect(restarted.claim('d1', 'remote', ['att-1'])).toEqual({ ok: false })
    expect(files.removes).toEqual([])
    expect(files.stored.has('att-1')).toBe(true)
  })
})

describe('the channel purges pending uploads (spec 031 T27)', () => {
  /** Distinct bytes on every call, so two paired devices never share a session token. */
  function varying(): (length: number) => Uint8Array {
    let n = 0
    return (length) => new Uint8Array(length).fill(++n % 256)
  }
  async function served(remote: Partial<RemoteSettings> = {}): Promise<Harness> {
    const base = defaultRemote()
    const t = await testChannel({
      remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true, sendFiles: true, ...remote },
      random: varying()
    })
    await t.channel.sync()
    t.chat.threads.push(makeThread('t1'))
    return t
  }
  const file = (name = 'a.txt') => body(name)
  const put = async (t: Harness, name: string, id?: string) => {
    const response = await t.call(id ? '/api/threads/attach' : '/api/chat/attach', id ? { id, ...file(name) } : file(name))
    expect(response.status, name).toBe(200)
  }
  const purged = (t: Harness, ids: string[]) => {
    expect(t.files.removes).toEqual(ids)
    for (const id of ids) expect(t.files.stored.has(id)).toBe(false)
    expect(t.timers.active()).toBe(0)
  }
  /** A second paired phone, in session. */
  async function other(t: Harness): Promise<{ deviceId: string; headers: Record<string, string> }> {
    await t.phone()
    const { deviceId, privateKey } = await pairDevice(t, 'other')
    const token = await openSession(t, deviceId, privateKey)
    return { deviceId, headers: { host: 'test.invalid', authorization: `Bearer ${token}` } }
  }

  it('AC-3.1 (031) revoke deletes that device\'s pending uploads and only its own', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    await put(t, 'a.txt')
    await put(t, 'b.txt', 't1')
    const second = await other(t)
    const theirs = await t.transport.request({ method: 'POST', path: '/api/chat/attach', headers: second.headers, body: file('c.txt') })
    expect(theirs.status).toBe(200)
    await t.channel.revokeDevice(deviceId)
    expect(t.files.removes).toEqual(['att-1', 'att-2'])
    expect(t.files.stored.has('att-3')).toBe(true)
  })

  it('AC-3.1 (031) forget this PC deletes the device\'s pending uploads', async () => {
    const t = await served()
    await put(t, 'a.txt')
    expect((await t.call('/api/forget')).status).toBe(200)
    purged(t, ['att-1'])
  })

  it('AC-3.1 (031) idle expiry of the device deletes its pending uploads', async () => {
    const t = await served()
    await put(t, 'a.txt')
    t.setNow(16 * 24 * 3_600_000)
    await t.channel.sweepDevices()
    // the 15-minute timer is also due by now; either way the file went once and the slot is free
    expect(t.files.removes).toEqual(['att-1'])
    expect(t.files.stored.size).toBe(0)
  })

  it('AC-3.1 (031) turning remote access off deletes every pending upload', async () => {
    const t = await served()
    await put(t, 'a.txt')
    await put(t, 'b.txt', 't1')
    await t.channel.stop()
    purged(t, ['att-1', 'att-2'])
  })

  it('AC-3.1 (031) the tray kill switch (remote disabled in the settings) deletes every pending upload', async () => {
    const t = await served()
    await put(t, 'a.txt')
    t.setRemote({ enabled: false })
    await t.channel.sync()
    purged(t, ['att-1'])
  })

  it('AC-3.1 (031) turning Send files off deletes every pending upload, and the gate then refuses new ones', async () => {
    const t = await served()
    await put(t, 'a.txt')
    await put(t, 'b.txt', 't1')
    t.setRemote({ sendFiles: false })
    await t.channel.sync()
    purged(t, ['att-1', 'att-2'])
    expect((await t.call('/api/chat/attach', file())).status).toBe(403)
  })

  it('AC-3.1 (031) turning Chat off deletes every pending upload', async () => {
    const t = await served()
    await put(t, 'a.txt')
    // the settings file would read Send files off too (AC-1.3); the purge must not depend on that
    t.setRemote({ scopes: { ...defaultRemote().scopes, chat: false, history: true } })
    await t.channel.sync()
    purged(t, ['att-1'])
  })

  it('AC-3.1 (031) New conversation deletes only the uploads of the thread it replaces', async () => {
    const t = await served()
    await put(t, 'a.txt') // the shared thread
    await put(t, 'b.txt', 'remote') // the same thread, by id
    await put(t, 'c.txt', 't1') // another conversation
    expect((await t.call('/api/chat/new', {})).status).toBe(200)
    expect(t.files.removes).toEqual(['att-1', 'att-2'])
    expect(t.files.stored.has('att-3')).toBe(true)
    // the new shared thread starts clean: a put goes to it
    await put(t, 'd.txt')
    expect(t.files.puts.at(-1)?.threadId).toBe(t.chat.threads.at(-1)?.id)
    expect(t.files.puts.at(-1)?.threadId).not.toBe('remote')
  })

  it('AC-3.1 (031) turning History or continue off keeps by-id uploads until they expire (G10, provisional)', async () => {
    const t = await served()
    await put(t, 'a.txt', 't1')
    t.setRemote({ continueHistory: false })
    await t.channel.sync()
    t.setRemote({ scopes: { ...defaultRemote().scopes, chat: true, history: false } })
    await t.channel.sync()
    expect(t.files.removes).toEqual([])
    expect(t.timers.active()).toBe(1)
    t.setNow(900_000)
    t.timers.fireDue()
    purged(t, ['att-1'])
  })
})

describe('"Borrar mi historial" and pending uploads (spec 031 T35)', () => {
  it('AC-3.4 (031) erase deletes the pending uploads of every device, and a sent attachment is left to the store erase', async () => {
    const base = defaultRemote()
    const t = await testChannel({ remote: { ...base, enabled: true, scopes: { ...base.scopes, chat: true }, sendFiles: true } })
    await t.channel.sync()
    const put = async (name: string) => (await t.call('/api/chat/attach', body(name))).status
    expect(await put('a.txt')).toBe(200)
    expect(await put('b.txt')).toBe(200)
    expect(t.timers.active()).toBe(2)
    expect(await t.channel.erase()).toEqual({ devices: 1 })
    expect(t.files.removes).toEqual(['att-1', 'att-2'])
    expect(t.files.stored.size).toBe(0)
    expect(t.timers.active()).toBe(0)
  })
})

describe('UploadsFlow.claimForSend: the one claim and blank-text rule of both sends (spec 031 AC-4.1, AC-4.2, AC-4.4)', () => {
  const shared = { shared: true as const }

  it('AC-4.4 (031) a blank text with no upload is invalid; with a bound upload it is accepted', () => {
    const { flow } = rig()
    flow.put('d1', shared, body('a.txt'))
    for (const blank of ['', '   \n']) expect(flow.claimForSend('d1', 'remote', undefined, blank)).toEqual({ ok: false, reason: 'invalid' })
    expect(flow.claimForSend('d1', 'remote', [], '')).toEqual({ ok: false, reason: 'invalid' })
    expect(flow.claimForSend('d1', 'remote', ['att-1'], '')).toEqual({ ok: true, ids: ['att-1'] })
  })

  it('AC-4.1 (031) a text-only send claims nothing and carries no ids at all', () => {
    const { flow } = rig()
    expect(flow.claimForSend('d1', 'remote', undefined, 'hola')).toEqual({ ok: true, ids: undefined })
    expect(flow.claimForSend('d1', 'remote', [], 'hola')).toEqual({ ok: true, ids: undefined })
  })

  it('AC-4.2 (031) a bad id refuses the whole send as unavailable, whatever the text', () => {
    const { flow } = rig()
    flow.put('d1', shared, body('a.txt'))
    expect(flow.claimForSend('d2', 'remote', ['att-1'], 'hola')).toEqual({ ok: false, reason: 'unavailable' })
    expect(flow.claimForSend('d1', 'remote', ['att-1', 'att-9'], '')).toEqual({ ok: false, reason: 'unavailable' })
    expect(flow.claimForSend('d1', 'remote', ['att-1'], 'hola')).toEqual({ ok: true, ids: ['att-1'] })
  })

  it('AC-4.3 (031) a provider owed the notice refuses the send as notice-needed', () => {
    const { flow, files } = rig()
    flow.put('d1', shared, body('a.txt'))
    files.owed = ['meta']
    expect(flow.claimForSend('d1', 'remote', ['att-1'], 'hola')).toEqual({ ok: false, reason: 'notice-needed' })
  })
})

describe('UploadsFlow: a file that cannot be deleted is recorded, without naming it (spec 031 AC-3.1, AC-7.2)', () => {
  it('AC-3.1 (031) a purge that cannot delete a file reports it to the sink and still stops tracking the upload', () => {
    const { flow, files, state } = rig()
    flow.put('d1', { shared: true }, body('a.txt'))
    files.remove = () => {
      throw new Error('EBUSY')
    }
    flow.dropAll()
    expect(state.leftover).toBe(1)
    expect(flow.claim('d1', 'remote', ['att-1'])).toEqual({ ok: false })
  })
})
