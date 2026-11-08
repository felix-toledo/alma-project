import { describe, expect, it, vi } from 'vitest'
import type { RemoteResponse } from '../src/shared/remote/api'
import { REMOTE_LIMITS } from '../src/shared/remote/api'
import { defaultRemote } from '../src/shared/remote/settings'
import { HOST, makeThread, openSession, pairDevice, testChannel, type Harness } from './support/remote-harness'

function varying(): (length: number) => Uint8Array {
  let n = 0
  return (length) => new Uint8Array(length).fill(++n % 256)
}

async function served(): Promise<Harness> {
  const scopes = { ...defaultRemote().scopes, chat: true, history: true }
  const t = await testChannel({ remote: { ...defaultRemote(), enabled: true, scopes, continueHistory: true }, random: varying() })
  await t.channel.sync()
  t.chat.seed([{ role: 'user', content: [{ type: 'text', text: 'hola' }], ts: 1 }])
  const talk = makeThread('talk')
  talk.messages.push({ role: 'user', content: [{ type: 'text', text: 'antes' }], ts: 1 })
  t.chat.threads.push(talk)
  return t
}

async function phone(t: Harness, name: string): Promise<Record<string, string>> {
  const { deviceId, privateKey } = await pairDevice(t, name)
  return { ...HOST, authorization: `Bearer ${await openSession(t, deviceId, privateKey)}` }
}

/** The Chat tab's held poll (rev 1 is the shared thread's current one). */
const statePoll = (t: Harness, headers: Record<string, string>, signal?: AbortSignal): Promise<RemoteResponse> =>
  t.transport.request({ method: 'GET', path: '/api/state', query: 'since=1', headers, signal })

/** A followed conversation's held read. */
const follow = (t: Harness, headers: Record<string, string>, id = 'talk', signal?: AbortSignal): Promise<RemoteResponse> =>
  t.transport.request({ method: 'POST', path: '/api/threads/read', headers, body: { id, since: 1, wait: true }, signal })

const drain = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('held long polls per device (spec 026 AC-10.3)', () => {
  it('AC-10.3 two held long polls are served and a third is refused as rate-limited', async () => {
    const t = await served()
    const headers = await phone(t, 'one')
    const gone = new AbortController()
    void statePoll(t, headers, gone.signal)
    void follow(t, headers, 'talk', gone.signal)
    await drain()
    expect(await follow(t, headers)).toMatchObject({ status: 429, body: { error: 'rate-limited' } })
    expect(await statePoll(t, headers)).toMatchObject({ status: 429, body: { error: 'rate-limited' } })
    gone.abort()
  })

  it('AC-10.3 a long poll that ends, answers its timeout or is aborted frees its slot', async () => {
    vi.useFakeTimers()
    try {
      const t = await served()
      const headers = await phone(t, 'one')
      const aborter = new AbortController()
      const kept = statePoll(t, headers)
      const aborted = follow(t, headers, 'talk', aborter.signal)
      await drain()
      expect((await statePoll(t, headers)).status).toBe(429)
      aborter.abort()
      await aborted
      const replacement = follow(t, headers)
      await drain()
      expect((await follow(t, headers)).status).toBe(429)
      await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.longPollMs)
      expect((await kept).status).toBe(200)
      expect((await replacement).status).toBe(200)
      const fresh = [statePoll(t, headers), follow(t, headers)]
      await drain()
      expect((await statePoll(t, headers)).status).toBe(429)
      await vi.advanceTimersByTimeAsync(REMOTE_LIMITS.longPollMs)
      expect((await Promise.all(fresh)).map((r) => r.status)).toEqual([200, 200])
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-10.3 another device is unaffected by a device holding two', async () => {
    const t = await served()
    const one = await phone(t, 'one')
    const other = await phone(t, 'two')
    const gone = new AbortController()
    void statePoll(t, one, gone.signal)
    void follow(t, one, 'talk', gone.signal)
    await drain()
    expect((await statePoll(t, one)).status).toBe(429)
    void statePoll(t, other, gone.signal)
    void follow(t, other, 'talk', gone.signal)
    await drain()
    expect((await follow(t, other)).status).toBe(429)
    gone.abort()
  })

  it('AC-10.3 short requests are never counted: the normal PWA pattern is never refused', async () => {
    const t = await served()
    const headers = await phone(t, 'one')
    const gone = new AbortController()
    void statePoll(t, headers, gone.signal)
    void follow(t, headers, 'talk', gone.signal)
    await drain()
    const short: Promise<RemoteResponse>[] = []
    for (let i = 0; i < 6; i++) {
      short.push(t.transport.request({ method: 'GET', path: '/api/status', headers }))
      short.push(t.transport.request({ method: 'POST', path: '/api/threads/read', headers, body: { id: 'talk' } }))
      short.push(t.transport.request({ method: 'GET', path: '/api/state', headers }))
    }
    short.push(t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: 'hola' } }))
    expect((await Promise.all(short)).map((r) => r.status)).toEqual(Array(19).fill(200))
    gone.abort()
  })
})
