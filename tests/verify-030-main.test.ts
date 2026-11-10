import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Grants, attachmentOpenAllowed, inspectGranted, inspectPath, insideAttachmentStore, openableAttachment, pickPaths, readForAttach, readGranted, touchesAttachmentStore, type AttachFs } from '../src/main/attach'
import { inboxFileName } from '../src/coordinator/tools/paths'
import { intakeFiles, type IntakeDeps, type IntakeSource } from '../src/shared/attach/intake'
import type { PathInfo, PathRead } from '../src/shared/desktop-api'
import type { StoreResult } from '../src/shared/types'
import { AttachmentStore } from '../src/coordinator/attachments/store'
import { ascii, b64, bytes, makePng, tmp } from './support/verify-030'

// Independent verification of spec 030 on the main-process side (grants, reading, open guard) and the intake rules
// that tie the pieces together (AC-1.4, AC-1.9, AC-2.1 to AC-2.4, AC-3.2). Written from spec.md only.

const MIB = 1_048_576
const ID = '0b8f5a52-6c3e-4f55-9d34-aaaaaaaaaaaa'
let dir: string

beforeEach(() => {
  dir = tmp('main')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fakeStats = (kind: 'file' | 'dir' | 'link' | 'other', size = 0) => ({ size, isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' })

describe('AC-2.4 (030 verify) reading a file for the composer', () => {
  it('AC-2.4 (030 verify) a real file is returned whole and left untouched', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hello')
    const before = statSync(file).mtimeMs
    expect(await readForAttach(file)).toEqual({ ok: true, name: 'a.txt', size: 5, base64: b64(bytes(ascii('hello'))) })
    expect(readFileSync(file, 'utf8')).toBe('hello')
    expect(statSync(file).mtimeMs).toBe(before)
  })

  it('AC-2.2 (030 verify) 2 MiB is read, one byte more is too big, and a 3 MiB real file is refused without being read', async () => {
    const exact = join(dir, 'exact.bin')
    writeFileSync(exact, new Uint8Array(2 * MIB))
    expect(await readForAttach(exact)).toMatchObject({ ok: true, size: 2 * MIB })
    const over = join(dir, 'over.bin')
    writeFileSync(over, new Uint8Array(2 * MIB + 1))
    expect(await readForAttach(over)).toEqual({ ok: false, reason: 'too-big' })
    const huge = join(dir, 'huge.bin')
    writeFileSync(huge, new Uint8Array(3 * MIB))
    expect(await readForAttach(huge)).toEqual({ ok: false, reason: 'too-big' })
  })

  it('AC-2.2 (030 verify) a file that grew after the stat is never loaded past the limit', async () => {
    let asked = 0
    const fs: AttachFs = {
      lstat: async () => fakeStats('file', 100) as never,
      readdir: async () => [],
      readFile: async (_path, limit) => {
        asked = limit
        return new Uint8Array(limit)
      },
    }
    expect(await readForAttach('C:\\x\\grew.txt', fs)).toEqual({ ok: false, reason: 'too-big' })
    expect(asked).toBe(2 * MIB + 1)
  })

  it('AC-2.4 (030 verify) missing, folder and reasons from the operating system', async () => {
    expect(await readForAttach(join(dir, 'nope.txt'))).toEqual({ ok: false, reason: 'missing' })
    expect(await readForAttach(dir)).toEqual({ ok: false, reason: 'is-folder' })
    const codes: [string, string][] = [['ENOENT', 'missing'], ['ENOTDIR', 'missing'], ['EACCES', 'denied'], ['EPERM', 'denied'], ['EBUSY', 'busy'], ['EISDIR', 'is-folder'], ['EIO', 'unreadable'], ['EMFILE', 'unreadable']]
    for (const [code, reason] of codes) {
      const fs: AttachFs = { lstat: async () => fakeStats('file', 10) as never, readdir: async () => [], readFile: async () => Promise.reject(Object.assign(new Error(code), { code })) }
      expect(await readForAttach('C:\\x\\f.txt', fs), code).toEqual({ ok: false, reason })
    }
    const strange: AttachFs = { lstat: async () => Promise.reject('not an error object'), readdir: async () => [], readFile: async () => new Uint8Array() }
    expect(await readForAttach('C:\\x\\f.txt', strange)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('AC-2.4 (030 verify) a link is never followed and a device or socket is unreadable', async () => {
    const asked: string[] = []
    for (const kind of ['link', 'other'] as const) {
      const fs: AttachFs = { lstat: async () => fakeStats(kind, 10) as never, readdir: async () => [], readFile: async (p) => {
          asked.push(p)
          return new Uint8Array(1)
        } }
      expect(await readForAttach('C:\\x\\l', fs), kind).toEqual({ ok: false, reason: 'unreadable' })
    }
    expect(asked).toEqual([])
  })

  it('AC-2.4 (030 verify) a symlink to a file is not followed (skipped where the platform will not create one)', async () => {
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'secret target')
    const link = join(dir, 'link.txt')
    try {
      symlinkSync(target, link, 'file')
    } catch {
      return
    }
    expect(await readForAttach(link)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('AC-2.4 (030 verify) an empty file reads as empty bytes (the type check then refuses it)', async () => {
    const file = join(dir, 'empty.txt')
    writeFileSync(file, '')
    expect(await readForAttach(file)).toEqual({ ok: true, name: 'empty.txt', size: 0, base64: '' })
  })

  it('AC-5.1 (030 verify) the name handed to the page is the base name only, whatever the path', async () => {
    const file = join(dir, 'sub dir', 'ñandú (1).txt')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'x')
    expect(await readForAttach(file)).toMatchObject({ ok: true, name: 'ñandú (1).txt' })
  })
})

describe('AC-1.9 (030 verify) listing a dropped folder', () => {
  it('AC-1.9 (030 verify) only the files directly inside are listed, subfolders are counted as skipped', async () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.md'), 'bb')
    writeFileSync(join(dir, 'empty.log'), '')
    mkdirSync(join(dir, 'sub'))
    mkdirSync(join(dir, 'sub2'))
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'deep')
    const info = await inspectPath(dir)
    expect(info.kind).toBe('folder')
    if (info.kind !== 'folder') return
    expect(info.files.map((f) => f.name).sort()).toEqual(['a.txt', 'b.md', 'empty.log'])
    expect(info.files.find((f) => f.name === 'b.md')?.size).toBe(2)
    expect(info.skipped).toBe(2)
    expect(info.files.every((f) => f.path.startsWith(dir))).toBe(true)
  })

  it('AC-1.9 (030 verify) a junction inside the folder counts as skipped, never followed (skipped where the platform will not create one)', async () => {
    const outside = tmp('outside')
    writeFileSync(join(outside, 'leak.txt'), 'leak')
    writeFileSync(join(dir, 'a.txt'), 'a')
    try {
      symlinkSync(outside, join(dir, 'link'), 'junction')
    } catch {
      return
    } finally {
      afterEachCleanup.push(outside)
    }
    const info = await inspectPath(dir)
    expect(info).toMatchObject({ kind: 'folder', skipped: 1 })
    if (info.kind === 'folder') expect(info.files.map((f) => f.name)).toEqual(['a.txt'])
  })

  it('AC-1.9 (030 verify) a dropped junction or link is not entered', async () => {
    const outside = tmp('outside2')
    afterEachCleanup.push(outside)
    writeFileSync(join(outside, 'leak.txt'), 'leak')
    const link = join(dir, 'link')
    try {
      symlinkSync(outside, link, 'junction')
    } catch {
      return
    }
    expect(await inspectPath(link)).toEqual({ kind: 'failed', reason: 'unreadable' })
  })

  it('AC-1.9 (030 verify) an entry that stops being a file between the listing and the measure is skipped', async () => {
    const fs: AttachFs = {
      lstat: async (path) => (path === 'C:\\d' ? (fakeStats('dir') as never) : path.endsWith('gone.txt') ? Promise.reject(new Error('ENOENT')) : (fakeStats('file', 7) as never)),
      readdir: async () => [
        { name: 'ok.txt', isFile: () => true },
        { name: 'gone.txt', isFile: () => true },
        { name: 'folder', isFile: () => false },
      ],
      readFile: async () => new Uint8Array(),
    }
    const info = await inspectPath('C:\\d', fs)
    expect(info).toMatchObject({ kind: 'folder', name: 'd', skipped: 2 })
    if (info.kind === 'folder') expect(info.files).toEqual([{ path: join('C:\\d', 'ok.txt'), name: 'ok.txt', size: 7 }])
  })

  it('AC-2.4 (030 verify) a missing or unreadable path is a failure with a reason; a plain file is reported as a file', async () => {
    expect(await inspectPath(join(dir, 'nope'))).toEqual({ kind: 'failed', reason: 'missing' })
    writeFileSync(join(dir, 'f.txt'), 'x')
    expect(await inspectPath(join(dir, 'f.txt'))).toEqual({ kind: 'file', name: 'f.txt', size: 1 })
    const denied: AttachFs = { lstat: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })), readdir: async () => [], readFile: async () => new Uint8Array() }
    expect(await inspectPath('C:\\x', denied)).toEqual({ kind: 'failed', reason: 'denied' })
    const listFails: AttachFs = { lstat: async () => fakeStats('dir') as never, readdir: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EPERM' })), readFile: async () => new Uint8Array() }
    expect(await inspectPath('C:\\x', listFails)).toEqual({ kind: 'failed', reason: 'denied' })
  })
})

const afterEachCleanup: string[] = []
afterEach(() => {
  for (const p of afterEachCleanup.splice(0)) rmSync(p, { recursive: true, force: true })
})

describe('AC-2.4 (030 verify) grants: the page may read only paths it was handed', () => {
  let clock = 1000
  const grants = (ttl = 300_000, max = 1000) => new Grants(() => clock, ttl, max)
  beforeEach(() => {
    clock = 1000
  })

  it('AC-2.4 (030 verify) a path nobody granted is denied for inspect and read, with no file access', async () => {
    const g = grants()
    const secret = join(dir, 'secret.txt')
    writeFileSync(secret, 'secret')
    expect(await inspectGranted(secret, g)).toEqual({ kind: 'failed', reason: 'denied' })
    expect(await readGranted(secret, g)).toEqual({ ok: false, reason: 'denied' })
  })

  it('AC-2.4 (030 verify) a grant is used once', async () => {
    const g = grants()
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hi')
    g.grant(file)
    expect(await inspectGranted(file, g)).toMatchObject({ kind: 'file' })
    expect(await inspectGranted(file, g)).toMatchObject({ kind: 'file' })
    expect(await readGranted(file, g)).toMatchObject({ ok: true })
    expect(await readGranted(file, g)).toEqual({ ok: false, reason: 'denied' })
  })

  it('AC-2.4 (030 verify) the grant is used up even when the read fails', async () => {
    const g = grants()
    const file = join(dir, 'missing.txt')
    g.grant(file)
    expect(await readGranted(file, g)).toEqual({ ok: false, reason: 'missing' })
    writeFileSync(file, 'now it exists')
    expect(await readGranted(file, g)).toEqual({ ok: false, reason: 'denied' })
  })

  it('AC-2.4 (030 verify) a grant expires exactly at its time to live', () => {
    const g = grants(1000)
    g.grant('C:\\a\\f.txt')
    clock = 1000 + 999
    expect(g.has('C:\\a\\f.txt')).toBe(true)
    clock = 1000 + 1000
    expect(g.has('C:\\a\\f.txt')).toBe(false)
    expect(g.consume('C:\\a\\f.txt')).toBe(false)
  })

  it('AC-2.4 (030 verify) granting again refreshes the time', () => {
    const g = grants(1000)
    g.grant('C:\\a\\f.txt')
    clock = 1900
    g.grant('C:\\a\\f.txt')
    clock = 2800
    expect(g.has('C:\\a\\f.txt')).toBe(true)
    clock = 2900
    expect(g.has('C:\\a\\f.txt')).toBe(false)
  })

  it('AC-2.4 (030 verify) the set is bounded: the oldest grants fall out first', () => {
    const g = grants(300_000, 3)
    for (const n of [1, 2, 3, 4, 5]) g.grant(`C:\\a\\f${n}.txt`)
    expect([1, 2, 3, 4, 5].map((n) => g.has(`C:\\a\\f${n}.txt`))).toEqual([false, false, true, true, true])
    g.grant('C:\\a\\f3.txt')
    g.grant('C:\\a\\f6.txt')
    expect([3, 4, 5, 6].map((n) => g.has(`C:\\a\\f${n}.txt`))).toEqual([true, false, true, true])
  })

  it('AC-2.4 (030 verify) only absolute paths can be granted or asked about', () => {
    const g = grants()
    for (const bad of ['a.txt', '.\\a.txt', '..\\a.txt', '', 'a/b.txt', 'file:///C:/a.txt']) {
      g.grant(bad)
      expect(g.has(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const junk of [null, undefined, 5, {}, ['C:\\a.txt']] as unknown[]) {
      expect(() => g.grant(junk as string)).not.toThrow()
      expect(g.has(junk as string)).toBe(false)
      expect(g.consume(junk as string)).toBe(false)
    }
  })

  it.runIf(process.platform === 'win32')('AC-2.4 (030 verify) on Windows case, slashes and dot segments name the same path; a longer or shorter name does not match', () => {
    const g = grants()
    g.grant('C:\\Dir\\File.TXT')
    expect(g.has('c:/dir/./sub/../file.txt')).toBe(true)
    expect(g.has('C:\\Dir\\File.TXT2')).toBe(false)
    expect(g.has('C:\\Dir\\File.TX')).toBe(false)
    expect(g.has('C:\\Dir\\File.TXT\\child')).toBe(false)
    expect(g.has('C:\\Dir')).toBe(false)
    expect(g.has('D:\\Dir\\File.TXT')).toBe(false)
    g.grant('\\\\srv\\share\\a.txt')
    expect(g.has('\\\\SRV\\share\\A.txt')).toBe(true)
    expect(g.has('\\\\srv\\share\\b.txt')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('AC-2.4 (030 verify) a granted path with ".." means the normalised path, never the parent it names', () => {
    const g = grants()
    g.grant('C:\\a\\b\\..\\c.txt')
    expect(g.has('C:\\a\\c.txt')).toBe(true)
    expect(g.has('C:\\a\\b\\c.txt')).toBe(false)
    expect(g.has('C:\\a\\b\\..\\c.txt')).toBe(true)
  })

  it('AC-1.8 (030 verify) the picker grants what was chosen; cancelling grants nothing', async () => {
    const g = grants()
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    expect(await pickPaths(async () => [], g)).toEqual([])
    expect(g.has(a)).toBe(false)
    expect(await pickPaths(async () => [a, b], g)).toEqual([a, b])
    expect(g.has(a) && g.has(b)).toBe(true)
    expect(g.has(join(dir, 'c.txt'))).toBe(false)
  })

  it('AC-1.9 (030 verify) inspecting a granted folder grants its direct files, once each, and nothing else', async () => {
    const g = grants()
    writeFileSync(join(dir, 'a.txt'), 'a')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'deep')
    g.grant(dir)
    const info = await inspectGranted(dir, g)
    expect(info.kind).toBe('folder')
    expect(await readGranted(join(dir, 'a.txt'), g)).toMatchObject({ ok: true })
    expect(await readGranted(join(dir, 'a.txt'), g)).toEqual({ ok: false, reason: 'denied' })
    expect(await readGranted(join(dir, 'sub', 'deep.txt'), g)).toEqual({ ok: false, reason: 'denied' })
    writeFileSync(join(dir, 'late.txt'), 'created after the listing')
    expect(await readGranted(join(dir, 'late.txt'), g)).toEqual({ ok: false, reason: 'denied' })
    expect(g.has(dir), 'the folder grant is not used up by listing').toBe(true)
  })

  it('AC-2.4 (030 verify) a granted file does not grant its neighbours or its parent', async () => {
    const g = grants()
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'b.txt'), 'b')
    g.grant(join(dir, 'a.txt'))
    expect(await readGranted(join(dir, 'b.txt'), g)).toEqual({ ok: false, reason: 'denied' })
    expect(await inspectGranted(dir, g)).toEqual({ kind: 'failed', reason: 'denied' })
  })
})

describe('AC-7.5 (030 verify) the open guard in main', () => {
  let root: string
  beforeEach(() => {
    root = join(dir, 'inbox', 'attachments')
    mkdirSync(join(root, ID), { recursive: true })
  })

  it('AC-7.5 (030 verify) a listed file one level below the store root is allowed', () => {
    for (const name of ['a.txt', 'a.pdf', 'a.PNG', 'a.docx', 'a.log']) expect(attachmentOpenAllowed(join(root, ID, name), root), name).toBe(true)
  })

  it('AC-7.5 (030 verify) source-code types, macros, scripts and double extensions are not allowed', () => {
    for (const name of ['a.js', 'a.py', 'a.xlsm', 'a.bat', 'a.ps1', 'a.exe', 'a.html', 'a.svg', 'a.txt.exe', 'a.txt:stream', 'a', 'a.txt.', 'a.cs', 'a.xml']) expect(attachmentOpenAllowed(join(root, ID, name), root), name).toBe(false)
  })

  it('AC-7.5 (030 verify) wrong depth, outside paths, relative paths, dot-dot and sibling-prefix folders are not allowed', () => {
    const inbox = join(dir, 'inbox')
    const cases = [
      join(root, 'a.txt'),
      join(root, ID, 'sub', 'a.txt'),
      join(root, ID),
      root,
      join(inbox, 'a.txt'),
      join(inbox, 'attachments-evil', ID, 'a.txt'),
      `${root}-evil\\${ID}\\a.txt`,
      join(root, '..', 'a.txt'),
      join(root, ID, '..', '..', 'a.txt'),
      join(root, ID, '..', '..', '..', 'x.txt'),
      'a.txt',
      `${ID}\\a.txt`,
      '',
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\a.txt',
    ]
    for (const path of cases) expect(attachmentOpenAllowed(path, root), path).toBe(false)
    expect(insideAttachmentStore(`${root}-evil\\${ID}\\a.txt`, root)).toBe(false)
    expect(insideAttachmentStore(join(root, ID, '..', '..', 'x'), root)).toBe(false)
    expect(insideAttachmentStore(root, root)).toBe(true)
    expect(insideAttachmentStore(join(root, ID), root)).toBe(true)
    expect(insideAttachmentStore(5 as unknown as string, root)).toBe(false)
    expect(insideAttachmentStore(undefined as unknown as string, root)).toBe(false)
  })

  it('AC-7.5 (030 verify) dot-dot that stays inside the store is resolved first and then judged', () => {
    expect(attachmentOpenAllowed(join(root, ID, 'x', '..', 'a.txt'), root)).toBe(true)
    expect(attachmentOpenAllowed(join(root, ID, 'x', '..', 'a.exe'), root)).toBe(false)
  })

  it('AC-7.5 (030 verify) openableAttachment returns the real path of an existing allowed file and nothing for a missing one', () => {
    const file = join(root, ID, 'a.txt')
    writeFileSync(file, 'x')
    expect(openableAttachment(file, root)).not.toBeNull()
    expect(openableAttachment(join(root, ID, 'missing.txt'), root)).toBeNull()
    expect(openableAttachment(join(root, ID, 'a.exe'), root)).toBeNull()
  })

  it('AC-7.5 (030 verify) a junction planted in the store that points outside is not opened (skipped where the platform will not create one)', () => {
    const outside = tmp('outside3')
    afterEachCleanup.push(outside)
    writeFileSync(join(outside, 'a.txt'), 'outside the store')
    const evil = join(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    try {
      symlinkSync(outside, evil, 'junction')
    } catch {
      return
    }
    expect(attachmentOpenAllowed(join(evil, 'a.txt'), root), 'the lexical check alone is fooled').toBe(true)
    expect(openableAttachment(join(evil, 'a.txt'), root)).toBeNull()
    expect(touchesAttachmentStore(join(evil, 'a.txt'), root)).toBe(true)
  })

  it('AC-7.5 (030 verify) a junction to the store from outside still counts as the store for shell:openPath', () => {
    const alias = join(dir, 'alias')
    try {
      symlinkSync(root, alias, 'junction')
    } catch {
      return
    }
    writeFileSync(join(root, ID, 'a.txt'), 'x')
    expect(touchesAttachmentStore(join(alias, ID, 'a.txt'), root)).toBe(true)
    expect(touchesAttachmentStore(join(dir, 'elsewhere.txt'), root)).toBe(false)
  })

  it('AC-7.5 (030 verify) shell:openPath is refused for anything in the store, as written or through ..', () => {
    writeFileSync(join(root, ID, 'a.txt'), 'x')
    expect(touchesAttachmentStore(join(root, ID, 'a.txt'), root)).toBe(true)
    expect(touchesAttachmentStore(join(root, ID, 'x', '..', 'a.txt'), root)).toBe(true)
    expect(touchesAttachmentStore(root, root)).toBe(true)
    expect(touchesAttachmentStore(join(dir, 'inbox', 'legacy.png'), root)).toBe(false)
    expect(touchesAttachmentStore(`${root}-evil\\a.txt`, root)).toBe(false)
  })
})

describe('AC-8.1 (030 verify) channels outside the feature are unchanged', () => {
  it('AC-8.1 (030 verify) a Telegram photo keeps its name pattern in the inbox', () => {
    expect(inboxFileName('telegram-AgADBQAD_x-y9.jpg')).toBe('telegram-AgADBQAD_x-y9.jpg')
    expect(inboxFileName('telegram-AQADyLoxG123456.jpg')).toBe('telegram-AQADyLoxG123456.jpg')
    const source = readFileSync(join(__dirname, '..', 'src', 'coordinator', 'channels', 'telegram.ts'), 'utf8')
    expect(source).toContain(['`telegram-$', '{photo.file_unique_id}.jpg`'].join(''))
    expect(source).toContain('this.deps.saveImage(')
  })

  it('AC-8.1 (030 verify) the channels do not call the attachment store, tool or intake', () => {
    const channels = join(__dirname, '..', 'src', 'coordinator', 'channels')
    const offenders: string[] = []
    for (const file of readdirSync(channels, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue
      const source = readFileSync(join(file.parentPath, file.name), 'utf8')
      // The remote channel reads the pure rules of shared/attach (spec 031: the phone's limits and file view); it still never reaches the store, the tool or the intake.
      const remote = /[\\/]channels[\\/]remote([\\/]|$)/.test(file.parentPath)
      if (/attachments\/(store|service|expand|read-tool)/.test(source) || (!remote && /shared\/attach\//.test(source))) offenders.push(file.name)
    }
    expect(offenders).toEqual([])
  })
})

// ---- the composer's intake, with the real store behind it ----

describe('AC-1.4 / AC-2.x / AC-3.2 (030 verify) intake of dropped, pasted and picked files', () => {
  let inbox: string
  let store: AttachmentStore
  let stored: { name: string; size: number }[]
  let asked: string[]
  let deps: IntakeDeps
  const files = new Map<string, { info: PathInfo; read: PathRead }>()
  const NOW = 1_800_000_000_000

  const addFile = (path: string, data: Uint8Array | PathRead, name = path.split('\\').pop() as string) => {
    const read: PathRead = data instanceof Uint8Array ? { ok: true, name, size: data.length, base64: b64(data) } : data
    const info: PathInfo = read.ok ? { kind: 'file', name, size: read.size } : { kind: 'failed', reason: read.reason as Extract<PathInfo, { kind: 'failed' }>['reason'] }
    files.set(path, { info, read })
    return { name, path }
  }

  beforeEach(() => {
    inbox = tmp('intake')
    afterEachCleanup.push(inbox)
    store = new AttachmentStore(inbox)
    stored = []
    asked = []
    files.clear()
    deps = {
      canAttach: true,
      existing: [],
      now: () => NOW,
      inspect: async (path) => files.get(path)?.info ?? { kind: 'failed', reason: 'missing' },
      read: async (path) => files.get(path)?.read ?? { ok: false, reason: 'missing' },
      store: async (file) => {
        const result: StoreResult = store.store({ threadId: 't1', ...file })
        if (result.ok) stored.push({ name: result.attachment.name, size: result.attachment.size })
        return result
      },
      confirmSecret: async (name) => {
        asked.push(name)
        return true
      },
    }
  })

  const roots = () => (existsSync(join(inbox, 'attachments')) ? readdirSync(join(inbox, 'attachments')).filter((n) => !n.endsWith('.json')) : [])

  it('AC-1.4 (030 verify) each file is judged on its own: the good ones get chips and every refusal is reported with its reason', async () => {
    const sources: IntakeSource[] = [
      addFile('C:\\d\\ok1.txt', bytes(ascii('one'))),
      addFile('C:\\d\\tool.exe', bytes(ascii('MZ'))),
      addFile('C:\\d\\ok2.png', makePng()),
      addFile('C:\\d\\big.txt', new Uint8Array(2 * MIB + 1).fill(0x61)),
      addFile('C:\\d\\gone.txt', { ok: false, reason: 'missing' }),
      addFile('C:\\d\\locked.txt', { ok: false, reason: 'busy' }),
      addFile('C:\\d\\fake.png', bytes(ascii('MZ'), 1, 2)),
      addFile('C:\\d\\empty.txt', new Uint8Array(0)),
      addFile('C:\\d\\noext', bytes(ascii('hello'))),
    ]
    const result = await intakeFiles(sources, deps)
    expect(result.added.map((a) => a.name)).toEqual(['ok1.txt', 'ok2.png'])
    expect(result.refused).toEqual([
      { name: 'tool.exe', reason: 'type' },
      { name: 'big.txt', reason: 'too-big' },
      { name: 'gone.txt', reason: 'missing' },
      { name: 'locked.txt', reason: 'busy' },
      { name: 'fake.png', reason: 'content' },
      { name: 'empty.txt', reason: 'empty' },
      { name: 'noext', reason: 'type' },
    ])
    expect(roots()).toHaveLength(2)
  })

  it('AC-2.3 (030 verify) seven files at once: five chips, two refusals, nothing stored for the refused', async () => {
    const sources = Array.from({ length: 7 }, (_, i) => addFile(`C:\\d\\f${i}.txt`, bytes(ascii(`file ${i}`))))
    const result = await intakeFiles(sources, deps)
    expect(result.added.map((a) => a.name)).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'])
    expect(result.refused).toEqual([{ name: 'f5.txt', reason: 'too-many' }, { name: 'f6.txt', reason: 'too-many' }])
    expect(roots()).toHaveLength(5)
  })

  it('AC-2.3 (030 verify) chips already in the composer count, and a refused file uses no slot', async () => {
    deps.existing = [{ size: 10 }, { size: 10 }, { size: 10 }]
    const sources = [addFile('C:\\d\\bad.exe', bytes(ascii('MZ'))), addFile('C:\\d\\a.txt', bytes(ascii('a'))), addFile('C:\\d\\b.txt', bytes(ascii('b'))), addFile('C:\\d\\c.txt', bytes(ascii('c')))]
    const result = await intakeFiles(sources, deps)
    expect(result.added.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
    expect(result.refused).toEqual([{ name: 'bad.exe', reason: 'type' }, { name: 'c.txt', reason: 'too-many' }])
  })

  it('AC-2.3 (030 verify) five files of exactly 2 MiB (10 MiB) all fit; with a chip already there the fifth is refused', async () => {
    const five = Array.from({ length: 5 }, (_, i) => addFile(`C:\\d\\m${i}.txt`, new Uint8Array(2 * MIB).fill(0x61)))
    expect((await intakeFiles(five, deps)).added).toHaveLength(5)
    deps.existing = [{ size: 1 }]
    const more = Array.from({ length: 5 }, (_, i) => addFile(`C:\\d\\n${i}.txt`, new Uint8Array(2 * MIB).fill(0x61)))
    const result = await intakeFiles(more, deps)
    expect(result.added).toHaveLength(4)
    expect(result.refused).toEqual([{ name: 'n4.txt', reason: 'too-many' }])
  })

  it('AC-1.5 (030 verify) a pasted picture with no name or the default name becomes imagen-<timestamp>.png', async () => {
    const png = makePng()
    const sources: IntakeSource[] = [
      { name: 'image.png', size: png.length, base64: async () => b64(png) },
      { name: '', size: png.length, base64: async () => b64(png) },
      { name: 'captura.png', size: png.length, base64: async () => b64(png) },
    ]
    const result = await intakeFiles(sources, deps)
    expect(result.added.map((a) => a.name)).toEqual([`imagen-${NOW}.png`, `imagen-${NOW}.png`, 'captura.png'])
  })

  it('AC-1.5 (030 verify) documents: a nameless JPEG screenshot is named .png and is then refused as not matching', async () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 5, 0xff, 0xd9)
    const result = await intakeFiles([{ name: '', size: jpeg.length, base64: async () => b64(jpeg) }], deps)
    expect(result.added).toEqual([])
    expect(result.refused).toEqual([{ name: `imagen-${NOW}.png`, reason: 'content' }])
  })

  it('AC-2.6 (030 verify) a pasted file whose claimed size is wrong is rejected by the coordinator on its real bytes', async () => {
    const data = bytes(ascii('twenty bytes of text'))
    const result = await intakeFiles([{ name: 'a.txt', size: 5, base64: async () => b64(data) }], deps)
    expect(result.added).toEqual([])
    expect(result.refused).toEqual([{ name: 'a.txt', reason: 'bad-payload' }])
    expect(roots()).toEqual([])
  })

  it('AC-2.6 (030 verify) a pasted file that claims to be small but holds more than 2 MiB is refused as too big', async () => {
    const big = new Uint8Array(2 * MIB + 10).fill(0x61)
    const result = await intakeFiles([{ name: 'a.txt', size: 100, base64: async () => b64(big) }], deps)
    expect(result.refused).toEqual([{ name: 'a.txt', reason: 'too-big' }])
    expect(roots()).toEqual([])
  })

  it('AC-2.4 (030 verify) a source that throws while it is read is refused as unreadable, and the next one still goes in', async () => {
    const sources: IntakeSource[] = [
      { name: 'boom.txt', size: 5, base64: async () => Promise.reject(new Error('reader failed')) },
      addFile('C:\\d\\ok.txt', bytes(ascii('ok'))),
    ]
    const result = await intakeFiles(sources, deps)
    expect(result.refused).toEqual([{ name: 'boom.txt', reason: 'unreadable' }])
    expect(result.added.map((a) => a.name)).toEqual(['ok.txt'])
  })

  it('AC-2.4 (030 verify) when inspect throws the file is unreadable', async () => {
    deps.inspect = async () => Promise.reject(new Error('x'))
    const result = await intakeFiles([{ name: 'x.txt', path: 'C:\\d\\x.txt' }], deps)
    expect(result.refused).toEqual([{ name: 'x.txt', reason: 'unreadable' }])
  })

  it('AC-2.5 (030 verify) when storing throws or reports a failure the chip does not appear and the reason is "storage"', async () => {
    const a = addFile('C:\\d\\a.txt', bytes(ascii('a')))
    const b = addFile('C:\\d\\b.txt', bytes(ascii('b')))
    deps.store = async () => Promise.reject(new Error('ENOSPC'))
    expect((await intakeFiles([a], deps)).refused).toEqual([{ name: 'a.txt', reason: 'storage' }])
    deps.store = async () => ({ ok: false, reason: 'storage' })
    const result = await intakeFiles([a, b], deps)
    expect(result.added).toEqual([])
    expect(result.refused).toEqual([{ name: 'a.txt', reason: 'storage' }, { name: 'b.txt', reason: 'storage' }])
  })

  it('AC-1.11 (030 verify) in a company conversation every file is refused, and nothing is read, listed or stored', async () => {
    deps.canAttach = false
    let touched = 0
    deps.inspect = async () => {
      touched++
      return { kind: 'failed', reason: 'missing' }
    }
    deps.read = async () => {
      touched++
      return { ok: false, reason: 'missing' }
    }
    deps.store = async () => {
      touched++
      return { ok: false, reason: 'storage' }
    }
    const result = await intakeFiles([{ name: 'a.txt', path: 'C:\\d\\a.txt' }, { name: 'b.png', size: 1, base64: async () => 'AA==' }], deps)
    expect(result.refused).toEqual([{ name: 'a.txt', reason: 'company' }, { name: 'b.png', reason: 'company' }])
    expect(touched).toBe(0)
  })

  it('AC-3.2 (030 verify) a secret-looking name warns; cancelling stores nothing and makes no chip; confirming attaches as usual', async () => {
    const a = addFile('C:\\d\\credentials.json', bytes(ascii('{"k":1}')))
    const b = addFile('C:\\d\\notes.txt', bytes(ascii('fine')))
    deps.confirmSecret = async (name) => {
      asked.push(name)
      return false
    }
    const cancelled = await intakeFiles([a, b], deps)
    expect(asked).toEqual(['credentials.json'])
    expect(cancelled.added.map((x) => x.name)).toEqual(['notes.txt'])
    expect(cancelled.refused).toEqual([])
    expect(roots()).toHaveLength(1)
    deps.confirmSecret = async (name) => {
      asked.push(name)
      return true
    }
    const confirmed = await intakeFiles([a], deps)
    expect(confirmed.added.map((x) => x.name)).toEqual(['credentials.json'])
  })

  it('AC-3.2 (030 verify) a secret-looking folder in the known path warns too, even if the file name is plain', async () => {
    const a = addFile('C:\\Users\\f\\.env\\notes.txt', bytes(ascii('hi')), 'notes.txt')
    await intakeFiles([a], deps)
    expect(asked).toEqual(['notes.txt'])
  })

  it('AC-3.2 (030 verify) a cancelled warning uses no budget: five more files still fit', async () => {
    const secret = addFile('C:\\d\\passwords.txt', bytes(ascii('pw')))
    deps.confirmSecret = async () => false
    const rest = Array.from({ length: 5 }, (_, i) => addFile(`C:\\d\\r${i}.txt`, bytes(ascii('x'))))
    const result = await intakeFiles([secret, ...rest], deps)
    expect(result.added).toHaveLength(5)
    expect(result.refused).toEqual([])
  })

  it('AC-3.2 (030 verify) documents: most secret-looking names (.env, *.pem, *.key, id_rsa, .npmrc) are refused by type before the warning can be shown', async () => {
    const names = ['.env', 'server.pem', 'my.key', 'id_rsa', '.npmrc', 'vault.kdbx', 'cert.pfx']
    const result = await intakeFiles(names.map((n) => addFile(`C:\\d\\${n}`, bytes(ascii('PRIVATE')))), deps)
    expect(result.refused.map((r) => r.reason)).toEqual(names.map(() => 'type'))
    expect(asked).toEqual([])
  })

  describe('AC-1.9 (030 verify) folder drop', () => {
    const folder = (path: string, entries: { name: string; data: Uint8Array | PathRead }[], skipped = 0) => {
      const list = entries.map((e) => {
        const full = `${path}\\${e.name}`
        addFile(full, e.data, e.name)
        return { path: full, name: e.name, size: e.data instanceof Uint8Array ? e.data.length : 0 }
      })
      files.set(path, { info: { kind: 'folder', name: path.split('\\').pop() as string, files: list, skipped }, read: { ok: false, reason: 'is-folder' } })
      return { name: path.split('\\').pop() as string, path }
    }

    it('AC-1.9 (030 verify) the direct files are attached one by one, and the person is told about the skipped subfolders', async () => {
      const src = folder('C:\\d\\docs', [{ name: 'a.txt', data: bytes(ascii('a')) }, { name: 'b.md', data: bytes(ascii('b')) }], 3)
      const result = await intakeFiles([src], deps)
      expect(result.added.map((a) => a.name)).toEqual(['a.txt', 'b.md'])
      expect(result.skippedFolders).toEqual([{ folder: 'docs', count: 3 }])
      expect(result.refused).toEqual([])
    })

    it('AC-1.9 (030 verify) a file inside that is not allowed is refused alone; the others still go in', async () => {
      const src = folder('C:\\d\\mix', [{ name: 'a.txt', data: bytes(ascii('a')) }, { name: 'run.exe', data: bytes(ascii('MZ')) }, { name: 'b.txt', data: bytes(ascii('b')) }])
      const result = await intakeFiles([src], deps)
      expect(result.added.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
      expect(result.refused).toEqual([{ name: 'run.exe', reason: 'type' }])
    })

    it('AC-1.9 (030 verify) six files, even if one would be refused anyway, refuse the whole folder and store nothing', async () => {
      const entries = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: bytes(ascii('x')) }))
      const src = folder('C:\\d\\big', [...entries, { name: 'run.exe', data: bytes(ascii('MZ')) }])
      const result = await intakeFiles([src], deps)
      expect(result.added).toEqual([])
      expect(result.refused).toEqual([{ name: 'big', reason: 'too-many', folder: true }])
      expect(roots()).toEqual([])
    })

    it('AC-1.9 (030 verify) a folder that adds up to more than 10 MiB with the chips already there is refused whole', async () => {
      deps.existing = [{ size: 9 * MIB }]
      const src = folder('C:\\d\\heavy', [{ name: 'a.txt', data: new Uint8Array(MIB + 1).fill(0x61) }])
      const result = await intakeFiles([src], deps)
      expect(result.refused).toEqual([{ name: 'heavy', reason: 'total', folder: true }])
      expect(roots()).toEqual([])
    })

    it('AC-1.9 (030 verify) an empty folder is reported, not silently ignored', async () => {
      const src = folder('C:\\d\\void', [], 2)
      const result = await intakeFiles([src], deps)
      expect(result.refused).toEqual([{ name: 'void', reason: 'empty', folder: true }])
      expect(result.skippedFolders).toEqual([{ folder: 'void', count: 2 }])
    })

    it('AC-1.9 (030 verify) five files from a folder plus one more dropped file: the folder takes the slots in the order given', async () => {
      const src = folder('C:\\d\\five', Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: bytes(ascii('x')) })))
      const extra = addFile('C:\\d\\extra.txt', bytes(ascii('x')))
      const result = await intakeFiles([src, extra], deps)
      expect(result.added).toHaveLength(5)
      expect(result.refused).toEqual([{ name: 'extra.txt', reason: 'too-many' }])
    })

    it('AC-1.9 (030 verify) a folder with a secret-looking file asks once for that file only', async () => {
      const src = folder('C:\\d\\mixed', [{ name: 'credentials.csv', data: bytes(ascii('a,b')) }, { name: 'plain.txt', data: bytes(ascii('x')) }])
      await intakeFiles([src], deps)
      expect(asked).toEqual(['credentials.csv'])
    })
  })

  it('AC-5.1 (030 verify) a hostile name reaches the store as a name only and ends up inside it', async () => {
    const hostile = addFile('C:\\d\\x', bytes(ascii('x')), '..\\..\\Windows\\win.txt')
    const result = await intakeFiles([hostile], deps)
    expect(result.added).toHaveLength(1)
    expect(readdirSync(inbox)).toEqual(['attachments'])
  })
})
