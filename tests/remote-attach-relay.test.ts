import { describe, expect, it } from 'vitest'
import { PHONE_ATTACH } from '../src/shared/attach/phone'
import { REMOTE_LIMITS } from '../src/shared/remote/api'
import { REMOTE_RELAY_LIMITS } from '../src/shared/remote/relay-limits'
import { defaultRemote } from '../src/shared/remote/settings'
import { makeThread } from './support/remote-harness'
import { mentions } from './support/relay-fake'
import { onThePair, served } from './support/relay-served'

const NAME_MARKER = 'MARKER-RELAY-NAME-0005.txt'
const CONTENT_MARKER = 'MARKER-RELAY-CONTENT-0006'
const TEXT_MARKER = 'MARKER-RELAY-TEXT-0007'

describe('a file crosses the sealed relay (spec 031 T38)', () => {
  it('AC-7.5 (031) a put and a send cross the sealed relay and nothing else is contacted', async () => {
    await onThePair(async () => {
      const base = defaultRemote()
      const { t, pair, headers } = await served({ scopes: { ...base.scopes, chat: true, history: true }, continueHistory: true, sendFiles: true })
      t.chat.threads.push(makeThread('t1'))
      // the biggest file a phone may put, with markers at its start
      const bytes = Buffer.concat([Buffer.from(CONTENT_MARKER), Buffer.alloc(PHONE_ATTACH.maxFileBytes - CONTENT_MARKER.length, 97)])
      const base64 = bytes.toString('base64')
      const put = await t.transport.request({ method: 'POST', path: '/api/chat/attach', headers, body: { name: NAME_MARKER, size: bytes.length, base64 } })
      expect(put.status).toBe(200)
      const { id } = (put.body as { attachment: { id: string } }).attachment
      const sent = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers, body: { text: TEXT_MARKER, attachments: [id] } })
      expect(sent.status).toBe(200)
      expect(t.chat.askCalls).toEqual([{ threadId: 'remote', text: TEXT_MARKER, attachments: [id] }])
      // the file, its name, the text and the token never travel in the clear on any hop
      // the scan can see these markers when they are there: the same request in the clear is caught
      expect(mentions(JSON.stringify({ name: NAME_MARKER, text: TEXT_MARKER, base64 }), [NAME_MARKER, TEXT_MARKER, base64.slice(0, 64)])).toHaveLength(3)
      expect(pair.relay.tap.leaks([NAME_MARKER, CONTENT_MARKER, TEXT_MARKER, base64.slice(0, 64), headers.authorization ?? ''])).toEqual([])
      // it fits one frame under the relay's cap, and the request body under the channel's
      const biggest = Math.max(...pair.relay.tap.of('phoneToRelay').map((frame) => frame.length))
      expect(biggest).toBeGreaterThan(PHONE_ATTACH.maxFileBytes)
      expect(biggest).toBeLessThan(REMOTE_RELAY_LIMITS.frameBytes)
      expect(Buffer.byteLength(JSON.stringify({ name: NAME_MARKER, size: bytes.length, base64 }))).toBeLessThan(REMOTE_LIMITS.requestBytes)
      // nothing else was contacted: no push post, and the one file went to the one conversation's store
      expect(t.posts).toEqual([])
      expect(t.files.puts.map((p) => p.threadId)).toEqual(['remote'])
    })
  })
})
