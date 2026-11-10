import { describe, expect, it, vi } from 'vitest'
import { translatePwa, type PwaKey } from '../src/remote-client/i18n'
import { en as pwaEn } from '../src/remote-client/i18n/en'
import { es as pwaEs } from '../src/remote-client/i18n/es'
import { bytesToBase64, chipsAfterSend, putFile, readAttachmentViews, removeUpload } from '../src/remote-client/lib/attach'
import { createAttachFlow } from '../src/remote-client/lib/attach-flow'
import { attachButton, canList } from '../src/remote-client/lib/can'
import { validateChatInput } from '../src/remote-client/lib/chat'
import { attachOutcomeKey, attachRetryOffered, FAILURES, outcomeKey, type Failure } from '../src/remote-client/lib/outcome'
import { shrinkPicture } from '../src/remote-client/lib/shrink'
import type { FetchLike } from '../src/remote-client/lib/session'
import { fetchStatus } from '../src/remote-client/lib/status'
import { decodedLength } from '../src/shared/attach/request'
import { planPhoneFile, reencodedPictureName, shrinkToFit, SHRINK_STEPS } from '../src/shared/attach/phone'
import { canSendNow, chipsReduce, type Chip, type ChipEvent, type ChipState, type PhoneChipReason } from '../src/shared/attach/phone-chips'
import { REMOTE_LIMITS } from '../src/shared/remote/api'

const file = (name: string, size = 10): File => new File([new Uint8Array(size).fill(65)], name)
const sized = (name: string, size: number) => ({ name, size })
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}
const flush = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('031 verify: the file plan (AC-8.1)', () => {
  it('AC-8.1 (031 verify) a picture within the limit is sent as is; at the exact limit too', () => {
    for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', 'a.gif']) {
      expect({ name, plan: planPhoneFile(sized(name, 700_000), 0) }).toEqual({ name, plan: { action: 'send' } })
      expect(planPhoneFile(sized(name, 0), 0)).toEqual({ action: 'send' })
    }
  })

  it('AC-8.1 (031 verify) a picture one byte over is shrunk, except a GIF, which is refused', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'A.PNG']) expect(planPhoneFile(sized(name, 700_001), 0)).toEqual({ action: 'shrink' })
    expect(planPhoneFile(sized('a.gif', 700_001), 0)).toEqual({ action: 'refuse', reason: 'too-big' })
    expect(planPhoneFile(sized('a.GIF', 20_000_000), 0)).toEqual({ action: 'refuse', reason: 'too-big' })
  })

  it('AC-8.1 (031 verify) any other file over the limit is refused as too-big, whatever its type', () => {
    for (const name of ['a.pdf', 'a.docx', 'a.xlsx', 'a.pptx', 'a.txt', 'a.ts', 'a.md']) expect(planPhoneFile(sized(name, 700_001), 0)).toEqual({ action: 'refuse', reason: 'too-big' })
    expect(planPhoneFile(sized('a.pdf', 700_000), 0)).toEqual({ action: 'send' })
  })

  it('AC-8.1 (031 verify) a type outside the 030 list is refused as type, at any size, and before the count and the size', () => {
    for (const name of ['a.svg', 'a.html', 'a.exe', 'a.zip', 'README', 'a.png.', 'a.png ', '.env', 'a.heic', 'a.bmp', 'a.tiff', 'a.mp4', 'a.txt.exe']) {
      expect({ name, plan: planPhoneFile(sized(name, 10), 0) }).toEqual({ name, plan: { action: 'refuse', reason: 'type' } })
      expect(planPhoneFile(sized(name, 9_000_000), 5)).toEqual({ action: 'refuse', reason: 'type' })
    }
  })

  it('AC-8.1 (031 verify) the sixth chip is refused as too-many; five held is the limit', () => {
    expect(planPhoneFile(sized('a.png', 10), 4)).toEqual({ action: 'send' })
    expect(planPhoneFile(sized('a.png', 10), 5)).toEqual({ action: 'refuse', reason: 'too-many' })
    expect(planPhoneFile(sized('a.png', 10), 99)).toEqual({ action: 'refuse', reason: 'too-many' })
  })

  it('AC-8.1 (031 verify) a re-encoded picture is named imagen-<timestamp>.jpg', () => {
    expect(reencodedPictureName(1_700_000_000_000)).toBe('imagen-1700000000000.jpg')
    expect(reencodedPictureName(0)).toMatch(/^imagen-\d+\.jpg$/)
  })

  it('AC-8.1 (031 verify) shrinking tries the biggest step first, stops at the first that fits, never returns a bigger file', async () => {
    const calls: number[] = []
    const sizes = [900_000, 800_000, 700_000, 100]
    const out = await shrinkToFit(async (step) => {
      calls.push(step.maxSide)
      return { size: sizes[calls.length - 1], step }
    })
    expect(calls).toEqual([2048, 1600, 1280])
    expect(out?.size).toBe(700_000)
    expect(await shrinkToFit(async () => ({ size: 700_001 }))).toBeNull()
    expect(await shrinkToFit(async () => ({ size: 700_000 }))).toEqual({ size: 700_000 })
    expect(await shrinkToFit(async () => ({ size: 5 }), 4)).toBeNull()
    expect(await shrinkToFit(async () => ({ size: 5 }), 5)).toEqual({ size: 5 })
  })

  it('AC-8.1 (031 verify) every step is tried once when nothing fits, then the picture is refused; an encoder that throws ends it at once', async () => {
    let tried = 0
    expect(await shrinkToFit(async () => ({ size: 9_999_999 }))).toBeNull()
    await shrinkToFit(async () => {
      tried += 1
      return { size: 9_999_999 }
    })
    expect(tried).toBe(SHRINK_STEPS.length)
    let thrown = 0
    expect(
      await shrinkToFit(async () => {
        thrown += 1
        throw new Error('canvas gone')
      })
    ).toBeNull()
    expect(thrown).toBe(1)
  })

  it('AC-8.1 (031 verify) the steps only get smaller and keep a usable JPEG quality', () => {
    for (let i = 1; i < SHRINK_STEPS.length; i++) expect(SHRINK_STEPS[i].maxSide).toBeLessThan(SHRINK_STEPS[i - 1].maxSide)
    for (const step of SHRINK_STEPS) {
      expect(step.quality).toBeGreaterThan(0)
      expect(step.quality).toBeLessThanOrEqual(1)
    }
  })

  it('AC-8.1 (031 verify) shrinkPicture names the result and returns null when nothing fits or the picture cannot be decoded', async () => {
    const small = await shrinkPicture(new Blob(['x']), 1234, async () => new Blob([new Uint8Array(100)]))
    expect(small?.name).toBe('imagen-1234.jpg')
    expect(small?.type).toBe('image/jpeg')
    expect(await shrinkPicture(new Blob(['x']), 1, async () => new Blob([new Uint8Array(700_001)]))).toBeNull()
    expect(await shrinkPicture(new Blob(['x']), 1, async () => Promise.reject(new Error('cannot decode')))).toBeNull()
  })

  it('AC-8.1 (031 verify) base64 of a 700 000-byte file equals Buffer, has 933 336 characters and decodes back to the same count', () => {
    const data = new Uint8Array(700_000)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff
    const encoded = bytesToBase64(data)
    expect(encoded).toBe(Buffer.from(data).toString('base64'))
    expect(encoded.length).toBe(933_336)
    expect(decodedLength(encoded)).toBe(700_000)
    for (const size of [0, 1, 2, 3, 4, 32_767, 32_768, 32_769, 65_536, 65_537]) {
      const part = data.subarray(0, size)
      expect(bytesToBase64(part)).toBe(Buffer.from(part).toString('base64'))
    }
  })
})

describe('031 verify: the chip state machine (AC-8.3, AC-8.6, AC-8.7)', () => {
  const STATES: ChipState[] = ['preparing', 'uploading', 'ready', 'failed']
  const make = (state: ChipState, key = 'k'): Chip => ({ key, name: 'n.txt', state, ...(state === 'ready' ? { id: 'ID' } : {}), ...(state === 'failed' ? { reason: 'network' as const } : {}) })

  it('AC-8.3 (031 verify) a new chip starts preparing and a repeated key changes nothing', () => {
    const out = chipsReduce([], { type: 'added', key: 'a', name: 'x.png' })
    expect(out.chips).toEqual([{ key: 'a', name: 'x.png', state: 'preparing' }])
    expect(out.effects).toEqual([])
    expect(chipsReduce(out.chips, { type: 'added', key: 'a', name: 'other' }).chips).toEqual(out.chips)
  })

  it('AC-8.3 (031 verify) every event against every state: only the documented transitions happen, nothing else', () => {
    const events: [string, ChipEvent, Partial<Record<ChipState, Chip>>][] = [
      ['prepared', { type: 'prepared', key: 'k' }, { preparing: { key: 'k', name: 'n.txt', state: 'uploading' } }],
      ['uploaded', { type: 'uploaded', key: 'k', id: 'NEW' }, { uploading: { key: 'k', name: 'n.txt', state: 'ready', id: 'NEW' } }],
      ['failed', { type: 'failed', key: 'k', reason: 'file-type' }, { preparing: { key: 'k', name: 'n.txt', state: 'failed', reason: 'file-type' }, uploading: { key: 'k', name: 'n.txt', state: 'failed', reason: 'file-type' } }],
      ['expired', { type: 'expired', id: 'ID' }, { ready: { key: 'k', name: 'n.txt', state: 'failed', reason: 'unavailable' } }]
    ]
    for (const [label, event, expected] of events) {
      for (const state of STATES) {
        const before = deepFreeze([make(state)])
        const out = chipsReduce(before, event)
        expect({ label, state, chips: out.chips }).toEqual({ label, state, chips: [expected[state] ?? before[0]] })
        expect(out.effects).toEqual([])
      }
    }
  })

  it('AC-8.3 (031 verify) an event for another key or id touches no other chip', () => {
    const chips = deepFreeze(STATES.map((state, i) => make(state, `k${i}`)))
    for (const event of [
      { type: 'prepared', key: 'zzz' },
      { type: 'uploaded', key: 'zzz', id: 'X' },
      { type: 'failed', key: 'zzz', reason: 'file-type' },
      { type: 'expired', id: 'NOPE' },
      { type: 'remove', key: 'zzz' }
    ] as ChipEvent[])
      expect(chipsReduce(chips, event).chips).toEqual(chips)
  })

  it('AC-8.3 (031 verify) a failed chip loses its id, so a failed upload can never be bound to a send', () => {
    const out = chipsReduce([make('ready')], { type: 'expired', id: 'ID' }).chips[0]
    expect(out.id).toBeUndefined()
    expect(chipsReduce([make('uploading')], { type: 'failed', key: 'k', reason: 'network' }).chips[0].id).toBeUndefined()
  })

  it('AC-8.3 (031 verify) the X aborts an uploading chip, asks the PC to remove a ready one, and just drops the rest', () => {
    const effects = (state: ChipState) => chipsReduce([make(state)], { type: 'remove', key: 'k' })
    expect(effects('uploading')).toEqual({ chips: [], effects: [{ type: 'abort', key: 'k' }] })
    expect(effects('ready')).toEqual({ chips: [], effects: [{ type: 'remove-remote', id: 'ID' }] })
    expect(effects('preparing')).toEqual({ chips: [], effects: [] })
    expect(effects('failed')).toEqual({ chips: [], effects: [] })
    expect(chipsReduce([{ key: 'k', name: 'x', state: 'ready' }], { type: 'remove', key: 'k' }).effects).toEqual([])
  })

  it('AC-8.6 (031 verify) a dropped connection fails the chip that was uploading (a failed event with the reason network) and keeps the others', () => {
    const chips = [make('preparing', 'a'), make('uploading', 'b'), make('ready', 'c'), make('uploading', 'd')]
    const out = ['b', 'd'].reduce((held, key) => chipsReduce(held, { type: 'failed', key, reason: 'network' }).chips, chips)
    expect(out.map((c) => c.state)).toEqual(['preparing', 'failed', 'ready', 'failed'])
    expect(out.filter((c) => c.state === 'failed').map((c) => c.reason)).toEqual(['network', 'network'])
  })

  it('AC-8.3 (031 verify) the send button is off while any chip is preparing or uploading, whatever the text', () => {
    for (const state of ['preparing', 'uploading'] as const) {
      expect(canSendNow([make(state), make('ready', 'r')], 'hola', false)).toBe(false)
      expect(canSendNow([make(state)], '', false)).toBe(false)
    }
  })

  it('AC-8.3 (031 verify) a ready chip or a text enables it; failed chips count as nothing; a run disables it', () => {
    expect(canSendNow([make('ready')], '', false)).toBe(true)
    expect(canSendNow([make('failed')], '', false)).toBe(false)
    expect(canSendNow([make('failed')], 'hola', false)).toBe(true)
    expect(canSendNow([], '   ', false)).toBe(false)
    expect(canSendNow([], '', false)).toBe(false)
    expect(canSendNow([make('ready')], 'hola', true)).toBe(false)
    expect(canSendNow([], 'hola', true)).toBe(false)
  })

  it('AC-8.7 (031 verify) after a send refused as unavailable every ready chip is expired; any other refusal keeps the chips', () => {
    const chips = deepFreeze([make('ready', 'a'), { ...make('ready', 'b'), id: 'ID2' }, make('failed', 'c'), make('uploading', 'd')])
    const expired = chipsAfterSend(chips, { ok: false, reason: 'unavailable' })
    expect(expired.map((c) => [c.state, c.reason])).toEqual([['failed', 'unavailable'], ['failed', 'unavailable'], ['failed', 'network'], ['uploading', undefined]])
    for (const reason of ['busy', 'run-active', 'not-delivered', 'network', 'attach-off', 'notice-needed', 'invalid', 'rate-limited', 'scope-off']) {
      expect(chipsAfterSend(chips, { ok: false, reason })).toEqual(chips)
    }
    expect(chipsAfterSend(chips, { ok: true })).toEqual([])
  })
})

describe('031 verify: the reason-to-key mapping (AC-8.5)', () => {
  const chipReasons = [...FAILURES, 'unreadable'] as PhoneChipReason[]
  const text = (key: PwaKey, language: 'es' | 'en') => translatePwa(language, key, { name: 'NOMBRE' })

  it('AC-8.5 (031 verify) every reason a chip can show maps to one dictionary key that exists, is non-empty and is not a placeholder, in both languages', () => {
    for (const reason of chipReasons) {
      const key = attachOutcomeKey(reason)
      for (const language of ['es', 'en'] as const) {
        const shown = text(key, language)
        expect({ reason, key, shown: shown.length > 0 }).toEqual({ reason, key, shown: true })
        expect(shown).not.toMatch(/\{\w+\}/)
        expect(shown).not.toBe(key)
      }
    }
  })

  it('AC-8.5 (031 verify) the file reasons name the file; the mapping is the one of the spec table', () => {
    const table: [PhoneChipReason, PwaKey][] = [
      ['attach-off', 'remote.pwa.attach.off'],
      ['notice-needed', 'remote.pwa.attach.noticeNeeded'],
      ['too-large', 'remote.pwa.attach.tooBig'],
      ['file-type', 'remote.pwa.attach.type'],
      ['file-content', 'remote.pwa.attach.content'],
      ['file-empty', 'remote.pwa.attach.empty'],
      ['file-malformed', 'remote.pwa.attach.malformed'],
      ['secret-name', 'remote.pwa.attach.secret'],
      ['too-many', 'remote.pwa.attach.tooMany'],
      ['busy', 'remote.pwa.attach.busy'],
      ['unavailable', 'remote.pwa.attach.expired'],
      ['storage', 'remote.pwa.attach.storage'],
      ['unreadable', 'remote.pwa.attach.failed'],
      ['network', 'remote.pwa.pcUnreachable'],
      ['gone', 'remote.pwa.thread.gone'],
      ['scope-off', 'remote.pwa.scopeOff'],
      ['write-off', 'remote.pwa.writeOff'],
      ['rate-limited', 'remote.pwa.rateLimited']
    ]
    for (const [reason, key] of table) expect({ reason, key: attachOutcomeKey(reason) }).toEqual({ reason, key })
    for (const key of ['remote.pwa.attach.tooBig', 'remote.pwa.attach.type', 'remote.pwa.attach.content', 'remote.pwa.attach.empty', 'remote.pwa.attach.malformed', 'remote.pwa.attach.secret', 'remote.pwa.attach.expired', 'remote.pwa.attach.storage', 'remote.pwa.attach.failed'] as PwaKey[]) {
      expect(pwaEs[key]).toContain('{name}')
      expect(pwaEn[key]).toContain('{name}')
    }
  })

  it('AC-8.5 (031 verify) a send refused on its own reasons reads concretely too (the key the chat shows for each file reason)', () => {
    for (const reason of ['attach-off', 'notice-needed', 'unavailable', 'too-many', 'secret-name', 'file-type', 'busy', 'run-active'] as const) {
      const key = outcomeKey(reason, 'chat')
      expect(translatePwa('en', key, { name: 'x' }).length).toBeGreaterThan(0)
    }
    expect(outcomeKey('unavailable', 'chat')).toBe('remote.pwa.attach.expired')
    expect(outcomeKey('unavailable', 'threads.send')).toBe('remote.pwa.attach.expired')
  })

  it('AC-8.5 (031 verify) retry is offered where trying again can help and never for a type, size, secret name, switch or notice', () => {
    for (const reason of ['network', 'unreadable'] as const) expect(attachRetryOffered(reason)).toBe(true)
    for (const reason of ['file-type', 'too-large', 'secret-name', 'attach-off', 'notice-needed', 'file-content', 'file-empty', 'file-malformed', 'too-many', 'scope-off', 'write-off', 'unknown-device'] as const) {
      expect({ reason, retry: attachRetryOffered(reason) }).toEqual({ reason, retry: false })
    }
  })

  it('AC-8.5 (031 verify) the translation fills a hostile name once, literally, and never expands it again', () => {
    const name = '$& $1 {name} {x} </span><img src=x>'
    expect(translatePwa('en', 'remote.pwa.attach.type', { name })).toBe(`“${name}” is a type Alma does not accept.`)
    expect(translatePwa('es', 'remote.pwa.attach.remove', { name: '{name}' })).toBe('Quitar «{name}»')
  })
})

describe('031 verify: status, button and composer rules', () => {
  const status = { scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: true }, sensitive: false, continue: true }

  it('AC-1.9 (031 verify) the "what this phone can do" list ends with Send files, on only for a real true', () => {
    const last = (value: unknown) => canList({ ...status, sendFiles: value } as never).at(-1)
    expect(last(true)).toEqual({ key: 'remote.pwa.can.attach', on: true })
    for (const value of [false, undefined, null, 'true', 1, {}, []]) expect(last(value)).toEqual({ key: 'remote.pwa.can.attach', on: false })
    expect(canList(status).at(-1)).toEqual({ key: 'remote.pwa.can.attach', on: false })
    expect(canList(status)).toHaveLength(9)
  })

  it('AC-8.4 (031 verify) the attach button is disabled with the switch-off reason unless the last status said files are allowed', () => {
    expect(attachButton(null)).toEqual({ enabled: false, reason: 'remote.pwa.attach.off' })
    expect(attachButton({ ...status, sendFiles: false })).toEqual({ enabled: false, reason: 'remote.pwa.attach.off' })
    expect(attachButton(status)).toEqual({ enabled: false, reason: 'remote.pwa.attach.off' })
    expect(attachButton({ ...status, sendFiles: 'yes' } as never).enabled).toBe(false)
    expect(attachButton({ ...status, sendFiles: true })).toEqual({ enabled: true, reason: null })
  })

  it('AC-1.9 (031 verify) the status read keeps only the known booleans and reads a missing or non-boolean sendFiles as off', async () => {
    const reply = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body })
    const base = { scopes: { chat: true, approve: false, home: false, cameras: false, vault: false, history: false }, sensitive: false, continue: false }
    const on = await fetchStatus({ fetch: reply({ ...base, sendFiles: true, secret: 'LEAK', extra: { a: 1 } }), token: 't' })
    expect(on).toEqual({ ok: true, status: { ...base, sendFiles: true } })
    for (const junk of [undefined, 'true', 1, null]) {
      const out = await fetchStatus({ fetch: reply({ ...base, ...(junk === undefined ? {} : { sendFiles: junk }) }), token: 't' })
      expect(out.ok && out.status.sendFiles).toBeFalsy()
      expect(out.ok && 'sendFiles' in out.status).toBe(false)
    }
  })

  it('AC-4.1 (031 verify) the composer accepts a blank text only with a ready file, and the 8000 limit holds with files', () => {
    expect(validateChatInput('', 0)).toEqual({ ok: false, reason: 'empty' })
    expect(validateChatInput('   ', 0)).toEqual({ ok: false, reason: 'empty' })
    expect(validateChatInput('', 1)).toEqual({ ok: true })
    expect(validateChatInput('  ', 5)).toEqual({ ok: true })
    expect(validateChatInput('a'.repeat(8000), 1)).toEqual({ ok: true })
    expect(validateChatInput('a'.repeat(8001), 1)).toEqual({ ok: false, reason: 'too-long' })
    expect(validateChatInput('a'.repeat(8001), 0)).toEqual({ ok: false, reason: 'too-long' })
    expect(validateChatInput('hola')).toEqual({ ok: true })
  })

  it('AC-4.1 (031 verify) the length the phone allows is the length the PC accepts, for a text made of surrogate pairs', async () => {
    const { chatSendBody } = await import('../src/shared/remote/api')
    for (const text of ['😀'.repeat(4000), '😀'.repeat(4001), 'a'.repeat(8000), 'a'.repeat(8001), '😀'.repeat(8000)]) {
      const phone = validateChatInput(text, 1).ok
      const pc = chatSendBody.safeParse({ text, attachments: ['x'] }).success
      expect({ units: text.length, phone, pc }).toEqual({ units: text.length, phone, pc: phone })
    }
    expect(REMOTE_LIMITS.chatChars).toBe(8000)
  })

  it('AC-5.1 (031 verify) the phone keeps only name, kind and size of each well-formed attachment, and none for anything else', () => {
    const views = readAttachmentViews([
      { id: 'ID', name: 'a.txt', kind: 'text', size: 3, path: 'P' },
      { name: 'b.png', kind: 'image', size: 0 },
      { name: 'c', kind: 'exe', size: 1 },
      { name: 5, kind: 'text', size: 1 },
      { name: 'd', kind: 'text', size: -1 },
      { name: 'd', kind: 'text', size: Number.NaN },
      { name: 'e', kind: 'text', size: Number.POSITIVE_INFINITY },
      { name: 'f', kind: 'text', size: '3' },
      null,
      'x',
      7,
      []
    ])
    expect(views).toEqual([{ name: 'a.txt', kind: 'text', size: 3 }, { name: 'b.png', kind: 'image', size: 0 }])
    for (const junk of [undefined, null, 'x', 5, {}, [], [null]]) expect(readAttachmentViews(junk)).toBeUndefined()
    expect(readAttachmentViews([{ name: '__proto__', kind: 'toString', size: 1 }])).toBeUndefined()
  })
})

describe('031 verify: putting and removing from the phone', () => {
  const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const stored = { ok: true, attachment: { id: 'ID1', name: 'a.txt', kind: 'text', size: 3 } }

  it('AC-8.3 (031 verify) a put goes to the shared route or the by-id route with the bearer token and the whole body, and carries the abort signal', async () => {
    const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } }[] = []
    const fetcher: FetchLike = async (url, init) => {
      calls.push({ url, init: init ?? {} })
      return reply(200, stored)
    }
    const controller = new AbortController()
    const data = { name: 'a.txt', size: 3, base64: 'YWJj' }
    expect(await putFile({ fetch: fetcher, token: 'tok', target: {}, file: data, signal: controller.signal })).toEqual({ ok: true, attachment: stored.attachment })
    expect(await putFile({ fetch: fetcher, token: 'tok', target: { id: 'T1' }, file: data })).toMatchObject({ ok: true })
    expect(calls[0].url).toBe('/api/chat/attach')
    expect(calls[1].url).toBe('/api/threads/attach')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers?.authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body ?? '')).toEqual(data)
    expect(JSON.parse(calls[1].init.body ?? '')).toEqual({ id: 'T1', ...data })
    expect(calls[0].init.signal).toBe(controller.signal)
  })

  it('AC-8.6 (031 verify) a dropped connection, an abort, a non-JSON answer and a nonsense 200 are all the PC not answering', async () => {
    const data = { name: 'a.txt', size: 3, base64: 'YWJj' }
    const run = (fetcher: never) => putFile({ fetch: fetcher, token: 't', target: {}, file: data })
    expect(await run((async () => { throw new TypeError('Failed to fetch') }) as never)).toEqual({ ok: false, reason: 'network' })
    const aborted = new AbortController()
    aborted.abort()
    const abortAware = (async (_: string, init: { signal?: AbortSignal }) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return reply(200, stored)
    }) as never
    expect(await putFile({ fetch: abortAware, token: 't', target: {}, file: data, signal: aborted.signal })).toEqual({ ok: false, reason: 'network' })
    for (const body of [null, 'nope', [], {}, { ok: true }, { attachment: null }, { attachment: { id: 5, name: 'a', kind: 'text', size: 1 } }, { attachment: { id: 'x', name: 'a', kind: 'exe', size: 1 } }, { attachment: { id: 'x', name: 'a', kind: 'text', size: '1' } }, { attachment: { id: 'x', kind: 'text', size: 1 } }]) {
      expect({ body, out: await run((async () => reply(200, body)) as never) }).toEqual({ body, out: { ok: false, reason: 'network' } })
    }
    expect(await run((async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } })) as never)).toEqual({ ok: false, reason: 'network' })
  })

  it('AC-8.5 (031 verify) the PC\'s named refusals come back by name; an unknown name falls back to the status, then to the PC not answering', async () => {
    const data = { name: 'a.txt', size: 3, base64: 'YWJj' }
    const run = (status: number, body: unknown) => putFile({ fetch: (async () => reply(status, body)) as never, token: 't', target: {}, file: data })
    const named: [number, string][] = [[403, 'attach-off'], [403, 'notice-needed'], [422, 'secret-name'], [415, 'file-type'], [422, 'file-content'], [422, 'file-empty'], [422, 'file-malformed'], [409, 'too-many'], [409, 'busy'], [404, 'gone'], [500, 'storage'], [413, 'too-large'], [429, 'rate-limited'], [401, 'unknown-device']]
    for (const [status, error] of named) expect({ error, out: await run(status, { error }) }).toEqual({ error, out: { ok: false, reason: error } })
    expect(await run(500, { error: 'weird' })).toEqual({ ok: false, reason: 'network' })
    expect(await run(413, {})).toEqual({ ok: false, reason: 'too-large' })
    expect(await run(403, { error: 'weird' })).toEqual({ ok: false, reason: 'scope-off' })
    expect(await run(500, null)).toEqual({ ok: false, reason: 'network' })
    expect(await run(500, { error: 'failed' })).toEqual({ ok: false, reason: 'network' })
  })

  it('AC-3.2 (031 verify) the remove call is a POST of the id and reports ok for a 200 whatever the id was', async () => {
    const seen: string[] = []
    const fetcher = (async (url: string, init: { body?: string }) => {
      seen.push(`${url} ${init.body}`)
      return reply(200, { ok: true })
    }) as never
    expect(await removeUpload({ fetch: fetcher, token: 't', id: 'abc' })).toEqual({ ok: true })
    expect(seen).toEqual(['/api/attachments/remove {"id":"abc"}'])
    expect(await removeUpload({ fetch: (async () => { throw new Error('offline') }) as never, token: 't', id: 'abc' })).toEqual({ ok: false, reason: 'network' })
  })
})

describe('031 verify: the composer flow (AC-8.3, AC-8.6, BR-14, BR-19)', () => {
  type PutResult = { ok: true; attachment: { id: string; name: string; kind: 'text'; size: number } } | { ok: false; reason: Failure }
  function harness(options: { shrink?: (f: File) => Promise<File | null> } = {}) {
    const puts: { file: { name: string; size: number; base64: string }; signal: AbortSignal; resolve(out: PutResult): void }[] = []
    const removes: string[] = []
    let shrinks = 0
    const flow = createAttachFlow({
      put: (payload, signal) =>
        new Promise((resolve) => {
          puts.push({ file: payload, signal, resolve: resolve as never })
        }),
      remove: async (id) => void removes.push(id),
      shrink: async (picked) => {
        shrinks += 1
        return options.shrink ? options.shrink(picked) : null
      }
    })
    return { flow, puts, removes, shrinks: () => shrinks }
  }
  const stored = (id: string, name = 'a.txt'): PutResult => ({ ok: true, attachment: { id, name, kind: 'text', size: 1 } })

  it('AC-8.3 (031 verify) chips upload one at a time, in the order picked, and the next starts only when the previous finished', async () => {
    const { flow, puts } = harness()
    flow.add([file('a.txt'), file('b.txt'), file('c.txt')])
    await flush()
    expect(puts.map((p) => p.file.name)).toEqual(['a.txt'])
    expect(flow.get().map((c) => c.state)).toEqual(['uploading', 'preparing', 'preparing'])
    puts[0].resolve(stored('A'))
    await flush()
    expect(puts.map((p) => p.file.name)).toEqual(['a.txt', 'b.txt'])
    puts[1].resolve({ ok: false, reason: 'secret-name' })
    await flush()
    expect(puts.map((p) => p.file.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    puts[2].resolve(stored('C', 'c.txt'))
    await flush()
    expect(flow.get().map((c) => [c.name, c.state, c.id, c.reason])).toEqual([['a.txt', 'ready', 'A', undefined], ['b.txt', 'failed', undefined, 'secret-name'], ['c.txt', 'ready', 'C', undefined]])
    expect(flow.readyIds()).toEqual(['A', 'C'])
    expect(canSendNow(flow.get(), '', false)).toBe(true)
  })

  it('AC-8.3 (031 verify) the send button stays off from the pick until the last upload ends', async () => {
    const { flow, puts } = harness()
    flow.add([file('a.txt')])
    expect(canSendNow(flow.get(), 'hola', false)).toBe(false)
    await flush()
    expect(canSendNow(flow.get(), 'hola', false)).toBe(false)
    puts[0].resolve(stored('A'))
    await flush()
    expect(canSendNow(flow.get(), 'hola', false)).toBe(true)
  })

  it('AC-8.1 (031 verify) a refused file never reaches the network: type, sixth chip, GIF over the limit, picture that cannot shrink', async () => {
    const { flow, puts, shrinks } = harness()
    const big = (name: string) => new File([new Uint8Array(700_001)], name)
    flow.add([file('x.svg'), big('big.gif'), big('big.pdf'), big('big.png')])
    await flush()
    expect(puts).toEqual([])
    expect(flow.get().map((c) => [c.name, c.state, c.reason])).toEqual([
      ['x.svg', 'failed', 'file-type'],
      ['big.gif', 'failed', 'too-large'],
      ['big.pdf', 'failed', 'too-large'],
      ['big.png', 'failed', 'too-large']
    ])
    expect(shrinks()).toBe(1)
    const held = harness()
    held.flow.add(['1', '2', '3', '4', '5', '6'].map((n) => file(`${n}.txt`)))
    await flush()
    expect(held.flow.get().at(-1)).toMatchObject({ name: '6.txt', state: 'failed', reason: 'too-many' })
  })

  it('AC-8.1 (031 verify) a shrunk picture is the one uploaded, under its new name and real size', async () => {
    const { flow, puts } = harness({ shrink: async () => new File([new Uint8Array(1000).fill(7)], 'imagen-5.jpg', { type: 'image/jpeg' }) })
    flow.add([new File([new Uint8Array(900_000)], 'foto.png')])
    await flush()
    expect(puts).toHaveLength(1)
    expect(puts[0].file).toMatchObject({ name: 'imagen-5.jpg', size: 1000 })
    expect(puts[0].file.base64).toBe(Buffer.alloc(1000, 7).toString('base64'))
  })

  it('AC-8.3 (031 verify) the size sent is the real byte count of what was read, not what the file claims', async () => {
    const liar = { name: 'a.txt', size: 5, arrayBuffer: async () => new Uint8Array(12).fill(1).buffer } as unknown as File
    const { flow, puts } = harness()
    flow.add([liar])
    await flush()
    expect(puts[0].file.size).toBe(12)
    expect(decodedLength(puts[0].file.base64)).toBe(12)
  })

  it('AC-8.3 (031 verify) a file the phone cannot read is a failed chip with the reason unreadable, and the next file still goes', async () => {
    const { flow, puts } = harness()
    const broken = { name: 'a.txt', size: 5, arrayBuffer: async () => Promise.reject(new Error('NotReadableError')) } as unknown as File
    flow.add([broken, file('b.txt')])
    await flush()
    expect(flow.get()[0]).toMatchObject({ state: 'failed', reason: 'unreadable' })
    expect(puts.map((p) => p.file.name)).toEqual(['b.txt'])
  })

  it('AC-8.3 (031 verify) removing an uploading chip aborts its request; if the PC stored it anyway, the file is removed best-effort', async () => {
    const { flow, puts, removes } = harness()
    flow.add([file('a.txt')])
    await flush()
    const key = flow.get()[0].key
    flow.remove(key)
    expect(puts[0].signal.aborted).toBe(true)
    expect(flow.get()).toEqual([])
    puts[0].resolve(stored('LATE'))
    await flush()
    expect(removes).toEqual(['LATE'])
    expect(flow.get()).toEqual([])
  })

  it('AC-8.3 (031 verify) removing a ready chip asks the PC to remove it, once', async () => {
    const { flow, puts, removes } = harness()
    flow.add([file('a.txt')])
    await flush()
    puts[0].resolve(stored('A'))
    await flush()
    flow.remove(flow.get()[0].key)
    flow.remove('chip-1')
    expect(removes).toEqual(['A'])
  })

  it('AC-8.6 (031 verify) a failed upload is a failed chip, nothing is replayed, and retry by hand re-adds that file once', async () => {
    const { flow, puts } = harness()
    flow.add([file('a.txt'), file('b.txt')])
    await flush()
    puts[0].resolve({ ok: false, reason: 'not-delivered' })
    await flush()
    expect(flow.get()[0]).toMatchObject({ state: 'failed', reason: 'network' })
    expect(puts).toHaveLength(2)
    puts[1].resolve(stored('B', 'b.txt'))
    await flush()
    expect(puts).toHaveLength(2)
    flow.retry(flow.get()[0].key)
    await flush()
    expect(puts.map((p) => p.file.name)).toEqual(['a.txt', 'b.txt', 'a.txt'])
    expect(flow.get().filter((c) => c.name === 'a.txt')).toHaveLength(1)
    const ready = flow.get().find((c) => c.state === 'ready')
    flow.retry(ready?.key ?? '')
    await flush()
    expect(puts).toHaveLength(3)
  })

  it('AC-8.6 (031 verify) a put that throws is the PC not answering and does not stall the queue', async () => {
    const flow = createAttachFlow({
      put: async (payload) => {
        if (payload.base64 === Buffer.from('A').toString('base64')) throw new Error('offline')
        return stored('OK')
      },
      remove: async () => undefined,
      shrink: async () => null
    })
    flow.add([new File(['A'], 'a.txt'), new File(['B'], 'b.txt')])
    await flush()
    expect(flow.get().map((c) => [c.state, c.reason])).toEqual([['failed', 'network'], ['ready', undefined]])
  })

  it('AC-8.7 (031 verify) a send refused as unavailable expires the ready chips so they can be attached again; accepted clears everything', async () => {
    const { flow, puts } = harness()
    flow.add([file('a.txt'), file('b.txt')])
    await flush()
    puts[0].resolve(stored('A'))
    await flush()
    puts[1].resolve(stored('B', 'b.txt'))
    await flush()
    flow.sent({ ok: false, reason: 'busy' })
    expect(flow.get().map((c) => c.state)).toEqual(['ready', 'ready'])
    flow.sent({ ok: false, reason: 'unavailable' })
    expect(flow.get().map((c) => [c.state, c.reason])).toEqual([['failed', 'unavailable'], ['failed', 'unavailable']])
    expect(flow.readyIds()).toEqual([])
    flow.sent({ ok: true })
    expect(flow.get()).toEqual([])
  })

  it('AC-8.3 (031 verify) leaving the screen aborts what is uploading and deletes what is ready', async () => {
    const { flow, puts, removes } = harness()
    flow.add([file('a.txt'), file('b.txt')])
    await flush()
    puts[0].resolve(stored('A'))
    await flush()
    flow.dispose()
    expect(puts[1].signal.aborted).toBe(true)
    expect(removes).toEqual(['A'])
    expect(flow.get()).toEqual([])
  })

  it('AC-8.3 (031 verify) a subscriber is told about every change and can unsubscribe', async () => {
    const { flow } = harness()
    const listener = vi.fn()
    const off = flow.subscribe(listener)
    flow.add([file('x.svg')])
    expect(listener).toHaveBeenCalled()
    off()
    const calls = listener.mock.calls.length
    flow.add([file('y.svg')])
    expect(listener.mock.calls.length).toBe(calls)
  })
})
