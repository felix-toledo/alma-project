import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAttachmentTool } from '../src/coordinator/attachments/read-tool'
import { AttachmentStore } from '../src/coordinator/attachments/store'
import { attachmentLog, countsAsOpened, scheduleSweep } from '../src/coordinator/attachments/service'
import { erasePersonalFiles, exportPersonalData } from '../src/coordinator/privacy'
import { ThreadStore } from '../src/coordinator/store'
import { planSweep } from '../src/shared/attach/sweep'
import { audit, initAudit } from '../src/shared/audit'
import { defaultSettings } from '../src/shared/defaults'
import { buildPng, contains, MARKERS } from './support/attach-fixtures'

let inbox: string
let now: number
const clock = () => now

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'alma-attach-'))
  now = 1_700_000_000_000
})
afterEach(() => rmSync(inbox, { recursive: true, force: true }))

const root = () => join(inbox, 'attachments')
const onDisk = (): string[] => (existsSync(root()) ? readdirSync(root(), { recursive: true }).map(String).sort() : [])
const request = (name: string, bytes: Uint8Array | string, extra: Record<string, unknown> = {}) => {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes)
  return { threadId: 't1', name, size: data.length, base64: data.toString('base64'), ...extra }
}
const stored = (store: AttachmentStore, name: string, bytes: Uint8Array | string, threadId = 't1') => {
  const result = store.store(request(name, bytes, { threadId }))
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  return result.attachment
}

describe('AttachmentStore.store (spec 030 T19)', () => {
  it('AC-1.1 (030) a valid file is stored with a record', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const result = store.store(request('notes.txt', 'hello'))
    expect(result).toMatchObject({ ok: true, attachment: { name: 'notes.txt', kind: 'text', size: 5 } })
    if (!result.ok) return
    expect(result.attachment.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('AC-5.3 (030) layout and record', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const { id } = stored(store, 'my notes.txt', 'hello')
    expect(onDisk()).toEqual([id, `${id}.json`, join(id, 'my_notes.txt')].sort())
    expect(readFileSync(join(root(), id, 'my_notes.txt'), 'utf8')).toBe('hello')
    expect(JSON.parse(readFileSync(join(root(), `${id}.json`), 'utf8'))).toEqual({
      id,
      threadId: 't1',
      originalName: 'my notes.txt',
      storedName: 'my_notes.txt',
      size: 5,
      kind: 'text',
      createdAt: now,
    })
  })

  it('AC-5.1 (030) a hostile name cannot leave its folder', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const { id } = stored(store, '..\\..\\evil.txt', 'x')
    expect(onDisk()).toEqual([id, `${id}.json`, join(id, '_.._evil.txt')].sort())
  })

  it('AC-5.6 (030) the same file twice is stored twice', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const a = stored(store, 'same.txt', 'hello')
    const b = stored(store, 'same.txt', 'hello')
    expect(a.id).not.toBe(b.id)
    expect(onDisk()).toHaveLength(6)
  })

  it('AC-2.6 (030) the coordinator rejects a bad payload before writing', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const good = request('a.txt', 'hello')
    const bad: unknown[] = [
      { ...good, base64: 'aGVsbG8' }, // bad padding
      { ...good, base64: 'aGV sbG8=' }, // whitespace
      { ...good, base64: '' },
      { ...good, size: 4 }, // claimed size differs from the bytes
      { ...good, extra: 1 },
      { ...good, name: '' },
      { ...good, threadId: '' },
      null,
      'a.txt',
    ]
    for (const payload of bad) expect(store.store(payload as never), JSON.stringify(payload)).toEqual({ ok: false, reason: 'bad-payload' })
    // G14: nothing at all is an empty file, not a malformed one
    expect(store.store({ ...good, size: 0, base64: '' })).toEqual({ ok: false, reason: 'empty' })
    expect(onDisk()).toEqual([])
  })

  it('AC-2.2 (030) the coordinator re-checks the real size', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const big = 'a'.repeat(2_097_153)
    // the renderer claims a small file; the bytes are over the limit
    expect(store.store(request('big.txt', big, { size: 10 }))).toEqual({ ok: false, reason: 'too-big' })
    // the renderer is honest about it
    expect(store.store(request('big.txt', big))).toEqual({ ok: false, reason: 'too-big' })
    expect(onDisk()).toEqual([])
    // the boundary itself passes
    expect(store.store(request('edge.txt', 'a'.repeat(2_097_152))).ok).toBe(true)
  })

  it('AC-2.1 (030) the coordinator re-classifies the bytes', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    expect(store.store(request('photo.png', 'MZ\u0090\u0000\u0003'))).toEqual({ ok: false, reason: 'content' })
    expect(store.store(request('run.exe', 'MZ'))).toEqual({ ok: false, reason: 'type' })
    expect(store.store(request('page.html', '<html>'))).toEqual({ ok: false, reason: 'type' })
    expect(onDisk()).toEqual([])
  })

  it('AC-3.3 (030) a stored picture has no metadata and the original is untouched', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const original = buildPng({ metadata: true })
    const copy = new Uint8Array(original)
    expect(contains(original, MARKERS.gps)).toBe(true)
    const payload = request('shot.png', original)
    const { id, size } = stored(store, 'shot.png', original)
    const bytes = readFileSync(join(root(), id, 'shot.png'))
    expect(contains(bytes, MARKERS.gps)).toBe(false)
    expect(Buffer.from(bytes).equals(Buffer.from(buildPng({ metadata: false })))).toBe(true)
    expect(size).toBe(bytes.length)
    expect(JSON.parse(readFileSync(join(root(), `${id}.json`), 'utf8')).size).toBe(bytes.length)
    // what the caller handed in is not modified
    expect(Buffer.from(original).equals(Buffer.from(copy))).toBe(true)
    expect(payload.size).toBe(original.length)
  })

  it('AC-3.4 (030) a malformed picture is never stored', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const truncated = buildPng({ metadata: true }).slice(0, 40)
    expect(store.store(request('cut.png', truncated))).toEqual({ ok: false, reason: 'malformed-image' })
    expect(onDisk()).toEqual([])
  })

  it('AC-2.5 (030) a failing write leaves no partial file and no record', () => {
    // the file write fails (disk full)
    const full = new AttachmentStore(inbox, {
      now: clock,
      io: {
        writeFileSync: () => {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        },
      },
    })
    expect(full.store(request('a.txt', 'hello'))).toEqual({ ok: false, reason: 'storage' })
    expect(onDisk()).toEqual([])
    // the file is written but the record cannot be: the file goes too
    const half = new AttachmentStore(inbox, {
      now: clock,
      io: {
        renameSync: () => {
          throw new Error('EPERM')
        },
      },
    })
    expect(half.store(request('b.txt', 'hello'))).toEqual({ ok: false, reason: 'storage' })
    expect(onDisk()).toEqual([])
  })
})

describe('AttachmentStore.lookup and remove (spec 030 T20)', () => {
  it('AC-4.5 (030) lookup accepts ids only', () => {
    let reads = 0
    const store = new AttachmentStore(inbox, {
      now: clock,
      io: {
        readFileSync: ((...args: Parameters<typeof readFileSync>) => {
          reads += 1
          return readFileSync(...args)
        }) as typeof readFileSync,
      },
    })
    const { id } = stored(store, 'a.txt', 'hello')
    // a folder and a record that exist in the store but whose name is not an id
    mkdirSync(join(root(), 'notanid'))
    writeFileSync(join(root(), 'notanid', 'x.txt'), 'secret')
    writeFileSync(join(root(), 'notanid.json'), '{}')

    expect(store.lookup(id)).toMatchObject({ state: 'present', record: { id, originalName: 'a.txt' }, path: join(root(), id, 'a.txt') })
    reads = 0
    const bad = ['..\\x', '../x', `..\\${id}`, `${id}/..`, `${id}.json`, 'C:\\Windows\\win.ini', 'C:', '/etc/passwd', '', 'a'.repeat(300), id.toUpperCase(), ` ${id}`, 'notanid', 'notanid/x.txt']
    for (const value of bad) expect(store.lookup(value), JSON.stringify(value)).toEqual({ state: 'unknown' })
    expect(store.lookup(undefined as never)).toEqual({ state: 'unknown' })
    // a bad id never reaches the disk
    expect(reads).toBe(0)
  })

  it('AC-4.5 (030) a record that does not describe its own id or points outside its folder is unknown', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const a = stored(store, 'a.txt', 'hello')
    const b = stored(store, 'b.txt', 'world')
    const record = JSON.parse(readFileSync(join(root(), `${a.id}.json`), 'utf8'))
    writeFileSync(join(root(), `${a.id}.json`), JSON.stringify({ ...record, id: b.id }))
    expect(store.lookup(a.id)).toEqual({ state: 'unknown' })
    writeFileSync(join(root(), `${a.id}.json`), JSON.stringify({ ...record, storedName: '..\\..\\x.txt' }))
    expect(store.lookup(a.id)).toEqual({ state: 'unknown' })
    writeFileSync(join(root(), `${a.id}.json`), '{ not json')
    expect(store.lookup(a.id)).toEqual({ state: 'unknown' })
  })

  it('AC-1.2 (030) remove deletes the stored file and its record at once', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const a = stored(store, 'a.txt', 'hello')
    const b = stored(store, 'b.txt', 'world')
    expect(store.remove(a.id)).toBe(true)
    expect(onDisk()).toEqual([b.id, `${b.id}.json`, join(b.id, 'b.txt')].sort())
    expect(store.lookup(a.id)).toEqual({ state: 'unknown' })
    // already gone, never stored, path characters: nothing happens and nothing else is touched
    for (const value of [a.id, '00000000-0000-0000-0000-000000000000', '..\\x', '', `../${b.id}`]) expect(store.remove(value), value).toBe(false)
    expect(onDisk()).toHaveLength(3)
  })

  it('AC-6.4 (030) lookup says removed when the file is gone and unknown when never stored', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const { id } = stored(store, 'a.txt', 'hello')
    rmSync(join(root(), id, 'a.txt'))
    expect(store.lookup(id)).toMatchObject({ state: 'removed', record: { id } })
    expect(store.lookup('11111111-1111-1111-1111-111111111111')).toEqual({ state: 'unknown' })
    // a record the sweep already marked
    const marked = stored(store, 'b.txt', 'world')
    const file = join(root(), `${marked.id}.json`)
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), removedAt: now }))
    expect(store.lookup(marked.id)).toMatchObject({ state: 'removed' })
  })
})

describe('deletion with the conversation (spec 030 T21)', () => {
  const withThreads = () => {
    const attachments = new AttachmentStore(inbox, { now: clock })
    const threads = new ThreadStore(inbox, () => 'en', (id) => attachments.deleteForThread(id))
    return { attachments, threads }
  }
  const attach = (attachments: AttachmentStore, threadId: string, name: string) => {
    const data = Buffer.from(name)
    const result = attachments.store({ threadId, name, size: data.length, base64: data.toString('base64') })
    if (!result.ok) throw new Error(result.reason)
    return result.attachment.id
  }

  it('AC-5.4 (030) deleting a conversation deletes its files', () => {
    const { attachments, threads } = withThreads()
    const a = threads.create('general', '/ws')
    const b = threads.create('general', '/ws')
    const a1 = attach(attachments, a.id, 'a1.txt')
    const a2 = attach(attachments, a.id, 'a2.txt')
    const b1 = attach(attachments, b.id, 'b1.txt')

    // the person's delete, retention and erase all go through ThreadStore.delete
    threads.delete(a.id)

    for (const id of [a1, a2]) expect(attachments.lookup(id), id).toEqual({ state: 'unknown' })
    expect(onDisk()).toEqual([b1, `${b1}.json`, join(b1, 'b1.txt')].sort())
    expect(attachments.lookup(b1).state).toBe('present')
    // the conversation itself is gone too
    expect(() => threads.get(a.id)).toThrow()
    expect(threads.get(b.id).id).toBe(b.id)
  })

  it('AC-5.4 (030) the files go before the thread, and a failing delete does not keep the thread', () => {
    const order: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'alma-threads-'))
    try {
      const threads = new ThreadStore(dir, () => 'en', (id) => {
        order.push(existsSync(join(dir, 'threads', `${id}.json`)) ? 'files first' : 'thread first')
        throw new Error('EBUSY')
      })
      const thread = threads.create('general', '/ws')
      threads.delete(thread.id)
      expect(order).toEqual(['files first'])
      expect(existsSync(join(dir, 'threads', `${thread.id}.json`))).toBe(false)
      expect(() => threads.get(thread.id)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('AC-5.4 (030) a file that cannot be deleted does not stop the others', () => {
    let locked: string | undefined
    const attachments = new AttachmentStore(inbox, {
      now: clock,
      io: {
        rmSync: ((path: string, options: Parameters<typeof rmSync>[1]) => {
          if (locked && String(path).endsWith(locked)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
          rmSync(path, options)
        }) as typeof rmSync,
      },
    })
    const first = attach(attachments, 't1', 'first.txt')
    const second = attach(attachments, 't1', 'second.txt')
    locked = first
    expect(() => attachments.deleteForThread('t1')).not.toThrow()
    expect(attachments.lookup(second)).toEqual({ state: 'unknown' })
    // the locked one keeps its record, so the next delete or sweep can finish it
    expect(attachments.lookup(first).state).toBe('present')
    locked = undefined
    attachments.deleteForThread('t1')
    expect(onDisk()).toEqual([])
  })
})

describe('ThreadStore.markOpened (spec 030 T22)', () => {
  afterEach(() => vi.useRealTimers())

  it('AC-6.7 (030) lastOpenedAt is set without changing updatedAt or the list order', () => {
    vi.useFakeTimers()
    const threads = new ThreadStore(inbox, () => 'en')
    vi.setSystemTime(1_000)
    const older = threads.create('general', '/ws')
    vi.setSystemTime(2_000)
    const newer = threads.create('general', '/ws')
    expect(threads.list().map((t) => t.id)).toEqual([newer.id, older.id])

    threads.markOpened(older.id, 9_000)

    expect(threads.get(older.id).lastOpenedAt).toBe(9_000)
    expect(threads.get(older.id).updatedAt).toBe(1_000)
    expect(threads.list().map((t) => t.id)).toEqual([newer.id, older.id])
    expect(threads.get(newer.id).lastOpenedAt).toBeUndefined()
    // it survives a restart, and an unknown conversation is not an error
    threads.flushAll()
    expect(new ThreadStore(inbox, () => 'en').get(older.id)).toMatchObject({ lastOpenedAt: 9_000, updatedAt: 1_000 })
    expect(() => threads.markOpened('gone', 1)).not.toThrow()
  })

  it('AC-6.3 (030) opening restarts the clock and a deleted file stays deleted', () => {
    const day = 86_400_000
    vi.useFakeTimers()
    const threads = new ThreadStore(inbox, () => 'en')
    const attachments = new AttachmentStore(inbox, { now: clock })
    vi.setSystemTime(0)
    const thread = threads.create('general', '/ws')
    threads.markOpened(thread.id, 0)
    const keep = stored(attachments, 'keep.txt', 'a', thread.id)
    const gone = stored(attachments, 'gone.txt', 'b', thread.id)
    const records = () => attachments.records().map((r) => ({ id: r.id, threadId: r.threadId, removedAt: r.removedAt }))
    const due = (at: number) => planSweep(records(), { [thread.id]: threads.get(thread.id).lastOpenedAt }, new Set(), at)

    expect(due(29 * day)).toEqual([])
    expect(due(30 * day).sort()).toEqual([keep.id, gone.id].sort())
    // opened on day 29: the 30 days start again from there
    threads.markOpened(thread.id, 29 * day)
    expect(due(30 * day)).toEqual([])
    expect(due(58 * day + 23 * 3_600_000)).toEqual([])
    expect(due(59 * day).sort()).toEqual([keep.id, gone.id].sort())
    // a file that was deleted does not come back by opening the conversation
    attachments.remove(gone.id)
    expect(attachments.lookup(gone.id)).toEqual({ state: 'unknown' })
    expect(due(59 * day)).toEqual([keep.id])
  })

  it('AC-6.7 (030) a routine, a house-rule and a company run do not set it', () => {
    expect(countsAsOpened({})).toBe(true)
    expect(countsAsOpened({ unattended: false })).toBe(true)
    expect(countsAsOpened({ unattended: true })).toBe(false)
  })

  it('AC-6.7 (030) attaching sets it at that moment', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const threads = new ThreadStore(inbox, () => 'en')
    const thread = threads.create('general', '/ws')
    const attachments = new AttachmentStore(inbox, { now: clock, opened: (id, at) => threads.markOpened(id, at) })
    const data = Buffer.from('hello')

    // a refused file does not count as opening the conversation
    attachments.store({ threadId: thread.id, name: 'a.exe', size: 5, base64: data.toString('base64') })
    expect(threads.get(thread.id).lastOpenedAt).toBeUndefined()

    attachments.store({ threadId: thread.id, name: 'a.txt', size: 5, base64: data.toString('base64') })
    expect(threads.get(thread.id).lastOpenedAt).toBe(now)
    expect(threads.get(thread.id).updatedAt).toBe(1_000)
  })
})

describe('log hygiene (spec 030 T34)', () => {
  const day = 86_400_000
  const NAME = 'NAMEMARKER-7f3a'
  const CONTENT = 'CONTENTMARKER-9c1d'

  it('AC-5.7 (030) no log or audit line carries names or contents', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-audit-'))
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    try {
      initAudit(dataDir, 'coordinator')
      const store = new AttachmentStore(inbox, { now: clock, log: attachmentLog(audit) })

      const kept = stored(store, `${NAME}.txt`, `${CONTENT} xai-abcdefghijklmnopqrstuvwxyz`)
      const gone = stored(store, `${NAME}-gone.txt`, CONTENT)
      // refused: by type, by bytes, by payload
      store.store(request(`${NAME}.exe`, CONTENT))
      store.store(request(`${NAME}.png`, CONTENT))
      store.store({ threadId: 't1', name: `${NAME}.txt`, size: 1, base64: CONTENT, extra: CONTENT })
      // read, including a failing read of a file that is no longer there
      const read = (id: string) => readAttachmentTool.run({ id, offset: 1, limit: 2000 }, { attachments: store, settings: defaultSettings(), workspace: '', signal: new AbortController().signal, host: { request: async () => ({ ok: true, message: '' }) } })
      expect(await read(kept.id)).toContain(CONTENT)
      expect(store.remove(gone.id)).toBe(true)
      await expect(read(gone.id)).rejects.toThrow()
      // swept
      now += 40 * day
      expect(store.sweep(() => 0, new Set())).toEqual({ removed: 1, failed: 0 })
      store.deleteForThread('t1')

      const trail = readdirSync(join(dataDir, 'audit')).map((file) => readFileSync(join(dataDir, 'audit', file), 'utf8')).join('')
      const console_ = JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
      for (const marker of [NAME, CONTENT, 'xai-abcdefghijklmnopqrstuvwxyz']) {
        expect(trail, `audit ${marker}`).not.toContain(marker)
        expect(console_, `console ${marker}`).not.toContain(marker)
      }
      // what it does carry: ids, kinds, sizes, reasons and counts
      const entries = trail.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { action: string; outcome: string; detail: Record<string, unknown> })
      const actions = entries.map((e) => e.action)
      expect(actions).toEqual(expect.arrayContaining(['attachment.store', 'attachment.refuse', 'attachment.remove', 'attachment.sweep']))
      expect(entries.find((e) => e.action === 'attachment.store')?.detail).toEqual({ id: kept.id, kind: 'text', size: kept.size })
      expect(entries.filter((e) => e.action === 'attachment.refuse').map((e) => e.detail.reason)).toEqual(['type', 'content', 'bad-payload'])
      expect(entries.find((e) => e.action === 'attachment.sweep')?.detail).toEqual({ removed: 1, failed: 0 })
      expect(entries.every((e) => Object.values(e.detail).every((v) => typeof v === 'string' || typeof v === 'number'))).toBe(true)
    } finally {
      for (const spy of spies) spy.mockRestore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

describe('erase and export (spec 030 T33)', () => {
  it('AC-5.2 (030) erase removes the store', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const kept = stored(store, 'notes.txt', 'hello')
    writeFileSync(join(inbox, 'telegram-77.jpg'), 'pixels')
    erasePersonalFiles(inbox)
    // the folder, every stored file and every record are gone; the inbox itself is back, empty
    expect(existsSync(root())).toBe(false)
    expect(readdirSync(inbox)).toEqual([])
    expect(store.lookup(kept.id)).toEqual({ state: 'unknown' })
    expect(store.records()).toEqual([])
  })

  it('AC-5.5 (030) export does not copy attachments', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'alma-export-'))
    const target = mkdtempSync(join(tmpdir(), 'alma-export-target-'))
    try {
      const store = new AttachmentStore(join(dataDir, 'inbox'), { now: clock })
      const file = stored(store, 'NAMEMARKER-export.txt', 'CONTENTMARKER-export')
      new ThreadStore(dataDir, () => 'en').create('general', '/ws')

      const out = exportPersonalData(dataDir, target)

      const names = readdirSync(out, { recursive: true }).map(String)
      // the conversation went along, the attachment store (and the inbox it lives in) did not
      expect(names.some((name) => name.startsWith('threads'))).toBe(true)
      expect(names.filter((name) => /inbox|attachments/.test(name) || name.includes(file.id) || name.includes('NAMEMARKER'))).toEqual([])
      for (const name of names) {
        const path = join(out, name)
        if (statSync(path).isFile()) expect(contains(readFileSync(path), 'CONTENTMARKER'), name).toBe(false)
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})

describe('the sweep (spec 030 T23)', () => {
  const day = 86_400_000
  const MARKER = 'SECRETMARKER'
  const NONE = new Set<string>()
  const opened = (map: Record<string, number>) => (threadId: string) => map[threadId]

  it('AC-6.1 (030) sweep deletes due files only', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const due = stored(store, 'due.txt', 'a', 'old')
    const dueToo = stored(store, 'due-too.txt', 'b', 'old')
    const nearly = stored(store, 'nearly.txt', 'c', 'recent')
    now = 1_000 * day
    const lastOpened = opened({ old: now - 30 * day, recent: now - 30 * day + 3_600_000 })

    expect(store.sweep(lastOpened, NONE)).toEqual({ removed: 2, failed: 0 })

    expect(existsSync(join(root(), due.id))).toBe(false)
    expect(existsSync(join(root(), dueToo.id))).toBe(false)
    expect(store.lookup(nearly.id).state).toBe('present')
    // the record stays and says when, so a chip can say "removed" and a second sweep leaves it alone
    expect(store.lookup(due.id)).toMatchObject({ state: 'removed', record: { id: due.id, originalName: 'due.txt', removedAt: now } })
    expect(store.sweep(lastOpened, NONE)).toEqual({ removed: 0, failed: 0 })
  })

  it('AC-6.2 (030) sweep skips running conversations', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const busy = stored(store, 'busy.txt', 'a', 'running')
    const idle = stored(store, 'idle.txt', 'b', 'idle')
    now += 40 * day
    const lastOpened = opened({ running: 0, idle: 0 })

    expect(store.sweep(lastOpened, new Set(['running']))).toEqual({ removed: 1, failed: 0 })
    expect(store.lookup(busy.id).state).toBe('present')
    expect(store.lookup(idle.id).state).toBe('removed')
    // once the run ends it is swept like the rest
    expect(store.sweep(lastOpened, NONE)).toEqual({ removed: 1, failed: 0 })
    expect(store.lookup(busy.id).state).toBe('removed')
  })

  it('AC-6.5 (030) a locked file does not stop the others and is retried', () => {
    const lines: string[] = []
    let locked: string | undefined
    const store = new AttachmentStore(inbox, {
      now: clock,
      log: (event, data) => lines.push(JSON.stringify({ event, ...data })),
      io: {
        rmSync: ((path: string, options: Parameters<typeof rmSync>[1]) => {
          if (locked && String(path).endsWith(locked)) throw Object.assign(new Error(`EBUSY ${path}`), { code: 'EBUSY' })
          rmSync(path, options)
        }) as typeof rmSync,
      },
    })
    const first = stored(store, `${MARKER}-first.txt`, MARKER, 'old')
    const second = stored(store, `${MARKER}-second.txt`, MARKER, 'old')
    now += 31 * day
    locked = first.id

    expect(store.sweep(opened({ old: 0 }), NONE)).toEqual({ removed: 1, failed: 1 })

    expect(store.lookup(second.id).state).toBe('removed')
    expect(store.lookup(first.id)).toMatchObject({ state: 'present' })
    expect(JSON.stringify(lines)).not.toContain(MARKER)
    locked = undefined
    expect(store.sweep(opened({ old: 0 }), NONE)).toEqual({ removed: 1, failed: 0 })
    expect(store.lookup(first.id).state).toBe('removed')
  })

  it('AC-6.5 (030) the file of a deleted conversation whose first erase failed is swept at once and retried until it is gone (G7)', () => {
    const lines: string[] = []
    let locked = true
    const store = new AttachmentStore(inbox, {
      now: clock,
      log: (event, data) => lines.push(JSON.stringify({ event, ...data })),
      io: {
        rmSync: ((path: string, options: Parameters<typeof rmSync>[1]) => {
          if (locked && String(path).includes('attachments')) throw Object.assign(new Error(`EBUSY ${path}`), { code: 'EBUSY' })
          rmSync(path, options)
        }) as typeof rmSync,
      },
    })
    const lost = stored(store, `${MARKER}-lost.txt`, MARKER, 'deleted')
    const kept = stored(store, 'kept.txt', 'k', 'alive')
    const busy = stored(store, 'busy.txt', 'b', 'deleted-running')
    store.deleteForThread('deleted')
    expect(store.lookup(lost.id).state).toBe('present')
    locked = false
    const exists = (threadId: string) => threadId === 'alive'

    // the conversation is gone: no 30-day wait, no last-opened time needed; a running id is still skipped
    expect(store.sweep(() => undefined, new Set(['deleted-running']), exists)).toEqual({ removed: 1, failed: 0 })

    expect(store.lookup(lost.id)).toMatchObject({ state: 'removed', record: { removedAt: now } })
    expect(store.lookup(kept.id).state).toBe('present')
    expect(store.lookup(busy.id).state).toBe('present')
    expect(JSON.stringify(lines)).not.toContain(MARKER)
    // while it stays locked the record keeps no removedAt, so the next sweep tries again
    const second = stored(store, 'second.txt', 's', 'deleted-too')
    locked = true
    expect(store.sweep(() => undefined, NONE, exists)).toEqual({ removed: 0, failed: 2 })
    expect(store.lookup(second.id).state).toBe('present')
    locked = false
    expect(store.sweep(() => undefined, NONE, exists)).toEqual({ removed: 2, failed: 0 })
    expect(store.lookup(second.id).state).toBe('removed')
  })

  it('AC-6.6 (030) legacy inbox pictures, Telegram photos and stills are not touched', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const kept = ['legacy-pasted.png', 'telegram-77.jpg', 'camera-still.jpg'].map((name) => {
      writeFileSync(join(inbox, name), 'pixels')
      return name
    })
    // a folder in the store with no record is not indexed either, and neither is a record that does not parse
    const orphan = '22222222-2222-2222-2222-222222222222'
    mkdirSync(join(root(), orphan), { recursive: true })
    writeFileSync(join(root(), orphan, 'x.txt'), 'x')
    writeFileSync(join(root(), '33333333-3333-3333-3333-333333333333.json'), '{ broken')
    now += 400 * day

    expect(store.sweep(() => 0, NONE)).toEqual({ removed: 0, failed: 0 })

    for (const name of kept) expect(readFileSync(join(inbox, name), 'utf8')).toBe('pixels')
    expect(readFileSync(join(root(), orphan, 'x.txt'), 'utf8')).toBe('x')
  })

  it('AC-6.1 (030) a conversation with no known last-opened time is left alone', () => {
    const store = new AttachmentStore(inbox, { now: clock })
    const a = stored(store, 'a.txt', 'a', 'gone-thread')
    now += 400 * day
    expect(store.sweep(() => undefined, NONE)).toEqual({ removed: 0, failed: 0 })
    expect(store.lookup(a.id).state).toBe('present')
  })

  it('AC-6.2 (030) the scheduler runs at start and every 12 hours', () => {
    vi.useFakeTimers()
    try {
      let runs = 0
      const timer = scheduleSweep(() => {
        runs += 1
      })
      expect(runs).toBe(1)
      vi.advanceTimersByTime(12 * 3_600_000 - 1)
      expect(runs).toBe(1)
      vi.advanceTimersByTime(1)
      expect(runs).toBe(2)
      vi.advanceTimersByTime(12 * 3_600_000)
      expect(runs).toBe(3)
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('AC-6.2 (030) the scheduler does not keep the process alive and survives a failing sweep', () => {
    const calls: { ms: number; unref: boolean }[] = []
    let tick: (() => void) | undefined
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      scheduleSweep(
        () => {
          throw new Error(`boom ${MARKER}`)
        },
        (fn, ms) => {
          tick = fn
          const handle = { unref: () => calls.push({ ms, unref: true }) }
          return handle as never
        },
      )
      expect(calls).toEqual([{ ms: 43_200_000, unref: true }])
      expect(() => tick?.()).not.toThrow()
      expect(JSON.stringify(errors.mock.calls)).not.toContain(MARKER)
    } finally {
      errors.mockRestore()
    }
  })
})
