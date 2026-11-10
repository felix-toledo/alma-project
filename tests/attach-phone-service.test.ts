import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PhoneFiles, refusalOf } from '../src/coordinator/attachments/phone'
import { AttachmentStore } from '../src/coordinator/attachments/store'
import { erasePersonalFiles, exportPersonalData } from '../src/coordinator/privacy'
import { PHONE_ATTACH } from '../src/shared/attach/phone'
import type { RefusalReason } from '../src/shared/attach/rules'
import { defaultSettings } from '../src/shared/defaults'
import type { Refusal } from '../src/shared/remote/api'
import type { ProviderId, Settings, Thread } from '../src/shared/types'
import { buildJpeg, buildPng, buildWebp, contains, MARKERS } from './support/attach-fixtures'

// Anything that reaches a model provider goes through this module: a put must never call it (AC-1.1).
const getProvider = vi.hoisted(() => vi.fn())
vi.mock('../src/coordinator/providers', () => ({ getProvider }))

let inbox: string
let settings: Settings
let threads: Record<string, Thread>
let store: AttachmentStore

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'alma-phone-files-'))
  settings = defaultSettings()
  // the conversation's agent is on meta; pictures are read by xai, so a picture owes two providers
  settings.images.vision = { provider: 'xai', model: 'grok-vision' }
  settings.attachments.noticeAcknowledged = ['meta', 'xai']
  threads = { t1: { id: 't1', agentId: 'general', channel: undefined } as unknown as Thread }
  store = new AttachmentStore(inbox)
  getProvider.mockClear()
})
afterEach(() => rmSync(inbox, { recursive: true, force: true }))

const files = (over: { settings?: () => Settings } = {}) => new PhoneFiles({ store, threads: { get: (id) => threads[id] }, settings: over.settings ?? (() => settings), env: () => ({}) })
const root = () => join(inbox, 'attachments')
const onDisk = (): string[] => (existsSync(root()) ? readdirSync(root(), { recursive: true }).map(String).sort() : [])
const request = (name: string, bytes: Uint8Array | string, extra: Record<string, unknown> = {}) => {
  const data = Buffer.from(bytes)
  return { threadId: 't1', name, size: data.length, base64: data.toString('base64'), ...extra }
}
const put = (name: string, bytes: Uint8Array | string, extra: Record<string, unknown> = {}) => files().put(request(name, bytes, extra))
const refused = (reason: Refusal) => ({ ok: false, reason })

describe('PhoneFiles.put: the rules in order (spec 031 T17)', () => {
  it('AC-2.2 (031) the PC classifies the bytes it received', () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40, 1)])
    expect(put('photo.png', exe)).toEqual(refused('file-content'))
    expect(put('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual(refused('file-type'))
    expect(put('page.html', '<html></html>')).toEqual(refused('file-type'))
    expect(put('bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toEqual(refused('file-type'))
    expect(put('README', 'hello')).toEqual(refused('file-type'))
    expect(put('tool.exe', exe)).toEqual(refused('file-type'))
    expect(put('report.pdf.exe', '%PDF-1.4')).toEqual(refused('file-type'))
    expect(put('notes.txt', Buffer.from('hola', 'utf16le'))).toEqual(refused('file-content'))
    expect(put('doc.pdf', 'not a pdf')).toEqual(refused('file-content'))
    // the NUL byte rule looks at the first 8000 bytes: index 7999 is inside, 8000 is outside
    expect(put('a.txt', Buffer.concat([Buffer.alloc(7999, 97), Buffer.from([0])]))).toEqual(refused('file-content'))
    expect(put('b.txt', Buffer.concat([Buffer.alloc(8000, 97), Buffer.from([0])]))).toMatchObject({ ok: true })
    // nothing from a refusal reaches the disk: the one accepted file is the folder, its file and its record
    expect(onDisk()).toHaveLength(3)
  })

  it('AC-2.2 (031) an empty file is refused with its own reason', () => {
    expect(put('empty.txt', '')).toEqual(refused('file-empty'))
    expect(onDisk()).toEqual([])
  })

  it('AC-2.3 (031) the decoded byte count decides', () => {
    const big = Buffer.alloc(PHONE_ATTACH.maxFileBytes + 1, 97)
    // the claim says 10 bytes; the bytes say 700 001
    expect(put('big.txt', big, { size: 10 })).toEqual(refused('too-large'))
    expect(put('big.txt', big)).toEqual(refused('too-large'))
    expect(onDisk()).toEqual([])
    // exactly the limit passes, even when the claim is wrong
    const limit = Buffer.alloc(PHONE_ATTACH.maxFileBytes, 97)
    expect(put('limit.txt', limit, { size: 3 })).toMatchObject({ ok: true, attachment: { size: PHONE_ATTACH.maxFileBytes } })
    // bad base64 is not something to store
    expect(files().put({ threadId: 't1', name: 'a.txt', size: 3, base64: 'AA*A' })).toEqual(refused('invalid'))
  })

  it('AC-2.4 (031) secret-looking names are refused with no override', () => {
    for (const name of ['.env', '.env.local', 'a.pem', 'id_rsa', 'passwords.xlsx', '.ENV', 'ID_RSA', 'KEY.PEM']) {
      expect(put(name, 'plain text'), name).toEqual(refused('secret-name'))
    }
    expect(onDisk()).toEqual([])
    expect(put('environment.txt', 'plain text')).toMatchObject({ ok: true })
  })

  it('AC-2.8 (031) a provider that was not acknowledged refuses with notice-needed', () => {
    settings.attachments.noticeAcknowledged = []
    expect(put('notes.txt', 'hello')).toEqual(refused('notice-needed'))
    settings.attachments.noticeAcknowledged = ['meta']
    expect(put('notes.txt', 'hello')).toMatchObject({ ok: true })
    // a picture is read by the vision provider too
    expect(put('shot.png', buildPng({ metadata: false }))).toEqual(refused('notice-needed'))
    settings.attachments.noticeAcknowledged = ['xai']
    expect(put('notes.txt', 'hello')).toEqual(refused('notice-needed'))
    settings.attachments.noticeAcknowledged = ['meta', 'xai'] satisfies ProviderId[]
    expect(put('shot.png', buildPng({ metadata: false }))).toMatchObject({ ok: true })
    expect(onDisk().filter((entry) => entry.endsWith('.json'))).toHaveLength(2)
  })

  it('AC-2.2 (031) the order is size, secret name, classification, notice', () => {
    settings.attachments.noticeAcknowledged = []
    const big = Buffer.alloc(PHONE_ATTACH.maxFileBytes + 1, 97)
    expect(put('.env', big)).toEqual(refused('too-large'))
    expect(put('.env', 'MZ')).toEqual(refused('secret-name'))
    expect(put('tool.exe', 'MZ')).toEqual(refused('file-type'))
    expect(put('doc.pdf', 'not a pdf')).toEqual(refused('file-content'))
    expect(put('empty.txt', '')).toEqual(refused('file-empty'))
    expect(put('notes.txt', 'hello')).toEqual(refused('notice-needed'))
  })

  it('AC-2.6 (031) an unknown conversation stores nothing', () => {
    expect(put('notes.txt', 'hello', { threadId: 'nope' })).toEqual(refused('gone'))
    expect(onDisk()).toEqual([])
  })

  it('AC-1.1 (031) a put sends nothing to any provider', () => {
    expect(put('notes.txt', 'hello')).toMatchObject({ ok: true })
    expect(put('shot.png', buildPng({ metadata: true }))).toMatchObject({ ok: true })
    expect(put('tool.exe', 'MZ')).toEqual(refused('file-type'))
    expect(getProvider).not.toHaveBeenCalled()
  })
})

describe('PhoneFiles.put: store, strip, failure (spec 031 T18)', () => {
  const storedBytes = (id: string): Buffer => {
    const found = store.lookup(id)
    if (found.state !== 'present') throw new Error('not stored')
    return readFileSync(found.path)
  }
  const id = (result: ReturnType<typeof put>): string => {
    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    return result.attachment.id
  }

  it('AC-2.1 (031) a valid file is stored through the 030 store, bound to the target conversation, and answers id, name, kind, size', () => {
    threads.t2 = { id: 't2', agentId: 'general' } as unknown as Thread
    const result = put('my notes.txt', 'hello', { threadId: 't2' })
    expect(result).toEqual({ ok: true, attachment: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'my notes.txt', kind: 'text', size: 5 } })
    const found = store.lookup(id(result))
    expect(found).toMatchObject({ state: 'present', record: { threadId: 't2', originalName: 'my notes.txt', size: 5, kind: 'text' } })
    // the answer carries exactly the four fields the phone may see
    if (result.ok) expect(Object.keys(result.attachment).sort()).toEqual(['id', 'kind', 'name', 'size'])
  })

  it('AC-2.5 (031) a stored picture has no metadata whatever the phone did', () => {
    const jpeg = buildJpeg({ metadata: true })
    const png = buildPng({ metadata: true })
    const webp = buildWebp({ metadata: true, vp8x: true })
    for (const [name, original, marker] of [
      ['a.jpg', jpeg, MARKERS.gps],
      ['b.png', png, MARKERS.gps],
      ['c.webp', webp, MARKERS.exifWebp],
    ] as const) {
      expect(contains(original, marker), name).toBe(true)
      const bytes = storedBytes(id(put(name, original)))
      expect(contains(bytes, marker), name).toBe(false)
    }
  })

  it('AC-2.5 (031) a malformed picture is refused and never stored', () => {
    expect(put('cut.png', buildPng({ metadata: true }).slice(0, 40))).toEqual(refused('file-malformed'))
    expect(put('cut.jpg', buildJpeg({ metadata: true }).slice(0, 30))).toEqual(refused('file-malformed'))
    expect(onDisk()).toEqual([])
  })

  it('AC-2.11 (031) a failing write answers storage and leaves no file and no record', () => {
    const failing = (io: ConstructorParameters<typeof AttachmentStore>[1]) => new PhoneFiles({ store: new AttachmentStore(inbox, io), threads: { get: (id) => threads[id] }, settings: () => settings, env: () => ({}) })
    const full = failing({
      io: {
        writeFileSync: () => {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        },
      },
    })
    expect(full.put(request('a.txt', 'hello'))).toEqual(refused('storage'))
    expect(onDisk()).toEqual([])
    const half = failing({
      io: {
        renameSync: () => {
          throw new Error('EPERM')
        },
      },
    })
    expect(half.put(request('b.txt', 'hello'))).toEqual(refused('storage'))
    expect(onDisk()).toEqual([])
  })

  it('AC-2.6 (031) a company conversation is refused even if the flow let it through', () => {
    settings.agents.push({ ...settings.agents[0], id: 'boss', companyId: 'c1' })
    threads.co = { id: 'co', agentId: 'boss' } as unknown as Thread
    expect(put('notes.txt', 'hello', { threadId: 'co' })).toEqual(refused('gone'))
    expect(onDisk()).toEqual([])
  })
})

describe('refusalOf (spec 031 T19)', () => {
  it('AC-8.5 (031) refusalOf maps every 030 reason to one wire refusal', () => {
    // a Record over the union: a 030 reason added without a line here is a type error
    const expected: Record<RefusalReason, Refusal> = {
      type: 'file-type',
      content: 'file-content',
      empty: 'file-empty',
      'too-big': 'too-large',
      total: 'too-large',
      'too-many': 'too-many',
      unreadable: 'invalid',
      'malformed-image': 'file-malformed',
      storage: 'storage',
      company: 'gone',
      'bad-payload': 'invalid',
    }
    for (const [reason, refusal] of Object.entries(expected) as [RefusalReason, Refusal][]) expect(refusalOf(reason), reason).toBe(refusal)
    // the store's company reason never goes out under its own name: the phone cannot tell it from an unknown conversation
    expect(Object.values(expected)).not.toContain('company')
    // the reasons the phone words differently stay distinct on the wire
    const phoneVisible = ['type', 'content', 'empty', 'too-big', 'too-many', 'malformed-image', 'storage'] as const
    expect(new Set(phoneVisible.map(refusalOf)).size).toBe(phoneVisible.length)
  })
})

describe('PhoneFiles.remove (spec 031 T24 support)', () => {
  it('AC-3.1 (031) remove deletes a stored file and its record through the 030 store, and ignores an unknown id', () => {
    const stored = put('a.txt', 'hello')
    if (!stored.ok) throw new Error('setup')
    expect(onDisk()).toHaveLength(3)
    files().remove('not-an-id')
    expect(onDisk()).toHaveLength(3)
    files().remove(stored.attachment.id)
    expect(onDisk()).toEqual([])
  })
})

describe('PhoneFiles.readersOwed (spec 031 T31)', () => {
  const stored = (name: string, bytes: Uint8Array | string): string => {
    const result = put(name, bytes)
    if (!result.ok) throw new Error('setup')
    return result.attachment.id
  }

  it('AC-4.3 (031) readersOwed names the providers a send would still owe a notice, by the conversation as it is at send', () => {
    const text = stored('notes.txt', 'hello')
    const picture = stored('shot.png', buildPng({ metadata: false }))
    // acknowledged at put (the beforeEach list): nothing owed
    expect(files().readersOwed('t1', [text, picture])).toEqual([])
    // the conversation's agent changed after the put: its provider is not acknowledged
    threads.t1 = { ...threads.t1, model: { provider: 'anthropic', model: 'claude-x' } } as unknown as Thread
    expect(files().readersOwed('t1', [text])).toEqual(['anthropic'])
    // a picture adds the vision provider
    threads.t1 = { id: 't1', agentId: 'general' } as unknown as Thread
    settings.attachments.noticeAcknowledged = ['meta']
    expect(files().readersOwed('t1', [text])).toEqual([])
    expect(files().readersOwed('t1', [picture])).toEqual(['xai'])
  })

  it('AC-4.3 (031) readersOwed owes nothing for a conversation or an id it does not know', () => {
    const text = stored('notes.txt', 'hello')
    settings.attachments.noticeAcknowledged = []
    expect(files().readersOwed('nope', [text])).toEqual([])
    expect(files().readersOwed('t1', ['not-an-id'])).toEqual([])
    expect(files().readersOwed('t1', [])).toEqual([])
  })
})

describe('erase and export with files from the phone (spec 031 T35)', () => {
  it('AC-3.4 (031) erase removes a file from the phone with the store, and export excludes it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-phone-export-'))
    const target = mkdtempSync(join(tmpdir(), 'alma-phone-export-target-'))
    try {
      const phoneStore = new AttachmentStore(join(dataDir, 'inbox'))
      const phone = new PhoneFiles({ store: phoneStore, threads: { get: (id) => threads[id] }, settings: () => settings, env: () => ({}) })
      const result = phone.put(request('NAMEMARKER-phone.txt', 'CONTENTMARKER-phone'))
      if (!result.ok) throw new Error('setup')
      const out = exportPersonalData(dataDir, target)
      const names = readdirSync(out, { recursive: true }).map(String)
      expect(names.filter((name) => /inbox|attachments/.test(name) || name.includes(result.attachment.id) || name.includes('NAMEMARKER'))).toEqual([])
      erasePersonalFiles(join(dataDir, 'inbox'))
      expect(phoneStore.lookup(result.attachment.id)).toEqual({ state: 'unknown' })
      expect(phoneStore.records()).toEqual([])
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})
