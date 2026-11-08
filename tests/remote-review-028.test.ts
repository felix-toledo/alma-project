import { mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NotesFlow, TREE_TTL_MS } from '../src/coordinator/channels/remote/notes'
import { defaultSettings } from '../src/shared/defaults'
import { fakeVault } from './support/remote-harness'
import { validateChatInput } from '../src/remote-client/lib/chat'
import { chatSendBody, threadsSendBody } from '../src/shared/remote/api'
import { clearOwnNote, mergeState, nextSince, type PwaState } from '../src/remote-client/lib/poll'
import { TailscaleTransport } from '../src/coordinator/channels/remote/tailscale-transport'
import { singleFlight } from '../src/remote-client/lib/session'
import { defaultRemote } from '../src/shared/remote/settings'
import { threadPage } from '../src/coordinator/channels/remote/thread-view'
import type { ChatMessage } from '../src/shared/types'
import { makeThread, testChannel, type Harness } from './support/remote-harness'

const drain = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const said = (value: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: value }], ts: 1 })

async function served(patch: Partial<ReturnType<typeof defaultRemote>> = {}): Promise<Harness> {
  const scopes = { ...defaultRemote().scopes, history: true, chat: true }
  const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true, ...patch } })
  await t.channel.sync()
  const thread = makeThread('talk')
  thread.messages.push(said('secret'))
  t.chat.threads.push(thread)
  await t.phone()
  return t
}

describe('quality review of spec 028', () => {
  it('concurrent token renewals share one request', async () => {
    let calls = 0
    let release: (value: string) => void = () => undefined
    const renew = singleFlight(() => {
      calls++
      return new Promise<string>((resolve) => {
        release = resolve
      })
    })
    const all = [renew(), renew(), renew(), renew()]
    release('token')
    expect(await Promise.all(all)).toEqual(['token', 'token', 'token', 'token'])
    expect(calls).toBe(1)
    const next = renew()
    release('again')
    expect(await next).toBe('again')
    expect(calls).toBe(2)
  })

  it('a failed renewal does not stick: the next call starts a new one', async () => {
    let calls = 0
    const renew = singleFlight(async () => {
      calls++
      if (calls === 1) throw new Error('boom')
      return 'ok'
    })
    await expect(renew()).rejects.toThrow('boom')
    expect(await renew()).toBe('ok')
  })

  it('a held threads read answers the refusal, not content, when History is turned off', async () => {
    const t = await served()
    const held = t.call('/api/threads/read', { id: 'talk', since: 1, wait: true })
    await drain()
    t.setRemote({ scopes: { ...defaultRemote().scopes, history: false } })
    await t.channel.sync()
    expect(await held).toMatchObject({ status: 403, body: { error: 'scope-off' } })
  })

  it('a held read answers unknown-device when the device is revoked', async () => {
    const t = await served()
    const { deviceId } = await t.phone()
    const held = t.call('/api/threads/read', { id: 'talk', since: 1, wait: true })
    await drain()
    await t.channel.revokeDevice(deviceId)
    expect(await held).toMatchObject({ status: 401, body: { error: 'unknown-device' } })
  })

  it('a held chat poll answers unknown-device when the device forgets the PC', async () => {
    const t = await served()
    const { headers } = await t.phone()
    const held = t.transport.request({ method: 'GET', path: '/api/state', query: 'since=0', headers })
    await drain()
    expect((await t.call('/api/forget', {})).status).toBe(200)
    expect(await held).toMatchObject({ status: 401, body: { error: 'unknown-device' } })
  })

  it('two syncs racing the transport start open one listener', async () => {
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true } })
    await Promise.all([t.channel.sync(), t.channel.sync(), t.channel.sync()])
    expect(t.transport.startedCount).toBe(1)
    expect(t.channel.currentStatus().state).toBe('online')
  })

  it('a sweep that throws leaves the channel off and the next sync starts clean', async () => {
    const t = await testChannel({ remote: { ...defaultRemote(), enabled: true } })
    vi.spyOn(t.store, 'devices').mockImplementationOnce(() => {
      throw new Error('disk')
    })
    await t.channel.sync()
    expect(t.channel.currentStatus().state).toBe('error')
    await t.channel.sync()
    expect(t.channel.currentStatus().state).toBe('online')
  })

  it('an abandoned long poll aborts the handler signal over real HTTP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alma-pwa-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
    let seen: AbortSignal | null = null
    let entered: () => void = () => undefined
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const transport = new TailscaleTransport({ port: 0, assetsDir: dir, dnsName: 'alma-pc.tail0000.ts.net.' })
    await transport.start(async (_request, signal) => {
      seen = signal
      entered()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      return { status: 200 }
    })
    try {
      const request = http.request({ host: '127.0.0.1', port: transport.localPort() ?? 0, method: 'POST', path: '/api/chat/send', headers: { host: 'alma-pc.tail0000.ts.net' } })
      request.on('error', () => undefined)
      request.end('{}')
      await reached
      request.destroy()
      await vi.waitFor(() => expect((seen as AbortSignal | null)?.aborted).toBe(true), { timeout: 2000 })
    } finally {
      await transport.stop()
    }
  })

  it('an aborted request releases its held threads read and its held chat poll', async () => {
    const t = await served()
    const { headers } = await t.phone()
    const gone = new AbortController()
    let answered = 0
    const body = { id: 'talk', since: 1, wait: true }
    void t.transport.request({ method: 'POST', path: '/api/threads/read', headers, body, signal: gone.signal }).then(() => answered++)
    void t.transport.request({ method: 'GET', path: '/api/state', query: 'since=0', headers, signal: gone.signal }).then(() => answered++)
    await drain()
    expect(answered).toBe(0)
    gone.abort()
    await drain()
    expect(answered).toBe(2)
  })

  it('a recovered poll clears the note it set, and only that one', () => {
    expect(clearOwnNote('remote.pwa.pcUnreachable', 'remote.pwa.pcUnreachable')).toBeNull()
    expect(clearOwnNote('remote.pwa.alreadyAnswered', 'remote.pwa.pcUnreachable')).toBe('remote.pwa.alreadyAnswered')
    expect(clearOwnNote('remote.pwa.pcUnreachable', null)).toBe('remote.pwa.pcUnreachable')
    expect(clearOwnNote(null, 'remote.pwa.rateLimited')).toBeNull()
  })

  it('a capped since delta keeps the oldest messages and a cursor that makes the phone fetch the rest', () => {
    const big = 'x'.repeat(400_000)
    const raw: ChatMessage[] = [said('seen'), ...['a', 'b', 'c', 'd'].map((tag) => said(tag + big))]
    const envelope = (kept: unknown): unknown => ({ messages: kept })
    const heard: number[] = []
    let since = 1
    for (let round = 0; round < 10 && since < raw.length; round++) {
      const page = threadPage(raw, { since }, envelope)
      expect(Buffer.byteLength(JSON.stringify(envelope(page.messages)))).toBeLessThanOrEqual(1_048_576)
      heard.push(...page.messages.map((m) => m.index))
      expect(page.rev).toBeGreaterThan(since)
      since = page.rev
    }
    expect(heard).toEqual([1, 2, 3, 4])
  })

  it('AC-8.7 a different conversation id resets the merge even when its rev is higher', () => {
    const msg = (index: number, text: string) => ({ index, role: 'user', text, at: 1 })
    const old: PwaState = { rev: 3, running: false, messages: [msg(0, 'a'), msg(1, 'b'), msg(2, 'c')], approvals: [], threadId: 'remote' }
    const fresh: PwaState = { rev: 5, running: false, messages: [msg(4, 'new')], approvals: [], threadId: 'remote-2' }
    expect(mergeState(old, fresh)).toEqual(fresh)
    expect(nextSince(old, fresh)).toBeNull()
    const same: PwaState = { ...fresh, threadId: 'remote' }
    expect(mergeState(old, same).messages.map((m) => m.text)).toEqual(['a', 'b', 'c', 'new'])
    expect(nextSince(old, same)).toBe(5)
  })

  it('the chat state names the shared thread, so a replaced one is told apart', async () => {
    const t = await served()
    const { headers } = await t.phone()
    const first = (await t.transport.request({ method: 'GET', path: '/api/state', headers })).body as { threadId?: string }
    await t.call('/api/chat/new', {})
    const second = (await t.transport.request({ method: 'GET', path: '/api/state', headers })).body as { threadId?: string }
    expect(first.threadId).toBe('remote')
    expect(second.threadId).not.toBe(first.threadId)
  })

  describe('notes tree cache', () => {
    function flow(): { notes: NotesFlow; vault: ReturnType<typeof fakeVault>; clock: { now: number } } {
      const vault = fakeVault()
      vault.put('a.md', 'a')
      vault.put('img/p.png', new Uint8Array([1]))
      const clock = { now: 1000 }
      const notes = new NotesFlow({ vault: () => vault, settings: () => defaultSettings(), now: () => clock.now })
      return { notes, vault, clock }
    }

    it('a note with ten images walks the tree once, then again after the TTL', async () => {
      const { notes, vault, clock } = flow()
      for (let i = 0; i < 11; i++) await notes.image('img/p.png', '')
      expect(vault.reads.tree).toBe(1)
      clock.now += TREE_TTL_MS - 1
      await notes.read('a.md')
      expect(vault.reads.tree).toBe(1)
      clock.now += 1
      await notes.read('a.md')
      expect(vault.reads.tree).toBe(2)
    })

    it('a vault change or a closed vault never serves the cached tree', async () => {
      const { notes, vault } = flow()
      await notes.list('')
      vault.put('b.md', 'b')
      notes.invalidate()
      expect(JSON.stringify(await notes.list(''))).toContain('b.md')
      vault.active = 'none'
      expect(await notes.list('')).toMatchObject({ body: { vault: 'none' } })
      vault.active = 'ready'
      await notes.list('')
      expect(vault.reads.tree).toBe(3)
    })
  })

  describe('conversation read audit (BR-30)', () => {
    const reads = (t: Harness): number => t.records.filter((entry) => entry.action === 'remote.threads.read').length

    it('an open audits, a follow past the served length does not, any other since does', async () => {
      const t = await served()
      await t.call('/api/threads/read', { id: 'talk' })
      expect(reads(t)).toBe(1)
      await t.call('/api/threads/read', { id: 'talk', since: 1 })
      expect(reads(t)).toBe(1)
      await t.call('/api/threads/read', { id: 'talk', since: 0 })
      expect(reads(t)).toBe(2)
      await t.call('/api/threads/read', { id: 'talk', before: 1 })
      expect(reads(t)).toBe(3)
    })

    it('a since without an earlier open audits when it answers messages, and stays silent when it answers none', async () => {
      const t = await served()
      await t.call('/api/threads/read', { id: 'talk', since: 1 })
      expect(reads(t)).toBe(0)
      await t.call('/api/threads/read', { id: 'talk', since: 0 })
      expect(reads(t)).toBe(1)
    })

    it('new messages after an open are followed unaudited, but only from the length already served', async () => {
      const t = await served()
      await t.call('/api/threads/read', { id: 'talk' })
      t.chat.threads.find((thread) => thread.id === 'talk')?.messages.push(said('later'))
      const delta = (await t.call('/api/threads/read', { id: 'talk', since: 1 })).body as { messages: { text: string }[]; rev: number }
      expect(delta.messages.map((m) => m.text)).toEqual(['later'])
      expect(reads(t)).toBe(1)
      await t.call('/api/threads/read', { id: 'talk', since: 2 })
      expect(reads(t)).toBe(1)
      await t.call('/api/threads/read', { id: 'talk', since: 1 })
      expect(reads(t)).toBe(2)
    })
  })

  it('the server refuses a blank or whitespace-only message with the same 400 invalid and starts no run', async () => {
    const t = await served()
    for (const text of ['', '   ', '\n\t \u00a0']) {
      expect(await t.call('/api/chat/send', { text }), JSON.stringify(text)).toMatchObject({ status: 400, body: { error: 'invalid' } })
      expect(await t.call('/api/threads/send', { id: 'talk', text })).toMatchObject({ status: 400, body: { error: 'invalid' } })
    }
    expect(t.chat.askCalls).toEqual([])
  })

  it('the phone and the server agree on blank and on length (same UTF-16 count)', () => {
    for (const text of ['', ' ', 'a', 'a'.repeat(8000), 'a'.repeat(8001), '😀'.repeat(4000), '😀'.repeat(4001), ' a ']) {
      const phone = validateChatInput(text).ok
      expect(chatSendBody.safeParse({ text }).success, JSON.stringify(text.slice(0, 5))).toBe(phone)
      expect(threadsSendBody.safeParse({ id: 'talk', text }).success).toBe(phone)
    }
  })
})
