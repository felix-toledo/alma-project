import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translatePwa, type PwaKey } from '../src/remote-client/i18n'
import { en } from '../src/remote-client/i18n/en'
import { es } from '../src/remote-client/i18n/es'
import { bytesToBase64, chipsAfterSend, putFile, removeUpload } from '../src/remote-client/lib/attach'
import { attachButton, canList } from '../src/remote-client/lib/can'
import { chatNoteKey, chatOutcomeKey, sendChat, validateChatInput } from '../src/remote-client/lib/chat'
import { attachOutcomeKey, attachRetryOffered, FAILURES, noteKeyFor, OPERATIONS, outcomeKey } from '../src/remote-client/lib/outcome'
import { mergeState, pollOnce } from '../src/remote-client/lib/poll'
import { shrinkPicture } from '../src/remote-client/lib/shrink'
import type { FetchLike, FetchResponse } from '../src/remote-client/lib/session'
import { fetchStatus } from '../src/remote-client/lib/status'
import { readThread, sendThread } from '../src/remote-client/lib/threads'
import { PHONE_ATTACH, SHRINK_STEPS } from '../src/shared/attach/phone'
import type { Chip, PhoneChipReason } from '../src/shared/attach/phone-chips'
import type { StatusView } from '../src/shared/remote/wire'

// The reasons a chip can carry (PhoneChipReason): every wire refusal, the PC not answering, and a file the phone could not read.
const CHIP_REASONS: PhoneChipReason[] = [...FAILURES.filter((reason) => reason !== 'not-delivered'), 'unreadable']

describe('attachment outcomes (AC-8.5, 031)', () => {
  it('AC-8.5 (031) every reason has exactly one key, present in es and en', () => {
    expect(OPERATIONS).toContain('attach')
    for (const reason of CHIP_REASONS) {
      const key = attachOutcomeKey(reason)
      expect(typeof key, reason).toBe('string')
      expect(es[key], `${reason} -> ${key} in es`).toBeTruthy()
      expect(en[key], `${reason} -> ${key} in en`).toBeTruthy()
    }
    for (const reason of FAILURES) {
      expect(es[outcomeKey(reason, 'attach')], reason).toBeTruthy()
      expect(en[outcomeKey(reason, 'attach')], reason).toBeTruthy()
    }
  })

  it('AC-8.5 (031) the attach operation names the concrete cause of plan 3.4', () => {
    const expected: Record<string, PwaKey> = {
      'too-large': 'remote.pwa.attach.tooBig',
      busy: 'remote.pwa.attach.busy',
      gone: 'remote.pwa.thread.gone',
      unavailable: 'remote.pwa.attach.expired',
      storage: 'remote.pwa.attach.storage',
      'attach-off': 'remote.pwa.attach.off',
      'notice-needed': 'remote.pwa.attach.noticeNeeded',
      'secret-name': 'remote.pwa.attach.secret',
      'file-type': 'remote.pwa.attach.type',
      'file-content': 'remote.pwa.attach.content',
      'file-empty': 'remote.pwa.attach.empty',
      'file-malformed': 'remote.pwa.attach.malformed',
      'too-many': 'remote.pwa.attach.tooMany',
      network: 'remote.pwa.pcUnreachable',
      unreadable: 'remote.pwa.attach.failed'
    }
    for (const [reason, key] of Object.entries(expected)) expect(attachOutcomeKey(reason as PhoneChipReason), reason).toBe(key)
    // A send refused for a bad id reads the same on the chat and the conversation screens.
    expect(outcomeKey('unavailable', 'chat')).toBe('remote.pwa.attach.expired')
    expect(outcomeKey('unavailable', 'threads.send')).toBe('remote.pwa.attach.expired')
    // The existing readings of the other operations are untouched.
    expect(outcomeKey('busy', 'threads.send')).toBe('remote.pwa.thread.busy')
    expect(outcomeKey('unavailable', 'notes.read')).toBe('remote.pwa.note.unavailable')
  })

  it('AC-8.5 (031) no two different causes share a key', () => {
    const seen = new Map<PwaKey, string>()
    for (const reason of ['too-large', 'busy', 'gone', 'unavailable', 'storage', 'attach-off', 'notice-needed', 'secret-name', 'file-type', 'file-content', 'file-empty', 'file-malformed', 'too-many', 'network', 'unreadable'] as const) {
      const key = attachOutcomeKey(reason)
      expect(seen.get(key), `${reason} shares ${key} with ${seen.get(key)}`).toBeUndefined()
      seen.set(key, reason)
    }
  })

  it('AC-8.5 (031) retry is offered only for the PC not answering and a failed upload', () => {
    for (const reason of CHIP_REASONS) expect(attachRetryOffered(reason), reason).toBe(reason === 'network' || reason === 'unreadable')
    for (const reason of ['file-type', 'secret-name', 'attach-off', 'notice-needed', 'too-large', 'file-empty'] as const) expect(attachRetryOffered(reason), reason).toBe(false)
  })

  it('AC-8.9 (031) no text renders a literal {name}: shown with no file to name it says the file', () => {
    for (const key of Object.keys(es) as PwaKey[]) {
      for (const language of ['es', 'en'] as const) expect(translatePwa(language, key), `${language} ${key}`).not.toContain('{name}')
    }
    expect(translatePwa('en', 'remote.pwa.attach.expired')).toBe('“the file” expired. Attach it again.')
    expect(translatePwa('es', 'remote.pwa.attach.expired')).toContain('el archivo')
    // a hostile name that spells the placeholder is the person's file name, not a hole to fill
    expect(translatePwa('en', 'remote.pwa.attach.expired', { name: 'a{name}.txt' })).toBe('“a{name}.txt” expired. Attach it again.')
  })

  it('AC-8.9 (031) the {name} placeholder is in the same texts in es and en and fills as plain text', () => {
    const keys = (Object.keys(es) as PwaKey[]).filter((key) => key.startsWith('remote.pwa.attach.'))
    for (const key of keys) expect(es[key].includes('{name}'), key).toBe(en[key].includes('{name}'))
    expect(translatePwa('en', 'remote.pwa.attach.type', { name: '<b>**x**</b>.exe' })).toBe('“<b>**x**</b>.exe” is a type Alma does not accept.')
  })
})

const answer = (status: number, body: unknown): FetchResponse => ({ ok: status < 300, status, json: async () => body })
const stored = { id: 'att-1', name: 'recibo.pdf', kind: 'pdf', size: 3 }

interface Call {
  url: string
  init?: Parameters<FetchLike>[1]
}
function recorder(reply: () => Promise<FetchResponse>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return reply()
    }
  }
}

describe('putting a file from the phone (AC-8.3, AC-8.6, AC-7.4, 031)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('AC-8.3 (031) putFile posts one file to the shared thread route and returns the stored attachment', async () => {
    const { fetch, calls } = recorder(async () => answer(200, { ok: true, attachment: stored, extra: 'dropped' }))
    const file = { name: 'recibo.pdf', size: 3, base64: 'AQID' }
    expect(await putFile({ fetch, token: 'tok', target: {}, file })).toEqual({ ok: true, attachment: stored })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/chat/attach')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' })
    expect(JSON.parse(calls[0].init?.body ?? '')).toEqual(file)
  })

  it('AC-8.3 (031) putFile into a conversation posts to the by-id route with the id', async () => {
    const { fetch, calls } = recorder(async () => answer(200, { ok: true, attachment: stored }))
    const file = { name: 'a.txt', size: 3, base64: 'AQID' }
    expect(await putFile({ fetch, token: 't', target: { id: 'thr-9' }, file })).toEqual({ ok: true, attachment: stored })
    expect(calls[0].url).toBe('/api/threads/attach')
    expect(JSON.parse(calls[0].init?.body ?? '')).toEqual({ id: 'thr-9', ...file })
  })

  it('AC-8.3 (031) an answer without a well-formed attachment is the PC not answering', async () => {
    const bodies = [{ ok: true }, { ok: true, attachment: { id: 1, name: 'a', kind: 'pdf', size: 1 } }, { ok: true, attachment: { id: 'x', name: 'a', kind: 'exe', size: 1 } }, { ok: true, attachment: { id: 'x', name: 'a', kind: 'pdf' } }]
    for (const body of bodies) {
      const { fetch } = recorder(async () => answer(200, body))
      expect(await putFile({ fetch, token: 't', target: {}, file: { name: 'a', size: 3, base64: 'AQID' } }), JSON.stringify(body)).toEqual({ ok: false, reason: 'network' })
    }
  })

  it('AC-8.3 (031) aborting the signal cancels the request', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const fetch: FetchLike = (_url, init) =>
      new Promise<FetchResponse>((_resolve, reject) => {
        seen = init?.signal
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const pending = putFile({ fetch, token: 't', target: {}, file: { name: 'a', size: 3, base64: 'AQID' }, signal: controller.signal })
    controller.abort()
    expect(seen).toBe(controller.signal)
    expect(await pending).toEqual({ ok: false, reason: 'network' })
  })

  it('AC-8.6 (031) a rejected fetch is network: nothing is queued or retried', async () => {
    const calls: string[] = []
    const fetch: FetchLike = async (url) => {
      calls.push(url)
      throw new TypeError('Failed to fetch')
    }
    vi.useFakeTimers()
    try {
      expect(await putFile({ fetch, token: 't', target: {}, file: { name: 'a', size: 3, base64: 'AQID' } })).toEqual({ ok: false, reason: 'network' })
      await vi.advanceTimersByTimeAsync(120_000)
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toEqual(['/api/chat/attach'])
  })

  it('AC-8.6 (031) a refusal body is read by its error name, whatever the status', async () => {
    const refusals = ['attach-off', 'notice-needed', 'too-many', 'secret-name', 'file-type', 'file-content', 'file-empty', 'file-malformed', 'storage', 'busy', 'gone', 'too-large'] as const
    for (const status of [403, 409, 415, 422, 500]) {
      for (const error of refusals) {
        const { fetch } = recorder(async () => answer(status, { error }))
        expect(await putFile({ fetch, token: 't', target: {}, file: { name: 'a', size: 3, base64: 'AQID' } }), `${status} ${error}`).toEqual({ ok: false, reason: error })
      }
    }
  })

  it('AC-8.3 (031) removeUpload asks the PC to drop one pending upload and keeps nothing', async () => {
    const { fetch, calls } = recorder(async () => answer(200, { ok: true }))
    expect(await removeUpload({ fetch, token: 'tok', id: 'att-1' })).toEqual({ ok: true })
    expect(calls[0].url).toBe('/api/attachments/remove')
    expect(JSON.parse(calls[0].init?.body ?? '')).toEqual({ id: 'att-1' })
    const down: FetchLike = async () => {
      throw new TypeError('x')
    }
    expect(await removeUpload({ fetch: down, token: 't', id: 'a' })).toEqual({ ok: false, reason: 'network' })
  })

  it('AC-7.4 (031) the module keeps nothing after the call: no storage API is touched', async () => {
    const touched: string[] = []
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
      const trap = new Proxy({}, { get: (_target, key) => { touched.push(`${name}.${String(key)}`); return undefined }, set: () => { touched.push(`${name} set`); return true } })
      vi.stubGlobal(name, trap)
    }
    const { fetch } = recorder(async () => answer(200, { ok: true, attachment: stored }))
    await putFile({ fetch, token: 't', target: {}, file: { name: 'a', size: 3, base64: bytesToBase64(new Uint8Array([1, 2, 3])) } })
    await putFile({ fetch, token: 't', target: { id: 'x' }, file: { name: 'a', size: 3, base64: 'AQID' } })
    await removeUpload({ fetch, token: 't', id: 'att-1' })
    expect(touched).toEqual([])
    // And the source names none of them, so a later edit cannot add one unseen.
    const source = readFileSync(join(__dirname, '..', 'src', 'remote-client', 'lib', 'attach.ts'), 'utf8')
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|\bcaches\b|idbStorage|node:|Buffer/)
  })
})

describe('bytes to base64 (AC-8.3, 031)', () => {
  it('AC-8.3 (031) bytesToBase64 matches Buffer for every length around the chunk edge', () => {
    const bytes = new Uint8Array(70_001)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    for (const length of [0, 1, 2, 3, 4, 5, 100, 0x7fff, 0x8000, 0x8001, 0x10000, 70_001]) {
      const slice = bytes.subarray(0, length)
      expect(bytesToBase64(slice), `${length}`).toBe(Buffer.from(slice).toString('base64'))
    }
  })

  it('AC-8.3 (031) a 700 000-byte file encodes to the 933 336 characters the PC bound allows', () => {
    const encoded = bytesToBase64(new Uint8Array(700_000).fill(255))
    expect(encoded.length).toBe(933_336)
    expect(encoded).toBe(Buffer.alloc(700_000, 255).toString('base64'))
  })
})

describe('sends that carry files (AC-4.1, AC-4.3, AC-8.7, 031)', () => {
  const body = (calls: Call[]): unknown => JSON.parse(calls[0].init?.body ?? 'null')

  it('AC-4.1 (031) validateChatInput accepts blank text with at least one ready file and refuses it with none', () => {
    expect(validateChatInput('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateChatInput('  ', 0)).toEqual({ ok: false, reason: 'empty' })
    expect(validateChatInput('', 1)).toEqual({ ok: true })
    expect(validateChatInput(' \n ', 5)).toEqual({ ok: true })
    expect(validateChatInput('x'.repeat(8000), 2)).toEqual({ ok: true })
    // The text limit still holds with files.
    expect(validateChatInput('x'.repeat(8001), 2)).toEqual({ ok: false, reason: 'too-long' })
  })

  it('AC-4.1 (031) sendChat and sendThread post the ids only when there are any', async () => {
    let calls: Call[] = []
    let fakeFetch: FetchLike = async () => answer(200, { ok: true })
    const reset = () => {
      const made = recorder(async () => answer(200, { ok: true }))
      calls = made.calls
      fakeFetch = made.fetch
    }
    reset()
    await sendChat({ fetch: fakeFetch, token: 't', text: 'hola' })
    expect(body(calls)).toEqual({ text: 'hola' })
    reset()
    await sendChat({ fetch: fakeFetch, token: 't', text: 'hola', attachments: [] })
    expect(body(calls)).toEqual({ text: 'hola' })
    reset()
    expect(await sendChat({ fetch: fakeFetch, token: 't', text: '', attachments: ['a', 'b'] })).toEqual({ ok: true })
    expect(body(calls)).toEqual({ text: '', attachments: ['a', 'b'] })
    expect(calls[0].url).toBe('/api/chat/send')
    reset()
    await sendThread({ fetch: fakeFetch, token: 't', id: 'thr', text: 'hola' })
    expect(body(calls)).toEqual({ id: 'thr', text: 'hola' })
    reset()
    await sendThread({ fetch: fakeFetch, token: 't', id: 'thr', text: 'hola', attachments: [] })
    expect(body(calls)).toEqual({ id: 'thr', text: 'hola' })
    reset()
    expect(await sendThread({ fetch: fakeFetch, token: 't', id: 'thr', text: '', attachments: ['a'] })).toEqual({ ok: true })
    expect(body(calls)).toEqual({ id: 'thr', text: '', attachments: ['a'] })
    expect(calls[0].url).toBe('/api/threads/send')
  })

  it('AC-4.1 (031) a 403 from attach-off is not read as scope-off when files are sent', async () => {
    const refuse = (status: number, error: string): FetchLike => async () => answer(status, { error })
    expect(await sendChat({ fetch: refuse(403, 'attach-off'), token: 't', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'attach-off' })
    expect(chatOutcomeKey('attach-off')).toBe('remote.pwa.attach.off')
    expect(await sendChat({ fetch: refuse(403, 'notice-needed'), token: 't', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'notice-needed' })
    expect(await sendChat({ fetch: refuse(403, 'scope-off'), token: 't', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'scope-off' })
    // Still the same readings as before for the key, the size and the rate.
    expect(await sendChat({ fetch: refuse(401, 'unknown-device'), token: 't', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'refused' })
    expect(await sendChat({ fetch: refuse(413, 'too-large'), token: 't', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'too-large' })
    expect(chatOutcomeKey('too-large')).toBe('remote.pwa.tooLong')
    // Without files the text-only send is exactly as before: every 403 is scope-off.
    expect(await sendChat({ fetch: refuse(403, 'attach-off'), token: 't', text: 'x' })).toEqual({ ok: false, reason: 'scope-off' })
    // A conversation send already reads the name.
    expect(await sendThread({ fetch: refuse(403, 'attach-off'), token: 't', id: 'thr', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'attach-off' })
  })

  it('AC-8.7 (031) unavailable on a send reads as expired on the chat and the conversation screens', async () => {
    const gone: FetchLike = async () => answer(409, { error: 'unavailable' })
    expect(await sendChat({ fetch: gone, token: 't', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'unavailable' })
    expect(chatOutcomeKey('unavailable')).toBe('remote.pwa.attach.expired')
    expect(await sendThread({ fetch: gone, token: 't', id: 'thr', text: 'x', attachments: ['a'] })).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('AC-8.7 (031) unavailable on a send marks every ready chip expired, one event per id', () => {
    const chips: Chip[] = [
      { key: 'k1', name: 'a.pdf', state: 'ready', id: 'i1' },
      { key: 'k2', name: 'b.png', state: 'ready', id: 'i2' },
      { key: 'k3', name: 'c.txt', state: 'failed', reason: 'network' }
    ]
    const next = chipsAfterSend(chips, { ok: false, reason: 'unavailable' })
    expect(next.map((chip) => [chip.key, chip.state, chip.reason])).toEqual([
      ['k1', 'failed', 'unavailable'],
      ['k2', 'failed', 'unavailable'],
      ['k3', 'failed', 'network']
    ])
    expect(next.every((chip) => chip.id === undefined)).toBe(true)
    expect(attachOutcomeKey('unavailable')).toBe('remote.pwa.attach.expired')
  })

  it('AC-8.7 (031) a send refused as unavailable shows no loose line (the chips say it by name); every other failure keeps its line', () => {
    expect(chatNoteKey('unavailable')).toBeNull()
    expect(noteKeyFor('unavailable', 'threads.send')).toBeNull()
    expect(chatNoteKey('busy')).toBe('remote.pwa.notDelivered')
    expect(chatNoteKey('attach-off')).toBe('remote.pwa.attach.off')
    expect(noteKeyFor('busy', 'threads.send')).toBe('remote.pwa.thread.busy')
    expect(noteKeyFor('notice-needed', 'threads.send')).toBe('remote.pwa.attach.noticeNeeded')
    // Outside a send the same word keeps its meaning.
    expect(noteKeyFor('unavailable', 'notes.read')).toBe('remote.pwa.note.unavailable')
  })

  it('AC-4.3 (031) a refused send keeps text and chips; an accepted one clears the chips', () => {
    const chips: Chip[] = [{ key: 'k1', name: 'a.pdf', state: 'ready', id: 'i1' }]
    for (const reason of ['busy', 'run-active', 'too-large', 'attach-off', 'notice-needed', 'scope-off', 'rate-limited', 'not-delivered', 'network'] as const) {
      expect(chipsAfterSend(chips, { ok: false, reason }), reason).toEqual(chips)
    }
    expect(chipsAfterSend(chips, { ok: true })).toEqual([])
  })
})

describe('reading the status and the attachment lists (AC-1.9, AC-5.1, AC-8.4, 031)', () => {
  const view = (over: Partial<StatusView['scopes']> = {}, rest: Partial<Omit<StatusView, 'scopes'>> = {}): StatusView => ({
    scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false, ...over },
    sensitive: false,
    continue: false,
    ...rest
  })

  it('AC-1.9 (031) canList shows Send files right after Continue, on or off', () => {
    for (const on of [true, false]) {
      const list = canList(view({}, { sendFiles: on }))
      expect(list.at(-1)).toEqual({ key: 'remote.pwa.can.attach', on })
      expect(list.at(-2)?.key).toBe('remote.pwa.can.continue')
    }
    expect(es['remote.pwa.can.attach']).toBe('Enviar archivos')
    expect(en['remote.pwa.can.attach']).toBe('Send files')
  })

  it('AC-1.9 (031) a status without the key, or with a non-boolean, reads as off', () => {
    expect(canList(view()).at(-1)).toEqual({ key: 'remote.pwa.can.attach', on: false })
    expect(canList({ ...view(), sendFiles: 'yes' } as unknown as StatusView).at(-1)?.on).toBe(false)
  })

  it('AC-1.9 (031) fetchStatus keeps sendFiles only when it is a boolean, and nothing else new', async () => {
    const reply = (extra: Record<string, unknown>): FetchLike => async () => answer(200, { ...view(), ...extra })
    expect(await fetchStatus({ fetch: reply({ sendFiles: true, secret: 'x' }), token: 't' })).toEqual({ ok: true, status: view({}, { sendFiles: true }) })
    expect(await fetchStatus({ fetch: reply({ sendFiles: false }), token: 't' })).toEqual({ ok: true, status: view({}, { sendFiles: false }) })
    const old = await fetchStatus({ fetch: reply({}), token: 't' })
    expect(old).toEqual({ ok: true, status: view() })
    expect(old.ok && 'sendFiles' in old.status).toBe(false)
    const odd = await fetchStatus({ fetch: reply({ sendFiles: 'yes' }), token: 't' })
    expect(odd.ok && 'sendFiles' in odd.status).toBe(false)
  })

  it('AC-7.5 (033) fetchStatus keeps the landing only as a conversation id', async () => {
    const reply = (extra: Record<string, unknown>): FetchLike => async () => answer(200, { ...view(), ...extra })
    expect(await fetchStatus({ fetch: reply({ landing: 'greeting-thread' }), token: 't' })).toEqual({ ok: true, status: view({}, { landing: 'greeting-thread' }) })
    for (const landing of [42, '', 'x'.repeat(65), null]) {
      const odd = await fetchStatus({ fetch: reply({ landing }), token: 't' })
      expect(odd.ok && 'landing' in odd.status, String(landing)).toBe(false)
    }
  })

  it('AC-8.4 (031) the attach button follows the status without a reload, off with the reason', async () => {
    expect(attachButton(null)).toEqual({ enabled: false, reason: 'remote.pwa.attach.off' })
    expect(attachButton(view())).toEqual({ enabled: false, reason: 'remote.pwa.attach.off' })
    expect(attachButton(view({}, { sendFiles: true }))).toEqual({ enabled: true, reason: null })
    // The next request changes it: the same reader, the PC flips the switch between two calls.
    let on = false
    const fetch: FetchLike = async () => answer(200, { ...view(), sendFiles: on })
    const read = async () => {
      const out = await fetchStatus({ fetch, token: 't' })
      return out.ok ? attachButton(out.status).enabled : null
    }
    expect(await read()).toBe(false)
    on = true
    expect(await read()).toBe(true)
    on = false
    expect(await read()).toBe(false)
  })

  const planted = [
    { name: 'recibo.pdf', kind: 'pdf', size: 1200, id: 'SECRET-ID', path: 'C:/secret' },
    { name: 'sin-size.txt', kind: 'text' },
    'junk',
    null,
    { name: 'raro.exe', kind: 'exe', size: 3 },
    { name: 'neg.txt', kind: 'text', size: -1 },
    { name: 'foto.png', kind: 'image', size: 5 }
  ]

  it('AC-5.1 (031) the Chat state keeps the attachment list and drops anything malformed; the id never reaches the render model', async () => {
    const messages = [
      { index: 1, role: 'user', text: 'mira', at: 10, attachments: planted },
      { index: 2, role: 'user', text: '', at: 11, attachments: [{ name: 'solo.pdf', kind: 'pdf', size: 7 }] },
      { index: 3, role: 'assistant', text: 'listo', at: 12, attachments: 'not-a-list' },
      { index: 4, role: 'user', text: 'x', at: 13, attachments: [{ name: 'a' }] },
      { index: 5, role: 'user', text: 'plain', at: 14, id: 'MSG-ID' }
    ]
    const fetch: FetchLike = async () => answer(200, { rev: 5, running: false, messages, approvals: [] })
    const polled = await pollOnce({ fetch, token: 't', since: null, signal: new AbortController().signal })
    expect(polled.ok).toBe(true)
    if (!polled.ok) return
    expect(polled.state.messages).toEqual([
      { index: 1, role: 'user', text: 'mira', at: 10, attachments: [{ name: 'recibo.pdf', kind: 'pdf', size: 1200 }, { name: 'foto.png', kind: 'image', size: 5 }] },
      { index: 2, role: 'user', text: '', at: 11, attachments: [{ name: 'solo.pdf', kind: 'pdf', size: 7 }] },
      { index: 3, role: 'assistant', text: 'listo', at: 12 },
      { index: 4, role: 'user', text: 'x', at: 13 },
      { index: 5, role: 'user', text: 'plain', at: 14 }
    ])
    expect(JSON.stringify(polled)).not.toMatch(/SECRET|MSG-ID/)
    // A later poll merges by index and keeps the lists.
    const merged = mergeState(polled.state, { ...polled.state, rev: 6, messages: [{ index: 6, role: 'user', text: 'otro', at: 15, attachments: [{ name: 'b.txt', kind: 'text', size: 1 }] }] })
    expect(merged.messages.at(-1)?.attachments).toEqual([{ name: 'b.txt', kind: 'text', size: 1 }])
    expect(merged.messages[0].attachments).toHaveLength(2)
  })

  it('AC-5.1 (031) a conversation window keeps the attachment list and drops anything malformed', async () => {
    const messages = [
      { index: 1, role: 'user', text: 'mira', at: 10, attachments: planted },
      { index: 2, role: 'assistant', text: 'ok', at: 11, attachments: { 0: { name: 'a', kind: 'pdf', size: 1 } } }
    ]
    const fetch: FetchLike = async () => answer(200, { rev: 2, running: false, ownRun: false, waiting: false, earlier: false, messages })
    const out = await readThread({ fetch, token: 't', id: 'thr' })
    expect(out.ok && out.window.messages).toEqual([
      { index: 1, role: 'user', text: 'mira', at: 10, attachments: [{ name: 'recibo.pdf', kind: 'pdf', size: 1200 }, { name: 'foto.png', kind: 'image', size: 5 }] },
      { index: 2, role: 'assistant', text: 'ok', at: 11 }
    ])
    expect(JSON.stringify(out)).not.toMatch(/SECRET|secret/)
  })
})

// Spec 031 section 6.1, phone keys: es (rioplatense) then en (US). The dictionaries are the source once built; this pins the wording agreed there.
const SPEC_TEXTS: Record<string, [string, string]> = {
  'remote.pwa.can.attach': ['Enviar archivos', 'Send files'],
  'remote.pwa.attach.button': ['Adjuntar', 'Attach'],
  'remote.pwa.attach.remove': ['Quitar «{name}»', 'Remove “{name}”'],
  'remote.pwa.attach.preparing': ['Preparando «{name}»…', 'Preparing “{name}”…'],
  'remote.pwa.attach.uploading': ['Subiendo «{name}»…', 'Uploading “{name}”…'],
  'remote.pwa.attach.failed': ['No se pudo subir «{name}».', 'Could not upload “{name}”.'],
  'remote.pwa.attach.off': ['Enviar archivos está apagado en la PC.', 'Sending files is turned off on the PC.'],
  'remote.pwa.attach.noticeNeeded': [
    'Aceptá en la PC el aviso de privacidad de este proveedor: adjuntá un archivo desde el chat de la PC una vez.',
    "Accept this provider's privacy notice on the PC: attach a file from the PC chat once."
  ],
  'remote.pwa.attach.tooBig': ['«{name}» pesa más de 700 KB. Desde el celular no se puede enviar; mandalo desde la PC.', '“{name}” is over 700 KB. It cannot be sent from the phone; send it from the PC.'],
  'remote.pwa.attach.type': ['«{name}» es de un tipo que Alma no acepta.', '“{name}” is a type Alma does not accept.'],
  'remote.pwa.attach.content': ['El contenido de «{name}» no coincide con su tipo.', 'The content of “{name}” does not match its type.'],
  'remote.pwa.attach.empty': ['«{name}» está vacío.', '“{name}” is empty.'],
  'remote.pwa.attach.malformed': ['La imagen «{name}» está dañada.', 'The picture “{name}” is damaged.'],
  'remote.pwa.attach.secret': ['«{name}» parece tener datos secretos. Mandalo desde la PC.', '“{name}” looks like it holds secrets. Send it from the PC.'],
  'remote.pwa.attach.tooMany': ['Hasta 5 archivos por mensaje.', 'Up to 5 files per message.'],
  'remote.pwa.attach.busy': ['La conversación está respondiendo. Esperá a que termine para adjuntar.', 'The conversation is replying. Wait for it to finish before attaching.'],
  'remote.pwa.attach.expired': ['«{name}» venció. Adjuntalo de nuevo.', '“{name}” expired. Attach it again.'],
  'remote.pwa.attach.storage': ['La PC no pudo guardar «{name}».', 'The PC could not store “{name}”.'],
  'remote.pwa.attach.kind.image': ['Imagen', 'Picture'],
  'remote.pwa.attach.kind.text': ['Texto', 'Text'],
  'remote.pwa.attach.kind.pdf': ['PDF', 'PDF'],
  'remote.pwa.attach.kind.office': ['Documento', 'Document']
}
// Reused keys: they must keep existing; their wording belongs to earlier specs.
const REUSED = ['remote.pwa.retry', 'remote.pwa.scopeOff', 'remote.pwa.writeOff', 'remote.pwa.pcUnreachable', 'remote.pwa.rateLimited', 'remote.pwa.thread.gone', 'remote.pwa.run.active', 'remote.pwa.tooLong'] as const

describe('dictionaries (AC-8.9, 031)', () => {
  it('AC-8.9 (031) every new key of section 6.1 exists in es and en with the agreed wording', () => {
    const dictionaries = { es: es as Record<string, string>, en: en as Record<string, string> }
    for (const [key, [spanish, english]] of Object.entries(SPEC_TEXTS)) {
      expect(dictionaries.es[key], `${key} es`).toBe(spanish)
      expect(dictionaries.en[key], `${key} en`).toBe(english)
    }
    for (const key of REUSED) {
      expect(dictionaries.es[key], `${key} es`).toBeTruthy()
      expect(dictionaries.en[key], `${key} en`).toBeTruthy()
    }
  })

  it('AC-8.9 (031) the {name} placeholders match in both languages and no file name can add markup', () => {
    for (const [key, [spanish, english]] of Object.entries(SPEC_TEXTS)) {
      expect(spanish.includes('{name}'), key).toBe(english.includes('{name}'))
    }
    const hostile = '<img src=x onerror=1>{name}$&.txt'
    for (const language of ['es', 'en'] as const) {
      expect(translatePwa(language, 'remote.pwa.attach.failed', { name: hostile })).toContain(hostile)
    }
  })

  it('AC-8.9 (031) the PC strings of section 6.1 are keys of the shared dictionaries in es and en', async () => {
    const { es: sharedEs } = await import('../src/shared/i18n/es')
    const { en: sharedEn } = await import('../src/shared/i18n/en')
    for (const key of ['remote.scope.attachments', 'remote.scope.attachments.hint', 'main.remote.attachments']) {
      expect((sharedEs as Record<string, unknown>)[key], `${key} es`).toBeTruthy()
      expect((sharedEn as Record<string, unknown>)[key], `${key} en`).toBeTruthy()
    }
    expect(String((sharedEn as Record<string, unknown>)['main.remote.attachments'])).toContain('{providers}')
    expect(String((sharedEs as Record<string, unknown>)['main.remote.attachments'])).toContain('{providers}')
  })
})

describe('shrinking a picture on the phone (AC-8.1, 031)', () => {
  const picture = new File([new Uint8Array(3_000_000)], 'IMG_0001.jpeg', { type: 'image/jpeg' })
  /** An encoder whose result sizes are given per step, recording the steps it was asked for. */
  const encoder = (sizes: number[]) => {
    const asked: { maxSide: number; quality: number }[] = []
    const encode = async (_source: Blob, step: { maxSide: number; quality: number }): Promise<Blob> => {
      asked.push(step)
      return new Blob([new Uint8Array(sizes[asked.length - 1] ?? 0)], { type: 'image/jpeg' })
    }
    return { encode, asked }
  }

  it('AC-8.1 (031) shrinkPicture stops at the first step that fits and names the JPEG imagen-<timestamp>.jpg', async () => {
    const { encode, asked } = encoder([900_000, 700_001, PHONE_ATTACH.maxFileBytes, 10])
    const shrunk = await shrinkPicture(picture, 1_700_000_000_000, encode)
    expect(shrunk?.name).toBe('imagen-1700000000000.jpg')
    expect(shrunk?.type).toBe('image/jpeg')
    expect(shrunk?.size).toBe(PHONE_ATTACH.maxFileBytes)
    expect(asked).toEqual(SHRINK_STEPS.slice(0, 3))
  })

  it('AC-8.1 (031) shrinkPicture is null when no step fits, and when the picture cannot be decoded: never sent larger', async () => {
    const { encode, asked } = encoder(SHRINK_STEPS.map(() => 800_000))
    expect(await shrinkPicture(picture, 1, encode)).toBeNull()
    expect(asked).toHaveLength(SHRINK_STEPS.length)
    const broken = async (): Promise<Blob> => {
      throw new Error('cannot decode')
    }
    expect(await shrinkPicture(picture, 1, broken)).toBeNull()
  })
})
