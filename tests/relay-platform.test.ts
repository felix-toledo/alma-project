import { describe, expect, it } from 'vitest'
import { answerFor, infoAnswer, toResponse } from '../src/relay/answer'
import { parseAttachment } from '../src/relay/attachment'
import { declaredBytes, readFrameBody } from '../src/relay/body'
import { createCounters } from '../src/relay/counters'
import { answerGate, remoteAddressLimits } from '../src/relay/gate'
import { RelayRoom } from '../src/relay/room'
import { isPaused, planFor, requestLine, routeOf } from '../src/relay/route'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { FakePc, random } from './support/relay-fake'

// The platform adapter is thin glue; what it decides lives in these pure parts (spec 027 T31).
const ID = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 26)
const host = `${ID}.relay.test`
const at = (path: string, extra: Partial<{ host: string; method: string; upgrade: boolean }> = {}) => ({ host, method: 'GET', path, upgrade: false, ...extra })

describe('relay routing by host and path (spec 027 PD-2, PD-6)', () => {
  it('AC-5.1 the first label of the host is the routing id and the path says what the request is', () => {
    expect(routeOf(at('/relay/v1/pc', { upgrade: true }))).toEqual({ kind: 'pc', id: ID })
    expect(routeOf(at('/relay/v1/frame', { method: 'POST' }))).toEqual({ kind: 'frame', id: ID })
    expect(routeOf(at('/relay/v1/info'))).toEqual({ kind: 'info', id: ID })
    expect(routeOf(at('/'))).toEqual({ kind: 'assets' })
    expect(routeOf(at('/assets/index-abc.js', { method: 'HEAD' }))).toEqual({ kind: 'assets' })
    expect(routeOf(at('/shell-manifest.json'))).toEqual({ kind: 'assets' })
  })

  it('AC-5.1 host names are matched without case and without a port', () => {
    expect(routeOf(at('/relay/v1/info', { host: `${ID.toUpperCase()}.Relay.Test:443` }))).toEqual({ kind: 'info', id: ID })
  })

  it('AC-5.4 a host that is not a routing id answers not found, for every path, so nothing is revealed about ids', () => {
    for (const bad of ['relay.test', 'localhost', `${ID.slice(1)}.relay.test`, `${ID}a.relay.test`, `${ID.replace('a', '1')}.relay.test`, `${ID.replace('a', '-')}.relay.test`, '', `.relay.test`]) {
      for (const path of ['/', '/relay/v1/info', '/relay/v1/frame']) {
        expect(routeOf(at(path, { host: bad, method: path.endsWith('frame') ? 'POST' : 'GET' })), `${bad} ${path}`).toEqual({ kind: 'not-found' })
      }
    }
  })

  it('AC-5.5 only the exact method and path of each relay route are served; the rest of /relay is not found', () => {
    expect(routeOf(at('/relay/v1/pc'))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/v1/pc', { method: 'POST', upgrade: true }))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/v1/frame'))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/v1/frame', { method: 'PUT' }))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/v1/info', { method: 'POST' }))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/v1/frame/', { method: 'POST' }))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/v2/frame', { method: 'POST' }))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/relay/'))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/', { method: 'POST' }))).toEqual({ kind: 'not-found' })
    expect(routeOf(at('/api/session', { method: 'DELETE' }))).toEqual({ kind: 'not-found' })
  })

  it('AC-5.5 the paths are the ones the phone client calls', () => {
    // The client posts to FRAME_PATH and asks http.ts for /relay/v1/info; the PC dials /relay/v1/pc.
    expect(routeOf(at('/relay/v1/frame', { method: 'POST' })).kind).toBe('frame')
    expect(routeOf(at('/relay/v1/info')).kind).toBe('info')
  })
})

describe('what the Worker does with a request (spec 027 PD-6, PD-7)', () => {
  it('AC-5.5 /relay/v1/info is answered by the Worker itself, without waking a room', () => {
    const plan = planFor(at('/relay/v1/info'), false)
    expect(plan).toEqual({ to: 'answer', answer: infoAnswer() })
    expect(infoAnswer()).toMatchObject({ status: 200, body: '{"relay":true,"v":1}', headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  })

  it('AC-5.1 the frame and the PC socket go to the room of the id; the shell comes from the assets', () => {
    expect(planFor(at('/relay/v1/frame', { method: 'POST' }), false)).toEqual({ to: 'room', id: ID })
    expect(planFor(at('/relay/v1/pc', { upgrade: true }), false)).toEqual({ to: 'room', id: ID })
    expect(planFor(at('/'), false)).toEqual({ to: 'assets' })
  })

  it('AC-5.4 anything else is the same not found, with no room and no assets involved', () => {
    expect(planFor(at('/relay/v1/frame'), false)).toMatchObject({ to: 'answer', answer: { status: 404, body: '{"error":"not-found"}' } })
    expect(planFor(at('/', { host: 'relay.test' }), false)).toMatchObject({ to: 'answer', answer: { status: 404 } })
  })

  it('AC-5.10 the emergency stop answers full for a phone frame before any room is woken, and leaves the shell, the info and the PC socket (refused by the room) alone', () => {
    expect(planFor(at('/relay/v1/frame', { method: 'POST' }), true)).toMatchObject({ to: 'answer', answer: { status: 429, body: '{"error":"full"}' } })
    expect(planFor(at('/relay/v1/pc', { upgrade: true }), true)).toEqual({ to: 'room', id: ID })
    expect(planFor(at('/relay/v1/info'), true)).toEqual({ to: 'answer', answer: infoAnswer() })
    expect(planFor(at('/'), true)).toEqual({ to: 'assets' })
  })

  it('AC-5.10 RELAY_PAUSED turns the stop on for 1 and true, and for nothing else', () => {
    expect([isPaused('1'), isPaused('true'), isPaused('TRUE')]).toEqual([true, true, true])
    expect([isPaused(undefined), isPaused(''), isPaused('0'), isPaused('false'), isPaused('no')]).toEqual([false, false, false, false, false])
  })
})

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  let next = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[next++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    }
  })
}
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('reading a phone frame with a bound (spec 027 BR-28)', () => {
  it('AC-5.5 a JSON body comes back parsed with its size in bytes, however it was chunked', async () => {
    const body = JSON.stringify({ t: 'q', note: 'año' })
    const bytes = utf8(body)
    expect(await readFrameBody(streamOf(bytes), 1000)).toEqual({ raw: { t: 'q', note: 'año' }, bytes: bytes.length })
    expect(await readFrameBody(streamOf(bytes.slice(0, 15), bytes.slice(15)), 1000)).toEqual({ raw: { t: 'q', note: 'año' }, bytes: bytes.length })
  })

  it('AC-5.5 a body that is not JSON, or no body, has no frame and the room answers malformed', async () => {
    expect(await readFrameBody(streamOf(utf8('{nope')), 1000)).toEqual({ raw: undefined, bytes: 5 })
    expect(await readFrameBody(null, 1000)).toEqual({ raw: undefined, bytes: 0 })
    expect(await readFrameBody(streamOf(), 1000)).toEqual({ raw: undefined, bytes: 0 })
  })

  it('AC-5.3 a body over the cap is not read to the end: the count says it is over and the stream is cancelled', async () => {
    let cancelled = false
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(100).fill(97))
      },
      cancel() {
        cancelled = true
      }
    })
    const read = await readFrameBody(endless, 250)
    expect(read.raw).toBeUndefined()
    expect(read.bytes).toBeGreaterThan(250)
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThan(10)
  })

  it('AC-5.3 a declared size over the cap is believed without reading anything', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull() {
        pulled++
      }
    })
    const read = await readFrameBody(body, 250, 9_999)
    expect(read).toEqual({ raw: undefined, bytes: 9_999 })
    expect(pulled).toBe(0)
  })

  it('AC-5.3 a body exactly at the cap is read whole', async () => {
    const filler = 'x'.repeat(40)
    const body = JSON.stringify({ a: filler })
    const bytes = utf8(body)
    expect(await readFrameBody(streamOf(bytes), bytes.length)).toEqual({ raw: { a: filler }, bytes: bytes.length })
    expect((await readFrameBody(streamOf(bytes), bytes.length - 1)).raw).toBeUndefined()
  })
})

describe('the per-address limits kept in one shared place (spec 027 BR-28, PD-6)', () => {
  const clock = { t: 5_000_000 }
  const now = (): number => clock.t

  it('AC-5.3 the shared object counts attempts and unknown-id misses with the same rules as a room that keeps them itself', () => {
    const gate = answerGate(REMOTE_RELAY_LIMITS, now)
    for (let i = 0; i < REMOTE_RELAY_LIMITS.attemptsPerMinutePerAddress; i++) expect(gate({ op: 'attempt', address: 'a' })).toBe(true)
    expect(gate({ op: 'attempt', address: 'a' })).toBe(false)
    expect(gate({ op: 'attempt', address: 'b' })).toBe(true)
    for (let i = 0; i < REMOTE_RELAY_LIMITS.unknownIdPerMinute; i++) expect(gate({ op: 'miss', address: 'c' })).toBe(true)
    expect(gate({ op: 'miss', address: 'c' })).toBe(false)
    expect(gate({ op: 'attempt', address: 'c' })).toBe(false)
    clock.t += REMOTE_RELAY_LIMITS.unknownIdBackoffMs
    expect(gate({ op: 'attempt', address: 'c' })).toBe(true)
  })

  it('AC-5.3 a call that is not an attempt or a miss for an address gets no verdict, and counts for nobody', () => {
    const gate = answerGate(REMOTE_RELAY_LIMITS, now)
    expect(gate({ op: 'reset', address: 'a' })).toBeUndefined()
    expect(gate({ op: 'attempt' })).toBeUndefined()
    expect(gate({ op: 'attempt', address: '' })).toBeUndefined()
    expect(gate({ op: 'attempt', address: 7 })).toBeUndefined()
    expect(gate('attempt')).toBeUndefined()
    expect(gate(null)).toBeUndefined()
  })

  it('AC-5.3 a room asks the shared object through one call, and when it cannot be reached the answer is no', async () => {
    const calls: Array<[string, string]> = []
    const reachable = remoteAddressLimits(async (op, address) => {
      calls.push([op, address])
      return op === 'attempt'
    })
    expect(await reachable.attempt('a')).toBe(true)
    expect(await reachable.miss('a')).toBe(false)
    expect(calls).toEqual([
      ['attempt', 'a'],
      ['miss', 'a']
    ])
    const down = remoteAddressLimits(async () => {
      throw new Error('unreachable')
    })
    expect(await down.attempt('a')).toBe(false)
    expect(await down.miss('a')).toBe(false)
  })
})

describe('a room that wakes with a socket that never proved a key (spec 027 PD-6)', () => {
  it('AC-5.3 such a socket is closed as refused and counted, and the room stays offline', () => {
    const counters = createCounters()
    const room = new RelayRoom({ routingId: ID, random, counters })
    const orphan = new FakePc()
    room.restorePc(orphan, null)
    expect(orphan.closed).toBe(4001)
    expect(room.online).toBe(false)
    expect(counters.snapshot().refusals.registration).toBe(1)
  })
})

describe('the small translations the adapter needs (spec 027 T31)', () => {
  it('AC-5.5 a request becomes the line the routing reads: host, method, path without the query, and whether it asks for a WebSocket', () => {
    const socket = new Request(`https://${host}/relay/v1/pc?x=1`, { headers: { upgrade: 'WebSocket' } })
    expect(requestLine(socket)).toEqual({ host, method: 'GET', path: '/relay/v1/pc', upgrade: true })
    const frame = new Request(`https://${host}/relay/v1/frame`, { method: 'POST', body: '{}' })
    expect(requestLine(frame)).toEqual({ host, method: 'POST', path: '/relay/v1/frame', upgrade: false })
    expect(requestLine(new Request(`https://${host}/`, { headers: { upgrade: 'h2c' } })).upgrade).toBe(false)
  })

  it('AC-5.5 an answer of the relay becomes a response with its status, body and headers', async () => {
    const response = toResponse(answerFor('offline'))
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('{"error":"offline"}')
  })

  it('AC-5.3 the size a request announces is read from content-length when it is a plain count, and from nothing else', () => {
    expect(declaredBytes('1234')).toBe(1234)
    expect(declaredBytes('0')).toBe(0)
    for (const odd of [null, '', 'abc', '-5', '1e9', '12.5', ' 7 ']) expect(declaredBytes(odd), String(odd)).toBeUndefined()
  })

  it('AC-6.1 what a socket keeps through a sleep is its id and the hash of its key, and anything else is nothing', () => {
    expect(parseAttachment({ id: ID, keyHash: 'abc' })).toEqual({ id: ID, keyHash: 'abc' })
    expect(parseAttachment({ id: ID, keyHash: null })).toEqual({ id: ID, keyHash: null })
    for (const bad of [null, undefined, 'x', 7, {}, { id: ID }, { id: 'short', keyHash: null }, { id: ID, keyHash: 5 }, { id: ID, keyHash: 'abc', extra: 1 }]) {
      expect(parseAttachment(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
